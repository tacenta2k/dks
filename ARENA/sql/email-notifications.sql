-- ============================================================================
-- DKS — Optional email notifications via a server-side Edge Function (Resend)
-- ============================================================================
--
-- WHAT THIS CHANGES (review before running — additive, non-destructive):
--
--  1. NEW queue table public.email_outbox + route log email_delivery_log
--     (sanitized status only — no email bodies stored server-side).
--  2. NEW settings rows: 'email_notifications' (admin-managed prefs) and a
--     PRIVATE 'email_trigger_key' (used ONLY between Postgres and the Edge
--     Function; never shipped to the client, never required in the app).
--  3. NEW trigger enqueueing ONE email per NEW pending Office sign-in request
--     (dedupe key = request id), firing only when an admin email is configured.
--  4. NEW SECURITY DEFINER helpers: claim_email_outbox / complete_email_outbox
--     (service-role only — NOT callable by desktop users) and
--     enqueue_expiry_digest() for the daily batch (one email per recipient
--     per day, dedupe-enforced by the unique outbox key).
--  5. Scheduled jobs via pg_cron + pg_net (see §5; SKIPPED cleanly when the
--     extensions are unavailable — free-tier posture is documented below).
--
-- PRIVACY RULES ENFORCED HERE:
--  - Emails NEVER contain passport numbers or Civil IDs by default (digest
--    payload carries only display labels + expiry + days-left — assembled
--    from non-identifier TEXT columns + the primary expiry).
--  - Delivery log stores ONLY: recipient, kind, status, one sanitized
--    detail string, timestamps.
--
-- OFFLINE/FREE-TIER POSTURE:
--  - If pg_cron or pg_net is unavailable, §5 installs nothing and merely
--    reports a NOTICE — nothing breaks; email stays inert.
--  - The Resend key lives ONLY in Edge Function secrets (deploy docs in
--    supabase/README.md §Email). Never in SQL, .env, or the app bundle.
--
-- DO NOT RUN BEFORE REVIEW: §0 preflight is SELECT-only.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- §0 — READ-ONLY PREFLIGHT (safe to run standalone)
-- ---------------------------------------------------------------------------
-- select 'already_present' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='email_outbox');
-- select 'pg_cron_ext' as check_, count(*) from pg_extension where extname='pg_cron';
-- select 'pg_net_ext' as check_, count(*) from pg_extension where extname='pg_net';
-- select 'office_requests' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='office_signin_requests');
--
-- Expect: already_present=false (first run), pg_cron_ext/pg_net_ext>=1,
-- office_requests=true (office-approval.sql applied first).

-- ---------------------------------------------------------------------------
-- §1 — outbox + delivery log
-- ---------------------------------------------------------------------------
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('office_signin_request', 'expiry_digest')),
  dedupe_key text not null,
  recipient text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text
);
create unique index if not exists email_outbox_kind_dedupe_uq
  on public.email_outbox (kind, dedupe_key);

create index if not exists email_outbox_pending_idx
  on public.email_outbox (status, created_at)
  where status = 'pending';

create table if not exists public.email_delivery_log (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid references public.email_outbox(id) on delete set null,
  kind text not null,
  recipient text,
  status text not null check (status in ('delivered', 'skipped', 'failed')),
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists email_delivery_log_created_idx
  on public.email_delivery_log (created_at desc);

alter table public.email_outbox enable row level security;
alter table public.email_delivery_log enable row level security;

-- Only Admin can LOOK at the queue/log (it carries recipient addresses).
drop policy if exists email_outbox_admin_select on public.email_outbox;
create policy email_outbox_admin_select
  on public.email_outbox for select to authenticated
  using (public.is_admin());

drop policy if exists email_delivery_log_admin_select on public.email_delivery_log;
create policy email_delivery_log_admin_select
  on public.email_delivery_log for select to authenticated
  using (public.is_admin());

grant select on public.email_outbox to authenticated;
grant select on public.email_delivery_log to authenticated;
revoke insert, update, delete on public.email_outbox from authenticated;
revoke insert, update, delete on public.email_delivery_log from authenticated;

-- ---------------------------------------------------------------------------
-- §2 — settings (server-side only wiring)
-- ---------------------------------------------------------------------------
insert into public.settings (key, value)
values ('email_notifications', jsonb_build_object(
  'enabled', false,
  'admin_email', null,
  'expiry_digest_enabled', false,
  'expiry_recipients', jsonb_build_array()
))
on conflict (key) do nothing;

insert into public.settings (key, value)
values ('email_trigger_key', to_jsonb(gen_random_uuid()::text))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- §3 — one email per NEW pending Office sign-in request
--        (dedupe key = request id so the unique index caps at exactly one)
-- ---------------------------------------------------------------------------
create or replace function public.office_signin_request_email_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefs jsonb;
  v_admin_email text;
begin
  select value into v_prefs from public.settings where key = 'email_notifications';
  v_admin_email := nullif(trim(coalesce(v_prefs ->> 'admin_email', '')), '');

  -- Hard rules: feature OFF, or no explicit admin email -> no email at all.
  if coalesce((v_prefs ->> 'enabled')::boolean, false) is not true or v_admin_email is null then
    return new;
  end if;

  insert into public.email_outbox (kind, dedupe_key, recipient, payload)
  values (
    'office_signin_request',
    'office_signin_request:' || new.id::text,
    v_admin_email,
    jsonb_build_object(
      'requestedAt', new.requested_at,
      'adminEmail', v_admin_email
    )
  )
  on conflict (kind, dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists office_signin_requests_email_enqueue on public.office_signin_requests;
create trigger office_signin_requests_email_enqueue
after insert on public.office_signin_requests
for each row execute function public.office_signin_request_email_enqueue();

-- ---------------------------------------------------------------------------
-- §4 — outbox claim/complete (service_role ONLY; desktop callers cannot)
-- ---------------------------------------------------------------------------
create or replace function public.claim_email_outbox(p_limit integer default 5)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 20));
begin
  if coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the email worker may claim outbox rows' using errcode = '42501';
  end if;

  return query
  update public.email_outbox
     set attempts = attempts + 1,
         updated_at = now()
   where id in (
     select id
       from public.email_outbox
      where status = 'pending'
        and attempts < 5
      order by created_at
      for update skip locked
      limit v_limit
   )
  returning *;
end;
$$;

create or replace function public.complete_email_outbox(
  p_id uuid,
  p_delivered boolean,
  p_detail text,
  p_recipient text,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.email_outbox%rowtype;
  v_final text;
begin
  if coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the email worker may complete outbox rows' using errcode = '42501';
  end if;

  select * into v_row from public.email_outbox where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if p_delivered then
    v_final := 'delivered';
    update public.email_outbox
       set status = 'delivered',
           delivered_at = now(),
           updated_at = now(),
           last_error = null
     where id = p_id;
  else
    -- requeue status stays 'pending' until attempts burn out to 3
    v_final := case when v_row.attempts >= greatest(coalesce(p_max_attempts, 3), 1) then 'failed' else 'pending' end;
    update public.email_outbox
       set status = v_final,
           updated_at = now(),
           last_error = left(coalesce(p_detail, ''), 240)
     where id = p_id;
  end if;

  insert into public.email_delivery_log (outbox_id, kind, recipient, status, detail)
  values (
    p_id,
    v_row.kind,
    p_recipient,
    case when p_delivered then 'delivered' when v_final = 'failed' then 'failed' else 'skipped' end,
    left(coalesce(p_detail, ''), 240)
  );

  return jsonb_build_object('ok', true, 'status', v_final, 'attempts', v_row.attempts);
end;
$$;

-- The worker RPCs are deliberately NOT granted to desktop users at all.
revoke execute on function public.claim_email_outbox(integer) from public, anon, authenticated;
revoke execute on function public.complete_email_outbox(uuid, boolean, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer) to service_role;
grant execute on function public.complete_email_outbox(uuid, boolean, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- §4b — the daily digest builder (server-side; one email per recipient/day)
-- ---------------------------------------------------------------------------

-- Display label for one entry: the FIRST non-empty TEXT/NOTES value across
-- the sheet's own column position order — identifier fields (passport-flagged
-- or civil_id) never make the list. Returns '(unnamed entry)' when blank.
create or replace function public.digest_row_label(p_data jsonb)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select btrim(value)
      from (
        select p_data ->> c.name as value, c.position as position
        from public.app_columns c
        where not c.deleted
          and coalesce(c.is_passport, false) is not true
          and c.type in ('text', 'notes')
      ) candidates(value, position)
      where value is not null and btrim(value) <> ''
      order by position
      limit 1
    ),
    '(unnamed entry)'
  );
$$;

create or replace function public.enqueue_expiry_digest()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefs jsonb;
  v_recipients jsonb;
  v_window integer := 90;
  v_primary_name text;
  v_items jsonb := '[]'::jsonb;
  v_recipient text;
  v_count integer := 0;
begin
  select value into v_prefs from public.settings where key = 'email_notifications';

  if coalesce((v_prefs ->> 'expiry_digest_enabled')::boolean, false) is not true then
    return 0;
  end if;

  v_recipients := coalesce(v_prefs -> 'expiry_recipients', '[]'::jsonb);
  if jsonb_typeof(v_recipients) <> 'array' or jsonb_array_length(v_recipients) = 0 then
    return 0;
  end if;

  -- Widest configured notification window (default 90 days).
  -- jsonb_array_elements_text yields TEXT: keep only numeric elements and
  -- cast before max() — otherwise COALESCE/MAX type-checking errors out.
  select greatest(90, coalesce(max(day_value.value::integer), 90))
    into v_window
  from public.settings s
       cross join lateral jsonb_array_elements_text(
         case jsonb_typeof(s.value) when 'array' then s.value else '[]'::jsonb end
       ) as day_value(value)
  where s.key = 'notification_days'
    and day_value.value ~ '^[0-9]{1,4}$';
  v_window := coalesce(v_window, 90);

  select name into v_primary_name
    from public.app_columns
   where is_primary_expiry and not deleted and visible
   limit 1;

  if v_primary_name is null then
    return 0;
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'label', public.digest_row_label(e.data),
             'expiry', e.data ->> v_primary_name,
             'daysLeft', ((e.data ->> v_primary_name)::date - current_date)
           )
           order by ((e.data ->> v_primary_name)::date - current_date) asc
         )
    into v_items
    from public.entries e
   where not e.deleted
     and e.data ? v_primary_name
     and (e.data ->> v_primary_name) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     and ((e.data ->> v_primary_name)::date - current_date) <= v_window;

  v_items := coalesce(v_items, '[]'::jsonb);

  for v_recipient in
    select trim(both '"' from recipient::text)
      from jsonb_array_elements(v_recipients) as recipient
     where jsonb_typeof(recipient) = 'string'
  loop
    insert into public.email_outbox (kind, dedupe_key, recipient, payload)
    values (
      'expiry_digest',
      'expiry_digest:' || v_recipient || ':' || to_char(current_date, 'YYYY-MM-DD'),
      v_recipient,
      jsonb_build_object('entries', v_items, 'date', to_char(current_date, 'YYYY-MM-DD'))
    )
    on conflict (kind, dedupe_key) do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.enqueue_expiry_digest() from public, anon, authenticated;
grant execute on function public.enqueue_expiry_digest() to service_role;
revoke execute on function public.digest_row_label(jsonb) from public, anon, authenticated;
grant execute on function public.digest_row_label(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- §5 — scheduled delivery (pg_cron + pg_net → POST send-email every minute;
--        digest enqueued daily at 07:00 server time)
--
-- FREE-TIER POSTURE: these extensions ship on Supabase free tiers but a
-- FREE project may be PAUSED after inactivity — then cron simply stops;
-- email stops with it; nothing else degrades. If either extension is
-- unavailable the migration/skips cleanly with a NOTICE.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'dks-email-outbox-tick',
      '* * * * *',
      $cron$
      select net.http_post(
        url := (select value #>> '{}' from public.settings where key = 'email_worker_url'),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-dks-trigger-key', (select value #>> '{}' from public.settings where key = 'email_trigger_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 15000
      );
      $cron$
    );
    raise notice 'scheduled dks-email-outbox-tick (needs email_worker_url settings row; see deploy docs)';
  else
    raise notice 'pg_cron unavailable — scheduled email delivery disabled (free-tier posture documented)';
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'dks-expiry-digest-daily',
      '0 7 * * *',
      $cron$
      perform public.enqueue_expiry_digest();
      $cron$
    );
    raise notice 'scheduled dks-expiry-digest-daily';
  end if;
exception when others then
  raise notice 'email schedule install skipped: %', sqlerrm;
end $$;

-- job URL: NONE by default (worker only fires when the operator sets it).
-- settings.value is jsonb: the URL must be a JSON string literal, not bare
-- text (a bare URL makes the whole migration ERROR out and ROLL BACK).
insert into public.settings (key, value)
values ('email_worker_url', to_jsonb('https://<PROJECT_REF>.functions.supabase.co/send-email'::text))
on conflict (key) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- §6 — READ-ONLY VERIFICATION
-- ---------------------------------------------------------------------------
-- select 'outbox' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='email_outbox');
-- select 'dedupe_unique' as check_, count(*) from pg_indexes where schemaname='public' and indexname='email_outbox_kind_dedupe_uq';
-- select 'claim_granted_to_service' as check_,
--   has_function_privilege('service_role', 'public.claim_email_outbox(integer)', 'execute');
-- select 'enqueue_scheduled' as check_, count(*) from cron.job where jobname in ('dks-email-outbox-tick','dks-expiry-digest-daily');
-- select 'trigger_key_private' as check_,
--   exists (select 1 from public.settings where key='email_trigger_key');
