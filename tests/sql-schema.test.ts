import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaPath = resolve(process.cwd(), 'supabase/schema.sql');
const arenaSql = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'ARENA/sql', name), 'utf8').toLowerCase();
const edgeFunctionPath = resolve(process.cwd(), 'supabase/edge-functions/expiry-digest/index.ts');

function schemaSource(): string {
  return readFileSync(schemaPath, 'utf8').toLowerCase();
}

function tableDefinition(sql: string, table: string): string {
  const start = sql.indexOf(`create table if not exists public.${table}`);
  const end = sql.indexOf('\n);', start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing table definition for ${table}`);
  }
  return sql.slice(start, end);
}

describe('Supabase STEP 3 schema', () => {
  it('defines every required public table', () => {
    const sql = schemaSource();

    for (const table of [
      'profiles',
      'app_columns',
      'entries',
      'renewals',
      'audit_log',
      'admin_notifications',
      'settings',
      'alert_snoozes',
      'sync_sessions',
    ]) {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${table}\\b`));
    }
  });

  it('contains the required RPCs and trigger safeguards', () => {
    const sql = schemaSource();

    for (const functionName of [
      'is_admin',
      'is_office',
      'column_is_empty',
      'office_delete_empty_column',
      'restore_entry',
      'permanently_delete_entry',
      'renew_entry',
      'set_updated_at',
      'write_audit_log',
      'guard_primary_expiry_column',
      'guard_primary_expiry_value',
    ]) {
      expect(sql).toContain(`function public.${functionName}`);
    }

    expect(sql).toContain('create trigger app_columns_primary_expiry_guard');
    expect(sql).toContain('create trigger entries_primary_expiry_guard');
    expect(sql).toContain('create unique index if not exists one_primary_expiry_column');
    expect(sql).toContain('create trigger entries_audit');
    expect(sql).toContain('create trigger app_columns_audit');

    const renewStart = sql.indexOf('function public.renew_entry');
    const renewBody = sql.slice(renewStart, sql.indexOf('$$;', renewStart) + 3);
    expect(renewBody).toContain('snapshot');
    expect(renewBody).toContain('jsonb_set');
    expect(renewBody).toContain('auth.uid()');
  });

  it('seeds the exact profile identities and rejects placeholder identities', () => {
    const sql = schemaSource();

    expect(sql).toContain('846536af-f3c6-47c1-8559-d13442c1490a');
    expect(sql).toContain('shahabasnavas123@gmail.com');
    expect(sql).toContain("'admin'");
    expect(sql).toMatch(
      /'846536af-f3c6-47c1-8559-d13442c1490a'\s*,\s*'shahabasnavas123@gmail\.com'\s*,\s*'admin'/,
    );
    expect(sql).toContain('2a959122-d789-4f2e-8fdf-958260c2e3f9');
    expect(sql).toContain('amervisamedical1dks@gmail.com');
    expect(sql).toContain("'office'");
    expect(sql).toMatch(
      /'2a959122-d789-4f2e-8fdf-958260c2e3f9'\s*,\s*'amervisamedical1dks@gmail\.com'\s*,\s*'office'/,
    );

    expect(sql).not.toContain('00000000-0000-0000-0000-000000000001');
    expect(sql).not.toContain('admin@dks.local');
    expect(sql).not.toContain('00000000-0000-0000-0000-000000000002');
    expect(sql).not.toContain('office@dks.local');
  });

  it('declares the exact application data contracts', () => {
    const sql = schemaSource();
    const appColumns = tableDefinition(sql, 'app_columns').replace(/\s+/g, ' ');
    const entries = tableDefinition(sql, 'entries');
    const renewals = tableDefinition(sql, 'renewals');
    const auditLog = tableDefinition(sql, 'audit_log');
    const notifications = tableDefinition(sql, 'admin_notifications');
    const settings = tableDefinition(sql, 'settings');
    const alertSnoozes = tableDefinition(sql, 'alert_snoozes');
    const syncSessions = tableDefinition(sql, 'sync_sessions');

    expect(sql).toMatch(
      /id\s+uuid\s+primary key\s+references auth\.users\s*\(id\)\s+on delete cascade/,
    );
    expect(appColumns).toMatch(
      /check \(type in \(\s*'text', 'number', 'phone', 'email', 'price', 'date_start', 'date_expiry', 'dropdown', 'checkbox', 'notes',\s*'civil_id'\s*\)\)/,
    );
    for (const column of [
      'name text not null',
      'type text not null',
      "options jsonb not null default '{}'::jsonb",
      'position integer not null',
      'visible boolean not null',
      'is_primary_expiry boolean not null',
      'is_passport boolean not null',
      'created_by uuid',
      'created_at timestamptz',
      'updated_at timestamptz',
    ]) {
      expect(appColumns).toContain(column);
    }
    expect(appColumns).toContain('visible boolean not null default true');
    expect(appColumns).toContain('is_primary_expiry boolean not null default false');
    expect(appColumns).toContain('is_passport boolean not null default false');
    expect(entries).toMatch(
      /\bdata\s+jsonb\s+not null\s+default\s+'\{\}'::jsonb[\s\S]*?\bcategory\s+text\s+not null\s+default\s+'employee'[\s\S]*?check\s*\(category\s+in\s*\('employee',\s*'family',\s*'client'\)\)/,
    );
    expect(entries).toContain('last_renewed_at timestamptz');
    expect(renewals).toMatch(/\bsnapshot\s+jsonb/);
    expect(auditLog).toMatch(
      /\bactor\s+uuid[\s\S]*?\bentry_id\s+uuid[\s\S]*?\bsnapshot\s+jsonb[\s\S]*?\bdetails\s+jsonb/,
    );
    expect(notifications).toMatch(
      /\bid\s+bigint\s+generated always as identity[\s\S]*?\btype\s+text[\s\S]*?\bmessage\s+text[\s\S]*?\bpayload\s+jsonb[\s\S]*?\bread\s+boolean/,
    );
    expect(settings).toMatch(
      /\bkey\s+text\s+primary key[\s\S]*?\bvalue\s+jsonb[\s\S]*?\bupdated_at\s+timestamptz/,
    );
    expect(alertSnoozes).toMatch(
      /\buser_id\s+uuid[\s\S]*?\bsnoozed_until\s+timestamptz[\s\S]*?\bdismissed_until_expiry_change\s+boolean[\s\S]*?\bexpiry_value\s+text/,
    );
    expect(syncSessions).toMatch(
      /\buser_id\s+uuid[\s\S]*?\bopened_at\s+timestamptz[\s\S]*?\bclosed_at\s+timestamptz/,
    );
    expect(settings).not.toMatch(/description|updated_by|created_at/);
    expect(notifications).not.toContain('is_read');
    expect(alertSnoozes).not.toContain('dismissed_expiry');
    expect(syncSessions).not.toContain('device_id');
    expect(sql).toContain('"symbol": "ر.ع."');
    expect(sql).toContain('"decimals": 3');
    expect(sql).toContain("('theme', '\"light\"'::jsonb)");
  });

  it('marks the schema as authenticated-only and protects definer RPCs', () => {
    const sql = schemaSource();

    expect(sql).toContain('enable row level security');
    expect(sql).toMatch(/grant usage on schema public to authenticated/);
    expect(sql).toMatch(/grant .* to authenticated/);
    expect(sql).toMatch(/revoke all on all tables in schema public from anon/);
    expect(sql).toMatch(/revoke all on all sequences in schema public from anon/);
    expect(sql).toMatch(/revoke all on all functions in schema public from public/);
    expect(sql).toContain('to authenticated');
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public');
    expect(sql).not.toMatch(/service[_-]?role|postgres:\/\//);

    for (const functionName of [
      'is_admin',
      'is_office',
      'column_is_empty',
      'office_delete_empty_column',
      'restore_entry',
      'permanently_delete_entry',
      'renew_entry',
    ]) {
      const functionStart = sql.indexOf(`function public.${functionName}`);
      expect(functionStart).toBeGreaterThanOrEqual(0);
      const functionBody = sql.slice(functionStart, sql.indexOf('$$;', functionStart) + 3);
      expect(functionBody).toContain('security definer');
      expect(functionBody).toContain('set search_path = public');
    }
  });

  it('declares role-specific RLS policies for every data surface', () => {
    const sql = schemaSource();

    for (const policy of [
      'profiles_select_authenticated',
      'profiles_admin_update',
      'app_columns_select_authenticated',
      'app_columns_insert_authenticated',
      'app_columns_delete_admin',
      'entries_select_authenticated',
      'entries_insert_authenticated',
      'entries_update_authenticated',
      'entries_delete_admin',
      'renewals_select_authenticated',
      'audit_log_select_admin',
      'admin_notifications_select_admin',
      'settings_select_authenticated',
      'settings_update_admin',
      'settings_delete_admin',
      'alert_snoozes_select_authenticated',
      'sync_sessions_select_authenticated',
    ]) {
      expect(sql).toContain(`create policy ${policy}`);
    }
  });

  it('declares indexes and updated_at wiring without storage backups', () => {
    const sql = schemaSource();

    expect(sql).toContain('create index if not exists entries_updated_at_idx');
    expect(sql).toContain('create index if not exists audit_log_created_at_idx');
    expect(sql).toContain('create trigger profiles_set_updated_at');
    expect(sql).toContain('create trigger settings_set_updated_at');
    expect(sql).toContain('create trigger sync_sessions_set_updated_at');
    expect(sql).not.toContain('dks-backups');
    expect(sql).not.toContain('storage.buckets');
    expect(sql).not.toContain('storage.objects');
  });

  it('keeps expiry values editable for office entries while primary selection stays guarded', () => {
    const sql = schemaSource();
    const columnGuardStart = sql.indexOf('function public.guard_primary_expiry_column');
    const columnGuardBody = sql.slice(columnGuardStart, sql.indexOf('$$;', columnGuardStart) + 3);
    const entriesUpdateStart = sql.indexOf('create policy entries_update_authenticated');
    const entriesUpdateBody = sql.slice(entriesUpdateStart, sql.indexOf('\n\n', entriesUpdateStart));

    expect(columnGuardBody).toContain('office users cannot change the primary expiry setting');
    expect(columnGuardBody).toContain('new.is_primary_expiry is distinct from old.is_primary_expiry');
    expect(columnGuardBody).toContain('not new.is_primary_expiry and not public.is_admin()');
    expect(entriesUpdateBody).toContain('public.is_office()');
    // R2-01: Office may only update live rows; the created_by test is gone.
    expect(entriesUpdateBody).toContain('deleted is false');
    expect(entriesUpdateBody).toContain('deleted_at is null');
    expect(entriesUpdateBody).toContain('deleted_by is null');
    expect(entriesUpdateBody).toContain('deleted is true');
    expect(entriesUpdateBody).not.toContain('created_by');
    expect(sql).toContain('create trigger entries_primary_expiry_guard');
    // created_by is immutable and Office cannot restore a deleted row.
    expect(sql).toContain('create trigger entries_keep_created_by');
    expect(sql).toContain('create trigger entries_guard_office_restore');
  });

  it('keeps the expiry digest secret-free and quiet when Resend is not configured', () => {
    const source = readFileSync(edgeFunctionPath, 'utf8');

    expect(source).toContain("Deno.env.get('RESEND_API_KEY')");
    expect(source).toContain('status: 204');
    expect(source).toContain('api.resend.com/emails');
    expect(source).not.toMatch(/Bearer\s+re_[a-z0-9_]+/i);
    expect(source).not.toMatch(/RESEND_API_KEY\s*=\s*['"][^'"]+['"]/);
  });
});

// ---------------------------------------------------------------------------
// Office sign-in approval — schema mirror + migration safety (R5 session gate)
// ---------------------------------------------------------------------------

describe('Office sign-in approval — schema mirror', () => {
  it('mirrors the approval table with the session binding and unique constraint', () => {
    const sql = schemaSource();

    const table = tableDefinition(sql, 'office_signin_requests').replace(/\s+/g, ' ');
    expect(table).toMatch(/user_id uuid not null\s+references public\.profiles\(id\) on delete cascade/);
    expect(table).toContain('auth_session_id uuid not null');
    expect(table).toMatch(/status text not null default 'pending'\s+check \(status in \('pending', 'approved', 'denied', 'revoked'\)\)/);
    expect(table).toContain('unique (user_id, auth_session_id)');

    for (const fn of [
      'office_session_is_approved',
      'request_office_signin',
      'my_office_signin',
      'decide_office_signin',
      'revoke_office_signin',
      'sign_out_all_office_sessions',
      'office_signin_request_notify_admin',
    ]) {
      expect(sql).toContain(`function public.${fn}`);
    }

    expect(sql).toContain('create trigger office_signin_requests_notify_admin');
    expect(sql).toContain('after insert on public.office_signin_requests');
    expect(sql).toContain('create policy office_signin_requests_select_own_or_admin');
    expect(sql).toContain('revoke insert, update, delete on public.office_signin_requests from authenticated');
    expect(sql).toContain('grant execute on function public.decide_office_signin(uuid, text) to authenticated');
  });

  it('bulk Office sign-out is admin-guarded, Office-only, audited, and grant-safe', () => {
    const sources: Array<[string, string]> = [
      ['schema.sql', schemaSource()],
      ['sign-out-all-office-sessions.sql', arenaSql('sign-out-all-office-sessions.sql')],
    ];

    for (const [, sql] of sources) {
      const start = sql.indexOf('function public.sign_out_all_office_sessions');
      expect(start).toBeGreaterThanOrEqual(0);
      const body = sql.slice(start, sql.indexOf('$$;', start) + 3);

      // Backend authorization is the real boundary: SECURITY DEFINER plus an
      // in-function administrator check that raises 42501 for anyone else.
      expect(body).toContain('security definer');
      expect(body).toContain('set search_path = public, auth');
      expect(body).toMatch(/v_actor is null or not public\.is_admin\(\)/);
      expect(body).toContain("using errcode = '42501'");

      // Only Office profiles are touched: live approvals revoked, then their
      // refresh tokens and Auth sessions deleted. The acting admin (role
      // 'admin') is never in scope, and business tables are never deleted.
      expect(body).toMatch(/r\.status in \('pending', 'approved'\)/);
      expect(body).toMatch(/set status = 'revoked'/);
      expect(body).toContain('delete from auth.refresh_tokens');
      expect(body).toContain('delete from auth.sessions');
      expect(body).toMatch(/p\.role = 'office'/);
      expect(body).not.toContain('delete from public.entries');
      expect(body).not.toContain('delete from public.profiles');
      expect(body).not.toContain('delete from public.app_columns');

      // One audit event records the action and its counts.
      expect(body).toContain('insert into public.audit_log');
      expect(body).toContain("'office_sessions_signed_out'");
      expect(body).toContain("'auth_sessions_deleted'");
      expect(body).toContain("'requests_revoked'");

      expect(sql).toContain(
        'grant execute on function public.sign_out_all_office_sessions() to authenticated',
      );
    }

    // The existing-deployment migration additionally strips PUBLIC/anon.
    const migration = arenaSql('sign-out-all-office-sessions.sql');
    expect(migration).toContain(
      'revoke all on function public.sign_out_all_office_sessions() from public',
    );
    expect(migration).toContain(
      'revoke all on function public.sign_out_all_office_sessions() from anon',
    );
  });

  it('gates every Office RLS clause and office-callable RPC on the approved session', () => {
    const sql = schemaSource();

    // Every office clause in the rewritten policies goes through the gate.
    const gatedOccurrences = sql.match(/is_office\(\) and public\.office_session_is_approved\(\)/g) ?? [];
    expect(gatedOccurrences.length).toBeGreaterThanOrEqual(9);

    // The policies that were rewritten must not keep a bare office escape.
    for (const policyStart of [
      'create policy app_columns_select_authenticated',
      'create policy app_columns_insert_authenticated',
      'create policy app_columns_update_authenticated',
      'create policy entries_select_authenticated',
      'create policy entries_insert_authenticated',
      'create policy entries_update_authenticated',
      'create policy renewals_select_authenticated',
      'create policy audit_log_insert_authenticated',
      'create policy settings_select_authenticated',
      'create policy alert_snoozes_select_authenticated',
      'create policy alert_snoozes_insert_authenticated',
      'create policy alert_snoozes_update_authenticated',
      'create policy alert_snoozes_delete_authenticated',
      'create policy sync_sessions_select_authenticated',
      'create policy sync_sessions_insert_authenticated',
      'create policy sync_sessions_update_authenticated',
      'create policy sync_sessions_delete_authenticated',
    ]) {
      const body = sql.slice(sql.indexOf(policyStart), sql.indexOf(';', sql.indexOf(policyStart)));
      if (body.includes('is_office()')) {
        expect(body).toContain('office_session_is_approved()');
      }
    }
  });
});

// The exact plpgsql failure behind "Cannot verify sign-in approval —
// record "old" has no field "deleted"": the shared audit trigger dereferenced
// OLD.deleted in the SAME expression as its scalar table guard, on tables
// that have no "deleted" column. These assertions pin the repaired shape.
describe('shared audit trigger — no record-field dereference behind scalar guards', () => {
  const files: Array<[string, string]> = [
    ['schema.sql', schemaSource()],
    ['office-approval.sql', arenaSql('office-approval.sql')],
    ['office-approval-fix.sql', arenaSql('office-approval-fix.sql')],
  ];
  // Comments document the bug itself; only executable SQL counts here.
  const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
  const auditBody = (sql: string): string => {
    const plain = stripComments(sql);
    const start = plain.indexOf('function public.write_audit_log');
    expect(start).toBeGreaterThanOrEqual(0);
    return plain.slice(start, plain.indexOf('$$;', start) + 3);
  };

  it.each(files.map(([name]) => name))('never combines tg guards with old.deleted in one expression (%s)', (name) => {
    const body = auditBody(files.find(([file]) => file === name)?.[1] ?? '');

    // The buggy pattern: tg_op = 'UPDATE' IMMEDIATELY followed by
    // "and old.deleted" inside the same condition (whitespace/newlines between).
    expect(body).not.toMatch(/tg_op\s*=\s*'update'\s+and\s+old\.deleted/i);
  });

  it.each(files.map(([name]) => name))('write_audit_log nests the entries notify branch behind a scalar-only guard (%s)', (name) => {
    const body = auditBody(files.find(([file]) => file === name)?.[1] ?? '');

    expect(body).toMatch(/tg_table_name\s*=\s*'entries'\s+and\s+tg_op\s*=\s*'update'\s+then/);
    expect(body).toMatch(/old\.deleted is false and new\.deleted is true and public\.is_office\(\)/);
  });
});

describe('office_signin_requests trigger whitelist', () => {
  it('only the whitelisted NEW-only notification triggers bind to the table', () => {
    const sources: Array<[string, string]> = [
      ['schema.sql', schemaSource()],
      ['office-approval.sql', arenaSql('office-approval.sql')],
      ['email-notifications.sql', arenaSql('email-notifications.sql')],
    ];
    const allowedTriggers = new Set([
      'office_signin_requests_notify_admin',
      'office_signin_requests_email_enqueue',
    ]);
    const allowedFunctions = new Set([
      'office_signin_request_notify_admin',
      'office_signin_request_email_enqueue',
    ]);

    const found: string[] = [];
    for (const [, sql] of sources) {
      const re =
        /create trigger\s+(\w+)\s+(after|before)[^;]*?on public\.office_signin_requests[^;]*?execute function public\.(\w+)\(\)/gs;
      for (const match of sql.matchAll(re)) {
        const [, triggerName, , fnName] = match;
        found.push(triggerName);
        expect(allowedTriggers.has(triggerName)).toBe(true);
        expect(allowedFunctions.has(fnName)).toBe(true);

        // The trigger functions must never touch OLD — the table's rows only
        // ever flow through NEW on AFTER INSERT, and OLD dereferences were the
        // production crash of the first migration revision.
        const fnStart = sql.indexOf(`function public.${fnName}`);
        expect(fnStart).toBeGreaterThanOrEqual(0);
        const fnBody = sql.slice(fnStart, sql.indexOf('$$;', fnStart) + 3);
        expect(fnBody).not.toMatch(/\bold\./);
      }
    }
    expect(found).toContain('office_signin_requests_notify_admin');
    expect(found).toContain('office_signin_requests_email_enqueue');
  });

  it('migration RLS rewrites keep the audit actor constraint (no forged attribution)', () => {
    for (const sql of [arenaSql('office-approval.sql'), schemaSource()]) {
      const start = sql.indexOf('create policy audit_log_insert_authenticated');
      expect(start).toBeGreaterThanOrEqual(0);
      const body = sql.slice(start, sql.indexOf(';', start));
      expect(body).toContain('actor = auth.uid() or actor is null');
      expect(body).toContain('office_session_is_approved()');
    }
  });
});

describe('email notifications migration — jsonb seeds and digest typing', () => {
  it('stores the worker url as a real jsonb string (never a bare literal)', () => {
    const sql = arenaSql('email-notifications.sql');

    // A bare URL used to ERROR the whole migration ("invalid input syntax for
    // type json") and roll everything back — including the outbox trigger.
    expect(sql).toMatch(/values \('email_worker_url', to_jsonb\(/);
    expect(sql).not.toMatch(/'email_worker_url', 'https/);
  });

  it('casts notification_days elements before max() (text array elements)', () => {
    const sql = arenaSql('email-notifications.sql');
    const start = sql.indexOf('function public.enqueue_expiry_digest');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, sql.indexOf('$$;', start) + 3);

    expect(body).toContain('day_value.value::integer');
    expect(body).toMatch(/day_value\.value ~ '\^\[0-9\]\{1,4\}\$'/);
  });
});
