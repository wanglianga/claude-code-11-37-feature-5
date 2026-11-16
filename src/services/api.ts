import { computeAttribution } from '@/engine/attribution';
import { snapshots } from '@/data/sampleData';
import type { DataSnapshot, RunConfig, RunResults } from '@/types/domain';

// ============================================================
// 模拟异步数据服务
// 真实环境对应后端 API：统一延迟、失败可复现。
// 防过期响应不放在服务端，而由调用方持有“请求序号”做竞态控制。
// ============================================================

function delay<T>(value: T, ms = 480): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function fetchSnapshots(): Promise<DataSnapshot[]> {
  return delay(snapshots, 300);
}

export function fetchSnapshot(snapshotId: string): Promise<DataSnapshot | undefined> {
  return delay(snapshots.find((s) => s.snapshotId === snapshotId), 200);
}

export function runAttribution(snapshotId: string, config: RunConfig): Promise<RunResults> {
  const snapshot = snapshots.find((s) => s.snapshotId === snapshotId);
  if (!snapshot) return Promise.reject(new Error(`快照 ${snapshotId} 不存在`));
  const computedAt = new Date().toISOString();
  return delay(computeAttribution(snapshot, config, computedAt), 650);
}

/** 在同一输入快照上并行计算多种模型，便于敏感性对比 */
export function runModelComparison(
  snapshotId: string,
  baseConfig: RunConfig,
  models: RunConfig['model'][],
): Promise<RunResults[]> {
  const snapshot = snapshots.find((s) => s.snapshotId === snapshotId);
  if (!snapshot) return Promise.reject(new Error(`快照 ${snapshotId} 不存在`));
  const computedAt = new Date().toISOString();
  return delay(
    models.map((model) => computeAttribution(snapshot!, { ...baseConfig, model }, computedAt)),
    800,
  );
}

/**
 * 请求序号守卫：同一筛选条件快速切换时，只有最新一次请求允许落库。
 * 用法：const seq = new RequestSeq(); seq.run(fetch(...)).then(...)
 * 旧请求 resolve 时 accept=false，调用方必须丢弃该响应。
 */
export class RequestSeq<T> {
  private current = 0;

  async run(factory: () => Promise<T>): Promise<{ data: T; accepted: boolean }> {
    const token = ++this.current;
    const data = await factory();
    return { data, accepted: token === this.current };
  }

  get latestToken(): number {
    return this.current;
  }
}
