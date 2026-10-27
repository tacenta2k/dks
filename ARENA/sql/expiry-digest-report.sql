-- ============================================================================
-- DKS — Expiry digest report upgrade (HTML body + in-memory PDF attachment)
-- ============================================================================
--
-- PURPOSE
--   Rewrites public.enqueue_expiry_digest() so the daily digest carries the
--   data the upgraded email needs: every active, visible Visa Sheet column
--   (id, name, type, position, flags) plus each qualifying record's data, the
--   Asia/Muscat report date, and the Admin opt-in flag for full identifiers.
--
-- WHAT CHANGES (additive, non-destructive — review before running):
--   1. NEW helper public.dks_parse_iso_date(text) — strict ISO calendar parse
--      that returns NULL for missing/malformed/impossible dates instead of
--      raising (the old function cast straight to date and could abort).
--   2. public.enqueue_expiry_digest() REWRITTEN:
--        * window is a FIXED 30 days for this report (expired + today + 1..30);
--          the workspace notification_days setting is NOT consulted;
--        * "today" is the Asia/Muscat business date, not the server clock;
--        * dedupe key uses the Muscat date;
--        * primary expiry is read by COLUMN ID first, then column name (the
--          app writes entries.data keyed by column id — see report §3);
--        * payload carries columns + currency + includeFullIds + entries
--          (id/expiry/daysLeft/data) + totalQualifying + truncated.
--   3. settings.email_notifications gains 'include_full_ids' (default false).
--      An existing true value is PRESERVED — no preference is reset.
--   4. Revised service-role grants for the new/changed helpers.
--
-- WHAT DOES NOT CHANGE
--   - office_signin_request emails (unchanged: no attachment, no link).
--   - email_outbox / email_delivery_log tables, RLS, the unique dedupe index,
--     claim/complete RPCs, retry limits, and all existing settings rows.
--   - No pending outbox row is deleted or cleared. No Storage bucket.
--
-- KEYING CONTRACT (verified against the app)
--   entries.data is keyed by the column ID (a slug of the column name), e.g.
--   {"visa_expiry":"2026-11-01"}. The app reads `data[column.id] ??
--   data[column.name]`. This migration reads the primary expiry with the same
--   id-first fallback so legacy name-keyed rows still work.
--
-- DO NOT RUN BEFORE REVIEW: §0 preflight is SELECT-only.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- §0 — READ-ONLY PREFLIGHT (safe to run standalone)
-- ---------------------------------------------------------------------------
-- select 'outbox_present' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='email_outbox');
-- select 'digest_fn_old_window' as check_,
--   (select pg_get_functiondef(p.oid) ~* 'v_window' from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname='enqueue_expiry_digest') as uses_dynamic_window;
-- select 'primary_expiry_columns' as check_, count(*)
--   from public.app_columns where is_primary_expiry and not deleted and visible;
-- select 'email_prefs' as check_, value from public.settings where key='email_notifications';

-- Expect: outbox_present=true, primary_expiry_columns=1, email_prefs row present.

-- ---------------------------------------------------------------------------
-- §1 — strict ISO date helper
-- ---------------------------------------------------------------------------
create or replace function public.dks_parse_iso_date(value text)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if value is null or not (value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
    return null;
  end if;
  begin
    return value::date;
  exception when others then
    return null;
  end;
end;
$$;

revoke all on function public.dks_parse_iso_date(text) from public, anon, authenticated;
grant execute on function public.dks_parse_iso_date(text) to service_role;

-- ---------------------------------------------------------------------------
-- §2 — rewrite the daily digest builder
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_expiry_digest()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefs jsonb;
  v_recipients jsonb;
  v_primary_id text;
  v_primary_name text;
  v_muscat_today date;
  v_items jsonb := '[]'::jsonb;
  v_columns jsonb;
  v_currency jsonb;
  v_include_full boolean := false;
  v_recipient text;
  v_count integer := 0;
  v_total integer := 0;
  v_rows integer := 0;
  v_max integer := 200;
  -- One record variable for the qualifying-rows loop. Named `v_entry`, never
  -- a bare single letter: a single-letter name here collides with SQL table
  -- aliases (`from public.app_columns c`) and PL/pgSQL then resolves the
  -- alias reference against this unassigned record.
  v_entry record;
begin
  select value into v_prefs from public.settings where key = 'email_notifications';

  if coalesce((v_prefs ->> 'expiry_digest_enabled')::boolean, false) is not true then
    return 0;
  end if;

  v_recipients := coalesce(v_prefs -> 'expiry_recipients', '[]'::jsonb);
  if jsonb_typeof(v_recipients) <> 'array' or jsonb_array_length(v_recipients) = 0 then
    return 0;
  end if;

  -- Admin opt-in for full Passport / Civil ID values in the emailed PDF.
  -- Default OFF; an existing true is preserved by §3.
  v_include_full := coalesce((v_prefs ->> 'include_full_ids')::boolean, false);

  -- The LIVE primary expiry column. Read by id first (the app's keying), with
  -- the column name as a legacy fallback.
  select ac.id::text, ac.name
    into v_primary_id, v_primary_name
    from public.app_columns ac
   where ac.is_primary_expiry and not ac.deleted and ac.visible
   limit 1;

  if v_primary_id is null then
    return 0;
  end if;

  -- Business calendar: the report date is the Asia/Muscat calendar day.
  v_muscat_today := (now() at time zone 'Asia/Muscat')::date;

  -- Active, visible user columns in the workspace's saved order, with the
  -- sensitive flag computed from the REAL column metadata.
  select jsonb_agg(jsonb_build_object(
           'id', ac.id::text,
           'name', ac.name,
           'type', ac.type,
           'position', ac.position,
           'visible', ac.visible,
           'isPrimaryExpiry', ac.is_primary_expiry,
           'isPassport', ac.is_passport,
           'sensitive', (ac.type = 'civil_id' or ac.is_passport or ac.name ~* 'passport')
         ) order by ac.position, ac.id)
    into v_columns
    from public.app_columns ac
   where not ac.deleted and ac.visible;

  select value into v_currency from public.settings where key = 'currency';
  if v_currency is null or jsonb_typeof(v_currency) <> 'object' then
    v_currency := '{"code":"OMR","symbol":"ر.ع.","decimals":3}'::jsonb;
  end if;

  -- Qualifying records: active, primary expiry present and a real calendar
  -- date, and daysLeft <= 30 (expired, today, or expiring soon). Ordered
  -- expired-first (oldest expiry) → today → upcoming 1..30 ascending.
  for v_entry in
    select *
      from (
        select en.id,
               en.data,
               public.dks_parse_iso_date(
                 coalesce(en.data ->> v_primary_id, en.data ->> v_primary_name)
               ) as expiry_date
          from public.entries en
         where not en.deleted
       ) eligible
     where eligible.expiry_date is not null
       and eligible.expiry_date - v_muscat_today <= 30
     order by eligible.expiry_date asc, eligible.id asc
  loop
    v_rows := v_rows + 1;
    if v_rows <= v_max then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_entry.id::text,
        'expiry', to_char(v_entry.expiry_date, 'YYYY-MM-DD'),
        'daysLeft', v_entry.expiry_date - v_muscat_today,
        'data', v_entry.data
      ));
    end if;
  end loop;

  v_total := v_rows;

  for v_recipient in
    select trim(both '"' from rcpt::text)
      from jsonb_array_elements(v_recipients) as rcpt
     where jsonb_typeof(rcpt) = 'string'
  loop
    insert into public.email_outbox (kind, dedupe_key, recipient, payload)
    values (
      'expiry_digest',
      'expiry_digest:' || v_recipient || ':' || to_char(v_muscat_today, 'YYYY-MM-DD'),
      v_recipient,
      jsonb_build_object(
        'reportDate', to_char(v_muscat_today, 'YYYY-MM-DD'),
        'columns', coalesce(v_columns, '[]'::jsonb),
        'currency', v_currency,
        'includeFullIds', v_include_full,
        'entries', v_items,
        'totalQualifying', v_total,
        'truncated', v_total > v_max
      )
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

-- ---------------------------------------------------------------------------
-- §3 — Admin opt-in flag (additive; an existing true value is preserved)
-- ---------------------------------------------------------------------------
update public.settings
   set value = case
     when jsonb_typeof(value) = 'object' and value ? 'include_full_ids' then value
     when jsonb_typeof(value) = 'object'
       then value || jsonb_build_object('include_full_ids', false)
     else jsonb_build_object('include_full_ids', false)
   end,
       updated_at = now()
 where key = 'email_notifications';

insert into public.settings (key, value)
values ('email_notifications', jsonb_build_object(
  'enabled', false,
  'admin_email', null,
  'expiry_digest_enabled', false,
  'expiry_recipients', jsonb_build_array(),
  'include_full_ids', false
))
on conflict (key) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- §4 — READ-ONLY VERIFICATION
-- ---------------------------------------------------------------------------
-- select 'parse_helper' as check_,
--   public.dks_parse_iso_date('2026-11-01') as ok,
--   public.dks_parse_iso_date('2026-02-31') as impossible_is_null,
--   public.dks_parse_iso_date('not-a-date') as malformed_is_null;
-- select 'digest_uses_muscat' as check_,
--   pg_get_functiondef(p.oid) ~* 'Asia/Muscat' as yes,
--   pg_get_functiondef(p.oid) ~* 'notification_days' as no_dynamic_window
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='enqueue_expiry_digest';
-- select 'include_full_ids_default' as check_,
--   coalesce((value ->> 'include_full_ids')::boolean, false) as off_by_default
--   from public.settings where key='email_notifications';
-- select 'pending_outbox_preserved' as check_, count(*)
--   from public.email_outbox where status = 'pending';
