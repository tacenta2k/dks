import { describe, expect, it } from 'vitest';

import { createSqliteStore } from '../electron/main/sqlite';
import { mergeLastWriteWins } from '../electron/main/sync';

describe('protected local SQLite cache and outbox', () => {
  it('writes entries locally first and creates one idempotent outbox item', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });

    const created = store.createEntry({
      id: 'entry-1',
      data: { Passport: 'A1234567' },
      category: 'Employee',
      idempotencyKey: 'entry-1-create',
    });

    expect(store.getEntry('entry-1')?.data).toEqual({ Passport: 'A1234567' });
    expect(store.getEntry('entry-1')?.updated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(store.getMigrationVersion()).toBeGreaterThan(0);
    expect(store.listEntries()).toHaveLength(1);
    expect(store.listOutbox()).toHaveLength(1);
    expect(store.enqueueOutbox({
      idempotencyKey: 'entry-1-create',
      operation: 'create',
      entityType: 'entry',
      entityId: created.id,
      payload: created,
    }).id).toBe(store.listOutbox()[0].id);

    store.close();
  });

  it('keeps terminal changes and concurrent edits out of automatic acknowledgement and retries', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });
    try {
      store.createEntry({ id: 'entry-1', data: { name: 'Kept locally' } });
      const [create] = store.listOutbox('all');
      store.markOutboxSynced(create.id);
      store.updateEntry('entry-1', { data: { name: 'Unsynchronised edit' } });
      const update = store.listOutbox('pending')[0];
      store.markOutboxTerminal(update.id, 'This record can no longer be changed from the Office account');
      store.createEntry({ id: 'entry-2', data: { name: 'Concurrent edit' } });

      expect(store.retryFailedOutbox()).toBe(0);
      expect(store.acknowledgeOutbox().status).toBe('error');
      expect(store.getPendingOutboxCount()).toBe(2);
      expect(store.listOutbox('all').find((item) => item.id === update.id)).toMatchObject({
        status: 'terminal', attempts: 1, lastError: expect.stringContaining('Office account'),
      });
      expect(store.getEntry('entry-1')?.data.name).toBe('Unsynchronised edit');
      expect(store.listOutbox('pending')).toHaveLength(1);
      store.markOutboxSynced(update.id);
      expect(store.listOutbox('all').find((item) => item.id === update.id)?.status).toBe('terminal');
    } finally {
      store.close();
    }
  });

  it('updates sync metadata and resolves conflicts by updated_at', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });
    store.setSyncStatus({ status: 'syncing', lastError: null });
    expect(store.getSyncStatus().status).toBe('syncing');

    const local = { id: 'entry-1', data: { value: 'local' }, updated_at: '2026-01-02T00:00:00.000Z' };
    const remote = { id: 'entry-1', data: { value: 'remote' }, updated_at: '2026-01-03T00:00:00.000Z' };
    const result = mergeLastWriteWins(local, remote);

    expect(result.winner).toBe('remote');
    expect(result.record).toBe(remote);
    expect(result.conflict).toBe(true);
    store.close();
  });

  it('persists notification state by its stable renderer id', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });
    const created = store.addNotification({
      type: 'expiry',
      message: 'Amina expires in 7 days.',
      payload: { id: 'expiry:entry-1:2026-01-08:7', kind: 'expiry' },
      read: false,
      dismissed: false,
    });

    expect(store.listNotifications()).toHaveLength(1);
    const updated = store.updateNotification('expiry:entry-1:2026-01-08:7', {
      read: true,
      dismissed: true,
      payload: { id: 'expiry:entry-1:2026-01-08:7', kind: 'expiry', snoozedUntil: null },
    });

    expect(updated?.id).toBe(created.id);
    expect(store.listNotifications()[0]).toMatchObject({
      read: true,
      dismissed: true,
      payload: { snoozedUntil: null },
    });
    store.close();
  });

  it('applies a remote snapshot without creating a local outbox echo', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });

    store.applyRemoteEntry({
      id: 'remote-entry',
      data: { name: 'Remote' },
      category: 'Client',
      deleted: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      version: 2,
    });
    store.applyRemoteColumn({
      id: 'remote-column',
      name: 'Country',
      type: 'text',
      options: {},
      position: 2,
      visible: true,
      is_primary_expiry: false,
      is_passport: false,
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    expect(store.getEntry('remote-entry')?.data).toEqual({ name: 'Remote' });
    expect(store.getColumn('remote-column')?.name).toBe('Country');
    expect(store.listOutbox()).toHaveLength(0);
    store.close();
  });

  it('caches workspace settings locally and exposes pending setting mutations', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });
    store.setSettings({ theme: 'dark', notification_days: [30, 7, 0] });

    expect(store.getSettings()).toEqual({
      theme: 'dark',
      notification_days: [30, 7, 0],
    });
    expect(store.listOutbox().some((item) => item.entityType === 'settings')).toBe(true);
    store.close();
  });

  it('keeps an administrator-selected primary expiry column instead of resetting to the first column', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });
    store.upsertColumn({ id: 'expiry-one', name: 'Expiry one', type: 'date_expiry', position: 0 });
    store.upsertColumn({ id: 'expiry-two', name: 'Expiry two', type: 'date_expiry', position: 1 });
    store.upsertColumn({ id: 'expiry-two', name: 'Expiry two', type: 'date_expiry', position: 1, isPrimaryExpiry: true });

    expect(store.listColumns().find((column) => column.isPrimaryExpiry)?.id).toBe('expiry-two');
    store.close();
  });

  it('gives a bulk recycle-bin delete one outbox item and one audit entry per row with no resurrection', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-01T00:00:00.000Z' });
    const keep = store.createEntry({ id: 'entry-keep', data: { name: 'Stays' } });
    const targets = ['entry-a', 'entry-b', 'entry-c'].map((id) => {
      const entry = store.createEntry({ id, data: { name: id } });
      store.softDeleteEntry(id);
      return entry;
    });

    // The Recycle Bin "Delete all" loop drives the SAME per-row permanent
    // delete path as the single-row button.
    for (const entry of targets) {
      store.permanentDeleteEntry(entry.id, undefined, 'Admin');
    }

    expect(store.listEntries(true).map((entry) => entry.id)).toEqual([keep.id]);
    const permanentOutbox = store
      .listOutbox('all')
      .filter((item) => item.operation === 'permanent_delete' && item.entityType === 'entry');
    expect(permanentOutbox).toHaveLength(3);
    // Unique idempotency keys keep the per-row RPC calls idempotent on sync.
    expect(new Set(permanentOutbox.map((item) => item.idempotencyKey)).size).toBe(3);
    expect(permanentOutbox.every((item) => item.status === 'pending')).toBe(true);

    const permanentAudit = store.listAudit().filter((entry) => entry.action === 'permanent_delete');
    expect(permanentAudit).toHaveLength(3);
    expect(permanentAudit.every((entry) => entry.actor === 'Admin')).toBe(true);

    // A later snapshot no longer surfaces the deleted rows in either bucket,
    // so the next sync/reconcile cannot resurrect them.
    const snapshot = store.listEntries(true);
    expect(snapshot.some((entry) => targets.some((target) => target.id === entry.id))).toBe(false);
    store.close();
  });
});
