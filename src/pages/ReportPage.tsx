import { useEffect, useMemo, useRef, useState } from 'react';
import EChart from '@/components/EChart';
import OrderDrawer from '@/components/OrderDrawer';
import { EmptyState, StatusBadge } from '@/components/ui';
import { verifyInvariants } from '@/engine/attribution';
import { formatCny } from '@/lib/format';
import { MODEL_LABELS } from '@/lib/constants';
import { CHART_COLORS, CHART_TEXT, baseTextStyle } from '@/lib/chart';
import { RequestSeq } from '@/services/api';
import type { EChartsOption } from 'echarts';
import { useAppStore } from '@/store/useAppStore';
import type { AttributionRun, OrderAttribution } from '@/types/domain';

interface Filters {
  channelId: string; // 'all' | 'unknown' | channelId
  keyword: string;
  onlyUnknown: boolean;
}

interface ReportView {
  rows: OrderAttribution[];
  totalFilteredNet: number;
  servedAt: number;
  filterSignature: string;
}

/** 模拟报告服务异步返回（真实环境为后端聚合接口） */
function fetchReportView(run: AttributionRun, filters: Filters): Promise<ReportView> {
  const signature = JSON.stringify(filters);
  return new Promise((resolve) => {
    setTimeout(() => {
      let rows = run.results!.orderAttributions;
      if (filters.channelId === 'unknown') rows = rows.filter((r) => r.unknown);
      else if (filters.channelId !== 'all') rows = rows.filter((r) => r.allocations.some((a) => a.channelId === filters.channelId));
      if (filters.onlyUnknown) rows = rows.filter((r) => r.unknown);
      if (filters.keyword.trim()) rows = rows.filter((r) => r.orderId.toLowerCase().includes(filters.keyword.trim().toLowerCase()));
      resolve({
        rows,
        totalFilteredNet: rows.reduce((s, r) => s + r.netAmount, 0),
        servedAt: Date.now(),
        filterSignature: signature,
      });
    }, 380);
  });
}

export default function ReportPage() {
  const store = useAppStore();
  const executableRuns = store.runs.filter((r) => r.results);
  const [runId, setRunId] = useState<string>(executableRuns[0]?.runId ?? '');
  const [filters, setFilters] = useState<Filters>({ channelId: 'all', keyword: '', onlyUnknown: false });
  const [view, setView] = useState<ReportView | null>(null);
  const [loading, setLoading] = useState(false);
  const [staleCount, setStaleCount] = useState(0);
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(null);
  const seqRef = useRef(new RequestSeq<ReportView>());

  // 运行被删除/重置时兜底
  useEffect(() => {
    if (!executableRuns.some((r) => r.runId === runId) && executableRuns.length > 0) {
      setRunId(executableRuns[0].runId);
    }
  }, [executableRuns, runId]);

  const run = store.runs.find((r) => r.runId === runId);
  const snapshot = store.snapshots.find((s) => s.snapshotId === run?.snapshotId);

  // 筛选/运行切换：请求序号守卫，旧响应到达即丢弃，绝不覆盖新条件视图
  useEffect(() => {
    if (!run?.results) {
      setView(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const signature = JSON.stringify(filters);
    seqRef.current.run(() => fetchReportView(run, filters)).then(({ data, accepted }) => {
      if (cancelled) return;
      if (!accepted || data.filterSignature !== signature) {
        setStaleCount((c) => c + 1);
        return;
      }
      setView(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [runId, filters, run]);

  const channelOption = useMemo(() => {
    if (!run?.results || !snapshot) return null;
    const nameOf = (id: string) => snapshot.channels.find((c) => c.channelId === id)?.name ?? id;
    const data = run.results.channelSummaries.map((c) => ({
      name: nameOf(c.channelId),
      value: c.attributedRevenue,
      channelId: c.channelId,
    }));
    const option: EChartsOption = {
      color: CHART_COLORS,
      textStyle: baseTextStyle,
      title: { text: '渠道归因收入占比（订单级分摊口径）', left: 'center', textStyle: { fontSize: 13, color: CHART_TEXT } },
      tooltip: { trigger: 'item', formatter: (p) => {
        const param = p as { name: string; value: number; percent: number };
        return `${param.name}<br/>${formatCny(param.value)}（${param.percent}%）`;
      } },
      legend: { bottom: 0, textStyle: { color: CHART_TEXT } },
      series: [{
        type: 'pie',
        radius: ['40%', '64%'],
        center: ['50%', '46%'],
        data,
        label: { formatter: '{b}\n{d}%' },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.15)' } },
      }],
    };
    return option;
  }, [run, snapshot]);

  /** 从渠道金额（扇区）直接下钻到该渠道的订单筛选，再点击订单行可回到触点依据 */
  const onPieClick = (params: { data?: unknown }) => {
    const channelId = (params.data as { channelId?: string } | null | undefined)?.channelId;
    if (channelId) setFilters((f) => ({ ...f, channelId }));
  };

  const barOption = useMemo(() => {
    if (!run?.results || !snapshot) return null;
    const nameOf = (id: string) => snapshot.channels.find((c) => c.channelId === id)?.name ?? id;
    const rows = [...run.results.channelSummaries].sort((a, b) => b.attributedRevenue - a.attributedRevenue);
    const option: EChartsOption = {
      color: CHART_COLORS,
      textStyle: baseTextStyle,
      title: { text: '各渠道归因收入与覆盖订单数', left: 'center', textStyle: { fontSize: 13, color: CHART_TEXT } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { color: CHART_TEXT } },
      grid: { left: 90, right: 56, top: 40, bottom: 48 },
      xAxis: { type: 'value', axisLabel: { color: CHART_TEXT, formatter: (v: number) => `${v / 100}元` }, splitLine: { lineStyle: { color: '#eef1f6' } } },
      yAxis: { type: 'category', data: rows.map((r) => nameOf(r.channelId)), axisLabel: { color: CHART_TEXT } },
      series: [
        { name: '归因收入', type: 'bar', data: rows.map((r) => r.attributedRevenue), itemStyle: { borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', formatter: (p) => formatCny(Number((p as { value: number }).value)), color: CHART_TEXT } },
      ],
    };
    return option;
  }, [run, snapshot]);

  if (executableRuns.length === 0) {
    return (
      <div className="card">
        <EmptyState text="还没有含结果的归因运行，请先到「归因运行」页创建并执行" />
      </div>
    );
  }

  const invariant = run?.results ? verifyInvariants(run.results) : null;
  const platformCost = snapshot?.platformClicks.reduce((s, a) => s + a.cost, 0) ?? 0;
  const platformClicks = snapshot?.platformClicks.reduce((s, a) => s + a.clicks, 0) ?? 0;

  return (
    <>
      <div className="card">
        <div className="form-row">
          <label className="field">分析运行（页面固定读取同一运行的订单、触点与退款版本）
            <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ minWidth: 420 }}>
              {executableRuns.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} · {MODEL_LABELS[r.config.model]} · {r.dataVersion} · {r.status}
                </option>
              ))}
            </select>
          </label>
          <label className="field">渠道筛选（异步请求，旧响应自动丢弃）
            <select value={filters.channelId} onChange={(e) => setFilters({ ...filters, channelId: e.target.value })}>
              <option value="all">全部渠道</option>
              <option value="unknown">仅未知来源</option>
              {snapshot?.channels.map((c) => <option key={c.channelId} value={c.channelId}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">订单号搜索
            <input value={filters.keyword} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} placeholder="如 O-2001" style={{ width: 160 }} />
          </label>
          <label className="field" style={{ justifyContent: 'flex-end' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32 }}>
              <input type="checkbox" checked={filters.onlyUnknown} onChange={(e) => setFilters({ ...filters, onlyUnknown: e.target.checked })} /> 只看未知来源
            </span>
          </label>
        </div>
        {staleCount > 0 && <div className="stale-note" style={{ marginTop: 10 }}>竞态保护：已丢弃 {staleCount} 个晚到的旧筛选响应，当前图表始终对应最新筛选条件。</div>}
        {run && (
          <div className="small muted" style={{ marginTop: 8 }}>
            运行 {run.runId}（<StatusBadge status={run.status} />）绑定快照 <span className="mono">{run.snapshotId}</span> / 数据版本 <span className="mono">{run.dataVersion}</span> / 规则修订 <span className="mono">{run.config.ruleRevision}</span>
          </div>
        )}
      </div>

      {run?.results && (
        <div className="grid cols-4">
          <div className="stat"><div className="label">参与分配净收入</div><div className="value">{formatCny(run.results.totalNetRevenue)}</div><div className="sub">本运行口径下的分配基数</div></div>
          <div className="stat"><div className="label">渠道已分配总额</div><div className="value">{formatCny(run.results.totalAllocated)}</div><div className="sub">各订单份额逐单汇总</div></div>
          <div className="stat unknown"><div className="label">未知来源（单列）</div><div className="value">{formatCny(run.results.unknownRevenue)}</div><div className="sub">{run.results.unknownOrderIds.length} 单，不进入渠道</div></div>
          <div className={`stat ${invariant?.ok ? '' : 'alert'}`}><div className="label">份额守恒校验</div><div className="value" style={{ fontSize: 17 }}>{invariant?.ok ? '通过 ✓' : '违反 ✕'}</div><div className="sub">已分配 + 未知 = 净收入，份额不超净额</div></div>
        </div>
      )}

      {!invariant?.ok && invariant && (
        <div className="notice error">{invariant.violations.join('；')}</div>
      )}

      <div className="grid cols-2">
        <div className="card">
          {channelOption && <EChart option={channelOption} className="chart-box" onClick={onPieClick} />}
          <div className="small muted" style={{ textAlign: 'center' }}>点击扇区可按该渠道筛选订单，再点击订单行回查触点依据</div>
        </div>
        <div className="card">{barOption && <EChart option={barOption} className="chart-box" />}</div>
      </div>

      <div className="card">
        <div className="card-title">订单级归因明细 <span className="hint">点击任意行回查订单与触点依据；金额单位元</span></div>
        {loading && <div className="empty"><span className="loading" />加载报告视图…</div>}
        {!loading && view && (
          <>
            <div className="small muted" style={{ marginBottom: 8 }}>
              命中 {view.rows.length} 单，筛选结果净额 {formatCny(view.totalFilteredNet)}
              {filters.channelId !== 'all' && '（按渠道筛选时一单可在多渠道出现，行内金额为该渠道在本单的分摊额）'}
            </div>
            <table>
              <thead><tr><th>订单</th><th>人员/设备</th><th className="num">净额</th><th>渠道分摊（逐单）</th><th>场景</th></tr></thead>
              <tbody>
                {view.rows.map((oa) => {
                  const order = snapshot?.orders.find((o) => o.orderId === oa.orderId);
                  return (
                    <tr key={oa.orderId} className="clickable" onClick={() => setDrawerOrderId(oa.orderId)}>
                      <td className="mono">{oa.orderId}</td>
                      <td className="small">{oa.personId ?? <span className="badge purple">未知人员</span>}<div className="muted mono">{order?.deviceId}</div></td>
                      <td className="num"><strong>{formatCny(oa.netAmount)}</strong></td>
                      <td>
                        {oa.unknown ? (
                          <span className="badge purple">未知来源单列 {formatCny(oa.netAmount)}</span>
                        ) : (
                          <div className="pill-row">
                            {oa.allocations.map((a) => (
                              <span key={a.touchpointId} className="badge blue">
                                {snapshot?.channels.find((c) => c.channelId === a.channelId)?.name} · {(a.weight * 100).toFixed(0)}% · {formatCny(a.amount)}
                              </span>
                            ))}
                          </div>
                        )}
                        {oa.excluded && !oa.unknown && <div className="small muted" style={{ marginTop: 4 }}>排除：{oa.excluded}</div>}
                        {oa.unknown && oa.excluded && <div className="small muted" style={{ marginTop: 4 }}>{oa.excluded}</div>}
                      </td>
                      <td className="small">{order?.scenarioTag ? <span className="tag-scenario">{order.scenarioTag.split('：')[0]}</span> : '—'}</td>
                    </tr>
                  );
                })}
                {view.rows.length === 0 && <tr><td colSpan={5}><EmptyState text="当前筛选无命中订单" /></td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card" style={{ borderColor: '#ffd591', background: '#fffdf7' }}>
        <div className="card-title">平台级汇总区（独立展示，禁止与订单明细相加） <span className="hint">无订单级标识的点击与费用</span></div>
        <div className="grid cols-4" style={{ marginBottom: 10 }}>
          <div className="stat alert"><div className="label">平台汇总费用</div><div className="value">{formatCny(platformCost)}</div></div>
          <div className="stat alert"><div className="label">平台汇总点击</div><div className="value">{platformClicks.toLocaleString()}</div></div>
          <div className="stat"><div className="label">数据来源</div><div className="value" style={{ fontSize: 15 }}>日级聚合回传</div><div className="sub">无稳定订单关联</div></div>
          <div className="stat"><div className="label">能否参与逐单分配</div><div className="value" style={{ fontSize: 15 }}>否</div><div className="sub">仅用于投放成本参照</div></div>
        </div>
        <table>
          <thead><tr><th>平台</th><th>渠道</th><th>日期</th><th className="num">点击</th><th className="num">费用</th></tr></thead>
          <tbody>
            {snapshot?.platformClicks.map((a) => (
              <tr key={a.aggId}>
                <td>{a.platform}</td>
                <td>{snapshot.channels.find((c) => c.channelId === a.channelId)?.name}</td>
                <td className="mono">{a.day}</td>
                <td className="num">{a.clicks.toLocaleString()}</td>
                <td className="num">{formatCny(a.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
          上表为平台口径汇总，与上方订单级归因口径不同；两者相加会重复归因（平台点击可能对应多笔或零笔订单），报告中严禁合并求和。
        </div>
      </div>

      <OrderDrawer open={!!drawerOrderId} orderId={drawerOrderId} snapshot={snapshot} run={run} onClose={() => setDrawerOrderId(null)} />
    </>
  );
}
