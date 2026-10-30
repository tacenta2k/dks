-- ============================================================================
-- DKS — Privacy-conscious automated error reporting (server-side ingestion)
-- ============================================================================
--
-- Apply manually in the Supabase SQL Editor ONLY AFTER reviewing the read-only
-- preflight queries in §0. Do NOT deploy automatically.
--
-- WHAT THIS INSTALLS (additive, idempotent, zero customer-data access):
--  1. Shared setting seed `error_reporting_enabled = true` (on conflict do
--     nothing — never overwrites an existing administrator choice).
--  2. `public.error_report_fingerprints` — deduplicated non-PII diagnostic
--     fingerprints and linked GitHub Issue numbers (24h rollup window).
--  3. `public.error_report_events` — bounded 30-day server-side rate-limit and
--     delivery log storing allowlisted diagnostic metadata ONLY (no customer
--     fields, no raw error messages, no stack traces, no emails, no paths).
--  4. `public.verify_error_report_caller()` — authenticated RPC enforcing
--     `is_admin() OR (is_office() AND office_session_is_approved())`.
--  5. `public.ingest_error_report(...)` & `public.complete_error_report_delivery(...)`
--     — `service_role`-ONLY RPCs called exclusively by the `report-error`
--     Edge Function (desktop clients have zero write access to these tables).
-- ============================================================================

-- 0. READ-ONLY PREFLIGHT -----------------------------------------------------
select to_regclass('public.profiles') is not null as profiles_exists,
       to_regclass('public.settings') is not null as settings_exists,
       to_regclass('public.office_signin_requests') is not null as office_requests_exists,
       to_regprocedure('public.is_admin()') is not null as is_admin_exists,
       to_regprocedure('public.is_office()') is not null as is_office_exists,
       to_regprocedure('public.office_session_is_approved()') is not null as approval_gate_exists;

select schemaname, tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('settings', 'error_report_fingerprints', 'error_report_events')
 order by tablename;

select tablename, policyname, cmd, permissive, roles
  from pg_policies
 where schemaname = 'public'
   and tablename in ('settings', 'error_report_fingerprints', 'error_report_events')
 order by tablename, policyname;

select key, value, updated_at
  from public.settings
 where key = 'error_reporting_enabled';

-- 1. INSTALL -----------------------------------------------------------------
begin;

-- Guard: verify `public.settings` has RLS enabled, and if the error-reporting
-- tables already exist from an earlier run, refuse to install over unexpected
-- permissive policies.
do $$
declare
  v_unexpected text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'settings' and c.relrowsecurity
  ) then
    raise exception 'DKS error reporting migration aborted: settings RLS is not enabled'
      using errcode = '42501';
  end if;

  if to_regclass('public.error_report_fingerprints') is not null then
    select string_agg(format('%s.%s (%s)', tablename, policyname, cmd), ', ' order by policyname)
      into v_unexpected
      from pg_policies
     where schemaname = 'public'
       and tablename = 'error_report_fingerprints'
       and permissive = 'PERMISSIVE'
       and (policyname, cmd) <> ('error_report_fingerprints_admin_select', 'SELECT');
    if v_unexpected is not null then
      raise exception 'DKS error reporting migration aborted: unexpected permissive policies: %', v_unexpected
        using errcode = '42501';
    end if;
  end if;

  if to_regclass('public.error_report_events') is not null then
    select string_agg(format('%s.%s (%s)', tablename, policyname, cmd), ', ' order by policyname)
      into v_unexpected
      from pg_policies
     where schemaname = 'public'
       and tablename = 'error_report_events'
       and permissive = 'PERMISSIVE'
       and (policyname, cmd) <> ('error_report_events_admin_select', 'SELECT');
    if v_unexpected is not null then
      raise exception 'DKS error reporting migration aborted: unexpected permissive policies: %', v_unexpected
        using errcode = '42501';
    end if;
  end if;
end;
$$;

insert into public.settings (key, value)
values ('error_reporting_enabled', 'true'::jsonb)
on conflict (key) do nothing;

create table if not exists public.error_report_fingerprints (
  fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{32,64}$'),
  category text not null check (
    category in ('auth', 'sync', 'sqlite', 'ipc', 'updater', 'renderer', 'main', 'settings', 'network')
  ),
  severity text not null check (severity in ('error', 'warning')),
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_.:-]{1,63}$'),
  component text not null check (component ~ '^[a-z0-9][a-z0-9_.:/-]{1,63}$'),
  process text not null check (process in ('main', 'renderer')),
  first_app_version text not null,
  latest_app_version text not null,
  platforms text[] not null default '{}'::text[],
  occurrences bigint not null default 1 check (occurrences >= 1),
  github_issue_number integer,
  github_issue_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_github_sync_at timestamptz
);

create index if not exists error_report_fingerprints_last_seen_idx
  on public.error_report_fingerprints (last_seen_at desc);

create table if not exists public.error_report_events (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null references public.error_report_fingerprints(fingerprint) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  reporter_role text not null check (reporter_role in ('admin', 'office')),
  app_version text not null,
  platform text not null check (platform in ('win32', 'darwin', 'linux', 'unknown')),
  arch text not null check (arch in ('x64', 'arm64', 'ia32', 'unknown')),
  os_release text not null,
  occurrences integer not null default 1 check (occurrences between 1 and 10000),
  delivery_status text not null default 'queued' check (
    delivery_status in ('queued', 'issue_created', 'issue_commented', 'deduped', 'rate_limited', 'failed')
  ),
  delivery_detail text,
  created_at timestamptz not null default now()
);

create index if not exists error_report_events_reporter_created_idx
  on public.error_report_events (reporter_id, created_at desc);

create index if not exists error_report_events_github_sync_idx
  on public.error_report_events (delivery_status, created_at desc)
  where delivery_status in ('issue_created', 'issue_commented');

alter table public.error_report_fingerprints enable row level security;
alter table public.error_report_events enable row level security;

drop policy if exists error_report_fingerprints_admin_select on public.error_report_fingerprints;
create policy error_report_fingerprints_admin_select
  on public.error_report_fingerprints for select to authenticated
  using (public.is_admin());

drop policy if exists error_report_events_admin_select on public.error_report_events;
create policy error_report_events_admin_select
  on public.error_report_events for select to authenticated
  using (public.is_admin());

grant select on public.error_report_fingerprints to authenticated;
grant select on public.error_report_events to authenticated;
revoke insert, update, delete on public.error_report_fingerprints from authenticated;
revoke insert, update, delete on public.error_report_events from authenticated;
revoke all on public.error_report_fingerprints from anon, public;
revoke all on public.error_report_events from anon, public;

-- Caller verification under the desktop user's own JWT: enforces Admin or an
-- approved Office session for this exact `session_id` before the Edge Function
-- accepts any report.
create or replace function public.verify_error_report_caller()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_enabled_json jsonb;
  v_enabled boolean := true;
  v_role text;
begin
  if auth.uid() is null or not (
    public.is_admin()
    or (public.is_office() and public.office_session_is_approved())
  ) then
    raise exception 'An approved DKS session is required' using errcode = '42501';
  end if;

  v_role := case when public.is_admin() then 'admin' else 'office' end;

  select s.value into v_enabled_json
    from public.settings s
   where s.key = 'error_reporting_enabled';

  if v_enabled_json is not null and jsonb_typeof(v_enabled_json) = 'boolean' then
    v_enabled := (v_enabled_json #>> '{}')::boolean;
  end if;

  return jsonb_build_object(
    'authorized', true,
    'user_id', auth.uid()::text,
    'role', v_role,
    'reporting_enabled', v_enabled
  );
end;
$$;

revoke all on function public.verify_error_report_caller() from public, anon;
grant execute on function public.verify_error_report_caller() to authenticated;

-- Service-role-only atomic rate-limit, 30-day retention prune, and 24-hour
-- fingerprint deduplication.
create or replace function public.ingest_error_report(
  p_user_id uuid,
  p_role text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled_json jsonb;
  v_enabled boolean := true;
  v_fingerprint text;
  v_category text;
  v_severity text;
  v_code text;
  v_component text;
  v_process text;
  v_app_version text;
  v_platform text;
  v_arch text;
  v_os_release text;
  v_occurrences integer;
  v_platform_tag text;
  v_user_10m integer := 0;
  v_user_1h integer := 0;
  v_gh_1h integer := 0;
  v_gh_24h integer := 0;
  v_fp public.error_report_fingerprints%rowtype;
  v_action text;
  v_retry_after integer := null;
  v_event_status text;
  v_event_id uuid;
begin
  if coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the error reporting worker may ingest reports' using errcode = '42501';
  end if;

  if p_user_id is null or p_role not in ('admin', 'office') then
    raise exception 'Valid reporter identity is required' using errcode = '22023';
  end if;

  select s.value into v_enabled_json
    from public.settings s
   where s.key = 'error_reporting_enabled';

  if v_enabled_json is not null and jsonb_typeof(v_enabled_json) = 'boolean' then
    v_enabled := (v_enabled_json #>> '{}')::boolean;
  end if;

  if not v_enabled then
    return jsonb_build_object('ok', true, 'action', 'disabled');
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Payload must be a JSON object' using errcode = '22023';
  end if;

  v_fingerprint := coalesce(p_payload ->> 'fingerprint', '');
  v_category := coalesce(p_payload ->> 'category', '');
  v_severity := coalesce(p_payload ->> 'severity', '');
  v_code := coalesce(p_payload ->> 'code', '');
  v_component := coalesce(p_payload ->> 'component', '');
  v_process := coalesce(p_payload ->> 'process', '');
  v_app_version := left(coalesce(p_payload ->> 'appVersion', '0.0.0'), 48);
  v_platform := coalesce(p_payload ->> 'platform', 'unknown');
  v_arch := coalesce(p_payload ->> 'arch', 'unknown');
  v_os_release := left(coalesce(p_payload ->> 'osRelease', '0.0.0'), 32);
  v_occurrences := greatest(1, least(coalesce((p_payload ->> 'occurrences')::integer, 1), 10000));

  if not (v_fingerprint ~ '^[0-9a-f]{32,64}$')
     or v_category not in ('auth', 'sync', 'sqlite', 'ipc', 'updater', 'renderer', 'main', 'settings', 'network')
     or v_severity not in ('error', 'warning')
     or not (v_code ~ '^[A-Z0-9][A-Z0-9_.:-]{1,63}$')
     or not (v_component ~ '^[a-z0-9][a-z0-9_.:/-]{1,63}$')
     or v_process not in ('main', 'renderer')
     or v_platform not in ('win32', 'darwin', 'linux', 'unknown')
     or v_arch not in ('x64', 'arm64', 'ia32', 'unknown') then
    raise exception 'Payload failed allowlist validation' using errcode = '22023';
  end if;

  -- Keep event log bounded to 30 days.
  delete from public.error_report_events ere
   where ere.created_at < now() - interval '30 days';

  -- Per-user rate controls (10 / 10 min, 30 / 1 hour).
  select count(*) into v_user_10m
    from public.error_report_events ere
   where ere.reporter_id = p_user_id
     and ere.created_at >= now() - interval '10 minutes';

  if v_user_10m >= 10 then
    return jsonb_build_object(
      'ok', false,
      'action', 'rate_limited_user',
      'retry_after_seconds', 600
    );
  end if;

  select count(*) into v_user_1h
    from public.error_report_events ere
   where ere.reporter_id = p_user_id
     and ere.created_at >= now() - interval '1 hour';

  if v_user_1h >= 30 then
    return jsonb_build_object(
      'ok', false,
      'action', 'rate_limited_user',
      'retry_after_seconds', 1800
    );
  end if;

  v_platform_tag := v_platform || '-' || v_arch;

  insert into public.error_report_fingerprints (
    fingerprint, category, severity, code, component, process,
    first_app_version, latest_app_version, platforms, occurrences,
    first_seen_at, last_seen_at
  )
  values (
    v_fingerprint, v_category, v_severity, v_code, v_component, v_process,
    v_app_version, v_app_version, array[v_platform_tag], v_occurrences,
    now(), now()
  )
  on conflict (fingerprint) do update
    set latest_app_version = excluded.latest_app_version,
        platforms = case
          when v_platform_tag = any(public.error_report_fingerprints.platforms)
            then public.error_report_fingerprints.platforms
          else array_append(public.error_report_fingerprints.platforms, v_platform_tag)
        end,
        occurrences = public.error_report_fingerprints.occurrences + excluded.occurrences,
        last_seen_at = now()
  returning * into v_fp;

  -- Global GitHub mutation caps (max 20/h and 60/24h across entire deployment).
  select count(*) into v_gh_1h
    from public.error_report_events ere
   where ere.delivery_status in ('issue_created', 'issue_commented')
     and ere.created_at >= now() - interval '1 hour';

  select count(*) into v_gh_24h
    from public.error_report_events ere
   where ere.delivery_status in ('issue_created', 'issue_commented')
     and ere.created_at >= now() - interval '24 hours';

  if v_fp.github_issue_number is null then
    if v_gh_1h >= 20 or v_gh_24h >= 60 then
      v_action := 'rate_limited_github';
      v_retry_after := 1800;
    else
      v_action := 'create_issue';
    end if;
  elsif v_fp.last_github_sync_at is null or v_fp.last_github_sync_at < now() - interval '24 hours' then
    if v_gh_1h >= 20 or v_gh_24h >= 60 then
      v_action := 'rate_limited_github';
      v_retry_after := 1800;
    else
      v_action := 'comment_issue';
    end if;
  else
    v_action := 'deduped';
  end if;

  v_event_status := case
    when v_action = 'deduped' then 'deduped'
    when v_action like 'rate_limited%' then 'rate_limited'
    else 'queued'
  end;

  insert into public.error_report_events (
    fingerprint, reporter_id, reporter_role,
    app_version, platform, arch, os_release,
    occurrences, delivery_status
  )
  values (
    v_fingerprint, p_user_id, p_role,
    v_app_version, v_platform, v_arch, v_os_release,
    v_occurrences, v_event_status
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'ok', v_action not like 'rate_limited%',
    'action', v_action,
    'event_id', v_event_id::text,
    'issue_number', v_fp.github_issue_number,
    'total_occurrences', v_fp.occurrences,
    'first_seen_at', v_fp.first_seen_at,
    'platforms', to_jsonb(v_fp.platforms),
    'retry_after_seconds', v_retry_after
  );
end;
$$;

create or replace function public.complete_error_report_delivery(
  p_event_id uuid,
  p_fingerprint text,
  p_status text,
  p_issue_number integer default null,
  p_issue_url text default null,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the error reporting worker may complete deliveries' using errcode = '42501';
  end if;

  v_status := case
    when p_status in ('issue_created', 'issue_commented', 'deduped', 'rate_limited', 'failed') then p_status
    else 'failed'
  end;

  update public.error_report_events ere
     set delivery_status = v_status,
         delivery_detail = left(coalesce(p_detail, ''), 160)
   where ere.id = p_event_id;

  if v_status in ('issue_created', 'issue_commented') then
    update public.error_report_fingerprints erf
       set github_issue_number = coalesce(p_issue_number, erf.github_issue_number),
           github_issue_url = coalesce(left(p_issue_url, 255), erf.github_issue_url),
           last_github_sync_at = now()
     where erf.fingerprint = p_fingerprint;
  end if;

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

revoke execute on function public.ingest_error_report(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_error_report(uuid, text, jsonb) to service_role;
revoke execute on function public.complete_error_report_delivery(uuid, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.complete_error_report_delivery(uuid, text, text, integer, text, text) to service_role;

commit;

-- 2. READ-ONLY VERIFICATION --------------------------------------------------
select schemaname, tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('error_report_fingerprints', 'error_report_events')
 order by tablename;

select tablename, policyname, cmd, permissive, roles, qual
  from pg_policies
 where schemaname = 'public'
   and tablename in ('error_report_fingerprints', 'error_report_events')
 order by tablename, policyname;

select has_table_privilege('anon', 'public.error_report_fingerprints', 'select') as anon_can_read_fp,
       has_table_privilege('authenticated', 'public.error_report_fingerprints', 'insert') as auth_can_insert_fp,
       has_table_privilege('authenticated', 'public.error_report_events', 'insert') as auth_can_insert_ev,
       has_function_privilege('authenticated', 'public.verify_error_report_caller()', 'execute') as auth_can_verify,
       has_function_privilege('authenticated', 'public.ingest_error_report(uuid, text, jsonb)', 'execute') as auth_can_ingest,
       has_function_privilege('service_role', 'public.ingest_error_report(uuid, text, jsonb)', 'execute') as service_can_ingest,
       has_function_privilege('service_role', 'public.complete_error_report_delivery(uuid, text, text, integer, text, text)', 'execute') as service_can_complete;

select key, value
  from public.settings
 where key = 'error_reporting_enabled';
