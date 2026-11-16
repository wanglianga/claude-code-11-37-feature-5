import { modelWeights } from '@/engine/attribution';
import { hashString } from '@/engine/registry';
import { mulberry32 } from '@/lib/prng';
import type {
  AllowedUse,
  ChannelShare,
  ComparisonRecord,
  ComparisonSide,
  CompositionComparison,
  CoverageBreakdown,
  DriftReport,
  DriftRow,
  EvaluationConfig,
  EvaluationResult,
  MergedInputs,
  ModelEvaluation,
  OrderAllocation,
  OrderDiff,
  PairedDiff,
  ResolvedModelRef,
  SampleBuild,
  SampleOrderRow,
  SegmentAnalysis,
  SegmentCell,
  SegmentChannelCell,
  SegmentDivergence,
  SegmentKey,
  StabilityResult,
  SupportState,
  UnknownBreakdown,
} from '@/types/evaluation';
import type { Touchpoint } from '@/types/domain';

// ============================================================
// 评估引擎（纯函数）
//  - 逐单守恒、退款负额、未知来源、无授权触点分别说明
//  - 份额 / 覆盖 / 分群指标
//  - 簇重复抽样 + 同一抽样上成对运行两个模型，给出差异区间
//  - 不输出准确率 / 因果结论；不足时返回「不支持结论」而非零分
// ============================================================

const MIN_CHANNEL_ORDERS = 1;

interface PreparedSample {
  rows: SampleOrderRow[];
  netByOrder: Map<string, number>;
  touchpointsById: Map<string, Touchpoint>;
  channelNames: Map<string, string>;
  netByCluster: Map<string, number>;
}

function prepare(build: SampleBuild, inputs: MergedInputs): PreparedSample {
  const touchpointsById = new Map(inputs.touchpoints.map((t) => [t.touchpointId, t] as const));
  const channelNames = new Map(inputs.channels.map((c) => [c.channelId, c.name] as const));
  const netByOrder = new Map<string, number>();
  const netByCluster = new Map<string, number>();
  for (const r of build.rows) {
    netByOrder.set(r.orderId, r.netAmount);
    netByCluster.set(r.clusterId, (netByCluster.get(r.clusterId) ?? 0) + r.netAmount);
  }
  return { rows: build.rows, netByOrder, touchpointsById, channelNames, netByCluster };
}

interface AllocationResult {
  allocations: Map<string, Map<string, number>>;
  unknown: UnknownBreakdown;
  negative: { orderId: string; channelId: string; amount: number }[];
  overRefund: { orderId: string; grossAmount: number; refundedAmount: number; excess: number }[];
  totalAttributed: number;
  totalNet: number;
  conservation: { ok: boolean; perOrderChecked: number; violations: string[] };
}

/** 在给定订单集合（可重复，用于重抽样）上按模型分摊；整数分摊保证逐单守恒 */
function allocate(
  rows: SampleOrderRow[],
  model: Pick<ResolvedModelRef, 'baseModel' | 'decayHalfLifeDays'>,
  prepared: PreparedSample,
): AllocationResult {
  const allocations = new Map<string, Map<string, number>>();
  const violations: string[] = [];
  const negative: { orderId: string; channelId: string; amount: number }[] = [];
  const overRefund: { orderId: string; grossAmount: number; refundedAmount: number; excess: number }[] = [];
  const unknown: UnknownBreakdown = {
    totalAmount: 0,
    orderIds: [],
    byReason: {
      no_person: { orders: [], amount: 0 },
      no_touchpoint: { orders: [], amount: 0 },
      all_touchpoints_excluded: { orders: [], amount: 0 },
    },
  };
  let totalAttributed = 0;
  let totalNet = 0;
  let checked = 0;

  // 每个订单在重抽样中可能重复出现；按出现次数汇总，保持守恒可核对
  const occurrences = new Map<string, { row: SampleOrderRow; count: number }>();
  for (const r of rows) {
    const cur = occurrences.get(r.orderId);
    if (cur) cur.count += 1;
    else occurrences.set(r.orderId, { row: r, count: 1 });
  }

  for (const { row, count } of occurrences.values()) {
    const base = row.netAmount;
    totalNet += base * count;
    if (row.overRefunded) {
      overRefund.push({
        orderId: row.orderId,
        grossAmount: row.grossAmount,
        refundedAmount: row.refundedAmount,
        excess: row.refundedAmount - row.grossAmount,
      });
    }
    if (row.unknownReason) {
      unknown.totalAmount += base * count;
      for (let i = 0; i < count; i++) unknown.orderIds.push(row.orderId);
      unknown.byReason[row.unknownReason].orders.push(row.orderId);
      unknown.byReason[row.unknownReason].amount += base * count;
      const m = allocations.get(row.orderId) ?? new Map<string, number>();
      allocations.set(row.orderId, m);
      continue;
    }
    const tps = row.eligibleTouchpointIds
      .map((id) => prepared.touchpointsById.get(id))
      .filter((t): t is Touchpoint => !!t);
    if (tps.length === 0) {
      unknown.totalAmount += base * count;
      unknown.orderIds.push(row.orderId);
      unknown.byReason.all_touchpoints_excluded.orders.push(row.orderId);
      unknown.byReason.all_touchpoints_excluded.amount += base * count;
      continue;
    }
    const weights = modelWeights(tps, model.baseModel, model.decayHalfLifeDays);
    // 整数分摊：同一下单订单重复出现时，逐份取整后再累加，份数一致
    const perCopy = weights.map((w) => Math.round(base * w));
    const diff = base - perCopy.reduce((a, b) => a + b, 0);
    perCopy[perCopy.length - 1] += diff;
    const m = allocations.get(row.orderId) ?? new Map<string, number>();
    tps.forEach((t, i) => {
      const add = perCopy[i] * count;
      m.set(t.channelId, (m.get(t.channelId) ?? 0) + add);
      if (perCopy[i] < 0) negative.push({ orderId: row.orderId, channelId: t.channelId, amount: perCopy[i] });
    });
    allocations.set(row.orderId, m);
    totalAttributed += base * count;
    checked += count;
  }

  if (totalAttributed + unknown.totalAmount !== totalNet) {
    violations.push(`总额守恒失败：已分配 ${totalAttributed} + 未知 ${unknown.totalAmount} ≠ 净收入 ${totalNet}`);
  }
  // 逐单守恒复核（按出现一次的订单做精确核对；重复订单在份数上已乘回）
  for (const { row, count } of occurrences.values()) {
    if (row.unknownReason) continue;
    const m = allocations.get(row.orderId);
    const sum = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
    if (sum !== row.netAmount * count) {
      violations.push(`订单 ${row.orderId} 分摊和 ${sum} ≠ 净额 ${row.netAmount * count}`);
    }
  }

  return {
    allocations,
    unknown,
    negative,
    overRefund,
    totalAttributed,
    totalNet,
    conservation: { ok: violations.length === 0, perOrderChecked: checked, violations },
  };
}

function channelAmountFrom(allocs: Map<string, Map<string, number>>, channelId: string): number {
  let sum = 0;
  for (const m of allocs.values()) sum += m.get(channelId) ?? 0;
  return sum;
}

function supportForShare(
  covered: boolean,
  sampleOrders: number,
  minClusters: number,
  allowed: boolean,
  share: number | null,
  total: number,
): { support: SupportState; reason: string } {
  if (!allowed) return { support: 'model_not_allowed', reason: '模型登记的允许用途不含本次比较用途' };
  if (!covered || sampleOrders < MIN_CHANNEL_ORDERS) {
    return { support: 'channel_not_covered', reason: '该渠道在样本中从未覆盖（无合格触点），不能下结论' };
  }
  if (sampleOrders < minClusters) {
    return { support: 'insufficient_sample', reason: `样本订单 ${sampleOrders} < 最小簇数 ${minClusters}，不填零分` };
  }
  if (share === null || total <= 0) {
    return { support: 'interval_undetermined', reason: '样本净收入为 0，份额无法确定' };
  }
  return { support: 'supported', reason: '仅表示份额可算，不代表准确率或因果贡献' };
}

/** 评估单个模型：守恒、退款负额、未知来源、无授权触点、覆盖、渠道份额 */
export function evaluateModel(
  build: SampleBuild,
  model: ResolvedModelRef,
  inputs: MergedInputs,
  minClusters: number,
  purpose: AllowedUse,
): { evaluation: ModelEvaluation; allocs: Map<string, Map<string, number>> } {
  const prepared = prepare(build, inputs);
  const result = allocate(build.rows, model, prepared);
  const allowed = model.allowedUses.includes(purpose);

  const channelShares: ChannelShare[] = inputs.channels.map((c) => {
    const amount = channelAmountFrom(result.allocations, c.channelId);
    const covered = build.rows.some((r) => r.channelIds.includes(c.channelId));
    const channelOrders = build.rows.filter((r) => r.channelIds.includes(c.channelId)).length;
    const share = result.totalAttributed > 0 ? amount / result.totalAttributed : null;
    const { support, reason } = supportForShare(covered, channelOrders, minClusters, allowed, share, result.totalAttributed);
    return {
      channelId: c.channelId,
      name: c.name,
      amount,
      share: share ?? 0,
      covered,
      support: support === 'supported' && share === null ? 'interval_undetermined' : support,
      supportReason: reason,
    };
  });

  const orderAllocations: OrderAllocation[] = build.rows.map((r) => {
    const m = result.allocations.get(r.orderId);
    return {
      orderId: r.orderId,
      netAmount: r.netAmount,
      allocations: m ? [...m.entries()].map(([channelId, amount]) => ({ channelId, amount })) : [],
      unknown: !!r.unknownReason,
    };
  });

  const coverage = buildCoverage(build, inputs);

  const supportNotes: string[] = [];
  if (!allowed) supportNotes.push(`模型 ${model.name}@${model.revision} 的允许用途不含「${purpose}」，所有渠道指标不支持结论。`);
  if (build.rows.length < minClusters) supportNotes.push(`样本订单 ${build.rows.length} < 最小簇数 ${minClusters}：份额与差异区间均不支持结论。`);
  if (build.pendingRefundIds.length > 0) supportNotes.push(`存在未过观察截止点的退款：${build.pendingRefundIds.join('、')}，份额可能随后续退款变化。`);
  supportNotes.push('净收入守恒通过只说明计算自洽，不能解读为模型准确率。');

  const evaluation: ModelEvaluation = {
    model,
    conservation: result.conservation,
    negativeAllocations: result.negative,
    overRefund: result.overRefund,
    unknown: result.unknown,
    coverage,
    channelShares,
    orderAllocations,
    totalAttributed: result.totalAttributed,
    totalNet: result.totalNet,
    unknownAmount: result.unknown.totalAmount,
    supportNotes,
  };

  return { evaluation, allocs: result.allocations };
}

function buildCoverage(build: SampleBuild, inputs: MergedInputs): CoverageBreakdown {
  const rows = build.rows;
  const ordersWithEligible = rows.filter((r) => !r.unknownReason).length;
  const touchpointCount = rows.reduce((s, r) => s + r.eligibleTouchpointIds.length, 0);
  const channels = inputs.channels.map((c) => {
    const touched = rows.filter((r) => r.channelIds.includes(c.channelId));
    const tps = rows.reduce(
      (s, r) => s + r.eligibleTouchpointIds.filter((id) => inputs.touchpoints.find((t) => t.touchpointId === id)?.channelId === c.channelId).length,
      0,
    );
    return {
      channelId: c.channelId,
      name: c.name,
      orders: touched.length,
      touchpoints: tps,
      netAmount: touched.reduce((s, r) => s + r.netAmount, 0),
      covered: touched.length > 0,
    };
  });
  return {
    ordersWithEligible,
    orderCount: rows.length,
    ratio: rows.length ? ordersWithEligible / rows.length : 0,
    touchpointCount,
    avgTouchpointsPerOrder: ordersWithEligible ? touchpointCount / ordersWithEligible : 0,
    channels,
  };
}

// ---------------- 稳定性：簇重复抽样 ----------------

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * 簇重复抽样稳定性：每次以簇为单位有放回抽取，簇内订单与其退款整体保留；
 * 在同一个抽样上成对运行两个模型，计算差异区间。
 */
export function stabilityAnalysis(
  build: SampleBuild,
  inputs: MergedInputs,
  modelA: ResolvedModelRef,
  modelB: ResolvedModelRef,
  config: Pick<EvaluationConfig, 'bootstrapIterations' | 'seed' | 'minClusters' | 'focusChannelId'>,
  purpose: AllowedUse,
): StabilityResult {
  const prepared = prepare(build, inputs);
  const clusters = [...new Set(build.rows.map((r) => r.clusterId))];
  const rowsByCluster = new Map<string, SampleOrderRow[]>();
  for (const r of build.rows) {
    const list = rowsByCluster.get(r.clusterId) ?? [];
    list.push(r);
    rowsByCluster.set(r.clusterId, list);
  }
  // 样本内全量点估计
  const fullA = allocate(build.rows, modelA, prepared);
  const fullB = allocate(build.rows, modelB, prepared);

  const iterations = Math.max(50, Math.min(2000, config.bootstrapIterations));
  const rand = mulberry32(config.seed);
  const channelIds = inputs.channels.map((c) => c.channelId);
  const channelNames = new Map(inputs.channels.map((c) => [c.channelId, c.name] as const));

  const shareDeltas = new Map<string, number[]>();
  const totalDeltas: number[] = [];
  const orderDeltaSeries: number[] = [];
  for (const c of channelIds) shareDeltas.set(c, []);

  for (let it = 0; it < iterations; it++) {
    const sampled: SampleOrderRow[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      sampled.push(...(rowsByCluster.get(c) ?? []));
    }
    const a = allocate(sampled, modelA, prepared);
    const b = allocate(sampled, modelB, prepared);
    for (const c of channelIds) {
      const shareA = a.totalAttributed > 0 ? channelAmountFrom(a.allocations, c) / a.totalAttributed : null;
      const shareB = b.totalAttributed > 0 ? channelAmountFrom(b.allocations, c) / b.totalAttributed : null;
      if (shareA !== null && shareB !== null) shareDeltas.get(c)!.push(shareB - shareA);
    }
    totalDeltas.push(b.totalAttributed - a.totalAttributed);
    // 每单渠道分摊的绝对差异均值：按出现次数还原为「每单」口径，
    // 保证点估计（未重复抽样）与区间处于同一口径
    const multiplicities = new Map<string, number>();
    for (const r of sampled) multiplicities.set(r.orderId, (multiplicities.get(r.orderId) ?? 0) + 1);
    let absSum = 0;
    let n = 0;
    for (const [id, times] of multiplicities) {
      const ma = a.allocations.get(id);
      const mb = b.allocations.get(id);
      let tv = 0;
      for (const c of channelIds) tv += Math.abs((mb?.get(c) ?? 0) - (ma?.get(c) ?? 0));
      absSum += tv / 2 / times;
      n += 1;
    }
    orderDeltaSeries.push(n > 0 ? absSum / n : 0);
  }

  const allowed = modelA.allowedUses.includes(purpose) && modelB.allowedUses.includes(purpose);
  const baseSupport = (): { support: SupportState; reason: string } => {
    if (!allowed) return { support: 'model_not_allowed', reason: '模型允许用途未登记本次比较' };
    if (clusters.length < config.minClusters) {
      return { support: 'insufficient_sample', reason: `可用簇 ${clusters.length} < 最小簇数 ${config.minClusters}，不给出区间也不填零分` };
    }
    return { support: 'supported', reason: '区间仅刻画抽样波动，不表示模型更准确' };
  };

  const diffs: PairedDiff[] = [];
  for (const c of channelIds) {
    const series = shareDeltas.get(c)!;
    const pointA = fullA.totalAttributed > 0 ? channelAmountFrom(fullA.allocations, c) / fullA.totalAttributed : null;
    const pointB = fullB.totalAttributed > 0 ? channelAmountFrom(fullB.allocations, c) / fullB.totalAttributed : null;
    const covered = build.rows.some((r) => r.channelIds.includes(c));
    let support = baseSupport().support;
    let reason = baseSupport().reason;
    if (support === 'supported' && !covered) {
      support = 'channel_not_covered';
      reason = '渠道在样本中从未覆盖，无法给出份额差异区间';
    }
    let lower: number | null = null;
    let upper: number | null = null;
    if (support === 'supported') {
      const sorted = [...series].sort((x, y) => x - y);
      lower = percentile(sorted, 0.025);
      upper = percentile(sorted, 0.975);
      if (lower === null || upper === null || !Number.isFinite(lower) || !Number.isFinite(upper) || (upper === lower && pointA === null)) {
        support = 'interval_undetermined';
        reason = '重复抽样未产生可用区间（该渠道份额无波动或缺失）';
        lower = null;
        upper = null;
      }
    }
    diffs.push({
      metric: 'channel_share',
      channelId: c,
      label: `${channelNames.get(c) ?? c} 份额差异（B−A）`,
      pointEstimate: pointA !== null && pointB !== null ? pointB - pointA : 0,
      lower,
      upper,
      replications: series.length,
      support,
      supportReason: reason,
    });
  }

  const totalSorted = [...totalDeltas].sort((a, b) => a - b);
  const totalSupport = baseSupport();
  const totalLower = totalSupport.support === 'supported' ? percentile(totalSorted, 0.025) : null;
  const totalUpper = totalSupport.support === 'supported' ? percentile(totalSorted, 0.975) : null;
  diffs.push({
    metric: 'total_attributed',
    label: '渠道已分配总额差异（B−A，分）',
    pointEstimate: fullB.totalAttributed - fullA.totalAttributed,
    lower: totalLower,
    upper: totalUpper,
    replications: totalDeltas.length,
    support: totalLower === null || totalUpper === null ? (totalSupport.support === 'supported' ? 'interval_undetermined' : totalSupport.support) : totalSupport.support,
    supportReason: totalLower === null ? totalSupport.reason : '区间仅反映抽样波动',
  });

  const orderSorted = [...orderDeltaSeries].sort((a, b) => a - b);
  const orderPoint = mean(fullOrderAbsDelta(build.rows, fullA.allocations, fullB.allocations, channelIds));
  const orderSupport = baseSupport();
  const orderLower = orderSupport.support === 'supported' ? percentile(orderSorted, 0.025) : null;
  const orderUpper = orderSupport.support === 'supported' ? percentile(orderSorted, 0.975) : null;
  diffs.push({
    metric: 'mean_order_abs_delta',
    label: '订单级平均分摊差异（分/单，B 与 A 的绝对差均值）',
    pointEstimate: orderPoint,
    lower: orderLower,
    upper: orderUpper,
    replications: orderDeltaSeries.length,
    support: orderLower === null ? (orderSupport.support === 'supported' ? 'interval_undetermined' : orderSupport.support) : orderSupport.support,
    supportReason: orderLower === null ? orderSupport.reason : '差异大只说明模型分歧大，不代表谁更准',
  });

  const fallbackOrderClusters = new Set(build.rows.filter((r) => r.clusterKind === 'order').map((r) => r.clusterId)).size;
  const limitations: string[] = [
    '重复抽样以簇为单位；簇内订单与同批退款整体保留，避免把同客户相关订单当成独立样本。',
    '成对运行两个模型使用同一抽样，差异区间可直接比较，但不等价于准确率。',
  ];
  if (fallbackOrderClusters > 0) {
    limitations.push('部分簇为订单簇（缺少可靠跨设备授权）：同客户跨订单相关性未纳入，区间可能偏窄；禁止拼接身份。');
  }
  if (clusters.length < config.minClusters) limitations.push('簇数量不足，区间不给出，显示「不支持结论」。');

  return {
    method: 'cluster_bootstrap',
    clusterKind: fallbackOrderClusters === 0 ? (build.customerClusterCount > 0 ? 'customer' : 'order') : build.customerClusterCount > 0 ? 'mixed' : 'order',
    clusterCount: clusters.length,
    orderCount: build.rows.length,
    iterations,
    seed: config.seed,
    points: diffs.length,
    supportedPoints: diffs.filter((d) => d.support === 'supported').length,
    diffs,
    fallbackOrderClusters,
    limitations,
  };
}

function fullOrderAbsDelta(
  rows: SampleOrderRow[],
  allocA: Map<string, Map<string, number>>,
  allocB: Map<string, Map<string, number>>,
  channelIds: string[],
): number[] {
  const byOrder = new Map<string, SampleOrderRow>();
  for (const r of rows) byOrder.set(r.orderId, r);
  const out: number[] = [];
  for (const id of byOrder.keys()) {
    const ma = allocA.get(id);
    const mb = allocB.get(id);
    let tv = 0;
    for (const c of channelIds) tv += Math.abs((mb?.get(c) ?? 0) - (ma?.get(c) ?? 0));
    out.push(tv / 2);
  }
  return out;
}

// ---------------- 分群对比与构成分解 ----------------

export function segmentAnalyses(
  buildA: SampleBuild,
  buildB: SampleBuild,
  evalA: ModelEvaluation,
  evalB: ModelEvaluation,
  segmentKeys: SegmentKey[],
  minClusters: number,
): { segments: Record<SegmentKey, SegmentAnalysis>; orderDiffs: OrderDiff[] } {
  const segments = {} as Record<SegmentKey, SegmentAnalysis>;
  const allocA = new Map(evalA.orderAllocations.map((o) => [o.orderId, o] as const));
  const allocB = new Map(evalB.orderAllocations.map((o) => [o.orderId, o] as const));
  const overallShareDelta = new Map<string, number>();
  for (const ca of evalA.channelShares) {
    const cb = evalB.channelShares.find((x) => x.channelId === ca.channelId);
    overallShareDelta.set(ca.channelId, (cb?.share ?? 0) - ca.share);
  }

  for (const key of segmentKeys) {
    const values = [...new Set([...buildA.rows.map((r) => r[key]), ...buildB.rows.map((r) => r[key])])].sort();
    const cells: SegmentCell[] = values.map((value) => {
      const rowsA = buildA.rows.filter((r) => r[key] === value);
      const rowsB = buildB.rows.filter((r) => r[key] === value);
      const netA = rowsA.reduce((s, r) => s + r.netAmount, 0);
      const netB = rowsB.reduce((s, r) => s + r.netAmount, 0);
      const unknownA = rowsA.filter((r) => r.unknownReason).reduce((s, r) => s + r.netAmount, 0);
      const unknownB = rowsB.filter((r) => r.unknownReason).reduce((s, r) => s + r.netAmount, 0);
      const channelIds = [...new Set([...rowsA.flatMap((r) => r.channelIds), ...rowsB.flatMap((r) => r.channelIds)])];
      const channels: SegmentChannelCell[] = channelIds.map((channelId) => {
        const amountA = rowsA.reduce((s, r) => s + (allocA.get(r.orderId)?.allocations.find((a) => a.channelId === channelId)?.amount ?? 0), 0);
        const amountB = rowsB.reduce((s, r) => s + (allocB.get(r.orderId)?.allocations.find((a) => a.channelId === channelId)?.amount ?? 0), 0);
        const coveredA = rowsA.some((r) => r.channelIds.includes(channelId));
        const coveredB = rowsB.some((r) => r.channelIds.includes(channelId));
        const denomA = netA - unknownA;
        const denomB = netB - unknownB;
        const shareA = denomA > 0 && coveredA ? amountA / denomA : null;
        const shareB = denomB > 0 && coveredB ? amountB / denomB : null;
        let support: SupportState = 'supported';
        let reason = '分群份额可算，不代表准确率';
        if (!coveredA || !coveredB) {
          support = 'channel_not_covered';
          reason = !coveredA && !coveredB ? '该分群内渠道从未覆盖' : '仅一侧窗口覆盖该渠道，不能比较';
        } else if (Math.min(rowsA.length, rowsB.length) < minClusters) {
          support = 'insufficient_sample';
          reason = `分群订单过少（A ${rowsA.length} / B ${rowsB.length}）`;
        } else if (shareA === null || shareB === null) {
          support = 'interval_undetermined';
          reason = '缺少可比较份额（该群净收入为 0）';
        }
        return {
          channelId,
          name: evalA.channelShares.find((c) => c.channelId === channelId)?.name ?? channelId,
          amountA,
          amountB,
          shareA,
          shareB,
          delta: shareA !== null && shareB !== null ? shareB - shareA : null,
          covered: coveredA && coveredB,
          support,
          supportReason: reason,
        };
      });
      let support: SupportState = 'supported';
      let reason = '分群可比较';
      if (rowsA.length < minClusters || rowsB.length < minClusters) {
        support = 'insufficient_sample';
        reason = `分群订单过少（A ${rowsA.length} / B ${rowsB.length}），不支持结论`;
      } else if (channels.length === 0) {
        support = 'channel_not_covered';
        reason = '该分群内没有任何已覆盖渠道';
      }
      return {
        key,
        value,
        orders: Math.min(rowsA.length, rowsB.length),
        netAmount: netB,
        weight: buildB.totalNet > 0 ? netB / buildB.totalNet : 0,
        unknownAmountA: unknownA,
        unknownAmountB: unknownB,
        coverageRatioA: rowsA.length ? (rowsA.length - rowsA.filter((r) => r.unknownReason).length) / rowsA.length : 0,
        coverageRatioB: rowsB.length ? (rowsB.length - rowsB.filter((r) => r.unknownReason).length) / rowsB.length : 0,
        channels,
        support,
        supportReason: reason,
      };
    });

    const divergences: SegmentDivergence[] = [];
    for (const cell of cells) {
      for (const ch of cell.channels) {
        if (ch.delta === null || ch.support !== 'supported') continue;
        const overall = overallShareDelta.get(ch.channelId) ?? 0;
        const eps = 0.005;
        if (Math.abs(ch.delta) >= eps && Math.abs(overall) >= eps && Math.sign(ch.delta) !== Math.sign(overall)) {
          divergences.push({
            key,
            value: cell.value,
            channelId: ch.channelId,
            channelName: ch.name,
            overallDelta: overall,
            segmentDelta: ch.delta,
            note: `总体 ${ch.name} 份额 ${overall > 0 ? '上升' : '下降'} ${(Math.abs(overall) * 100).toFixed(1)}pp，但「${cell.value}」群 ${ch.delta > 0 ? '上升' : '下降'} ${(Math.abs(ch.delta) * 100).toFixed(1)}pp：不能以总均值掩盖局部方向相反。`,
          });
        }
      }
    }

    segments[key] = {
      cells,
      divergences,
      note: '分群差异只描述模型/输入造成的份额差异；局部方向与总体相反时单独标注，不用总均值掩盖。',
    };
  }

  const orderDiffs = buildOrderDiffs(buildA, buildB, evalA, evalB);
  return { segments, orderDiffs };
}

export function buildOrderDiffs(buildA: SampleBuild, buildB: SampleBuild, evalA: ModelEvaluation, evalB: ModelEvaluation): OrderDiff[] {
  const ids = [...new Set([...buildA.rows.map((r) => r.orderId), ...buildB.rows.map((r) => r.orderId)])].sort();
  const rowA = new Map(buildA.rows.map((r) => [r.orderId, r] as const));
  const rowB = new Map(buildB.rows.map((r) => [r.orderId, r] as const));
  const allocA = new Map(evalA.orderAllocations.map((o) => [o.orderId, o] as const));
  const allocB = new Map(evalB.orderAllocations.map((o) => [o.orderId, o] as const));
  const channelNames = new Map(evalA.channelShares.map((c) => [c.channelId, c.name] as const));
  for (const c of evalB.channelShares) if (!channelNames.has(c.channelId)) channelNames.set(c.channelId, c.name);

  return ids.map((orderId) => {
    const a = rowA.get(orderId);
    const b = rowB.get(orderId);
    const oa = allocA.get(orderId);
    const ob = allocB.get(orderId);
    const netA = a?.netAmount ?? 0;
    const netB = b?.netAmount ?? 0;
    const channelIds = [...new Set([...(oa?.allocations.map((x) => x.channelId) ?? []), ...(ob?.allocations.map((x) => x.channelId) ?? [])])];
    const channelDeltas = channelIds.map((channelId) => ({
      channelId,
      name: channelNames.get(channelId) ?? channelId,
      delta: (ob?.allocations.find((x) => x.channelId === channelId)?.amount ?? 0) - (oa?.allocations.find((x) => x.channelId === channelId)?.amount ?? 0),
    }));
    const allocationDelta = channelDeltas.reduce((s, c) => s + Math.abs(c.delta), 0) / 2;
    const netDelta = netB - netA;
    const changeKind: OrderDiff['changeKind'] =
      netDelta !== 0 && allocationDelta !== 0
        ? 'both'
        : netDelta !== 0
          ? 'net_only'
          : allocationDelta !== 0
            ? 'model_only'
            : 'none';
    return {
      orderId,
      netDelta,
      allocationDelta,
      channelDeltas,
      changeKind,
      unknownA: !!a?.unknownReason,
      unknownB: !!b?.unknownReason,
    };
  });
}

/** 构成变化：先共同分群权重比较，再单列新增/缺失群 */
export function compositionComparison(
  base: { build: SampleBuild; eval: ModelEvaluation },
  alt: { build: SampleBuild; eval: ModelEvaluation },
  key: SegmentKey,
  focusChannelId: string | undefined,
): CompositionComparison {
  const baseValues = new Map(base.build.segmentWeights[key].map((w) => [w.value, w] as const));
  const altValues = new Map(alt.build.segmentWeights[key].map((w) => [w.value, w] as const));
  const common = [...baseValues.keys()].filter((v) => altValues.has(v));
  const added = [...altValues.keys()].filter((v) => !baseValues.has(v));
  const missing = [...baseValues.keys()].filter((v) => !altValues.has(v));
  const commonTotal = common.reduce((s, v) => s + (baseValues.get(v)?.netAmount ?? 0), 0);
  const commonWeights: Record<string, number> = {};
  for (const v of common) commonWeights[v] = commonTotal > 0 ? (baseValues.get(v)?.netAmount ?? 0) / commonTotal : 0;

  const focus = focusChannelId ?? base.eval.channelShares[0]?.channelId ?? '';
  const shareIn = (e: ModelEvaluation, rows: SampleOrderRow[], channelId: string) => {
    const net = rows.reduce((s, r) => s + r.netAmount, 0);
    const unknown = rows.filter((r) => r.unknownReason).reduce((s, r) => s + r.netAmount, 0);
    const amount = rows.reduce((s, r) => s + (e.orderAllocations.find((o) => o.orderId === r.orderId)?.allocations.find((a) => a.channelId === channelId)?.amount ?? 0), 0);
    return net - unknown > 0 ? amount / (net - unknown) : null;
  };

  let weightedBase: number | null = null;
  let weightedAlt: number | null = null;
  if (common.length > 0 && focus) {
    let bSum = 0;
    let aSum = 0;
    let wSum = 0;
    for (const v of common) {
      const w = commonWeights[v];
      const rowsB = base.build.rows.filter((r) => r[key] === v);
      const rowsA = alt.build.rows.filter((r) => r[key] === v);
      const sb = shareIn(base.eval, rowsB, focus);
      const sa = shareIn(alt.eval, rowsA, focus);
      if (sb === null || sa === null) continue;
      bSum += sb * w;
      aSum += sa * w;
      wSum += w;
    }
    if (wSum > 0) {
      weightedBase = bSum / wSum;
      weightedAlt = aSum / wSum;
    }
  }

  // 局部方向与总体方向相反
  const overallDelta = weightedBase !== null && weightedAlt !== null ? weightedAlt - weightedBase : null;
  const divergence: CompositionComparison['divergence'] = [];
  if (overallDelta !== null && focus) {
    for (const v of common) {
      const sb = shareIn(base.eval, base.build.rows.filter((r) => r[key] === v), focus);
      const sa = shareIn(alt.eval, alt.build.rows.filter((r) => r[key] === v), focus);
      if (sb === null || sa === null) continue;
      const segDelta = sa - sb;
      if (Math.abs(segDelta) >= 0.005 && Math.abs(overallDelta) >= 0.005 && Math.sign(segDelta) !== Math.sign(overallDelta)) {
        divergence.push({ value: v, overallDelta, segmentDelta: segDelta });
      }
    }
  }

  const note = [
    `以基准样本的共同分群权重（重新归一化 ${common.length} 群）比较，避免构成变化被误读为模型差异。`,
    added.length > 0 ? `新增群：${added.join('、')}，单独展示，不并入共同权重比较。` : '无新增群。',
    missing.length > 0 ? `缺失群：${missing.join('、')}，单独展示，不并入共同权重比较。` : '无缺失群。',
    divergence.length > 0 ? '存在局部方向与总体相反的分群，需单独说明，不能以总均值掩盖。' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    key,
    commonValues: common,
    addedValues: added,
    missingValues: missing,
    commonWeights,
    commonWeightedBase: weightedBase,
    commonWeightedAlt: weightedAlt,
    commonWeightedDelta: weightedBase !== null && weightedAlt !== null ? weightedAlt - weightedBase : null,
    divergence,
    note,
  };
}

function comparisonSide(build: SampleBuild, evaluation: ModelEvaluation): ComparisonSide {
  return {
    sampleId: build.sampleId,
    sampleRevision: build.revision,
    sampleHash: build.sampleHash,
    modelLabel: `${evaluation.model.name}@${evaluation.model.revision}`,
    totalNet: evaluation.totalNet,
    totalAttributed: evaluation.totalAttributed,
    conservationOk: evaluation.conservation.ok,
    channelShares: evaluation.channelShares,
    segments: {} as Record<SegmentKey, SegmentCell[]>,
  };
}

export function makeComparison(
  kind: ComparisonRecord['kind'],
  base: { build: SampleBuild; eval: ModelEvaluation },
  alt: { build: SampleBuild; eval: ModelEvaluation },
  segmentKeys: SegmentKey[],
  focusChannelId: string | undefined,
  minClusters: number,
  notes: string[],
): ComparisonRecord {
  const composition = {} as Record<SegmentKey, CompositionComparison>;
  for (const key of segmentKeys) composition[key] = compositionComparison(base, alt, key, focusChannelId);

  const orderDiffs = buildOrderDiffs(base.build, alt.build, base.eval, alt.eval);
  const changed = orderDiffs.filter((d) => d.changeKind !== 'none').length;

  const support: SupportState =
    base.build.rows.length < minClusters || alt.build.rows.length < minClusters
      ? 'insufficient_sample'
      : base.eval.channelShares.every((c) => !c.covered) && alt.eval.channelShares.every((c) => !c.covered)
        ? 'channel_not_covered'
        : 'supported';

  const side = (b: { build: SampleBuild; eval: ModelEvaluation }) => ({
    ...comparisonSide(b.build, b.eval),
  });

  return {
    kind,
    label:
      kind === 'model_swap'
        ? '同样本换模型'
        : kind === 'sample_swap'
          ? '同模型换样本'
          : '只更新退款',
    base: side(base),
    alt: side(alt),
    netDelta: alt.eval.totalNet - base.eval.totalNet,
    attributedDelta: alt.eval.totalAttributed - base.eval.totalAttributed,
    orderDiffs,
    changedOrderCount: changed,
    isolatedFactor: kind === 'model_swap' ? 'model' : kind === 'refund_update' ? 'refund' : 'sample',
    focusChannelId,
    composition,
    support,
    supportReason:
      support === 'insufficient_sample'
        ? `样本订单不足（${base.build.rows.length} / ${alt.build.rows.length} vs 最小簇数 ${minClusters}）`
        : support === 'channel_not_covered'
          ? '两侧均无渠道覆盖，差异不可解释'
          : '差异只归因到被隔离的单一因素；不代表准确率',
    notes,
  };
}

// ---------------- 漂移监测 ----------------

export function driftReport(
  mature: { build: SampleBuild; eval: ModelEvaluation },
  recent: { build: SampleBuild; eval: ModelEvaluation },
  segmentKeys: SegmentKey[],
  focusChannelId: string | undefined,
): DriftReport {
  const rows: DriftRow[] = mature.eval.channelShares.map((m) => {
    const r = recent.eval.channelShares.find((x) => x.channelId === m.channelId);
    const recentCoverage = recent.build.rows.length
      ? recent.build.rows.filter((row) => row.channelIds.includes(m.channelId)).length / recent.build.rows.length
      : 0;
    const delta = r && r.covered && m.covered ? r.share - m.share : null;
    let support: SupportState = 'supported';
    let reason = '漂移仅用于早期信号，近期标签可能未成熟，不能当作版本结论';
    if (!m.covered || !r?.covered) {
      support = 'channel_not_covered';
      reason = '至少一侧窗口渠道未覆盖';
    } else if (delta === null) {
      support = 'interval_undetermined';
      reason = '份额无法计算';
    }
    return {
      channelId: m.channelId,
      name: m.name,
      matureShare: m.covered ? m.share : null,
      recentShare: r?.covered ? r.share : null,
      delta,
      recentCoverage,
      support,
      supportReason: reason,
    };
  });
  const composition = {} as Record<SegmentKey, CompositionComparison>;
  for (const key of segmentKeys) composition[key] = compositionComparison(mature, recent, key, focusChannelId);
  // 把构成对照中「局部方向与总体相反」的群汇总到漂移报告
  const divisions: SegmentDivergence[] = [];
  for (const key of segmentKeys) {
    for (const d of composition[key].divergence) {
      const recentShare = recent.eval.channelShares.find((c) => c.channelId === focusChannelId);
      divisions.push({
        key,
        value: d.value,
        channelId: focusChannelId ?? '',
        channelName: recentShare?.name ?? focusChannelId ?? '重点渠道',
        overallDelta: d.overallDelta,
        segmentDelta: d.segmentDelta,
        note: `近期窗口总体漂移 ${(d.overallDelta * 100).toFixed(1)}pp，但「${d.value}」群反向 ${(d.segmentDelta * 100).toFixed(1)}pp：需单独说明，不能以总均值掩盖。`,
      });
    }
  }
  const note =
    '成熟共同样本与近期窗口各自独立：上方漂移只提示近期退化方向，不并入版本排行榜；近期订单可能未成熟（退款未到齐、人群构成变化）。';
  return {
    matureSampleId: mature.build.sampleId,
    recentSampleId: recent.build.sampleId,
    modelLabel: `${mature.eval.model.name}@${mature.eval.model.revision}`,
    rows,
    immatureRecentOrderIds: recent.build.immatureOrderIds,
    composition,
    divergences: divisions,
    limitations: [
      '近期窗口承担标签尚未成熟与人群构成变化的不确定性，早发现退化但结论更弱。',
      '两个窗口不混成同一排行榜。',
      ...recent.build.limitations,
    ],
    note,
  };
}

// ---------------- 评估编排 ----------------

export function evaluate(
  build: SampleBuild,
  inputs: MergedInputs,
  modelA: ResolvedModelRef,
  modelB: ResolvedModelRef,
  config: EvaluationConfig,
  purpose: AllowedUse,
  evaluatedAt: string,
): EvaluationResult {
  const purposeNotes: string[] = [];
  const evalA = evaluateModel(build, modelA, inputs, config.minClusters, purpose);
  const evalB = evaluateModel(build, modelB, inputs, config.minClusters, purpose);

  const { segments, orderDiffs } = segmentAnalyses(build, build, evalA.evaluation, evalB.evaluation, config.segmentKeys, config.minClusters);

  const stability = stabilityAnalysis(build, inputs, modelA, modelB, config, purpose);
  if (!modelA.allowedUses.includes(purpose)) purposeNotes.push(`模型 A ${modelA.name}@${modelA.revision} 未登记用途「${purpose}」`);
  if (!modelB.allowedUses.includes(purpose)) purposeNotes.push(`模型 B ${modelB.name}@${modelB.revision} 未登记用途「${purpose}」`);

  return {
    sampleId: build.sampleId,
    sampleLabel: build.sampleLabel,
    sampleWindow: build.window,
    sampleRevision: build.revision,
    sampleHash: build.sampleHash,
    sampleBuiltAt: build.builtAt,
    sample: build,
    evaluatedAt,
    config,
    modelA: evalA.evaluation,
    modelB: evalB.evaluation,
    stability,
    segments,
    orderDiffs,
    supportNotes: [...purposeNotes, ...evalA.evaluation.supportNotes, ...evalB.evaluation.supportNotes],
    disclaimers: [
      '没有可观测的真实渠道贡献标签：本页不输出准确率，也不宣布哪个模型更接近真实效果。',
      '净收入守恒、份额稳定或某渠道金额上升，都不能当作模型准确率。',
      '不发布因果效果，不自动调整投放。',
    ],
  };
}

/** 审查冻结指纹：模型、样本与关键指标一起哈希 */
export function evaluationFingerprint(r: EvaluationResult): string {
  return hashString(
    JSON.stringify({
      sampleId: r.sampleId,
      sampleRevision: r.sampleRevision,
      sampleHash: r.sampleHash,
      a: [r.modelA.model.registryId, r.modelA.model.revision, r.modelA.model.revisionHash],
      b: [r.modelB.model.registryId, r.modelB.model.revision, r.modelB.model.revisionHash],
      totals: [r.modelA.totalNet, r.modelA.totalAttributed, r.modelB.totalAttributed],
    }),
  );
}
