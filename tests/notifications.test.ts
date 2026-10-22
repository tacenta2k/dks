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
  getSummaryKinds,
  type AlertColumn,
  type AlertRow,
} from '../src/features/notifications/alert-service';
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

  it('calculates snoozes as local calendar durations and supports a custom deadline', () => {
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
    expect(getSummaryKinds(new Date(2026, 0, 5, 9, 0))).toEqual(['daily', 'weekly']);
    expect(getSummaryKinds(new Date(2026, 0, 6, 9, 4))).toEqual(['daily']);
    expect(getSummaryKinds(new Date(2026, 0, 5, 8, 59))).toEqual([]);
  });

  it('creates serializable in-app summary records and suppresses sent summaries', () => {
    const now = new Date(2026, 0, 5, 9, 0);
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

  it('renders unread records and offers a custom snooze action', () => {
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
    expect(screen.getByRole('button', { name: 'Snooze custom' })).toBeTruthy();
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
