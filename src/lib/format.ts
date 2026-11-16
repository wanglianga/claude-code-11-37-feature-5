// 金额（分）与时间展示工具
export function formatYuan(cents: number): string {
  return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatCny(cents: number): string {
  return `¥${formatYuan(cents)}`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDateTime(iso: string, timezone?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  };
  try {
    return new Intl.DateTimeFormat('zh-CN', opts).format(d);
  } catch {
    return d.toISOString();
  }
}

export function formatDay(iso: string): string {
  return iso.slice(0, 10);
}
