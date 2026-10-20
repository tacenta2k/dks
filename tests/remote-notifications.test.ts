import { describe, expect, it, vi } from 'vitest';

import {
  dismissAdminNotification,
  loadAdminNotifications,
  restoreDeletedEntry,
  type AdminNotificationClient,
} from '../src/features/notifications/remote-notifications';

describe('remote administrator notifications', () => {
  it('loads office-delete notifications and supports dismiss and restore actions', async () => {
    const update = vi.fn(() => ({ eq: async () => ({ data: [], error: null }) }));
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const client: AdminNotificationClient = {
      from: () => ({
        select: async () => ({
          data: [{
            id: 7,
            type: 'delete',
            message: 'Office deleted Amina on 2026-01-01 10:30',
            payload: { entry_id: 'entry-1', row_label: 'Amina' },
            read: false,
            created_at: '2026-01-01T10:30:00.000Z',
          }],
          error: null,
        }),
        update,
      }),
      rpc,
    };

    const records = await loadAdminNotifications(client);
    expect(records[0]).toEqual(expect.objectContaining({
      id: 'admin-notification-7',
      kind: 'office-delete',
      entryId: 'entry-1',
      rowLabel: 'Amina',
    }));

    await dismissAdminNotification(client, '7');
    await restoreDeletedEntry(client, 'entry-1');
    expect(update).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('restore_entry', { p_entry_id: 'entry-1' });
  });
});
