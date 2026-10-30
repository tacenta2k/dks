// @vitest-environment node
/**
 * Real PostgreSQL verification (PGlite WASM) for `ARENA/sql/error-reporting.sql`
 * and its parity with `supabase/schema.sql`.
 */
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationSql = readFileSync('ARENA/sql/error-reporting.sql', 'utf8').replace(/\r\n/g, '\n');
const freshSchemaSql = readFileSync('supabase/schema.sql', 'utf8').replace(/\r\n/g, '\n');

const ADMIN_ID = '846536af-f3c6-47c1-8559-d13442c1490a';
const OFFICE_ID = '2a959122-d789-4f2e-8fdf-958260c2e3f9';
const SESSION_APPROVED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_UNAPPROVED = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const BOOTSTRAP_SQL = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;

  create table auth.users (
    id uuid primary key,
    email text not null
  );

  insert into auth.users (id, email) values
    ('${ADMIN_ID}', 'shahabasnavas123@gmail.com'),
    ('${OFFICE_ID}', 'amervisamedical1dks@gmail.com');

  create or replace function auth.jwt()
  returns jsonb
  language sql
  stable
  as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  $$;

  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid;
  $$;

  create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    role text not null check (role in ('admin', 'office'))
  );
  alter table public.profiles enable row level security;

  insert into public.profiles (id, email, role) values
    ('${ADMIN_ID}', 'shahabasnavas123@gmail.com', 'admin'),
    ('${OFFICE_ID}', 'amervisamedical1dks@gmail.com', 'office');

  create table public.settings (
    key text primary key,
    value jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  );
  alter table public.settings enable row level security;

  create table public.office_signin_requests (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references auth.users(id) on delete cascade,
    auth_session_id text not null,
    status text not null check (status in ('pending', 'approved', 'denied', 'revoked'))
  );
  alter table public.office_signin_requests enable row level security;

  insert into public.office_signin_requests (office_id, auth_session_id, status) values
    ('${OFFICE_ID}', '${SESSION_APPROVED}', 'approved'),
    ('${OFFICE_ID}', '${SESSION_UNAPPROVED}', 'pending');

  create or replace function public.is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    );
  $$;

  create or replace function public.is_office()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'office'
    );
  $$;

  create or replace function public.office_session_is_approved()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
  as $$
    select exists (
      select 1
        from public.office_signin_requests r
       where r.office_id = auth.uid()
         and r.auth_session_id = coalesce(auth.jwt() ->> 'session_id', '')
         and r.status = 'approved'
    );
  $$;

  grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
  grant execute on function public.is_admin(), public.is_office(), public.office_session_is_approved()
    to authenticated, service_role;
`;

async function createDatabase(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(BOOTSTRAP_SQL);
  await db.exec(migrationSql);
  // Run a second time to prove full idempotency (including preflight + policy guard + verification).
  await db.exec(migrationSql);
  return db;
}

describe('ARENA/sql/error-reporting.sql on real PostgreSQL (PGlite)', () => {
  let db!: PGlite;

  beforeAll(async () => {
    db = await createDatabase();
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it('keeps verify_error_report_caller, ingest_error_report, and complete_error_report_delivery aligned between schema.sql and migration', () => {
    for (const fnName of [
      'verify_error_report_caller',
      'ingest_error_report',
      'complete_error_report_delivery',
    ]) {
      const pattern = new RegExp(
        `create or replace function public\\.${fnName}\\b[\\s\\S]*?\\$\\$;`,
        'i',
      );
      const fromMigration = migrationSql.match(pattern)?.[0]?.replace(/--[^\n]*\n/g, '').replace(/\s+/g, ' ').trim();
      const fromSchema = freshSchemaSql.match(pattern)?.[0]?.replace(/--[^\n]*\n/g, '').replace(/\s+/g, ' ').trim();
      expect(fromMigration, `Missing ${fnName} in migration`).toBeTruthy();
      expect(fromSchema, `Missing ${fnName} in schema.sql`).toBe(fromMigration);
    }
  });

  it('enforces RLS, revokes anon & client writes, and gates verify_error_report_caller by role + Office session approval', async () => {
    const privs = await db.query<{
      anon_can_read_fp: boolean;
      auth_can_insert_fp: boolean;
      auth_can_insert_ev: boolean;
      auth_can_verify: boolean;
      auth_can_ingest: boolean;
      service_can_ingest: boolean;
      service_can_complete: boolean;
    }>(`
      select has_table_privilege('anon', 'public.error_report_fingerprints', 'select') as anon_can_read_fp,
             has_table_privilege('authenticated', 'public.error_report_fingerprints', 'insert') as auth_can_insert_fp,
             has_table_privilege('authenticated', 'public.error_report_events', 'insert') as auth_can_insert_ev,
             has_function_privilege('authenticated', 'public.verify_error_report_caller()', 'execute') as auth_can_verify,
             has_function_privilege('authenticated', 'public.ingest_error_report(uuid, text, jsonb)', 'execute') as auth_can_ingest,
             has_function_privilege('service_role', 'public.ingest_error_report(uuid, text, jsonb)', 'execute') as service_can_ingest,
             has_function_privilege('service_role', 'public.complete_error_report_delivery(uuid, text, text, integer, text, text)', 'execute') as service_can_complete;
    `);

    expect(privs.rows[0]).toEqual({
      anon_can_read_fp: false,
      auth_can_insert_fp: false,
      auth_can_insert_ev: false,
      auth_can_verify: true,
      auth_can_ingest: false,
      service_can_ingest: true,
      service_can_complete: true,
    });

    const verifyAs = async (claims: Record<string, string>) => {
      await db.exec('begin;');
      try {
        await db.exec('set local role authenticated;');
        await db.query('select set_config($1, $2, true)', [
          'request.jwt.claims',
          JSON.stringify(claims),
        ]);
        const out = await db.query<{ res: Record<string, unknown> }>(
          'select public.verify_error_report_caller() as res',
        );
        await db.exec('commit;');
        return out.rows[0].res;
      } catch (err) {
        await db.exec('rollback;');
        throw err;
      }
    };

    expect(await verifyAs({ role: 'authenticated', sub: ADMIN_ID })).toEqual({
      authorized: true,
      user_id: ADMIN_ID,
      role: 'admin',
      reporting_enabled: true,
    });

    expect(
      await verifyAs({
        role: 'authenticated',
        sub: OFFICE_ID,
        session_id: SESSION_APPROVED,
      }),
    ).toEqual({
      authorized: true,
      user_id: OFFICE_ID,
      role: 'office',
      reporting_enabled: true,
    });

    // Pending/unapproved Office session MUST fail with 42501!
    await expect(
      verifyAs({
        role: 'authenticated',
        sub: OFFICE_ID,
        session_id: SESSION_UNAPPROVED,
      }),
    ).rejects.toThrow(/approved DKS session is required/i);
  });

  it('deduplicates 24h fingerprints, enforces 10/10m per-user rate limits, prunes >30d events, and honors error_reporting_enabled=false', async () => {
    const ingestAsServiceRole = async (
        userId: string,
        role: 'admin' | 'office',
        payload: Record<string, unknown>,
      ) => {
        await db.exec('begin;');
        try {
          await db.exec('set local role service_role;');
          await db.query('select set_config($1, $2, true)', [
            'request.jwt.claims',
            JSON.stringify({ role: 'service_role' }),
          ]);
          const res = await db.query<{ res: Record<string, unknown> }>(
            'select public.ingest_error_report($1::uuid, $2, $3::jsonb) as res',
            [userId, role, JSON.stringify(payload)],
          );
          await db.exec('commit;');
          return res.rows[0].res;
        } catch (err) {
          await db.exec('rollback;');
          throw err;
        }
      };

      const completeAsServiceRole = async (
        eventId: string,
        fingerprint: string,
        status: string,
        issueNumber: number | null,
      ) => {
        await db.exec('begin;');
        try {
          await db.exec('set local role service_role;');
          await db.query('select set_config($1, $2, true)', [
            'request.jwt.claims',
            JSON.stringify({ role: 'service_role' }),
          ]);
          await db.query(
            'select public.complete_error_report_delivery($1::uuid, $2, $3, $4, $5, $6)',
            [
              eventId,
              fingerprint,
              status,
              issueNumber,
              issueNumber ? `https://github.com/tacenta2k/dks/issues/${issueNumber}` : null,
              null,
            ],
          );
          await db.exec('commit;');
        } catch (err) {
          await db.exec('rollback;');
          throw err;
        }
      };

      const fp1 = '1'.repeat(32);
      const basePayload = {
        fingerprint: fp1,
        category: 'sync',
        severity: 'error',
        code: 'SYNC_OUTBOX_TERMINAL',
        component: 'renderer/supabase-sync',
        process: 'renderer',
        appVersion: '1.1.3',
        platform: 'win32',
        arch: 'x64',
        osRelease: '10.0.22631',
        occurrences: 1,
      };

      // 1. Seed a stale 35-day-old event to prove 30-day retention pruning works:
      await db.query(
        `insert into public.error_report_fingerprints (fingerprint, category, severity, code, component, process, first_app_version, latest_app_version)
         values ($1, 'main', 'error', 'OLD_CODE', 'main/process', 'main', '1.0.0', '1.0.0')`,
        ['9'.repeat(32)],
      );
      await db.query(
        `insert into public.error_report_events (fingerprint, reporter_id, reporter_role, app_version, platform, arch, os_release, delivery_status, created_at)
         values ($1, $2::uuid, 'admin', '1.0.0', 'win32', 'x64', '10.0.19045', 'deduped', now() - interval '35 days')`,
        ['9'.repeat(32), ADMIN_ID],
      );

      // 2. First report creates issue:
      const first = await ingestAsServiceRole(ADMIN_ID, 'admin', basePayload);
      expect(first).toMatchObject({
        ok: true,
        action: 'create_issue',
        total_occurrences: 1,
      });
      await completeAsServiceRole(String(first.event_id), fp1, 'issue_created', 101);

      // Stale 35-day event was pruned!
      const staleCount = await db.query<{ count: number }>(
        `select count(*)::int as count from public.error_report_events where fingerprint = $1`,
        ['9'.repeat(32)],
      );
      expect(staleCount.rows[0].count).toBe(0);

      // 3. Repeat within 24h is deduplicated (increments occurrences, no GitHub spam):
      const second = await ingestAsServiceRole(OFFICE_ID, 'office', {
        ...basePayload,
        occurrences: 3,
      });
      expect(second).toMatchObject({
        ok: true,
        action: 'deduped',
        issue_number: 101,
        total_occurrences: 4,
      });

      // 4. After >24h since last_github_sync_at, posts one rollup comment:
      await db.query(
        `update public.error_report_fingerprints
            set last_github_sync_at = now() - interval '25 hours'
          where fingerprint = $1`,
        [fp1],
      );
      const after24h = await ingestAsServiceRole(ADMIN_ID, 'admin', basePayload);
      expect(after24h).toMatchObject({
        ok: true,
        action: 'comment_issue',
        issue_number: 101,
        total_occurrences: 5,
      });

      // 5. Per-user rate limit: 10 events in 10 minutes for ADMIN_ID -> 11th returns rate_limited_user:
      for (let i = 0; i < 8; i += 1) {
        const res = await ingestAsServiceRole(ADMIN_ID, 'admin', {
          ...basePayload,
          fingerprint: (i + 2).toString(16).padStart(32, 'c'),
          code: `RATE_TEST_${i}`,
        });
        expect(res.ok).toBe(true);
      }
      const eleventh = await ingestAsServiceRole(ADMIN_ID, 'admin', {
        ...basePayload,
        fingerprint: 'd'.repeat(32),
        code: 'RATE_TEST_OVERFLOW',
      });
      expect(eleventh).toEqual({
        ok: false,
        action: 'rate_limited_user',
        retry_after_seconds: 600,
      });

      // 6. Disabling workspace setting returns action='disabled':
      await db.exec(`update public.settings set value = 'false'::jsonb where key = 'error_reporting_enabled';`);
      const whenDisabled = await ingestAsServiceRole(OFFICE_ID, 'office', basePayload);
      expect(whenDisabled).toEqual({
        ok: true,
        action: 'disabled',
      });
  });
});
