import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { NotificationBell } from '../src/features/notifications/NotificationBell';
import { evaluateAlerts, getSummaryKinds, type ExpiryNotificationRecord, type NotificationRecord } from '../src/features/notifications/alert-service';
import { formatNotificationText, notificationOsContent } from '../src/features/notifications/notification-display';

const expiry: ExpiryNotificationRecord = {
  id: 'expiry:r1:2026-10-27:7', kind: 'expiry', rowId: 'r1', expiryColumnId: 'expiry',
  expiryValue: '2026-10-27', daysLeft: 7, alertDay: 7, dedupeKey: 'expiry:r1:2026-10-27:7',
  title: 'Expires 10/27/2026', body: 'Amina expires 10/27/2026.',
  createdAt: '2026-10-20T09:00:00Z', read: false, dismissed: false,
};

function showBell(records: NotificationRecord[]) {
  render(<NotificationBell notifications={records} />);
  fireEvent.click(screen.getByRole('button', { name: `Notifications (${records.length} unread)` }));
}

describe('notification display dates', () => {
  it('formats legacy expiry title, bell primary/secondary lines, and desktop body consistently', () => {
    showBell([expiry]);
    expect(screen.getByText('Amina expires 27/10/2026.')).toBeInTheDocument();
    expect(screen.getByText('Amina · 27/10/2026')).toBeInTheDocument();
    expect(notificationOsContent(expiry)).toEqual({ title: 'Expires 27/10/2026', body: 'Amina expires 27/10/2026.' });
    expect(notificationOsContent({ ...expiry, body: 'Amina expires in 7 days.' }).body)
      .toBe('Amina expires in 7 days. · 27/10/2026');
  });

  it('uses the record date to resolve ambiguous legacy US dates without flipping valid DD/MM', () => {
    const record = { ...expiry, expiryValue: '2026-03-04' };
    expect(formatNotificationText('Expires 03/04/2026', record)).toBe('Expires 04/03/2026');
    expect(formatNotificationText('Expires 04/03/2026', record)).toBe('Expires 04/03/2026');
    expect(formatNotificationText('Other date 01/02/2025', record)).toBe('Other date 01/02/2025');
  });

  it('formats daily and weekly summary bell text, secondary lines, titles, and OS bodies', () => {
    const summaries: NotificationRecord[] = (['daily-summary', 'weekly-summary'] as const).map((kind) => ({
      id: kind, kind, summaryDate: '2026-10-27', alertCount: 1, alertIds: ['r1'],
      title: `${kind} 10/27/2026`, body: `${kind} for 2026-10-27`,
      createdAt: '2026-10-27T05:00:00Z', read: false, dismissed: false,
    }));
    showBell(summaries);
    expect(screen.getByText('daily-summary for 27/10/2026')).toBeInTheDocument();
    expect(screen.getByText('weekly-summary for 27/10/2026')).toBeInTheDocument();
    expect(screen.getAllByText('27/10/2026')).toHaveLength(2);
    expect(notificationOsContent(summaries[0])).toEqual({ title: 'daily-summary 27/10/2026', body: 'daily-summary for 27/10/2026' });
    expect(notificationOsContent(summaries[1])).toEqual({ title: 'weekly-summary 27/10/2026', body: 'weekly-summary for 27/10/2026' });
  });

  it('renders office-delete card and desktop text in Muscat across midnight', () => {
    const deletion: NotificationRecord = {
      id: 'delete-1', kind: 'office-delete', entryId: 'r1', rowLabel: 'Amina',
      title: 'Deleted on 10/27/2026', body: 'Office deleted Amina on 2026-10-27 21:30',
      createdAt: '2026-10-27T21:30:00Z', read: false, dismissed: false,
    };
    showBell([deletion]);
    expect(screen.getByText('Office deleted Amina on 28/10/2026 01:30')).toBeInTheDocument();
    expect(screen.getByText('Amina · 28/10/2026 01:30')).toBeInTheDocument();
    expect(notificationOsContent(deletion)).toEqual({ title: 'Deleted on 28/10/2026', body: 'Office deleted Amina on 28/10/2026 01:30' });
    expect(formatNotificationText('Office deleted Amina on 10/27/2026 21:30', deletion))
      .toBe('Office deleted Amina on 28/10/2026 01:30');
  });

  it('uses the Muscat calendar and clock for expiry evaluation and summary windows', () => {
    const alerts = evaluateAlerts({
      rows: [{ id: 'r1', data: { name: 'Amina', expiry: '2026-10-27' } }],
      columns: [{ id: 'expiry', name: 'Expiry', type: 'date_expiry', isPrimaryExpiry: true }],
      now: new Date('2026-10-26T21:00:00Z'), alertDays: [0],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].daysLeft).toBe(0);
    expect(getSummaryKinds(new Date('2026-01-05T05:00:00Z'))).toEqual(['daily', 'weekly']);
    expect(getSummaryKinds(new Date('2026-01-05T09:00:00Z'))).toEqual([]);
  });
});
