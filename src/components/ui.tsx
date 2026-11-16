import type { ReactNode } from 'react';
import { STATUS_COLORS, STATUS_LABELS } from '@/lib/constants';
import type { RunStatus } from '@/types/domain';

const toneMap: Record<RunStatus, string> = {
  draft: 'gray',
  running: 'blue',
  completed: 'purple',
  locked: 'green',
  superseded: 'orange',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${toneMap[status]}`}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLORS[status] }} />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="sm" onClick={onClose}>关闭</button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="sm" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="empty">— {text} —</div>;
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
