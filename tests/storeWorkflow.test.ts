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
import { verifyInvariants } from '@/engine/attribution';
import { RULE_REVISION_V1, RULE_REVISION_V2 } from '@/data/sampleData';
import type { RunConfig } from '@/types/domain';

const config: RunConfig = {
  timezone: 'Asia/Shanghai',
  dealDefinition: 'net_of_refund_at_lock',
  windowDays: 7,
  model: 'linear',
  ruleRevision: RULE_REVISION_V1,
  decayHalfLifeDays: 7,
};

describe('归因运行全生命周期工作流', () => {
  beforeEach(() => {
    useAppStore.getState().resetDemo();
  });

  it('草稿→执行→审批核对→锁定→分享，结果守恒且只有锁定运行可分享', async () => {
    const s = useAppStore.getState();
    const runId = s.createDraftRun({ snapshotId: 'DS-2026-11-01', config });
    expect(useAppStore.getState().runs[0].status).toBe('draft');

    await useAppStore.getState().executeRun(runId);
    let run = useAppStore.getState().runs.find((r) => r.runId === runId)!;
    expect(run.status).toBe('completed');
    expect(verifyInvariants(run.results!).ok).toBe(true);

    // 未锁定不能分享
    const blocked = useAppStore.getState().createSharedReport(runId, '提前分享', 'U-2001');
    expect(blocked.ok).toBe(false);

    const approval = useAppStore.getState().approveRun(runId, 'U-2001');
    expect(approval.ok).toBe(true);
    const lock = useAppStore.getState().lockRun(runId);
    expect(lock.ok).toBe(true);
    run = useAppStore.getState().runs.find((r) => r.runId === runId)!;
    expect(run.status).toBe('locked');

    const shared = useAppStore.getState().createSharedReport(runId, '双月渠道贡献', 'U-2001');
    expect(shared.ok).toBe(true);
    expect(shared.shareId).toBeTruthy();
  });

  it('规则修订与快照不一致时审批驳回，且不能锁定', async () => {
    const s = useAppStore.getState();
    const runId = s.createDraftRun({ snapshotId: 'DS-2026-11-01', config });
    // 人为把草稿修订改成新版本，模拟来源修订漂移
    useAppStore.getState().updateDraftConfig(runId, { ruleRevision: RULE_REVISION_V2 });
    await useAppStore.getState().executeRun(runId);

    const approval = useAppStore.getState().approveRun(runId, 'U-2001');
    expect(approval.ok).toBe(false);
    const run = useAppStore.getState().runs.find((r) => r.runId === runId)!;
    expect(run.approval?.revisionMatched).toBe(false);
    expect(useAppStore.getState().lockRun(runId).ok).toBe(false);
  });

  it('锁定后迟到退款只生成新运行并列出变化订单，旧分享冻结数字不变', async () => {
    const s = useAppStore.getState();
    const parentId = s.createDraftRun({ snapshotId: 'DS-2026-11-01', config });
    await useAppStore.getState().executeRun(parentId);
    useAppStore.getState().approveRun(parentId, 'U-2001');
    useAppStore.getState().lockRun(parentId);
    const share = useAppStore.getState().createSharedReport(parentId, '冻结报告', 'U-2001');

    const oldO2002 = useAppStore.getState()
      .sharedReports.find((r) => r.shareId === share.shareId)!
      .frozen.orderAttributions.find((o) => o.orderId === 'O-2002')!;
    expect(oldO2002.netAmount).toBe(89900);

    const childId = useAppStore.getState().createSupersedingRun(parentId, 'DS-2026-11-05');
    expect(childId).toBeTruthy();
    const child = useAppStore.getState().runs.find((r) => r.runId === childId)!;
    expect(child.parentRunId).toBe(parentId);
    expect(child.changeSummary?.changedOrders).toContain('O-2002');
    expect(child.changeSummary?.refundedAfterLock).toContain('O-2002');
    expect(child.config.ruleRevision).toBe(RULE_REVISION_V2);

    // 父运行保持 locked，旧分享数字不被新退款改写
    const parent = useAppStore.getState().runs.find((r) => r.runId === parentId)!;
    expect(parent.status).toBe('locked');
    const stillFrozen = useAppStore.getState()
      .sharedReports.find((r) => r.shareId === share.shareId)!
      .frozen.orderAttributions.find((o) => o.orderId === 'O-2002')!;
    expect(stillFrozen.netAmount).toBe(89900);
  });

  it('预算可见性：草稿与计算中运行不可作为预算来源，已完成/已锁定才可读', async () => {
    const s = useAppStore.getState();
    const draftId = s.createDraftRun({ snapshotId: 'DS-2026-11-01', config });
    const readableBefore = useAppStore.getState().runs.filter(
      (r) => (r.status === 'completed' || r.status === 'locked') && r.results,
    );
    expect(readableBefore).toHaveLength(0);
    expect(draftId).toBeTruthy();

    const runId = s.createDraftRun({ snapshotId: 'DS-2026-11-01', config });
    await useAppStore.getState().executeRun(runId);
    const readableAfter = useAppStore.getState().runs.filter(
      (r) => (r.status === 'completed' || r.status === 'locked') && r.results,
    );
    expect(readableAfter.map((r) => r.runId)).toContain(runId);
  });
});
