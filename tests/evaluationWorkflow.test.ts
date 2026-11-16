import { beforeEach, describe, expect, it } from 'vitest';

// node 环境下为 zustand persist 提供最小 localStorage 桩
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

import { useAppStore } from '@/store/useAppStore';
import type { EvaluationConfig } from '@/types/evaluation';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const matureConfig: EvaluationConfig = {
  sampleId: 'SMP-MATURE-2026-11',
  modelA: { registryId: 'MDL-LAST-TOUCH', revision: 'v1' },
  modelB: { registryId: 'MDL-FIRST-TOUCH', revision: 'v1' },
  segmentKeys: ['region', 'deviceSegment'],
  bootstrapIterations: 120,
  seed: 5,
  minClusters: 4,
  focusChannelId: 'C-DISPLAY',
};

async function waitForEval(evalId: string, timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = useAppStore.getState().evaluations.find((x) => x.evalId === evalId);
    if (e && e.status !== 'running') return;
    await sleep(60);
  }
  throw new Error('评估超时');
}

describe('模型评估全生命周期', () => {
  beforeEach(() => useAppStore.getState().resetDemo());

  it('成熟样本评估 → 守恒/稳定性/分群 → 版本对照（同样本换模型）', async () => {
    const r = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    expect(r.ok).toBe(true);
    await waitForEval(r.evalId!);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === r.evalId)!;
    expect(ev.status).toBe('completed');
    expect(ev.result).toBeTruthy();
    const result = ev.result!;
    expect(result.modelA.conservation.ok).toBe(true);
    expect(result.modelB.conservation.ok).toBe(true);
    expect(result.modelA.totalAttributed + result.modelA.unknownAmount).toBe(result.modelA.totalNet);
    expect(result.stability.diffs.length).toBeGreaterThan(0);
    // 覆盖边界：联盟流量从未覆盖
    expect(result.modelA.channelShares.find((c) => c.channelId === 'C-AFFILIATE')!.support).toBe('channel_not_covered');
    // 同一份样本换模型：样本哈希一致，只隔离模型因素
    const modelSwap = ev.comparisons.find((c) => c.kind === 'model_swap')!;
    expect(modelSwap).toBeTruthy();
    expect(modelSwap.base.sampleHash).toBe(modelSwap.alt.sampleHash);
    expect(modelSwap.isolatedFactor).toBe('model');
    expect(modelSwap.changedOrderCount).toBeGreaterThan(0);
  });

  it('库存退款的近期窗口样本只能做漂移监测，不能做版本比较', () => {
    const r = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, sampleId: 'SMP-RECENT-2026-11' },
      purpose: 'version_compare',
      minClusters: 4,
      by: 'U-1001',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('两个窗口不混排');
  });

  it('近期窗口漂移报告包含未成熟退款与新增/缺失群', async () => {
    const r = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, sampleId: 'SMP-RECENT-2026-11' },
      purpose: 'drift_monitor',
      minClusters: 3,
      by: 'U-1001',
    });
    expect(r.ok).toBe(true);
    await waitForEval(r.evalId!);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === r.evalId)!;
    expect(ev.drift).toBeTruthy();
    expect(ev.drift!.immatureRecentOrderIds).toContain('O-2203');
    // 近期窗口新增 Tablet 设备群
    const comp = ev.drift!.composition.deviceSegment;
    expect(comp.addedValues).toContain('Tablet');
    // 成熟窗口的西部区域在近期窗口缺失
    expect(ev.drift!.composition.region.missingValues).toContain('西部');
  });

  it('切换样本：旧运行中任务被取消，其结果不会覆盖新结果', async () => {
    const store = useAppStore.getState();
    const first = store.startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    expect(first.ok).toBe(true);
    // 立刻用另一样本启动新评估
    const second = store.startEvaluationRun({
      config: { ...matureConfig, sampleId: 'SMP-EDGE-UNKNOWN' },
      purpose: 'version_compare',
      minClusters: 3,
      by: 'U-1001',
    });
    expect(second.ok).toBe(true);
    const old = useAppStore.getState().evaluations.find((e) => e.evalId === first.evalId!)!;
    expect(old.status).toBe('cancelled');
    expect(old.cancelReason).toContain('取代');
    await waitForEval(second.evalId!);
    const stale = useAppStore.getState().evaluations.find((e) => e.evalId === first.evalId!)!;
    // 旧任务结果未写入
    expect(stale.status).toBe('cancelled');
    expect(stale.result).toBeUndefined();
    const fresh = useAppStore.getState().evaluations.find((e) => e.evalId === second.evalId!)!;
    expect(fresh.status).toBe('completed');
    expect(fresh.sampleId).toBe('SMP-EDGE-UNKNOWN');
  });

  it('取消后到达的结果被丢弃', async () => {
    const r = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    useAppStore.getState().cancelEvaluation(r.evalId!);
    await sleep(1600);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === r.evalId)!;
    expect(ev.status).toBe('cancelled');
    expect(ev.result).toBeUndefined();
  });

  it('审查引用模型修订与样本哈希：批准冻结 → 发布 → 模型升级后旧审查失效', async () => {
    const r = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    await waitForEval(r.evalId!);
    const review = useAppStore.getState().createReview({ evalId: r.evalId!, title: '双月模型评估', by: 'U-1001' });
    expect(review.ok).toBe(true);
    const rid = review.reviewId!;
    expect(useAppStore.getState().reviews.find((x) => x.reviewId === rid)!.frozen).toBeUndefined();

    const approve = useAppStore.getState().approveReview(rid, 'U-2001');
    expect(approve.ok).toBe(true);
    const approved = useAppStore.getState().reviews.find((x) => x.reviewId === rid)!;
    expect(approved.frozen).toBeTruthy();
    expect(approved.frozen!.sampleHash).toBe(approved.sampleHash);
    expect(approved.frozen!.conservationA).toBe(true);

    const publish = useAppStore.getState().publishReview(rid, 'U-2001');
    expect(publish.ok).toBe(true);
    expect(useAppStore.getState().reviews.find((x) => x.reviewId === rid)!.status).toBe('published');

    // 模型修订升级：旧审查不再作为新分析的有效性证明
    const bump = useAppStore.getState().addModelRevision({
      registryId: 'MDL-LAST-TOUCH', revision: 'v2', baseModel: 'last_touch', decayHalfLifeDays: 7, ruleText: '修订后的规则', allowedUses: ['version_compare', 'drift_monitor', 'review_basis'], note: '调整', by: 'U-1001',
    });
    expect(bump.ok).toBe(true);
    const after = useAppStore.getState().reviews.find((x) => x.reviewId === rid)!;
    expect(after.validForNewAnalysis).toBe(false);
    expect(after.invalidationReason).toContain('升级');
  });

  it('退款补齐生成新样本修订，报告给出模型 / 样本 / 退款三类对照，旧审查保留原结果', async () => {
    // 先完成一次成熟样本评估并生成审查（旧结果）
    const first = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    await waitForEval(first.evalId!);
    const review = useAppStore.getState().createReview({ evalId: first.evalId!, title: '补齐前审查', by: 'U-1001' });
    useAppStore.getState().approveReview(review.reviewId!, 'U-2001');
    const frozenBefore = structuredClone(useAppStore.getState().reviews.find((x) => x.reviewId === review.reviewId!)!.frozen!);

    // 导入退款补充并刷新样本
    useAppStore.getState().loadBuiltinSupplement('refund', 'U-1001');
    const refresh = useAppStore.getState().refreshSampleRefunds('SMP-MATURE-2026-11', 'U-1001');
    expect(refresh.ok).toBe(true);
    const newSampleId = `SMP-MATURE-2026-11-R${refresh.newRevision}`;

    const second = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, sampleId: newSampleId },
      purpose: 'version_compare',
      minClusters: 4,
      by: 'U-1001',
    });
    expect(second.ok).toBe(true);
    await waitForEval(second.evalId!);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === second.evalId!)!;
    const kinds = ev.comparisons.map((c) => c.kind);
    expect(kinds).toContain('model_swap');
    expect(kinds).toContain('refund_update');
    // 只更新退款对照：成员一致、差异来自净额
    const refundCmp = ev.comparisons.find((c) => c.kind === 'refund_update')!;
    expect(refundCmp.netDelta).not.toBe(0);
    expect(refundCmp.isolatedFactor).toBe('refund');

    // 旧审查冻结结果保持不变
    const frozenAfter = useAppStore.getState().reviews.find((x) => x.reviewId === review.reviewId!)!.frozen!;
    expect(frozenAfter.totalNet).toBe(frozenBefore.totalNet);
    expect(frozenAfter.sampleHash).toBe(frozenBefore.sampleHash);
  });

  it('撤回后旧报告可回看但不能用于新分析；发布前复核阻断并发撤回', async () => {
    const r = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    await waitForEval(r.evalId!);
    const review = useAppStore.getState().createReview({ evalId: r.evalId!, title: '待撤回审查', by: 'U-1001' });
    const rid = review.reviewId!;
    useAppStore.getState().approveReview(rid, 'U-2001');

    // 模拟并发撤回：批准后立即撤回，再尝试发布
    const revoke = useAppStore.getState().revokeReview(rid, 'U-2001', '规则调整');
    expect(revoke.ok).toBe(true);
    const revoked = useAppStore.getState().reviews.find((x) => x.reviewId === rid)!;
    expect(revoked.status).toBe('revoked');
    expect(revoked.validForNewAnalysis).toBe(false);
    // 冻结结果仍保留供回看
    expect(revoked.frozen).toBeTruthy();

    // 撤回后状态不再是「已批准」，发布被阻断（并发撤回后不会把旧结论重新发布）
    const publish = useAppStore.getState().publishReview(rid, 'U-2001');
    expect(publish.ok).toBe(false);
    expect(publish.message).toContain('已批准');

    // 已发布审查被并发撤回时，再次发布前复核阻断
    const review2 = useAppStore.getState().createReview({ evalId: r.evalId!, title: '并发撤回审查', by: 'U-1001' });
    const rid2 = review2.reviewId!;
    useAppStore.getState().approveReview(rid2, 'U-2001');
    useAppStore.getState().publishReview(rid2, 'U-2001');
    // 发布后并发撤回 => validForNewAnalysis=false
    useAppStore.getState().revokeReview(rid2, 'U-2001', '并发撤回');
    const again = useAppStore.getState().publishReview(rid2, 'U-2001');
    expect(again.ok).toBe(false);
  });

  it('基于旧模型修订生成的审查，在该修订升级后批准被阻断', async () => {
    const r = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    await waitForEval(r.evalId!);
    const review = useAppStore.getState().createReview({ evalId: r.evalId!, title: '旧修订审查', by: 'U-1001' });
    const rid = review.reviewId!;
    // 模型升级到 v2 后再批准：旧引用应被阻断
    useAppStore.getState().addModelRevision({
      registryId: 'MDL-LAST-TOUCH', revision: 'v2', baseModel: 'last_touch', decayHalfLifeDays: 7, ruleText: '新规则', allowedUses: ['version_compare', 'drift_monitor', 'review_basis'], note: '升级', by: 'U-1001',
    });
    const approve = useAppStore.getState().approveReview(rid, 'U-2001');
    expect(approve.ok).toBe(false);
    expect(approve.message).toContain('阻断');
    const after = useAppStore.getState().reviews.find((x) => x.reviewId === rid)!;
    expect(after.status).toBe('draft');
    expect(after.audit.some((a) => a.action === 'approve_blocked')).toBe(true);
  });

  it('样本量不足或渠道未覆盖时评估显示不支持结论，不填零分', async () => {
    const edge = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, sampleId: 'SMP-EDGE-UNKNOWN', minClusters: 3 },
      purpose: 'version_compare',
      minClusters: 3,
      by: 'U-1001',
    });
    expect(edge.ok).toBe(true);
    await waitForEval(edge.evalId!);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === edge.evalId!)!;
    const result = ev.result!;
    expect(result.modelA.unknownAmount).toBe(result.modelA.totalNet);
    for (const c of result.modelA.channelShares) {
      expect(c.support).not.toBe('supported');
    }
  });

  it('未登记允许用途的模型发起版本比较：渠道指标不支持结论', async () => {
    const r = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, modelB: { registryId: 'MDL-BRAND-CAUTIOUS', revision: 'v1' } },
      purpose: 'version_compare',
      minClusters: 4,
      by: 'U-1001',
    });
    expect(r.ok).toBe(true);
    await waitForEval(r.evalId!);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === r.evalId!)!;
    expect(ev.result!.modelB.channelShares.every((c) => c.support === 'model_not_allowed')).toBe(true);
  });

  it('退款补充改变输入但样本修订未升级时，批准被阻断（重建哈希复核）', async () => {
    const r = useAppStore.getState().startEvaluationRun({ config: matureConfig, purpose: 'version_compare', minClusters: 4, by: 'U-1001' });
    await waitForEval(r.evalId!);
    const review = useAppStore.getState().createReview({ evalId: r.evalId!, title: '输入漂移审查', by: 'U-1001' });
    const rid = review.reviewId!;
    // 直接对原样本补充退款（不刷新修订），使样本哈希漂移
    useAppStore.getState().loadBuiltinSupplement('refund', 'U-1001');
    useAppStore.setState((s) => ({
      sampleDefinitions: s.sampleDefinitions.map((d) =>
        d.sampleId === 'SMP-MATURE-2026-11' ? { ...d, supplementIds: ['SUP-REFUND-1010'] } : d,
      ),
    }));
    const approve = useAppStore.getState().approveReview(rid, 'U-2001');
    expect(approve.ok).toBe(false);
    expect(approve.message).toContain('阻断');
    const after = useAppStore.getState().reviews.find((x) => x.reviewId === rid)!;
    expect(after.audit.some((a) => a.action === 'approve_blocked')).toBe(true);
  });

  it('同模型换样本：指定对照样本后生成 sample_swap 对照且模型一致', async () => {
    // 需要一个与成熟样本不同的成熟样本：用退款补齐派生样本之前的原始样本 + 观察期口径派生样本无法直接对比，
    // 因此这里先刷新样本生成 R2，再以 R2 为基准、原始样本为对照样本，隔离「样本输入」因素。
    useAppStore.getState().loadBuiltinSupplement('refund', 'U-1001');
    const refresh = useAppStore.getState().refreshSampleRefunds('SMP-MATURE-2026-11', 'U-1001');
    const newSampleId = `SMP-MATURE-2026-11-R${refresh.newRevision}`;
    const r = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, sampleId: newSampleId },
      purpose: 'version_compare',
      minClusters: 4,
      by: 'U-1001',
      sampleBId: 'SMP-MATURE-2026-11',
    });
    expect(r.ok).toBe(true);
    await waitForEval(r.evalId!);
    const ev = useAppStore.getState().evaluations.find((e) => e.evalId === r.evalId!)!;
    const sampleSwap = ev.comparisons.find((c) => c.kind === 'sample_swap');
    expect(sampleSwap).toBeTruthy();
    // 两侧模型相同（隔离样本因素）
    expect(sampleSwap!.base.modelLabel).toBe(sampleSwap!.alt.modelLabel);
    expect(sampleSwap!.isolatedFactor).toBe('sample');
  });

  it('近期窗口样本不能生成审查依据', async () => {
    const r = useAppStore.getState().startEvaluationRun({
      config: { ...matureConfig, sampleId: 'SMP-RECENT-2026-11' }, purpose: 'drift_monitor', minClusters: 3, by: 'U-1001',
    });
    await waitForEval(r.evalId!);
    const review = useAppStore.getState().createReview({ evalId: r.evalId!, title: '漂移审查', by: 'U-1001' });
    expect(review.ok).toBe(false);
  });
});
