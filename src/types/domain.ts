// ============================================================
// 渠道贡献归因工作台 —— 领域模型
// 所有金额单位：分（整数），展示层再格式化为元，避免浮点误差
// ============================================================

/** 渠道 */
export interface Channel {
  channelId: string;
  name: string;
  platform: string;
  mediaType: '搜索' | '社交' | '展示' | '邮件' | '自有';
}

/** 确定性标识（仅授权标识可用于跨设备连接） */
export interface IdentityIdentifier {
  kind: 'login_id' | 'email_hash' | 'device_id' | 'crm_id';
  value: string;
  authorized: boolean;
  deviceId?: string;
}

export interface IdentityLink {
  personId: string;
  displayName: string;
  identifiers: IdentityIdentifier[];
  /** 跨设备连接是否具备授权依据；false 时引擎禁止把不同设备拼成同一人 */
  crossDeviceAuthorized: boolean;
  note?: string;
}

/** 订单级触点：必须带稳定订单关联，才允许参与逐单分配 */
export interface Touchpoint {
  touchpointId: string;
  orderId: string;
  personId: string | null;
  deviceId: string;
  channelId: string;
  campaignId: string;
  campaignName: string;
  /** UTC 时刻（ISO 字符串） */
  eventTime: string;
  /** 事件原始时区，用于跨时区活动追溯 */
  eventTimezone: string;
  eventType: 'impression' | 'click';
  identityKind: IdentityIdentifier['kind'];
  identityAuthorized: boolean;
}

export type OrderStatus = 'placed' | 'cancelled' | 'refunded_partial' | 'refunded_full';

export interface Order {
  orderId: string;
  personId: string | null;
  deviceId: string;
  orderTime: string;
  orderTimezone: string;
  grossAmount: number;
  currency: 'CNY';
  status: OrderStatus;
  touchpointIds: string[];
  scenarioTag?: string;
  /** 评估分群：区域（缺省时评估样本标记为「未标注」） */
  region?: string;
  /** 评估分群：设备群（缺省时评估样本标记为「未标注」） */
  deviceSegment?: string;
}

/** 退款事件（可能晚于广告回传与运行锁定到达） */
export interface RefundEvent {
  refundId: string;
  orderId: string;
  amount: number;
  refundTime: string;
  reason: string;
  dataVersion: string;
  /** 退款批次：簇重抽样时同批退款随订单整体移动，不拆散 */
  refundBatchId?: string;
}

/** 订单净额版本：毛额 → 退款扣减 → 净额，可追溯 */
export interface OrderVersion {
  orderId: string;
  dataVersion: string;
  grossAmount: number;
  refundedAmount: number;
  netAmount: number;
  status: OrderStatus;
  refundIds: string[];
}

/** 平台点击汇总（无订单级标识）——只进平台汇总区，不参与逐单分配 */
export interface PlatformClickAggregate {
  aggId: string;
  platform: string;
  channelId: string;
  campaignId: string;
  day: string;
  clicks: number;
  cost: number;
  hasOrderIdentifier: false;
  note?: string;
}

/** 数据接入作业（血缘记录） */
export interface IngestionJob {
  jobId: string;
  source: string;
  stream: 'orders' | 'order_touchpoints' | 'platform_click_aggregate' | 'refund' | 'identity';
  fetchedAt: string;
  recordCount: number;
  checksum: string;
  status: 'success' | 'quarantined';
  note?: string;
}

/** 输入数据快照：接入、归并、净额三条管线的冻结产物 */
export interface DataSnapshot {
  snapshotId: string;
  dataVersion: string;
  /** 该快照生效的规则修订 */
  ruleRevision: string;
  createdAt: string;
  ingestionJobs: IngestionJob[];
  channels: Channel[];
  identityLinks: IdentityLink[];
  orders: Order[];
  touchpoints: Touchpoint[];
  refunds: RefundEvent[];
  orderVersions: OrderVersion[];
  platformClicks: PlatformClickAggregate[];
}

// ---------------- 归因运行 ----------------

export type AttributionModel =
  | 'last_touch'
  | 'first_touch'
  | 'linear'
  | 'time_decay'
  | 'position_based';

/** 成交定义 */
export type DealDefinition = 'paid_order' | 'shipped_order' | 'net_of_refund_at_lock';

export type RunStatus = 'draft' | 'running' | 'completed' | 'locked' | 'superseded';

export interface RunConfig {
  timezone: string;
  dealDefinition: DealDefinition;
  windowDays: number;
  model: AttributionModel;
  ruleRevision: string;
  decayHalfLifeDays: number;
}

export interface AllocationLine {
  channelId: string;
  touchpointId: string;
  weight: number;
  amount: number;
}

export interface OrderAttribution {
  orderId: string;
  personId: string | null;
  netAmount: number;
  eligibleTouchpointIds: string[];
  allocations: AllocationLine[];
  /** 未知来源（无授权人员标识或无合格触点），金额单列 */
  unknown: boolean;
  excluded?: string;
}

export interface ChannelSummary {
  channelId: string;
  attributedRevenue: number;
  orderCount: number;
  touchpointCount: number;
}

export interface RunResults {
  model: AttributionModel;
  computedAt: string;
  orderAttributions: OrderAttribution[];
  channelSummaries: ChannelSummary[];
  unknownRevenue: number;
  unknownOrderIds: string[];
  totalNetRevenue: number;
  totalAllocated: number;
  excludedZeroNetOrderIds: string[];
}

export interface ApprovalRecord {
  approvedBy: string;
  approvedAt: string;
  /** 审批时核对的来源修订 */
  sourceRevision: string;
  ruleRevision: string;
  configChecksum: string;
  revisionMatched: boolean;
}

export interface RunChangeSummary {
  newOrders: string[];
  changedOrders: string[];
  refundedAfterLock: string[];
}

export interface AttributionRun {
  runId: string;
  snapshotId: string;
  dataVersion: string;
  analyst: string;
  createdAt: string;
  status: RunStatus;
  config: RunConfig;
  results?: RunResults;
  approval?: ApprovalRecord;
  lockedAt?: string;
  /** 迟到退款派生链 */
  parentRunId?: string;
  changeSummary?: RunChangeSummary;
}

// ---------------- 共享报告 ----------------

export interface SharedReport {
  shareId: string;
  runId: string;
  snapshotId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  status: 'active' | 'revoked';
  /** 冻结载荷：运行锁定后复制，后续运行变化不影响它 */
  frozen: {
    dataVersion: string;
    ruleRevision: string;
    config: RunConfig;
    channelSummaries: ChannelSummary[];
    orderAttributions: OrderAttribution[];
    unknownRevenue: number;
    totalNetRevenue: number;
    totalAllocated: number;
  };
}

// ---------------- 预算方案 ----------------

export interface BudgetLine {
  channelId: string;
  currentSpend: number;
  proposedBudget: number;
  /** 基于已完成运行的模拟收入（仅模拟，不回写订单） */
  simulatedRevenue: number;
}

export interface BudgetPlan {
  planId: string;
  name: string;
  runId: string;
  createdAt: string;
  status: 'draft' | 'published';
  lines: BudgetLine[];
}
