-- ============================================================================
-- DKS — Full Passport / Civil ID values in the emailed expiry PDF (default ON)
-- ============================================================================
--
-- PURPOSE (owner decision, 2026-10-27)
--   The daily expiry digest PDF is addressed to the ADMIN mailbox only (the
--   Office cannot read that mailbox), and the Admin must be able to phone the
--   customer from the email alone. Full Passport / Civil ID values in the PDF
--   are therefore the DEFAULT; masking is now an explicit opt-out.
--
-- WHAT CHANGES (additive, idempotent — review before running):
--   1. settings.email_notifications.include_full_ids is set to TRUE, preserving
--      every other key in that JSON object. If the row is missing it is
--      created with the documented defaults and include_full_ids = true.
--   2. public.enqueue_expiry_digest() is re-created with the SAME body as
--      supabase/schema.sql, so its fallback is `coalesce(..., true)`; a missing
--      key can no longer silently mask identifiers.
--   3. Service-role-only execute grants are re-applied.
--
-- WHAT DOES NOT CHANGE
--   - No table, column, index, trigger, cron schedule or RLS policy is created,
--     altered or dropped. The Office approval email is untouched.
--   - The digest window (30 days, Asia/Muscat), ordering, dedupe key, the
--     200-row cap, the claim/complete RPCs and the retry limits are unchanged.
--   - The HTML / plain-text email body still NEVER carries an identifier; only
--     the in-memory PDF attachment does, and only to the Admin.
--   - Nothing is written to disk, Storage, or a database blob: the PDF stays in
--     memory and rides the Resend attachment.
--
-- ORDER: run this AFTER ARENA/sql/expiry-digest-report.sql (which introduces
-- the key) on an existing deployment. Running it again is safe.
--
-- DO NOT RUN BEFORE REVIEW: §0 is SELECT-only.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- §0 — READ-ONLY PREFLIGHT (safe to run standalone)
-- ---------------------------------------------------------------------------
-- select 'email_prefs_row' as check_, count(*) as rows
--   from public.settings where key = 'email_notifications';
-- select 'current_value' as check_, value
--   from public.settings where key = 'email_notifications';
-- select 'digest_fn_present' as check_, count(*)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'enqueue_expiry_digest';
-- select 'pending_outbox_preserved' as check_, count(*)
--   from public.email_outbox where status = 'pending';

-- ---------------------------------------------------------------------------
-- §1 — Full identifiers are the default
-- ---------------------------------------------------------------------------
-- Set the key on an existing row without touching any other preference.
update public.settings
   set value = case
     when jsonb_typeof(value) = 'object' then value || jsonb_build_object('include_full_ids', true)
     else jsonb_build_object('include_full_ids', true)
   end,
       updated_at = now()
 where key = 'email_notifications';

-- Create the row with the documented defaults when the deployment never had it.
insert into public.settings (key, value)
values ('email_notifications', jsonb_build_object(
  'enabled', false,
  'admin_email', null,
  'expiry_digest_enabled', false,
  'expiry_recipients', jsonb_build_array(),
  'include_full_ids', true
))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- §2 — Digest builder: full values by default (body identical to schema.sql)
-- ---------------------------------------------------------------------------

-- Daily digest builder: one email per recipient per Asia/Muscat day, 30-day
-- window, ordered expired-first → today → upcoming 1..30.
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

  -- Full identifiers are the default (Admin-only PDF); only an explicit
  -- false in Settings -> Notifications masks them.
  v_include_full := coalesce((v_prefs ->> 'include_full_ids')::boolean, true);

  select ac.id::text, ac.name
    into v_primary_id, v_primary_name
    from public.app_columns ac
   where ac.is_primary_expiry and not ac.deleted and ac.visible
   limit 1;

  if v_primary_id is null then
    return 0;
  end if;

  v_muscat_today := (now() at time zone 'Asia/Muscat')::date;

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

commit;

-- ---------------------------------------------------------------------------
-- §3 — READ-ONLY VERIFICATION
-- ---------------------------------------------------------------------------
-- select 'include_full_ids_on' as check_,
--        coalesce((value ->> 'include_full_ids')::boolean, null) as include_full_ids,
--        value ->> 'expiry_digest_enabled' as digest_enabled,
--        value -> 'expiry_recipients' as recipients
--   from public.settings where key = 'email_notifications';
-- -- Expect include_full_ids = true and every other preference unchanged.
-- select 'digest_fn_default_true' as check_,
--        pg_get_functiondef(p.oid) ~ 'include_full_ids.{0,30}true' as full_by_default
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'enqueue_expiry_digest';
-- -- Expect full_by_default = true.
-- select 'cron_unchanged' as check_, jobname, schedule
--   from cron.job where jobname in ('dks-email-outbox-tick', 'dks-expiry-digest-daily');
-- select 'pending_outbox_preserved' as check_, count(*)
--   from public.email_outbox where status = 'pending';
-- ---------------------------------------------------------------------------
