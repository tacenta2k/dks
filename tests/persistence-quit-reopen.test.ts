/**
 * B5 persistence check — create -> full quit -> reopen -> still there.
 *
 * The packaged app's real path is exercised end to end:
 *   registerLocalIpcHandlers (real) -> SqliteStore on a real database FILE
 *   -> store.close() (app quit) -> brand-new SqliteStore on the same file
 *   (app start) -> storeSnapshot read path -> real runSupabaseSync pushing the
 *   queued items to the remote tables.
 *
 * Nothing is faked except the Supabase HTTP client itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LOCAL_IPC_CHANNELS,
  registerLocalIpcHandlers,
  type LocalIpcStore,
} from '../electron/main/local-ipc';
import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseSyncLocal,
  type SupabaseOutboxItem,
} from '../src/features/sync/supabase-sync';
import type { DksLocalColumn, DksLocalRow, DksLocalSnapshot } from '../src/lib/types';

function registerWithMockIpcMain(store: LocalIpcStore) {
  const registered = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
      registered.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      registered.delete(channel);
    },
  };
  const unregister = registerLocalIpcHandlers({ ipcMain: ipcMain as never, store });
  return { registered, unregister };
}

function createFakeRemote() {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const apply = (table: string, values: readonly Record<string, unknown>[]) => {
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
  };
  const client: SupabaseDataClient = {
    from: (table) => ({
      select: async () => ({ data: tables[table] ?? [], error: null }),
      // R3 batch G: entries/columns are written with an explicit INSERT or
      // UPDATE; only settings may be upserted.
      insert: async (values) => {
        apply(table, values);
        return { data: [...values], error: null };
      },
      update: (values) => ({
        eq: async (_column: string, id: string) => {
          apply(table, [{ ...values, id }]);
          return { data: null, error: null };
        },
      }),
      upsert: async (values) => {
        if (table !== 'settings') {
          return {
            data: null,
            error: { message: `unexpected upsert for ${table}` },
          };
        }
        apply(table, values);
        return { data: [...values], error: null };
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, tables };
}

function sqliteSyncLocal(store: ReturnType<typeof makeStore>): SupabaseSyncLocal {
  const snapshot = (): DksLocalSnapshot => ({
    rows: store.listRows(true).map((row) => ({ ...row })) as unknown as DksLocalRow[],
    deletedRows: store.listRows(true).filter((row) => row.deleted === true)
      .map((row) => ({ ...row })) as unknown as DksLocalRow[],
    columns: store.listColumns(false).map((column) => ({ ...column })) as unknown as DksLocalColumn[],
    deletedColumns: store.listColumns(true).filter((column) => column.deleted === true)
      .map((column) => ({ ...column })) as unknown as DksLocalColumn[],
    settings: store.getSettings(),
    syncStatus: store.getSyncStatus() as unknown as DksLocalSnapshot['syncStatus'],
  });
  return {
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
}

type SqliteStoreModule = typeof import('../electron/main/sqlite');
let sqlite: SqliteStoreModule | null = null;

function makeStore(filename: string) {
  if (!sqlite) {
    throw new Error('sqlite module not loaded');
  }
  return sqlite.createSqliteStore({ filename });
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('persistence across full app restart (B5)', () => {
  it('keeps created rows, columns and changed settings after quit -> reopen, and pushes them to Supabase', async () => {
    sqlite = await import('../electron/main/sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'dks-b5-'));
    tempDirs.push(dir);
    const filename = join(dir, 'dks.db');

    // ---------- session 1: user creates data, then the app quits ----------
    {
      const store = makeStore(filename);
      const { registered, unregister } = registerWithMockIpcMain(store);
      try {
        // Row created through the exact IPC payload electron-repository sends.
        const row = await registered.get(LOCAL_IPC_CHANNELS.createRow)!({}, {
          data: { 'Full Name': 'B5 Persisted Person', 'Passport No': 'B5-1234567' },
          category: 'Employee',
        });
        expect(row).toMatchObject({ id: expect.any(String) });

        // Column created through the IPC payload the column wizard sends.
        const column = await registered.get(LOCAL_IPC_CHANNELS.addColumn)!({}, {
          name: 'B5 Custom Notes',
          type: 'text',
          role: 'admin',
        });
        expect(column).toMatchObject({ name: 'B5 Custom Notes' });

        // A changed setting (App.tsx local.setSettings payload shape).
        await registered.get(LOCAL_IPC_CHANNELS.setSettings)!({}, {
          settings: {
            primary_expiry_column_id: 'visa_expiry',
            weekly_summary_enabled: true,
            weekly_summary_day: 5,
            daily_summary_time: '08:15',
          },
        });
      } finally {
        unregister();
        store.close(); // full application quit
      }
    }

    // ---------- session 2: app restarts and opens the same database ----------
    {
      const store = makeStore(filename);
      const { registered, unregister } = registerWithMockIpcMain(store);
      try {
        // The startup read path the renderer uses (get-snapshot).
        const snapshot = await registered.get(LOCAL_IPC_CHANNELS.getSnapshot)!({}, undefined) as {
          rows: Array<{ data: Record<string, unknown> }>;
          columns: Array<{ name: string }>;
          settings: Record<string, unknown>;
        };

        const persistedRow = snapshot.rows.find((entry) => entry.data['Full Name'] === 'B5 Persisted Person');
        expect(persistedRow).toBeTruthy();
        expect(persistedRow?.data['Passport No']).toBe('B5-1234567');

        expect(snapshot.columns.some((entry) => entry.name === 'B5 Custom Notes')).toBe(true);

        expect(snapshot.settings).toMatchObject({
          primary_expiry_column_id: 'visa_expiry',
          weekly_summary_enabled: true,
          weekly_summary_day: 5,
          daily_summary_time: '08:15',
        });

        // The creates are still queued (never silently dropped across restart).
        expect(store.getPendingOutboxCount()).toBeGreaterThan(0);

        // ---------- real sync pushes them into the remote tables ----------
        const { client, tables } = createFakeRemote();
        const result = await runSupabaseSync({ client, local: sqliteSyncLocal(store) });

        expect(result.status).toBe('healthy');
        expect(result.errors ?? []).toEqual([]);

        // Row present in the remote entries table.
        expect((tables.entries ?? []).some((entry) => {
          const data = entry.data as Record<string, unknown> | undefined;
          return data?.['Full Name'] === 'B5 Persisted Person';
        })).toBe(true);

        // Column present in the remote app_columns table.
        expect((tables.app_columns ?? []).some((entry) => entry.name === 'B5 Custom Notes')).toBe(true);

        // Changed setting present in the remote settings table.
        const remoteSettings = Object.fromEntries(
          (tables.settings ?? []).map((entry) => [String(entry.key), entry.value]),
        );
        expect(remoteSettings['primary_expiry_column_id']).toBe('visa_expiry');
        expect(remoteSettings['weekly_summary_enabled']).toBe(true);
        expect(remoteSettings['weekly_summary_day']).toBe(5);
        expect(remoteSettings['daily_summary_time']).toBe('08:15');

        // And the queue drained — the changes are in Supabase, not stuck local.
        expect(store.getPendingOutboxCount()).toBe(0);
      } finally {
        unregister();
        store.close();
      }
    }
  });
});
