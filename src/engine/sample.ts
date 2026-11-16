import { eligibleTouchpoints } from '@/engine/attribution';
import { hashString } from '@/engine/registry';
import type {
  ChannelCoverage,
  ExclusionRecord,
  MergedInputs,
  SampleBuild,
  SampleDefinition,
  SampleOrderRow,
  SegmentKey,
  SegmentWeight,
  SupplementBatch,
} from '@/types/evaluation';
import type { DataSnapshot, Order, OrderVersion, RefundEvent, RunConfig } from '@/types/domain';

const MS_PER_DAY = 86_400_000;

/** 合并基础快照与补充导入批次（订单/触点/退款按 id 去重，后者覆盖前者） */
export function mergeInputs(snapshot: DataSnapshot, supplements: SupplementBatch[]): MergedInputs {
  const channels = snapshot.channels.slice();
  const orders = snapshot.orders.slice();
  const touchpoints = snapshot.touchpoints.slice();
  const refunds = snapshot.refunds.slice();

  for (const sup of supplements) {
    for (const c of sup.channels) if (!channels.some((x) => x.channelId === c.channelId)) channels.push(c);
    for (const o of sup.orders) {
      const i = orders.findIndex((x) => x.orderId === o.orderId);
      if (i >= 0) orders[i] = o; else orders.push(o);
    }
    for (const t of sup.touchpoints) {
      const i = touchpoints.findIndex((x) => x.touchpointId === t.touchpointId);
      if (i >= 0) touchpoints[i] = t; else touchpoints.push(t);
    }
    for (const r of sup.refunds) {
      const i = refunds.findIndex((x) => x.refundId === r.refundId);
      if (i >= 0) refunds[i] = r; else refunds.push(r);
    }
  }
  const batchIds = supplements.map((s) => s.batchId);
  return {
    dataVersion: batchIds.length ? `${snapshot.dataVersion}+${batchIds.length}补充` : snapshot.dataVersion,
    channels,
    orders,
    touchpoints,
    refunds,
    sourceSnapshot: snapshot,
    supplementIds: batchIds,
  };
}

/** 由毛额与退款重算净额版本（补充退款后必须重算，不允许沿用旧版本） */
export function buildVersion(order: Order, refunds: RefundEvent[], dataVersion: string): OrderVersion {
  const related = refunds.filter((r) => r.orderId === order.orderId);
  const refundedAmount = related.reduce((s, r) => s + r.amount, 0);
  const netAmount = order.status === 'cancelled' ? 0 : Math.max(0, order.grossAmount - refundedAmount);
  const status =
    order.status === 'cancelled'
      ? 'cancelled'
      : refundedAmount >= order.grossAmount
        ? 'refunded_full'
        : refundedAmount > 0
          ? 'refunded_partial'
          : 'placed';
  return {
    orderId: order.orderId,
    dataVersion,
    grossAmount: order.grossAmount,
    refundedAmount,
    netAmount,
    status,
    refundIds: related.map((r) => r.refundId),
  };
}

export interface SampleBuildOptions {
  definition: SampleDefinition;
  inputs: MergedInputs;
  /** 身份授权表（是否允许跨设备合并到客户簇） */
  identityLinks: DataSnapshot['identityLinks'];
  now: string;
}

/**
 * 构建评估样本：固定订单窗口、授权触点、退款观察截止点与成熟条件。
 * 每个订单同时给出纳入 / 排除原因，便于负责人审查边界。
 */
export function buildSample(opts: SampleBuildOptions): SampleBuild {
  const { definition: def, inputs, identityLinks } = opts;
  const start = new Date(def.windowStart).getTime();
  const end = new Date(def.windowEnd).getTime();
  const cutoff = new Date(def.refundCutoff).getTime();
  const relevantRefunds = inputs.refunds;

  const rows: SampleOrderRow[] = [];
  const excluded: ExclusionRecord[] = [];
  const versionCache = new Map<string, OrderVersion>();

  for (const order of inputs.orders) {
    const orderTime = new Date(order.orderTime).getTime();
    if (Number.isNaN(orderTime)) {
      excluded.push({ orderId: order.orderId, kind: 'invalid_order', reason: '下单时间无法解析', netAmount: 0 });
      continue;
    }
    if (orderTime < start || orderTime > end) {
      excluded.push({ orderId: order.orderId, kind: 'window', reason: `下单时间不在窗口 ${def.windowStart.slice(0, 10)} ~ ${def.windowEnd.slice(0, 10)} 内`, netAmount: 0 });
      continue;
    }

    const version = buildVersion(order, relevantRefunds, def.dataVersion);
    versionCache.set(order.orderId, version);
    const orderRefunds = relevantRefunds.filter((r) => r.orderId === order.orderId);
    const overRefunded = order.status !== 'cancelled' && version.refundedAmount > order.grossAmount;

    // 成熟条件
    let mature = true;
    let maturityNote: string | undefined;
    const pendingRefundIds: string[] = [];
    if (def.maturityCondition === 'refund_settled_before_cutoff') {
      const late = orderRefunds.filter((r) => new Date(r.refundTime).getTime() > cutoff);
      if (late.length > 0) {
        mature = false;
        pendingRefundIds.push(...late.map((r) => r.refundId));
        maturityNote = `退款 ${late.map((r) => r.refundId).join('、')} 晚于观察截止点 ${def.refundCutoff.slice(0, 10)}，等待退款入账`;
      }
    } else {
      // 观察期已满：只要观察期结束（下单 + observeDays）在当前追溯时间之前即可；未入账退款保留并标记
      const observeEnd = orderTime + def.observeDays * MS_PER_DAY;
      if (observeEnd > new Date(opts.now).getTime()) {
        mature = false;
        maturityNote = `观察期未满（需至 ${new Date(observeEnd).toISOString().slice(0, 10)}）`;
      } else {
        const late = orderRefunds.filter((r) => new Date(r.refundTime).getTime() > cutoff);
        if (late.length > 0) {
          pendingRefundIds.push(...late.map((r) => r.refundId));
          maturityNote = `观察期已满；退款 ${late.map((r) => r.refundId).join('、')} 晚于截止点仍保留，标注不确定性`;
        }
      }
    }

    if (order.status === 'cancelled') {
      excluded.push({ orderId: order.orderId, kind: 'cancelled', reason: '已取消订单净额为 0，不参与评估', netAmount: 0 });
      continue;
    }
    if (version.netAmount <= 0) {
      excluded.push({
        orderId: order.orderId,
        kind: version.refundedAmount > 0 ? 'zero_net' : 'zero_net',
        reason: version.refundedAmount > 0 ? '全额退款后净额为 0，不参与份额与差异计算' : '净额为 0，不参与评估',
        netAmount: 0,
      });
      continue;
    }
    if (!mature) {
      excluded.push({
        orderId: order.orderId,
        kind: 'immature_refund',
        reason: maturityNote ?? '退款尚未成熟',
        netAmount: version.netAmount,
      });
      continue;
    }

    // 合格触点：复用归因引擎的窗口 / 授权 / 跨设备判定
    const config: RunConfig = {
      timezone: def.timezone,
      dealDefinition: 'net_of_refund_at_lock',
      windowDays: def.attributionWindowDays,
      model: 'last_touch',
      ruleRevision: '',
      decayHalfLifeDays: 7,
    };
    const snapshotForEligibility: DataSnapshot = {
      ...inputs.sourceSnapshot,
      channels: inputs.channels,
      identityLinks,
      orders: inputs.orders,
      touchpoints: inputs.touchpoints,
      refunds: inputs.refunds,
      orderVersions: [...versionCache.values()],
    };
    const decision = eligibleTouchpoints(snapshotForEligibility, order, config);
    const excludedTouchpointReasons = decision.reasons.slice();
    const channelIds = [...new Set(decision.eligible.map((t) => t.channelId))];

    let unknownReason: SampleOrderRow['unknownReason'];
    if (!order.personId) unknownReason = 'no_person';
    else if (inputs.touchpoints.filter((t) => t.orderId === order.orderId).length === 0) unknownReason = 'no_touchpoint';
    else if (decision.eligible.length === 0) unknownReason = 'all_touchpoints_excluded';

    // 簇：有订单人员且授权跨设备时按客户簇；否则按订单簇，并写明限制
    const link = order.personId ? identityLinks.find((l) => l.personId === order.personId) : undefined;
    const useCustomerCluster = !!order.personId && !!link && link.crossDeviceAuthorized;
    const clusterId = useCustomerCluster ? `CU:${order.personId}` : `ORD:${order.orderId}`;
    const clusterKind: SampleOrderRow['clusterKind'] = useCustomerCluster ? 'customer' : 'order';
    let clusterNote: string | undefined;
    if (!useCustomerCluster) {
      clusterNote = !order.personId
        ? '无授权人员标识，按订单簇处理'
        : !link
          ? '人员档案缺失，按订单簇处理'
          : '人员档案缺少可靠跨设备授权，禁止拼接身份，按订单簇处理';
    }

    rows.push({
      orderId: order.orderId,
      personId: order.personId,
      deviceId: order.deviceId,
      clusterId,
      clusterKind,
      clusterNote,
      region: order.region ?? '未标注',
      deviceSegment: order.deviceSegment ?? '未标注',
      orderTime: order.orderTime,
      grossAmount: order.grossAmount,
      refundedAmount: version.refundedAmount,
      netAmount: version.netAmount,
      status: version.status,
      overRefunded,
      eligibleTouchpointIds: decision.eligible.map((t) => t.touchpointId),
      authorizedTouchpointCount: decision.eligible.length,
      excludedTouchpointReasons,
      channelIds,
      unknownReason,
      noAuthorizedTouchpoint: decision.eligible.length === 0,
      refundBatchIds: [...new Set(orderRefunds.map((r) => r.refundBatchId ?? r.refundId))],
      refundIds: orderRefunds.map((r) => r.refundId),
      pendingRefundIds,
      mature,
      maturityNote,
    });
  }

  rows.sort((a, b) => a.orderId.localeCompare(b.orderId));
  excluded.sort((a, b) => a.orderId.localeCompare(b.orderId));

  const segmentWeights: Record<SegmentKey, SegmentWeight[]> = {
    region: computeSegmentWeights(rows, 'region'),
    deviceSegment: computeSegmentWeights(rows, 'deviceSegment'),
  };

  const channelCoverage: ChannelCoverage[] = inputs.channels.map((c) => {
    const touchedRows = rows.filter((r) => r.channelIds.includes(c.channelId));
    return {
      channelId: c.channelId,
      name: c.name,
      orders: touchedRows.length,
      touchpoints: rows.reduce((s, r) => s + r.eligibleTouchpointIds.filter((id) => inputs.touchpoints.find((t) => t.touchpointId === id)?.channelId === c.channelId).length, 0),
      netAmount: touchedRows.reduce((s, r) => s + r.netAmount, 0),
      covered: touchedRows.length > 0,
    };
  });

  const clusters = new Set(rows.map((r) => r.clusterId));
  const customerClusterCount = new Set(rows.filter((r) => r.clusterKind === 'customer').map((r) => r.clusterId)).size;
  const orderClusterCount = new Set(rows.filter((r) => r.clusterKind === 'order').map((r) => r.clusterId)).size;
  const totalNet = rows.reduce((s, r) => s + r.netAmount, 0);
  const totalRefunded = rows.reduce((s, r) => s + r.refundedAmount, 0);
  const immatureExcluded = excluded.filter((e) => e.kind === 'immature_refund').length;
  const overRefundOrderIds = rows.filter((r) => r.overRefunded).map((r) => r.orderId);
  const pendingRefundIds = [...new Set(rows.flatMap((r) => r.pendingRefundIds))];

  const limitations: string[] = [
    '没有可观测真实渠道贡献标签：本样本只能验证计算、稳定性与输入/模型差异来源，不能给出准确率。',
    '成熟共同样本对当前流量的代表性有限；近期构成变化需用近期窗口单独做漂移监测。',
  ];
  if (rows.some((r) => r.clusterKind === 'order')) {
    limitations.push('部分订单缺少可靠跨设备授权：仅能按订单簇重抽样，同客户跨订单相关性未纳入，区间偏窄，不能拼接身份。');
  }
  if (pendingRefundIds.length > 0) {
    limitations.push(`仍有 ${pendingRefundIds.length} 笔退款未过观察截止点：已按所选成熟条件处理，结论需等待退款观察完成。`);
  }
  if (overRefundOrderIds.length > 0) {
    limitations.push(`订单 ${overRefundOrderIds.join('、')} 退款超过毛额：净额按 0 计不产生负分配，需人工核对退款流水。`);
  }
  if (rows.some((r) => r.region === '未标注' || r.deviceSegment === '未标注')) {
    limitations.push('存在区域或设备群未标注的订单，已归入「未标注」群，分群比较时需注意。');
  }

  const build: SampleBuild = {
    sampleId: def.sampleId,
    sampleLabel: def.label,
    window: def.window,
    revision: def.revision,
    dataVersion: def.dataVersion,
    rows,
    excludedOrders: excluded,
    segmentWeights,
    channelCoverage,
    clusterCount: clusters.size,
    customerClusterCount,
    orderClusterCount,
    orderCount: rows.length,
    totalNet,
    totalRefunded,
    overRefundOrderIds,
    immatureOrderIds: excluded.filter((e) => e.kind === 'immature_refund').map((e) => e.orderId),
    pendingRefundIds,
    maturitySummary: {
      condition: def.maturityCondition,
      cutoff: def.refundCutoff,
      observeDays: def.observeDays,
      matureOrders: rows.length,
      immatureExcluded,
    },
    sampleHash: '',
    builtAt: opts.now,
    limitations,
  };
  build.sampleHash = sampleFingerprint(build, def);
  return build;
}

function computeSegmentWeights(rows: SampleOrderRow[], key: SegmentKey): SegmentWeight[] {
  const map = new Map<string, { orders: number; netAmount: number }>();
  for (const r of rows) {
    const v = r[key];
    const cur = map.get(v) ?? { orders: 0, netAmount: 0 };
    cur.orders += 1;
    cur.netAmount += r.netAmount;
    map.set(v, cur);
  }
  const total = rows.reduce((s, r) => s + r.netAmount, 0);
  return [...map.entries()]
    .map(([value, v]) => ({ value, orders: v.orders, netAmount: v.netAmount, weight: total > 0 ? v.netAmount / total : 0 }))
    .sort((a, b) => b.netAmount - a.netAmount);
}

/** 样本指纹：覆盖窗口、截止点、成熟条件与全部纳入订单的净额与触点 */
export function sampleFingerprint(build: SampleBuild, definition: SampleDefinition): string {
  const raw = JSON.stringify({
    window: definition.window,
    start: definition.windowStart,
    end: definition.windowEnd,
    cutoff: definition.refundCutoff,
    condition: definition.maturityCondition,
    observeDays: definition.observeDays,
    attributionWindowDays: definition.attributionWindowDays,
    rows: build.rows.map((r) => [r.orderId, r.netAmount, r.refundIds, r.eligibleTouchpointIds]),
  });
  return hashString(raw);
}
