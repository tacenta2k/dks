import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isDuplicateColumnKeyError,
  isDuplicateColumnNameError,
  resolveRemoteColumnByName,
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseOutboxItem,
  type SupabaseConflict,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import { createSqliteStore } from '../electron/main/sqlite';
import type { DksLocalSnapshot } from '../src/lib/types';

/**
 * R3 batch B — Office sync failed with
 *   Column Visa Expiry: duplicate key value violates unique constraint
 *   "app_columns_name_key"
 * because `app_columns.name` is unique across the table (soft-deleted columns
 * keep their name) and Office cannot SELECT a deleted row.
 *
 * The sync now asks the server which row owns the name and reconciles:
 *  - identical definition → adopt the server id (entry JSON keys included);
 *  - different definition → keep both, record a conflict, readable reason;
 *  - no lookup RPC yet     → say which SQL file to run, never retry blindly.
 */

const OFFICE_UID = '2a959122-d789-4f2e-8fdf-958260c2e3f9';
const LOCAL_COLUMN_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_COLUMN_ID = '22222222-2222-4222-8222-222222222222';
const ROW_ID = 'aaaaaaaa-4444-4444-8444-000000000004';

interface RemoteColumn {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown>;
  position?: number;
  visible?: boolean;
  is_primary_expiry?: boolean;
  is_passport?: boolean;
  deleted?: boolean;
  deleted_at?: string | null;
  updated_at?: string;
}

interface FakeServerOptions {
  columns?: RemoteColumn[];
  /** Rows Office cannot SELECT (deleted) are still returned by the RPC. */
  hiddenColumns?: RemoteColumn[];
  /** Fail the insert with the real Postgres message. */
  duplicateOnInsert?: boolean;
  /** Fail the insert outright with this Postgres message (e.g. the pkey case). */
  insertError?: string;
  /** Omit the RPC entirely (migration not run). */
  withoutRpc?: boolean;
  rpcThrows?: string;
}

function createFakeServer(options: FakeServerOptions = {}) {
  const visible = options.columns ?? [];
  const hidden = options.hiddenColumns ?? [];
  const calls: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const client: SupabaseDataClient = {
    from: (table) => ({
      select: async () => {
        calls.push(`select:${table}`);
        return { data: table === 'app_columns' ? [...visible] : [], error: null };
      },
      upsert: async (values) => {
        calls.push(`upsert:${table}`);
        return { data: [...values], error: null };
      },
      insert: async (values) => {
        calls.push(`insert:${table}`);
        if (options.insertError) {
          return { data: null, error: { message: options.insertError } };
        }
        if (table === 'app_columns' && options.duplicateOnInsert !== false) {
          const clash = [...visible, ...hidden].some((column) => (
            values.some((value) => (
              String(value.name ?? '').toLowerCase() === column.name.toLowerCase()
            ))
          ));
          if (clash) {
            return {
              data: null,
              error: {
                message: 'duplicate key value violates unique constraint "app_columns_name_key"',
              },
            };
          }
        }
        if (table === 'app_columns') inserts.push(...values);
        return { data: [...values], error: null };
      },
      update: (values) => ({
        eq: async (_column: string, id: string) => {
          calls.push(`update:${table}:${id}`);
          if (table === 'app_columns') updates.push({ id, ...values });
          return { data: null, error: null };
        },
      }),
    }),
    ...(options.withoutRpc
      ? {}
      : {
        rpc: async (name: string, args: Record<string, unknown>) => {
          rpcCalls.push({ name, args });
          if (options.rpcThrows) {
            return { data: null, error: { message: options.rpcThrows } };
          }
          if (name === 'resolve_duplicate_column') {
            const wanted = String(args.p_name ?? '').trim().toLowerCase();
            const match = hidden.find((column) => column.name.trim().toLowerCase() === wanted);
            return { data: match ?? null, error: null };
          }
          return { data: null, error: null };
        },
      }),
  };

  return { client, calls, inserts, updates, rpcCalls };
}

function sqliteLocal() {
  const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
  const snapshot = (): DksLocalSnapshot => ({
    rows: store.listRows(true).map((row) => ({ ...row })) as never,
    deletedRows: store.listRows(true).filter((row) => row.deleted === true).map((row) => ({ ...row })) as never,
    columns: store.listColumns(true).map((column) => ({ ...column })) as never,
    deletedColumns: [],
    settings: store.getSettings(),
    syncStatus: store.getSyncStatus() as never,
  });
  const conflicts: SupabaseConflict[] = [];
  const reported: string[] = [];
  const local: SupabaseSyncLocal = {
    getSnapshot: async () => snapshot(),
    setSyncStatus: async (state) => store.setSyncStatus(state as never) as never,
    applyRemoteSnapshot: async (input) => {
      for (const row of input.rows) store.applyRemoteEntry(row as never);
      for (const column of input.columns) store.applyRemoteColumn(column as never);
      return snapshot();
    },
    acknowledgeOutbox: async () => store.acknowledgeOutbox() as never,
    recordConflict: async (conflict) => {
      conflicts.push(conflict);
    },
    listOutbox: async (input) => store.listOutbox(input?.status ?? 'all') as unknown as SupabaseOutboxItem[],
    markOutboxSynced: (id) => {
      store.markOutboxSynced(id);
    },
    markOutboxFailed: (id, message) => {
      store.markOutboxFailed(id, message);
      reported.push(message);
    },
    retryFailedOutbox: async () => store.retryFailedOutbox(),
    rekeyColumn: (oldId, newId) => {
      store.rekeyColumn(oldId, newId);
    },
  };
  return { store, local, conflicts, reported };
}

function seededColumn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LOCAL_COLUMN_ID,
    name: 'Visa Expiry',
    type: 'date_expiry',
    options: {},
    position: 2,
    visible: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('duplicate column name errors are recognised', () => {
  it('matches the real Postgres message without matching unrelated failures', () => {
    expect(isDuplicateColumnNameError(
      'duplicate key value violates unique constraint "app_columns_name_key"',
    )).toBe(true);
    expect(isDuplicateColumnNameError('duplicate key value violates unique constraint "entries_pkey"')).toBe(false);
    expect(isDuplicateColumnNameError('new row violates row-level security policy')).toBe(false);
  });
});

describe('duplicate primary key on column insert (23505 app_columns_pkey)', () => {
  it('treats an already-present row as created: updates it and acknowledges the outbox item', async () => {
    // Root cause of the stuck pill: a replayed column insert hits the primary
    // key (the row is already on the server, e.g. it was created on another
    // device or the ack was lost). That is NOT an error to show the user — the
    // column exists. The old catch only retried the name conflict, so the item
    // went to `failed` with a raw "duplicate key value violates unique
    // constraint app_columns_pkey" and the pill stayed red forever.
    const { store, local, conflicts, reported } = sqliteLocal();
    try {
      store.createColumn(seededColumn() as never);
      const server = createFakeServer({
        columns: [],
        insertError: 'duplicate key value violates unique constraint "app_columns_pkey"',
      });

      const result = await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('healthy');
      // The item was resolved by writing the row under its own id.
      expect(server.inserts).toHaveLength(0);
      expect(server.updates).toEqual([
        expect.objectContaining({ id: LOCAL_COLUMN_ID, name: 'Visa Expiry' }),
      ]);
      expect(store.listOutbox('all').filter((item) => item.entityType === 'column'))
        .toEqual([expect.objectContaining({ status: 'synced' })]);
      // Nothing user-facing: no failed message, no conflict, still one column.
      expect(reported.join(' ')).not.toMatch(/duplicate key|unique constraint|pkey/i);
      expect(conflicts).toHaveLength(0);
      expect(store.listColumns(true).map((column) => column.id)).toEqual([LOCAL_COLUMN_ID]);
    } finally {
      store.close();
    }
  });

  it('recognises a primary-key clash without swallowing other failures', () => {
    expect(isDuplicateColumnKeyError(
      'duplicate key value violates unique constraint "app_columns_pkey"',
    )).toBe(true);
    expect(isDuplicateColumnKeyError(
      '23505: duplicate key value violates unique constraint "app_columns_pkey"',
    )).toBe(true);
    expect(isDuplicateColumnKeyError(
      'duplicate key value violates unique constraint "entries_pkey"',
    )).toBe(false);
    expect(isDuplicateColumnKeyError('duplicate key value violates unique constraint "app_columns_name_key"'))
      .toBe(false);
    expect(isDuplicateColumnKeyError('new row violates row-level security policy')).toBe(false);
  });

  it('still reports a readable reason when the replay cannot be updated either', async () => {
    const { store, local, reported } = sqliteLocal();
    try {
      store.createColumn(seededColumn() as never);
      const server = createFakeServer({
        columns: [],
        insertError: 'duplicate key value violates unique constraint "app_columns_pkey"',
      });
      // Office may not UPDATE a soft-deleted row: the replay is genuinely stuck.
      const blocked = {
        ...server.client,
        from: (table: string) => {
          const base = server.client.from(table);
          return {
            ...base,
            update: () => ({
              eq: async () => ({
                data: null,
                error: { message: 'new row violates row-level security policy for table "app_columns"' },
              }),
            }),
          };
        },
      };

      await runSupabaseSync({ client: blocked as typeof server.client, local, userId: OFFICE_UID });

      // The tab still surfaces the real reason instead of a raw Postgres dump.
      expect(reported.join(' ')).toContain('already exists on the server');
      expect(reported.join(' ')).not.toContain('duplicate key value violates');
    } finally {
      store.close();
    }
  });
});

describe('duplicate column reconciliation (Office)', () => {
  it('adopts the server id when the definition is identical and rewrites entry keys', async () => {
    const { store, local, conflicts, reported } = sqliteLocal();
    try {
      store.createColumn(seededColumn() as never);
      const created = store.createEntry({ data: { [LOCAL_COLUMN_ID]: '2027-03-01' }, category: 'Employee' });
      const remoteColumn: RemoteColumn = {
        id: REMOTE_COLUMN_ID,
        name: 'Visa Expiry',
        type: 'date_expiry',
        options: {},
        deleted: true,
        updated_at: '2026-01-01T00:00:00.000Z',
      };
      const server = createFakeServer({ columns: [], hiddenColumns: [remoteColumn] });

      const result = await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      // The queued column item is acknowledged, not left failing.
      expect(result.status).toBe('healthy');
      expect(store.listOutbox('all').filter((item) => item.entityType === 'column'))
        .toEqual([expect.objectContaining({ status: 'synced' })]);
      // The server row was updated, never inserted a second time.
      expect(server.inserts).toHaveLength(0);
      expect(server.updates[0]).toEqual(expect.objectContaining({ id: REMOTE_COLUMN_ID }));

      // The local column now carries the server id ...
      const columns = store.listColumns(true);
      expect(columns.map((column) => column.id)).toEqual([REMOTE_COLUMN_ID]);
      // ... and the entry value moved with it (nothing was lost).
      const row = store.listRows(true).find((candidate) => candidate.id === created.id);
      expect((row?.data as Record<string, unknown>)[REMOTE_COLUMN_ID]).toBe('2027-03-01');
      expect((row?.data as Record<string, unknown>)[LOCAL_COLUMN_ID]).toBeUndefined();

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toEqual(expect.objectContaining({ entityType: 'column', winner: 'remote' }));
      expect(reported.join(' ')).not.toContain('unique constraint');
    } finally {
      store.close();
    }
  });

  it('keeps both versions and surfaces a readable conflict when the definitions differ', async () => {
    const { store, local, conflicts, reported } = sqliteLocal();
    try {
      store.createColumn(seededColumn({ type: 'text' }) as never);
      const remoteColumn: RemoteColumn = {
        id: REMOTE_COLUMN_ID,
        name: 'Visa Expiry',
        type: 'date_expiry',
        options: { format: 'DD/MM/YYYY' },
        deleted: true,
      };
      const server = createFakeServer({ columns: [], hiddenColumns: [remoteColumn] });

      const result = await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('error');
      // Nothing deleted, nothing renamed: the local column and its type stay.
      expect(store.listColumns(true)).toEqual([
        expect.objectContaining({ id: LOCAL_COLUMN_ID, name: 'Visa Expiry', type: 'text' }),
      ]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].winner).toBe('local');
      const [item] = store.listOutbox('all').filter((row) => row.entityType === 'column');
      expect(item.status).toBe('failed');
      expect(item.lastError).toMatch(/different type or options/i);
      expect(item.lastError).toMatch(/administrator/i);
      expect(reported.join(' ')).not.toContain('unique constraint');
    } finally {
      store.close();
    }
  });

  it('tells the user which SQL file to run when the lookup RPC is missing', async () => {
    const { store, local } = sqliteLocal();
    try {
      store.createColumn(seededColumn() as never);
      const server = createFakeServer({
        columns: [],
        hiddenColumns: [{ id: REMOTE_COLUMN_ID, name: 'Visa Expiry', type: 'date_expiry' }],
        withoutRpc: true,
      });

      await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      const [item] = store.listOutbox('all').filter((row) => row.entityType === 'column');
      expect(item.status).toBe('failed');
      expect(item.lastError).toContain('ARENA/sql/fix-column-sync.sql');
      // The local column is untouched and the value is not lost.
      expect(store.listColumns(true)[0]).toEqual(expect.objectContaining({ id: LOCAL_COLUMN_ID }));
    } finally {
      store.close();
    }
  });

  it('reports a clear reason when the lookup itself fails', async () => {
    const { store, local } = sqliteLocal();
    try {
      store.createColumn(seededColumn() as never);
      const server = createFakeServer({
        columns: [],
        hiddenColumns: [{ id: REMOTE_COLUMN_ID, name: 'Visa Expiry', type: 'date_expiry' }],
        rpcThrows: 'permission denied for function resolve_duplicate_column',
      });

      await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      const [item] = store.listOutbox('all').filter((row) => row.entityType === 'column');
      expect(item.status).toBe('failed');
      expect(item.lastError).toMatch(/could not be inspected/i);
      expect(item.lastError).toContain('permission denied');
    } finally {
      store.close();
    }
  });

  it('pulls shared columns before pushing any new local column', async () => {
    const { store, local } = sqliteLocal();
    try {
      store.createColumn(seededColumn({ name: 'Nationality', type: 'text' }) as never);
      const server = createFakeServer({
        // A column that exists only on the server must be pulled first.
        columns: [{
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Department',
          type: 'text',
          position: 3,
        }],
        duplicateOnInsert: false,
      });

      await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      const selectIndex = server.calls.indexOf('select:app_columns');
      const insertIndex = server.calls.indexOf('insert:app_columns');
      expect(selectIndex).toBeGreaterThanOrEqual(0);
      if (insertIndex >= 0) {
        expect(selectIndex).toBeLessThan(insertIndex);
      }
      expect(store.listColumns(true).map((column) => column.name).sort())
        .toEqual(['Department', 'Nationality']);
    } finally {
      store.close();
    }
  });

  it('flags two local columns that share a name instead of retrying an impossible insert', async () => {
    const { store, local, reported } = sqliteLocal();
    try {
      // A second column with a case-only different name would break the unique
      // name on the server; the store allows it, so the sync must catch it.
      store.createColumn(seededColumn() as never);
      store.createColumn({
        ...seededColumn({ id: '44444444-4444-4444-8444-444444444444' }),
        name: 'visa expiry',
      } as never);
      const server = createFakeServer({ columns: [], duplicateOnInsert: false });

      await runSupabaseSync({ client: server.client, local, userId: OFFICE_UID });

      expect(reported.join(' ')).toMatch(/both named/i);
      const failed = store.listOutbox('all').filter((row) => row.status === 'failed');
      expect(failed.length).toBeGreaterThan(0);
      // Nothing was deleted to work around the clash.
      expect(store.listColumns(true)).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe('column reconciliation SQL', () => {
  const files = ['supabase/schema.sql', 'ARENA/sql/fix-column-sync.sql'];

  it.each(files)('%s ships the scoped, read-only resolver', (file) => {
    const sql = readFileSync(resolve(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toLowerCase();
    expect(sql).toContain('create or replace function public.resolve_duplicate_column');
    expect(sql).toContain('security definer');
    expect(sql).toContain('grant execute on function public.resolve_duplicate_column(text) to authenticated');
    expect(sql).not.toContain('grant execute on function public.resolve_duplicate_column(text) to anon');
    // Read-only: no writes anywhere in this function body.
    const body = (sql.split('create or replace function public.resolve_duplicate_column')[1] ?? '')
      .split('$$')[1] ?? '';
    expect(body).not.toMatch(/\binsert into\b/);
    expect(body).not.toMatch(/\bdelete from\b/);
    // The unique constraint stays in place.
    expect(sql).not.toContain('drop constraint if exists app_columns_name_key');
    expect(sql).not.toContain('drop index if exists app_columns_name_key');
  });
});

describe('fix-column-sync.sql — preflight and schema compatibility (R3 batch G)', () => {
  const sqlPath = resolve(process.cwd(), 'ARENA/sql/fix-column-sync.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  const schema = readFileSync(resolve(process.cwd(), 'supabase/schema.sql'), 'utf8');

  it('documents the exact fields the client and function need', () => {
    for (const column of [
      'name', 'type', 'options', 'position', 'visible',
      'is_primary_expiry', 'is_passport', 'deleted', 'deleted_at', 'updated_at',
    ]) {
      expect(sql).toContain(`('${column}'`);
    }
    expect(sql).toContain("table_name = 'app_columns'");
    expect(sql).toContain('information_schema.columns');
    expect(sql).toContain('SECTION 0 — PREFLIGHT');
  });

  it('adds only the missing app_columns fields, additively', () => {
    for (const column of [
      'options jsonb not null default',
      'visible boolean not null default true',
      'is_primary_expiry boolean not null default false',
      'is_passport boolean not null default false',
      'updated_at timestamptz not null default now()',
      'deleted boolean not null default false',
      'deleted_at timestamptz',
    ]) {
      expect(sql).toContain(`alter table public.app_columns add column if not exists ${column}`);
    }
    // Additive only: never weaken the unique constraint or rewrite data.
    expect(sql).not.toMatch(/drop constraint/i);
    expect(sql).not.toMatch(/drop column/i);
    expect(sql).not.toMatch(/rename column/i);
    expect(sql).not.toMatch(/delete from public\.app_columns/i);
    expect(sql).not.toMatch(/update public\.app_columns/i);
  });

  it('reads app_columns through jsonb so an absent optional field cannot fail a call', () => {
    expect(sql).toContain('v_row jsonb;');
    expect(sql).toContain('select to_jsonb(c)');
    expect(sql).toContain("coalesce((to_jsonb(c) ->> 'deleted')::boolean, false)");
    expect(sql).not.toContain('v_row public.app_columns;');
    // Mirrored in the shipped schema for fresh installs.
    expect(schema).toContain('select to_jsonb(c)');
    expect(schema).not.toContain('v_row public.app_columns;');
  });

  it('never grants the resolver to anon and keeps it read-only', () => {
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/grant[^;]*to anon/i);
    expect(statements).not.toMatch(/grant[^;]*to public/i);
    expect(statements).toContain('grant execute on function public.resolve_duplicate_column(text) to authenticated');
    expect(statements).not.toMatch(/delete from public\.app_columns/i);
    expect(statements).not.toMatch(/insert into public\.app_columns/i);
  });
});
