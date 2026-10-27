-- DKS: live Visa Sheet change notifications (two PCs, one shared sheet)
--
-- Apply manually in the Supabase SQL editor after reviewing the read-only
-- preflight. Idempotent: running it twice changes nothing the second time.
--
-- WHAT THIS DOES
--   Adds public.entries and public.app_columns to the existing
--   `supabase_realtime` publication, so a client can be woken up when another
--   PC saves a row or a column.
--
-- WHAT THIS DOES NOT DO
--   * No policy, grant, trigger, table or column is created, dropped or
--     altered. RLS stays exactly as it is today.
--   * Realtime postgres_changes is subject to the table's RLS SELECT policies:
--     the server only sends a change when the subscriber may already SELECT
--     that row. Office therefore never receives a row it cannot read, and a
--     pending/revoked Office session receives nothing at all.
--
-- CLIENT BEHAVIOUR (src/features/sync/live-sheet-realtime.ts)
--   Every event is treated ONLY as "something changed". The payload is never
--   applied: events are coalesced for ~1 s and then the existing pull/reconcile
--   path runs, so last-write-wins and the outbox keep their current semantics.
--   The 1.5 s push debounce and the 60 s timer sync are unchanged (fallback).
--
-- EXPECTED QUOTA (Supabase free tier: 200 concurrent Realtime connections,
-- 2 million messages/month)
--   * 1 Realtime connection per signed-in DKS client (one channel, three
--     filters: entries + app_columns + the pre-existing approval channel is a
--     separate channel). A 2-PC office therefore uses 2 connections total.
--   * ~1 message per saved change per OTHER connected client. A row edit is
--     one entry UPDATE; a column add is one app_columns INSERT. Bursts are
--     coalesced client-side into a single sync, so messages do not multiply.
--   * Example worst case: 2 PCs, 200 saved changes per working day, 22 days
--     = 200 * 2 * 22 ≈ 8,800 messages/month (0.44% of the free allowance).
--   * Reconnects use exponential backoff with jitter (1 s → 30 s), so a
--     paused project or a lost network cannot cause a reconnect storm.

-- 0. READ-ONLY PREFLIGHT -----------------------------------------------------
select exists (select 1 from pg_publication where pubname = 'supabase_realtime') as realtime_publication_exists,
       to_regclass('public.entries') is not null as entries_exists,
       to_regclass('public.app_columns') is not null as app_columns_exists;

select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('entries', 'app_columns')
 order by c.relname;

-- Review these before installing: the same policies will now also decide which
-- change events Realtime delivers.
select tablename, policyname, cmd, permissive, roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename in ('entries', 'app_columns')
 order by tablename, policyname;

select has_table_privilege('authenticated', 'public.entries', 'select') as authenticated_can_select_entries,
       has_table_privilege('authenticated', 'public.app_columns', 'select') as authenticated_can_select_app_columns,
       has_table_privilege('anon', 'public.entries', 'select') as anon_can_select_entries,
       has_table_privilege('anon', 'public.app_columns', 'select') as anon_can_select_app_columns;
-- Expected: true, true, false, false.

select pubname, schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
   and tablename in ('entries', 'app_columns');
-- Expect zero rows before the first run and two rows afterwards.

-- 1. INSTALL ---------------------------------------------------------------
begin;

do $$
declare
  v_table text;
  v_problem text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'DKS live-sheet migration aborted: the supabase_realtime publication is missing; enable Realtime in the Supabase dashboard first'
      using errcode = '42501';
  end if;

  foreach v_table in array array['entries', 'app_columns'] loop
    if to_regclass(format('public.%I', v_table)) is null then
      raise exception 'DKS live-sheet migration aborted: public.% does not exist', v_table
        using errcode = '42501';
    end if;

    -- Publishing a table without RLS would stream every row to every
    -- subscriber. Refuse instead of installing a leak.
    if not exists (
      select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'DKS live-sheet migration aborted: RLS is not enabled on public.%', v_table
        using errcode = '42501',
              hint = 'Enable row level security and the existing policies before publishing the table.';
    end if;

    -- Realtime only delivers a change the subscriber may SELECT. With no
    -- authenticated SELECT policy nothing would ever arrive (silently broken),
    -- and with an anon policy the sheet would be readable anonymously.
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = v_table
         and cmd in ('SELECT', 'ALL')
         and (roles && array['authenticated', 'public']::name[])
    ) then
      raise exception 'DKS live-sheet migration aborted: public.% has no SELECT policy for authenticated', v_table
        using errcode = '42501',
              hint = 'Run the entries/app_columns policy migrations first.';
    end if;

    select string_agg(format('%s (%s → %s)', policyname, cmd, array_to_string(roles, ',')), ', ' order by policyname)
      into v_problem
      from pg_policies
     where schemaname = 'public' and tablename = v_table
       and cmd in ('SELECT', 'ALL')
       and roles && array['anon']::name[];
    if v_problem is not null then
      raise exception 'DKS live-sheet migration aborted: anonymous SELECT policy on public.%: %', v_table, v_problem
        using errcode = '42501',
              hint = 'Remove the anonymous read policy before publishing this table.';
    end if;

    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

commit;

-- 2. READ-ONLY VERIFICATION ------------------------------------------------
select pubname, schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
 order by tablename;
-- Expect entries and app_columns to be present exactly once (plus settings,
-- admin_notifications and office_signin_requests). Run this script a second
-- time to confirm the rows do not duplicate.

select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('entries', 'app_columns')
 order by c.relname;
-- Expect rls_enabled = true for both: publishing did not touch security.

select tablename, policyname, cmd, permissive, roles
  from pg_policies
 where schemaname = 'public' and tablename in ('entries', 'app_columns')
 order by tablename, policyname;
-- Expect the same policy list as the preflight: this migration changes none.

-- Delivery and the cross-session restriction must be confirmed with real
-- signed-in sessions (two PCs); this script cannot prove Realtime behaviour.
-- Manual test: edit a row on PC A, confirm PC B shows it within ~3 s, then the
-- same in the other direction, then take one PC offline, edit on the other,
-- reconnect the first and confirm it catches up.
