import { useMemo, useState } from 'react';
import EChart from '@/components/EChart';
import { Modal } from '@/components/ui';
import { formatCny, formatDateTime } from '@/lib/format';
import { CHART_COLORS, CHART_TEXT, baseTextStyle } from '@/lib/chart';
import { useAppStore } from '@/store/useAppStore';
import type { DataSnapshot, Order } from '@/types/domain';

const STREAM_LABELS: Record<string, string> = {
  orders: '订单流',
  order_touchpoints: '订单级触点流',
  platform_click_aggregate: '平台点击汇总流',
  refund: '退款流',
  identity: '身份授权流',
};

/** 数据接入与血缘页：输入边界、授权标识、净额管线、平台汇总分离 */
export default function DataIngestionPage() {
  const snapshots = useAppStore((s) => s.snapshots);
  const [snapshotId, setSnapshotId] = useState(snapshots[snapshots.length - 1].snapshotId);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);

  const snapshot = snapshots.find((s) => s.snapshotId === snapshotId) ?? snapshots[0];

  const totals = useMemo(() => {
    const gross = snapshot.orders.reduce((s, o) => s + o.grossAmount, 0);
    const refunded = snapshot.orderVersions.reduce((s, v) => s + v.refundedAmount, 0);
    const net = snapshot.orderVersions.reduce((s, v) => s + v.netAmount, 0);
    const platformCost = snapshot.platformClicks.reduce((s, a) => s + a.cost, 0);
    const platformClicks = snapshot.platformClicks.reduce((s, a) => s + a.clicks, 0);
    return { gross, refunded, net, platformCost, platformClicks };
  }, [snapshot]);

  const channelMap = new Map(snapshot.channels.map((c) => [c.channelId, c]));

  const costByChannel = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of snapshot.platformClicks) m.set(a.channelId, (m.get(a.channelId) ?? 0) + a.cost);
    return [...m.entries()].map(([id, cost]) => ({ name: channelMap.get(id)?.name ?? id, cost }));
  }, [snapshot]);

  return (
    <>
      <div className="form-row" style={{ marginBottom: 14 }}>
        <label className="field">
          输入快照（同一分析运行只绑定一个快照）
          <select value={snapshotId} onChange={(e) => setSnapshotId(e.target.value)} style={{ minWidth: 320 }}>
            {snapshots.map((s) => (
              <option key={s.snapshotId} value={s.snapshotId}>
                {s.snapshotId} · {s.dataVersion} · 规则修订 {s.ruleRevision}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="notice info">
        <div>
          <strong>输入边界：</strong>平台点击汇总与订单级触点分开保存。只有带稳定订单关联且标识授权的订单级触点参与逐单分配；
          无法匹配的费用与点击只保留在下方「平台汇总区」，两个区域的金额禁止相加。
        </div>
      </div>

      <div className="grid cols-4">
        <div className="stat"><div className="label">订单毛额合计</div><div className="value">{formatCny(totals.gross)}</div><div className="sub">{snapshot.orders.length} 笔订单</div></div>
        <div className="stat alert"><div className="label">累计退款扣减</div><div className="value">{formatCny(totals.refunded)}</div><div className="sub">{snapshot.refunds.length} 笔退款流水</div></div>
        <div className="stat"><div className="label">订单净额合计</div><div className="value">{formatCny(totals.net)}</div><div className="sub">毛额 − 退款（取消单净额为 0）</div></div>
        <div className="stat unknown"><div className="label">平台汇总费用（不可与明细相加）</div><div className="value">{formatCny(totals.platformCost)}</div><div className="sub">{totals.platformClicks.toLocaleString()} 次汇总点击</div></div>
      </div>

      <div className="card">
        <div className="card-title">① 接入作业血缘 <span className="hint">来源、记录数、校验和、隔离记录</span></div>
        <table>
          <thead><tr><th>作业</th><th>来源系统</th><th>数据流</th><th>拉取时间</th><th className="num">记录数</th><th>校验和</th><th>状态</th><th>备注</th></tr></thead>
          <tbody>
            {snapshot.ingestionJobs.map((j) => (
              <tr key={j.jobId}>
                <td className="mono">{j.jobId}</td>
                <td>{j.source}</td>
                <td>{STREAM_LABELS[j.stream]}</td>
                <td className="small">{formatDateTime(j.fetchedAt)}</td>
                <td className="num">{j.recordCount}</td>
                <td className="mono muted">{j.checksum}</td>
                <td>{j.status === 'success' ? <span className="badge green">成功</span> : <span className="badge red">已隔离</span>}</td>
                <td className="small muted">{j.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">② 确定性标识与授权边界 <span className="hint">未授权跨设备不拼人</span></div>
          <table>
            <thead><tr><th>人员</th><th>跨设备授权</th><th>标识（设备）</th></tr></thead>
            <tbody>
              {snapshot.identityLinks.map((p) => (
                <tr key={p.personId}>
                  <td>
                    <div className="mono">{p.personId}</div>
                    <div className="small muted">{p.displayName}</div>
                  </td>
                  <td>{p.crossDeviceAuthorized ? <span className="badge green">已授权</span> : <span className="badge red">未授权</span>}</td>
                  <td className="small">
                    {p.identifiers.map((i) => (
                      <div key={`${i.kind}-${i.value}-${i.deviceId}`} className="mono">
                        {i.kind}={i.value} <span className="muted">@ {i.deviceId}</span>
                        {i.authorized ? '' : ' <span className="badge red">未授权</span>'}
                      </div>
                    ))}
                    {p.note && <div className="small" style={{ color: 'var(--warning)', marginTop: 4 }}>⚠ {p.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-title">③ 订单净额管线 <span className="hint">毛额 → 退款 → 净额，逐版本可追溯</span></div>
          <table>
            <thead><tr><th>订单</th><th className="num">毛额</th><th className="num">退款</th><th className="num">净额</th><th>状态</th></tr></thead>
            <tbody>
              {snapshot.orderVersions.map((v) => {
                const order = snapshot.orders.find((o) => o.orderId === v.orderId);
                return (
                  <tr key={v.orderId} className="clickable" onClick={() => order && setDetailOrder(order)}>
                    <td className="mono">{v.orderId}{order?.scenarioTag && <div className="tag-scenario" style={{ marginTop: 3 }}>{order.scenarioTag.split('：')[0]}</div>}</td>
                    <td className="num">{formatCny(v.grossAmount)}</td>
                    <td className="num" style={{ color: v.refundedAmount ? 'var(--warning)' : undefined }}>{formatCny(v.refundedAmount)}</td>
                    <td className="num"><strong>{formatCny(v.netAmount)}</strong></td>
                    <td><span className={`badge ${v.status === 'cancelled' ? 'gray' : v.status.startsWith('refunded') ? 'orange' : 'green'}`}>{v.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>点击订单行可查看场景标签与完整净额版本。</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">④ 平台汇总区（无订单级标识，不参与逐单分配）</div>
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div>
            <table>
              <thead><tr><th>平台/渠道</th><th>日期</th><th className="num">点击</th><th className="num">费用</th><th>订单标识</th></tr></thead>
              <tbody>
                {snapshot.platformClicks.map((a) => (
                  <tr key={a.aggId}>
                    <td className="small">{a.platform}<div className="muted">{channelMap.get(a.channelId)?.name} · {a.campaignId}</div></td>
                    <td className="mono small">{a.day}</td>
                    <td className="num">{a.clicks.toLocaleString()}</td>
                    <td className="num">{formatCny(a.cost)}</td>
                    <td><span className="badge red">无</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {snapshot.platformClicks.some((a) => a.note) && (
              <div className="small muted" style={{ marginTop: 8 }}>
                {snapshot.platformClicks.filter((a) => a.note).map((a) => <div key={a.aggId}>· {a.aggId}：{a.note}</div>)}
              </div>
            )}
          </div>
          <EChart
            option={{
              color: CHART_COLORS,
              textStyle: baseTextStyle,
              title: { text: '平台汇总费用（分渠道，仅汇总口径）', left: 'center', textStyle: { fontSize: 13, color: CHART_TEXT } },
              tooltip: { trigger: 'item', valueFormatter: (v: unknown) => formatCny(Number(v)) },
              legend: { bottom: 0, textStyle: { color: CHART_TEXT } },
              series: [{
                type: 'pie',
                radius: ['38%', '62%'],
                center: ['50%', '46%'],
                data: costByChannel.map((c) => ({ name: c.name, value: c.cost })),
                label: { formatter: '{b}\n{d}%' },
              }],
            }}
            className="chart-box short"
          />
        </div>
      </div>

      <OrderVersionModal order={detailOrder} snapshot={snapshot} onClose={() => setDetailOrder(null)} />
    </>
  );
}

function OrderVersionModal({ order, snapshot, onClose }: { order: Order | null; snapshot: DataSnapshot; onClose: () => void }) {
  if (!order) return null;
  const v = snapshot.orderVersions.find((x) => x.orderId === order.orderId);
  return (
    <Modal open={!!order} title={<span>订单净额版本 <span className="mono">{order.orderId}</span></span>} onClose={onClose}>
      {order.scenarioTag && <div className="notice info">{order.scenarioTag}</div>}
      <table>
        <thead><tr><th>数据版本</th><th className="num">毛额</th><th className="num">退款扣减</th><th className="num">净额</th><th>状态</th><th>关联退款</th></tr></thead>
        <tbody>
          <tr>
            <td className="mono">{v?.dataVersion}</td>
            <td className="num">{v ? formatCny(v.grossAmount) : '—'}</td>
            <td className="num">{v ? formatCny(v.refundedAmount) : '—'}</td>
            <td className="num"><strong>{v ? formatCny(v.netAmount) : '—'}</strong></td>
            <td>{v?.status}</td>
            <td className="mono small">{v?.refundIds.join('、') || '无'}</td>
          </tr>
        </tbody>
      </table>
      <div className="small muted" style={{ marginTop: 10 }}>
        净额计算公式：净收入 = 毛额 − 累计退款；取消订单净额强制为 0。退款晚到时会生成新数据版本与新归因运行，旧运行图表保持不变。
      </div>
    </Modal>
  );
}
