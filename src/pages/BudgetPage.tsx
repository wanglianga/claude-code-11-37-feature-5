import { useMemo, useState } from 'react';
import EChart from '@/components/EChart';
import { EmptyState, StatusBadge } from '@/components/ui';
import { formatCny } from '@/lib/format';
import { MODEL_LABELS } from '@/lib/constants';
import { CHART_COLORS, CHART_TEXT, baseTextStyle } from '@/lib/chart';
import { useAppStore } from '@/store/useAppStore';
import type { EChartsOption } from 'echarts';
import type { BudgetPlan } from '@/types/domain';

/**
 * 预算方案页
 * - 只读取「已完成 / 已锁定」的归因运行，草稿与计算中不可选
 * - 模拟收入按显式规则（份额比例 × 预算比例弹性系数）推算，仅用于方案对比
 * - 任何模拟都不回写实际订单与归因结果
 */
export default function BudgetPage() {
  const store = useAppStore();
  const readableRuns = store.runs.filter((r) => (r.status === 'completed' || r.status === 'locked') && r.results);
  const [runId, setRunId] = useState(readableRuns[0]?.runId ?? '');
  const [planName, setPlanName] = useState('预算调整草案');
  const [elasticity, setElasticity] = useState(0.6);
  const [proposed, setProposed] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);

  const run = readableRuns.find((r) => r.runId === runId) ?? readableRuns[0];
  const snapshot = store.snapshots.find((s) => s.snapshotId === run?.snapshotId);

  const lines = useMemo(() => {
    if (!run || !snapshot) return [];
    const spendByChannel = new Map<string, number>();
    for (const a of snapshot.platformClicks) spendByChannel.set(a.channelId, (spendByChannel.get(a.channelId) ?? 0) + a.cost);
    return run.results!.channelSummaries.map((c) => {
      const currentSpend = spendByChannel.get(c.channelId) ?? 0;
      const proposedBudget = proposed[c.channelId] ?? currentSpend;
      // 显式模拟规则：模拟收入 = 归因收入 × (新预算/现投入)^弹性系数；无现投入时不做推算
      const simulatedRevenue =
        currentSpend > 0 && proposedBudget > 0
          ? Math.round(c.attributedRevenue * Math.pow(proposedBudget / currentSpend, elasticity))
          : c.attributedRevenue;
      return { channelId: c.channelId, currentSpend, proposedBudget, simulatedRevenue, attributedRevenue: c.attributedRevenue };
    });
  }, [run, snapshot, proposed, elasticity]);

  if (readableRuns.length === 0) {
    return (
      <div className="card">
        <EmptyState text="没有已完成或已锁定的归因运行；预算页只读取已完成运行，请先在「归因运行」页执行计算" />
      </div>
    );
  }

  const totalCurrent = lines.reduce((s, l) => s + l.currentSpend, 0);
  const totalProposed = lines.reduce((s, l) => s + l.proposedBudget, 0);
  const totalSimulated = lines.reduce((s, l) => s + l.simulatedRevenue, 0);
  const totalAttributed = lines.reduce((s, l) => s + l.attributedRevenue, 0);

  const chartOption: EChartsOption = {
    color: CHART_COLORS,
    textStyle: baseTextStyle,
    title: { text: '当前投入 vs 拟议预算 vs 模拟收入（规则推算，非因果）', left: 'center', textStyle: { fontSize: 13, color: CHART_TEXT } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => formatCny(Number(v)) },
    legend: { bottom: 0, textStyle: { color: CHART_TEXT } },
    grid: { left: 80, right: 24, top: 44, bottom: 56 },
    xAxis: { type: 'category', data: lines.map((l) => snapshot?.channels.find((c) => c.channelId === l.channelId)?.name ?? l.channelId), axisLabel: { color: CHART_TEXT } },
    yAxis: { type: 'value', axisLabel: { color: CHART_TEXT, formatter: (v: number) => `${v / 100}元` }, splitLine: { lineStyle: { color: '#eef1f6' } } },
    series: [
      { name: '当前投入（平台汇总）', type: 'bar', data: lines.map((l) => l.currentSpend) },
      { name: '拟议预算', type: 'bar', data: lines.map((l) => l.proposedBudget) },
      { name: '模拟收入', type: 'bar', data: lines.map((l) => l.simulatedRevenue) },
    ],
  };

  const savePlan = (status: 'draft' | 'published') => {
    const plan: BudgetPlan = {
      planId: `PLAN-${Date.now().toString(36)}`,
      name: planName,
      runId: run!.runId,
      createdAt: new Date().toISOString(),
      status,
      lines: lines.map((l) => ({ channelId: l.channelId, currentSpend: l.currentSpend, proposedBudget: l.proposedBudget, simulatedRevenue: l.simulatedRevenue })),
    };
    store.saveBudgetPlan(plan);
    setToast(`方案「${planName}」已保存为${status === 'draft' ? '草稿' : '已发布'}；模拟结果未回写任何订单或归因运行`);
    window.setTimeout(() => setToast(null), 4200);
  };

  return (
    <>
      <div className="notice info">
        <div>
          <strong>使用边界：</strong>本页仅可选择状态为「已完成 / 已锁定」的运行；模拟收入依据可解释的弹性规则推算，
          用于方案间比较，<strong>不代表渠道因果，也不会回写实际订单、净额或归因结果</strong>。
        </div>
      </div>
      {toast && <div className="notice success">{toast}</div>}

      <div className="card">
        <div className="form-row">
          <label className="field">数据来源运行（只读）
            <select value={run?.runId ?? ''} onChange={(e) => { setRunId(e.target.value); setProposed({}); }} style={{ minWidth: 420 }}>
              {readableRuns.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} · {MODEL_LABELS[r.config.model]} · {r.dataVersion} · {r.status}
                </option>
              ))}
            </select>
          </label>
          <label className="field">方案名称
            <input value={planName} onChange={(e) => setPlanName(e.target.value)} style={{ width: 200 }} />
          </label>
          <label className="field">收入弹性系数（模拟规则）
            <input type="number" min={0} max={2} step={0.1} value={elasticity} onChange={(e) => setElasticity(Number(e.target.value))} style={{ width: 120 }} />
          </label>
          <div style={{ alignSelf: 'flex-end' }} className="small muted">
            运行状态：{run && <StatusBadge status={run.status} />}
          </div>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="stat"><div className="label">当前投入合计</div><div className="value">{formatCny(totalCurrent)}</div><div className="sub">平台汇总区费用</div></div>
        <div className="stat"><div className="label">拟议预算合计</div><div className="value">{formatCny(totalProposed)}</div><div className="sub">可在下表逐渠道编辑</div></div>
        <div className="stat"><div className="label">运行归因收入</div><div className="value">{formatCny(totalAttributed)}</div><div className="sub">订单级分摊口径</div></div>
        <div className="stat unknown"><div className="label">模拟收入合计</div><div className="value">{formatCny(totalSimulated)}</div><div className="sub">规则推算，禁止当作实际收入</div></div>
      </div>

      <div className="card">
        <EChart option={chartOption} className="chart-box" />
      </div>

      <div className="card">
        <div className="card-title">渠道预算编辑 <span className="hint">模拟规则：模拟收入 = 归因收入 × (拟议预算 ÷ 当前投入)^弹性系数</span></div>
        <table>
          <thead>
            <tr><th>渠道</th><th className="num">当前投入</th><th className="num">运行归因收入</th><th>拟议预算（元）</th><th className="num">模拟收入</th><th className="num">模拟 ROAS</th></tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const name = snapshot?.channels.find((c) => c.channelId === l.channelId)?.name ?? l.channelId;
              return (
                <tr key={l.channelId}>
                  <td>{name}</td>
                  <td className="num">{formatCny(l.currentSpend)}</td>
                  <td className="num">{formatCny(l.attributedRevenue)}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={Math.round(l.proposedBudget / 100)}
                      onChange={(e) => setProposed({ ...proposed, [l.channelId]: Math.max(0, Math.round(Number(e.target.value) * 100)) })}
                      style={{ width: 140 }}
                    />
                  </td>
                  <td className="num">{formatCny(l.simulatedRevenue)}</td>
                  <td className="num">{l.proposedBudget > 0 ? (l.simulatedRevenue / l.proposedBudget).toFixed(2) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="pill-row" style={{ marginTop: 14 }}>
          <button onClick={() => savePlan('draft')}>保存为草稿方案</button>
          <button className="primary" onClick={() => savePlan('published')}>发布方案</button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">已保存方案 <span className="hint">各自记录独立状态；始终保留对来源运行的引用</span></div>
        {store.budgetPlans.length === 0 ? <EmptyState text="暂无保存的预算方案" /> : (
          <table>
            <thead><tr><th>方案</th><th>来源运行</th><th>状态</th><th className="num">预算合计</th><th className="num">模拟收入合计</th><th>创建时间</th></tr></thead>
            <tbody>
              {[...store.budgetPlans].reverse().map((p) => (
                <tr key={p.planId}>
                  <td>{p.name}<div className="small muted mono">{p.planId}</div></td>
                  <td className="mono small">{p.runId}</td>
                  <td>{p.status === 'draft' ? <span className="badge gray">草稿</span> : <span className="badge green">已发布</span>}</td>
                  <td className="num">{formatCny(p.lines.reduce((s, l) => s + l.proposedBudget, 0))}</td>
                  <td className="num">{formatCny(p.lines.reduce((s, l) => s + l.simulatedRevenue, 0))}</td>
                  <td className="small">{new Date(p.createdAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
