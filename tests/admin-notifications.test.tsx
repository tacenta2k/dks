import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { NotificationBell } from '../src/features/notifications/NotificationBell';
import type { OfficeDeleteNotificationRecord } from '../src/features/notifications/alert-service';

const record: OfficeDeleteNotificationRecord = {
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

describe('administrator delete notifications', () => {
  it('offers View, Restore, and Dismiss actions', () => {
    const onView = vi.fn();
    const onRestore = vi.fn();
    const onDismiss = vi.fn();

    render(
      <NotificationBell
        notifications={[record]}
        onView={onView}
        onRestore={onRestore}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));
    expect(screen.getByText(record.body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onView).toHaveBeenCalledWith(record);
    expect(onRestore).toHaveBeenCalledWith(record);
    expect(onDismiss).toHaveBeenCalledWith(record.id);
  });
});
