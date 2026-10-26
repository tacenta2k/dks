import { useEffect, useMemo, useRef, useState } from 'react';

import { formatDisplayDate, formatLocalDateTime } from '../../lib/date';
import {
  dedupeNotifications,
  isNotificationSnoozed,
  notificationStableKey,
  type ExpiryNotificationRecord,
  type NotificationRecord,
  type OfficeDeleteNotificationRecord,
  type SnoozeDuration,
  type SummaryNotificationRecord,
} from './alert-service';

export interface NotificationBellProps {
  notifications: readonly NotificationRecord[];
  onMarkRead?: (id: string) => void;
  /**
   * Called with the dismissed record's REAL id. Dedupe keys stay INTERNAL to
   * this component/the store layer: callers expand one id to every duplicate
   * of the same logical alert when persisting, but the id is never replaced.
   */
  onDismiss?: (id: string) => void;
  onClearAll?: () => void;
  onView?: (record: OfficeDeleteNotificationRecord) => void;
  onRestore?: (record: OfficeDeleteNotificationRecord) => void;
  onSnooze?: (record: NotificationRecord, duration: SnoozeDuration) => void;
}

/**
 * R2-02 — snooze choices depend on how long is actually left.
 *   D >= 7      → 1 day, 3 days, 1 week
 *   3 <= D < 7  → 1 day, 3 days
 *   1 <= D < 3  → 1 day
 *   D <= 0      → no snooze at all
 * A snooze is never offered for longer than the time left.
 */
export function snoozeOptionsForDaysLeft(daysLeft: number): SnoozeDuration[] {
  if (!Number.isFinite(daysLeft) || daysLeft <= 0) {
    return [];
  }
  if (daysLeft < 3) {
    return ['1d'];
  }
  if (daysLeft < 7) {
    return ['1d', '3d'];
  }
  return ['1d', '3d', '1w'];
}

const SNOOZE_LABELS: Record<Exclude<SnoozeDuration, 'custom'>, string> = {
  '1d': 'Snooze 1 day',
  '3d': 'Snooze 3 days',
  '1w': 'Snooze 1 week',
};

function expiryLabel(record: ExpiryNotificationRecord): string {
  // body = "<record label> expires in N days." / "<record label> expires today."
  // Strip only that exact generated suffix so a label that itself contains
  // the word "expires" is not truncated. Never fall back to the raw row id.
  const label = record.body.replace(/\s+expires (?:today|in \d+ days?)\.$/i, '').trim();
  return label && label !== record.rowId ? label : 'Unnamed record';
}

function isSnoozed(record: NotificationRecord): boolean {
  return isNotificationSnoozed(record);
}

function primaryLine(record: NotificationRecord): string {
  return record.body || record.title;
}

function secondaryLine(record: NotificationRecord): string {
  if (record.kind === 'expiry') {
    return `${expiryLabel(record)} · ${formatDisplayDate(record.expiryValue)}`;
  }
  if (record.kind === 'office-delete') {
    return `${record.rowLabel} · ${formatLocalDateTime(record.createdAt)}`;
  }
  return formatDisplayDate(record.summaryDate);
}

export function unreadNotificationCount(notifications: readonly NotificationRecord[]): number {
  // Logical alerts only: duplicate records of the same alert count once.
  return dedupeNotifications(notifications).filter((notification) => (
    notification.read !== true && notification.dismissed !== true && !isSnoozed(notification)
  )).length;
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5z" />
      <path d="M10 18.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

/** Compact notification centre popover (identical for Admin and Office). */
export function NotificationBell({
  notifications,
  onMarkRead,
  onDismiss,
  onClearAll,
  onView,
  onRestore,
  onSnooze,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const unreadCount = unreadNotificationCount(notifications);
  // Dedupe FIRST (one card per logical alert, newest state wins), then hide
  // dismissed/snoozed — so the surviving representative decides visibility.
  const visible = useMemo(
    () => dedupeNotifications(notifications).filter((notification) => (
      notification.dismissed !== true && !isSnoozed(notification)
    )),
    [notifications],
  );

  const sectionRef = useRef<HTMLElement>(null);
  // FIXES_UI §3.3 / R2-02: Escape or clicking outside the bell closes the
  // popover; the bell button itself toggles it closed.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (sectionRef.current && target && !sectionRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return (
    <section className="notification-bell" aria-label="Notifications" ref={sectionRef}>
      <button
        className="notification-bell__button"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        title="Notifications"
        onClick={() => setOpen((current) => !current)}
      >
        <BellIcon />
        {unreadCount > 0 ? (
          <span className="notification-bell__badge" aria-label={`${unreadCount} unread`}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="notification-bell__panel" role="dialog" aria-label="Notifications">
          <header className="notification-bell__header">
            <strong>Notifications</strong>
            <span className="notification-bell__count">
              {unreadCount} unread
            </span>
            {/* Compact one-tap clear: dismisses everything currently listed
                (persisted via the same Dismiss plumbing per alert). */}
            {visible.length > 0 && onClearAll ? (
              <button
                className="notification-bell__clear-all"
                type="button"
                onClick={onClearAll}
              >
                Clear all
              </button>
            ) : null}
          </header>

          {visible.length === 0 ? (
            <p className="notification-bell__empty">No notifications</p>
          ) : (
            <ul className="notification-bell__list">
              {visible.map((notification) => {
                const unread = notification.read !== true;
                // The list key is the stable DEDUPE key; every action speaks
                // the record's real id so persistence always targets a store
                // row (callers expand one logical alert to all duplicates).
                const stableKey = notificationStableKey(notification);
                const snoozeOptions = notification.kind === 'expiry'
                  ? snoozeOptionsForDaysLeft(notification.daysLeft)
                  : [];
                return (
                  <li
                    className={`notification-bell__item${unread ? ' notification-bell__item--unread' : ''}`}
                    key={stableKey}
                    data-kind={notification.kind}
                  >
                    <p className="notification-bell__message">{primaryLine(notification)}</p>
                    <p className="notification-bell__meta">{secondaryLine(notification)}</p>
                    <div className="notification-bell__actions">
                      {notification.kind === 'office-delete' ? (
                        <>
                          {onView ? (
                            <button
                              className="notification-bell__action"
                              type="button"
                              onClick={() => onView(notification)}
                            >
                              View
                            </button>
                          ) : null}
                          {onRestore ? (
                            <button
                              className="notification-bell__action"
                              type="button"
                              onClick={() => onRestore(notification)}
                            >
                              Restore
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {unread ? (
                            <button
                              className="notification-bell__action"
                              type="button"
                              onClick={() => onMarkRead?.(notification.id)}
                            >
                              Mark read
                            </button>
                          ) : null}
                          {notification.kind === 'expiry' && onSnooze
                            ? snoozeOptions.map((duration) => (
                              <button
                                className="notification-bell__action"
                                type="button"
                                key={duration}
                                onClick={() => onSnooze(notification, duration)}
                              >
                                {SNOOZE_LABELS[duration as Exclude<SnoozeDuration, 'custom'>]}
                              </button>
                            ))
                            : null}
                        </>
                      )}
                      {/* EVERY item keeps a compact Dismiss — including expiry
                          alerts, read state and daysLeft <= 0 alike. Dismiss
                          always addresses the RECORD ID (a real store row);
                          the app layer resolves its logical-alert siblings. */}
                      <button
                        className="notification-bell__action"
                        type="button"
                        onClick={() => onDismiss?.(notification.id)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

export type { ExpiryNotificationRecord, SummaryNotificationRecord };
export default NotificationBell;
