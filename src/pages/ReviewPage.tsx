import { useState } from 'react';
import { EmptyState, KeyValue, Modal } from '@/components/ui';
import { SupportBadge, pct, pp } from '@/components/evalUi';
import { formatCny, formatDateTime } from '@/lib/format';
import { ALLOWED_USE_LABELS, REVIEW_STATUS_LABELS, SEGMENT_LABELS } from '@/types/evaluation';
import type { ReviewRecord, SegmentKey } from '@/types/evaluation';
import { checkRefCurrent } from '@/engine/registry';
import { useAppStore } from '@/store/useAppStore';

export default function ReviewPage() {
  const store = useAppStore();
  const isOwner = store.currentUserId === 'U-2001';
  const [openReview, setOpenReview] = useState<ReviewRecord | null>(null);
  const [revoking, setRevoking] = useState<ReviewRecord | null>(null);
  const [reason, setReason] = useState('模型修订调整，旧结论仅保留回看');
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const notify = (kind: 'success' | 'error' | 'info', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 5000);
  };

  const reviewValidity = (review: ReviewRecord) => {
    if (review.status === 'revoked') return { ok: false, reason: '已撤回，不能作为新分析的有效性证明' };
    for (const ref of review.modelRefs) {
      const entry = store.modelRegistry.find((m) => m.registryId === ref.registryId);
      const check = checkRefCurrent(entry, ref);
      if (!check.ok) return { ok: false, reason: check.reason };
      if (entry?.status === 'retired') return { ok: false, reason: `模型 ${entry.name} 已停用` };
    }
    const def = store.sampleDefinitions.find((d) => d.sampleId === review.sampleId);
    if (!def) return { ok: false, reason: '样本已不存在' };
    if (def.revision !== review.sampleRevision) return { ok: false, reason: `样本已更新到 rev${def.revision}` };
    return { ok: true, reason: '模型修订与样本哈希仍一致' };
  };

  return (
    <>
      <div className="notice info">
        <div>
          <strong>审查记录引用确定的模型与样本：</strong>批准和发布前都会重新检查模型修订与样本修订/哈希。
          撤回后旧报告仍可回看，但<strong>不能供新分析作为有效性证明</strong>；发布与撤回并发时，发布前复核会阻断。
        </div>
      </div>
      {toast && <div className={`notice ${toast.kind === 'error' ? 'error' : toast.kind === 'info' ? 'info' : 'success'}`}>{toast.text}</div>}

      <div className="card">
        <div className="card-title">审查记录列表 <span className="hint">状态独立：待审批 → 已批准 → 已发布；撤回不删除冻结结果</span></div>
        {store.reviews.length === 0 ? (
          <EmptyState text="暂无审查记录，请在「模型评估 → 评估结果」页对已完成评估生成审查" />
        ) : (
          <table>
            <thead><tr><th>审查</th><th>标题</th><th>样本</th><th>模型修订</th><th>状态</th><th>当前有效性</th><th>创建</th><th>操作</th></tr></thead>
            <tbody>
              {store.reviews.map((r) => {
                const validity = reviewValidity(r);
                return (
                  <tr key={r.reviewId}>
                    <td className="mono">{r.reviewId}</td>
                    <td>{r.title}<div className="small muted">{r.evalId}</div></td>
                    <td className="small"><span className="mono">{r.sampleId}</span><div className="muted">rev{r.sampleRevision} · {r.sampleHash.slice(0, 8)}</div></td>
                    <td className="small">{r.modelRefs.map((m) => `${m.name}@${m.revision}`).join(' / ')}</td>
                    <td><ReviewStatusBadge status={r.status} /></td>
                    <td>{r.status === 'revoked' ? <span className="badge red">不可用于新分析</span> : validity.ok ? <span className="badge green">可复核</span> : <span className="badge orange">{validity.reason}</span>}</td>
                    <td className="small">{formatDateTime(r.createdAt)}</td>
                    <td>
                      <div className="pill-row">
                        <button className="sm" onClick={() => setOpenReview(r)}>查看冻结内容</button>
                        {r.status === 'draft' && isOwner && <button className="sm primary" onClick={() => { const x = store.approveReview(r.reviewId, store.currentUserId); notify(x.ok ? 'success' : 'error', x.message); }}>批准</button>}
                        {r.status === 'approved' && isOwner && <button className="sm primary" onClick={() => { const x = store.publishReview(r.reviewId, store.currentUserId); notify(x.ok ? 'success' : 'error', x.message); }}>发布</button>}
                        {(r.status === 'approved' || r.status === 'published') && isOwner && <button className="sm danger" onClick={() => setRevoking(r)}>撤回</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!isOwner && <div className="small muted" style={{ marginTop: 8 }}>当前为分析师身份：可查看审查；批准、发布与撤回限投放负责人（赵明）。</div>}
      </div>

      <FrozenReviewModal review={openReview} onClose={() => setOpenReview(null)} />

      <Modal open={!!revoking} title={<span>撤回审查 <span className="mono">{revoking?.reviewId}</span></span>} onClose={() => setRevoking(null)}>
        <div className="notice warn">撤回后：旧报告仍可回看，但 validForNewAnalysis=false，不得作为新分析的有效性证明；冻结结果保留可审计。</div>
        <label className="field">撤回原因 <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></label>
        <div className="modal-foot">
          <button onClick={() => setRevoking(null)}>取消</button>
          <button className="danger" onClick={() => {
            if (!revoking) return;
            const x = store.revokeReview(revoking.reviewId, store.currentUserId, reason);
            notify(x.ok ? 'success' : 'error', x.message);
            if (x.ok) setRevoking(null);
          }}>确认撤回</button>
        </div>
      </Modal>
    </>
  );
}

function ReviewStatusBadge({ status }: { status: ReviewRecord['status'] }) {
  const tone = status === 'draft' ? 'gray' : status === 'approved' ? 'purple' : status === 'published' ? 'green' : 'red';
  return <span className={`badge ${tone}`}>{REVIEW_STATUS_LABELS[status]}</span>;
}

function FrozenReviewModal({ review, onClose }: { review: ReviewRecord | null; onClose: () => void }) {
  const store = useAppStore();
  const [segmentKey, setSegmentKey] = useState<SegmentKey>('region');
  if (!review) return null;
  const frozen = review.frozen;

  return (
    <Modal open wide title={<span>审查冻结内容 <span className="mono">{review.reviewId}</span></span>} onClose={onClose}>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card tight">
          <div className="card-title">引用与状态</div>
          <KeyValue rows={[
            ['状态', <ReviewStatusBadge status={review.status} />],
            ['是否可用于新分析', review.validForNewAnalysis ? <span className="badge green">可</span> : <span className="badge red">否 · {review.invalidationReason ?? '已失效'}</span>],
            ['评估', <span className="mono">{review.evalId}</span>],
            ['样本', `${review.sampleId}@rev${review.sampleRevision}`],
            ['样本哈希', <span className="mono">{review.sampleHash}</span>],
            ['模型 A', <span>{review.modelRefs[0]?.name}@{review.modelRefs[0]?.revision}<div className="mono small">{review.modelRefs[0]?.revisionHash}</div></span>],
            ['模型 B', <span>{review.modelRefs[1]?.name}@{review.modelRefs[1]?.revision}<div className="mono small">{review.modelRefs[1]?.revisionHash}</div></span>],
            ['批准', review.approvedAt ? `${formatDateTime(review.approvedAt)} · ${review.approvedBy}` : '—'],
            ['发布', review.publishedAt ? formatDateTime(review.publishedAt) : '—'],
            ['撤回', review.revokedAt ? `${formatDateTime(review.revokedAt)} · ${review.revokeReason}` : '—'],
          ]} />
          {review.publishBlockedReason && <div className="notice error" style={{ marginTop: 10 }}>发布阻断：{review.publishBlockedReason}</div>}
        </div>

        <div className="card tight">
          <div className="card-title">审计轨迹</div>
          <div className="small">
            {review.audit.map((a, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <span className="mono muted">{formatDateTime(a.at)}</span> · <span className={`badge ${a.action.includes('blocked') ? 'red' : a.action === 'revoked' ? 'orange' : 'gray'}`}>{a.action}</span> · {a.by}
                <div className="muted">{a.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {!frozen ? (
        <div className="notice warn">审查尚未批准，冻结结果尚未生成（批准时复制评估结果）。</div>
      ) : (
        <>
          <div className="grid cols-3">
            <div className="stat"><div className="label">净收入</div><div className="value">{formatCny(frozen.totalNet)}</div><div className="sub">冻结时点</div></div>
            <div className="stat"><div className="label">已分配 A / B</div><div className="value" style={{ fontSize: 16 }}>{formatCny(frozen.totalAttributedA)} / {formatCny(frozen.totalAttributedB)}</div><div className="sub">未知 A {formatCny(frozen.unknownAmountA)}</div></div>
            <div className="stat"><div className="label">稳定性结论</div><div className="value" style={{ fontSize: 16 }}>{frozen.supportedPoints}/{frozen.stabilityPoints} 可下结论</div><div className="sub">{frozen.unsupportedPoints} 项不支持结论</div></div>
          </div>

          <div className="card tight">
            <div className="card-title">冻结的渠道份额与守恒</div>
            <table>
              <thead><tr><th>渠道</th><th className="num">A 金额</th><th className="num">A 份额</th><th className="num">B 金额</th><th className="num">B 份额</th><th>A 结论</th></tr></thead>
              <tbody>
                {frozen.channelSharesA.map((a) => {
                  const b = frozen.channelSharesB.find((x) => x.channelId === a.channelId);
                  return (
                    <tr key={a.channelId}>
                      <td>{a.name}</td>
                      <td className="num">{formatCny(a.amount)}</td>
                      <td className="num">{a.covered ? pct(a.share) : '—'}</td>
                      <td className="num">{b ? formatCny(b.amount) : '—'}</td>
                      <td className="num">{b?.covered ? pct(b.share) : '—'}</td>
                      <td><SupportBadge state={a.support} reason={a.supportReason} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="small muted" style={{ marginTop: 6 }}>守恒 A {frozen.conservationA ? '✓' : '✕'} / B {frozen.conservationB ? '✓' : '✕'}；冻结于 {formatDateTime(frozen.frozenAt)}。</div>
          </div>

          <div className="card tight">
            <div className="card-title">冻结的分群下钻</div>
            <div className="pill-row" style={{ marginBottom: 8 }}>
              {(Object.keys(SEGMENT_LABELS) as SegmentKey[]).filter((k) => frozen.segments[k]).map((k) => (
                <button key={k} className={`sm ${segmentKey === k ? 'primary' : ''}`} onClick={() => setSegmentKey(k)}>{SEGMENT_LABELS[k]}</button>
              ))}
            </div>
            <table>
              <thead><tr><th>分群</th><th className="num">订单</th><th>渠道</th><th className="num">A 份额</th><th className="num">B 份额</th><th className="num">Δ</th></tr></thead>
              <tbody>
                {frozen.segments[segmentKey]?.cells.map((cell) => cell.channels.map((ch, i) => (
                  <tr key={`${cell.value}-${ch.channelId}`}>
                    {i === 0 && <td rowSpan={cell.channels.length}>{cell.value}</td>}
                    {i === 0 && <td rowSpan={cell.channels.length} className="num">{cell.orders}</td>}
                    <td className="small">{ch.name}</td>
                    <td className="num">{ch.shareA === null ? '—' : pct(ch.shareA)}</td>
                    <td className="num">{ch.shareB === null ? '—' : pct(ch.shareB)}</td>
                    <td className="num">{ch.delta === null ? '—' : pp(ch.delta)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>

          {frozen.comparisons.length > 0 && (
            <div className="card tight">
              <div className="card-title">冻结的版本对照</div>
              <table>
                <thead><tr><th>对照</th><th>基准</th><th>对照</th><th className="num">净额 Δ</th><th className="num">变化订单</th><th>结论</th></tr></thead>
                <tbody>
                  {frozen.comparisons.map((c, i) => (
                    <tr key={i}>
                      <td>{c.label}</td>
                      <td className="small">{c.base.sampleId}@rev{c.base.sampleRevision} / {c.base.modelLabel}</td>
                      <td className="small">{c.alt.sampleId}@rev{c.alt.sampleRevision} / {c.alt.modelLabel}</td>
                      <td className="num">{formatCny(c.netDelta)}</td>
                      <td className="num">{c.changedOrderCount}</td>
                      <td><SupportBadge state={c.support} reason={c.supportReason} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {frozen.drift && (
            <div className="card tight">
              <div className="card-title">随附漂移监测（独立窗口，不并入版本结论）</div>
              <div className="small muted">{frozen.drift.note}</div>
            </div>
          )}

          <div className="notice warn" style={{ marginBottom: 0 }}>
            审查上限：所有冻结结果均为规则分摊与稳定性描述，<strong>不构成准确率、因果效果或投放调整依据</strong>。
          </div>
        </>
      )}

      <div className="small muted" style={{ marginTop: 10 }}>
        当前登记用途：{review.modelRefs.map((m) => `${m.name}：${m.allowedUses.map((u) => ALLOWED_USE_LABELS[u]).join('、')}`).join('；')}
        {store.reviews.some((r) => r.supersededBy === review.reviewId) && '；该审查已被后续样本修订的审查标记替代（旧结果保持可回看）。'}
      </div>
    </Modal>
  );
}
