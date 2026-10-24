import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaPath = resolve(process.cwd(), 'supabase/schema.sql');
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
