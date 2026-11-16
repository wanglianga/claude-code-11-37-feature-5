import { useMemo, useRef, useState } from 'react';
import EChart from '@/components/EChart';
import { KeyValue, Modal, StatusBadge } from '@/components/ui';
import { verifyInvariants } from '@/engine/attribution';
import { formatCny, formatDateTime } from '@/lib/format';
import { ACCOUNTS, ALL_MODELS, DEAL_LABELS, MODEL_DESCRIPTIONS, MODEL_LABELS } from '@/lib/constants';
import { CHART_COLORS, CHART_TEXT, baseTextStyle } from '@/lib/chart';
import { RequestSeq, runModelComparison } from '@/services/api';
import { LATE_REFUND_SNAPSHOT_ID } from '@/data/sampleData';
import type { BarSeriesOption, EChartsOption } from 'echarts';
import { configChecksum, useAppStore } from '@/store/useAppStore';
import type { AttributionModel, AttributionRun, DealDefinition, RunConfig, RunResults } from '@/types/domain';

const DEFAULT_CONFIG: RunConfig = {
  timezone: 'Asia/Shanghai',
  dealDefinition: 'net_of_refund_at_lock',
  windowDays: 7,
  model: 'last_touch',
  ruleRevision: '',
  decayHalfLifeDays: 7,
};

export default function RunsPage() {
  const store = useAppStore();
  const isOwner = store.currentUserId === 'U-2001';
  const [form, setForm] = useState<RunConfig>({ ...DEFAULT_CONFIG });
  const [snapshotId, setSnapshotId] = useState(store.snapshots[0].snapshotId);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const detailRun = store.runs.find((r) => r.runId === detailRunId) ?? null;
  // 迟到退款派生目标：R-1006 所在的 11-05 快照（评估用的 11-15 不参与归因运行的派生）
  const lateRefundSnapshot = store.snapshots.find((s) => s.snapshotId === LATE_REFUND_SNAPSHOT_ID) ?? store.snapshots[store.snapshots.length - 1];

  const notify = (kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  };

  const createDraft = () => {
    const runId = store.createDraftRun({ snapshotId, config: form });
    notify('success', `已创建草稿运行 ${runId}（分析师 ${ACCOUNTS.find((a) => a.userId === store.currentUserId)?.name}）`);
    setDetailRunId(runId);
  };

  return (
    <>
      {toast && <div className={`notice ${toast.kind === 'success' ? 'success' : 'error'}`}>{toast.text}</div>}

      <div className="card">
        <div className="card-title">
          创建归因运行（草稿）
          <span className="hint">运行绑定：时区 · 成交定义 · 归因窗口 · 规则修订；两名分析师各自产生独立草稿，互不覆盖</span>
        </div>
        <div className="form-row">
          <label className="field">输入快照
            <select value={snapshotId} onChange={(e) => setSnapshotId(e.target.value)}>
              {store.snapshots.map((s) => <option key={s.snapshotId} value={s.snapshotId}>{s.snapshotId}（{s.dataVersion} / {s.ruleRevision}）</option>)}
            </select>
          </label>
          <label className="field">报告时区
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              <option value="Asia/Shanghai">Asia/Shanghai（UTC+8）</option>
              <option value="America/Los_Angeles">America/Los_Angeles（UTC-8）</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          <label className="field">成交定义
            <select value={form.dealDefinition} onChange={(e) => setForm({ ...form, dealDefinition: e.target.value as DealDefinition })}>
              {Object.entries(DEAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field">归因窗口（天）
            <input type="number" min={1} max={90} value={form.windowDays} onChange={(e) => setForm({ ...form, windowDays: Number(e.target.value) })} style={{ width: 110 }} />
          </label>
          <label className="field">归因模型
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value as AttributionModel })}>
              {ALL_MODELS.map((m) => <option key={m} value={m}>{MODEL_LABELS[m]}</option>)}
            </select>
          </label>
          {form.model === 'time_decay' && (
            <label className="field">半衰期（天）
              <input type="number" min={1} max={30} value={form.decayHalfLifeDays} onChange={(e) => setForm({ ...form, decayHalfLifeDays: Number(e.target.value) })} style={{ width: 110 }} />
            </label>
          )}
          <button className="primary" onClick={createDraft}>创建草稿运行</button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>模型说明：{MODEL_DESCRIPTIONS[form.model]}</div>
      </div>

      <ParallelScratchPanel snapshotId={snapshotId} baseConfig={form} />

      <div className="card">
        <div className="card-title">运行列表 <span className="hint">审批与分享必须核对来源修订；锁定后迟到退款只生成新运行</span></div>
        {store.runs.length === 0 ? (
          <div className="empty">暂无运行，请先在上方创建草稿</div>
        ) : (
          <table>
            <thead>
              <tr><th>运行</th><th>负责人</th><th>快照/版本</th><th>模型与口径</th><th>状态</th><th>审批核对</th><th>派生</th><th>操作</th></tr>
            </thead>
            <tbody>
              {[...store.runs].reverse().map((run) => {
                const analyst = ACCOUNTS.find((a) => a.userId === run.analyst);
                const canEdit = run.status === 'draft' && (run.analyst === store.currentUserId || isOwner);
                return (
                  <tr key={run.runId}>
                    <td>
                      <span className="mono clickable" onClick={() => setDetailRunId(run.runId)}>{run.runId}</span>
                      <div className="small muted">{formatDateTime(run.createdAt)}</div>
                    </td>
                    <td>{analyst?.name ?? run.analyst}<div className="small muted">{analyst?.role === 'owner' ? '负责人' : '分析师'}</div></td>
                    <td className="small"><span className="mono">{run.snapshotId}</span><div className="muted">{run.dataVersion} / {run.config.ruleRevision}</div></td>
                    <td className="small">{MODEL_LABELS[run.config.model]}<div className="muted">{DEAL_LABELS[run.config.dealDefinition]} · 窗口 {run.config.windowDays}d · {run.config.timezone}</div></td>
                    <td><StatusBadge status={run.status} /></td>
                    <td>
                      {run.approval ? (
                        run.approval.revisionMatched ? <span className="badge green">修订一致 ✓</span> : <span className="badge red">修订不一致 ✕</span>
                      ) : <span className="badge gray">未审批</span>}
                    </td>
                    <td>{run.parentRunId ? <span className="badge orange">派生自 {run.parentRunId.slice(-6)}</span> : '—'}</td>
                    <td>
                      <div className="pill-row">
                        <button className="sm" onClick={() => setDetailRunId(run.runId)}>详情</button>
                        {(run.status === 'draft' || run.status === 'superseded') && (
                          <button className="sm primary" disabled={!canEdit} title={canEdit ? '' : '只有创建者或负责人可编辑该草稿'} onClick={() => void store.executeRun(run.runId)}>
                            执行计算
                          </button>
                        )}
                        {run.status === 'running' && <span className="small"><span className="loading" />计算中</span>}
                        {run.status === 'completed' && isOwner && (
                          <button className="sm" onClick={() => { const r = store.approveRun(run.runId, store.currentUserId); notify(r.ok ? 'success' : 'error', r.message); }}>审批核对</button>
                        )}
                        {run.status === 'completed' && run.approval?.revisionMatched && isOwner && (
                          <button className="sm primary" onClick={() => { const r = store.lockRun(run.runId); notify(r.ok ? 'success' : 'error', r.message); }}>锁定</button>
                        )}
                        {run.status === 'locked' && run.snapshotId === 'DS-2026-11-01' && (
                          <button className="sm danger" onClick={() => {
                            const id = store.createSupersedingRun(run.runId, lateRefundSnapshot.snapshotId);
                            if (id) { notify('success', `检测到锁定后退款，已生成新草稿运行 ${id}；旧运行图表保持不变`); setDetailRunId(id); }
                          }}>基于新退款生成新运行</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <RunDetailModal run={detailRun} onClose={() => setDetailRunId(null)} notify={notify} />
    </>
  );
}

// ---------------- 并行模型试算（同一快照，不落库） ----------------
function ParallelScratchPanel({ snapshotId, baseConfig }: { snapshotId: string; baseConfig: RunConfig }) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RunResults[] | null>(null);
  const [staleCount, setStaleCount] = useState(0);
  const seqRef = useRef(new RequestSeq<RunResults[]>());
  const channels = useAppStore((s) => s.snapshots.find((x) => x.snapshotId === snapshotId)?.channels ?? []);

  const runAll = async () => {
    setLoading(true);
    const { data, accepted } = await seqRef.current.run(() => runModelComparison(snapshotId, baseConfig, ALL_MODELS));
    if (!accepted) {
      // 旧响应：明确丢弃，不允许覆盖最新条件下的视图
      setStaleCount((c) => c + 1);
      setLoading(false);
      return;
    }
    setResults(data);
    setLoading(false);
  };

  const option = useMemo<EChartsOption | null>(() => {
    if (!results) return null;
    return {
      color: CHART_COLORS,
      textStyle: baseTextStyle,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => formatCny(Number(v)) },
      legend: { bottom: 0, textStyle: { color: CHART_TEXT } },
      grid: { left: 70, right: 20, top: 36, bottom: 60 },
      xAxis: { type: 'category', data: ALL_MODELS.map((m) => MODEL_LABELS[m]), axisLabel: { color: CHART_TEXT, interval: 0, fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { color: CHART_TEXT, formatter: (v: number) => `${v / 100}元` }, splitLine: { lineStyle: { color: '#eef1f6' } } },
      series: channels.map((c): BarSeriesOption => ({
        name: c.name,
        type: 'bar',
        stack: 'rev',
        data: results.map((r) => r.channelSummaries.find((s) => s.channelId === c.channelId)?.attributedRevenue ?? 0),
      })).filter((s) => (s.data as number[]).some((v) => v > 0)),
    };
  }, [results, channels, snapshotId]);

  return (
    <div className="card">
      <div className="card-title">
        同一快照并行多模型试算
        <span className="hint">在选定快照上并行计算 5 种模型，观察渠道结论对规则的敏感程度；试算结果不保存为运行</span>
      </div>
      <div className="pill-row" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => void runAll()} disabled={loading}>
          {loading ? <span><span className="loading" />并行计算中…</span> : '并行试算全部模型'}
        </button>
        {staleCount > 0 && <span className="stale-note">已丢弃 {staleCount} 次过期响应（条件切换后旧请求返回，未覆盖当前视图）</span>}
      </div>
      {results && option && (
        <>
          <EChart option={option} className="chart-box" />
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>模型</th><th className="num">已分配</th><th className="num">未知来源单列</th><th className="num">净收入合计</th><th>守恒</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.model}>
                  <td>{MODEL_LABELS[r.model]}</td>
                  <td className="num">{formatCny(r.totalAllocated)}</td>
                  <td className="num">{formatCny(r.unknownRevenue)}</td>
                  <td className="num">{formatCny(r.totalNetRevenue)}</td>
                  <td>{verifyInvariants(r).ok ? <span className="badge green">通过</span> : <span className="badge red">违反</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------------- 运行详情 ----------------
function RunDetailModal({ run, onClose, notify }: { run: AttributionRun | null; onClose: () => void; notify: (k: 'success' | 'error', t: string) => void }) {
  const store = useAppStore();
  if (!run) return null;
  const snapshot = store.snapshots.find((s) => s.snapshotId === run.snapshotId);
  const invariant = run.results ? verifyInvariants(run.results) : null;
  const analyst = ACCOUNTS.find((a) => a.userId === run.analyst);
  const isOwner = store.currentUserId === 'U-2001';

  return (
    <Modal open={!!run} wide title={<span>运行详情 <span className="mono">{run.runId}</span></span>} onClose={onClose}>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card tight">
          <div className="card-title">绑定配置（不可静默变更）</div>
          <KeyValue rows={[
            ['状态', <StatusBadge status={run.status} />],
            ['创建人', `${analyst?.name}（${run.analyst}）`],
            ['输入快照', <span className="mono">{run.snapshotId}</span>],
            ['数据版本', <span className="mono">{run.dataVersion}</span>],
            ['规则修订', run.status === 'draft' ? (
              <select
                value={run.config.ruleRevision}
                onChange={(e) => store.updateDraftConfig(run.runId, { ruleRevision: e.target.value })}
              >
                <option value="RR-2026-03">RR-2026-03（11-01 快照）</option>
                <option value="RR-2026-04">RR-2026-04（11-05 快照）</option>
              </select>
            ) : <span className="mono">{run.config.ruleRevision}</span>],
            ['报告时区', run.config.timezone],
            ['成交定义', DEAL_LABELS[run.config.dealDefinition]],
            ['归因窗口', `${run.config.windowDays} 天`],
            ['模型', `${MODEL_LABELS[run.config.model]}${run.config.model === 'time_decay' ? `（半衰期 ${run.config.decayHalfLifeDays} 天）` : ''}`],
            ['配置校验和', <span className="mono">{configChecksum(run.config)}</span>],
          ]} />
          {run.approval && (
            <>
              <div className="section-divider" />
              <div className="card-title">审批记录</div>
              <KeyValue rows={[
                ['审批人', ACCOUNTS.find((a) => a.userId === run.approval!.approvedBy)?.name ?? run.approval.approvedBy],
                ['审批时间', formatDateTime(run.approval.approvedAt)],
                ['来源修订', <span className="mono">{run.approval.sourceRevision}</span>],
                ['运行修订', <span className="mono">{run.approval.ruleRevision}</span>],
                ['核对结论', run.approval.revisionMatched ? <span className="badge green">一致，允许锁定与分享</span> : <span className="badge red">不一致，禁止锁定</span>],
              ]} />
            </>
          )}
          {run.lockedAt && <div className="notice success" style={{ marginTop: 10 }}>已于 {formatDateTime(run.lockedAt)} 锁定；锁定后到达的退款不会改动本运行任何图表。</div>}
        </div>

        <div className="card tight">
          <div className="card-title">结果与不变量</div>
          {!run.results ? (
            <div className="empty">尚未执行计算</div>
          ) : (
            <>
              <KeyValue rows={[
                ['参与分配净收入', formatCny(run.results.totalNetRevenue)],
                ['渠道已分配总额', formatCny(run.results.totalAllocated)],
                ['未知来源（单列）', `${formatCny(run.results.unknownRevenue)}（${run.results.unknownOrderIds.length} 单）`],
                ['零净额排除订单', run.results.excludedZeroNetOrderIds.join('、') || '无'],
                ['份额守恒', invariant?.ok ? <span className="badge green">已分配 + 未知 = 净收入</span> : <span className="badge red">{invariant?.violations.join('；')}</span>],
              ]} />
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>渠道</th><th className="num">归因收入</th><th className="num">订单数</th><th className="num">触点数</th></tr></thead>
                <tbody>
                  {run.results.channelSummaries.map((c) => (
                    <tr key={c.channelId}>
                      <td>{snapshot?.channels.find((x) => x.channelId === c.channelId)?.name ?? c.channelId}</td>
                      <td className="num">{formatCny(c.attributedRevenue)}</td>
                      <td className="num">{c.orderCount}</td>
                      <td className="num">{c.touchpointCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {run.changeSummary && (
            <>
              <div className="section-divider" />
              <div className="card-title">相对父运行的变化 <span className="hint">迟到退款派生</span></div>
              <div className="notice warn">
                <div>
                  新增订单：{run.changeSummary.newOrders.join('、') || '无'}<br />
                  净额变化订单：{run.changeSummary.changedOrders.join('、') || '无'}<br />
                  锁定后到达退款：{run.changeSummary.refundedAfterLock.join('、') || '无'}
                </div>
              </div>
            </>
          )}
          <div className="modal-foot" style={{ paddingRight: 0 }}>
            {run.status === 'completed' && (
              isOwner
                ? <button className="primary" onClick={() => { const r = store.approveRun(run.runId, store.currentUserId); notify(r.ok ? 'success' : 'error', r.message); }}>执行审批修订核对</button>
                : <span className="muted small">审批与锁定限投放负责人（赵明）操作</span>
            )}
            {run.status === 'completed' && run.approval?.revisionMatched && isOwner && (
              <button className="primary" onClick={() => { const r = store.lockRun(run.runId); notify(r.ok ? 'success' : 'error', r.message); onClose(); }}>确认锁定</button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
