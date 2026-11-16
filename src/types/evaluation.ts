import type { AttributionModel, Channel, DataSnapshot, Order, OrderStatus, RefundEvent, Touchpoint } from '@/types/domain';

// ============================================================
// 归因模型评估与适用范围 —— 领域模型
// 核心立场：没有可观测的真实渠道贡献标签。
// 本模块只回答「计算是否正确」「结果是否稳定」「差异来自模型还是输入」，
// 不输出准确率、因果效果，也不自动调整投放。
// ============================================================

/** 模型允许用途：版本比较 / 漂移监测 / 审查依据 */
export type AllowedUse = 'version_compare' | 'drift_monitor' | 'review_basis';

export const ALLOWED_USE_LABELS: Record<AllowedUse, string> = {
  version_compare: '版本比较',
  drift_monitor: '漂移监测',
  review_basis: '审查依据',
};

export interface ModelRevisionRecord {
  revision: string;
  baseModel: AttributionModel;
  decayHalfLifeDays: number;
  ruleText: string;
  allowedUses: AllowedUse[];
  createdAt: string;
  createdBy: string;
  note: string;
}

/** 模型登记：保存规则、允许用途与修订 */
export interface ModelRegistryEntry {
  registryId: string;
  name: string;
  currentRevision: string;
  status: 'active' | 'retired';
  revisions: ModelRevisionRecord[];
  createdAt: string;
  createdBy: string;
}

/** 解析后的确定模型引用（含修订哈希，用于审查与发布复核） */
export interface ResolvedModelRef {
  registryId: string;
  name: string;
  revision: string;
  revisionHash: string;
  baseModel: AttributionModel;
  decayHalfLifeDays: number;
  allowedUses: AllowedUse[];
}

// ---------------- 补充导入 ----------------

/** 用户导入的订单 / 触点 / 退款补充样例 */
export interface SupplementBatch {
  batchId: string;
  label: string;
  importedAt: string;
  importedBy: string;
  note: string;
  channels: Channel[];
  orders: Order[];
  touchpoints: Touchpoint[];
  refunds: RefundEvent[];
  validation: { ok: boolean; issues: string[] };
}

// ---------------- 评估样本 ----------------

/** 成熟共同样本（版本比较） vs 近期窗口（漂移监测）—— 两个窗口不混排 */
export type SampleWindow = 'mature' | 'recent';

export const SAMPLE_WINDOW_LABELS: Record<SampleWindow, string> = {
  mature: '成熟共同样本（版本比较）',
  recent: '近期窗口（漂移监测）',
};

/** 成熟条件 */
export type MaturityCondition =
  | 'refund_settled_before_cutoff'
  | 'observation_window_elapsed';

export const MATURITY_LABELS: Record<MaturityCondition, string> = {
  refund_settled_before_cutoff: '退款已入账且早于观察截止点',
  observation_window_elapsed: '订单观察期已满（未入账退款保留并标记）',
};

export type SegmentKey = 'region' | 'deviceSegment';

export const SEGMENT_LABELS: Record<SegmentKey, string> = {
  region: '区域',
  deviceSegment: '设备群',
};

export interface SampleDefinition {
  sampleId: string;
  label: string;
  window: SampleWindow;
  baseSnapshotId: string;
  dataVersion: string;
  supplementIds: string[];
  windowStart: string;
  windowEnd: string;
  /** 退款观察截止点 */
  refundCutoff: string;
  maturityCondition: MaturityCondition;
  observeDays: number;
  attributionWindowDays: number;
  timezone: string;
  segmentKeys: SegmentKey[];
  /** 样本修订：退款补齐 / 重新构建时递增，旧审查固定旧修订 */
  revision: number;
  supersedes?: string;
  createdAt: string;
  createdBy: string;
}

export interface ExclusionRecord {
  orderId: string;
  kind: 'window' | 'immature_refund' | 'zero_net' | 'cancelled' | 'missing_version' | 'invalid_order';
  reason: string;
  netAmount: number;
}

export interface SampleOrderRow {
  orderId: string;
  personId: string | null;
  deviceId: string;
  clusterId: string;
  clusterKind: 'customer' | 'order';
  clusterNote?: string;
  region: string;
  deviceSegment: string;
  orderTime: string;
  grossAmount: number;
  refundedAmount: number;
  netAmount: number;
  status: OrderStatus;
  overRefunded: boolean;
  eligibleTouchpointIds: string[];
  authorizedTouchpointCount: number;
  excludedTouchpointReasons: string[];
  channelIds: string[];
  unknownReason?: 'no_person' | 'no_touchpoint' | 'all_touchpoints_excluded';
  noAuthorizedTouchpoint: boolean;
  refundBatchIds: string[];
  refundIds: string[];
  pendingRefundIds: string[];
  mature: boolean;
  maturityNote?: string;
}

export interface SegmentWeight {
  value: string;
  orders: number;
  netAmount: number;
  weight: number;
}

export interface ChannelCoverage {
  channelId: string;
  name: string;
  orders: number;
  touchpoints: number;
  netAmount: number;
  covered: boolean;
}

export interface SampleBuild {
  sampleId: string;
  sampleLabel: string;
  window: SampleWindow;
  revision: number;
  dataVersion: string;
  rows: SampleOrderRow[];
  excludedOrders: ExclusionRecord[];
  segmentWeights: Record<SegmentKey, SegmentWeight[]>;
  channelCoverage: ChannelCoverage[];
  clusterCount: number;
  customerClusterCount: number;
  orderClusterCount: number;
  orderCount: number;
  totalNet: number;
  totalRefunded: number;
  overRefundOrderIds: string[];
  immatureOrderIds: string[];
  pendingRefundIds: string[];
  maturitySummary: { condition: MaturityCondition; cutoff: string; observeDays: number; matureOrders: number; immatureExcluded: number };
  sampleHash: string;
  builtAt: string;
  limitations: string[];
}

// ---------------- 单模型评估 ----------------

export type SupportState =
  | 'supported'
  | 'insufficient_sample'
  | 'channel_not_covered'
  | 'interval_undetermined'
  | 'model_not_allowed';

export const SUPPORT_LABELS: Record<SupportState, string> = {
  supported: '可下结论',
  insufficient_sample: '样本量不足',
  channel_not_covered: '渠道未覆盖',
  interval_undetermined: '区间无法确定',
  model_not_allowed: '模型不允许该用途',
};

export interface ChannelShare {
  channelId: string;
  name: string;
  amount: number;
  share: number;
  covered: boolean;
  support: SupportState;
  supportReason: string;
}

export interface UnknownBreakdown {
  totalAmount: number;
  orderIds: string[];
  byReason: Record<'no_person' | 'no_touchpoint' | 'all_touchpoints_excluded', { orders: string[]; amount: number }>;
}

export interface CoverageBreakdown {
  ordersWithEligible: number;
  orderCount: number;
  ratio: number;
  touchpointCount: number;
  avgTouchpointsPerOrder: number;
  channels: ChannelCoverage[];
}

export interface OrderAllocation {
  orderId: string;
  netAmount: number;
  allocations: { channelId: string; amount: number }[];
  unknown: boolean;
}

export interface ModelEvaluation {
  model: ResolvedModelRef;
  conservation: { ok: boolean; perOrderChecked: number; violations: string[] };
  negativeAllocations: { orderId: string; channelId: string; amount: number }[];
  overRefund: { orderId: string; grossAmount: number; refundedAmount: number; excess: number }[];
  unknown: UnknownBreakdown;
  coverage: CoverageBreakdown;
  channelShares: ChannelShare[];
  orderAllocations: OrderAllocation[];
  totalAttributed: number;
  totalNet: number;
  unknownAmount: number;
  supportNotes: string[];
}

// ---------------- 稳定性（簇重复抽样） ----------------

export type StabilityMetric = 'channel_share' | 'total_attributed' | 'mean_order_abs_delta';

export interface PairedDiff {
  metric: StabilityMetric;
  channelId?: string;
  label: string;
  pointEstimate: number;
  lower: number | null;
  upper: number | null;
  replications: number;
  support: SupportState;
  supportReason: string;
}

export interface StabilityResult {
  method: 'cluster_bootstrap';
  clusterKind: 'customer' | 'order' | 'mixed';
  clusterCount: number;
  orderCount: number;
  iterations: number;
  seed: number;
  points: number;
  supportedPoints: number;
  diffs: PairedDiff[];
  fallbackOrderClusters: number;
  limitations: string[];
}

// ---------------- 分群 ----------------

export interface SegmentChannelCell {
  channelId: string;
  name: string;
  amountA: number;
  amountB: number;
  shareA: number | null;
  shareB: number | null;
  delta: number | null;
  covered: boolean;
  support: SupportState;
  supportReason: string;
}

export interface SegmentCell {
  key: SegmentKey;
  value: string;
  orders: number;
  netAmount: number;
  weight: number;
  unknownAmountA: number;
  unknownAmountB: number;
  coverageRatioA: number;
  coverageRatioB: number;
  channels: SegmentChannelCell[];
  support: SupportState;
  supportReason: string;
}

export interface SegmentDivergence {
  key: SegmentKey;
  value: string;
  channelId: string;
  channelName: string;
  overallDelta: number;
  segmentDelta: number;
  note: string;
}

export interface SegmentAnalysis {
  cells: SegmentCell[];
  divergences: SegmentDivergence[];
  note: string;
}

// ---------------- 版本对照 ----------------

export interface CompositionComparison {
  key: SegmentKey;
  commonValues: string[];
  addedValues: string[];
  missingValues: string[];
  /** 共同分群在基准样本中的权重（重新归一化后） */
  commonWeights: Record<string, number>;
  /** 用共同权重加权的目标渠道份额 */
  commonWeightedBase: number | null;
  commonWeightedAlt: number | null;
  commonWeightedDelta: number | null;
  /** 总均值方向与局部群方向相反 */
  divergence: { value: string; overallDelta: number; segmentDelta: number }[];
  note: string;
}

export interface OrderDiff {
  orderId: string;
  netDelta: number;
  allocationDelta: number;
  channelDeltas: { channelId: string; name: string; delta: number }[];
  changeKind: 'model_only' | 'net_only' | 'both' | 'none';
  unknownA: boolean;
  unknownB: boolean;
}

export interface ComparisonSide {
  sampleId: string;
  sampleRevision: number;
  sampleHash: string;
  modelLabel: string;
  totalNet: number;
  totalAttributed: number;
  conservationOk: boolean;
  channelShares: ChannelShare[];
  segments: Record<SegmentKey, SegmentCell[]>;
}

export interface ComparisonRecord {
  kind: 'model_swap' | 'sample_swap' | 'refund_update';
  label: string;
  base: ComparisonSide;
  alt: ComparisonSide;
  netDelta: number;
  attributedDelta: number;
  orderDiffs: OrderDiff[];
  changedOrderCount: number;
  isolatedFactor: 'model' | 'sample' | 'refund';
  focusChannelId?: string;
  composition: Record<SegmentKey, CompositionComparison>;
  support: SupportState;
  supportReason: string;
  notes: string[];
}

// ---------------- 漂移监测 ----------------

export interface DriftRow {
  channelId: string;
  name: string;
  matureShare: number | null;
  recentShare: number | null;
  delta: number | null;
  recentCoverage: number;
  support: SupportState;
  supportReason: string;
}

export interface DriftReport {
  matureSampleId: string;
  recentSampleId: string;
  modelLabel: string;
  rows: DriftRow[];
  immatureRecentOrderIds: string[];
  composition: Record<SegmentKey, CompositionComparison>;
  divergences: SegmentDivergence[];
  limitations: string[];
  note: string;
}

// ---------------- 评估运行 ----------------

export interface EvaluationConfig {
  sampleId: string;
  modelA: { registryId: string; revision: string };
  modelB: { registryId: string; revision: string };
  segmentKeys: SegmentKey[];
  bootstrapIterations: number;
  seed: number;
  minClusters: number;
  focusChannelId?: string;
}

export interface EvaluationResult {
  sampleId: string;
  sampleLabel: string;
  sampleWindow: SampleWindow;
  sampleRevision: number;
  sampleHash: string;
  sampleBuiltAt: string;
  sample: SampleBuild;
  evaluatedAt: string;
  config: EvaluationConfig;
  modelA: ModelEvaluation;
  modelB: ModelEvaluation;
  stability: StabilityResult;
  segments: Record<SegmentKey, SegmentAnalysis>;
  orderDiffs: OrderDiff[];
  supportNotes: string[];
  disclaimers: string[];
}

export type EvaluationStatus = 'running' | 'completed' | 'cancelled';

export interface EvaluationRun {
  evalId: string;
  config: EvaluationConfig;
  sampleId: string;
  sampleHash: string;
  sampleRevision: number;
  modelARef: ResolvedModelRef;
  modelBRef: ResolvedModelRef;
  status: EvaluationStatus;
  progress: number;
  createdAt: string;
  createdBy: string;
  completedAt?: string;
  cancelledAt?: string;
  /** 取消原因（手动取消 / 切换样本被取代） */
  cancelReason?: string;
  result?: EvaluationResult;
  /** 版本对照：同样本换模型 / 同模型换样本 / 只更新退款 */
  comparisons: ComparisonRecord[];
  /** 审查依据说明（用户填写的评估理由） */
  basis?: string;
  drift?: DriftReport;
  /** 因切换样本 / 取消而丢弃的晚到结果次数 */
  staleDiscards: number;
}

// ---------------- 审查与发布 ----------------

export type ReviewStatus = 'draft' | 'approved' | 'published' | 'revoked';

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  draft: '待审批',
  approved: '已批准',
  published: '已发布',
  revoked: '已撤回',
};

export interface ReviewModelRef {
  registryId: string;
  name: string;
  revision: string;
  revisionHash: string;
  baseModel: AttributionModel;
  allowedUses: AllowedUse[];
}

export interface FrozenEvaluation {
  evalId: string;
  sampleId: string;
  sampleLabel: string;
  sampleRevision: number;
  sampleHash: string;
  dataVersion: string;
  modelARef: ReviewModelRef;
  modelBRef: ReviewModelRef;
  conservationA: boolean;
  conservationB: boolean;
  totalNet: number;
  totalAttributedA: number;
  totalAttributedB: number;
  unknownAmountA: number;
  channelSharesA: ChannelShare[];
  channelSharesB: ChannelShare[];
  stabilityPoints: number;
  supportedPoints: number;
  unsupportedPoints: number;
  segments: Record<SegmentKey, SegmentAnalysis>;
  comparisons: ComparisonRecord[];
  drift?: DriftReport;
  frozenAt: string;
}

export interface ReviewAuditEntry {
  at: string;
  by: string;
  action: 'created' | 'approved' | 'approve_blocked' | 'published' | 'publish_blocked' | 'revoked' | 'revalidated';
  detail: string;
}

export interface ReviewRecord {
  reviewId: string;
  title: string;
  evalId: string;
  sampleId: string;
  sampleRevision: number;
  sampleHash: string;
  modelRefs: ReviewModelRef[];
  status: ReviewStatus;
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  publishedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
  /** 撤回后仍可回看，但不得作为新分析的有效性证明 */
  validForNewAnalysis: boolean;
  invalidationReason?: string;
  publishBlockedReason?: string;
  frozen?: FrozenEvaluation;
  supersededBy?: string;
  audit: ReviewAuditEntry[];
}

// ---------------- 合并输入 ----------------

export interface MergedInputs {
  dataVersion: string;
  channels: Channel[];
  orders: Order[];
  touchpoints: Touchpoint[];
  refunds: RefundEvent[];
  sourceSnapshot: DataSnapshot;
  supplementIds: string[];
}
