import { Drawer, KeyValue } from '@/components/ui';
import { eligibleTouchpoints } from '@/engine/attribution';
import { formatCny, formatDateTime } from '@/lib/format';
import type { AttributionRun, DataSnapshot } from '@/types/domain';

/** 订单 → 触点依据钻取抽屉：从渠道金额可回到订单与每个触点的资格判定 */
export default function OrderDrawer({
  open,
  orderId,
  snapshot,
  run,
  onClose,
}: {
  open: boolean;
  orderId: string | null;
  snapshot: DataSnapshot | undefined;
  run: AttributionRun | undefined;
  onClose: () => void;
}) {
  if (!orderId || !snapshot) return null;
  const order = snapshot.orders.find((o) => o.orderId === orderId);
  const version = snapshot.orderVersions.find((v) => v.orderId === orderId);
  if (!order || !version) return null;

  const decision = run ? eligibleTouchpoints(snapshot, order, run.config) : { eligible: [], reasons: [] };
  const eligibleIds = new Set(decision.eligible.map((t) => t.touchpointId));
  const tps = snapshot.touchpoints
    .filter((t) => t.orderId === orderId)
    .sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
  const oa = run?.results?.orderAttributions.find((x) => x.orderId === orderId);
  const channelMap = new Map(snapshot.channels.map((c) => [c.channelId, c]));
  const refunds = snapshot.refunds.filter((r) => r.orderId === orderId);

  return (
    <Drawer open={open} title={<span>订单依据回查 <span className="mono">{orderId}</span></span>} onClose={onClose}>
      {order.scenarioTag && <div className="notice info"><span className="tag-scenario">{order.scenarioTag}</span></div>}

      <div className="card tight">
        <div className="card-title">订单与净额版本 <span className="hint">数据版本 {version.dataVersion}</span></div>
        <KeyValue
          rows={[
            ['下单时间', `${formatDateTime(order.orderTime, order.orderTimezone)}（原始时区 ${order.orderTimezone}）`],
            ['人员标识', order.personId ?? <span className="badge purple">无授权人员标识</span>],
            ['设备', <span className="mono">{order.deviceId}</span>],
            ['订单状态', version.status],
            ['毛额', formatCny(version.grossAmount)],
            ['累计退款', `${formatCny(version.refundedAmount)}（${version.refundIds.join('、') || '无'}）`],
            ['净额（分配基数）', <strong>{formatCny(version.netAmount)}</strong>],
          ]}
        />
      </div>

      {refunds.length > 0 && (
        <div className="card tight">
          <div className="card-title">退款流水（可能晚于广告回传）</div>
          <table>
            <thead><tr><th>退款单号</th><th>金额</th><th>退款时间</th><th>原因</th><th>数据版本</th></tr></thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.refundId}>
                  <td className="mono">{r.refundId}</td>
                  <td className="num">{formatCny(r.amount)}</td>
                  <td className="small">{formatDateTime(r.refundTime)}</td>
                  <td className="small">{r.reason}</td>
                  <td className="mono">{r.dataVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card tight">
        <div className="card-title">
          触点旅程与资格判定
          <span className="hint">
            {run ? `模型窗口 ${run.config.windowDays} 天 · 规则修订 ${run.config.ruleRevision}` : '选择运行后展示资格判定'}
          </span>
        </div>
        {tps.length === 0 ? (
          <div className="empty">该订单没有任何订单级触点（平台点击汇总无法关联到本订单）</div>
        ) : (
          <div style={{ paddingLeft: 4 }}>
            {tps.map((t) => {
              const line = oa?.allocations.find((a) => a.touchpointId === t.touchpointId);
              const eligible = eligibleIds.has(t.touchpointId);
              return (
                <div key={t.touchpointId} className={`timeline-item${eligible ? '' : ' warn'}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{channelMap.get(t.channelId)?.name ?? t.channelId} · {t.campaignName}</strong>
                    {run && (
                      eligible
                        ? <span className="badge green">合格 {line ? `· 权重 ${(line.weight * 100).toFixed(1)}% · ${formatCny(line.amount)}` : ''}</span>
                        : <span className="badge red">排除</span>
                    )}
                  </div>
                  <div className="t-time">
                    {formatDateTime(t.eventTime, t.eventTimezone)}（{t.eventTimezone}）· {t.eventType === 'click' ? '点击' : '曝光'} ·{' '}
                    <span className="mono">{t.touchpointId}</span> · 设备 {t.deviceId} · 标识 {t.identityKind}
                    {t.identityAuthorized ? '（已授权）' : '（未授权）'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {decision.reasons.length > 0 && (
          <div className="notice warn" style={{ marginTop: 10 }}>
            <div>
              <strong>排除依据：</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {decision.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          </div>
        )}
        {oa?.unknown && (
          <div className="notice error" style={{ marginTop: 10 }}>
            本单计入<strong>未知来源</strong>：{oa.excluded}。金额 {formatCny(oa.netAmount)} 单列，不进入任何渠道份额。
          </div>
        )}
      </div>
    </Drawer>
  );
}
