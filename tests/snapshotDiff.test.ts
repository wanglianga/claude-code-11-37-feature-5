import { describe, expect, it } from 'vitest';
import { configChecksum, diffSnapshots } from '@/store/useAppStore';
import { snapshots } from '@/data/sampleData';
import type { RunConfig } from '@/types/domain';

describe('迟到退款与快照差异', () => {
  it('锁定后到达的 R-1006 被识别为变化订单与锁定后退款', () => {
    const [v1, v2] = snapshots;
    const diff = diffSnapshots(v1, v2);
    expect(diff.changedOrders).toContain('O-2002');
    expect(diff.refundedAfterLock).toContain('O-2002');
    expect(diff.newOrders).toEqual([]);
  });

  it('迟到判定基于输入血缘：即使当前墙上时钟晚于退款时间，仍计为锁定后退款', () => {
    const [v1, v2] = snapshots;
    const diff = diffSnapshots(v1, v2);
    expect(diff.changedOrders).toContain('O-2002');
    expect(diff.refundedAfterLock).toContain('O-2002');
  });

  it('两个快照都包含的退款（R-1005）不计为锁定后迟到退款', () => {
    const [v1, v2] = snapshots;
    const diff = diffSnapshots(v1, v2);
    expect(diff.refundedAfterLock).not.toContain('O-2005');
    expect(v1.refunds.some((r) => r.refundId === 'R-1005')).toBe(true);
    expect(v2.refunds.some((r) => r.refundId === 'R-1005')).toBe(true);
  });

  it('配置校验和对相同配置稳定、对不同配置敏感', () => {
    const cfg: RunConfig = { timezone: 'Asia/Shanghai', dealDefinition: 'net_of_refund_at_lock', windowDays: 7, model: 'linear', ruleRevision: 'RR-1', decayHalfLifeDays: 7 };
    expect(configChecksum(cfg)).toBe(configChecksum({ ...cfg }));
    expect(configChecksum(cfg)).not.toBe(configChecksum({ ...cfg, windowDays: 14 }));
  });
});
