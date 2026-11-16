import { evaluate, makeComparison } from '@/engine/evaluation';
import type {
  AllowedUse,
  ComparisonRecord,
  EvaluationConfig,
  EvaluationResult,
  MergedInputs,
  ResolvedModelRef,
  SampleBuild,
} from '@/types/evaluation';

// ============================================================
// 模拟评估服务：真实环境由后端长任务执行（进度 + 取消 + 竞态防护）。
// 计算在内存中同步完成，但以分片 Promise 推进进度，让 UI 能显示进度、取消，
// 并用请求序号丢弃「切换样本后旧任务」的结果。
// ============================================================

export interface EvaluationJobHandle {
  evalId: string;
  /** 取消：之后不会回调 onResult */
  cancel: () => void;
  done: Promise<EvaluationResult | null>;
}

export interface StartEvaluationArgs {
  evalId: string;
  build: SampleBuild;
  inputs: MergedInputs;
  config: EvaluationConfig;
  modelA: ResolvedModelRef;
  modelB: ResolvedModelRef;
  purpose: AllowedUse;
  onProgress?: (progress: number) => void;
  /** 用于测试的可注入时钟（默认 Date） */
  now?: () => Date;
  /** 每级模拟延迟（毫秒），测试可设为 0 */
  tickMs?: number;
}

const STEPS = [8, 22, 40, 58, 74, 88, 100];

export function startEvaluation(args: StartEvaluationArgs): EvaluationJobHandle {
  let cancelled = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: ((value: EvaluationResult | null) => void) | null = null;
  const tick = args.tickMs ?? 260;
  const now = args.now ?? (() => new Date());

  const done = new Promise<EvaluationResult | null>((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let step = 0;
    const advance = () => {
      if (cancelled) {
        settle?.(null);
        return;
      }
      const progress = STEPS[step];
      args.onProgress?.(progress);
      step += 1;
      if (step < STEPS.length) {
        timer = setTimeout(advance, tick);
        return;
      }
      // 最后一步真实计算（纯函数，可能较重）
      try {
        const result = evaluate(
          args.build,
          args.inputs,
          args.modelA,
          args.modelB,
          args.config,
          args.purpose,
          now().toISOString(),
        );
        settle?.(cancelled ? null : result);
      } catch {
        settle?.(null);
      }
    };
    // 立即推进第一帧
    timer = setTimeout(advance, 0);
  });

  return {
    evalId: args.evalId,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // 取消后立即结算，避免悬挂的 Promise；调用方因 status !== 'running' 会丢弃该结果
      settle?.(null);
    },
    done,
  };
}

/**
 * 计算版本对照：把差异隔离到单一因素。
 *  - model_swap：同样本换模型
 *  - sample_swap：同模型换样本
 *  - refund_update：样本成员不变、仅退款补齐后的净额变化
 */
export function buildComparisons(args: {
  primary: EvaluationResult;
  /** 同样本、换模型 A→B */
  sameSampleSwapped?: EvaluationResult;
  /** 同模型、换样本 */
  sameModelOtherSample?: EvaluationResult;
  /** 同模型、同样本成员、退款补齐后的样本 */
  refundUpdated?: EvaluationResult;
  segmentKeys: EvaluationConfig['segmentKeys'];
  focusChannelId?: string;
  minClusters: number;
}): ComparisonRecord[] {
  const out: ComparisonRecord[] = [];
  const toPair = (r: EvaluationResult) => ({ build: r.sample, eval: r.modelA });
  if (args.sameSampleSwapped) {
    out.push(
      makeComparison(
        'model_swap',
        toPair(args.primary),
        toPair(args.sameSampleSwapped),
        args.segmentKeys,
        args.focusChannelId,
        args.minClusters,
        ['两侧样本哈希一致，差异只能来自模型规则（B 模型在该样本上的结果）。'],
      ),
    );
  }
  if (args.sameModelOtherSample) {
    out.push(
      makeComparison(
        'sample_swap',
        toPair(args.primary),
        toPair(args.sameModelOtherSample),
        args.segmentKeys,
        args.focusChannelId,
        args.minClusters,
        ['两侧模型与修订一致，差异只能来自样本输入（订单集合 / 触点 / 截止点）。'],
      ),
    );
  }
  if (args.refundUpdated) {
    out.push(
      makeComparison(
        'refund_update',
        toPair(args.primary),
        toPair(args.refundUpdated),
        args.segmentKeys,
        args.focusChannelId,
        args.minClusters,
        ['模型与样本成员一致，差异只能来自退款补齐后的净额变化。'],
      ),
    );
  }
  return out;
}
