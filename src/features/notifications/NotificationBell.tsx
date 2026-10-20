import { useMemo, useState } from 'react';

import type {
  NotificationRecord,
  SnoozeDuration,
} from './alert-service';

export interface NotificationBellProps {
  notifications: readonly NotificationRecord[];
  onMarkRead?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onSnooze?: (record: NotificationRecord, duration: SnoozeDuration, customUntil?: string) => void;
}

function notificationLabel(record: NotificationRecord): string {
  return record.kind === 'expiry' ? record.title : record.title;
}

/** A small controlled notification centre surface for the renderer shell. */
export function NotificationBell({
  notifications,
  onMarkRead,
  onDismiss,
  onSnooze,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [customUntil, setCustomUntil] = useState<Record<string, string>>({});
  const unreadCount = notifications.filter((notification) => (
    notification.read !== true
    && notification.dismissed !== true
    && !(notification.kind === 'expiry' && notification.snoozedUntil && new Date(notification.snoozedUntil).getTime() > Date.now())
  )).length;
  const visible = useMemo(
    () => [...notifications].filter((notification) => (
      notification.dismissed !== true
      && !(notification.kind === 'expiry' && notification.snoozedUntil && new Date(notification.snoozedUntil).getTime() > Date.now())
    )),
    [notifications],
  );

  return (
    <section className="notification-bell" aria-label="Notifications">
      <button
        className="notification-bell__button"
        type="button"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 ? (
          <span className="notification-bell__badge" aria-label={`${unreadCount} unread`}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="notification-bell__panel" role="dialog" aria-label="Notification centre">
          <header className="notification-bell__header">
            <strong>Notifications</strong>
            <span>{unreadCount} unread</span>
          </header>
          {visible.length === 0 ? (
            <p className="notification-bell__empty">No notifications</p>
          ) : (
            <ul className="notification-bell__list">
              {visible.map((notification) => (
                <li
                  className={`notification-bell__item${notification.read ? '' : ' notification-bell__item--unread'}`}
                  key={notification.id}
                >
                  <strong>{notificationLabel(notification)}</strong>
                  <p>{notification.body}</p>
                  <div className="notification-bell__actions">
                    {!notification.read ? (
                      <button type="button" onClick={() => onMarkRead?.(notification.id)}>
                        Mark read
                      </button>
                    ) : null}
                    {notification.kind === 'expiry' && onSnooze ? (
                      <>
                        <button type="button" onClick={() => onSnooze(notification, '1d')}>Snooze 1d</button>
                        <button type="button" onClick={() => onSnooze(notification, '3d')}>Snooze 3d</button>
                        <button type="button" onClick={() => onSnooze(notification, '1w')}>Snooze 1w</button>
                        <input
                          aria-label={`Custom snooze for ${notification.rowId}`}
                          type="datetime-local"
                          value={customUntil[notification.id] ?? ''}
                          onChange={(event) => setCustomUntil((current) => ({
                            ...current,
                            [notification.id]: event.target.value,
                          }))}
                        />
                        <button
                          type="button"
                          disabled={!customUntil[notification.id]}
                          onClick={() => {
                            const value = customUntil[notification.id];
                            if (!value) {
                              return;
                            }
                            const parsed = new Date(value);
                            if (!Number.isNaN(parsed.getTime())) {
                              onSnooze(notification, 'custom', parsed.toISOString());
                            }
                          }}
                        >
                          Snooze custom
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={() => onDismiss?.(notification.id)}>
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default NotificationBell;
