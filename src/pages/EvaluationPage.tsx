import { useMemo, useState } from 'react';
import EChart from '@/components/EChart';
import { EmptyState, KeyValue, Modal } from '@/components/ui';
import { SupportBadge, intervalText, pct, pp } from '@/components/evalUi';
import { formatCny, formatDateTime } from '@/lib/format';
import { CHART_COLORS, CHART_TEXT, baseTextStyle } from '@/lib/chart';
import { ALLOWED_USE_LABELS } from '@/types/evaluation';
import type {
  AllowedUse,
  ComparisonRecord,
  EvaluationResult,
  EvaluationRun,
  ModelRegistryEntry,
  SampleBuild,
  SampleDefinition,
  SegmentKey,
  SupplementBatch,
} from '@/types/evaluation';
import { SEGMENT_LABELS } from '@/types/evaluation';
import { useAppStore } from '@/store/useAppStore';
import type { EChartsOption } from 'echarts';

type Tab = 'registry' | 'sample' | 'run' | 'result' | 'drift';

const TABS: { key: Tab; label: string }[] = [
  { key: 'registry', label: '模型登记' },
  { key: 'sample', label: '评估样本' },
  { key: 'run', label: '评估运行' },
  { key: 'result', label: '评估结果与分群' },
  { key: 'drift', label: '漂移监测' },
];

export default function EvaluationPage() {
  const store = useAppStore();
  const [tab, setTab] = useState<Tab>('sample');
  const [activeEvalId, setActiveEvalId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const notify = (kind: 'success' | 'error' | 'info', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 5000);
  };

  const activeEval = store.evaluations.find((e) => e.evalId === activeEvalId) ?? store.evaluations[0] ?? null;

  return (
    <>
      <div className="notice warn">
        <div>
          <strong>适用边界：</strong>本页没有可观测的真实渠道贡献标签，<strong>不输出准确率、不发布因果效果、不自动调整投放</strong>。
          净收入守恒、份额稳定或某渠道金额上升，都不能当作模型准确率。稳定性按可验证的客户簇 / 订单簇重复抽样；缺少可靠跨设备关系时只按订单簇处理，禁止拼接身份。
        </div>
      </div>
      {toast && <div className={`notice ${toast.kind === 'error' ? 'error' : toast.kind === 'info' ? 'info' : 'success'}`}>{toast.text}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === 'registry' && <RegistryTab notify={notify} />}
      {tab === 'sample' && <SampleTab notify={notify} onStarted={(id) => { setActiveEvalId(id); setTab('run'); }} />}
      {tab === 'run' && <RunTab activeEval={activeEval} setActiveEvalId={setActiveEvalId} onShowResult={() => setTab('result')} onShowDrift={() => setTab('drift')} notify={notify} />}
      {tab === 'result' && <ResultTab activeEval={activeEval} setActiveEvalId={setActiveEvalId} notify={notify} />}
      {tab === 'drift' && <DriftTab activeEval={activeEval} setActiveEvalId={setActiveEvalId} />}
    </>
  );
}

// ---------------- 模型登记 ----------------

function RegistryTab({ notify }: { notify: (k: 'success' | 'error' | 'info', t: string) => void }) {
  const store = useAppStore();
  const isOwner = store.currentUserId === 'U-2001';
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ revision: '', ruleText: '', halfLife: 7, allowedUses: ['version_compare', 'drift_monitor', 'review_basis'] as AllowedUse[], note: '' });

  const startEdit = (entry: ModelRegistryEntry) => {
    setEditing(entry.registryId);
    setForm({ revision: '', ruleText: entry.revisions[entry.revisions.length - 1].ruleText, halfLife: entry.revisions[entry.revisions.length - 1].decayHalfLifeDays, allowedUses: ['version_compare', 'drift_monitor', 'review_basis'], note: '' });
  };

  const save = (entry: ModelRegistryEntry) => {
    const base = entry.revisions[entry.revisions.length - 1].baseModel;
    const r = store.addModelRevision({
      registryId: entry.registryId,
      revision: form.revision.trim(),
      baseModel: base,
      decayHalfLifeDays: form.halfLife,
      ruleText: form.ruleText,
      allowedUses: form.allowedUses,
      note: form.note,
      by: store.currentUserId,
    });
    notify(r.ok ? 'success' : 'error', r.message);
    if (r.ok) setEditing(null);
  };

  return (
    <div className="card">
      <div className="card-title">
        模型登记 <span className="hint">保存规则文本、基础模型、允许用途与修订；修订哈希进入审查与发布复核</span>
      </div>
      <table>
        <thead><tr><th>登记</th><th>当前修订</th><th>基础模型</th><th>规则</th><th>允许用途</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {store.modelRegistry.map((entry) => {
            const cur = entry.revisions.find((r) => r.revision === entry.currentRevision)!;
            return (
              <tr key={entry.registryId}>
                <td><span className="mono">{entry.registryId}</span><div className="small muted">{entry.name}</div></td>
                <td><span className="mono">{entry.currentRevision}</span><div className="small muted">{entry.revisions.length} 个修订</div></td>
                <td className="small">{cur.baseModel}{cur.baseModel === 'time_decay' ? `（半衰期 ${cur.decayHalfLifeDays}d）` : ''}</td>
                <td className="small" style={{ maxWidth: 280 }}>{cur.ruleText}</td>
                <td>
                  <div className="pill-row">
                    {cur.allowedUses.length === 0 && <span className="badge red">无允许用途</span>}
                    {cur.allowedUses.map((u) => <span key={u} className={`badge ${u === 'review_basis' ? 'purple' : u === 'drift_monitor' ? 'blue' : 'green'}`}>{ALLOWED_USE_LABELS[u]}</span>)}
                  </div>
                </td>
                <td>{entry.status === 'active' ? <span className="badge green">启用</span> : <span className="badge gray">已停用</span>}</td>
                <td>
                  <div className="pill-row">
                    <button className="sm" onClick={() => startEdit(entry)} disabled={!isOwner && store.currentUserId !== entry.createdBy}>登记新修订</button>
                    {entry.status === 'active' && (isOwner || store.currentUserId === entry.createdBy) && (
                      <button className="sm danger" onClick={() => { const r = store.retireModel(entry.registryId); notify(r.ok ? 'success' : 'error', r.message); }}>停用</button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing && (() => {
        const entry = store.modelRegistry.find((m) => m.registryId === editing)!;
        return (
          <div className="card tight" style={{ marginTop: 14, background: 'var(--surface-2)' }}>
            <div className="card-title">登记新修订 · {entry.name}</div>
            <div className="form-row">
              <label className="field">修订号 <input value={form.revision} onChange={(e) => setForm({ ...form, revision: e.target.value })} placeholder="如 v2" style={{ width: 120 }} /></label>
              <label className="field" style={{ flex: 1, minWidth: 260 }}>规则文本 <input value={form.ruleText} onChange={(e) => setForm({ ...form, ruleText: e.target.value })} style={{ width: '100%' }} /></label>
              <label className="field">半衰期 <input type="number" min={1} value={form.halfLife} onChange={(e) => setForm({ ...form, halfLife: Number(e.target.value) })} style={{ width: 100 }} /></label>
              <label className="field" style={{ minWidth: 300 }}>允许用途
                <div className="pill-row" style={{ paddingTop: 4 }}>
                  {(Object.keys(ALLOWED_USE_LABELS) as AllowedUse[]).map((u) => (
                    <label key={u} className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={form.allowedUses.includes(u)}
                        onChange={(e) => setForm({ ...form, allowedUses: e.target.checked ? [...form.allowedUses, u] : form.allowedUses.filter((x) => x !== u) })}
                      />
                      {ALLOWED_USE_LABELS[u]}
                    </label>
                  ))}
                </div>
              </label>
            </div>
            <div className="form-row" style={{ marginTop: 10 }}>
              <label className="field" style={{ flex: 1 }}>变更说明 <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ width: '100%' }} /></label>
              <button className="primary" onClick={() => save(entry)}>保存修订</button>
              <button onClick={() => setEditing(null)}>取消</button>
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>
              当前修订 {entry.currentRevision} 的哈希：<span className="mono">{entry.revisions.find((r) => r.revision === entry.currentRevision) && '见审查记录'}</span>。
              登记新修订后，旧引用（审查 / 评估）在批准或发布时将被复核并阻断，需要基于新修订重新评估。
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------------- 评估样本 ----------------

function SampleTab({ notify, onStarted }: { notify: (k: 'success' | 'error' | 'info', t: string) => void; onStarted: (evalId: string) => void }) {
  const store = useAppStore();
  const [sampleId, setSampleId] = useState(store.sampleDefinitions[0]?.sampleId ?? '');
  const [condition, setCondition] = useState<'as_defined' | 'refund_settled_before_cutoff' | 'observation_window_elapsed'>('as_defined');
  const [segmentKeys, setSegmentKeys] = useState<SegmentKey[]>(['region', 'deviceSegment']);
  const [modelA, setModelA] = useState('MDL-LAST-TOUCH');
  const [modelB, setModelB] = useState('MDL-FIRST-TOUCH');
  const [revA, setRevA] = useState('v1');
  const [revB, setRevB] = useState('v1');
  const [purpose, setPurpose] = useState<AllowedUse>('version_compare');
  const [iterations, setIterations] = useState(400);
  const [seed, setSeed] = useState(20261116);
  const [minClusters, setMinClusters] = useState(6);
  const [focusChannel, setFocusChannel] = useState('C-DISPLAY');
  const [compareSampleId, setCompareSampleId] = useState('');
  const [showImported, setShowImported] = useState(false);

  const def = store.sampleDefinitions.find((d) => d.sampleId === sampleId);
  const effectiveDef = useMemo<SampleDefinition | undefined>(() => {
    if (!def) return undefined;
    return { ...def, maturityCondition: condition === 'as_defined' ? def.maturityCondition : condition, segmentKeys };
  }, [def, condition, segmentKeys]);

  const preview = useMemo(() => (effectiveDef ? store.previewSample(effectiveDef) : null), [effectiveDef, store]);

  const start = () => {
    if (!def) return;
    const r = store.startEvaluationRun({
      config: {
        sampleId: def.sampleId,
        modelA: { registryId: modelA, revision: revA },
        modelB: { registryId: modelB, revision: revB },
        segmentKeys,
        bootstrapIterations: iterations,
        seed,
        minClusters,
        focusChannelId: focusChannel || undefined,
      },
      purpose,
      minClusters,
      by: store.currentUserId,
      sampleBId: compareSampleId || undefined,
    });
    notify(r.ok ? 'success' : 'error', r.message);
    if (r.ok && r.evalId) onStarted(r.evalId);
  };

  return (
    <>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">① 选择样本与成熟条件 <span className="hint">固定订单、授权触点、退款观察截止点与成熟条件</span></div>
          <div className="form-row">
            <label className="field" style={{ flex: 1, minWidth: 300 }}>评估样本
              <select value={sampleId} onChange={(e) => { setSampleId(e.target.value); }} style={{ width: '100%' }}>
                {store.sampleDefinitions.map((d) => (
                  <option key={d.sampleId} value={d.sampleId}>{d.sampleId} · rev{d.revision} · {d.window === 'mature' ? '成熟' : '近期'}</option>
                ))}
              </select>
            </label>
            <label className="field">成熟条件
              <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)}>
                <option value="as_defined">按样本定义（{def ? (def.maturityCondition === 'refund_settled_before_cutoff' ? '退款已入账' : '观察期已满') : '—'}）</option>
                <option value="refund_settled_before_cutoff">退款已入账且早于截止点</option>
                <option value="observation_window_elapsed">订单观察期已满</option>
              </select>
            </label>
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="field" style={{ minWidth: 220 }}>分群
              <div className="pill-row" style={{ paddingTop: 4 }}>
                {(Object.keys(SEGMENT_LABELS) as SegmentKey[]).map((k) => (
                  <label key={k} className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" checked={segmentKeys.includes(k)} onChange={(e) => setSegmentKeys(e.target.checked ? [...segmentKeys, k] : segmentKeys.filter((x) => x !== k))} />
                    {SEGMENT_LABELS[k]}
                  </label>
                ))}
              </div>
            </label>
            <label className="field">对照样本（同模型换样本，可选）
              <select value={compareSampleId} onChange={(e) => setCompareSampleId(e.target.value)}>
                <option value="">不比较</option>
                {store.sampleDefinitions.filter((d) => d.window === 'mature' && d.sampleId !== sampleId).map((d) => (
                  <option key={d.sampleId} value={d.sampleId}>{d.sampleId}</option>
                ))}
              </select>
            </label>
          </div>
          {def && (
            <div className="small muted" style={{ marginTop: 8 }}>
              窗口 {def.windowStart.slice(0, 10)} ~ {def.windowEnd.slice(0, 10)} · 退款截止 {def.refundCutoff.slice(0, 10)} · 观察 {def.observeDays} 天 · 归因窗口 {def.attributionWindowDays} 天 · 快照 {def.baseSnapshotId}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">② 选择模型与评估参数 <span className="hint">在同一份样本上成对运行两个模型</span></div>
          <div className="form-row">
            <ModelSelect label="模型 A（基准）" registryId={modelA} revision={revA} onChange={(id, rev) => { setModelA(id); setRevA(rev); }} />
            <ModelSelect label="模型 B（对照）" registryId={modelB} revision={revB} onChange={(id, rev) => { setModelB(id); setRevB(rev); }} />
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="field">评估用途
              <select value={purpose} onChange={(e) => setPurpose(e.target.value as AllowedUse)}>
                <option value="version_compare">版本比较（成熟共同样本）</option>
                <option value="drift_monitor">漂移监测（近期窗口）</option>
              </select>
            </label>
            <label className="field">重复抽样次数 <input type="number" min={50} max={2000} value={iterations} onChange={(e) => setIterations(Number(e.target.value))} style={{ width: 110 }} /></label>
            <label className="field">随机种子 <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} style={{ width: 140 }} /></label>
            <label className="field">最小簇数 <input type="number" min={1} value={minClusters} onChange={(e) => setMinClusters(Number(e.target.value))} style={{ width: 100 }} /></label>
            <label className="field">重点渠道
              <select value={focusChannel} onChange={(e) => setFocusChannel(e.target.value)}>
                <option value="">不指定</option>
                {preview?.channelCoverage.map((c) => <option key={c.channelId} value={c.channelId}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <div className="pill-row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={start}>启动评估（显示进度、可取消）</button>
            <button onClick={() => setShowImported(true)}>导入补充样例</button>
            {def && (
              <button onClick={() => {
                const r = store.refreshSampleRefunds(def.sampleId, store.currentUserId);
                notify(r.ok ? 'success' : 'error', r.message);
                if (r.ok) setSampleId(`${def.sampleId}-R${r.newRevision}`);
              }}>退款补齐生成新样本修订</button>
            )}
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            长计算会分片推进进度；切换样本后，旧任务结果不会覆盖新结果。样本量不足、渠道从未覆盖或区间无法确定时显示「不支持结论」，不会填零分。
          </div>
        </div>
      </div>

      {preview && <SamplePreview build={preview} />}

      {showImported && <SupplementModal onClose={() => setShowImported(false)} notify={notify} />}
    </>
  );
}

function ModelSelect({ label, registryId, revision, onChange }: { label: string; registryId: string; revision: string; onChange: (id: string, rev: string) => void }) {
  const store = useAppStore();
  const entries = store.modelRegistry.filter((m) => m.status === 'active');
  const entry = entries.find((m) => m.registryId === registryId);
  return (
    <label className="field" style={{ minWidth: 260 }}>{label}
      <div className="pill-row" style={{ alignItems: 'center' }}>
        <select value={registryId} onChange={(e) => { const next = entries.find((m) => m.registryId === e.target.value); onChange(e.target.value, next?.currentRevision ?? 'v1'); }} style={{ flex: 1 }}>
          {entries.map((m) => <option key={m.registryId} value={m.registryId}>{m.name}</option>)}
        </select>
        <select value={revision} onChange={(e) => onChange(registryId, e.target.value)} style={{ width: 90 }}>
          {(entry?.revisions ?? []).map((r) => <option key={r.revision} value={r.revision}>{r.revision}</option>)}
        </select>
      </div>
    </label>
  );
}

function SamplePreview({ build }: { build: SampleBuild }) {
  const [showRows, setShowRows] = useState(false);
  return (
    <div className="card">
      <div className="card-title">
        ③ 纳入 / 排除预览 <span className="hint">样本哈希 <span className="mono">{build.sampleHash}</span></span>
      </div>
      <div className="grid cols-4">
        <div className="stat"><div className="label">纳入订单</div><div className="value">{build.orderCount}</div><div className="sub">{build.clusterCount} 簇（{build.customerClusterCount} 客户 / {build.orderClusterCount} 订单）</div></div>
        <div className="stat"><div className="label">纳入净收入</div><div className="value">{formatCny(build.totalNet)}</div><div className="sub">退款扣减 {formatCny(build.totalRefunded)}</div></div>
        <div className="stat alert"><div className="label">排除订单</div><div className="value">{build.excludedOrders.length}</div><div className="sub">未成熟退款 {build.immatureOrderIds.length} 单</div></div>
        <div className="stat unknown"><div className="label">未成熟退款</div><div className="value">{build.pendingRefundIds.length}</div><div className="sub">等待观察完成</div></div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14, alignItems: 'start' }}>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>渠道覆盖与触点</div>
          <table>
            <thead><tr><th>渠道</th><th className="num">覆盖订单</th><th className="num">触点数</th><th>覆盖</th></tr></thead>
            <tbody>
              {build.channelCoverage.map((c) => (
                <tr key={c.channelId}>
                  <td>{c.name}<div className="small muted mono">{c.channelId}</div></td>
                  <td className="num">{c.orders}</td>
                  <td className="num">{c.touchpoints}</td>
                  <td>{c.covered ? <span className="badge green">已覆盖</span> : <span className="badge gray">从未覆盖 · 不支持结论</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>分群构成（按净额权重）</div>
          {(['region', 'deviceSegment'] as SegmentKey[]).map((k) => (
            <div key={k} style={{ marginBottom: 10 }}>
              <div className="small muted">{SEGMENT_LABELS[k]}</div>
              <div className="pill-row">
                {build.segmentWeights[k].map((w) => (
                  <span key={w.value} className="badge blue">{w.value} · {w.orders}单 · {pct(w.weight)}</span>
                ))}
              </div>
            </div>
          ))}
          {build.limitations.length > 0 && (
            <div className="notice warn" style={{ marginTop: 6, marginBottom: 0 }}>
              <ul style={{ margin: '2px 0 0 16px', padding: 0 }}>{build.limitations.map((l, i) => <li key={i} className="small">{l}</li>)}</ul>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <button className="sm" onClick={() => setShowRows((v) => !v)}>{showRows ? '收起' : '展开'}纳入与排除明细</button>
        {showRows && (
          <div style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>订单</th><th>簇</th><th>区域/设备</th><th className="num">净额</th><th className="num">合格触点</th><th>状态</th></tr></thead>
              <tbody>
                {build.rows.map((r) => (
                  <tr key={r.orderId}>
                    <td className="mono">{r.orderId}</td>
                    <td className="small">{r.clusterId}{r.clusterNote && <div className="small muted">⚠ {r.clusterNote}</div>}</td>
                    <td className="small">{r.region} / {r.deviceSegment}</td>
                    <td className="num">{formatCny(r.netAmount)}</td>
                    <td className="num">{r.eligibleTouchpointIds.length}</td>
                    <td className="small">{r.unknownReason ? <span className="badge purple">未知来源 · {r.unknownReason}</span> : r.overRefunded ? <span className="badge red">退款超毛额</span> : <span className="badge green">已纳入</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small" style={{ fontWeight: 600, margin: '10px 0 6px' }}>排除订单与原因</div>
            <table>
              <thead><tr><th>订单</th><th>原因</th><th className="num">未纳入净额</th></tr></thead>
              <tbody>
                {build.excludedOrders.map((e) => (
                  <tr key={e.orderId}>
                    <td className="mono">{e.orderId}</td>
                    <td className="small"><span className={`badge ${e.kind === 'immature_refund' ? 'orange' : 'gray'}`}>{e.kind}</span> {e.reason}</td>
                    <td className="num">{formatCny(e.netAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SupplementModal({ onClose, notify }: { onClose: () => void; notify: (k: 'success' | 'error' | 'info', t: string) => void }) {
  const store = useAppStore();
  const [json, setJson] = useState('');
  const [batch, setBatch] = useState<SupplementBatch | null>(null);

  const imports = () => {
    store.loadBuiltinSupplement('refund', store.currentUserId);
    notify('success', '已导入内置「迟到退款」补充批次 SUP-REFUND-1010；可在「评估样本」刷新退款生成新样本修订');
  };

  const parse = () => {
    try {
      const parsed = JSON.parse(json) as Partial<SupplementBatch>;
      const candidate: SupplementBatch = {
        batchId: parsed.batchId ?? `SUP-${Date.now().toString(36)}`,
        label: parsed.label ?? '用户导入批次',
        importedAt: new Date().toISOString(),
        importedBy: store.currentUserId,
        note: parsed.note ?? '',
        channels: parsed.channels ?? [],
        orders: parsed.orders ?? [],
        touchpoints: parsed.touchpoints ?? [],
        refunds: parsed.refunds ?? [],
        validation: { ok: true, issues: [] },
      };
      const v = store.validateSupplement(candidate);
      setBatch({ ...candidate, validation: v });
    } catch (e) {
      notify('error', `JSON 解析失败：${(e as Error).message}`);
    }
  };

  const confirm = () => {
    if (!batch) return;
    const r = store.importSupplement(batch);
    notify(r.ok ? 'success' : 'error', r.message);
    if (r.ok) onClose();
  };

  return (
    <Modal open title="导入补充样例（订单 / 触点 / 退款）" onClose={onClose}>
      <div className="notice info small">补充样例与基础快照分开保存；导入后需刷新评估样本（修订 +1），旧审查保留原结果。</div>
      <div className="pill-row" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={imports}>导入内置迟到退款补充</button>
        <button onClick={() => { store.loadBuiltinSupplement('order', store.currentUserId); notify('success', '已导入内置订单补充 SUP-ORDER-2301'); }}>导入内置订单补充</button>
      </div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>或粘贴 JSON（字段：orders / touchpoints / refunds）</div>
      <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={8} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} placeholder='{"orders":[...],"touchpoints":[...],"refunds":[...]}' />
      <div className="pill-row" style={{ marginTop: 10 }}>
        <button onClick={parse}>解析并校验</button>
        <button className="primary" disabled={!batch} onClick={confirm}>确认导入</button>
      </div>
      {batch && (
        <div className="card tight" style={{ marginTop: 10 }}>
          <div className="small">
            批次 <span className="mono">{batch.batchId}</span>：订单 {batch.orders.length}、触点 {batch.touchpoints.length}、退款 {batch.refunds.length}；
            校验 {batch.validation.ok ? <span className="badge green">通过</span> : <span className="badge orange">{batch.validation.issues.length} 条提示</span>}
          </div>
          {batch.validation.issues.length > 0 && (
            <ul className="small muted" style={{ margin: '6px 0 0 16px' }}>{batch.validation.issues.map((i, k) => <li key={k}>{i}</li>)}</ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------- 评估运行 ----------------

function RunTab({ activeEval, setActiveEvalId, onShowResult, onShowDrift, notify }: {
  activeEval: EvaluationRun | null;
  setActiveEvalId: (id: string) => void;
  onShowResult: () => void;
  onShowDrift: () => void;
  notify: (k: 'success' | 'error' | 'info', t: string) => void;
}) {
  const store = useAppStore();

  return (
    <>
      <div className="card">
        <div className="card-title">评估运行列表 <span className="hint">长计算显示进度并可取消；切换样本后旧任务不得覆盖新结果</span></div>
        {store.evaluations.length === 0 ? <EmptyState text="暂无评估运行，请在「评估样本」页启动评估" /> : (
          <table>
            <thead><tr><th>评估</th><th>样本</th><th>模型 A → B</th><th className="num">进度</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {store.evaluations.map((e) => (
                <tr key={e.evalId} className={activeEval?.evalId === e.evalId ? 'active-row' : ''}>
                  <td><span className="mono clickable" onClick={() => setActiveEvalId(e.evalId)}>{e.evalId}</span><div className="small muted">{formatDateTime(e.createdAt)}</div></td>
                  <td className="small"><span className="mono">{e.sampleId}</span><div className="muted">rev{e.sampleRevision} · {e.sampleHash.slice(0, 8)}</div></td>
                  <td className="small">{e.modelARef.name}@{e.modelARef.revision} → {e.modelBRef.name}@{e.modelBRef.revision}</td>
                  <td className="num">{e.progress}%</td>
                  <td>
                    {e.status === 'running' ? <span className="badge blue"><span className="loading" />计算中</span>
                      : e.status === 'completed' ? <span className="badge green">已完成</span>
                      : <span className="badge gray">已取消</span>}
                  </td>
                  <td>
                    <div className="pill-row">
                      {e.status === 'running' && <button className="sm danger" onClick={() => { store.cancelEvaluation(e.evalId); notify('info', `已取消评估 ${e.evalId}；之后到达的结果将被丢弃`); }}>取消</button>}
                      {e.status === 'completed' && <button className="sm" onClick={() => { setActiveEvalId(e.evalId); onShowResult(); }}>查看结果</button>}
                      {e.status === 'completed' && e.drift && <button className="sm" onClick={() => { setActiveEvalId(e.evalId); onShowDrift(); }}>漂移报告</button>}
                      {e.status !== 'running' && <button className="sm danger" onClick={() => store.removeEvaluation(e.evalId)}>移除</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {activeEval?.status === 'running' && (
        <div className="card">
          <div className="card-title">运行进度 <span className="mono">{activeEval.evalId}</span></div>
          <div style={{ height: 10, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${activeEval.progress}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.2s' }} />
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>{activeEval.progress}% · 正在按簇重复抽样并成对运行两个模型…</div>
          <button className="danger sm" style={{ marginTop: 10 }} onClick={() => { store.cancelEvaluation(activeEval.evalId); notify('info', '已取消'); }}>取消任务</button>
        </div>
      )}

      {activeEval?.status === 'cancelled' && (
        <div className="notice warn">评估 {activeEval.evalId} 已取消；即使后台结果晚到也不会写入（切换样本后的旧任务同样被丢弃）。</div>
      )}
    </>
  );
}

// ---------------- 评估结果与分群 ----------------

function ResultTab({ activeEval, setActiveEvalId, notify }: { activeEval: EvaluationRun | null; setActiveEvalId: (id: string) => void; notify: (k: 'success' | 'error' | 'info', t: string) => void }) {
  const result = activeEval?.result;
  const [segmentKey, setSegmentKey] = useState<SegmentKey>('region');
  const [comparisonKind, setComparisonKind] = useState<ComparisonRecord['kind']>('model_swap');
  const [reviewOpen, setReviewOpen] = useState(false);

  const store = useAppStore();
  const comparison = result ? activeEval?.comparisons.find((c) => c.kind === comparisonKind) : undefined;

  if (!result) {
    return (
      <div className="card">
        <div className="card-title">评估结果</div>
        <EmptyState text={activeEval ? '当前评估尚未完成，请在「评估运行」查看进度' : '请先在「评估样本」页启动评估'} />
        {store.evaluations.filter((e) => e.status === 'completed').length > 0 && (
          <div className="small muted" style={{ textAlign: 'center' }}>已有完成评估，可在上方列表选择。</div>
        )}
      </div>
    );
  }

  const shareOption = shareChartOption(result);
  const stabilityOption = stabilityChartOption(result);

  return (
    <>
      <div className="card">
        <div className="form-row">
          <label className="field">查看评估
            <select value={activeEval!.evalId} onChange={(e) => setActiveEvalId(e.target.value)} style={{ minWidth: 320 }}>
              {store.evaluations.filter((e) => e.status === 'completed' && e.result).map((e) => (
                <option key={e.evalId} value={e.evalId}>{e.evalId} · {e.sampleId} · {e.modelARef.name}→{e.modelBRef.name}</option>
              ))}
            </select>
          </label>
          <div style={{ alignSelf: 'flex-end' }} className="small muted">
            样本哈希 <span className="mono">{result.sampleHash.slice(0, 12)}</span> · 样本修订 rev{result.sampleRevision} · 分群 {result.config.segmentKeys.join('、')}
          </div>
        </div>
        <div className="notice info" style={{ marginTop: 10, marginBottom: 0 }}>
          <div className="small">{result.disclaimers.join(' ')}</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <ModelCard title={`模型 A · ${result.modelA.model.name}@${result.modelA.model.revision}`} evaluation={result.modelA} />
        <ModelCard title={`模型 B · ${result.modelB.model.name}@${result.modelB.model.revision}`} evaluation={result.modelB} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">渠道份额 A vs B <span className="hint">份额仅表示分摊比例</span></div>
          <EChart option={shareOption} className="chart-box short" />
        </div>
        <div className="card">
          <div className="card-title">稳定性：成对差异区间 <span className="hint">同抽样上成对运行；区间不代表准确率</span></div>
          <EChart option={stabilityOption} className="chart-box short" />
        </div>
      </div>

      <div className="card">
        <div className="card-title">稳定性差异区间明细 <span className="hint">簇重复抽样 · {result.stability.clusterCount} 簇 · {result.stability.iterations} 次 · 种子 {result.stability.seed}</span></div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          {result.stability.clusterKind === 'customer' ? '客户簇' : result.stability.clusterKind === 'order' ? '订单簇' : '混合簇'}；
          簇内订单与同批退款整体保留。{result.stability.fallbackOrderClusters > 0 && `其中 ${result.stability.fallbackOrderClusters} 个订单簇缺少跨设备授权，区间可能偏窄。`}
        </div>
        <table>
          <thead><tr><th>指标</th><th className="num">点估计（B−A）</th><th>95% 区间</th><th className="num">重复</th><th>结论</th></tr></thead>
          <tbody>
            {result.stability.diffs.map((d, i) => (
              <tr key={i}>
                <td className="small">{d.label}</td>
                <td className="num">{d.metric === 'channel_share' ? pp(d.pointEstimate) : formatCny(d.pointEstimate)}</td>
                <td className="small">{intervalText(d.lower, d.upper, d.metric === 'channel_share' ? (n) => pp(n) : formatCny)}</td>
                <td className="num">{d.replications}</td>
                <td><SupportBadge state={d.support} reason={d.supportReason} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.stability.limitations.length > 0 && (
          <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
            <ul style={{ margin: '2px 0 0 16px', padding: 0 }}>{result.stability.limitations.map((l, i) => <li key={i} className="small">{l}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">分群下钻 <span className="hint">按区域 / 设备群分解；总体与局部方向相反时单独标注</span></div>
        <div className="pill-row" style={{ marginBottom: 10 }}>
          {(Object.keys(SEGMENT_LABELS) as SegmentKey[]).filter((k) => result.segments[k]).map((k) => (
            <button key={k} className={segmentKey === k ? 'primary' : ''} onClick={() => setSegmentKey(k)}>{SEGMENT_LABELS[k]}</button>
          ))}
        </div>
        <SegmentTable result={result} segmentKey={segmentKey} />
      </div>

      {result.segments[segmentKey]?.divergences.length > 0 && (
        <div className="card" style={{ borderColor: '#ffd591', background: '#fffdf7' }}>
          <div className="card-title">⚠ 总体与局部方向相反 <span className="hint">不能以总均值改善掩盖某群退化</span></div>
          <table>
            <thead><tr><th>分群</th><th>渠道</th><th className="num">总体 Δ</th><th className="num">该群 Δ</th><th>说明</th></tr></thead>
            <tbody>
              {result.segments[segmentKey].divergences.map((d, i) => (
                <tr key={i}>
                  <td>{d.value}</td>
                  <td>{d.channelName}</td>
                  <td className="num">{pp(d.overallDelta)}</td>
                  <td className="num" style={{ color: 'var(--danger)' }}>{pp(d.segmentDelta)}</td>
                  <td className="small">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-title">版本对照 <span className="hint">同样本换模型 / 同模型换样本 / 只更新退款</span></div>
        {activeEval!.comparisons.length === 0 ? (
          <div className="empty">本次评估没有可用的对照（需要同样本双模型、对照样本或退款补齐派生样本）</div>
        ) : (
          <>
            <div className="pill-row" style={{ marginBottom: 10 }}>
              {(['model_swap', 'sample_swap', 'refund_update'] as const).map((k) => (
                <button key={k} className={comparisonKind === k ? 'primary' : ''} disabled={!activeEval!.comparisons.some((c) => c.kind === k)} onClick={() => setComparisonKind(k)}>
                  {k === 'model_swap' ? '同样本换模型' : k === 'sample_swap' ? '同模型换样本' : '只更新退款'}
                </button>
              ))}
            </div>
            {comparison ? <ComparisonView comparison={comparison} result={result} /> : <div className="empty">该对照类型不可用</div>}
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">审查依据 <span className="hint">引用确定的模型修订与样本哈希；批准/发布前复核</span></div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          生成的审查记录会固定当前评估的模型修订哈希与样本哈希。若之后模型登记了新修订或样本因退款补齐而更新，批准或发布会被阻断。
        </div>
        <div className="pill-row">
          <button className="primary" onClick={() => setReviewOpen(true)}>生成审查记录</button>
          <button onClick={() => notify('info', '已复制样本哈希，可粘贴到审查说明')} onClickCapture={() => void navigator.clipboard?.writeText(result.sampleHash).catch(() => {})}>复制样本哈希</button>
        </div>
      </div>

      <ReviewCreateModal open={reviewOpen} onClose={() => setReviewOpen(false)} evaluation={activeEval!} notify={notify} />
    </>
  );
}

function ModelCard({ title, evaluation }: { title: string; evaluation: EvaluationResult['modelA'] }) {
  return (
    <div className="card tight">
      <div className="card-title">{title}</div>
      <KeyValue rows={[
        ['逐单守恒', evaluation.conservation.ok ? <span className="badge green">通过（{evaluation.conservation.perOrderChecked} 单核对）</span> : <span className="badge red">{evaluation.conservation.violations.join('；')}</span>],
        ['已分配 / 未知 / 净收入', `${formatCny(evaluation.totalAttributed)} / ${formatCny(evaluation.unknownAmount)} / ${formatCny(evaluation.totalNet)}`],
        ['退款后负额', evaluation.negativeAllocations.length ? <span className="badge red">{evaluation.negativeAllocations.length} 条</span> : <span className="badge green">无（净额按 0 截断）</span>],
        ['退款超毛额', evaluation.overRefund.length ? `${evaluation.overRefund.map((o) => `${o.orderId} 超 ${formatCny(o.excess)}`).join('；')}` : '无'],
        ['有效触点覆盖', `${pct(evaluation.coverage.ratio)}（${evaluation.coverage.ordersWithEligible}/${evaluation.coverage.orderCount} 单，均 ${evaluation.coverage.avgTouchpointsPerOrder.toFixed(1)} 触点）`],
      ]} />
      <div className="small muted" style={{ marginTop: 6 }}>未知来源构成：有人员无触点 {evaluation.unknown.byReason.no_touchpoint.orders.length} 单 / 无授权触点 {evaluation.unknown.byReason.all_touchpoints_excluded.orders.length} 单 / 无人员标识 {evaluation.unknown.byReason.no_person.orders.length} 单。</div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>渠道</th><th className="num">金额</th><th className="num">份额</th><th>结论</th></tr></thead>
        <tbody>
          {evaluation.channelShares.map((c) => (
            <tr key={c.channelId}>
              <td>{c.name}</td>
              <td className="num">{formatCny(c.amount)}</td>
              <td className="num">{c.covered ? pct(c.share) : '—'}</td>
              <td><SupportBadge state={c.support} reason={c.supportReason} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SegmentTable({ result, segmentKey }: { result: EvaluationResult; segmentKey: SegmentKey }) {
  const analysis = result.segments[segmentKey];
  if (!analysis) return <div className="empty">未选择该分群</div>;
  return (
    <table>
      <thead>
        <tr><th>{SEGMENT_LABELS[segmentKey]}</th><th className="num">订单</th><th className="num">净额</th><th className="num">权重</th><th>渠道</th><th className="num">A 份额</th><th className="num">B 份额</th><th className="num">Δ</th><th>结论</th></tr>
      </thead>
      <tbody>
        {analysis.cells.map((cell) => (
          cell.channels.length === 0 ? (
            <tr key={cell.value}>
              <td>{cell.value}</td>
              <td className="num">{cell.orders}</td>
              <td className="num">{formatCny(cell.netAmount)}</td>
              <td className="num">{pct(cell.weight)}</td>
              <td colSpan={4} className="small muted">该群没有已覆盖渠道</td>
              <td><SupportBadge state={cell.support} reason={cell.supportReason} /></td>
            </tr>
          ) : cell.channels.map((ch, i) => (
            <tr key={`${cell.value}-${ch.channelId}`}>
              {i === 0 && (
                <>
                  <td rowSpan={cell.channels.length}>{cell.value}<div className="small muted">{pct(cell.coverageRatioA)} 覆盖</div></td>
                  <td rowSpan={cell.channels.length} className="num">{cell.orders}</td>
                  <td rowSpan={cell.channels.length} className="num">{formatCny(cell.netAmount)}</td>
                  <td rowSpan={cell.channels.length} className="num">{pct(cell.weight)}</td>
                </>
              )}
              <td className="small">{ch.name}</td>
              <td className="num">{ch.shareA === null ? '—' : pct(ch.shareA)}</td>
              <td className="num">{ch.shareB === null ? '—' : pct(ch.shareB)}</td>
              <td className="num" style={{ color: ch.delta !== null && ch.delta < 0 ? 'var(--danger)' : undefined }}>{ch.delta === null ? '—' : pp(ch.delta)}</td>
              <td><SupportBadge state={ch.support} reason={ch.supportReason} /></td>
            </tr>
          ))
        ))}
      </tbody>
    </table>
  );
}

function ComparisonView({ comparison, result }: { comparison: ComparisonRecord; result: EvaluationResult }) {
  const focus = comparison.focusChannelId;
  return (
    <>
      <div className="grid cols-3">
        <div className="stat"><div className="label">隔离因素</div><div className="value" style={{ fontSize: 16 }}>{comparison.isolatedFactor === 'model' ? '模型规则' : comparison.isolatedFactor === 'sample' ? '样本输入' : '退款补齐'}</div><div className="sub">{comparison.label}</div></div>
        <div className="stat"><div className="label">净收入差异（alt−base）</div><div className="value">{formatCny(comparison.netDelta)}</div><div className="sub">已分配差异 {formatCny(comparison.attributedDelta)}</div></div>
        <div className="stat"><div className="label">变化订单</div><div className="value">{comparison.changedOrderCount}</div><div className="sub">共 {comparison.orderDiffs.length} 单参与对照</div></div>
      </div>
      <div className="small muted" style={{ margin: '10px 0' }}>
        base：{comparison.base.modelLabel} · {comparison.base.sampleId}@rev{comparison.base.sampleRevision}（{comparison.base.sampleHash.slice(0, 8)}）→ alt：{comparison.alt.modelLabel} · {comparison.alt.sampleId}@rev{comparison.alt.sampleRevision}（{comparison.alt.sampleHash.slice(0, 8)}）。
        守恒 A {comparison.base.conservationOk ? '✓' : '✕'} / B {comparison.alt.conservationOk ? '✓' : '✕'}。{comparison.supportReason}
      </div>

      {(['region', 'deviceSegment'] as SegmentKey[]).filter((k) => comparison.composition[k]).map((k) => {
        const comp = comparison.composition[k];
        return (
          <div key={k} className="card tight" style={{ marginBottom: 10 }}>
            <div className="card-title">构成变化 · {SEGMENT_LABELS[k]} <span className="hint">先共同权重比较，再单列新增/缺失群</span></div>
            <div className="small">
              共同分群权重：{comp.commonValues.length ? comp.commonValues.map((v) => `${v} ${pct(comp.commonWeights[v])}`).join(' · ') : '无'}；
              新增群：{comp.addedValues.join('、') || '无'}；缺失群：{comp.missingValues.join('、') || '无'}。
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              共同权重加权 {focus ? result.modelA.channelShares.find((c) => c.channelId === focus)?.name : '重点渠道'} 份额：A {pct(comp.commonWeightedBase)} → B {pct(comp.commonWeightedAlt)}（Δ {pp(comp.commonWeightedDelta)}）
            </div>
            {comp.divergence.length > 0 && (
              <div className="notice warn" style={{ marginTop: 8, marginBottom: 0 }}>
                局部方向与总体相反：{comp.divergence.map((d) => `${d.value}（该群 ${pp(d.segmentDelta)}）`).join('、')}。不能以总均值掩盖。
              </div>
            )}
          </div>
        );
      })}

      <div className="small" style={{ fontWeight: 600, margin: '8px 0 6px' }}>订单级差异（只列变化订单）</div>
      <table>
        <thead><tr><th>订单</th><th>类型</th><th className="num">净额 Δ</th><th className="num">分摊 Δ</th><th>渠道差异</th></tr></thead>
        <tbody>
          {comparison.orderDiffs.filter((d) => d.changeKind !== 'none').slice(0, 40).map((d) => (
            <tr key={d.orderId}>
              <td className="mono">{d.orderId}</td>
              <td className="small"><span className={`badge ${d.changeKind === 'model_only' ? 'blue' : d.changeKind === 'net_only' ? 'orange' : 'purple'}`}>{d.changeKind}</span></td>
              <td className="num">{formatCny(d.netDelta)}</td>
              <td className="num">{formatCny(d.allocationDelta)}</td>
              <td className="small">{d.channelDeltas.filter((c) => c.delta !== 0).map((c) => `${c.name} ${c.delta > 0 ? '+' : ''}${formatCny(c.delta)}`).join('；') || '—'}</td>
            </tr>
          ))}
          {comparison.orderDiffs.every((d) => d.changeKind === 'none') && <tr><td colSpan={5} className="empty">两侧结果完全一致（同一模型、同一样本）</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function ReviewCreateModal({ open, onClose, evaluation, notify }: { open: boolean; onClose: () => void; evaluation: EvaluationRun; notify: (k: 'success' | 'error' | 'info', t: string) => void }) {
  const store = useAppStore();
  const [title, setTitle] = useState(`${evaluation.sampleId} 模型评估审查`);
  if (!open) return null;
  const def = store.sampleDefinitions.find((d) => d.sampleId === evaluation.sampleId);
  return (
    <Modal open title="生成审查记录（引用确定的模型与样本）" onClose={onClose}>
      {def?.window === 'recent' && <div className="notice warn">近期窗口样本仅用于漂移监测，不能作为审查依据。</div>}
      <label className="field">审查标题 <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} /></label>
      <div className="card tight" style={{ marginTop: 10 }}>
        <KeyValue rows={[
          ['评估', <span className="mono">{evaluation.evalId}</span>],
          ['样本', `${evaluation.sampleId}@rev${evaluation.sampleRevision}`],
          ['样本哈希', <span className="mono">{evaluation.sampleHash}</span>],
          ['模型 A', `${evaluation.modelARef.name}@${evaluation.modelARef.revision} · ${evaluation.modelARef.revisionHash}`],
          ['模型 B', `${evaluation.modelBRef.name}@${evaluation.modelBRef.revision} · ${evaluation.modelBRef.revisionHash}`],
        ]} />
      </div>
      <div className="modal-foot">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => {
          const r = store.createReview({ evalId: evaluation.evalId, title, by: store.currentUserId });
          notify(r.ok ? 'success' : 'error', r.message);
          if (r.ok) onClose();
        }}>生成审查记录</button>
      </div>
    </Modal>
  );
}

// ---------------- 漂移监测 ----------------

function DriftTab({ activeEval, setActiveEvalId }: { activeEval: EvaluationRun | null; setActiveEvalId: (id: string) => void }) {
  const store = useAppStore();
  const driftEvals = store.evaluations.filter((e) => e.status === 'completed' && e.drift);
  const current = activeEval?.drift ? activeEval : driftEvals[0] ?? null;
  const drift = current?.drift;

  return (
    <>
      <div className="notice info">
        <div>
          <strong>两个窗口不混成同一排行榜：</strong>成熟共同样本用于版本比较；近期窗口另做漂移监测，更早发现近期退化，但承担标签尚未成熟和人群构成变化的不确定性。
        </div>
      </div>
      <div className="card">
        <div className="form-row">
          <label className="field">漂移评估
            <select value={current?.evalId ?? ''} onChange={(e) => setActiveEvalId(e.target.value)} style={{ minWidth: 380 }}>
              {driftEvals.length === 0 && <option value="">暂无漂移报告（在近期窗口样本上以「漂移监测」用途运行评估）</option>}
              {driftEvals.map((e) => <option key={e.evalId} value={e.evalId}>{e.evalId} · {e.sampleId} · {e.modelARef.name}→{e.modelBRef.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {!drift ? (
        <div className="card"><EmptyState text="暂无漂移报告" /></div>
      ) : (
        <>
          <div className="card">
            <div className="card-title">成熟 vs 近期 份额漂移 <span className="hint">模型 {drift.modelLabel} · 两窗口独立</span></div>
            <table>
              <thead><tr><th>渠道</th><th className="num">成熟份额</th><th className="num">近期份额</th><th className="num">漂移 Δ</th><th className="num">近期覆盖</th><th>结论</th></tr></thead>
              <tbody>
                {drift.rows.map((r) => (
                  <tr key={r.channelId}>
                    <td>{r.name}</td>
                    <td className="num">{r.matureShare === null ? '—' : pct(r.matureShare)}</td>
                    <td className="num">{r.recentShare === null ? '—' : pct(r.recentShare)}</td>
                    <td className="num" style={{ color: r.delta !== null && r.delta < 0 ? 'var(--danger)' : undefined }}>{r.delta === null ? '—' : pp(r.delta)}</td>
                    <td className="num">{pct(r.recentCoverage)}</td>
                    <td><SupportBadge state={r.support} reason={r.supportReason} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small muted" style={{ marginTop: 8 }}>
              近期窗口未成熟订单：{drift.immatureRecentOrderIds.join('、') || '无'}。这些订单因退款晚于观察截止点被排除，需等待退款观察完成。
            </div>
          </div>

          {(['region', 'deviceSegment'] as SegmentKey[]).filter((k) => drift.composition[k]).map((k) => {
            const comp = drift.composition[k];
            return (
              <div key={k} className="card">
                <div className="card-title">构成变化 · {SEGMENT_LABELS[k]} <span className="hint">新增/缺失群单独展示，不与共同权重混算</span></div>
                <div className="pill-row">
                  <span className="badge blue">共同群：{comp.commonValues.join('、') || '无'}</span>
                  <span className="badge green">新增群：{comp.addedValues.join('、') || '无'}</span>
                  <span className="badge orange">缺失群：{comp.missingValues.join('、') || '无'}</span>
                </div>
                {comp.divergence.length > 0 && (
                  <div className="notice warn" style={{ marginTop: 8, marginBottom: 0 }}>局部与总体方向相反：{comp.divergence.map((d) => `${d.value}（${pp(d.segmentDelta)}）`).join('、')}，需单独说明，不能以总均值掩盖。</div>
                )}
              </div>
            );
          })}

          {drift.divergences.length > 0 && (
            <div className="card" style={{ borderColor: '#ffd591', background: '#fffdf7' }}>
              <div className="card-title">⚠ 近期窗口总体与局部方向相反</div>
              <table>
                <thead><tr><th>分群</th><th>渠道</th><th className="num">总体 Δ</th><th className="num">该群 Δ</th><th>说明</th></tr></thead>
                <tbody>
                  {drift.divergences.map((d, i) => (
                    <tr key={i}>
                      <td>{d.value}</td>
                      <td>{d.channelName}</td>
                      <td className="num">{pp(d.overallDelta)}</td>
                      <td className="num" style={{ color: 'var(--danger)' }}>{pp(d.segmentDelta)}</td>
                      <td className="small">{d.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <div className="card-title">漂移报告限制</div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{drift.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>{drift.note}</div>
          </div>
        </>
      )}
    </>
  );
}

// ---------------- 图表 ----------------

function shareChartOption(result: EvaluationResult): EChartsOption {
  const rows = result.modelA.channelShares.filter((c) => c.covered);
  return {
    color: CHART_COLORS,
    textStyle: baseTextStyle,
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => pct(Number(v)) },
    legend: { bottom: 0, textStyle: { color: CHART_TEXT } },
    grid: { left: 80, right: 24, top: 24, bottom: 48 },
    xAxis: { type: 'category', data: rows.map((c) => c.name), axisLabel: { color: CHART_TEXT, interval: 0, fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { color: CHART_TEXT, formatter: (v: number) => `${(v * 100).toFixed(0)}%` }, splitLine: { lineStyle: { color: '#eef1f6' } } },
    series: [
      { name: '模型 A', type: 'bar', data: rows.map((c) => c.share) },
      {
        name: '模型 B',
        type: 'bar',
        data: rows.map((c) => {
          const b = result.modelB.channelShares.find((x) => x.channelId === c.channelId);
          return b?.covered ? b.share : null;
        }),
      },
    ],
  };
}

function stabilityChartOption(result: EvaluationResult): EChartsOption {
  const rows = result.stability.diffs.filter((d) => d.metric === 'channel_share' && d.lower !== null && d.upper !== null);
  return {
    color: CHART_COLORS,
    textStyle: baseTextStyle,
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => pp(Number(v)) },
    grid: { left: 90, right: 24, top: 24, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { color: CHART_TEXT, formatter: (v: number) => `${(v * 100).toFixed(0)}pp` }, splitLine: { lineStyle: { color: '#eef1f6' } } },
    yAxis: { type: 'category', data: rows.map((d) => d.label.replace(' 份额差异（B−A）', '')), axisLabel: { color: CHART_TEXT, fontSize: 11 } },
    series: [{
      type: 'custom',
      data: rows.map((d) => [d.channelId, d.lower, d.upper, d.pointEstimate]),
      renderItem: (_params: unknown, api: { value: (i: number) => number; coord: (p: number[]) => number[]; size: (p: number[]) => number[] }) => {
        const lower = api.value(1);
        const upper = api.value(2);
        const point = api.value(3);
        const c1 = api.coord([lower, api.value(0)]);
        const c2 = api.coord([upper, api.value(0)]);
        const cp = api.coord([point, api.value(0)]);
        const h = api.size([0, 1])[1] * 0.35;
        return {
          type: 'group',
          children: [
            { type: 'line', shape: { x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1] }, style: { stroke: '#2f54eb', lineWidth: 2 } },
            { type: 'line', shape: { x1: c1[0], y1: c1[1] - h, x2: c1[0], y2: c1[1] + h }, style: { stroke: '#2f54eb', lineWidth: 2 } },
            { type: 'line', shape: { x1: c2[0], y1: c2[1] - h, x2: c2[0], y2: c2[1] + h }, style: { stroke: '#2f54eb', lineWidth: 2 } },
            { type: 'circle', shape: { cx: cp[0], cy: cp[1], r: 4 }, style: { fill: '#2f54eb' } },
          ],
        };
      },
    }],
  } as EChartsOption;
}
