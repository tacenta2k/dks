import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('supabase/schema.sql', 'utf8').toLowerCase();
const visibilityMigration = readFileSync('ARENA/sql/entry-visibility.sql', 'utf8').toLowerCase();
const realtimeMigration = readFileSync('ARENA/sql/realtime-office-approval.sql', 'utf8').toLowerCase();

describe('visibility and approval SQL contract', () => {
  it.each([schema, visibilityMigration])('uses the same stable predicate in SELECT and the guarded visibility-only RPC', (sql) => {
    expect(sql).toMatch(/function public\.office_entry_is_visible\(p_entry public\.entries\)[\s\S]*?stable[\s\S]*?\(p_entry\)\.deleted is false/);
    expect(sql).toMatch(/function public\.entry_visibility\(p_id uuid\)[\s\S]*?stable[\s\S]*?security definer/);
    expect(sql).toMatch(/public\.is_office\(\) and public\.office_session_is_approved\(\)/);
    expect(sql).toMatch(/public\.office_entry_is_visible\(e\) then 'visible'[\s\S]*?else 'hidden'[\s\S]*?coalesce\(v_visibility, 'missing'\)/);
    expect(sql).toMatch(/create policy entries_select_authenticated[\s\S]*?public\.office_entry_is_visible\(entries\)/);
    expect(sql).toContain('revoke all on function public.entry_visibility(uuid) from anon, public');
    expect(sql).toContain('grant execute on function public.entry_visibility(uuid) to authenticated');
  });

  it.each([schema, realtimeMigration])('publishes requests idempotently and limits Office reads to the signed session', (sql) => {
    expect(sql).toMatch(/create policy office_signin_requests_select_own_or_admin[\s\S]*?user_id = auth\.uid\(\)[\s\S]*?auth_session_id = nullif\(auth\.jwt\(\) ->> 'session_id', ''\)::uuid/);
    expect(sql).toMatch(/pg_publication_tables[\s\S]*?tablename = 'office_signin_requests'[\s\S]*?alter publication supabase_realtime add table public\.office_signin_requests/);
  });

  it('contains read-only preflight and verification in both manual migrations', () => {
    for (const sql of [visibilityMigration, realtimeMigration]) {
      expect(sql).toContain('read-only preflight');
      expect(sql).toContain('read-only verification');
      expect(sql).toContain('begin;');
      expect(sql).toContain('commit;');
      expect(sql).not.toMatch(/disable row level security|truncate\s|drop table\s/);
    }
  });

  it('explicitly revokes the bulk-signout RPC from unauthenticated roles', () => {
    expect(schema).toContain('revoke all on function public.sign_out_all_office_sessions() from anon, public;');
    expect(schema).toContain('grant execute on function public.sign_out_all_office_sessions() to authenticated;');
  });
});
