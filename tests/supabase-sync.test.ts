import { describe, expect, it } from 'vitest';

import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalColumn, DksLocalRow, DksLocalSnapshot } from '../src/lib/types';

function snapshot(): DksLocalSnapshot {
  return {
    rows: [{
      id: 'entry-local',
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
        id: 'entry-remote',
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
      expect.objectContaining({ id: 'entry-local', data: { name: 'Local winner' } }),
    ]));
    expect(localSnapshot.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'entry-remote', data: { name: 'Remote winner' } }),
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
              id: 'entry-local',
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
      entityId: 'entry-local',
      winner: 'remote',
    }));
    expect(conflicts).toHaveLength(1);
  });
});
