import { useState } from 'react';
import type { Toast } from '../state/store';
import { useApp } from '../state/store';
import { Modal } from './Overlays';

function NoticeIcon({ tone }: { tone: Toast['tone'] }) {
  if (tone === 'success') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.3" />
        <path d="m5.2 8.2 1.9 1.9 3.8-4" />
      </svg>
    );
  }
  if (tone === 'error') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.8 15 14H1L8 1.8Z" />
        <path d="M8 6v3.4M8 11.6h.01" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.2v3.6M8 4.9h.01" />
    </svg>
  );
}

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function NoticeCard({
  notice,
  onDismiss,
  showLink = false,
}: {
  notice: Toast;
  onDismiss?: () => void;
  showLink?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleNotifications = useApp((s) => s.toggleNotifications);

  return (
    <div className={`notice notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <div className="notice-head">
        <span className="notice-icon">
          <NoticeIcon tone={notice.tone} />
        </span>
        <span className="notice-title">{notice.title}</span>
        <span className="notice-time">{timeOf(notice.at)}</span>
        {onDismiss && (
          <button className="notice-close" title="Dismiss" onClick={onDismiss}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="m3 3 6 6M9 3l-6 6" />
            </svg>
          </button>
        )}
      </div>
      <div className="notice-message">{notice.message}</div>
      {notice.detail && (
        <>
          <button className="notice-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded && <pre className="notice-detail">{notice.detail}</pre>}
        </>
      )}
      {showLink && (
        <button className="notice-link" onClick={() => toggleNotifications(true)}>
          View all notifications →
        </button>
      )}
      {notice.duration > 0 && onDismiss && (
        <div className="notice-timer" style={{ animationDuration: `${notice.duration}ms` }} />
      )}
    </div>
  );
}

/** Live stack in the bottom-right corner. */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const notifications = useApp((s) => s.notifications);
  const dismissToast = useApp((s) => s.dismissToast);
  const toggleNotifications = useApp((s) => s.toggleNotifications);

  if (!notifications.length) return null;
  return (
    <div className="notices" aria-live="polite">
      {toasts.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onDismiss={() => dismissToast(notice.id)} showLink />
      ))}
      {notifications.length > toasts.length && (
        <button className="notices-history" onClick={() => toggleNotifications(true)}>
          {notifications.length} notification{notifications.length === 1 ? '' : 's'} this session · view all
        </button>
      )}
    </div>
  );
}

type Filter = 'all' | 'error' | 'success';

/** Full session history with filters; opened from the status bar or a toast. */
export function NotificationCenter() {
  const open = useApp((s) => s.notificationsOpen);
  const toggleNotifications = useApp((s) => s.toggleNotifications);
  const notifications = useApp((s) => s.notifications);
  const clearNotifications = useApp((s) => s.clearNotifications);
  const [filter, setFilter] = useState<Filter>('all');

  if (!open) return null;
  const shown = notifications.filter((n) => filter === 'all' || n.tone === filter);
  const errors = notifications.filter((n) => n.tone === 'error').length;

  return (
    <Modal
      title="Notifications"
      wide
      onClose={() => toggleNotifications(false)}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {notifications.length} total{errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
          </span>
          <button className="btn btn--ghost" disabled={!notifications.length} onClick={clearNotifications}>
            Clear all
          </button>
          <button className="btn btn--primary" onClick={() => toggleNotifications(false)}>
            Done
          </button>
        </>
      }
    >
      <div className="notice-filters">
        {(['all', 'error', 'success'] as const).map((value) => (
          <button
            key={value}
            className={`btn ${filter === value ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? 'All' : value === 'error' ? 'Errors' : 'Successes'}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="pf-empty">
          <div className="pf-empty-title">Nothing here yet</div>
          <div>
            {filter === 'all'
              ? 'Actions such as applying YAML, deleting resources and importing kubeconfigs will be listed here.'
              : `No ${filter === 'error' ? 'errors' : 'successes'} recorded in this session.`}
          </div>
        </div>
      ) : (
        <div className="notice-history">
          {shown.map((notice) => (
            <NoticeCard key={notice.id} notice={notice} />
          ))}
        </div>
      )}
    </Modal>
  );
}
