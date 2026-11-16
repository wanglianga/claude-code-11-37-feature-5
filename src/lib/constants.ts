import type { AttributionModel, DealDefinition, RunStatus } from '@/types/domain';

export const MODEL_LABELS: Record<AttributionModel, string> = {
  last_touch: '末次触点',
  first_touch: '首次触点',
  linear: '线性分摊',
  time_decay: '时间衰减',
  position_based: '位置加权（U 型）',
};

export const MODEL_DESCRIPTIONS: Record<AttributionModel, string> = {
  last_touch: '全部份额给成交前最后一个合格触点，最易解释，忽略前序接触。',
  first_touch: '全部份额给首个合格触点，强调拉新渠道。',
  linear: '旅程内所有合格触点平分净额，保留完整旅程但不区分触点强弱。',
  time_decay: '越接近成交的触点权重越高（半衰期可配置），兼顾旅程与时效。',
  position_based: '首末触点各 40%，中间触点平分 20%，同时强调引流与收口。',
};

export const DEAL_LABELS: Record<DealDefinition, string> = {
  paid_order: '付款订单（按毛额）',
  shipped_order: '发货订单（按毛额）',
  net_of_refund_at_lock: '锁定时净额（扣减已到退款）',
};

export const STATUS_LABELS: Record<RunStatus, string> = {
  draft: '草稿',
  running: '计算中',
  completed: '已完成',
  locked: '已锁定',
  superseded: '已被替代',
};

export const STATUS_COLORS: Record<RunStatus, string> = {
  draft: '#8c8c8c',
  running: '#1677ff',
  completed: '#722ed1',
  locked: '#389e0d',
  superseded: '#d46b08',
};

export interface AnalystAccount {
  userId: string;
  name: string;
  role: 'analyst' | 'owner';
  description: string;
}

export const ACCOUNTS: AnalystAccount[] = [
  { userId: 'U-1001', name: '林岚', role: 'analyst', description: '投放分析师 A：可创建/编辑自己的草稿运行' },
  { userId: 'U-1002', name: '高航', role: 'analyst', description: '投放分析师 B：可创建/编辑自己的草稿运行' },
  { userId: 'U-2001', name: '赵明', role: 'owner', description: '投放负责人：审批修订核对、锁定运行、创建共享报告' },
];

export const ALL_MODELS: AttributionModel[] = ['last_touch', 'first_touch', 'linear', 'time_decay', 'position_based'];
