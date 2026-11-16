import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { runAttribution } from '@/services/api';
import { buildComparisons, startEvaluation } from '@/services/evaluationService';
import { buildSample, mergeInputs } from '@/engine/sample';
import { checkRefCurrent, resolveModelRef, revisionHash } from '@/engine/registry';
import {
  SAMPLE_AS_OF,
  seedModelRegistry,
  seedSampleDefinitions,
  snapshots as seedSnapshots,
  lateRefundSupplement,
  regionalOrderSupplement,
} from '@/data/sampleData';
import type {
  AttributionRun,
  BudgetPlan,
  DataSnapshot,
  RunConfig,
  SharedReport,
} from '@/types/domain';
import type {
  AllowedUse,
  EvaluationConfig,
  EvaluationRun,
  EvaluationStatus,
  FrozenEvaluation,
  ModelRegistryEntry,
  ReviewAuditEntry,
  ReviewRecord,
  SupplementBatch,
} from '@/types/evaluation';

/** 轻量配置校验和：审批/分享时核对来源修订与运行参数 */
export function configChecksum(config: RunConfig): string {
  const raw = JSON.stringify(config);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return `chk:${(hash >>> 0).toString(16)}`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 对比两个快照，生成迟到退款/净额变化清单。迟到判定只看输入血缘，不依赖墙上时钟。 */
export function diffSnapshots(oldSnap: DataSnapshot, newSnap: DataSnapshot) {
  const oldMap = new Map(oldSnap.orderVersions.map((v) => [v.orderId, v]));
  const newOrders: string[] = [];
  const changedOrders: string[] = [];
  const refundedAfterLock: string[] = [];

  for (const nv of newSnap.orderVersions) {
    const ov = oldMap.get(nv.orderId);
    if (!ov) {
      newOrders.push(nv.orderId);
    } else if (ov.netAmount !== nv.netAmount || ov.status !== nv.status) {
      changedOrders.push(nv.orderId);
    }
  }
  // 新快照中存在、但锁定运行所消费的旧快照中不存在的退款，
  // 即运行输入冻结之后才到达的迟到退款（运行锁定后不回改旧图表）。
  for (const r of newSnap.refunds) {
    if (!oldSnap.refunds.some((x) => x.refundId === r.refundId)) {
      refundedAfterLock.push(r.orderId);
    }
  }
  return { newOrders, changedOrders, refundedAfterLock: [...new Set(refundedAfterLock)] };
}

interface AppState {
  currentUserId: string;
  snapshots: DataSnapshot[];
  runs: AttributionRun[];
  sharedReports: SharedReport[];
  budgetPlans: BudgetPlan[];

  // ---- 模型评估与适用范围 ----
  modelRegistry: ModelRegistryEntry[];
  supplements: SupplementBatch[];
  sampleDefinitions: SampleDefinition[];
  evaluations: EvaluationRun[];
  reviews: ReviewRecord[];
  /** 评估运行状态的瞬时进度（不持久化） */
  evalProgress: Record<string, number>;

  switchUser: (userId: string) => void;
  createDraftRun: (input: { snapshotId: string; config: RunConfig }) => string;
  updateDraftConfig: (runId: string, patch: Partial<RunConfig>) => void;
  executeRun: (runId: string) => Promise<void>;
  approveRun: (runId: string, approverId: string) => { ok: boolean; message: string };
  lockRun: (runId: string) => { ok: boolean; message: string };
  createSupersedingRun: (parentRunId: string, newSnapshotId: string) => string | null;
  createSharedReport: (runId: string, title: string, createdBy: string) => { ok: boolean; shareId?: string; message: string };
  revokeSharedReport: (shareId: string) => void;
  saveBudgetPlan: (plan: BudgetPlan) => void;
  resetDemo: () => void;

  // 模型登记
  addModelRevision: (input: {
    registryId: string;
    revision: string;
    baseModel: ModelRegistryEntry['revisions'][number]['baseModel'];
    decayHalfLifeDays: number;
    ruleText: string;
    allowedUses: AllowedUse[];
    note: string;
    by: string;
  }) => { ok: boolean; message: string };
  retireModel: (registryId: string) => { ok: boolean; message: string };

  // 补充导入
  importSupplement: (batch: SupplementBatch) => { ok: boolean; message: string };
  loadBuiltinSupplement: (kind: 'refund' | 'order', by: string) => { ok: boolean; message: string };
  validateSupplement: (batch: SupplementBatch) => { ok: boolean; issues: string[] };

  // 样本
  createSampleDefinition: (def: Omit<SampleDefinition, 'sampleId' | 'createdAt' | 'createdBy' | 'revision'>) => string;
  refreshSampleRefunds: (sampleId: string, by: string) => { ok: boolean; message: string; newRevision?: number };
  previewSample: (def: SampleDefinition) => ReturnType<typeof buildSample> | null;
  buildSampleFor: (def: SampleDefinition) => ReturnType<typeof buildSample> | null;

  // 评估运行
  startEvaluationRun: (input: {
    config: EvaluationConfig;
    purpose: AllowedUse;
    minClusters: number;
    by: string;
    sampleBId?: string;
    basis?: string;
  }) => { ok: boolean; evalId?: string; message: string };
  cancelEvaluation: (evalId: string) => void;
  removeEvaluation: (evalId: string) => void;

  // 审查 / 发布 / 撤回
  createReview: (input: { evalId: string; title: string; by: string }) => { ok: boolean; reviewId?: string; message: string };
  approveReview: (reviewId: string, by: string) => { ok: boolean; message: string };
  publishReview: (reviewId: string, by: string) => { ok: boolean; message: string };
  revokeReview: (reviewId: string, by: string, reason: string) => { ok: boolean; message: string };
}

function audit(at: string, by: string, action: ReviewAuditEntry['action'], detail: string): ReviewAuditEntry {
  return { at, by, action, detail };
}

/** 运行中的评估任务句柄（不持久化；页面刷新后旧任务自然中断） */
const evalHandles = new Map<string, { cancel: () => void }>();

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentUserId: 'U-1001',
      snapshots: seedSnapshots,
      runs: [],
      sharedReports: [],
      budgetPlans: [],
      modelRegistry: seedModelRegistry,
      supplements: [],
      sampleDefinitions: seedSampleDefinitions,
      evaluations: [],
      reviews: [],
      evalProgress: {},

      switchUser: (userId) => set({ currentUserId: userId }),

      createDraftRun: ({ snapshotId, config }) => {
        const runId = uid('RUN');
        const analyst = get().currentUserId;
        const snapshot = get().snapshots.find((s) => s.snapshotId === snapshotId);
        const run: AttributionRun = {
          runId,
          snapshotId,
          dataVersion: snapshot?.dataVersion ?? 'unknown',
          analyst,
          createdAt: new Date().toISOString(),
          status: 'draft',
          // 草稿绑定创建时快照的规则修订；后续快照升级不会静默改写草稿
          config: { ...config, ruleRevision: snapshot?.ruleRevision ?? config.ruleRevision },
        };
        set((s) => ({ runs: [...s.runs, run] }));
        return runId;
      },

      updateDraftConfig: (runId, patch) =>
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === runId && r.status === 'draft' ? { ...r, config: { ...r.config, ...patch } } : r,
          ),
        })),

      executeRun: async (runId) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run || (run.status !== 'draft' && run.status !== 'superseded')) return;
        set((s) => ({
          runs: s.runs.map((r) => (r.runId === runId ? { ...r, status: 'running' } : r)),
        }));
        try {
          const results = await runAttribution(run.snapshotId, run.config);
          set((s) => ({
            runs: s.runs.map((r) =>
              r.runId === runId && r.status === 'running'
                ? { ...r, results, status: 'completed' }
                : r,
            ),
          }));
        } catch {
          // 计算失败回退为草稿，允许修正参数重试
          set((s) => ({
            runs: s.runs.map((r) => (r.runId === runId ? { ...r, status: 'draft' } : r)),
          }));
        }
      },

      approveRun: (runId, approverId) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run) return { ok: false, message: '运行不存在' };
        if (run.status !== 'completed') return { ok: false, message: '只有已完成运行可提交审批' };
        const snapshot = get().snapshots.find((s) => s.snapshotId === run.snapshotId);
        const revisionMatched = snapshot?.ruleRevision === run.config.ruleRevision;
        const checksum = configChecksum(run.config);
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === runId
              ? {
                  ...r,
                  approval: {
                    approvedBy: approverId,
                    approvedAt: new Date().toISOString(),
                    sourceRevision: snapshot?.ruleRevision ?? 'unknown',
                    ruleRevision: run.config.ruleRevision,
                    configChecksum: checksum,
                    revisionMatched,
                  },
                }
              : r,
          ),
        }));
        return revisionMatched
          ? { ok: true, message: '审批通过：来源规则修订与运行配置一致' }
          : { ok: false, message: '审批驳回：运行绑定的规则修订与当前快照不一致，请基于新快照重建运行' };
      },

      lockRun: (runId) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run) return { ok: false, message: '运行不存在' };
        if (run.status !== 'completed') return { ok: false, message: '只有已完成运行可锁定' };
        if (!run.approval) return { ok: false, message: '缺少审批记录，不能锁定' };
        if (!run.approval.revisionMatched) return { ok: false, message: '审批修订核对未通过，不能锁定' };
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === runId ? { ...r, status: 'locked', lockedAt: new Date().toISOString() } : r,
          ),
        }));
        return { ok: true, message: '运行已锁定，结果与分享快照不可变' };
      },

      createSupersedingRun: (parentRunId, newSnapshotId) => {
        const parent = get().runs.find((r) => r.runId === parentRunId);
        if (!parent || !parent.lockedAt) return null;
        const oldSnap = get().snapshots.find((s) => s.snapshotId === parent.snapshotId);
        const newSnap = get().snapshots.find((s) => s.snapshotId === newSnapshotId);
        if (!oldSnap || !newSnap) return null;
        const runId = uid('RUN');
        const run: AttributionRun = {
          runId,
          snapshotId: newSnapshotId,
          dataVersion: newSnap.dataVersion,
          analyst: get().currentUserId,
          createdAt: new Date().toISOString(),
          status: 'draft',
          config: { ...parent.config, ruleRevision: newSnap.ruleRevision },
          parentRunId,
          changeSummary: diffSnapshots(oldSnap, newSnap),
        };
        set((s) => ({ runs: [...s.runs, run] }));
        return runId;
      },

      createSharedReport: (runId, title, createdBy) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run || !run.results) return { ok: false, message: '运行不存在或尚无结果' };
        if (run.status !== 'locked') return { ok: false, message: '只有已锁定运行才能生成共享报告' };
        const shareId = uid('SHARE');
        const report: SharedReport = {
          shareId,
          runId,
          snapshotId: run.snapshotId,
          title,
          createdBy,
          createdAt: new Date().toISOString(),
          status: 'active',
          // 冻结载荷：复制运行结果，后续新运行/新退款不会影响旧分享
          frozen: {
            dataVersion: run.dataVersion,
            ruleRevision: run.config.ruleRevision,
            config: structuredClone(run.config),
            channelSummaries: structuredClone(run.results.channelSummaries),
            orderAttributions: structuredClone(run.results.orderAttributions),
            unknownRevenue: run.results.unknownRevenue,
            totalNetRevenue: run.results.totalNetRevenue,
            totalAllocated: run.results.totalAllocated,
          },
        };
        set((s) => ({ sharedReports: [...s.sharedReports, report] }));
        return { ok: true, shareId, message: '共享报告已生成并冻结' };
      },

      revokeSharedReport: (shareId) =>
        set((s) => ({
          sharedReports: s.sharedReports.map((r) => (r.shareId === shareId ? { ...r, status: 'revoked' } : r)),
        })),

      saveBudgetPlan: (plan) =>
        set((s) => {
          const exists = s.budgetPlans.some((p) => p.planId === plan.planId);
          return {
            budgetPlans: exists
              ? s.budgetPlans.map((p) => (p.planId === plan.planId ? plan : p))
              : [...s.budgetPlans, plan],
          };
        }),

      resetDemo: () =>
        set({
          runs: [],
          sharedReports: [],
          budgetPlans: [],
          currentUserId: 'U-1001',
          modelRegistry: seedModelRegistry,
          supplements: [],
          sampleDefinitions: seedSampleDefinitions,
          evaluations: [],
          reviews: [],
          evalProgress: {},
        }),

      // ---------------- 模型登记 ----------------

      addModelRevision: (input) => {
        const entry = get().modelRegistry.find((m) => m.registryId === input.registryId);
        if (!entry) return { ok: false, message: '模型登记不存在' };
        if (entry.revisions.some((r) => r.revision === input.revision)) {
          return { ok: false, message: `修订 ${input.revision} 已存在，修订号不可复用` };
        }
        if (input.allowedUses.length === 0) return { ok: false, message: '至少登记一个允许用途' };
        if (input.baseModel === 'time_decay' && input.decayHalfLifeDays <= 0) {
          return { ok: false, message: '时间衰减模型必须登记正数半衰期' };
        }
        const record = {
          revision: input.revision,
          baseModel: input.baseModel,
          decayHalfLifeDays: input.decayHalfLifeDays,
          ruleText: input.ruleText,
          allowedUses: input.allowedUses,
          createdAt: new Date().toISOString(),
          createdBy: input.by,
          note: input.note,
        };
        const prevRevision = entry.currentRevision;
        const now = new Date().toISOString();
        set((s) => ({
          modelRegistry: s.modelRegistry.map((m) =>
            m.registryId === input.registryId
              ? { ...m, currentRevision: input.revision, revisions: [...m.revisions, record] }
              : m,
          ),
          // 引用旧修订的已批准/已发布审查：标记失效（仍可回看，但不得作为新分析有效性证明）
          reviews: s.reviews.map((r) => {
            if (r.status !== 'approved' && r.status !== 'published') return r;
            if (!r.modelRefs.some((ref) => ref.registryId === input.registryId && ref.revision === prevRevision)) return r;
            return {
              ...r,
              validForNewAnalysis: false,
              invalidationReason: `模型 ${entry.name} 已从修订 ${prevRevision} 升级到 ${input.revision}，旧审查不再作为新分析的有效性证明`,
              audit: [...r.audit, audit(now, input.by, 'revalidated', `模型修订升级 ${prevRevision}→${input.revision}，引用失效`)],
            };
          }),
        }));
        return {
          ok: true,
          message: `已登记修订 ${input.revision}（哈希 ${revisionHash(record)}）；引用旧修订的审查已标记失效，需复核`,
        };
      },

      retireModel: (registryId) => {
        const entry = get().modelRegistry.find((m) => m.registryId === registryId);
        if (!entry) return { ok: false, message: '模型登记不存在' };
        if (entry.status === 'retired') return { ok: false, message: '模型已停用' };
        set((s) => ({
          modelRegistry: s.modelRegistry.map((m) =>
            m.registryId === registryId ? { ...m, status: 'retired' } : m,
          ),
        }));
        return { ok: true, message: '模型已停用；既有审查保留引用，但新评估不可再选择' };
      },

      // ---------------- 补充导入 ----------------

      validateSupplement: (batch) => {
        const issues: string[] = [];
        for (const o of batch.orders) {
          if (!o.orderId) issues.push('订单缺少 orderId');
          if (!Number.isFinite(o.grossAmount) || o.grossAmount < 0) issues.push(`订单 ${o.orderId} 毛额非法`);
          if (Number.isNaN(new Date(o.orderTime).getTime())) issues.push(`订单 ${o.orderId} 下单时间无法解析`);
          if (!o.personId) issues.push(`订单 ${o.orderId} 无人员标识，将进入未知来源`);
        }
        for (const t of batch.touchpoints) {
          if (!t.orderId) issues.push(`触点 ${t.touchpointId} 缺少订单关联`);
          if (!t.channelId) issues.push(`触点 ${t.touchpointId} 缺少渠道`);
          if (!t.identityAuthorized) issues.push(`触点 ${t.touchpointId} 标识未授权，不参与分配`);
        }
        for (const r of batch.refunds) {
          if (!r.orderId) issues.push(`退款 ${r.refundId} 缺少订单关联`);
          if (!Number.isFinite(r.amount) || r.amount <= 0) issues.push(`退款 ${r.refundId} 金额非法`);
        }
        const orderIds = new Set(batch.orders.map((o) => o.orderId));
        for (const t of batch.touchpoints) {
          if (!orderIds.has(t.orderId) && t.orderId) {
            // 允许补充已有订单的触点，不做硬阻断，只提示
            issues.push(`触点 ${t.touchpointId} 关联的订单 ${t.orderId} 不在本批次订单中（可能是补充已有订单）`);
          }
        }
        return { ok: issues.length === 0, issues };
      },

      importSupplement: (batch) => {
        if (get().supplements.some((s) => s.batchId === batch.batchId)) {
          return { ok: false, message: `批次 ${batch.batchId} 已导入，不重复导入` };
        }
        const validation = get().validateSupplement(batch);
        const record: SupplementBatch = { ...batch, validation };
        set((s) => ({ supplements: [...s.supplements, record] }));
        return {
          ok: true,
          message: `已导入补充批次 ${batch.batchId}${validation.issues.length ? `（${validation.issues.length} 条提示，详见预览）` : ''}；刷新样本后进入评估`,
        };
      },

      loadBuiltinSupplement: (kind, by) => {
        const batch = kind === 'refund' ? lateRefundSupplement(by) : regionalOrderSupplement(by);
        return get().importSupplement(batch);
      },

      // ---------------- 样本 ----------------

      createSampleDefinition: (def) => {
        const sampleId = uid('SMP');
        const record: SampleDefinition = {
          ...def,
          sampleId,
          revision: 1,
          createdAt: new Date().toISOString(),
          createdBy: get().currentUserId,
        };
        set((s) => ({ sampleDefinitions: [...s.sampleDefinitions, record] }));
        return sampleId;
      },

      refreshSampleRefunds: (sampleId, by) => {
        const def = get().sampleDefinitions.find((d) => d.sampleId === sampleId);
        if (!def) return { ok: false, message: '样本不存在' };
        const newDef: SampleDefinition = {
          ...def,
          revision: def.revision + 1,
          createdAt: new Date().toISOString(),
          supersedes: def.sampleId,
          supplementIds: [...new Set([...def.supplementIds, ...get().supplements.map((s) => s.batchId)])],
        };
        // 样本修订生成新样本 id 以固定旧审查引用；同时保留可读的派生关系
        const newSampleId = `${def.sampleId}-R${newDef.revision}`;
        const created: SampleDefinition = { ...newDef, sampleId: newSampleId, createdBy: by };
        set((s) => ({ sampleDefinitions: [...s.sampleDefinitions, created] }));
        return {
          ok: true,
          message: `退款补齐后生成新样本修订 ${created.sampleId}（rev ${created.revision}）；原样本与既有审查保留原结果`,
          newRevision: created.revision,
        };
      },

      previewSample: (def) => get().buildSampleFor(def),

      buildSampleFor: (def) => {
        const snapshot = get().snapshots.find((s) => s.snapshotId === def.baseSnapshotId);
        if (!snapshot) return null;
        const supplements = get().supplements.filter((s) => def.supplementIds.includes(s.batchId));
        const inputs = mergeInputs(snapshot, supplements);
        return buildSample({ definition: def, inputs, identityLinks: snapshot.identityLinks, now: SAMPLE_AS_OF });
      },

      // ---------------- 评估运行 ----------------

      startEvaluationRun: ({ config, purpose, minClusters, by, sampleBId, basis }) => {
        const evalId = uid('EVAL');
        const defA = get().sampleDefinitions.find((d) => d.sampleId === config.sampleId);
        if (!defA) return { ok: false, message: '样本不存在' };
        if (defA.window === 'recent' && purpose === 'version_compare') {
          return { ok: false, message: '近期窗口仅用于漂移监测，不能作为版本比较样本（两个窗口不混排）' };
        }
        const entryA = get().modelRegistry.find((m) => m.registryId === config.modelA.registryId);
        const entryB = get().modelRegistry.find((m) => m.registryId === config.modelB.registryId);
        if (!entryA || !entryB) return { ok: false, message: '模型登记不存在' };
        if (entryA.status === 'retired' || entryB.status === 'retired') {
          return { ok: false, message: '已停用模型不能发起新评估' };
        }
        const ra = resolveModelRef(entryA, config.modelA.revision);
        const rb = resolveModelRef(entryB, config.modelB.revision);
        if (!ra.ok) return { ok: false, message: (ra as { error: string }).error };
        if (!rb.ok) return { ok: false, message: (rb as { error: string }).error };

        const buildA = get().buildSampleFor(defA);
        if (!buildA) return { ok: false, message: '样本构建失败（快照缺失）' };

        const run: EvaluationRun = {
          evalId,
          config,
          sampleId: defA.sampleId,
          sampleHash: buildA.sampleHash,
          sampleRevision: buildA.revision,
          modelARef: ra.ref,
          modelBRef: rb.ref,
          status: 'running',
          progress: 0,
          createdAt: new Date().toISOString(),
          createdBy: by,
          comparisons: [],
          staleDiscards: 0,
          ...(basis ? { basis } : {}),
        };
        for (const [id, h] of evalHandles) {
          if (id !== evalId) {
            h.cancel();
            evalHandles.delete(id);
          }
        }
        set((s) => ({
          // 切换样本后旧任务不得覆盖新结果：先把仍在运行的旧评估标记为被取代
          // （其结果回调因 status !== 'running' 会被丢弃），再插入新评估
          evaluations: [
            run,
            ...s.evaluations.map((e) =>
              e.status === 'running'
                ? { ...e, status: 'cancelled' as EvaluationStatus, cancelledAt: run.createdAt, cancelReason: `已被新评估 ${evalId}（样本 ${defA.sampleId}）取代，旧结果丢弃`, staleDiscards: e.staleDiscards + 1 }
                : e,
            ),
          ],
          evalProgress: { ...s.evalProgress, [evalId]: 0 },
        }));

        const supplements = get().supplements.filter((s) => defA.supplementIds.includes(s.batchId));
        const inputs = mergeInputs(
          get().snapshots.find((s) => s.snapshotId === defA.baseSnapshotId)!,
          supplements,
        );

        const handle = startEvaluation({
          evalId,
          build: buildA,
          inputs,
          config,
          modelA: ra.ref,
          modelB: rb.ref,
          purpose,
          onProgress: (p) => {
            set((s) =>
              s.evaluations.find((e) => e.evalId === evalId)?.status === 'running'
                ? {
                    evalProgress: { ...s.evalProgress, [evalId]: p },
                    evaluations: s.evaluations.map((e) => (e.evalId === evalId ? { ...e, progress: p } : e)),
                  }
                : {},
            );
          },
        });

        evalHandles.set(evalId, handle);
        void handle.done.then((result) => {
          evalHandles.delete(evalId);
          const current = get().evaluations.find((e) => e.evalId === evalId);
          // 取消后到达的结果一律丢弃
          if (!current || current.status !== 'running') return;
          if (!result) {
            set((s) => ({
              evaluations: s.evaluations.map((e) =>
                e.evalId === evalId ? { ...e, status: 'cancelled' as EvaluationStatus, cancelledAt: new Date().toISOString() } : e,
              ),
            }));
            return;
          }

          // ---- 版本对照：隔离单一因素 ----
          const comparisonRecords: EvaluationRun['comparisons'] = [];
          // 1) 同样本换模型：交换 A/B 在「同一份样本哈希」上重算
          const swapped = evaluateSampleSafe({
            def: defA,
            inputs,
            modelA: rb.ref,
            modelB: ra.ref,
            config,
            purpose,
            minClusters,
          });
          if (swapped && swapped.sampleHash === result.sampleHash) {
            comparisonRecords.push(
              ...buildComparisons({
                primary: result,
                sameSampleSwapped: swapped,
                segmentKeys: config.segmentKeys,
                focusChannelId: config.focusChannelId,
                minClusters,
              }),
            );
          }

          // 2) 只更新退款：沿样本派生链找上一修订，成员一致、仅退款/净额变化
          const lineagePrev = findPreviousRevision(get().sampleDefinitions, defA);
          let previousResult: EvaluationResult | null = null;
          if (lineagePrev) {
            const prevBuild = get().buildSampleFor(lineagePrev);
            if (prevBuild) {
              const supPrev = get().supplements.filter((s) => lineagePrev.supplementIds.includes(s.batchId));
              const inputsPrev = mergeInputs(get().snapshots.find((s) => s.snapshotId === lineagePrev.baseSnapshotId)!, supPrev);
              previousResult = evaluateSampleSafe({
                def: lineagePrev,
                inputs: inputsPrev,
                modelA: ra.ref,
                modelB: rb.ref,
                config: { ...config, sampleId: lineagePrev.sampleId },
                purpose,
                minClusters,
              });
            }
          }
          if (previousResult) {
            const sameMemberSet = sameOrderSet(previousResult.sample, result.sample);
            if (sameMemberSet) {
              comparisonRecords.push(
                ...buildComparisons({
                  primary: previousResult,
                  refundUpdated: result,
                  segmentKeys: config.segmentKeys,
                  focusChannelId: config.focusChannelId,
                  minClusters,
                }),
              );
            } else {
              comparisonRecords.push(
                ...buildComparisons({
                  primary: previousResult,
                  sameModelOtherSample: result,
                  segmentKeys: config.segmentKeys,
                  focusChannelId: config.focusChannelId,
                  minClusters,
                }),
              );
            }
          }

          // 3) 同模型换样本：可选对照样本（必须同为成熟窗口）
          const defB = sampleBId ? get().sampleDefinitions.find((d) => d.sampleId === sampleBId) : undefined;
          if (defB && defB.window === 'mature' && defB.sampleId !== defA.sampleId) {
            const buildB = get().buildSampleFor(defB);
            if (buildB) {
              const supB = get().supplements.filter((s) => defB.supplementIds.includes(s.batchId));
              const inputsB = mergeInputs(get().snapshots.find((s) => s.snapshotId === defB.baseSnapshotId)!, supB);
              const otherResult = evaluateSampleSafe({
                def: defB,
                inputs: inputsB,
                modelA: ra.ref,
                modelB: rb.ref,
                config: { ...config, sampleId: defB.sampleId },
                purpose,
                minClusters,
              });
              if (otherResult) {
                comparisonRecords.push(
                  ...buildComparisons({
                    primary: result,
                    sameModelOtherSample: otherResult,
                    segmentKeys: config.segmentKeys,
                    focusChannelId: config.focusChannelId,
                    minClusters,
                  }),
                );
              }
            }
          }

          set((s) => ({
            evaluations: s.evaluations.map((e) =>
              e.evalId === evalId
                ? {
                    ...e,
                    status: 'completed' as EvaluationStatus,
                    progress: 100,
                    completedAt: new Date().toISOString(),
                    result,
                    comparisons: comparisonRecords,
                    basis,
                    drift: defA.window === 'recent' ? buildDriftFor(s, defA, ra.ref, rb.ref, config, minClusters) : undefined,
                  }
                : e,
            ),
            evalProgress: { ...s.evalProgress, [evalId]: 100 },
          }));
        });

        return { ok: true, evalId, message: '评估已启动：可查看进度或取消' };
      },

      cancelEvaluation: (evalId) => {
        evalHandles.get(evalId)?.cancel();
        evalHandles.delete(evalId);
        set((s) => ({
          evaluations: s.evaluations.map((e) =>
            e.evalId === evalId && e.status === 'running'
              ? { ...e, status: 'cancelled' as EvaluationStatus, cancelledAt: new Date().toISOString() }
              : e,
          ),
        }));
      },

      removeEvaluation: (evalId) =>
        set((s) => ({
          evaluations: s.evaluations.filter((e) => e.evalId !== evalId),
        })),

      // ---------------- 审查 ----------------

      createReview: ({ evalId, title, by }) => {
        const evaluation = get().evaluations.find((e) => e.evalId === evalId);
        if (!evaluation || evaluation.status !== 'completed' || !evaluation.result) {
          return { ok: false, message: '只有已完成的评估可生成审查记录' };
        }
        const def = get().sampleDefinitions.find((d) => d.sampleId === evaluation.sampleId);
        if (def?.window === 'recent') {
          return { ok: false, message: '近期窗口样本只用于漂移监测，不能作为审查依据' };
        }
        const reviewId = uid('REV');
        const now = new Date().toISOString();
        const review: ReviewRecord = {
          reviewId,
          title,
          evalId,
          sampleId: evaluation.sampleId,
          sampleRevision: evaluation.sampleRevision,
          sampleHash: evaluation.sampleHash,
          modelRefs: [toReviewRef(evaluation.modelARef), toReviewRef(evaluation.modelBRef)],
          status: 'draft',
          createdAt: now,
          createdBy: by,
          validForNewAnalysis: true,
          audit: [audit(now, by, 'created', `引用评估 ${evalId}、样本 ${evaluation.sampleId}@rev${evaluation.sampleRevision}（${evaluation.sampleHash}）`)],
        };
        set((s) => ({ reviews: [review, ...s.reviews] }));
        return { ok: true, reviewId, message: '审查记录已创建（待审批），已固定模型与样本修订' };
      },

      approveReview: (reviewId, by) => {
        const review = get().reviews.find((r) => r.reviewId === reviewId);
        if (!review) return { ok: false, message: '审查不存在' };
        if (review.status !== 'draft') return { ok: false, message: '只有待审批审查可批准' };
        const now = new Date().toISOString();
        const checks = verifyReviewRefs(review, get());
        if (!checks.ok) {
          set((s) => ({
            reviews: s.reviews.map((r) =>
              r.reviewId === reviewId
                ? {
                    ...r,
                    audit: [...r.audit, audit(now, by, 'approve_blocked', checks.reason)],
                    invalidationReason: checks.reason,
                  }
                : r,
            ),
          }));
          return { ok: false, message: `批准被阻断：${checks.reason}` };
        }
        const evaluation = get().evaluations.find((e) => e.evalId === review.evalId);
        if (!evaluation?.result) return { ok: false, message: '引用的评估结果已不可用' };
        const frozen = freezeEvaluation(evaluation, now);
        set((s) => ({
          reviews: s.reviews.map((r) =>
            r.reviewId === reviewId
              ? {
                  ...r,
                  status: 'approved',
                  approvedAt: now,
                  approvedBy: by,
                  frozen,
                  audit: [...r.audit, audit(now, by, 'approved', '修订与样本哈希一致，已冻结评估结果')],
                }
              : r,
          ),
        }));
        return { ok: true, message: '审查已批准并冻结结果' };
      },

      publishReview: (reviewId, by) => {
        const review = get().reviews.find((r) => r.reviewId === reviewId);
        if (!review) return { ok: false, message: '审查不存在' };
        if (review.status !== 'approved') return { ok: false, message: '只有已批准审查可发布' };
        const now = new Date().toISOString();
        // 发布前复核：状态（并发撤回）、模型修订与样本哈希都会重新检查
        if (!review.validForNewAnalysis) {
          return { ok: false, message: `发布被阻断：审查已撤回（${review.invalidationReason ?? '并发撤回'}）` };
        }
        const checks = verifyReviewRefs(review, get());
        if (!checks.ok) {
          set((s) => ({
            reviews: s.reviews.map((r) =>
              r.reviewId === reviewId
                ? {
                    ...r,
                    publishBlockedReason: checks.reason,
                    audit: [...r.audit, audit(now, by, 'publish_blocked', checks.reason)],
                  }
                : r,
            ),
          }));
          return { ok: false, message: `发布被阻断：${checks.reason}` };
        }
        set((s) => ({
          reviews: s.reviews.map((r) =>
            r.reviewId === reviewId
              ? {
                  ...r,
                  status: 'published',
                  publishedAt: now,
                  publishBlockedReason: undefined,
                  audit: [...r.audit, audit(now, by, 'published', '发布前复核通过（模型修订与样本哈希一致）')],
                }
              : r,
          ),
        }));
        return { ok: true, message: '审查已发布；仅在登记用途内有效，不构成因果效果' };
      },

      revokeReview: (reviewId, by, reason) => {
        const review = get().reviews.find((r) => r.reviewId === reviewId);
        if (!review) return { ok: false, message: '审查不存在' };
        if (review.status === 'revoked') return { ok: false, message: '审查已撤回' };
        const now = new Date().toISOString();
        set((s) => ({
          reviews: s.reviews.map((r) =>
            r.reviewId === reviewId
              ? {
                  ...r,
                  status: 'revoked',
                  revokedAt: now,
                  revokedBy: by,
                  revokeReason: reason || '未填写原因',
                  validForNewAnalysis: false,
                  invalidationReason: '已撤回：旧报告仍可回看，但不得作为新分析的有效性证明',
                  audit: [...r.audit, audit(now, by, 'revoked', `撤回原因：${reason || '未填写'}；冻结结果保留可审计`)],
                }
              : r,
          ),
        }));
        return { ok: true, message: '审查已撤回；旧报告仍可回看，但不能作为新分析的有效性证明' };
      },
    }),
    {
      name: 'attribution-workbench-v1',
      version: 2,
      // 旧版本（无评估字段）迁移：补齐模型登记、样本定义与空评估/审查
      migrate: (persisted, version) => {
        const state = persisted as Partial<AppState>;
        if (version < 2) {
          return {
            ...state,
            modelRegistry: state.modelRegistry ?? seedModelRegistry,
            supplements: state.supplements ?? [],
            sampleDefinitions: state.sampleDefinitions ?? seedSampleDefinitions,
            evaluations: state.evaluations ?? [],
            reviews: state.reviews ?? [],
            evalProgress: {},
          } as AppState;
        }
        return state as AppState;
      },
      partialize: (s) => ({
        currentUserId: s.currentUserId,
        runs: s.runs,
        sharedReports: s.sharedReports,
        budgetPlans: s.budgetPlans,
        modelRegistry: s.modelRegistry,
        supplements: s.supplements,
        sampleDefinitions: s.sampleDefinitions,
        evaluations: s.evaluations,
        reviews: s.reviews,
      }),
    },
  ),
);

// ============================================================
// 评估 / 审查辅助（纯函数，导出便于单测）
// ============================================================

import { evaluate } from '@/engine/evaluation';
import { evaluationFingerprint } from '@/engine/evaluation';
import type { EvaluationResult, ResolvedModelRef, SampleDefinition } from '@/types/evaluation';

/** 在指定样本 + 模型上同步评估（供版本对照内部使用） */
function evaluateSampleSafe(args: {
  def: SampleDefinition;
  inputs: Parameters<typeof buildSample>[0]['inputs'];
  modelA: ResolvedModelRef;
  modelB: ResolvedModelRef;
  config: EvaluationConfig;
  purpose: AllowedUse;
  minClusters: number;
}): EvaluationResult | null {
  try {
    const build = buildSample({
      definition: args.def,
      inputs: args.inputs,
      identityLinks: args.inputs.sourceSnapshot.identityLinks,
      now: SAMPLE_AS_OF,
    });
    return evaluate(
      build,
      args.inputs,
      args.modelA,
      args.modelB,
      { ...args.config, minClusters: args.minClusters },
      args.purpose,
      new Date().toISOString(),
    );
  } catch {
    return null;
  }
}

function toReviewRef(ref: ResolvedModelRef) {
  return {
    registryId: ref.registryId,
    name: ref.name,
    revision: ref.revision,
    revisionHash: ref.revisionHash,
    baseModel: ref.baseModel,
    allowedUses: ref.allowedUses,
  };
}

/** 批准 / 发布前复核：模型修订仍为当前、哈希一致、样本修订与哈希一致 */
export function verifyReviewRefs(
  review: Pick<ReviewRecord, 'modelRefs' | 'sampleId' | 'sampleRevision' | 'sampleHash' | 'evalId'>,
  state: {
    modelRegistry: ModelRegistryEntry[];
    sampleDefinitions: SampleDefinition[];
    reviews?: ReviewRecord[];
    evaluations?: EvaluationRun[];
    snapshots?: DataSnapshot[];
    supplements?: SupplementBatch[];
  },
): { ok: boolean; reason: string } {
  for (const ref of review.modelRefs) {
    const entry = state.modelRegistry.find((m) => m.registryId === ref.registryId);
    const check = checkRefCurrent(entry, ref);
    if (!check.ok) return { ok: false, reason: check.reason };
    if (entry?.status === 'retired') return { ok: false, reason: `模型 ${entry.name} 已停用，引用失效` };
  }
  const def = state.sampleDefinitions.find((d) => d.sampleId === review.sampleId);
  if (!def) return { ok: false, reason: '引用的样本已不存在' };
  if (def.revision !== review.sampleRevision) {
    return { ok: false, reason: `样本已从修订 ${review.sampleRevision} 更新到 ${def.revision}，引用失效，需重新评估` };
  }
  // 样本哈希复核：真实重建样本，检查输入（订单 / 触点 / 退款）是否漂移。
  // 若退款补充等输入改变但样本修订未同步升级，这里会阻断，避免「旧审查被新输入静默复用」。
  if (state.snapshots && state.supplements) {
    const snapshot = state.snapshots.find((s) => s.snapshotId === def.baseSnapshotId);
    if (!snapshot) return { ok: false, reason: '样本绑定的快照已不存在' };
    const supplements = state.supplements.filter((s) => def.supplementIds.includes(s.batchId));
    const rebuilt = buildSample({
      definition: def,
      inputs: mergeInputs(snapshot, supplements),
      identityLinks: snapshot.identityLinks,
      now: SAMPLE_AS_OF,
    });
    if (rebuilt.sampleHash !== review.sampleHash) {
      return { ok: false, reason: '样本输入已变化（重建哈希不一致），引用失效，需基于新样本重新评估' };
    }
  }
  const evalRun = state.evaluations?.find((e) => e.evalId === review.evalId);
  if (evalRun && evalRun.sampleHash !== review.sampleHash) {
    return { ok: false, reason: '评估的样本哈希与审查记录不一致，引用失效' };
  }
  return { ok: true, reason: '模型修订与样本修订一致，样本哈希重建校验通过' };
}

/** 冻结评估结果（审查批准时复制，之后运行/退款不影响它） */
export function freezeEvaluation(evaluation: EvaluationRun, at: string): FrozenEvaluation {
  const r = evaluation.result!;
  return {
    evalId: evaluation.evalId,
    sampleId: r.sampleId,
    sampleLabel: r.sampleLabel,
    sampleRevision: r.sampleRevision,
    sampleHash: r.sampleHash,
    dataVersion: r.sample.dataVersion,
    modelARef: toReviewRef(r.modelA.model),
    modelBRef: toReviewRef(r.modelB.model),
    conservationA: r.modelA.conservation.ok,
    conservationB: r.modelB.conservation.ok,
    totalNet: r.modelA.totalNet,
    totalAttributedA: r.modelA.totalAttributed,
    totalAttributedB: r.modelB.totalAttributed,
    unknownAmountA: r.modelA.unknownAmount,
    channelSharesA: structuredClone(r.modelA.channelShares),
    channelSharesB: structuredClone(r.modelB.channelShares),
    stabilityPoints: r.stability.points,
    supportedPoints: r.stability.supportedPoints,
    unsupportedPoints: r.stability.points - r.stability.supportedPoints,
    segments: structuredClone(r.segments),
    comparisons: structuredClone(evaluation.comparisons),
    drift: evaluation.drift ? structuredClone(evaluation.drift) : undefined,
    frozenAt: at,
  };
}

/** 指纹（用于审查记录展示，确保模型/样本/关键指标可复核） */
export function reviewFingerprint(evaluation: EvaluationRun): string | null {
  return evaluation.result ? evaluationFingerprint(evaluation.result) : null;
}

/** 沿样本派生链找上一修订（样本修订或由它派生出的新样本） */
export function findPreviousRevision(defs: SampleDefinition[], def: SampleDefinition): SampleDefinition | undefined {
  const bySupersede = defs.find((d) => d.sampleId === def.supersedes);
  if (bySupersede) return bySupersede;
  const m = def.sampleId.match(/^(.*)-R(\d+)$/);
  if (m) {
    const baseId = m[1];
    const rev = Number(m[2]);
    if (rev > 1) {
      return defs.find((d) => d.sampleId === (rev - 1 === 1 ? baseId : `${baseId}-R${rev - 1}`));
    }
    return defs.find((d) => d.sampleId === baseId);
  }
  return undefined;
}

/** 两个样本是否包含完全相同的订单成员（用于判定「只更新退款」） */
export function sameOrderSet(a: { rows: { orderId: string }[] }, b: { rows: { orderId: string }[] }): boolean {
  if (a.rows.length !== b.rows.length) return false;
  const setA = new Set(a.rows.map((r) => r.orderId));
  return b.rows.every((r) => setA.has(r.orderId));
}

function buildDriftFor(
  state: { sampleDefinitions: SampleDefinition[]; evaluations: EvaluationRun[]; supplements: SupplementBatch[]; snapshots: DataSnapshot[] },
  recentDef: SampleDefinition,
  modelA: ResolvedModelRef,
  modelB: ResolvedModelRef,
  config: EvaluationConfig,
  minClusters: number,
): EvaluationRun['drift'] {
  const matureDef = state.sampleDefinitions
    .filter((d) => d.window === 'mature')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!matureDef) return undefined;
  const buildFor = (def: SampleDefinition) => {
    const snap = state.snapshots.find((s) => s.snapshotId === def.baseSnapshotId);
    if (!snap) return null;
    const sups = state.supplements.filter((s) => def.supplementIds.includes(s.batchId));
    const inputs = mergeInputs(snap, sups);
    return { build: buildSample({ definition: def, inputs, identityLinks: snap.identityLinks, now: SAMPLE_AS_OF }), inputs };
  };
  const rm = buildFor(matureDef);
  const rr = buildFor(recentDef);
  if (!rm || !rr) return undefined;
  const matureEval = evaluateSampleSafe({ def: matureDef, inputs: rm.inputs, modelA, modelB, config: { ...config, sampleId: matureDef.sampleId }, purpose: 'drift_monitor', minClusters });
  const recentEval = evaluateSampleSafe({ def: recentDef, inputs: rr.inputs, modelA, modelB, config: { ...config, sampleId: recentDef.sampleId }, purpose: 'drift_monitor', minClusters });
  if (!matureEval || !recentEval) return undefined;
  return driftReport(
    { build: matureEval.sample, eval: matureEval.modelA },
    { build: recentEval.sample, eval: recentEval.modelA },
    config.segmentKeys,
    config.focusChannelId,
  );
}

import { driftReport } from '@/engine/evaluation';
