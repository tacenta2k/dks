import { describe, expect, it } from 'vitest';

import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseOutboxItem,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalColumn, DksLocalRow, DksLocalSnapshot } from '../src/lib/types';

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
