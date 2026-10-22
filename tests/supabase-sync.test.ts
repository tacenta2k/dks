import { describe, expect, it } from 'vitest';

import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseOutboxItem,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalColumn, DksLocalRow, DksLocalSnapshot } from '../src/lib/types';
import { createSqliteStore } from '../electron/main/sqlite';
import { sanitizeSyncError } from '../src/lib/sync-error';

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_ID = '22222222-2222-4222-8222-222222222222';
const DELETED_ID = '33333333-3333-4333-8333-333333333333';
const PURGED_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

function snapshot(): DksLocalSnapshot {
  return {
    rows: [{
      id: LOCAL_ID,
      data: { name: 'Local winner' },
      category: 'Employee',
      deleted: false,
      updated_at: '2026-01-03T00:00:00.000Z',
    }],
    deletedRows: [],
    columns: [{
      id: 'name',
      name: 'Name',
      type: 'text',
      position: 0,
      visible: true,
      updated_at: '2026-01-03T00:00:00.000Z',
    }],
    syncStatus: {
      status: 'offline',
      lastSyncAt: null,
      lastError: null,
      pendingCount: 1,
    },
  };
}

describe('Supabase offline reconciliation', () => {
  it('pushes local winners, applies remote winners, and acknowledges the outbox', async () => {
    const remoteTables: Record<string, Record<string, unknown>[]> = {
      entries: [{
        id: REMOTE_ID,
        data: { name: 'Remote winner' },
        category: 'Client',
        deleted: false,
        updated_at: '2026-01-04T00:00:00.000Z',
      }],
      app_columns: [{
        id: 'remote-name-column',
        name: 'Name',
        type: 'text',
        position: 0,
        visible: true,
        updated_at: '2026-01-02T00:00:00.000Z',
      }],
    };
    const upserts: Record<string, unknown[]> = {};
    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: remoteTables[table] ?? [], error: null }),
        upsert: async (values) => {
          upserts[table] = [...values];
          return { data: [...values], error: null };
        },
      }),
    };
    let localSnapshot = snapshot();
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => localSnapshot,
      setSyncStatus: async (state) => {
        localSnapshot = { ...localSnapshot, syncStatus: { ...localSnapshot.syncStatus, ...state } };
        return localSnapshot.syncStatus;
      },
      applyRemoteSnapshot: async (input) => {
        localSnapshot = {
          ...localSnapshot,
          rows: [...localSnapshot.rows, ...input.rows.map((row) => ({ ...row }) as unknown as DksLocalRow)],
          columns: [...localSnapshot.columns, ...input.columns.map((column) => ({ ...column }) as unknown as DksLocalColumn)],
        };
        return localSnapshot;
      },
      acknowledgeOutbox: async () => {
        localSnapshot = {
          ...localSnapshot,
          syncStatus: { ...localSnapshot.syncStatus, pendingCount: 0, status: 'healthy' },
        };
        return localSnapshot.syncStatus;
      },
    };

    const result = await runSupabaseSync({ client, local, now: () => '2026-01-05T00:00:00.000Z' });

    expect(result.status).toBe('healthy');
    expect(upserts.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: LOCAL_ID, data: { name: 'Local winner' } }),
    ]));
    expect(localSnapshot.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: REMOTE_ID, data: { name: 'Remote winner' } }),
    ]));
    expect(localSnapshot.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'name', name: 'Name' }),
    ]));
    expect(localSnapshot.syncStatus.pendingCount).toBe(0);
  });

  it('reports remote failures and preserves a useful sync error', async () => {
    const client: SupabaseDataClient = {
      from: () => ({
        select: async () => ({ data: null, error: { message: 'offline' } }),
        upsert: async () => ({ data: null, error: null }),
      }),
    };
    let state = snapshot().syncStatus;
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot(),
      setSyncStatus: async (next) => {
        state = { ...state, ...next };
        return state;
      },
    };

    const result = await runSupabaseSync({ client, local });

    expect(result.status).toBe('error');
    expect(result.error).toContain('offline');
    expect(state.lastError).toBe('offline');
  });

  it('records a visible conflict instead of silently discarding the losing copy', async () => {
    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({
          data: table === 'entries'
            ? [{
              id: LOCAL_ID,
              data: { name: 'Remote edit' },
              category: 'Employee',
              deleted: false,
              updated_at: '2026-01-04T00:00:00.000Z',
            }]
            : [],
          error: null,
        }),
        upsert: async (values) => ({ data: [...values], error: null }),
      }),
    };
    const conflicts: unknown[] = [];
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot(),
      setSyncStatus: async (state) => ({
        ...snapshot().syncStatus,
        ...state,
      }),
      recordConflict: async (conflict) => {
        conflicts.push(conflict);
      },
      applyRemoteSnapshot: async () => snapshot(),
      acknowledgeOutbox: async () => ({
        status: 'healthy',
        lastSyncAt: '2026-01-05T00:00:00.000Z',
        lastError: null,
        pendingCount: 0,
      }),
    };

    const result = await runSupabaseSync({ client, local });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual(expect.objectContaining({
      entityType: 'entry',
      entityId: LOCAL_ID,
      winner: 'remote',
    }));
    expect(conflicts).toHaveLength(1);
  });
});

interface FakeOutboxState {
  items: SupabaseOutboxItem[];
  synced: Array<number | string>;
  failed: Array<{ id: number | string; message: string }>;
  acknowledged: number;
}

function fakeOutbox(items: SupabaseOutboxItem[]): FakeOutboxState {
  return { items: items.map((item) => ({ ...item })), synced: [], failed: [], acknowledged: 0 };
}

function outboxLocal(
  state: FakeOutboxState,
  snapshotInput: DksLocalSnapshot,
  overrides: Partial<SupabaseSyncLocal> = {},
): SupabaseSyncLocal {
  let current = snapshotInput;
  return {
    getSnapshot: async () => current,
    setSyncStatus: async (next) => {
      current = { ...current, syncStatus: { ...current.syncStatus, ...next } };
      return current.syncStatus;
    },
    applyRemoteSnapshot: async (input) => {
      current = {
        ...current,
        rows: [...current.rows, ...input.rows.map((row) => ({ ...row }) as unknown as DksLocalRow)],
      };
      return current;
    },
    listOutbox: async () => state.items,
    markOutboxSynced: async (id) => {
      state.synced.push(id);
    },
    markOutboxFailed: async (id, message) => {
      state.failed.push({ id, message });
    },
    retryFailedOutbox: async () => 0,
    acknowledgeOutbox: async () => {
      state.acknowledged += 1;
      current = { ...current, syncStatus: { ...current.syncStatus, pendingCount: 0, status: 'healthy' } };
      return current.syncStatus;
    },
    ...overrides,
  };
}

describe('pending outbox synchronisation (B3)', () => {
  it('isolates a rejected row, keeps its outbox item pending, and syncs the others', async () => {
    const failingId = LOCAL_ID;
    const goodId = REMOTE_ID;
    const state = fakeOutbox([
      {
        id: 1,
        idempotencyKey: 'entry:update:1',
        operation: 'update',
        entityType: 'entry',
        entityId: failingId,
        status: 'pending',
      },
      {
        id: 2,
        idempotencyKey: 'entry:update:2',
        operation: 'update',
        entityType: 'entry',
        entityId: goodId,
        status: 'pending',
      },
    ]);

    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: [], error: null }),
        upsert: async (values) => {
          const id = values[0]?.id;
          if (table === 'entries' && id === failingId) {
            return { data: null, error: { message: 'new row violates row-level security policy' } };
          }
          return { data: [...values], error: null };
        },
      }),
    };

    const base = snapshot();
    const local = outboxLocal(state, {
      ...base,
      rows: [
        { ...(base.rows[0] as unknown as Record<string, unknown>), id: failingId } as unknown as DksLocalRow,
        {
          id: goodId,
          data: { name: 'Second row' },
          category: 'Employee',
          deleted: false,
          updated_at: '2026-01-03T00:00:00.000Z',
        },
      ],
    });

    const result = await runSupabaseSync({ client, local });

    expect(result.status).toBe('error');
    expect(result.errors[0]).toContain('row-level security');
    // The good row synced and its item was acknowledged individually.
    expect(state.synced).toContain(2);
    // The failing row keeps its item pending with the real server message.
    expect(state.failed).toEqual([{ id: 1, message: expect.stringContaining('row-level security') }]);
    // A partial run must not blanket-acknowledge the whole queue.
    expect(state.acknowledged).toBe(0);
  });

  it('sends deleted_by for soft deletes and inserts missing rows before deleting them', async () => {
    const state = fakeOutbox([
      {
        id: 7,
        idempotencyKey: 'entry:delete:7',
        operation: 'delete',
        entityType: 'entry',
        entityId: DELETED_ID,
        status: 'pending',
      },
    ]);
    const upserted: Record<string, unknown>[] = [];

    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: [], error: null }),
        upsert: async (values) => {
          if (table === 'entries') {
            upserted.push({ ...values[0] });
          }
          return { data: [...values], error: null };
        },
      }),
    };

    const base = snapshot();
    const local = outboxLocal(state, {
      ...base,
      rows: [],
      deletedRows: [{
        id: DELETED_ID,
        data: { name: 'Removed row' },
        category: 'Employee',
        deleted: true,
        deleted_at: '2026-01-04T00:00:00.000Z',
        updated_at: '2026-01-04T00:00:00.000Z',
      }],
    });

    const result = await runSupabaseSync({ client, local, userId: USER_ID });

    expect(result.status).toBe('healthy');
    expect(upserted).toHaveLength(2);
    // First write inserts the row in an active state (remote insert policy
    // rejects rows that are already deleted) …
    expect(upserted[0]).toEqual(expect.objectContaining({ id: DELETED_ID, deleted: false }));
    // … then the deletion is applied with the acting user recorded.
    expect(upserted[1]).toEqual(expect.objectContaining({
      id: DELETED_ID,
      deleted: true,
      deleted_by: USER_ID,
    }));
    expect(state.synced).toContain(7);
  });

  it('propagates queued permanent deletes and never resurrects the remote row', async () => {
    const state = fakeOutbox([
      {
        id: 9,
        idempotencyKey: 'entry:permanent-delete:9',
        operation: 'permanent_delete',
        entityType: 'entry',
        entityId: PURGED_ID,
        status: 'pending',
      },
    ]);
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const applied: Array<Record<string, unknown>> = [];

    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({
          data: table === 'entries'
            ? [{
              id: PURGED_ID,
              data: { name: 'Should not come back' },
              category: 'Employee',
              deleted: true,
              deleted_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            }]
            : [],
          error: null,
        }),
        upsert: async (values) => ({ data: [...values], error: null }),
      }),
      rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: true, error: null };
      },
    };

    const base = snapshot();
    const local = outboxLocal(state, {
      ...base,
      rows: [],
      deletedRows: [],
    }, {
      applyRemoteSnapshot: async (input) => {
        applied.push(...input.rows);
        return base;
      },
    });

    const result = await runSupabaseSync({ client, local });

    expect(result.status).toBe('healthy');
    expect(result.deletedRemotely).toBe(1);
    expect(rpcCalls).toEqual([{
      name: 'permanently_delete_entry',
      args: { p_entry_id: PURGED_ID },
    }]);
    // The remote copy of the permanently deleted row is not applied locally.
    expect(applied).toHaveLength(0);
    expect(state.synced).toContain(9);
    expect(state.acknowledged).toBe(1);
  });

  it('keeps a permanent delete pending when the server rejects it', async () => {
    const state = fakeOutbox([
      {
        id: 11,
        idempotencyKey: 'entry:permanent-delete:11',
        operation: 'permanent_delete',
        entityType: 'entry',
        entityId: PURGED_ID,
        status: 'pending',
      },
    ]);

    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: [], error: null }),
        upsert: async (values) => ({ data: [...values], error: null }),
      }),
      rpc: async () => ({ data: null, error: { message: 'Only administrators may permanently delete entries' } }),
    };

    const base = snapshot();
    const local = outboxLocal(state, { ...base, rows: [], deletedRows: [] });

    const result = await runSupabaseSync({ client, local });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Only administrators may permanently delete entries');
    expect(state.failed).toEqual([{
      id: 11,
      message: expect.stringContaining('administrators'),
    }]);
    expect(state.acknowledged).toBe(0);
  });

  it('reports non-UUID local ids as a per-row failure without blocking other rows', async () => {
    const state = fakeOutbox([
      {
        id: 21,
        idempotencyKey: 'entry:update:21',
        operation: 'create',
        entityType: 'entry',
        entityId: 'row-not-a-uuid',
        status: 'pending',
      },
    ]);

    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: [], error: null }),
        upsert: async (values) => ({ data: [...values], error: null }),
      }),
    };

    const base = snapshot();
    const local = outboxLocal(state, {
      ...base,
      rows: [
        {
          id: 'row-not-a-uuid',
          data: { name: 'Old id' },
          category: 'Employee',
          deleted: false,
          updated_at: '2026-01-03T00:00:00.000Z',
        },
        base.rows[0] as unknown as DksLocalRow,
      ],
    });

    const result = await runSupabaseSync({ client, local });

    expect(result.status).toBe('error');
    expect(result.errors[0]).toContain('not a UUID');
    expect(state.failed).toEqual([{ id: 21, message: expect.stringContaining('not a UUID') }]);
    expect(result.pushedEntries).toBe(1);
  });
});

/**
 * B3 regression: "Sync error · N pending" where N only ever grew (3 -> 8).
 *
 * Root causes found and fixed:
 *   1. Soft-deleted columns were excluded from the sync snapshot, so their
 *      outbox items could never be consumed and the deletion never reached
 *      Supabase.
 *   2. The entry "remote wins" reconciliation branch applied the server row
 *      but never consumed the superseded outbox items.
 *   3. Settings outbox items were only cleared by a one-shot renderer save;
 *      if that failed they were never retried by the sync loop.
 *
 * These tests run the REAL SqliteStore outbox (including the real pending
 * count shown in the UI) against an in-memory Supabase double.
 */
describe('outbox queue drains after successful sync (B3)', () => {
  function createSqliteLocal() {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
    const snapshot = () => ({
      rows: store.listRows(true).map((row) => ({ ...row })) as unknown as DksLocalRow[],
      deletedRows: store.listRows(true).filter((row) => row.deleted === true)
        .map((row) => ({ ...row })) as unknown as DksLocalRow[],
      columns: store.listColumns(false).map((column) => ({ ...column })) as unknown as DksLocalColumn[],
      deletedColumns: store.listColumns(true).filter((column) => column.deleted === true)
        .map((column) => ({ ...column })) as unknown as DksLocalColumn[],
      settings: store.getSettings(),
      syncStatus: store.getSyncStatus() as unknown as DksLocalSnapshot['syncStatus'],
    });
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot(),
      setSyncStatus: async (state) => store.setSyncStatus(state as never) as unknown as DksLocalSnapshot['syncStatus'],
      applyRemoteSnapshot: async (input) => {
        for (const row of input.rows) {
          store.applyRemoteEntry(row as never);
        }
        for (const column of input.columns) {
          store.applyRemoteColumn(column as never);
        }
        return snapshot();
      },
      acknowledgeOutbox: async () => store.acknowledgeOutbox() as unknown as DksLocalSnapshot['syncStatus'],
      recordConflict: async (conflict) => {
        store.recordConflict({ ...conflict, resolved: false } as never);
      },
      listOutbox: async (input) => store.listOutbox(input?.status ?? 'all') as unknown as SupabaseOutboxItem[],
      markOutboxSynced: (id) => {
        store.markOutboxSynced(id);
      },
      markOutboxFailed: (id, message) => {
        store.markOutboxFailed(id, message);
      },
      retryFailedOutbox: async () => store.retryFailedOutbox(),
    };
    return { store, local };
  }

  function createFakeRemote(initial: Record<string, Record<string, unknown>[]> = {}, failSettings = false) {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const [table, rows] of Object.entries(initial)) {
      tables[table] = rows.map((row) => ({ ...row }));
    }
    const upserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: tables[table] ?? [], error: null }),
        upsert: async (values) => {
          if (failSettings && table === 'settings') {
            return { data: null, error: { message: 'settings write denied' } };
          }
          upserts.push({ table, values: values.map((value) => ({ ...value })) });
          const rows = tables[table] ?? (tables[table] = []);
          for (const value of values) {
            const key = typeof value.id === 'string' ? 'id' : 'key';
            const index = rows.findIndex((row) => row[key] === value[key]);
            if (index >= 0) {
              rows[index] = { ...rows[index], ...value };
            } else {
              rows.push({ ...value });
            }
          }
          return { data: [...values], error: null };
        },
      }),
      rpc: async (_name, args) => {
        const id = String(args.p_entry_id ?? '');
        tables.entries = (tables.entries ?? []).filter((row) => row.id !== id);
        return { data: null, error: null };
      },
    };
    return { client, tables, upserts };
  }

  it('drains the pending count to zero after a successful sync', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({
        id: '11111111-aaaa-4bbb-8ccc-000000000001',
        data: { name: 'Queued Person' },
        category: 'Employee',
      });
      expect(store.getPendingOutboxCount()).toBeGreaterThan(0);

      const { client } = createFakeRemote();
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('healthy');
      expect(store.getPendingOutboxCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('pushes a deleted column upstream and consumes its outbox item', async () => {
    const { store, local } = createSqliteLocal();
    try {
      const column = store.createColumn({
        id: '11111111-aaaa-4bbb-8ccc-000000000010',
        name: 'Temp Field',
        type: 'text',
        position: 0,
      });
      store.deleteColumn(column.id, 'admin');
      expect(store.getPendingOutboxCount()).toBeGreaterThan(0);

      const { client, upserts } = createFakeRemote();
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('healthy');
      const columnUpserts = upserts.filter((entry) => entry.table === 'app_columns');
      expect(columnUpserts.some((entry) => entry.values.some((value) => (
        value.name === 'Temp Field' && value.deleted === true
      )))).toBe(true);
      expect(store.getPendingOutboxCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('retries queued settings through the sync loop and clears them', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.setSettings({ theme: 'dark', notification_days: [7, 1] });
      expect(store.getPendingOutboxCount()).toBe(2);

      const { client, upserts } = createFakeRemote();
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('healthy');
      const settingsUpserts = upserts.filter((entry) => entry.table === 'settings');
      expect(settingsUpserts.flatMap((entry) => entry.values)).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'theme', value: 'dark' }),
        expect.objectContaining({ key: 'notification_days', value: [7, 1] }),
      ]));
      expect(store.getPendingOutboxCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('keeps settings items pending and reports the error when the remote rejects them', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.setSettings({ theme: 'dark' });

      const { client } = createFakeRemote({}, true);
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('error');
      expect(result.errors.join(' ')).toMatch(/settings/i);
      // Never cleared to hide the failure.
      expect(store.getPendingOutboxCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('consumes superseded outbox items when the server version wins', async () => {
    const { store, local } = createSqliteLocal();
    try {
      const row = store.createEntry({
        id: '11111111-aaaa-4bbb-8ccc-000000000002',
        data: { name: 'Edited locally' },
        category: 'Employee',
      });
      expect(store.getPendingOutboxCount()).toBe(1);

      const { client, tables } = createFakeRemote({
        entries: [{
          id: '11111111-aaaa-4bbb-8ccc-000000000002',
          data: { name: 'Edited elsewhere' },
          category: 'Employee',
          deleted: false,
          created_at: row.created_at,
          updated_at: '2026-01-06T00:00:00.000Z',
        }],
      });
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('healthy');
      expect(result.appliedEntries).toBe(1);
      expect(store.getPendingOutboxCount()).toBe(0);
      expect(store.getEntry('11111111-aaaa-4bbb-8ccc-000000000002')?.data)
        .toEqual({ name: 'Edited elsewhere' });
      expect(tables.entries[0].data).toEqual({ name: 'Edited elsewhere' });
    } finally {
      store.close();
    }
  });
});

/**
 * Blocker 3: "sync pending stuck" — pending must never hide and the exact
 * (sanitised) failure reason must reach the UI. The real SqliteStore outbox
 * (including the live pending count the sidebar shows) is exercised against
 * a Supabase double that rejects with a credential-bearing message.
 */
describe('sync failure surfacing (Blocker 3)', () => {
  function createSqliteLocal() {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
    const snapshot = () => ({
      rows: store.listRows(true).map((row) => ({ ...row })) as unknown as DksLocalRow[],
      deletedRows: store.listRows(true).filter((row) => row.deleted === true)
        .map((row) => ({ ...row })) as unknown as DksLocalRow[],
      columns: store.listColumns(false).map((column) => ({ ...column })) as unknown as DksLocalColumn[],
      deletedColumns: store.listColumns(true).filter((column) => column.deleted === true)
        .map((column) => ({ ...column })) as unknown as DksLocalColumn[],
      settings: store.getSettings(),
      syncStatus: store.getSyncStatus() as unknown as DksLocalSnapshot['syncStatus'],
    });
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot(),
      setSyncStatus: async (state) => store.setSyncStatus(state as never) as unknown as DksLocalSnapshot['syncStatus'],
      applyRemoteSnapshot: async (input) => {
        for (const row of input.rows) {
          store.applyRemoteEntry(row as never);
        }
        for (const column of input.columns) {
          store.applyRemoteColumn(column as never);
        }
        return snapshot();
      },
      acknowledgeOutbox: async () => store.acknowledgeOutbox() as unknown as DksLocalSnapshot['syncStatus'],
      recordConflict: async (conflict) => {
        store.recordConflict({ ...conflict, resolved: false } as never);
      },
      listOutbox: async (input) => store.listOutbox(input?.status ?? 'all') as unknown as SupabaseOutboxItem[],
      markOutboxSynced: (id) => {
        store.markOutboxSynced(id);
      },
      markOutboxFailed: (id, message) => {
        store.markOutboxFailed(id, message);
      },
      retryFailedOutbox: async () => store.retryFailedOutbox(),
    };
    return { store, local };
  }

  /** A remote that rejects every entries upsert with a fixed (secret-laden) message. */
  function createFailingRemote(message: string) {
    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: [], error: null }),
        upsert: async () => {
          if (table === 'entries') {
            return { data: null, error: { message } };
          }
          return { data: [], error: null };
        },
      }),
    };
    return { client };
  }

  const SECRET = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.deadbeef00112233';

  it('keeps pending visible and stores a sanitised per-item reason on rejection', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({
        id: '11111111-aaaa-4bbb-8ccc-000000000001',
        data: { name: 'Queued One' },
        category: 'Employee',
      });
      expect(store.getPendingOutboxCount()).toBeGreaterThan(0);

      const { client } = createFailingRemote(`row-level security violation: apikey=${SECRET} rejected`);
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('error');
      // The pending count is NEVER cleared to hide the failure.
      expect(store.getPendingOutboxCount()).toBeGreaterThan(0);
      const pending = store.listOutbox('failed');
      expect(pending.length).toBeGreaterThan(0);
      for (const item of pending) {
        const reason = String(item.lastError ?? item.last_error ?? '');
        // The credential never survives into the stored reason.
        expect(reason).not.toContain(SECRET);
        expect(reason).not.toContain('apikey=');
        // The actual failure reason still reaches the user.
        expect(reason).toContain('row-level security');
      }
      // The surfaced sync status error is sanitised too.
      const status = store.getSyncStatus();
      const lastError = String(status.lastError ?? '');
      expect(lastError).not.toContain(SECRET);
      expect(lastError).not.toContain('apikey=');
      expect(lastError).toContain('row-level security');
    } finally {
      store.close();
    }
  });

  it('drains to healthy and records lastSyncAt when the remote accepts', async () => {
    const { store, local } = createSqliteLocal();
    try {
      // The user's real scenario: 2 local rows -> 2 pending -> sync accepts.
      store.createEntry({
        id: '11111111-aaaa-4bbb-8ccc-000000000002',
        data: { name: 'Queued One' },
        category: 'Employee',
      });
      store.createEntry({
        id: '11111111-aaaa-4bbb-8ccc-000000000003',
        data: { name: 'Queued Two' },
        category: 'Employee',
      });
      expect(store.getPendingOutboxCount()).toBe(2);

      // Reuse the passing fake remote shape from the B3 suite above.
      const tables: Record<string, Record<string, unknown>[]> = { entries: [] };
      const client: SupabaseDataClient = {
        from: (table) => ({
          select: async () => ({ data: tables[table] ?? [], error: null }),
          upsert: async (values) => {
            const rows = tables[table] ?? (tables[table] = []);
            for (const value of values) {
              rows.push({ ...value });
            }
            return { data: [...values], error: null };
          },
        }),
        rpc: async (_name, args) => {
          const id = String(args.p_entry_id ?? '');
          tables.entries = (tables.entries ?? []).filter((row) => row.id !== id);
          return { data: null, error: null };
        },
      };
      const result = await runSupabaseSync({ client, local });

      expect(result.status).toBe('healthy');
      expect(store.getPendingOutboxCount()).toBe(0);
      const status = store.getSyncStatus();
      expect(status.status).toBe('healthy');
      expect(status.lastSyncAt).toBeTruthy();
      expect(status.lastError).toBeNull();
      expect(status.pendingCount).toBe(0);
    } finally {
      store.close();
    }
  });

  it('sanitizeSyncError redacts credentials while keeping the reason', () => {
    const secret = 'sk-live_9f8e7d6c5b4a3210';
    const raw = `upsert failed: fetch https://x.supabase.co/rest/v1/entries?apikey=${secret}`;
    const out = sanitizeSyncError(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain('upsert failed');
  });
});

/**
 * Entries INSERT RLS regression.
 *
 * Windows sync failed with:
 *   "new row violates row-level security policy for table 'entries'"
 *
 * Root cause: local rows never persist `created_by` and the sync payload
 * omitted it, so a fresh remote INSERT relied on the `created_by default
 * auth.uid()` column default. When that default did not resolve to the
 * session's UID, the entries INSERT policy (`created_by = auth.uid()`)
 * rejected the row.
 *
 * Fix under test: `toRemoteEntry` stamps `created_by` from the authenticated
 * session for FRESH inserts and omits it on updates (preserving the original
 * creator). These tests run the real store + sync against a remote double that
 * captures the exact entries payload, and evaluate it against a faithful copy
 * of the policy in supabase/schema.sql.
 */
describe('entries insert authorization (RLS regression)', () => {
  const ADMIN_UID = '846536af-f3c6-47c1-8559-d13442c1490a';
  const OFFICE_UID = '2a959122-d789-4f2e-8fdf-958260c2e3f9';

  function createSqliteLocal() {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
    const snapshot = () => ({
      rows: store.listRows(true).map((row) => ({ ...row })) as unknown as DksLocalRow[],
      deletedRows: store.listRows(true).filter((row) => row.deleted === true)
        .map((row) => ({ ...row })) as unknown as DksLocalRow[],
      columns: store.listColumns(false).map((column) => ({ ...column })) as unknown as DksLocalColumn[],
      deletedColumns: store.listColumns(true).filter((column) => column.deleted === true)
        .map((column) => ({ ...column })) as unknown as DksLocalColumn[],
      settings: store.getSettings(),
      syncStatus: store.getSyncStatus() as unknown as DksLocalSnapshot['syncStatus'],
    });
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot(),
      setSyncStatus: async (state) => store.setSyncStatus(state as never) as unknown as DksLocalSnapshot['syncStatus'],
      applyRemoteSnapshot: async (input) => {
        for (const row of input.rows) store.applyRemoteEntry(row as never);
        for (const column of input.columns) store.applyRemoteColumn(column as never);
        return snapshot();
      },
      acknowledgeOutbox: async () => store.acknowledgeOutbox() as unknown as DksLocalSnapshot['syncStatus'],
      recordConflict: async (conflict) => {
        store.recordConflict({ ...conflict, resolved: false } as never);
      },
      listOutbox: async (input) => store.listOutbox(input?.status ?? 'all') as unknown as SupabaseOutboxItem[],
      markOutboxSynced: (id) => {
        store.markOutboxSynced(id);
      },
      markOutboxFailed: (id, message) => {
        store.markOutboxFailed(id, message);
      },
      retryFailedOutbox: async () => store.retryFailedOutbox(),
    };
    return { store, local };
  }

  /** Remote double that returns seeded rows and captures the entries upsert payload. */
  function capturingRemote(initial: Record<string, Record<string, unknown>[]> = {}) {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const [table, rows] of Object.entries(initial)) {
      tables[table] = rows.map((row) => ({ ...row }));
    }
    const entriesUpserts: Record<string, unknown>[] = [];
    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: tables[table] ?? [], error: null }),
        upsert: async (values) => {
          if (table === 'entries') {
            for (const value of values) entriesUpserts.push({ ...value });
            const rows = tables[table] ?? (tables[table] = []);
            for (const value of values) {
              const index = rows.findIndex((row) => row.id === value.id);
              if (index >= 0) rows[index] = { ...rows[index], ...value };
              else rows.push({ ...value });
            }
          }
          return { data: values, error: null };
        },
      }),
    };
    return { client, entriesUpserts };
  }

  /**
   * Faithful copy of the entries INSERT policy in supabase/schema.sql:
   *   with check ((is_admin() or is_office()) and created_by = auth.uid() and not deleted)
   */
  function entriesInsertPolicyPasses(
    payload: Record<string, unknown>,
    authUid: string,
    role: 'admin' | 'office',
  ): boolean {
    const isAdmin = role === 'admin';
    const isOffice = role === 'office';
    return (
      (isAdmin || isOffice) &&
      payload.created_by === authUid &&
      payload.deleted === false
    );
  }

  it('stamps created_by with the authenticated uid so an Admin insert passes the policy', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({
        id: 'aaaaaaaa-1111-4111-8111-000000000001',
        data: { name: 'Ahmed' },
        category: 'Employee',
      });
      const { client, entriesUpserts } = capturingRemote();
      const result = await runSupabaseSync({ client, local, userId: ADMIN_UID });

      expect(result.status).toBe('healthy');
      expect(entriesUpserts.length).toBe(1);
      const payload = entriesUpserts[0];
      expect(payload.created_by).toBe(ADMIN_UID);
      expect(payload.deleted).toBe(false);
      expect(entriesInsertPolicyPasses(payload, ADMIN_UID, 'admin')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('stamps created_by with the authenticated uid so an Office insert passes the policy', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({
        id: 'aaaaaaaa-2222-4222-8222-000000000002',
        data: { name: 'Priya' },
        category: 'Family',
      });
      const { client, entriesUpserts } = capturingRemote();
      const result = await runSupabaseSync({ client, local, userId: OFFICE_UID });

      expect(result.status).toBe('healthy');
      expect(entriesUpserts.length).toBe(1);
      const payload = entriesUpserts[0];
      expect(payload.created_by).toBe(OFFICE_UID);
      expect(entriesInsertPolicyPasses(payload, OFFICE_UID, 'office')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('does NOT re-stamp created_by when updating an existing remote row', async () => {
    const rowId = 'aaaaaaaa-3333-4333-8333-000000000003';
    const { store, local } = createSqliteLocal();
    try {
      // Remote already has the row, created earlier by the Admin.
      const remoteSeed = {
        entries: [{
          id: rowId,
          data: { name: 'Original' },
          category: 'Employee',
          deleted: false,
          created_by: ADMIN_UID,
          version: 1,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }],
      };
      // Local copy edited later (newer updated_at) -> local wins -> UPDATE.
      store.createEntry({ id: rowId, data: { name: 'Edited' }, category: 'Employee' });

      const { client, entriesUpserts } = capturingRemote(remoteSeed);
      await runSupabaseSync({ client, local, userId: OFFICE_UID });

      expect(entriesUpserts.length).toBe(1);
      const payload = entriesUpserts[0];
      // created_by is omitted on updates so the original creator is preserved.
      expect('created_by' in payload).toBe(false);
    } finally {
      store.close();
    }
  });

  it('policy simulator rejects a mismatched created_by (sanity check)', () => {
    expect(entriesInsertPolicyPasses({ created_by: OFFICE_UID, deleted: false }, ADMIN_UID, 'admin')).toBe(false);
    expect(entriesInsertPolicyPasses({ created_by: ADMIN_UID, deleted: true }, ADMIN_UID, 'admin')).toBe(false);
  });
});
