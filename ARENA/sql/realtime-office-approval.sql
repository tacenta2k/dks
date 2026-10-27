-- DKS: immediate Office approval/revocation notifications
-- Apply manually in the Supabase SQL editor after reviewing preflight. This
-- idempotent migration publishes only the existing request table; it does not
-- change any request or Auth session. RLS still governs every change event.
-- Quota: one approval channel per signed-in client (in addition to DKS's
-- existing data-sync channel), with a handful of change messages per sign-in.
-- The client treats every event only as a trigger to re-poll the server.

-- 0. READ-ONLY PREFLIGHT -----------------------------------------------------
select to_regclass('public.office_signin_requests') is not null as requests_exist,
       to_regprocedure('public.is_admin()') is not null as admin_helper_exists,
       to_regprocedure('public.is_office()') is not null as office_helper_exists,
       exists (select 1 from pg_publication where pubname = 'supabase_realtime') as realtime_publication_exists;
select schemaname, tablename, rowsecurity
  from pg_tables where schemaname = 'public' and tablename = 'office_signin_requests';
select policyname, cmd, qual
  from pg_policies where schemaname = 'public' and tablename = 'office_signin_requests';
select pubname, schemaname, tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
   and tablename = 'office_signin_requests';

-- 1. INSTALL ---------------------------------------------------------------
begin;

-- Office is a shared account: user_id alone would expose other devices'
-- request rows. Keep the current session's row readable even after revocation
-- so the decision event can be delivered. Admin can still read all requests.
drop policy if exists office_signin_requests_select_own_or_admin on public.office_signin_requests;
create policy office_signin_requests_select_own_or_admin
on public.office_signin_requests for select to authenticated
using (
  public.is_admin()
  or (
    public.is_office()
    and user_id = auth.uid()
    and auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
  )
);

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'The supabase_realtime publication is missing; enable Realtime before running this migration';
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'office_signin_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.office_signin_requests';
  end if;
end;
$$;

commit;

-- 2. READ-ONLY VERIFICATION -------------------------------------------------
select schemaname, tablename, rowsecurity
  from pg_tables where schemaname = 'public' and tablename = 'office_signin_requests';
select policyname, cmd, qual
  from pg_policies where schemaname = 'public' and tablename = 'office_signin_requests';
select pubname, schemaname, tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
   and tablename = 'office_signin_requests';
-- Expect one publication row, RLS true, and the signed-session predicate.
-- Verify delivery and the cross-session restriction using real sessions later.
