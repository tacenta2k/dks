import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/renderer/components/AppShell';
import type { ExpiryNotificationRecord } from '../src/features/notifications/alert-service';

const notification: ExpiryNotificationRecord = {
  id: 'expiry:row-1:2026-01-07:7',
  kind: 'expiry',
  rowId: 'row-1',
  expiryColumnId: 'visa_expiry',
  expiryValue: '2026-01-07',
  daysLeft: 7,
  alertDay: 7,
  dedupeKey: 'expiry:row-1:2026-01-07:7',
  title: 'Expiry reminder',
  body: 'Amina expires in 7 days.',
  createdAt: '2026-01-01T09:00:00.000Z',
  read: false,
  dismissed: false,
};

describe('app notification bell', () => {
  it('shows unread expiry alerts and delegates mark-read actions', () => {
    const onMarkRead = vi.fn();

    render(
      <AppShell
        notifications={[notification]}
        onNotificationMarkRead={onMarkRead}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));
    expect(screen.getByText('Amina expires in 7 days.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));

    expect(onMarkRead).toHaveBeenCalledWith(notification.id);
  });
});
