import type {
  AllocationLine,
  AttributionModel,
  ChannelSummary,
  DataSnapshot,
  Order,
  OrderAttribution,
  OrderVersion,
  RunConfig,
  RunResults,
  Touchpoint,
} from '@/types/domain';

// ============================================================
// 归因引擎（纯函数，便于单测）
// 关键边界：
//  1. 只使用授权的确定性标识；跨设备归并要求人员档案 crossDeviceAuthorized
//  2. 只有带稳定订单关联的订单级触点参与逐单分配
//  3. 无授权人员标识 / 无合格触点 → 未知来源单列
//  4. 每单分配额之和严格等于该单分配基数（整数分摊，尾差给末次触点）
// ============================================================

const MS_PER_DAY = 86_400_000;

export interface EligibilityDecision {
  eligible: Touchpoint[];
  reasons: string[];
}

/** 成交定义决定逐单分配基数（分） */
export function allocationBase(order: Order, ov: OrderVersion, deal: RunConfig['dealDefinition']): number {
  if (order.status === 'cancelled') return 0; // 取消单任何口径都不参与
  switch (deal) {
    case 'net_of_refund_at_lock':
      return ov.netAmount;
    case 'paid_order':
      // 付款口径：全额退款视为未成交，部分退款在付款时点仍按毛额
      return ov.status === 'refunded_full' ? 0 : order.grossAmount;
    case 'shipped_order':
      // 发货口径：按发货时毛额，退款在后续版本另行处理
      return order.grossAmount;
  }
}

/** 判定一个订单的合格触点（窗口 + 授权 + 跨设备边界） */
export function eligibleTouchpoints(snapshot: DataSnapshot, order: Order, config: RunConfig): EligibilityDecision {
  const reasons: string[] = [];
  const windowStart = new Date(order.orderTime).getTime() - config.windowDays * MS_PER_DAY;
  const link = order.personId ? snapshot.identityLinks.find((l) => l.personId === order.personId) : undefined;

  const candidates = snapshot.touchpoints.filter((t) => t.orderId === order.orderId);
  const eligible: Touchpoint[] = [];

  for (const t of candidates) {
    const tTime = new Date(t.eventTime).getTime();
    if (tTime < windowStart || tTime > new Date(order.orderTime).getTime()) {
      reasons.push(`${t.touchpointId}：超出 ${config.windowDays} 天归因窗口`);
      continue;
    }
    if (!t.identityAuthorized) {
      reasons.push(`${t.touchpointId}：标识未授权，禁止用于归因`);
      continue;
    }
    if (t.deviceId !== order.deviceId && link && !link.crossDeviceAuthorized) {
      reasons.push(`${t.touchpointId}：人员档案无跨设备匹配授权，设备 ${t.deviceId} 不并入本旅程`);
      continue;
    }
    if (order.personId === null || t.personId !== order.personId) {
      reasons.push(`${t.touchpointId}：缺少与订单一致的授权人员标识`);
      continue;
    }
    eligible.push(t);
  }

  eligible.sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
  return { eligible, reasons };
}

/** 各模型权重（返回与触点等长、和为 1 的数组；单触点直接为 1） */
export function modelWeights(touchpoints: Touchpoint[], model: AttributionModel, halfLifeDays: number): number[] {
  const n = touchpoints.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  switch (model) {
    case 'last_touch':
      return touchpoints.map((_, i) => (i === n - 1 ? 1 : 0));
    case 'first_touch':
      return touchpoints.map((_, i) => (i === 0 ? 1 : 0));
    case 'linear':
      return touchpoints.map(() => 1 / n);
    case 'time_decay': {
      const orderTime = new Date(touchpoints[n - 1].eventTime).getTime();
      const raw = touchpoints.map((t) => {
        const ageDays = (orderTime - new Date(t.eventTime).getTime()) / MS_PER_DAY;
        return Math.pow(2, -ageDays / halfLifeDays);
      });
      const sum = raw.reduce((a, b) => a + b, 0);
      return raw.map((v) => v / sum);
    }
    case 'position_based': {
      // U 型：首末各 40%，中间平分 20%
      if (n === 2) return [0.5, 0.5];
      const middle = 0.2 / (n - 2);
      return touchpoints.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : middle));
    }
  }
}

/** 整数分摊：先按权重取整，尾差（可正可负）并入末次触点，保证总额严格守恒 */
export function integerAllocation(base: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const raw = weights.map((w) => Math.round(base * w));
  const diff = base - raw.reduce((a, b) => a + b, 0);
  raw[raw.length - 1] += diff;
  return raw;
}

export function computeAttribution(snapshot: DataSnapshot, config: RunConfig, computedAt: string): RunResults {
  const orderAttributions: OrderAttribution[] = [];
  const excludedZeroNetOrderIds: string[] = [];
  let unknownRevenue = 0;
  const unknownOrderIds: string[] = [];
  let totalNetRevenue = 0;

  for (const order of snapshot.orders) {
    const ov = snapshot.orderVersions.find((v) => v.orderId === order.orderId);
    if (!ov) continue;
    const base = allocationBase(order, ov, config.dealDefinition);
    if (base <= 0) {
      excludedZeroNetOrderIds.push(order.orderId);
      continue;
    }
    totalNetRevenue += base;

    const { eligible, reasons } = eligibleTouchpoints(snapshot, order, config);

    if (order.personId === null) {
      unknownRevenue += base;
      unknownOrderIds.push(order.orderId);
      orderAttributions.push({
        orderId: order.orderId,
        personId: null,
        netAmount: base,
        eligibleTouchpointIds: [],
        allocations: [],
        unknown: true,
        excluded: '无授权人员标识，整单计入未知来源',
      });
      continue;
    }

    if (eligible.length === 0) {
      unknownRevenue += base;
      unknownOrderIds.push(order.orderId);
      orderAttributions.push({
        orderId: order.orderId,
        personId: order.personId,
        netAmount: base,
        eligibleTouchpointIds: [],
        allocations: [],
        unknown: true,
        excluded: reasons.join('；') || '无合格订单级触点',
      });
      continue;
    }

    const weights = modelWeights(eligible, config.model, config.decayHalfLifeDays);
    const amounts = integerAllocation(base, weights);
    const allocations: AllocationLine[] = eligible.map((t, i) => ({
      channelId: t.channelId,
      touchpointId: t.touchpointId,
      weight: weights[i],
      amount: amounts[i],
    }));

    orderAttributions.push({
      orderId: order.orderId,
      personId: order.personId,
      netAmount: base,
      eligibleTouchpointIds: eligible.map((t) => t.touchpointId),
      allocations,
      unknown: false,
      excluded: reasons.length ? reasons.join('；') : undefined,
    });
  }

  // 渠道汇总
  const map = new Map<string, ChannelSummary>();
  for (const channel of snapshot.channels) {
    map.set(channel.channelId, { channelId: channel.channelId, attributedRevenue: 0, orderCount: 0, touchpointCount: 0 });
  }
  const orderCounted = new Set<string>();
  for (const oa of orderAttributions) {
    if (oa.unknown) continue;
    const touchedChannels = new Set<string>();
    for (const line of oa.allocations) {
      const summary = map.get(line.channelId);
      if (!summary) continue;
      summary.attributedRevenue += line.amount;
      summary.touchpointCount += 1;
      touchedChannels.add(line.channelId);
    }
    for (const channelId of touchedChannels) {
      const summary = map.get(channelId);
      if (summary && !orderCounted.has(`${oa.orderId}:${channelId}`)) {
        summary.orderCount += 1;
        orderCounted.add(`${oa.orderId}:${channelId}`);
      }
    }
  }

  const channelSummaries = [...map.values()].filter((s) => s.attributedRevenue > 0 || s.touchpointCount > 0);
  const totalAllocated = channelSummaries.reduce((s, c) => s + c.attributedRevenue, 0);

  return {
    model: config.model,
    computedAt,
    orderAttributions,
    channelSummaries,
    unknownRevenue,
    unknownOrderIds,
    totalNetRevenue,
    totalAllocated,
    excludedZeroNetOrderIds,
  };
}

/** 引擎不变量：渠道份额 + 未知来源 = 参与分配的净收入；逐单分摊守恒 */
export function verifyInvariants(results: RunResults): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (results.totalAllocated + results.unknownRevenue !== results.totalNetRevenue) {
    violations.push(
      `守恒失败：已分配 ${results.totalAllocated} + 未知 ${results.unknownRevenue} ≠ 净收入 ${results.totalNetRevenue}`,
    );
  }
  if (results.totalAllocated > results.totalNetRevenue) {
    violations.push('订单份额总和超过净收入');
  }
  for (const oa of results.orderAttributions) {
    if (oa.unknown) continue;
    const sum = oa.allocations.reduce((s, a) => s + a.amount, 0);
    if (sum !== oa.netAmount) {
      violations.push(`订单 ${oa.orderId} 分摊和 ${sum} ≠ 净额 ${oa.netAmount}`);
    }
  }
  return { ok: violations.length === 0, violations };
}
