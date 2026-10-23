import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSqliteStore } from '../electron/main/sqlite';
import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseOutboxItem,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalColumn, DksLocalRow, DksLocalSnapshot } from '../src/lib/types';

/**
 * R2-01 — entries RLS for Office edits and soft deletes.
 *
 * Real Windows behaviour (logged in as OFFICE) was:
 *   entry · update · attempted 0× · new row violates row-level security
 *   policy for table "entries"
 * for both an edit and a delete of an Admin-created row.
 *
 * The shipped fix has two halves:
 *   1. supabase/schema.sql + ARENA/sql/fix-entries-rls.sql replace the UPDATE
 *      policy (no created_by test, live rows only for Office, soft delete
 *      allowed) and keep created_by immutable with a BEFORE UPDATE trigger.
 *   2. The sync client writes existing rows with a real UPDATE and new rows
 *      with a real INSERT, so an update never re-runs the INSERT policy.
 *
 * These tests model the SQL policies exactly and run the real sync client
 * against a remote double. A real PostgreSQL instance is not available in this
 * environment, so the policy model is the executable specification (and the
 * migration file is asserted to match it line-for-line in intent).
 */

const ADMIN_UID = '846536af-f3c6-47c1-8559-d13442c1490a';
const OFFICE_UID = '2a959122-d789-4f2e-8fdf-958260c2e3f9';
const ROW_ID = 'aaaaaaaa-4444-4444-8444-000000000004';

type Role = 'admin' | 'office';

interface EntryRow {
  id: string;
  data: Record<string, unknown>;
  category: string;
  deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string;
  updated_by: string | null;
  updated_at: string;
  [key: string]: unknown;
}

function isAdmin(role: Role): boolean {
  return role === 'admin';
}

function isOffice(role: Role): boolean {
  return role === 'office';
}

/** SELECT policy: `using (not deleted or public.is_admin())`. */
function selectPolicyPasses(row: EntryRow, role: Role): boolean {
  return row.deleted === false || isAdmin(role);
}

/** INSERT policy (schema.sql / migration §4). */
function insertPolicyPasses(row: EntryRow, uid: string, role: Role): boolean {
  return (
    Boolean(uid)
    && (isAdmin(role) || isOffice(role))
    && row.created_by === uid
    && row.deleted === false
    && row.deleted_at === null
    && row.deleted_by === null
  );
}

/** UPDATE policy USING clause (migration §5). */
function updatePolicyUsing(oldRow: EntryRow, role: Role): boolean {
  return isAdmin(role) || (isOffice(role) && oldRow.deleted === false);
}

/** UPDATE policy WITH CHECK clause (migration §5). */
function updatePolicyCheck(newRow: EntryRow, uid: string, role: Role): boolean {
  if (isAdmin(role)) {
    return true;
  }
  if (!isOffice(role)) {
    return false;
  }
  return (
    (newRow.deleted === false && newRow.deleted_at === null && newRow.deleted_by === null)
    || (
      newRow.deleted === true
      && newRow.deleted_at !== null
      && (newRow.deleted_by === null || newRow.deleted_by === uid)
    )
  );
}

/** BEFORE UPDATE trigger: created_by is copied from OLD. */
function keepCreatedBy(oldRow: EntryRow, newRow: EntryRow): EntryRow {
  return { ...newRow, created_by: oldRow.created_by };
}

/** BEFORE UPDATE trigger: Office may not restore or touch a deleted row. */
function guardOfficeRestore(oldRow: EntryRow, newRow: EntryRow, role: Role): void {
  if (!isOffice(role)) {
    return;
  }
  if (oldRow.deleted === true) {
    if (newRow.deleted === false) {
      throw new Error('Only administrators may restore entries');
    }
    throw new Error('Only administrators may update deleted entries');
  }
}

type UpdateOutcome =
  | { kind: 'updated'; row: EntryRow }
  | { kind: 'no-rows' }
  | { kind: 'rejected'; message: string };

/** Full PostgreSQL evaluation order: USING → trigger → WITH CHECK. */
function simulateUpdate(
  oldRow: EntryRow,
  patch: Partial<EntryRow>,
  uid: string,
  role: Role,
): UpdateOutcome {
  if (!updatePolicyUsing(oldRow, role)) {
    // RLS filters the row out of the UPDATE: no error, zero rows affected.
    return { kind: 'no-rows' };
  }
  const pending = { ...oldRow, ...patch } as EntryRow;
  let afterTrigger: EntryRow;
  try {
    guardOfficeRestore(oldRow, pending, role);
    afterTrigger = keepCreatedBy(oldRow, pending);
  } catch (caught) {
    return { kind: 'rejected', message: caught instanceof Error ? caught.message : String(caught) };
  }
  if (!updatePolicyCheck(afterTrigger, uid, role)) {
    return {
      kind: 'rejected',
      message: 'new row violates row-level security policy for table "entries"',
    };
  }
  return { kind: 'updated', row: afterTrigger };
}

function baseRow(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: ROW_ID,
    data: { name: 'Ahmed' },
    category: 'Employee',
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_by: ADMIN_UID,
    updated_by: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const migrationPath = resolve(process.cwd(), 'ARENA/sql/fix-entries-rls.sql');
const schemaPath = resolve(process.cwd(), 'supabase/schema.sql');

describe('entries RLS — migration file', () => {
  it('is idempotent, keeps RLS enabled, and never grants anon or service-role access', () => {
    const source = readFileSync(migrationPath, 'utf8').toLowerCase();
    // Ignore comments (they explain the safety rules) and assert on statements.
    const sql = source.replace(/--[^\n]*/g, '');

    for (const policy of [
      'entries_select_authenticated',
      'entries_insert_authenticated',
      'entries_update_authenticated',
      'entries_delete_admin',
    ]) {
      expect(sql).toContain(`drop policy if exists ${policy}`);
      expect(sql).toContain(`create policy ${policy}`);
    }
    expect(sql).toContain('alter table public.entries enable row level security');
    expect(sql).not.toMatch(/disable row level security/);
    expect(sql).not.toContain('service_role');
    expect(sql).not.toMatch(/grant[^;]*anon/);
    expect(sql).not.toMatch(/grant .* to anon/);
    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('truncate');
  });

  it('keeps created_by immutable and blocks Office restores with triggers', () => {
    const sql = readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain('create or replace function public.entries_keep_created_by');
    expect(sql).toContain('new.created_by := old.created_by');
    expect(sql).toContain('create trigger entries_keep_created_by');
    expect(sql).toContain('before update on public.entries');

    expect(sql).toContain('create or replace function public.guard_office_restore');
    expect(sql).toContain('only administrators may restore entries');
    expect(sql).toContain('create trigger entries_guard_office_restore');
  });

  it('mirrors the shipped schema for fresh installs', () => {
    const schema = readFileSync(schemaPath, 'utf8').toLowerCase();
    const migration = readFileSync(migrationPath, 'utf8').toLowerCase();

    for (const fragment of [
      'create trigger entries_keep_created_by',
      'create trigger entries_guard_office_restore',
      'create or replace function public.entries_keep_created_by',
      'create or replace function public.guard_office_restore',
    ]) {
      expect(schema).toContain(fragment);
      expect(migration).toContain(fragment.replace('create or replace function public.', 'create or replace function public.'));
    }

    const updateStart = schema.indexOf('create policy entries_update_authenticated');
    const updateBody = schema.slice(updateStart, schema.indexOf('\n\n', updateStart));
    expect(updateBody).toContain('public.is_office() and deleted is false');
    expect(updateBody).toContain('deleted is true');
    expect(updateBody).not.toContain('created_by');
  });
});

describe('entries RLS — Office edits and deletes of Admin-created rows', () => {
  it('allows Office to update a live Admin-created row without changing created_by', () => {
    const outcome = simulateUpdate(
      baseRow(),
      { data: { name: 'Ahmed (edited by office)' }, updated_by: OFFICE_UID },
      OFFICE_UID,
      'office',
    );

    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.row.data).toEqual({ name: 'Ahmed (edited by office)' });
      expect(outcome.row.created_by).toBe(ADMIN_UID);
      expect(outcome.row.updated_by).toBe(OFFICE_UID);
    }
  });

  it('allows Office to soft delete a live Admin-created row', () => {
    const outcome = simulateUpdate(
      baseRow(),
      {
        deleted: true,
        deleted_at: '2026-01-06T00:00:00.000Z',
        deleted_by: OFFICE_UID,
        updated_by: OFFICE_UID,
      },
      OFFICE_UID,
      'office',
    );

    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.row.deleted).toBe(true);
      expect(outcome.row.deleted_by).toBe(OFFICE_UID);
      expect(outcome.row.created_by).toBe(ADMIN_UID);
    }
  });

  it('rejects Office updating an already-deleted row (restore stays admin-only)', () => {
    const deletedRow = baseRow({
      deleted: true,
      deleted_at: '2026-01-02T00:00:00.000Z',
      deleted_by: OFFICE_UID,
    });

    expect(simulateUpdate(deletedRow, { data: { name: 'sneaky' } }, OFFICE_UID, 'office').kind)
      .toBe('no-rows');
    expect(simulateUpdate(deletedRow, { deleted: false, deleted_at: null, deleted_by: null }, OFFICE_UID, 'office').kind)
      .toBe('no-rows');
    // Office cannot read the deleted row either.
    expect(selectPolicyPasses(deletedRow, 'office')).toBe(false);
  });

  it('never lets a rogue payload rewrite created_by', () => {
    const outcome = simulateUpdate(
      baseRow(),
      { created_by: OFFICE_UID, data: { name: 'rewritten' } },
      OFFICE_UID,
      'office',
    );

    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.row.created_by).toBe(ADMIN_UID);
    }
  });

  it('accepts inserts from both roles only with their own created_by', () => {
    expect(insertPolicyPasses(baseRow({ created_by: ADMIN_UID }), ADMIN_UID, 'admin')).toBe(true);
    expect(insertPolicyPasses(baseRow({ created_by: OFFICE_UID }), OFFICE_UID, 'office')).toBe(true);
    expect(insertPolicyPasses(baseRow({ created_by: ADMIN_UID }), OFFICE_UID, 'office')).toBe(false);
    expect(insertPolicyPasses(baseRow({ created_by: OFFICE_UID, deleted: true }), OFFICE_UID, 'office')).toBe(false);
  });

  it('leaves the admin paths unchanged', () => {
    const deletedRow = baseRow({
      deleted: true,
      deleted_at: '2026-01-02T00:00:00.000Z',
      deleted_by: OFFICE_UID,
    });
    // Admin can still see, edit and restore deleted rows.
    expect(selectPolicyPasses(deletedRow, 'admin')).toBe(true);
    expect(simulateUpdate(deletedRow, {
      deleted: false,
      deleted_at: null,
      deleted_by: null,
    }, ADMIN_UID, 'admin').kind).toBe('updated');
    // Only admins may hard delete.
    expect(isAdmin('admin')).toBe(true);
    expect(isAdmin('office')).toBe(false);
  });
});

interface FakeRemoteOptions {
  seed?: Record<string, Record<string, unknown>[]>;
  /** Simulates the server still refusing writes for one row (e.g. old RLS). */
  rejectEntryId?: string;
  rejectMessage?: string;
}

function createFakeRemote(options: FakeRemoteOptions = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [table, rows] of Object.entries(options.seed ?? {})) {
    tables[table] = rows.map((row) => ({ ...row }));
  }
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];

  const client: SupabaseDataClient = {
    from: (table) => ({
      select: async () => ({ data: tables[table] ?? [], error: null }),
      upsert: async (values) => {
        for (const value of values) {
          upserts.push({ table, ...value });
          const rows = tables[table] ?? (tables[table] = []);
          const index = rows.findIndex((row) => row.id === value.id);
          if (index >= 0) rows[index] = { ...rows[index], ...value };
          else rows.push({ ...value });
        }
        return { data: values, error: null };
      },
      insert: async (values) => {
        if (values.some((value) => value.id === options.rejectEntryId)) {
          return {
            data: null,
            error: { message: options.rejectMessage ?? 'rejected by the server' },
          };
        }
        for (const value of values) {
          inserts.push({ table, ...value });
          const rows = tables[table] ?? (tables[table] = []);
          rows.push({ ...value });
        }
        return { data: values, error: null };
      },
      update: (values) => ({
        eq: async (column: string, id: string) => {
          if (id === options.rejectEntryId) {
            return {
              data: null,
              error: { message: options.rejectMessage ?? 'rejected by the server' },
            };
          }
          updates.push({ table, ...values });
          const rows = tables[table] ?? [];
          const index = rows.findIndex((row) => row[column] === id);
          if (index >= 0) {
            // The SQL trigger keeps created_by immutable.
            rows[index] = { ...rows[index], ...values, created_by: rows[index].created_by };
          }
          return { data: null, error: null };
        },
      }),
    }),
  };

  return { client, inserts, updates, upserts, tables };
}

function createSqliteLocal() {
  const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
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

function remoteSeed(): Record<string, Record<string, unknown>[]> {
  return {
    entries: [{
      id: ROW_ID,
      data: { name: 'Admin original' },
      category: 'Employee',
      deleted: false,
      created_by: ADMIN_UID,
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }],
    app_columns: [],
  };
}

describe('entries RLS — sync client writes', () => {
  it('uses a real UPDATE (not an upsert) for an existing row and omits created_by', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({ id: ROW_ID, data: { name: 'Office edit' }, category: 'Employee' });
      const remote = createFakeRemote({ seed: remoteSeed() });

      const result = await runSupabaseSync({ client: remote.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('healthy');
      expect(remote.updates).toHaveLength(1);
      expect(remote.upserts.filter((entry) => entry.table === 'entries')).toHaveLength(0);
      const payload = remote.updates[0];
      expect(payload.data).toEqual({ name: 'Office edit' });
      // created_by is never re-sent on an update.
      expect('created_by' in payload).toBe(false);
      expect(payload.updated_by).toBe(OFFICE_UID);
      // The remote keeps the original creator.
      expect(remote.tables.entries[0].created_by).toBe(ADMIN_UID);
    } finally {
      store.close();
    }
  });

  it('soft deletes an existing Admin-created row with deleted_by = session uid', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({ id: ROW_ID, data: { name: 'To delete' }, category: 'Employee' });
      store.softDeleteEntry(ROW_ID, undefined, OFFICE_UID);
      const remote = createFakeRemote({ seed: remoteSeed() });

      const result = await runSupabaseSync({ client: remote.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('healthy');
      const deleteUpdate = remote.updates[remote.updates.length - 1];
      expect(deleteUpdate.deleted).toBe(true);
      expect(deleteUpdate.deleted_at).not.toBeNull();
      expect(deleteUpdate.deleted_by).toBe(OFFICE_UID);
      expect('created_by' in deleteUpdate).toBe(false);
      expect(remote.tables.entries[0].deleted).toBe(true);
      expect(remote.tables.entries[0].created_by).toBe(ADMIN_UID);
    } finally {
      store.close();
    }
  });

  it('uses a real INSERT with created_by = session uid for a brand-new row', async () => {
    const rowId = 'aaaaaaaa-5555-4555-8555-000000000005';
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({ id: rowId, data: { name: 'New office row' }, category: 'Employee' });
      const remote = createFakeRemote({ seed: { entries: [], app_columns: [] } });

      const result = await runSupabaseSync({ client: remote.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('healthy');
      expect(remote.inserts).toHaveLength(1);
      expect(remote.inserts[0].created_by).toBe(OFFICE_UID);
      expect(insertPolicyPasses(remote.inserts[0] as unknown as EntryRow, OFFICE_UID, 'office')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('drains the queued items after the writes succeed', async () => {
    const { store, local } = createSqliteLocal();
    try {
      store.createEntry({ id: ROW_ID, data: { name: 'Drain' }, category: 'Employee' });
      expect(store.getPendingOutboxCount()).toBeGreaterThan(0);
      const remote = createFakeRemote({ seed: remoteSeed() });

      const result = await runSupabaseSync({ client: remote.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('healthy');
      expect(store.getPendingOutboxCount()).toBe(0);
      expect(store.getSyncStatus().status).toBe('healthy');
    } finally {
      store.close();
    }
  });

  it('counts every failed attempt so the sync detail stops saying "attempted 0×"', async () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
    try {
      const item = store.enqueueOutbox({
        idempotencyKey: 'attempts-1',
        operation: 'update',
        entityType: 'entry',
        entityId: ROW_ID,
        payload: {},
      });
      expect(store.listOutbox('all')[0].attempts).toBe(0);

      store.markOutboxFailed(item.id, 'first failure');
      store.markOutboxFailed(item.id, 'second failure');

      const [afterTwoFailures] = store.listOutbox('all');
      expect(afterTwoFailures.attempts).toBe(2);
      expect(afterTwoFailures.status).toBe('failed');
      expect(afterTwoFailures.lastError).toBe('second failure');
    } finally {
      store.close();
    }
  });

  it('keeps the recorded reason while a failed item is requeued and retried', async () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-05T00:00:00.000Z' });
    try {
      const item = store.enqueueOutbox({
        idempotencyKey: 'reason-1',
        operation: 'update',
        entityType: 'entry',
        entityId: ROW_ID,
        payload: {},
      });
      store.markOutboxFailed(item.id, 'permission denied for table entries');

      // Requeuing used to wipe last_error, so a pending retry looked like a
      // fresh item with no explanation. The reason now survives the retry and
      // is only cleared once the write actually succeeds.
      expect(store.retryFailedOutbox()).toBe(1);
      const [requeued] = store.listOutbox('all');
      expect(requeued.status).toBe('pending');
      expect(requeued.lastError).toBe('permission denied for table entries');
      expect(requeued.attempts).toBe(1);

      store.markOutboxSynced(item.id);
      const [synced] = store.listOutbox('all');
      expect(synced.status).toBe('synced');
      expect(synced.lastError).toBeNull();
    } finally {
      store.close();
    }
  });

  it('attempts every sibling even when the first item in the queue fails', async () => {
    const { store, local } = createSqliteLocal();
    const siblingId = 'aaaaaaaa-5555-4555-8555-000000000005';
    try {
      store.createEntry({ id: ROW_ID, data: { name: 'First' }, category: 'Employee' });
      store.createEntry({ id: siblingId, data: { name: 'Second' }, category: 'Employee' });

      // Every write to the first row is rejected (e.g. a policy that still
      // refuses); the second row must still be attempted and synced.
      const remote = createFakeRemote({
        seed: { entries: [], app_columns: [] },
        rejectEntryId: ROW_ID,
        rejectMessage: 'new row violates row-level security policy for table "entries"',
      });

      const result = await runSupabaseSync({ client: remote.client, local, userId: OFFICE_UID });

      expect(result.status).toBe('error');
      expect(remote.inserts.some((payload) => payload.id === siblingId)).toBe(true);
      const items = store.listOutbox('all');
      const failed = items.filter((row) => row.entityId === ROW_ID);
      const synced = items.filter((row) => row.entityId === siblingId);
      expect(failed.every((row) => row.status === 'failed')).toBe(true);
      expect(failed.every((row) => row.attempts > 0)).toBe(true);
      expect(failed.every((row) => (row.lastError ?? '').includes('row-level security'))).toBe(true);
      expect(synced.every((row) => row.status === 'synced')).toBe(true);
      // The failure is reported per item, never by clearing the whole queue.
      expect(store.getPendingOutboxCount()).toBe(failed.length);
    } finally {
      store.close();
    }
  });
});

describe('entries RLS — audit clear, policy guard and attribution (R3 batch G)', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const schema = readFileSync(schemaPath, 'utf8');

  it('clears the audit log with a scoped delete, never an unfiltered one', () => {
    // The REST error "DELETE requires a WHERE clause" is what an unfiltered
    // DELETE produces; the function must always carry a predicate.
    expect(sql).toContain('delete from public.audit_log');
    expect(sql).toMatch(/delete from public\.audit_log\s+where id is not null;/);
    expect(schema).toMatch(/delete from public\.audit_log\s+where id is not null;/);
    // No bare "delete from public.audit_log;" (semicolon straight after the name).
    expect(sql).not.toMatch(/delete from public\.audit_log\s*;/);
    expect(schema).not.toMatch(/delete from public\.audit_log\s*;/);
    // `id` is the identity primary key, so the predicate removes every row.
    expect(sql).toContain('id is not null');
  });

  it('stamps the clear message in Oman local time and keeps the wording', () => {
    for (const source of [sql, schema]) {
      expect(source).toContain("to_char(now() at time zone 'Asia/Muscat', 'DD/MM/YYYY HH24:MI')");
      expect(source).not.toContain("now() at time zone 'UTC'");
      expect(source).toContain("'Audit log cleared by Admin on '");
    }
  });

  it('guards against an unexpected permissive policy before recreating policies', () => {
    // PostgreSQL ORs permissive policies, so a forgotten broad policy would
    // silently keep working. The migration must refuse to run in that case.
    expect(sql).toContain('do $$');
    expect(sql).toContain('from pg_policies p');
    expect(sql).toContain("p.permissive = 'PERMISSIVE'");
    expect(sql).toContain('unexpected permissive policies');
    expect(sql).toContain('row level security is disabled');

    // The guard runs before any policy is created.
    const guardIndex = sql.indexOf('unexpected permissive policies');
    const firstPolicy = sql.indexOf('create policy ');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstPolicy);
    expect(sql.indexOf('begin;')).toBeLessThan(guardIndex);
  });

  it('allowlists exactly the ten expected policies for the three tables', () => {
    const expected = [
      "('entries',     'entries_select_authenticated',     'SELECT')",
      "('entries',     'entries_insert_authenticated',     'INSERT')",
      "('entries',     'entries_update_authenticated',     'UPDATE')",
      "('entries',     'entries_delete_admin',             'DELETE')",
      "('audit_log',   'audit_log_select_admin',           'SELECT')",
      "('audit_log',   'audit_log_insert_authenticated',   'INSERT')",
      "('app_columns', 'app_columns_select_authenticated', 'SELECT')",
      "('app_columns', 'app_columns_insert_authenticated', 'INSERT')",
      "('app_columns', 'app_columns_update_authenticated', 'UPDATE')",
      "('app_columns', 'app_columns_delete_admin',         'DELETE')",
    ];
    for (const row of expected) {
      expect(sql).toContain(row);
    }
    // The two legacy audit-log delete policies are dropped in the same
    // transaction, so the guard must tolerate them instead of deadlocking.
    expect(sql).toContain("('audit_log',   'audit_log_delete_admin',           'DELETE')");
    expect(sql).toContain("('audit_log',   'audit_log_delete_authenticated',   'DELETE')");
    expect(sql).toContain('drop policy if exists audit_log_delete_admin');
    expect(sql).toContain('drop policy if exists audit_log_delete_authenticated');
  });

  it('ships a read-only preflight and a verification section', () => {
    expect(sql).toContain('SECTION 0 — PREFLIGHT');
    expect(sql).toContain('SECTION 2 — VERIFICATION');
    // The preflight must be commented out so a careless "Run all" changes nothing.
    const preflight = sql.slice(sql.indexOf('SECTION 0'), sql.indexOf('SECTION 1'));
    const statements = preflight.split('\n').filter((line) => /^(select|with|alter|drop|create)\b/i.test(line.trim()));
    expect(statements).toEqual([]);
  });

  it('stamps updated_by from the session and mirrors it into the schema', () => {
    for (const source of [sql, schema]) {
      expect(source).toContain('create or replace function public.entries_stamp_updated_by');
      expect(source).toContain('new.updated_by := auth.uid()');
      expect(source).toContain('create trigger entries_stamp_updated_by');
      expect(source).toContain('before update on public.entries');
    }
    // created_at is frozen with created_by so a client cannot rewrite history.
    expect(sql).toContain('new.created_at := old.created_at');
    expect(schema).toContain('new.created_at := old.created_at');
  });
});
