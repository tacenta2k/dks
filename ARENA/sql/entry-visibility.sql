-- DKS: entry visibility classification for offline Office writes
-- Apply manually in the Supabase SQL editor AFTER reviewing the read-only
-- preflight results. This script is idempotent; it changes no entry data.
-- The companion Realtime migration is ARENA/sql/realtime-office-approval.sql.

-- 0. READ-ONLY PREFLIGHT -----------------------------------------------------
select to_regclass('public.entries') is not null as entries_exists,
       to_regprocedure('public.is_admin()') is not null as admin_helper_exists,
       to_regprocedure('public.is_office()') is not null as office_helper_exists,
       to_regprocedure('public.office_session_is_approved()') is not null as approval_helper_exists;
select schemaname, tablename, rowsecurity
  from pg_tables where schemaname = 'public' and tablename = 'entries';
select policyname, cmd, qual
  from pg_policies where schemaname = 'public' and tablename = 'entries'
  order by policyname;

-- 1. INSTALL ---------------------------------------------------------------
begin;

-- This is the ONE Office row-visibility predicate. When a later feature
-- restricts older rows, change this helper, not two independent predicates.
create or replace function public.office_entry_is_visible(p_entry public.entries)
returns boolean
language sql
stable
set search_path = public
as $$
  select (p_entry).deleted is false;
$$;

-- The definer may inspect existence behind RLS but returns no row data. An
-- Office caller must be approved for its CURRENT signed JWT session. Never
-- expose a missing/hidden distinction to a pending/revoked Office session.
create or replace function public.entry_visibility(p_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_visibility text;
begin
  if auth.uid() is null or not (
    public.is_admin()
    or (public.is_office() and public.office_session_is_approved())
  ) then
    raise exception 'An approved session is required' using errcode = '42501';
  end if;

  select case
    when public.is_admin() or public.office_entry_is_visible(e) then 'visible'
    else 'hidden'
  end into v_visibility
  from public.entries e
  where e.id = p_id;

  return coalesce(v_visibility, 'missing');
end;
$$;

revoke all on function public.office_entry_is_visible(public.entries) from anon, public;
revoke all on function public.entry_visibility(uuid) from anon, public;
grant execute on function public.office_entry_is_visible(public.entries) to authenticated;
grant execute on function public.entry_visibility(uuid) to authenticated;

drop policy if exists entries_select_authenticated on public.entries;
create policy entries_select_authenticated
on public.entries for select to authenticated
using (
  public.is_admin()
  or (public.is_office() and public.office_session_is_approved() and public.office_entry_is_visible(entries))
);

commit;

-- 2. READ-ONLY VERIFICATION -------------------------------------------------
-- Confirm RLS remains enabled, the SELECT policy calls the shared helper,
-- the RPC is stable/security-definer, and anon/PUBLIC lack execute.
select schemaname, tablename, rowsecurity
  from pg_tables where schemaname = 'public' and tablename = 'entries';
select policyname, cmd, qual
  from pg_policies
 where schemaname = 'public' and tablename = 'entries'
   and policyname = 'entries_select_authenticated';
select p.proname, p.provolatile, p.prosecdef, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('office_entry_is_visible', 'entry_visibility')
 order by p.proname;
select has_function_privilege('authenticated', 'public.entry_visibility(uuid)', 'execute') as authenticated_can_execute,
       has_function_privilege('anon', 'public.entry_visibility(uuid)', 'execute') as anon_can_execute;
-- Expected: true, false. Test approved/denied behavior with actual sessions
-- separately; do not substitute a user ID or session ID into these checks.
