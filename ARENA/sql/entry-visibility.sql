-- DKS: entry visibility classification for offline Office writes
-- Apply manually in the Supabase SQL editor AFTER reviewing the read-only
-- preflight results. This script is idempotent; it changes no entry data.
-- It installs a private, transaction-scoped soft-delete check context.
-- The companion Realtime migration is ARENA/sql/realtime-office-approval.sql.

-- 0. READ-ONLY PREFLIGHT -----------------------------------------------------
select to_regclass('public.entries') is not null as entries_exists,
       to_regprocedure('public.is_admin()') is not null as admin_helper_exists,
       to_regprocedure('public.is_office()') is not null as office_helper_exists,
       to_regprocedure('public.office_session_is_approved()') is not null as approval_helper_exists;
select schemaname, tablename, rowsecurity
  from pg_tables where schemaname = 'public' and tablename = 'entries';
select policyname, cmd, permissive, roles, qual, with_check
  from pg_policies where schemaname = 'public' and tablename = 'entries'
  order by policyname;
select to_regclass('dks_private.office_entry_soft_delete_context') is not null as context_exists;

-- 1. INSTALL ---------------------------------------------------------------
begin;

-- Permissive policies are OR-ed. Refuse to install a visibility classifier if
-- any unknown rule could make its answer disagree with actual Office SELECTs.
do $$
declare
  v_unexpected text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'entries' and c.relrowsecurity
  ) then
    raise exception 'DKS entry visibility migration aborted: entries RLS is not enabled' using errcode = '42501';
  end if;
  select string_agg(format('%s (%s)', policyname, cmd), ', ' order by policyname)
    into v_unexpected
    from pg_policies
   where schemaname = 'public' and tablename = 'entries' and permissive = 'PERMISSIVE'
     and (policyname, cmd) not in (
       ('entries_select_authenticated', 'SELECT'),
       ('entries_insert_authenticated', 'INSERT'),
       ('entries_update_authenticated', 'UPDATE'),
       ('entries_delete_admin', 'DELETE')
     );
  if v_unexpected is not null then
    raise exception 'DKS entry visibility migration aborted: unexpected permissive policies: %', v_unexpected
      using errcode = '42501', hint = 'Review the read-only preflight and resolve unexpected policies before installing.';
  end if;
end;
$$;

-- PostgreSQL applies the SELECT policy to a new row when UPDATE reads an id
-- in its WHERE clause, even with no RETURNING. While an approved Office user
-- soft-deletes a live row, expose only that already-readable row to the UPDATE
-- check, and only until its AFTER trigger runs. This private, transaction- and
-- backend-scoped marker cannot be created/read by API roles; it rolls back
-- with a failed statement. Ordinary SELECTs and the visibility RPC still hide
-- all deleted rows. Do not replace this with a client-settable GUC or header.
create schema if not exists dks_private;
revoke all on schema dks_private from public, anon, authenticated;
create table if not exists dks_private.office_entry_soft_delete_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  entry_id uuid not null,
  primary key (backend_pid, transaction_id, entry_id)
);
alter table dks_private.office_entry_soft_delete_context enable row level security;
revoke all on dks_private.office_entry_soft_delete_context from public, anon, authenticated;

create or replace function dks_private.entry_is_being_soft_deleted(p_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from dks_private.office_entry_soft_delete_context c
     where c.backend_pid = pg_backend_pid()
       and c.transaction_id = txid_current_if_assigned()
       and c.entry_id = p_id
  );
$$;
revoke all on function dks_private.entry_is_being_soft_deleted(uuid) from public, anon, authenticated;

create or replace function dks_private.begin_office_entry_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.is_office() and public.office_session_is_approved() then
    insert into dks_private.office_entry_soft_delete_context (backend_pid, transaction_id, entry_id)
    values (pg_backend_pid(), txid_current(), new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create or replace function dks_private.end_office_entry_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from dks_private.office_entry_soft_delete_context c
   where c.backend_pid = pg_backend_pid()
     and c.transaction_id = txid_current_if_assigned()
     and c.entry_id = new.id;
  return new;
end;
$$;
revoke all on function dks_private.begin_office_entry_soft_delete() from public, anon, authenticated;
revoke all on function dks_private.end_office_entry_soft_delete() from public, anon, authenticated;

drop trigger if exists entries_office_soft_delete_begin on public.entries;
create trigger entries_office_soft_delete_begin
before update of deleted on public.entries
for each row when (old.deleted is false and new.deleted is true)
execute function dks_private.begin_office_entry_soft_delete();

drop trigger if exists entries_office_soft_delete_end on public.entries;
create trigger entries_office_soft_delete_end
after update of deleted on public.entries
for each row when (old.deleted is false and new.deleted is true)
execute function dks_private.end_office_entry_soft_delete();

-- This is the ONE Office visibility predicate shared by RLS and the RPC. The
-- private marker is an execution-only allowance, not a persisted visibility
-- change; ordinary SELECT and RPC calls see deleted records as hidden.
create or replace function public.office_entry_is_visible(p_entry public.entries)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select (p_entry).deleted is false
      or dks_private.entry_is_being_soft_deleted((p_entry).id);
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
select policyname, cmd, permissive, roles, qual, with_check
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

select has_schema_privilege('authenticated', 'dks_private', 'usage') as authenticated_can_use_private_schema,
       has_table_privilege('authenticated', 'dks_private.office_entry_soft_delete_context', 'select,insert,update,delete') as authenticated_can_access_context;
select tgname from pg_trigger
 where tgrelid = 'public.entries'::regclass and not tgisinternal
   and tgname in ('entries_office_soft_delete_begin', 'entries_office_soft_delete_end')
 order by tgname;
-- Expected: false, false; exactly two private soft-delete context triggers.
