import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import {
  NotificationBell,
  snoozeOptionsForDaysLeft,
  unreadNotificationCount,
} from '../src/features/notifications/NotificationBell';
import {
  dedupeNotifications,
  notificationStableKey,
  type ExpiryNotificationRecord,
  type OfficeDeleteNotificationRecord,
} from '../src/features/notifications/alert-service';

function expiryAlert(daysLeft: number, overrides: Partial<ExpiryNotificationRecord> = {}): ExpiryNotificationRecord {
  return {
    id: `expiry:row-${daysLeft}:${daysLeft}`,
    kind: 'expiry',
    rowId: 'row-1',
    expiryColumnId: 'visa_expiry',
    expiryValue: '2026-01-08',
    daysLeft,
    alertDay: daysLeft,
    dedupeKey: `expiry:row-${daysLeft}:${daysLeft}`,
    title: daysLeft === 0 ? 'Expiry due today' : 'Expiry reminder',
    body: `Amina expires in ${daysLeft} days.`,
    createdAt: '2026-01-01T09:00:00.000Z',
    read: false,
    dismissed: false,
    ...overrides,
  };
}

const deletionAlert: OfficeDeleteNotificationRecord = {
  id: 'admin-notification-1',
  kind: 'office-delete',
  entryId: 'entry-1',
  rowLabel: 'Amina',
  title: 'Office deleted',
  body: 'Office deleted Amina on 2026-01-01 10:30',
  createdAt: '2026-01-01T10:30:00.000Z',
  read: false,
  dismissed: false,
};

function openBell() {
  fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));
}

describe('notification popover (R2-02)', () => {
  it('offers snooze lengths that never exceed the time left', () => {
    expect(snoozeOptionsForDaysLeft(30)).toEqual(['1d', '3d', '1w']);
    expect(snoozeOptionsForDaysLeft(7)).toEqual(['1d', '3d', '1w']);
    expect(snoozeOptionsForDaysLeft(6)).toEqual(['1d', '3d']);
    expect(snoozeOptionsForDaysLeft(3)).toEqual(['1d', '3d']);
    expect(snoozeOptionsForDaysLeft(2)).toEqual(['1d']);
    expect(snoozeOptionsForDaysLeft(1)).toEqual(['1d']);
    expect(snoozeOptionsForDaysLeft(0)).toEqual([]);
    expect(snoozeOptionsForDaysLeft(-4)).toEqual([]);
  });

  it('renders one compact button row per expiry alert, driven by days left', () => {
    render(<NotificationBell notifications={[expiryAlert(7)]} onSnooze={vi.fn()} onMarkRead={vi.fn()} />);
    openBell();

    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 1 day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 3 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 1 week' })).toBeInTheDocument();
    // No native date input and no custom snooze control.
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /custom/i })).not.toBeInTheDocument();
  });

  it('shows fewer snoozes as the deadline approaches and only Mark read when due', () => {
    const { rerender } = render(
      <NotificationBell notifications={[expiryAlert(3)]} onSnooze={vi.fn()} onMarkRead={vi.fn()} />,
    );
    openBell();
    expect(screen.queryByRole('button', { name: 'Snooze 1 week' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 3 days' })).toBeInTheDocument();

    rerender(
      <NotificationBell notifications={[expiryAlert(1)]} onSnooze={vi.fn()} onMarkRead={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Snooze 3 days' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 1 day' })).toBeInTheDocument();

    rerender(
      <NotificationBell notifications={[expiryAlert(0)]} onSnooze={vi.fn()} onMarkRead={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /Snooze/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
  });

  it('shows a one-line message plus a record · date secondary line', () => {
    render(<NotificationBell notifications={[expiryAlert(7)]} />);
    openBell();

    expect(screen.getByText('Amina expires in 7 days.')).toBeInTheDocument();
    expect(screen.getByText('Amina · 08/01/2026')).toBeInTheDocument();
    expect(screen.getByText('1 unread')).toBeInTheDocument();
  });

  it('keeps the popover open and the item in place after one action', () => {
    const onSnooze = vi.fn();
    render(
      <NotificationBell notifications={[expiryAlert(7)]} onSnooze={onSnooze} onMarkRead={vi.fn()} />,
    );
    openBell();
    fireEvent.click(screen.getByRole('button', { name: 'Snooze 1 day' }));

    expect(onSnooze).toHaveBeenCalledWith(expect.objectContaining({ id: expiryAlert(7).id }), '1d');
    // Popover still open, remaining buttons still there.
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze 1 week' })).toBeInTheDocument();
  });

  it('keeps View / Restore / Dismiss for admin deletion alerts', () => {
    const onView = vi.fn();
    const onRestore = vi.fn();
    const onDismiss = vi.fn();
    render(
      <NotificationBell
        notifications={[deletionAlert]}
        onView={onView}
        onRestore={onRestore}
        onDismiss={onDismiss}
      />,
    );
    openBell();

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onView).toHaveBeenCalledWith(deletionAlert);
    expect(onRestore).toHaveBeenCalledWith(deletionAlert);
    // Dismiss addresses the LOGICAL alert (stable key) so every persisted
    // duplicate of the entry's deletion notice disappears at once.
    expect(onDismiss).toHaveBeenCalledWith('office-delete:entry-1');
    expect(notificationStableKey(deletionAlert)).toBe('office-delete:entry-1');
    expect(screen.queryByRole('button', { name: /Snooze/ })).not.toBeInTheDocument();
  });

  it('toggles closed on the bell, and closes on Escape and outside click', () => {
    render(<NotificationBell notifications={[expiryAlert(7)]} />);

    const bell = screen.getByRole('button', { name: /Notifications/i });
    fireEvent.click(bell);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    fireEvent.click(bell);
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();

    fireEvent.click(bell);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();

    fireEvent.click(bell);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('counts unread alerts while ignoring dismissed and snoozed ones', () => {
    const snoozed = expiryAlert(7, { snoozedUntil: '2999-01-01T00:00:00.000Z' });
    const read = expiryAlert(3, { read: true });
    const dismissed = expiryAlert(1, { dismissed: true });
    expect(unreadNotificationCount([expiryAlert(7), read, dismissed, snoozed])).toBe(1);
  });

  it('lists the item without bullet markers (no list markers in the panel)', () => {
    render(<NotificationBell notifications={[expiryAlert(7)]} />);
    openBell();
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveClass('notification-bell__list');
  });

  it('shows exactly ONE card per logical alert even for duplicated records', () => {
    // The reported bug: "sasi expires today." appeared twice — two records of
    // the same alert under different ids (a renewed expiry value re-issued
    // the alert for the same row/milestone).
    const staleRenewal = expiryAlert(0, {
      id: 'expiry:row-0:2026-01-01:0',
      dedupeKey: 'expiry:row-0:2026-01-01:0',
      expiryValue: '2026-01-01',
      createdAt: '2025-12-30T09:00:00.000Z', // older evaluation
    });
    const current = expiryAlert(0, {
      id: 'expiry:row-0:2026-01-08:0',
      dedupeKey: 'expiry:row-0:2026-01-08:0',
      createdAt: '2026-01-01T09:00:00.000Z', // newest state wins
    });
    expect(notificationStableKey(staleRenewal)).toBe(notificationStableKey(current));

    render(<NotificationBell notifications={[staleRenewal, current]} />);
    openBell();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByText('Amina expires in 0 days.')).toHaveLength(1);
    // …and the surviving card is the newest state.
    const kept = dedupeNotifications([staleRenewal, current]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(current.id);
    expect((kept[0] as { expiryValue?: string }).expiryValue).toBe('2026-01-08');
  });

  it('every item keeps a compact Dismiss — expiry alerts included, read state and daysLeft = 0 alike', () => {
    const onDismiss = vi.fn();
    render(
      <NotificationBell
        notifications={[
          expiryAlert(0), // due today: no snoozes exist, Dismiss must remain
          expiryAlert(1, { read: true }), // read: still dismissible
        ]}
        onDismiss={onDismiss}
      />,
    );
    openBell();

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(dismissButtons).toHaveLength(2);

    fireEvent.click(dismissButtons[0]);
    // Dismiss speaks the logical alert key (kind + rowId + milestone), not
    // one physical record id — every duplicate disappears immediately.
    expect(onDismiss).toHaveBeenCalledWith('expiry:row-1:0');
    expect(notificationStableKey(expiryAlert(0))).toBe('expiry:row-1:0');
  });

  it('offers a compact "Clear all" in the header while items are listed, and hides it when empty', () => {
    const onClearAll = vi.fn();
    const { rerender } = render(
      <NotificationBell notifications={[expiryAlert(7), deletionAlert]} onClearAll={onClearAll} />,
    );
    openBell();
    const clearAll = screen.getByRole('button', { name: 'Clear all' });
    fireEvent.click(clearAll);
    expect(onClearAll).toHaveBeenCalledTimes(1);

    // Nothing listed (dismissed away) → no Clear all, just the empty state.
    rerender(
      <NotificationBell notifications={[{ ...expiryAlert(7), dismissed: true }]} onClearAll={onClearAll} />,
    );
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });
});

describe('notification dedupe semantics', () => {
  it('keys alerts by kind + record + milestone, never by expiry value', () => {
    expect(notificationStableKey(expiryAlert(0))).toBe('expiry:row-1:0');
    expect(notificationStableKey(expiryAlert(7))).toBe('expiry:row-1:7');
    expect(notificationStableKey(deletionAlert)).toBe('office-delete:entry-1');
  });

  it('respects an active snooze over a regenerated twin', () => {
    const snoozed = expiryAlert(7, {
      id: 'expiry:row-1:2026-01-08:7:old',
      snoozedUntil: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T09:00:00.000Z',
    });
    const regenerated = expiryAlert(7, {
      id: 'expiry:row-1:2026-01-08:7:new',
      createdAt: '2026-01-02T09:00:00.000Z', // newer, but must NOT un-snooze
    });
    const kept = dedupeNotifications([snoozed, regenerated]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(snoozed.id);
    // The badge/list treat the surviving snoozed state as hidden.
    expect(unreadNotificationCount([snoozed, regenerated])).toBe(0);
  });

  it('shows the one surviving card only while at least one copy is actionable', () => {
    const dismissed = expiryAlert(1, { id: 'a', dismissed: true, createdAt: '2026-01-01T09:00:00.000Z' });
    const fresh = expiryAlert(1, { id: 'b', createdAt: '2026-01-02T09:00:00.000Z' });
    expect(dedupeNotifications([dismissed, fresh]).map((record) => record.id)).toEqual(['b']);
    // All copies dismissed → the winner is dismissed → no card at all.
    const allDismissed = [dismissed, { ...fresh, dismissed: true }];
    render(<NotificationBell notifications={allDismissed} />);
    openBell();
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });
});
