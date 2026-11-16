import { describe, expect, it } from 'vitest';
import {
  allocationBase,
  computeAttribution,
  eligibleTouchpoints,
  integerAllocation,
  modelWeights,
  verifyInvariants,
} from '@/engine/attribution';
import { snapshots, RULE_REVISION_V1 } from '@/data/sampleData';
import type { RunConfig } from '@/types/domain';

const baseConfig: RunConfig = {
  timezone: 'Asia/Shanghai',
  dealDefinition: 'net_of_refund_at_lock',
  windowDays: 7,
  model: 'last_touch',
  ruleRevision: RULE_REVISION_V1,
  decayHalfLifeDays: 7,
};

const models = ['last_touch', 'first_touch', 'linear', 'time_decay', 'position_based'] as const;

describe('归因引擎不变量（两个快照 × 五种模型）', () => {
  for (const snapshot of snapshots) {
    for (const model of models) {
      it(`${snapshot.snapshotId}/${model}：份额+未知=净收入，且份额不超过净收入`, () => {
        const results = computeAttribution(snapshot, { ...baseConfig, model }, '2026-11-02T00:00:00Z');
        const check = verifyInvariants(results);
        expect(check.ok, check.violations.join('；')).toBe(true);
        expect(results.totalAllocated).toBeLessThanOrEqual(results.totalNetRevenue);
        // 每单分摊逐单守恒
        for (const oa of results.orderAttributions) {
          if (oa.unknown) continue;
          expect(oa.allocations.reduce((s, a) => s + a.amount, 0)).toBe(oa.netAmount);
        }
      });
    }
  }
});

describe('授权与跨设备边界', () => {
  const snap = snapshots[0];

  it('跨设备未授权：O-2007 排除异设备 D-C1 触点，仅保留 D-C2', () => {
    const order = snap.orders.find((o) => o.orderId === 'O-2007')!;
    const { eligible, reasons } = eligibleTouchpoints(snap, order, baseConfig);
    expect(eligible.map((t) => t.touchpointId)).toEqual(['T-3009']);
    expect(reasons.some((r) => r.includes('T-3016') && r.includes('跨设备'))).toBe(true);
  });

  it('跨设备已授权：O-2001 旅程保留 D-A1 与 D-A2 三个触点', () => {
    const order = snap.orders.find((o) => o.orderId === 'O-2001')!;
    const { eligible } = eligibleTouchpoints(snap, order, baseConfig);
    expect(eligible.map((t) => t.touchpointId).sort()).toEqual(['T-3001', 'T-3002', 'T-3003']);
  });

  it('未授权标识触点 T-3014 与无人员订单 O-2004 进入未知来源', () => {
    const results = computeAttribution(snap, baseConfig, 't');
    const oa = results.orderAttributions.find((o) => o.orderId === 'O-2004')!;
    expect(oa.unknown).toBe(true);
    expect(results.unknownOrderIds).toContain('O-2004');
  });

  it('无订单级触点的 O-2006 进入未知来源，平台点击汇总不参与分配', () => {
    const results = computeAttribution(snap, baseConfig, 't');
    const oa = results.orderAttributions.find((o) => o.orderId === 'O-2006')!;
    expect(oa.unknown).toBe(true);
    expect(oa.excluded).toContain('无合格订单级触点');
  });
});

describe('净额、退款与成交定义', () => {
  const v1 = snapshots[0];
  const v2 = snapshots[1];

  it('取消订单 O-2008 任何口径下净额为 0 并被排除', () => {
    const order = v1.orders.find((o) => o.orderId === 'O-2008')!;
    const ov = v1.orderVersions.find((v) => v.orderId === 'O-2008')!;
    for (const deal of ['paid_order', 'shipped_order', 'net_of_refund_at_lock'] as const) {
      expect(allocationBase(order, ov, deal)).toBe(0);
    }
    const results = computeAttribution(v1, { ...baseConfig }, 't');
    expect(results.excludedZeroNetOrderIds).toContain('O-2008');
  });

  it('部分退款 O-2005：净额 = 毛额 − 退款', () => {
    const ov = v1.orderVersions.find((v) => v.orderId === 'O-2005')!;
    expect(ov.grossAmount - ov.refundedAmount).toBe(ov.netAmount);
    expect(ov.netAmount).toBe(209900);
  });

  it('迟到退款 R-1006 只在新快照生效：O-2002 净额由 89900 降为 69900', () => {
    const oldV = v1.orderVersions.find((v) => v.orderId === 'O-2002')!;
    const newV = v2.orderVersions.find((v) => v.orderId === 'O-2002')!;
    expect(oldV.netAmount).toBe(89900);
    expect(newV.netAmount).toBe(69900);
    // 旧快照结果保持原值（不可变）
    const r1 = computeAttribution(v1, baseConfig, 't1');
    const r2 = computeAttribution(v2, { ...baseConfig, ruleRevision: v2.ruleRevision }, 't2');
    const oa1 = r1.orderAttributions.find((o) => o.orderId === 'O-2002')!;
    const oa2 = r2.orderAttributions.find((o) => o.orderId === 'O-2002')!;
    expect(oa1.netAmount).toBe(89900);
    expect(oa2.netAmount).toBe(69900);
  });

  it('付款口径下毛额口径与净额口径可区分（部分退款单）', () => {
    const order = v1.orders.find((o) => o.orderId === 'O-2005')!;
    const ov = v1.orderVersions.find((v) => v.orderId === 'O-2005')!;
    expect(allocationBase(order, ov, 'paid_order')).toBe(order.grossAmount);
    expect(allocationBase(order, ov, 'net_of_refund_at_lock')).toBe(ov.netAmount);
  });
});

describe('模型权重与整数分摊', () => {
  it('线性模型权重和为 1', () => {
    const snap = snapshots[0];
    const order = snap.orders.find((o) => o.orderId === 'O-2001')!;
    const { eligible } = eligibleTouchpoints(snap, order, baseConfig);
    const w = modelWeights(eligible, 'linear', 7);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('整数分摊严格守恒（含奇数尾差并入末次）', () => {
    const amounts = integerAllocation(10001, [0.3333, 0.3333, 0.3334]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(10001);
  });

  it('末次/首次模型在多触点旅程上分别收口到最后/首个触点', () => {
    const snap = snapshots[0];
    const order = snap.orders.find((o) => o.orderId === 'O-2001')!;
    const { eligible } = eligibleTouchpoints(snap, order, baseConfig);
    expect(modelWeights(eligible, 'last_touch', 7).findIndex((w) => w === 1)).toBe(eligible.length - 1);
    expect(modelWeights(eligible, 'first_touch', 7).findIndex((w) => w === 1)).toBe(0);
  });
});
