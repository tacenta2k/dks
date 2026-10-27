// @vitest-environment node
/**
 * Live Visa Sheet Realtime — SQL contract.
 *
 * The publication change is the ONLY server-side change: entries and
 * app_columns are published idempotently, and no policy/grant is touched, so
 * Realtime keeps delivering exactly the rows the existing RLS lets a client
 * SELECT. The migration is executed twice against a real local PostgreSQL
 * (PGlite WASM, no Supabase project) to prove idempotency, and against a
 * deliberately broken install to prove it refuses to publish an unsafe table.
 */
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('supabase/schema.sql', 'utf8');
const migration = readFileSync('ARENA/sql/realtime-live-sheet.sql', 'utf8');
const lower = (sql: string) => sql.toLowerCase();
/** SQL with `--` comments removed, so assertions only judge statements. */
const statementsOnly = (sql: string) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .toLowerCase();

describe('live sheet publication SQL (static contract)', () => {
  it('publishes entries and app_columns idempotently in the fresh-install schema', () => {
    const sql = lower(schema);
    for (const table of ['entries', 'app_columns']) {
      expect(sql).toMatch(
        new RegExp(
          `pg_publication_tables[\\s\\S]*?tablename = '${table}'[\\s\\S]*?alter publication supabase_realtime add table public\\.${table}`,
        ),
      );
    }
  });

  it('keeps the manual migration read-only in preflight and verification', () => {
    const sql = lower(migration);
    expect(sql).toContain('read-only preflight');
    expect(sql).toContain('read-only verification');
    expect(sql).toContain('begin;');
    expect(sql).toContain('commit;');
    expect(sql).toMatch(/foreach v_table in array array\['entries', 'app_columns'\]/);
    expect(sql).toContain(
      "execute format('alter publication supabase_realtime add table public.%i', v_table)",
    );
    expect(sql).toMatch(/pg_publication_tables[\s\S]*?tablename = v_table/);
  });

  it('changes NO policy, grant, trigger or table definition (RLS is untouched)', () => {
    const sql = statementsOnly(migration);
    expect(sql).not.toMatch(/create policy|drop policy|alter policy/);
    expect(sql).not.toMatch(/disable row level security|no force row level security/);
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b/);
    expect(sql).not.toMatch(/create table|alter table|drop table|truncate/);
    expect(sql).not.toMatch(/create trigger|drop trigger/);
    // It refuses instead of installing over a table without RLS.
    expect(sql).toMatch(/rls is not enabled on public\.%[\s\S]*?errcode = '42501'/);
    // An anonymous read policy would leak the sheet through Realtime.
    expect(sql).toContain("roles && array['anon']::name[]");
  });

  it('documents the expected free-tier quota (one connection, one message per change)', () => {
    const sql = lower(migration);
    expect(sql).toContain('expected quota');
    expect(sql).toMatch(/1 realtime connection per signed-in dks client/);
    expect(sql).toMatch(/~1 message per saved change per other connected client/);
    expect(sql).toMatch(/200 concurrent realtime connections/);
  });
});

async function createDatabase(options: { rls: boolean; anonPolicy?: boolean }): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create publication supabase_realtime;
    create table public.entries (id uuid primary key, data jsonb not null default '{}'::jsonb, created_by uuid);
    create table public.app_columns (id uuid primary key, name text not null);
    grant select, insert, update, delete on public.entries, public.app_columns to authenticated;
  `);
  if (options.rls) {
    await db.exec(`
      alter table public.entries enable row level security;
      alter table public.app_columns enable row level security;
      create policy entries_select_authenticated on public.entries
        for select to authenticated using (true);
      create policy app_columns_select_authenticated on public.app_columns
        for select to authenticated using (true);
    `);
  }
  if (options.anonPolicy) {
    await db.exec('grant select on public.entries to anon; create policy entries_anon_read on public.entries for select to anon using (true)');
  }
  return db;
}

async function publishedTables(db: PGlite): Promise<string[]> {
  const result = await db.query<{ tablename: string }>(
    `select tablename from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
      order by tablename`,
  );
  return result.rows.map((row) => row.tablename);
}

async function rlsEnabled(db: PGlite): Promise<Array<{ relname: string; relrowsecurity: boolean }>> {
  const result = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('entries', 'app_columns')
      order by c.relname`,
  );
  return result.rows;
}

describe('live sheet publication migration (real PostgreSQL)', () => {
  it('adds both tables and stays idempotent, leaving RLS and policies untouched', async () => {
    const db = await createDatabase({ rls: true });
    try {
      const policiesBefore = await db.query(
        `select tablename, policyname, cmd, roles::text from pg_policies
          where schemaname = 'public' order by tablename, policyname`,
      );
      expect(await publishedTables(db)).toEqual([]);

      await db.exec(migration);
      expect(await publishedTables(db)).toEqual(['app_columns', 'entries']);

      // Running it again must not duplicate publication entries.
      await db.exec(migration);
      await db.exec(migration);
      expect(await publishedTables(db)).toEqual(['app_columns', 'entries']);

      expect(await rlsEnabled(db)).toEqual([
        { relname: 'app_columns', relrowsecurity: true },
        { relname: 'entries', relrowsecurity: true },
      ]);
      const policiesAfter = await db.query(
        `select tablename, policyname, cmd, roles::text from pg_policies
          where schemaname = 'public' order by tablename, policyname`,
      );
      expect(policiesAfter.rows).toEqual(policiesBefore.rows);
    } finally {
      await db.close();
    }
  });

  it('refuses to publish a table without row level security', async () => {
    const db = await createDatabase({ rls: false });
    try {
      await expect(db.exec(migration)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback');
      expect(await publishedTables(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('refuses to publish a table that anonymous users can read', async () => {
    const db = await createDatabase({ rls: true, anonPolicy: true });
    try {
      await expect(db.exec(migration)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback');
      expect(await publishedTables(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
