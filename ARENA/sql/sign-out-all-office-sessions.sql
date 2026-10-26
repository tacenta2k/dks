-- ============================================================================
-- DKS — Admin action: sign out all Office sessions (EXISTING deployments)
-- ============================================================================
--
-- WHAT THIS CHANGES:
--   Adds public.sign_out_all_office_sessions(), the SECURITY DEFINER RPC used
--   by Settings → Workspace → "Sign out all office sessions".
--
-- AUTHORIZATION:
--   The signed-in caller must satisfy public.is_admin(). The function raises
--   SQLSTATE 42501 for every other caller. EXECUTE is revoked from PUBLIC and
--   anon and granted only to authenticated; the in-function administrator
--   check remains the real authorization boundary.
--
-- EFFECT WHEN CALLED:
--   1. Pending and approved Office approval rows become 'revoked', so DKS's
--      session-bound RLS denies later requests immediately.
--   2. Refresh tokens and Auth sessions belonging only to profiles with role
--      'office' are deleted. The acting administrator remains signed in.
--   3. One audit_log row records the counts. Business records are untouched.
--
-- An already-issued JWT remains cryptographically valid until its exp claim,
-- which is a Supabase Auth property. Step 1 is therefore essential: even if a
-- device still holds an unexpired access token, office_session_is_approved()
-- is false and DKS data policies deny it.
--
-- DO NOT RUN BEFORE REVIEW: §0 is SELECT-only. This migration is idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- §0 — READ-ONLY PREFLIGHT (safe to run standalone)
-- ---------------------------------------------------------------------------
-- select 'profiles' as check_, exists (
--   select 1 from pg_tables where schemaname='public' and tablename='profiles');
-- select 'office_requests' as check_, exists (
--   select 1 from pg_tables
--    where schemaname='public' and tablename='office_signin_requests');
-- select 'is_admin_fn' as check_, count(*)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='is_admin';
-- select 'auth_sessions' as check_, exists (
--   select 1 from pg_tables where schemaname='auth' and tablename='sessions');
-- select 'auth_refresh_tokens' as check_, exists (
--   select 1 from pg_tables
--    where schemaname='auth' and tablename='refresh_tokens');
--
-- Expect every table check to be true and is_admin_fn=1.

-- ---------------------------------------------------------------------------
-- §1 — bulk Office session sign-out RPC
-- ---------------------------------------------------------------------------
create or replace function public.sign_out_all_office_sessions()
returns table (
  office_users bigint,
  auth_sessions_deleted bigint,
  requests_revoked bigint
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor uuid := auth.uid();
  v_office_users bigint := 0;
  v_refresh_tokens_deleted bigint := 0;
  v_auth_sessions_deleted bigint := 0;
  v_requests_revoked bigint := 0;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Only administrators may sign out Office sessions'
      using errcode = '42501';
  end if;

  select count(*) into v_office_users
    from public.profiles
   where role = 'office';

  update public.office_signin_requests r
     set status = 'revoked',
         decided_at = now(),
         decided_by = v_actor,
         updated_at = now()
   where r.status in ('pending', 'approved')
     and exists (
       select 1
         from public.profiles p
        where p.id = r.user_id
          and p.role = 'office'
     );
  get diagnostics v_requests_revoked = row_count;

  delete from auth.refresh_tokens rt
   using auth.sessions s, public.profiles p
   where rt.session_id = s.id
     and s.user_id = p.id
     and p.role = 'office';
  get diagnostics v_refresh_tokens_deleted = row_count;

  delete from auth.sessions s
   using public.profiles p
   where s.user_id = p.id
     and p.role = 'office';
  get diagnostics v_auth_sessions_deleted = row_count;

  insert into public.audit_log (actor, entry_id, action, snapshot, details)
  values (
    v_actor,
    null,
    'office_sessions_signed_out',
    '{}'::jsonb,
    jsonb_build_object(
      'office_users', v_office_users,
      'auth_sessions_deleted', v_auth_sessions_deleted,
      'refresh_tokens_deleted', v_refresh_tokens_deleted,
      'requests_revoked', v_requests_revoked
    )
  );

  return query select v_office_users, v_auth_sessions_deleted, v_requests_revoked;
end;
$$;

revoke all on function public.sign_out_all_office_sessions() from public;
revoke all on function public.sign_out_all_office_sessions() from anon;
grant execute on function public.sign_out_all_office_sessions() to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- §2 — READ-ONLY VERIFICATION (run after the migration)
-- ---------------------------------------------------------------------------
-- select 'function_exists' as check_, count(*)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='sign_out_all_office_sessions';
-- select 'security_definer' as check_, p.prosecdef
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='sign_out_all_office_sessions';
-- select 'authenticated_execute' as check_,
--        has_function_privilege(
--          'authenticated',
--          'public.sign_out_all_office_sessions()',
--          'EXECUTE');
-- select 'anon_execute' as check_,
--        has_function_privilege(
--          'anon',
--          'public.sign_out_all_office_sessions()',
--          'EXECUTE');
--
-- Expect: function_exists=1, security_definer=true,
-- authenticated_execute=true, anon_execute=false.
