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
});
