import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';

// The main-process notification/tray modules import 'electron'. Mock the
// module so this suite runs without downloading the Electron binary (offline
// CI and sandboxed environments) while still exercising the real logic.
vi.mock('electron', () => {
  class Notification {
    title: string;

    body: string;

    constructor(options: { title?: string; body?: string }) {
      this.title = options.title ?? '';
      this.body = options.body ?? '';
    }

    static isSupported(): boolean {
      return true;
    }

    show(): void {}

    close(): void {}
  }
  return {
    Notification,
    Menu: { buildFromTemplate: () => ({ popup: () => undefined }), setApplicationMenu: () => undefined },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    Tray: class Tray {
      setToolTip(): void {}

      setContextMenu(): void {}

      on(): void {}

      destroy(): void {}
    },
  };
});

import {
  DEFAULT_ALERT_DAYS,
  createInAppNotificationStore,
  createSnooze,
  evaluateAlerts,
  evaluateSummaryNotifications,
  expiryRowLabel,
  getSummaryKinds,
  refreshExpiryNotificationLabel,
  refreshExpiryNotificationLabels,
  type AlertColumn,
  type AlertRow,
  type ExpiryNotificationRecord,
} from '../src/features/notifications/alert-service';
import { fromLocalNotification } from '../src/features/notifications/local-notifications';
import type { DksLocalNotificationRecord } from '../src/lib/types';
import {
  createNotificationService,
} from '../electron/main/notifications';
import {
  createNotificationScheduler,
} from '../electron/main/notifications';
import {
  formatTrayTooltip,
  getTrayStatus,
} from '../electron/main/tray';
import NotificationBell from '../src/features/notifications/NotificationBell';

const columns: AlertColumn[] = [
  {
    id: 'visa_expiry',
    name: 'Visa expiry',
    type: 'date_expiry',
    isPrimaryExpiry: true,
  },
  {
    id: 'passport_expiry',
    name: 'Passport expiry',
    type: 'date_expiry',
  },
];

function row(id: string, expiry: string, passportExpiry = '2026-01-01'): AlertRow {
  return {
    id,
    data: {
      name: 'Ravi Kumar',
      visa_expiry: expiry,
      passport_expiry: passportExpiry,
    },
  };
}

describe('notification alert evaluator', () => {
  it('uses the primary expiry and the default alert days', () => {
    // Use dates generated from the fixed day count so the assertion does not
    // depend on the machine's timezone or the month lengths.
    const fixedRows = DEFAULT_ALERT_DAYS.map((days, index) => {
      const expiry = new Date(Date.UTC(2026, 0, 1));
      expiry.setUTCDate(expiry.getUTCDate() + days);
      return row(`row-${days}`, expiry.toISOString().slice(0, 10), '2025-01-01');
    });

    const alerts = evaluateAlerts({
      rows: fixedRows,
      columns,
      now: new Date(2026, 0, 1, 10, 0),
    });

    expect(alerts.map((alert) => alert.daysLeft)).toEqual(DEFAULT_ALERT_DAYS);
    expect(alerts.every((alert) => alert.expiryColumnId === 'visa_expiry')).toBe(true);
    expect(alerts.every((alert) => alert.expiryValue !== '2025-01-01')).toBe(true);
  });

  it('supports configured days, snoozes, dismissals, and expiry changes', () => {
    const now = new Date(2026, 0, 1, 10, 0);
    const original = row('r1', '2026-01-31');
    const first = evaluateAlerts({ rows: [original], columns, now, alertDays: [30] });
    expect(first).toHaveLength(1);

    expect(evaluateAlerts({
      rows: [original],
      columns,
      now,
      alertDays: [30],
      snoozes: [createSnooze('r1', '3d', now, '2026-01-31')],
    })).toEqual([]);

    expect(evaluateAlerts({
      rows: [original],
      columns,
      now,
      alertDays: [30],
      dismissedExpiryValues: { r1: '2026-01-31' },
    })).toEqual([]);

    expect(evaluateAlerts({
      rows: [original],
      columns,
      now,
      alertDays: [30],
      dismissed: { r1: '2026-01-31' },
    })).toEqual([]);

    expect(evaluateAlerts({
      rows: [original],
      columns,
      now,
      alertDays: [30],
      dismissed: [{ entryId: 'r1', expiry_value: '2026-01-31' }],
    })).toEqual([]);

    expect(evaluateAlerts({
      rows: [original],
      columns,
      now,
      alertDays: [30],
      snoozes: [{
        entry_id: 'r1',
        snoozed_until: '2099-01-01T00:00:00.000Z',
        dismissed_until_expiry_change: true,
        expiry_value: '2026-01-31',
      }],
    })).toEqual([]);

    const renewed = row('r1', '2026-02-28');
    expect(evaluateAlerts({
      rows: [renewed],
      columns,
      now,
      alertDays: [58],
      dismissedExpiryValues: { r1: '2026-01-31' },
    })).toHaveLength(1);
  });

  it('calculates snoozes as Muscat calendar durations and supports a custom deadline', () => {
    const now = new Date(2026, 2, 28, 10, 30);
    const oneDay = new Date(createSnooze('r1', '1d', now).until!);
    const threeDays = new Date(createSnooze('r1', '3d', now).until!);
    const oneWeek = new Date(createSnooze('r1', '1w', now).until!);

    expect(oneDay.getDate()).toBe(29);
    expect(threeDays.getDate()).toBe(31);
    expect(oneWeek.getDate()).toBe(4);
    expect(createSnooze('r1', 'custom', now, null, '2026-04-15T12:00:00.000Z').until!)
      .toBe('2026-04-15T12:00:00.000Z');
    expect(createSnooze('r1', 'custom', '2026-04-20T12:00:00.000Z').until!)
      .toBe('2026-04-20T12:00:00.000Z');
  });

  it('does not duplicate an unchanged expiry alert', () => {
    const options = {
      rows: [row('r1', '2026-01-31')],
      columns,
      now: new Date(2026, 0, 1, 10, 0),
      alertDays: [30],
    } as const;
    const first = evaluateAlerts(options);
    const second = evaluateAlerts({ ...options, existingNotifications: first });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('keeps a dismissed row quiet across later milestones until its expiry changes', () => {
    const dismissed = evaluateAlerts({
      rows: [row('r1', '2026-01-31')],
      columns,
      now: '2026-01-01',
      alertDays: [30],
    })[0];
    expect(dismissed).toBeDefined();

    expect(evaluateAlerts({
      rows: [row('r1', '2026-01-31')],
      columns,
      now: '2026-01-16',
      alertDays: [15],
      existingNotifications: [{ ...dismissed!, dismissed: true }],
    })).toEqual([]);
  });

  it('returns alerts in stable milestone and row order regardless of input order', () => {
    const rows = [
      row('row-90', '2026-04-01'),
      row('row-30', '2026-01-31'),
    ];
    const alerts = evaluateAlerts({
      rows: rows.reverse(),
      columns,
      now: '2026-01-01',
      alertDays: [30, 90],
    });

    expect(alerts.map((alert) => alert.daysLeft)).toEqual([90, 30]);
  });

  it('selects daily summaries every day and adds a weekly summary on Monday', () => {
    expect(getSummaryKinds(new Date('2026-01-05T05:00:00Z'))).toEqual(['daily', 'weekly']);
    expect(getSummaryKinds(new Date('2026-01-06T05:04:00Z'))).toEqual(['daily']);
    expect(getSummaryKinds(new Date('2026-01-05T04:59:00Z'))).toEqual([]);
  });

  it('creates serializable in-app summary records and suppresses sent summaries', () => {
    const now = new Date('2026-01-05T05:00:00Z');
    const alerts = evaluateAlerts({
      rows: [row('r1', '2026-01-05')],
      columns,
      now,
      alertDays: [0],
    });
    const summaries = evaluateSummaryNotifications({
      alerts,
      now,
      existingNotifications: [],
    });
    const repeated = evaluateSummaryNotifications({
      alerts,
      now,
      existingNotifications: summaries,
    });

    expect(summaries.map((summary) => summary.kind)).toEqual(['daily-summary', 'weekly-summary']);
    expect(summaries.every((summary) => JSON.stringify(summary))).toBe(true);
    expect(repeated).toEqual([]);
  });

  it('stores records without exposing mutable internal state', () => {
    const store = createInAppNotificationStore();
    const [record] = evaluateAlerts({
      rows: [row('r1', '2026-01-31')],
      columns,
      now: '2026-01-01',
      alertDays: [30],
    });

    store.add(record);
    expect(store.list()).toEqual([record]);
    store.markRead(record.id);
    expect(store.list()[0]?.read).toBe(true);
    store.dismiss(record.id);
    expect(store.list()[0]?.dismissed).toBe(true);
  });

  it('renders unread records and offers snoozes limited by the time left (R2-02)', () => {
    const [record] = evaluateAlerts({
      rows: [row('r1', '2026-01-31')],
      columns,
      now: '2026-01-01',
      alertDays: [30],
    });
    const onSnooze = vi.fn();

    render(createElement(NotificationBell, { notifications: [record], onSnooze }));
    expect(screen.getByRole('button', { name: 'Notifications (1 unread)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));
    // S1: the body carries the human row label, never the raw row id.
    expect(screen.getByText('Ravi Kumar expires in 30 days.')).toBeTruthy();
    expect(screen.queryByText(/r1 expires/)).toBeNull();
    // R2-02: fixed snooze choices only (1 day / 3 days / 1 week) — the native
    // date input and the custom snooze button are gone.
    expect(screen.getByRole('button', { name: 'Snooze 1 day' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Snooze 3 days' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Snooze 1 week' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Snooze custom' })).toBeNull();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });
});

describe('expiry notification human labels', () => {
  const labelColumns: AlertColumn[] = [
    { id: 'customer_name', name: 'Customer Name', type: 'text' },
    { id: 'visa_expiry', name: 'Visa expiry', type: 'date_expiry', isPrimaryExpiry: true },
  ];
  const realUuid = '8c1f2a44-3b6d-4c2e-9f01-0123456789ab';

  it('uses the customer column value (by column id or name), never the entry UUID', () => {
    const byId = evaluateAlerts({
      rows: [{ id: realUuid, data: { customer_name: 'Amina Ali', visa_expiry: '2026-01-01' } }],
      columns: labelColumns,
      now: '2026-01-01',
      alertDays: [0],
    });
    expect(byId).toHaveLength(1);
    expect(byId[0].title).toBe('Expiry due today');
    expect(byId[0].body).toBe('Amina Ali expires today.');
    expect(byId[0].body).not.toContain(realUuid);

    // Legacy/imported rows may key data by the column NAME instead of its id.
    const byName = evaluateAlerts({
      rows: [{ id: realUuid, data: { 'Customer Name': 'Ravi Kumar', 'Visa expiry': '2026-01-08' } }],
      columns: labelColumns,
      now: '2026-01-01',
      alertDays: [7],
    });
    expect(byName[0].body).toBe('Ravi Kumar expires in 7 days.');
  });

  it('falls back to exactly "Unnamed record" when the row has no usable label', () => {
    const alerts = evaluateAlerts({
      rows: [{ id: realUuid, data: { visa_expiry: '2026-01-01' } }],
      columns: labelColumns,
      now: '2026-01-01',
      alertDays: [0],
    });
    expect(alerts[0].body).toBe('Unnamed record expires today.');
    expect(alerts[0].body).not.toContain(realUuid);
    // A bare date value is never mistaken for a name either.
    expect(expiryRowLabel(
      { id: realUuid, data: { visa_expiry: '2026-01-01', other_date: '2025-12-01' } },
      labelColumns,
    )).toBe('Unnamed record');
  });

  it('rejects a caller label callback that returns the raw row id', () => {
    const alerts = evaluateAlerts({
      rows: [{ id: realUuid, data: { customer_name: 'Meera Joshi', visa_expiry: '2026-01-02' } }],
      columns: labelColumns,
      now: '2026-01-01',
      alertDays: [1],
      // The old buggy caller contract: `data?.name ?? row.id`.
      rowLabel: (r) => (typeof r.data?.name === 'string' ? r.data.name : r.id),
    });
    expect(alerts[0].body).toBe('Meera Joshi expires in 1 day.');
    expect(alerts[0].body).not.toContain(realUuid);
  });

  function legacyRecord(overrides: Partial<ExpiryNotificationRecord> = {}): ExpiryNotificationRecord {
    return {
      id: `expiry:${realUuid}:2026-10-26:0`,
      kind: 'expiry',
      rowId: realUuid,
      expiryColumnId: 'visa_expiry',
      expiryValue: '2026-10-26',
      daysLeft: 0,
      alertDay: 0,
      dedupeKey: `expiry:${realUuid}:2026-10-26:0`,
      title: 'Expiry due today',
      body: `${realUuid} expires today.`,
      createdAt: '2026-10-26T05:00:00.000Z',
      read: false,
      dismissed: false,
      ...overrides,
    };
  }

  it('repairs a persisted UUID body on load, preserving identity and user state', () => {
    const legacy = legacyRecord({ read: true, snoozedUntil: '2026-10-27T05:00:00.000Z' });
    const refreshed = refreshExpiryNotificationLabel(
      legacy,
      { id: realUuid, data: { customer_name: 'Amina Ali', visa_expiry: '2026-10-26' } },
      labelColumns,
    );

    expect(refreshed.body).toBe('Amina Ali expires today.');
    expect(refreshed.body).not.toContain(realUuid);
    // Everything that identifies or state-tracks the alert is untouched.
    expect(refreshed.id).toBe(legacy.id);
    expect(refreshed.dedupeKey).toBe(legacy.dedupeKey);
    expect(refreshed.rowId).toBe(realUuid);
    expect(refreshed.expiryValue).toBe('2026-10-26');
    expect(refreshed.daysLeft).toBe(0);
    expect(refreshed.alertDay).toBe(0);
    expect(refreshed.createdAt).toBe(legacy.createdAt);
    expect(refreshed.read).toBe(true);
    expect(refreshed.dismissed).toBe(false);
    expect(refreshed.snoozedUntil).toBe('2026-10-27T05:00:00.000Z');

    // Dismissed legacy records stay dismissed through the repair.
    const dismissed = refreshExpiryNotificationLabel(legacyRecord({ dismissed: true }), null, labelColumns);
    expect(dismissed.dismissed).toBe(true);
    // The row is gone: safe fallback, still no UUID.
    expect(dismissed.body).toBe('Unnamed record expires today.');
  });

  it('does not duplicate the alert when evaluation runs against repaired history', () => {
    const repaired = refreshExpiryNotificationLabels(
      [legacyRecord()],
      [{ id: realUuid, data: { customer_name: 'Amina Ali', visa_expiry: '2026-10-26' } }],
      labelColumns,
    );
    const generated = evaluateAlerts({
      rows: [{ id: realUuid, data: { customer_name: 'Amina Ali', visa_expiry: '2026-10-26' } }],
      columns: labelColumns,
      now: '2026-10-26',
      alertDays: [0],
      existingNotifications: repaired,
    });
    expect(generated).toEqual([]);
  });

  it('leaves non-generated bodies and already-correct bodies byte-identical', () => {
    const custom = legacyRecord({ body: 'Custom operator note for this record' });
    expect(refreshExpiryNotificationLabel(custom, { id: realUuid, data: { customer_name: 'Amina Ali' } }, labelColumns))
      .toBe(custom);

    const correct = legacyRecord({ body: 'Amina Ali expires today.' });
    expect(refreshExpiryNotificationLabel(correct, { id: realUuid, data: { customer_name: 'Amina Ali' } }, labelColumns))
      .toBe(correct);
  });

  it('repairs records reloaded from the local notification store payload', () => {
    const stored: DksLocalNotificationRecord = {
      id: 42,
      type: 'expiry',
      message: `${realUuid} expires today.`,
      payload: { ...legacyRecord() },
      read: false,
      dismissed: false,
      createdAt: '2026-10-26T05:00:00.000Z',
      updatedAt: '2026-10-26T05:00:00.000Z',
    };
    const loaded = fromLocalNotification(stored);
    expect(loaded?.kind).toBe('expiry');

    const [refreshed] = refreshExpiryNotificationLabels(
      [loaded!],
      [{ id: realUuid, data: { customer_name: 'Amina Ali', visa_expiry: '2026-10-26' } }],
      labelColumns,
    );
    expect(refreshed).toMatchObject({ kind: 'expiry', body: 'Amina Ali expires today.' });

    // The bell renders the repaired body and secondary line without any UUID.
    render(createElement(NotificationBell, { notifications: [refreshed] }));
    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));
    expect(screen.getByText('Amina Ali expires today.')).toBeTruthy();
    expect(screen.getByText('Amina Ali · 26/10/2026')).toBeTruthy();
    expect(screen.queryByText(new RegExp(realUuid))).toBeNull();
  });

  it('derives the bell secondary line without leaking the row id from a legacy body', () => {
    // Even if a record somehow reaches the bell unrepaired, the meta line
    // must not echo the row UUID (the App-level refresh fixes the primary
    // line on load; this is the display-time safety net for the meta line).
    render(createElement(NotificationBell, { notifications: [legacyRecord()] }));
    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));
    expect(screen.getByText('Unnamed record · 26/10/2026')).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${realUuid} ·`))).toBeNull();
  });
});

describe('safe desktop notification and tray boundaries', () => {
  it('validates renderer requests and catches OS delivery failures', () => {
    const show = vi.fn();
    const service = createNotificationService({
      isSupported: () => true,
      create: () => ({ show }),
    });

    expect(service.show({ title: 'Expiry', body: 'Due today' })).toEqual({ delivered: true });
    expect(show).toHaveBeenCalledOnce();
    expect(service.show({ title: '', body: 'invalid' })).toEqual({ delivered: false, reason: 'invalid' });

    const unavailable = createNotificationService({
      isSupported: () => {
        throw new Error('desktop service unavailable');
      },
    });
    expect(unavailable.show({ title: 'Expiry', body: 'Due today' })).toEqual({ delivered: false, reason: 'error' });
  });

  it('formats urgent tray state with a stable zero-safe tooltip', () => {
    expect(formatTrayTooltip(0)).toBe('DKS');
    expect(formatTrayTooltip(1)).toContain('1 urgent');
    expect(formatTrayTooltip(3)).toContain('3 urgent');
    expect(getTrayStatus(2)).toEqual({ urgentCount: 2, urgent: true, tooltip: 'DKS · 2 urgent expiries' });
    expect(getTrayStatus(-2)).toEqual({ urgentCount: 0, urgent: false, tooltip: 'DKS' });
  });

  it('runs a launch notification check and catches timer/check failures', async () => {
    const check = vi.fn(async () => undefined);
    let scheduled: (() => void) | undefined;
    const scheduler = createNotificationScheduler(check, {
      setInterval: vi.fn((callback: () => void) => {
        scheduled = callback;
        return 7;
      }),
      clearInterval: vi.fn(),
    });

    await scheduler.start();
    scheduled?.();
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
    scheduler.stop();
    scheduled?.();
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
