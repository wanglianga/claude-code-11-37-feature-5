import type { ReactNode } from 'react';
import { SUPPORT_LABELS } from '@/types/evaluation';
import type { SupportState } from '@/types/evaluation';

const SUPPORT_TONE: Record<SupportState, string> = {
  supported: 'green',
  insufficient_sample: 'orange',
  channel_not_covered: 'gray',
  interval_undetermined: 'orange',
  model_not_allowed: 'red',
};

/** 统一的「是否支持结论」徽章：不支持时显示原因，绝不填零分 */
export function SupportBadge({ state, reason }: { state: SupportState; reason?: string }) {
  return (
    <span className={`badge ${SUPPORT_TONE[state]}`} title={reason ?? ''}>
      {SUPPORT_LABELS[state]}
      {state !== 'supported' && ' · 不支持结论'}
    </span>
  );
}

export function SupportYesNo({ ok, yes, no }: { ok: boolean; yes: ReactNode; no: ReactNode }) {
  return ok ? <span className="badge green">{yes}</span> : <span className="badge red">{no}</span>;
}

/** 百分比，null 显示「—」而不是 0 */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** 百分点（pp），null 显示「—」 */
export function pp(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}pp`;
}

export function scoreLookup(value: number | null | undefined): 'up' | 'down' | 'flat' | 'none' {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'none';
  if (Math.abs(value) < 0.0005) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/** 区间文案，缺失显示「区间无法确定」 */
export function intervalText(lower: number | null, upper: number | null, format: (n: number) => string): string {
  if (lower === null || upper === null) return '区间无法确定（不支持结论）';
  return `[${format(lower)}, ${format(upper)}]`;
}
