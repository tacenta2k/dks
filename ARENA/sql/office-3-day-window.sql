-- DKS: Office 3-day visibility window (owner decision, 2026-10-27)
-- Office may see and work with only records CREATED in the last 3 calendar
-- days (Asia/Muscat), today included. Admin sees everything (unchanged).
--   Office-visible iff deleted = false AND
--   (created_at AT TIME ZONE 'Asia/Muscat')::date
--     >= (now() AT TIME ZONE 'Asia/Muscat')::date - 3
-- Creation date only: an Admin edit to an older record does NOT bring it back.
--
-- Apply manually in the Supabase SQL editor AFTER reviewing the read-only
-- preflight results. This script is idempotent and transactional; it changes
-- no entry data.
--
-- ORDER MATTERS on an existing project: run ARENA/sql/entry-visibility.sql
-- (and the Realtime migrations) FIRST and this file LAST. entry-visibility.sql
-- recreates the shared visibility helper; this file must be the final word on
-- it. The preflight below refuses to install when the sync-fix helper or its
-- soft-delete marker machinery is missing.

-- 0. READ-ONLY PREFLIGHT -----------------------------------------------------
select to_regclass('public.entries') is not null as entries_exists,
       to_regclass('public.renewals') is not null as renewals_exists,
       to_regprocedure('public.is_admin()') is not null as admin_helper_exists,
       to_regprocedure('public.is_office()') is not null as office_helper_exists,
       to_regprocedure('public.office_entry_is_visible(public.entries)') is not null as visibility_helper_exists,
       to_regprocedure('public.entry_visibility(uuid)') is not null as visibility_rpc_exists,
       to_regclass('dks_private.office_entry_soft_delete_context') is not null as soft_delete_context_exists,
       to_regprocedure('public.renew_entry(uuid, date)') is not null as renew_entry_exists,
       to_regprocedure('public.column_is_empty(uuid)') is not null as column_is_empty_exists;
select schemaname, tablename, rowsecurity
  from pg_tables where schemaname = 'public' and tablename in ('entries', 'renewals');
select policyname, cmd, permissive, roles
  from pg_policies where schemaname = 'public' and tablename in ('entries', 'renewals')
  order by tablename, policyname;
select tgname, pg_get_triggerdef(oid) as trigger_def
  from pg_trigger
 where tgrelid = 'public.entries'::regclass and not tgisinternal
  order by tgname;
-- The SELECT policy and the RPC must already use the shared helper from the
-- sync fix (this migration keeps them using it and only widens the helper).
select proname, prosrc like '%office_entry_is_visible%' as uses_shared_helper
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname in ('office_entry_is_visible', 'entry_visibility');

-- 1. INSTALL ----------------------------------------------------------------
begin;

-- Permissive policies are OR-ed. Refuse to widen the visibility predicate if
-- any unknown rule could make its answer disagree with actual Office SELECTs,
-- and refuse to install on top of a project that has not received the sync-fix
-- helper (entry-visibility.sql) first.
do $$
declare
  v_unexpected text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'entries' and c.relrowsecurity
  ) then
    raise exception 'DKS office 3-day window aborted: entries RLS is not enabled' using errcode = '42501';
  end if;
  if to_regprocedure('public.office_entry_is_visible(public.entries)') is null
     or to_regprocedure('public.entry_visibility(uuid)') is null
     or to_regclass('dks_private.office_entry_soft_delete_context') is null then
    raise exception 'DKS office 3-day window aborted: sync-fix prerequisites missing'
      using errcode = '42501', hint = 'Run ARENA/sql/entry-visibility.sql first, then this file.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'entry_visibility'
       and p.prosrc like '%office_entry_is_visible%'
  ) then
    raise exception 'DKS office 3-day window aborted: entry_visibility() no longer uses the shared helper'
      using errcode = '42501', hint = 'Re-run ARENA/sql/entry-visibility.sql, then this file.';
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
    raise exception 'DKS office 3-day window aborted: unexpected permissive policies: %', v_unexpected
      using errcode = '42501', hint = 'Review the read-only preflight and resolve unexpected policies before installing.';
  end if;
end;
$$;

-- 1.1 THE shared Office visibility predicate (used by the Office entries
-- SELECT policy and entry_visibility()). Same soft-delete marker allowance as
-- the sync fix; the window is creation-date only.
create or replace function public.office_entry_is_visible(p_entry public.entries)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select (
      (p_entry).deleted is false
      and (p_entry).created_at is not null
      and ((p_entry).created_at at time zone 'Asia/Muscat')::date
        >= (now() at time zone 'Asia/Muscat')::date - 3
    )
    or dks_private.entry_is_being_soft_deleted((p_entry).id);
$$;

revoke all on function public.office_entry_is_visible(public.entries) from anon, public;
grant execute on function public.office_entry_is_visible(public.entries) to authenticated;

-- 1.2 Office INSERT must NOT be windowed (a row created offline 4 days ago
-- must still sync), but Office inserts cannot set created_at in the FUTURE:
-- clamp to now(). created_by/created_at stay immutable on UPDATE.
create or replace function public.entries_keep_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_office() and new.created_at > now() then
      new.created_at := now();
    end if;
    return new;
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists entries_keep_created_by on public.entries;
create trigger entries_keep_created_by
before insert or update on public.entries
for each row execute function public.entries_keep_created_by();

-- 1.3 Office entries UPDATE: same predicate in USING and WITH CHECK; the
-- soft-delete allowance and guard_office_restore() are unchanged. Admin is
-- unchanged. The INSERT policy is deliberately NOT touched here (no window).
drop policy if exists entries_update_authenticated on public.entries;
create policy entries_update_authenticated
on public.entries for update to authenticated
using (
  public.is_admin()
  or (
    public.is_office() and public.office_session_is_approved() and deleted is false
    and ((created_at at time zone 'Asia/Muscat')::date >= (now() at time zone 'Asia/Muscat')::date - 3)
  )
)
with check (
  public.is_admin()
  or (
    public.is_office()
    and public.office_session_is_approved()
    and ((created_at at time zone 'Asia/Muscat')::date >= (now() at time zone 'Asia/Muscat')::date - 3)
    and (
      (
        deleted is false
        and deleted_at is null
        and deleted_by is null
      )
      or (
        deleted is true
        and deleted_at is not null
        and (deleted_by is null or deleted_by = auth.uid())
      )
    )
  )
);

-- 1.4 renewals SELECT for Office: only for Office-visible entries.
drop policy if exists renewals_select_authenticated on public.renewals;
create policy renewals_select_authenticated
on public.renewals for select to authenticated
using (
  public.is_admin()
  or (
    public.is_office()
    and public.office_session_is_approved()
    and exists (
      select 1
        from public.entries e
       where e.id = entry_id
         and public.office_entry_is_visible(e)
    )
  )
);

-- 1.5 Office-callable RPC touching entries: renew_entry() uses the same
-- predicate for Office (SECURITY DEFINER bypasses RLS, so the check is
-- explicit). Admin renewal of any live entry is unchanged.
create or replace function public.renew_entry(p_entry_id uuid, p_new_expiry date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  entry_row public.entries%rowtype;
  primary_name text;
  old_expiry date;
  renewal_id uuid;
begin
  if auth.uid() is null or (not public.is_admin() and not (public.is_office() and public.office_session_is_approved())) then
    raise exception 'Only office users with an approved session or administrators may renew entries'
      using errcode = '42501';
  end if;

  if p_new_expiry is null then
    raise exception 'A new expiry date is required' using errcode = '22004';
  end if;

  select *
    into entry_row
    from public.entries
   where id = p_entry_id
     and not deleted
   for update;

  if not found then
    raise exception 'Entry does not exist or is deleted' using errcode = '22023';
  end if;

  -- Office-callable RPC touching entries: Office may only renew entries it can
  -- see (live and inside the 3-day creation window). Admin is unchanged. The
  -- shared helper carries the same predicate as the entries SELECT policy.
  if not public.is_admin() and not public.office_entry_is_visible(entry_row) then
    raise exception 'This record can no longer be changed from the Office account'
      using errcode = '42501';
  end if;

  select name
    into primary_name
    from public.app_columns
   where is_primary_expiry
     and not deleted
     and visible
   limit 1;

  if primary_name is null then
    raise exception 'A primary expiry column must be configured'
      using errcode = '23514';
  end if;

  begin
    old_expiry := nullif(entry_row.data ->> primary_name, '')::date;
  exception when others then
    raise exception 'The entry has an invalid primary expiry value'
      using errcode = '23514';
  end;

  if old_expiry is not null and p_new_expiry <= old_expiry then
    raise exception 'The renewed expiry must be later than the current expiry'
      using errcode = '23514';
  end if;

  insert into public.renewals (
    entry_id,
    old_expiry,
    new_expiry,
    snapshot,
    renewed_by,
    renewed_at
  ) values (
    p_entry_id,
    old_expiry,
    p_new_expiry,
    entry_row.data,
    auth.uid(),
    now()
  ) returning id into renewal_id;

  update public.entries
     set data = jsonb_set(
       coalesce(data, '{}'::jsonb),
       array[primary_name],
       to_jsonb(to_char(p_new_expiry, 'YYYY-MM-DD')),
       true
      ),
      updated_by = auth.uid(),
      last_renewed_at = now(),
      version = version + 1,
     updated_at = now()
   where id = p_entry_id;

  return renewal_id;
end;
$$;

-- 1.6 Office-callable RPC touching entries: column_is_empty() counts only
-- entries Office can see (same predicate). Admin keeps counting every live row.
create or replace function public.column_is_empty(p_column_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  column_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not public.is_admin() and not (public.is_office() and public.office_session_is_approved()) then
    raise exception 'Only office users with an approved session or administrators may inspect columns'
      using errcode = '42501';
  end if;

  select name
    into column_name
    from public.app_columns
   where id = p_column_id
     and not deleted;

  if column_name is null then
    raise exception 'Column does not exist' using errcode = '22023';
  end if;

  -- Office-callable RPC touching entries: Office may only "see" entries inside
  -- its 3-day creation window, so only those rows can keep a column alive for
  -- an Office delete. Admin keeps counting every live row (unchanged).
  return not exists (
    select 1
      from public.entries e
     where not e.deleted
       and (not public.is_office() or public.office_entry_is_visible(e))
       and nullif(trim(e.data ->> column_name), '') is not null
  );
end;
$$;

commit;

-- 2. VERIFICATION (READ-ONLY) ------------------------------------------------
-- Expected: entries policies are exactly the four known ones with the window
-- in the UPDATE policy ONLY; the INSERT policy has no window; the SELECT
-- policy and entry_visibility() still use office_entry_is_visible; the
-- visibility helper carries the Muscat window; renewals SELECT uses the
-- helper; renew_entry and column_is_empty carry the Office window; the
-- entries_keep_created_by trigger fires on INSERT and UPDATE; Admin policy
-- texts are unchanged.
select policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename in ('entries', 'renewals')
 order by tablename, policyname;
select proname,
       prosrc like '%Asia/Muscat%' as carries_muscat_window,
       prosrc like '%office_entry_is_visible%' as uses_shared_helper
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and proname in ('office_entry_is_visible', 'entry_visibility', 'renew_entry', 'column_is_empty');
select tgname, pg_get_triggerdef(oid) as trigger_def
  from pg_trigger
 where tgrelid = 'public.entries'::regclass and not tgisinternal
 order by tgname;
select has_function_privilege('authenticated', 'public.office_entry_is_visible(public.entries)', 'execute') as authenticated_can_execute,
       has_function_privilege('anon', 'public.office_entry_is_visible(public.entries)', 'execute') as anon_can_execute;
select (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'office_entry_is_visible') like '%deleted is false%'
         as helper_keeps_deleted_rule,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'entries'
           and policyname = 'entries_insert_authenticated'
           and coalesce(qual, '') || coalesce(with_check, '') not like '%Asia/Muscat%') = 1
         as insert_policy_has_no_window,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'entries'
           and policyname = 'entries_update_authenticated'
           and coalesce(qual, '') || coalesce(with_check, '') like '%Asia/Muscat%') = 1
         as update_policy_has_window;
