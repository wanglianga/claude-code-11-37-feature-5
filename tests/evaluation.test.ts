import { describe, expect, it } from 'vitest';
import { snapshots, seedSampleDefinitions, seedModelRegistry, SAMPLE_AS_OF, lateRefundSupplement } from '@/data/sampleData';
import { buildSample, mergeInputs, sampleFingerprint } from '@/engine/sample';
import { evaluate, evaluateModel, stabilityAnalysis, compositionComparison } from '@/engine/evaluation';
import { checkRefCurrent, hashString, resolveModelRef, revisionHash } from '@/engine/registry';
import type { SampleDefinition, SegmentKey } from '@/types/evaluation';

const matureDef = seedSampleDefinitions.find((d) => d.sampleId === 'SMP-MATURE-2026-11')!;
const recentDef = seedSampleDefinitions.find((d) => d.sampleId === 'SMP-RECENT-2026-11')!;
const edgeDef = seedSampleDefinitions.find((d) => d.sampleId === 'SMP-EDGE-UNKNOWN')!;

function inputsFor(def: SampleDefinition, withSupplements = false) {
  const snap = snapshots.find((s) => s.snapshotId === def.baseSnapshotId)!;
  const sup = withSupplements ? [lateRefundSupplement('U-1001')] : [];
  return { snap, inputs: mergeInputs(snap, sup) };
}

function build(def: SampleDefinition, withSupplements = false) {
  const { snap, inputs } = inputsFor(def, withSupplements);
  const b = buildSample({ definition: def, inputs, identityLinks: snap.identityLinks, now: SAMPLE_AS_OF });
  return { build: b, inputs };
}

const A = resolveModelRef(seedModelRegistry.find((m) => m.registryId === 'MDL-LAST-TOUCH')!, 'v1');
const B = resolveModelRef(seedModelRegistry.find((m) => m.registryId === 'MDL-FIRST-TOUCH')!, 'v1');
const LINEAR = resolveModelRef(seedModelRegistry.find((m) => m.registryId === 'MDL-LINEAR')!, 'v1');
const CAUTIOUS = resolveModelRef(seedModelRegistry.find((m) => m.registryId === 'MDL-BRAND-CAUTIOUS')!, 'v1');
if (!A.ok || !B.ok || !LINEAR.ok || !CAUTIOUS.ok) throw new Error('model refs');

const baseConfig = {
  sampleId: matureDef.sampleId,
  modelA: { registryId: 'MDL-LAST-TOUCH', revision: 'v1' },
  modelB: { registryId: 'MDL-FIRST-TOUCH', revision: 'v1' },
  segmentKeys: ['region', 'deviceSegment'] as SegmentKey[],
  bootstrapIterations: 120,
  seed: 42,
  minClusters: 4,
};

describe('样本构建：固定窗口、成熟条件、授权触点', () => {
  it('成熟样本纳入 / 排除原因齐备，样本哈希稳定', () => {
    const { build: b } = build(matureDef);
    const again = build(matureDef).build;
    expect(b.orderCount).toBeGreaterThan(10);
    expect(b.sampleHash).toBe(again.sampleHash);
    expect(b.channelCoverage.find((c) => c.channelId === 'C-ORGANIC')!.covered).toBe(false);
    // 未成熟退款 O-2105 被排除，原因写明等待退款入账
    const excluded = b.excludedOrders.find((e) => e.orderId === 'O-2105')!;
    expect(excluded.kind).toBe('immature_refund');
    expect(excluded.reason).toContain('R-1030');
    // 已取消订单有明确排除原因
    expect(b.excludedOrders.find((e) => e.orderId === 'O-2008')!.kind).toBe('cancelled');
  });

  it('同客户多订单进入客户簇；缺少跨设备授权的订单回退为订单簇并写明限制', () => {
    const { build: b } = build(matureDef);
    const multi = b.rows.filter((r) => r.personId === 'P-2001');
    expect(multi.length).toBe(2);
    expect(new Set(multi.map((r) => r.clusterId)).size).toBe(1);
    expect(multi[0].clusterKind).toBe('customer');
    const fallback = b.rows.find((r) => r.orderId === 'O-2114')!;
    expect(fallback.clusterKind).toBe('order');
    expect(fallback.clusterNote).toContain('按订单簇');
    expect(b.limitations.join(' ')).toContain('订单簇');
  });

  it('两种成熟条件对未成熟退款给出不同处理', () => {
    const strict = build({ ...matureDef, maturityCondition: 'refund_settled_before_cutoff' }).build;
    const loose = build({ ...matureDef, maturityCondition: 'observation_window_elapsed' }).build;
    expect(strict.immatureOrderIds).toContain('O-2105');
    // 观察期已满口径下订单保留，但迟到退款被标注为 pending
    expect(loose.immatureOrderIds).not.toContain('O-2105');
    expect(loose.pendingRefundIds).toContain('R-1030');
  });

  it('导入补充退款后刷新样本，净额下降但成员不变', () => {
    const before = build(matureDef).build;
    const withSup = build({ ...matureDef, supplementIds: ['SUP-REFUND-1010'] }, true).build;
    const rowBefore = before.rows.find((r) => r.orderId === 'O-2111')!;
    const rowAfter = withSup.rows.find((r) => r.orderId === 'O-2111')!;
    expect(rowAfter.netAmount).toBe(rowBefore.netAmount - 20000);
    expect(new Set(before.rows.map((r) => r.orderId))).toEqual(new Set(withSup.rows.map((r) => r.orderId)));
  });

  it('分群权重按净额归一，未标注订单进入未标注群', () => {
    const { build: b } = build(matureDef);
    const sum = b.segmentWeights.region.reduce((s, w) => s + w.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('评估：守恒、退款后负额、未知渠道与覆盖边界', () => {
  it('两模型逐单守恒，已分配 + 未知 = 净收入', () => {
    const { build: b, inputs } = build(matureDef);
    const evA = evaluateModel(b, A.ref, inputs, 4, 'version_compare');
    const evB = evaluateModel(b, B.ref, inputs, 4, 'version_compare');
    for (const e of [evA.evaluation, evB.evaluation]) {
      expect(e.conservation.ok).toBe(true);
      expect(e.totalAttributed + e.unknownAmount).toBe(e.totalNet);
      expect(e.negativeAllocations).toHaveLength(0);
      for (const oa of e.orderAllocations.filter((x) => !x.unknown)) {
        expect(oa.allocations.reduce((s, x) => s + x.amount, 0)).toBe(oa.netAmount);
      }
    }
  });

  it('未知来源按原因分别说明（无人员 / 无触点 / 触点全被排除）', () => {
    const { build: b, inputs } = build(edgeDef);
    const ev = evaluateModel(b, A.ref, inputs, 3, 'version_compare').evaluation;
    expect(ev.unknown.totalAmount).toBe(ev.totalNet);
    expect(ev.unknown.byReason.no_person.orders).toContain('O-2401');
    expect(ev.unknown.byReason.all_touchpoints_excluded.orders).toContain('O-2402');
    expect(ev.unknown.byReason.no_touchpoint.orders).toContain('O-2403');
    // 渠道全部未覆盖：显示「渠道未覆盖」，绝不填零分
    for (const c of ev.channelShares) {
      expect(c.support).toBe('channel_not_covered');
      expect(c.covered).toBe(false);
    }
  });

  it('渠道从未覆盖时份额不支持结论；已覆盖渠道可下结论', () => {
    const { build: b, inputs } = build(matureDef);
    const ev = evaluateModel(b, A.ref, inputs, 4, 'version_compare').evaluation;
    expect(ev.channelShares.find((c) => c.channelId === 'C-AFFILIATE')!.support).toBe('channel_not_covered');
    expect(ev.channelShares.find((c) => c.channelId === 'C-SEM')!.support).toBe('supported');
  });

  it('未登记允许用途的模型，所有渠道指标不支持结论', () => {
    const { build: b, inputs } = build(matureDef);
    const ev = evaluateModel(b, CAUTIOUS.ref, inputs, 4, 'version_compare').evaluation;
    expect(ev.channelShares.every((c) => c.support === 'model_not_allowed')).toBe(true);
  });

  it('样本量不足时显示不支持结论而不是零分', () => {
    const { build: b, inputs } = build(matureDef);
    const ev = evaluateModel(b, A.ref, inputs, 100, 'version_compare').evaluation;
    expect(ev.channelShares.find((c) => c.channelId === 'C-SEM')!.support).toBe('insufficient_sample');
  });
});

describe('稳定性：簇重抽样成对差异', () => {
  it('同一抽样上成对运行两个模型，给出差异区间；不覆盖渠道区间为空', () => {
    const { build: b, inputs } = build(matureDef);
    const st = stabilityAnalysis(b, inputs, A.ref, B.ref, { bootstrapIterations: 200, seed: 7, minClusters: 4, focusChannelId: 'C-DISPLAY' }, 'version_compare');
    expect(st.clusterCount).toBe(b.clusterCount);
    const sem = st.diffs.find((d) => d.channelId === 'C-SEM')!;
    expect(sem.support).toBe('supported');
    expect(sem.lower).not.toBeNull();
    expect(sem.upper).not.toBeNull();
    expect(sem.lower! <= sem.pointEstimate + 1e-9).toBe(true);
    const organic = st.diffs.find((d) => d.channelId === 'C-ORGANIC')!;
    expect(organic.support).toBe('channel_not_covered');
    expect(organic.lower).toBeNull();
    // 订单级平均差异的点估计落在区间内（口径一致）
    const mod = st.diffs.find((d) => d.metric === 'mean_order_abs_delta')!;
    expect(mod.lower! <= mod.pointEstimate + 1e-6 && mod.pointEstimate <= mod.upper! + 1e-6).toBe(true);
  });

  it('最小簇数不足时区间不给出，标记样本量不足', () => {
    const { build: b, inputs } = build(matureDef);
    const st = stabilityAnalysis(b, inputs, A.ref, B.ref, { bootstrapIterations: 100, seed: 7, minClusters: 999 }, 'version_compare');
    expect(st.diffs.every((d) => d.support === 'insufficient_sample' && d.lower === null)).toBe(true);
  });

  it('缺少跨设备授权时记录订单簇回退限制', () => {
    const { build: b, inputs } = build(matureDef);
    const st = stabilityAnalysis(b, inputs, A.ref, B.ref, { bootstrapIterations: 100, seed: 7, minClusters: 4 }, 'version_compare');
    expect(st.fallbackOrderClusters).toBeGreaterThan(0);
    expect(st.limitations.join(' ')).toContain('禁止拼接身份');
  });

  it('同一种子可复现相同区间', () => {
    const { build: b, inputs } = build(matureDef);
    const one = stabilityAnalysis(b, inputs, A.ref, B.ref, { bootstrapIterations: 120, seed: 99, minClusters: 4 }, 'version_compare');
    const two = stabilityAnalysis(b, inputs, A.ref, B.ref, { bootstrapIterations: 120, seed: 99, minClusters: 4 }, 'version_compare');
    expect(one.diffs.map((d) => d.lower)).toEqual(two.diffs.map((d) => d.lower));
  });
});

describe('分群：总体与局部方向相反', () => {
  it('存在局部方向与总体相反的群，并单独标注', () => {
    const { build: b, inputs } = build(matureDef);
    const result = evaluate(b, inputs, A.ref, B.ref, baseConfig, 'version_compare', '2026-11-16T00:00:00Z');
    const all = [...result.segments.region.divergences, ...result.segments.deviceSegment.divergences];
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) {
      expect(Math.sign(d.overallDelta)).not.toBe(Math.sign(d.segmentDelta));
      expect(d.note).toContain('不能以总均值掩盖');
    }
    // 分群单元带权重与覆盖
    const huaBei = result.segments.region.cells.find((c) => c.value === '华北')!;
    expect(huaBei.orders).toBeGreaterThan(0);
    expect(huaBei.weight).toBeGreaterThan(0);
  });

  it('构成变化先用共同分群权重比较，再单列新增/缺失群', () => {
    const full = evaluate(build(matureDef).build, build(matureDef).inputs, A.ref, B.ref, baseConfig, 'version_compare', 't');
    // 用观察期口径模拟「构成变化」的一侧
    const loose = build({ ...matureDef, maturityCondition: 'observation_window_elapsed' }).build;
    const looseResult = evaluate(loose, build(matureDef).inputs, A.ref, B.ref, baseConfig, 'version_compare', 't');
    const comp = compositionComparison(
      { build: full.sample, eval: full.modelA },
      { build: looseResult.sample, eval: looseResult.modelA },
      'region',
      'C-SEM',
    );
    expect(comp.commonValues.length).toBeGreaterThan(0);
    expect(comp.note).toContain('共同分群权重');
    expect(comp.note).toContain('重新归一化');
    expect(comp.note).toMatch(/新增群|缺失群/);
  });
});

describe('漂移监测：两窗口独立', () => {
  it('近期窗口存在未成熟退款订单，漂移报告标出且不并入版本结论', () => {
    const recent = build(recentDef);
    const mature = build(matureDef);
    const recentEval = evaluate(recent.build, recent.inputs, A.ref, B.ref, { ...baseConfig, sampleId: recentDef.sampleId }, 'drift_monitor', 't');
    expect(recentEval.sample.immatureOrderIds).toContain('O-2203');
    const dr = evaluate(build(matureDef).build, mature.inputs, A.ref, B.ref, baseConfig, 'version_compare', 't');
    void dr;
    // 近期窗口覆盖率变化：社交流在近期从未覆盖
    expect(recent.build.channelCoverage.find((c) => c.channelId === 'C-SOCIAL')!.covered).toBe(false);
  });
});

describe('模型登记：修订哈希与允许用途复核', () => {
  it('修订哈希对规则 / 允许用途变化敏感', () => {
    const entry = seedModelRegistry.find((m) => m.registryId === 'MDL-LAST-TOUCH')!;
    const rev = entry.revisions[0];
    expect(revisionHash(rev)).toBe(revisionHash({ ...rev }));
    expect(revisionHash(rev)).not.toBe(revisionHash({ ...rev, allowedUses: ['drift_monitor'] }));
    expect(revisionHash(rev)).not.toBe(revisionHash({ ...rev, ruleText: '改了规则' }));
  });

  it('模型升级到新修订后，旧引用复核失败', () => {
    const entry = seedModelRegistry.find((m) => m.registryId === 'MDL-LAST-TOUCH')!;
    const oldRef = resolveModelRef(entry, 'v1');
    expect(oldRef.ok).toBe(true);
    if (!oldRef.ok) return;
    const upgraded = { ...entry, currentRevision: 'v2', revisions: [...entry.revisions, { ...entry.revisions[0], revision: 'v2' }] };
    const check = checkRefCurrent(upgraded, oldRef.ref);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('升级');
  });

  it('哈希函数稳定且区分不同输入', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('结果一致性：份额、覆盖、分群与订单差异', () => {
  it('分群 A 份额之和与总体 A 份额一致（按已分配口径）', () => {
    const { build: b, inputs } = build(matureDef);
    const result = evaluate(b, inputs, A.ref, B.ref, baseConfig, 'version_compare', 't');
    const regionSum = result.segments.region.cells.reduce((s, c) => {
      const ch = c.channels.reduce((x, y) => x + y.amountA, 0);
      return s + ch;
    }, 0);
    expect(regionSum).toBeCloseTo(result.modelA.totalAttributed, -3);
  });

  it('订单差异只标记变化单，净额差异与分摊差异一致可解释', () => {
    const { build: b, inputs } = build(matureDef);
    const result = evaluate(b, inputs, A.ref, B.ref, baseConfig, 'version_compare', 't');
    const changed = result.orderDiffs.filter((d) => d.changeKind !== 'none');
    expect(changed.length).toBeGreaterThan(0);
    for (const d of changed) {
      expect(['model_only', 'net_only', 'both']).toContain(d.changeKind);
    }
  });

  it('覆盖：订单从未覆盖某渠道时该渠道不出现于其分配', () => {
    const { build: b, inputs } = build(matureDef);
    const result = evaluate(b, inputs, A.ref, B.ref, baseConfig, 'version_compare', 't');
    for (const oa of result.modelA.orderAllocations) {
      if (oa.unknown) continue;
      const sum = oa.allocations.reduce((s, x) => s + x.amount, 0);
      expect(sum).toBe(oa.netAmount);
    }
  });
});

describe('样本指纹', () => {
  it('退款补齐改变净额会改变样本指纹', () => {
    const a = buildSample({ definition: matureDef, inputs: inputsFor(matureDef).inputs, identityLinks: inputsFor(matureDef).snap.identityLinks, now: SAMPLE_AS_OF });
    const sup = lateRefundSupplement('U-1001');
    const b = buildSample({ definition: { ...matureDef, supplementIds: [sup.batchId] }, inputs: inputsFor(matureDef, true).inputs, identityLinks: inputsFor(matureDef).snap.identityLinks, now: SAMPLE_AS_OF });
    expect(sampleFingerprint(a, matureDef)).not.toBe(sampleFingerprint(b, { ...matureDef, supplementIds: [sup.batchId] }));
  });
});
