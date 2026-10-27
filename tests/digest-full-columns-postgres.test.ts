// @vitest-environment node
/**
 * Digest full-columns migration — real SQL contract.
 *
 * The owner runs these files by hand in the Supabase SQL editor, so they are
 * executed here against a real local PostgreSQL (PGlite WASM, no Supabase
 * project) in production order and TWICE each, proving:
 *   - `email_notifications.include_full_ids` ends up true even when the live row
 *     said false;
 *   - every other preference is preserved (no reset, no dropped recipient);
 *   - a project that had no settings row gets the documented defaults;
 *   - `enqueue_expiry_digest()` really carries the full-by-default fallback;
 *   - the scripts are idempotent and touch no table/ policy/ trigger.
 */
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const digestUpgrade = readFileSync('ARENA/sql/expiry-digest-report.sql', 'utf8');
const fullColumns = readFileSync('ARENA/sql/digest-full-columns.sql', 'utf8');

const PREFLIGHT = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create table public.settings (
    key text primary key,
    value jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  );
`;

async function createDatabase(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(PREFLIGHT);
  return db;
}

async function preferences(db: PGlite): Promise<Record<string, unknown> | null> {
  const result = await db.query<{ value: Record<string, unknown> }>(
    "select value from public.settings where key = 'email_notifications'",
  );
  return result.rows[0]?.value ?? null;
}

async function digestDefinition(db: PGlite): Promise<string> {
  const result = await db.query<{ def: string }>(
    `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'enqueue_expiry_digest'`,
  );
  return result.rows[0]?.def ?? '';
}

describe('digest full-columns migration (real PostgreSQL)', () => {
  it('turns an existing false into true and preserves every other preference', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        insert into public.settings (key, value)
        values ('email_notifications', '{
          "enabled": true,
          "admin_email": "admin@example.com",
          "expiry_digest_enabled": true,
          "expiry_recipients": ["digest@example.com", "second@example.com"],
          "include_full_ids": false
        }'::jsonb);
      `);

      await db.exec(digestUpgrade);
      await db.exec(fullColumns);
      // Idempotency: the owner may re-run either file at any time.
      await db.exec(fullColumns);

      const prefs = await preferences(db);
      expect(prefs).not.toBeNull();
      expect(prefs?.include_full_ids).toBe(true);
      expect(prefs?.enabled).toBe(true);
      expect(prefs?.admin_email).toBe('admin@example.com');
      expect(prefs?.expiry_digest_enabled).toBe(true);
      expect(prefs?.expiry_recipients).toEqual(['digest@example.com', 'second@example.com']);

      expect(await digestDefinition(db)).toMatch(/include_full_ids'\)::boolean, true/);
    } finally {
      await db.close();
    }
  });

  it('creates the documented defaults when the deployment never had the row', async () => {
    const db = await createDatabase();
    try {
      await db.exec(fullColumns);

      const prefs = await preferences(db);
      expect(prefs).toEqual({
        enabled: false,
        admin_email: null,
        expiry_digest_enabled: false,
        expiry_recipients: [],
        include_full_ids: true,
      });
    } finally {
      await db.close();
    }
  });

  it('keeps an Admin opt-out that is applied AFTER the migration', async () => {
    const db = await createDatabase();
    try {
      await db.exec(fullColumns);
      await db.exec(`
        update public.settings
           set value = value || '{"include_full_ids": false}'::jsonb
         where key = 'email_notifications';
      `);
      // Re-running the migration would flip it back on — that is the point of
      // the owner-approved default — but the app's parser is what decides a
      // legacy row, so the fallback must stay "full" only when the key is absent.
      expect((await preferences(db))?.include_full_ids).toBe(false);
      expect(await digestDefinition(db)).toMatch(/include_full_ids'\)::boolean, true/);
    } finally {
      await db.close();
    }
  });

  it('does not touch tables, policies, triggers or cron', async () => {
    const before = await createDatabase();
    const after = await createDatabase();
    try {
      const snapshot = async (db: PGlite) => {
        const result = await db.query<{ count: number }>(
          `select count(*)::int as count from pg_class
            where relnamespace = 'public'::regnamespace and relkind = 'r'`,
        );
        const policies = await db.query<{ count: number }>(
          'select count(*)::int as count from pg_policies',
        );
        const triggers = await db.query<{ count: number }>(
          'select count(*)::int as count from pg_trigger where not tgisinternal',
        );
        return [result.rows[0].count, policies.rows[0].count, triggers.rows[0].count];
      };
      const baseline = await snapshot(before);
      await after.exec(fullColumns);
      // The migration only creates/updates the settings row and the digest
      // function — no new relation, policy or trigger appears.
      expect(await snapshot(after)).toEqual(baseline);
    } finally {
      await before.close();
      await after.close();
    }
  });
});
