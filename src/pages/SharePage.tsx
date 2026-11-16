import { useState } from 'react';
import EChart from '@/components/EChart';
import { EmptyState, KeyValue, Modal, StatusBadge } from '@/components/ui';
import { formatCny, formatDateTime } from '@/lib/format';
import { DEAL_LABELS, MODEL_LABELS } from '@/lib/constants';
import { CHART_COLORS, CHART_TEXT, baseTextStyle } from '@/lib/chart';
import { useAppStore } from '@/store/useAppStore';
import type { EChartsOption } from 'echarts';
import type { SharedReport } from '@/types/domain';

export default function SharePage() {
  const store = useAppStore();
  const isOwner = store.currentUserId === 'U-2001';
  const [title, setTitle] = useState('双月渠道贡献分享');
  const [shareRunId, setShareRunId] = useState('');
  const [openReport, setOpenReport] = useState<SharedReport | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const lockableRuns = store.runs.filter((r) => r.status === 'locked' && r.results);
  const latestVersion = store.snapshots[store.snapshots.length - 1].dataVersion;

  const notify = (kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  };

  const createShare = () => {
    const r = store.createSharedReport(shareRunId, title || '未命名共享报告', store.currentUserId);
    if (r.ok && r.shareId) {
      notify('success', `共享报告 ${r.shareId} 已生成：载荷已冻结，后续退款与新运行不会改变它`);
    } else {
      notify('error', r.message);
    }
  };

  return (
    <>
      {toast && <div className={`notice ${toast.kind === 'success' ? 'success' : 'error'}`}>{toast.text}</div>}

      <div className="card">
        <div className="card-title">
          生成共享报告
          <span className="hint">仅已锁定运行可分享；分享快照固定引用该运行并复制冻结载荷</span>
        </div>
        {!isOwner && <div className="notice warn">当前为分析师身份：可查看共享报告；创建与撤销限投放负责人（赵明）。</div>}
        <div className="form-row">
          <label className="field">来源运行（必须已锁定）
            <select value={shareRunId} onChange={(e) => setShareRunId(e.target.value)} style={{ minWidth: 420 }}>
              <option value="">请选择已锁定运行…</option>
              {lockableRuns.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} · {MODEL_LABELS[r.config.model]} · {r.dataVersion} · 锁定于 {r.lockedAt ? formatDateTime(r.lockedAt) : '—'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">报告标题
            <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: 240 }} />
          </label>
          <button className="primary" disabled={!isOwner || !shareRunId} onClick={createShare}>冻结并生成分享</button>
        </div>
        {lockableRuns.length === 0 && <div className="small muted" style={{ marginTop: 8 }}>还没有已锁定运行：请在「归因运行」页完成审批核对后锁定。</div>}
      </div>

      <div className="card">
        <div className="card-title">共享报告列表 <span className="hint">状态独立记录；撤销不删除冻结载荷，仅标记失效</span></div>
        {store.sharedReports.length === 0 ? <EmptyState text="暂无共享报告" /> : (
          <table>
            <thead><tr><th>共享</th><th>标题</th><th>来源运行</th><th>冻结数据版本</th><th>当前最新版本</th><th>状态</th><th>创建</th><th>操作</th></tr></thead>
            <tbody>
              {[...store.sharedReports].reverse().map((rep) => (
                <tr key={rep.shareId}>
                  <td className="mono">{rep.shareId}</td>
                  <td>{rep.title}</td>
                  <td className="mono small">{rep.runId}</td>
                  <td className="mono">{rep.frozen.dataVersion}<div className="small muted">{rep.frozen.ruleRevision}</div></td>
                  <td>
                    <span className="mono">{latestVersion}</span>
                    {rep.frozen.dataVersion !== latestVersion && <div className="small" style={{ color: 'var(--warning)' }}>已有更新版本，本分享仍保持冻结时结果</div>}
                  </td>
                  <td>{rep.status === 'active' ? <span className="badge green">生效中</span> : <span className="badge red">已撤销</span>}</td>
                  <td className="small">{formatDateTime(rep.createdAt)}</td>
                  <td>
                    <div className="pill-row">
                      <button className="sm" onClick={() => setOpenReport(rep)}>查看冻结内容</button>
                      {rep.status === 'active' && isOwner && (
                        <button className="sm danger" onClick={() => { store.revokeSharedReport(rep.shareId); notify('success', `共享 ${rep.shareId} 已撤销，冻结载荷保留可审计`); }}>撤销</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <FrozenReportModal report={openReport} onClose={() => setOpenReport(null)} />
    </>
  );
}

function FrozenReportModal({ report, onClose }: { report: SharedReport | null; onClose: () => void }) {
  const store = useAppStore();
  if (!report) return null;
  const snapshot = store.snapshots.find((s) => s.snapshotId === report.snapshotId);
  const nameOf = (id: string) => snapshot?.channels.find((c) => c.channelId === id)?.name ?? id;
  const chartOption: EChartsOption = {
    color: CHART_COLORS,
    textStyle: baseTextStyle,
    title: { text: '冻结载荷：渠道归因收入（分享时复制，不随后续运行变化）', left: 'center', textStyle: { fontSize: 13, color: CHART_TEXT } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => formatCny(Number(v)) },
    grid: { left: 90, right: 30, top: 48, bottom: 40 },
    xAxis: { type: 'value', axisLabel: { color: CHART_TEXT, formatter: (v: number) => `${v / 100}元` }, splitLine: { lineStyle: { color: '#eef1f6' } } },
    yAxis: { type: 'category', data: report.frozen.channelSummaries.map((c) => nameOf(c.channelId)), axisLabel: { color: CHART_TEXT } },
    series: [{ type: 'bar', data: report.frozen.channelSummaries.map((c) => c.attributedRevenue), itemStyle: { borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', formatter: (p) => formatCny(Number((p as { value: number }).value)), color: CHART_TEXT } }],
  };

  return (
    <Modal open={!!report} wide title={<span>共享报告冻结内容 <span className="mono">{report.shareId}</span></span>} onClose={onClose}>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card tight">
          <div className="card-title">固定引用</div>
          <KeyValue rows={[
            ['状态', report.status === 'active' ? <span className="badge green">生效中</span> : <span className="badge red">已撤销</span>],
            ['来源运行', <span className="mono">{report.runId}</span>],
            ['输入快照', <span className="mono">{report.snapshotId}</span>],
            ['冻结数据版本', <span className="mono">{report.frozen.dataVersion}</span>],
            ['规则修订', <span className="mono">{report.frozen.ruleRevision}</span>],
            ['模型', MODEL_LABELS[report.frozen.config.model]],
            ['成交定义', DEAL_LABELS[report.frozen.config.dealDefinition]],
            ['窗口/时区', `${report.frozen.config.windowDays} 天 · ${report.frozen.config.timezone}`],
            ['创建时间', formatDateTime(report.createdAt)],
          ]} />
          <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
            不可变性：迟到退款只会生成新运行与新分享；本报告数字、图表与订单明细在创建时复制冻结，刷新页面或产生新运行后保持不变。
          </div>
        </div>
        <div className="card tight">
          <div className="card-title">冻结汇总数字</div>
          <KeyValue rows={[
            ['净收入合计', formatCny(report.frozen.totalNetRevenue)],
            ['渠道已分配', formatCny(report.frozen.totalAllocated)],
            ['未知来源单列', formatCny(report.frozen.unknownRevenue)],
            ['守恒', report.frozen.totalAllocated + report.frozen.unknownRevenue === report.frozen.totalNetRevenue ? <span className="badge green">份额+未知=净收入</span> : <span className="badge red">异常</span>],
            ['冻结订单条数', `${report.frozen.orderAttributions.length} 单`],
            ['来源运行当前状态', <StatusBadge status={store.runs.find((r) => r.runId === report.runId)?.status ?? 'superseded'} />],
          ]} />
        </div>
      </div>
      <div className="card tight"><EChart option={chartOption} className="chart-box short" /></div>
      <div className="card tight">
        <div className="card-title">冻结的订单级结果（逐单分摊额）</div>
        <table>
          <thead><tr><th>订单</th><th>类型</th><th className="num">净额</th><th>冻结分摊</th></tr></thead>
          <tbody>
            {report.frozen.orderAttributions.map((oa) => (
              <tr key={oa.orderId}>
                <td className="mono">{oa.orderId}</td>
                <td>{oa.unknown ? <span className="badge purple">未知来源</span> : <span className="badge blue">订单级分配</span>}</td>
                <td className="num">{formatCny(oa.netAmount)}</td>
                <td className="small">
                  {oa.unknown ? '单列，不进渠道' : oa.allocations.map((a) => `${nameOf(a.channelId)} ${formatCny(a.amount)}`).join('；')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
