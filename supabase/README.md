# DKS STEP 3 — Supabase setup

`schema.sql` is the complete database deliverable. It creates the ten
application tables, exact Auth-linked profile seeds, the dynamic column and
entry contracts, renewal snapshots, audit records, role-safe RPCs, the
session-bound Office sign-in approval gate, indexes, authenticated grants, RLS
policies, timestamp/expiry/audit triggers, and the realtime
notification/settings surfaces. DKS does not use Supabase Storage;
data lives in these database tables and the desktop's local SQLite cache.

## Apply the schema

1. Create a Supabase project and open **Authentication → Users** (or use the
   project's approved Auth admin provisioning path).
2. Provision these two Auth users with the exact UUIDs shown below. Provision
   passwords through Supabase Auth; no password or service-role key belongs in
   this repository. If the Dashboard's create-user form does not allow a
   caller-supplied UUID, use an Auth provisioning workflow that does or use
   Auth records already created with these IDs.
   - `846536af-f3c6-47c1-8559-d13442c1490a` —
     `shahabasnavas123@gmail.com` — `admin`
   - `2a959122-d789-4f2e-8fdf-958260c2e3f9` —
     `amervisamedical1dks@gmail.com` — `office`
3. Open **SQL Editor**, copy `supabase/schema.sql`, and run the entire file as
   one script. If an older DKS deployment created the removed backup bucket,
   delete that bucket and its object policies once from the Storage dashboard
   before applying the current schema.
4. Run the verification queries below. Query 1 should report ten present and
   ten RLS-enabled public tables. Query 2 should return the two exact profile
   rows. Query 3 checks the exact column contracts, RPCs, and default settings.

## Migrations for an EXISTING deployment (side files in ARENA/sql/)

Fresh projects only ever need `schema.sql` above. An existing project gets the
newer surfaces from the reviewed migration scripts, IN THIS ORDER:

1. `ARENA/sql/office-approval.sql` — Office sign-in approval (table, RPCs,
   RLS rewrites, admin notification, plus the `write_audit_log` repair in §5c).
2. `ARENA/sql/office-approval-fix.sql` — ONLY if `office-approval.sql` was
   applied before the §5c repair existed (symptom: Office waiting screen shows
   "Cannot verify sign-in approval — record "old" has no field "deleted"").
   Safe to run more than once; otherwise skip it.
3. `ARENA/sql/civil-id-type.sql` — Civil ID column type (metadata-only CHECK
   relaxation).
4. `ARENA/sql/email-notifications.sql` — optional Resend email outbox +
   delivery log + triggers (+ pg_cron schedule when the extension is on).
   If an earlier revision failed with `invalid input syntax for type json`
   near `email_worker_url`, the whole file rolled back then — simply run the
   current revision end to end; every object in it is idempotent.
5. `ARENA/sql/sign-out-all-office-sessions.sql` — admin-only RPC behind
   Settings → Workspace → “Sign out all office sessions”. It revokes live
   Office approvals and deletes only Office Auth sessions/refresh tokens;
   the acting administrator and all business records are untouched.

Each script starts with a commented §0 preflight (SELECT-only) and ends with
verification queries. Run exactly one script at a time, as one batch, in the
order above.

The `profiles.id` foreign key points to `auth.users(id)` with `ON DELETE
CASCADE`. The Auth rows therefore must exist before the profile seed statements
run. The script updates the two profile roles/emails on a repeat run.

## Schema contract

- `profiles.id` is the Auth UUID; the only roles are `admin` and `office`.
- `app_columns` stores `name`, `type`, `options`, `position`, `visible`,
  `is_primary_expiry`, `is_passport`, `created_by`, `created_at`, and
  `updated_at`. `type` is constrained to `text`, `number`, `phone`, `email`,
  `price`, `date_start`, `date_expiry`, `dropdown`, `checkbox`, or `notes`;
  `options` defaults to `{}`.
- `entries.data` defaults to `{}`. `category` defaults to `Employee` and is
  constrained to `Employee`, `Family`, or `Client`. Entry deletion is soft for office users;
  only administrators can restore or permanently delete an entry.
- `renewals.snapshot` stores the entry JSON before `renew_entry` changes the
  primary expiry value. The RPC writes the snapshot and JSON update in one
  security-definer transaction.
- `audit_log` records `actor`, optional `entry_id`, `snapshot`, and `details`.
- `admin_notifications.id` is a bigint identity, with `type`, `message`,
  `payload`, and `read` fields.
- `settings` uses only `key`, `value`, and `updated_at` for its persisted
  configuration contract.
- `alert_snoozes` uses `user_id`, `snoozed_until`,
  `dismissed_until_expiry_change`, and `expiry_value` for per-entry alerts.
- `sync_sessions` uses `user_id`, `opened_at`, and `closed_at` for sync
  lifecycle state.
- `office_signin_requests` binds the Office sign-in approval gate to the
  signed Auth session (`auth_session_id` from the JWT `session_id` claim).
  Clients may only SELECT their own rows; status transitions
  (pending → approved/denied, approved → revoked) run through SECURITY
  DEFINER RPCs, and every Office RLS clause additionally requires
  `office_session_is_approved()` for the CURRENT session.

## Verification query 1 — table and RLS health

```sql
with required(name) as (
  values
    ('profiles'), ('app_columns'), ('entries'), ('renewals'), ('audit_log'),
    ('admin_notifications'), ('settings'), ('alert_snoozes'), ('sync_sessions'),
    ('office_signin_requests')
), present as (
  select c.relname as name, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
)
select
  (select count(*) from required) as expected_tables,
  (select count(*) from required r join present p using (name)) as present_tables,
  (select count(*) from required r join present p using (name)
    where p.relrowsecurity) as rls_enabled_tables,
  (select coalesce(string_agg(r.name, ', ' order by r.name), 'none')
     from required r left join present p using (name)
    where p.name is null) as missing_tables;
```

## Verification query 2 — exact profile seeds

```sql
select id, email, role
  from public.profiles
 where id in (
   '846536af-f3c6-47c1-8559-d13442c1490a'::uuid,
   '2a959122-d789-4f2e-8fdf-958260c2e3f9'::uuid
 )
 order by id;
```

Expected rows:

| id | email | role |
| --- | --- | --- |
| `2a959122-d789-4f2e-8fdf-958260c2e3f9` | `amervisamedical1dks@gmail.com` | `office` |
| `846536af-f3c6-47c1-8559-d13442c1490a` | `shahabasnavas123@gmail.com` | `admin` |

## Verification query 3 — exact columns, RPCs, and defaults

```sql
select table_name, column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public'
   and (
     (table_name = 'app_columns' and column_name in
       ('name', 'type', 'options', 'position', 'visible',
        'is_primary_expiry', 'is_passport', 'created_by', 'created_at', 'updated_at'))
     or (table_name = 'entries' and column_name in ('data', 'category'))
     or (table_name = 'renewals' and column_name = 'snapshot')
     or (table_name = 'audit_log' and column_name in
       ('actor', 'entry_id', 'snapshot', 'details'))
     or (table_name = 'admin_notifications' and column_name in
       ('id', 'type', 'message', 'payload', 'read'))
     or (table_name = 'settings' and column_name in ('key', 'value', 'updated_at'))
     or (table_name = 'alert_snoozes' and column_name in
       ('user_id', 'snoozed_until', 'dismissed_until_expiry_change', 'expiry_value'))
     or (table_name = 'sync_sessions' and column_name in
       ('user_id', 'opened_at', 'closed_at'))
   )
 order by table_name, ordinal_position;

select
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'is_admin', 'is_office', 'column_is_empty',
        'office_delete_empty_column', 'restore_entry',
        'permanently_delete_entry', 'renew_entry'
      )) as core_rpc_count,
  (select count(*) from public.settings
    where key in ('thresholds', 'notification_days', 'currency', 'theme'))
    as default_setting_count;
```

`core_rpc_count` must be `7`, and the default setting count must be `4` or
greater. No Storage bucket or object policy is part of the DKS schema.

## Role and safety behavior

- Both authenticated roles can read active columns and entries and can create
  or edit active entries. Office updates can only transition an active entry to
  a soft-deleted row owned by the current user; there is no office restore or
  permanent-delete policy.
- Administrators can inspect deleted rows, restore them through
  `restore_entry(uuid)`, and permanently delete them through
  `permanently_delete_entry(uuid)` (or the administrator DELETE policy).
- Office column deletion is available through
  `office_delete_empty_column(uuid)` only when no active entry contains a
  non-empty value. The trigger repeats the check for direct soft-delete
  attempts. A primary `date_expiry` column cannot be hidden, deleted, unset, or
  duplicated.
- `renew_entry(uuid, date)` validates the new date, writes the prior JSON to
  `renewals.snapshot`, and updates the configured primary expiry key in
  `entries.data`. All role helpers and mutating RPCs use `SECURITY DEFINER`
  with `SET search_path = public`; client calls still require `authenticated`.
- When an office soft-deletes an entry, the database creates an administrator
  notification with the message `Office deleted [row label] on [date/time]`.
  The notification is generated by a trigger and does not require a client-side
  service-role credential.

## Optional expiry digest function

`edge-functions/expiry-digest/index.ts` is a dependency-free Supabase Edge
Function skeleton. Deploy it with the Supabase CLI from the repository root:

```text
supabase functions deploy expiry-digest
supabase secrets set RESEND_API_KEY=<your-resend-key>
supabase secrets set RESEND_FROM_EMAIL="DKS <noreply@your-domain.example>"
supabase secrets set EXPIRY_DIGEST_TO=shahabasnavas123@gmail.com
```

The function accepts a `POST` JSON payload containing `to`, `subject`, `text`
or `html`, and optionally `entries`/`summary`. It returns `204` without a
network request when `RESEND_API_KEY` is missing. Do not put a Resend key in
this repository, the desktop `.env`, or the renderer bundle.

## Live-Supabase caveats

- This deliverable assumes the standard Supabase `auth`, `storage.buckets`,
  and `storage.objects` schemas. Enable Storage before running the script if it
  is disabled.
- The exact Auth UUIDs are part of the database contract. If those Auth users
  already exist with different email addresses, correct the Auth records
  first; do not substitute a different profile UUID.
- `create table if not exists` does not convert an older, already-deployed
  placeholder table. Back up production data and perform a reviewed migration
  (or use a fresh project) before applying this corrected contract.
- Supabase's service role bypasses RLS by design. The desktop client should use
  only the publishable key and the authenticated role.

## Email notifications — `send-email` Edge Function (optional)

Two kinds of server-side email ride the same queue (`public.email_outbox`),
populated by database triggers/functions (see `ARENA/sql/email-notifications.sql`):

- **Office sign-in request**: after an Office session opens a pending request,
  the qualifying trigger enqueues at most ONE email per request (dedupe key =
  request id) to the configured Admin email from `settings.email_notifications`.
- **Expiry digest**: `public.enqueue_expiry_digest()` enqueues at most ONE batch
  email per recipient per local-day (dedupe key = recipient + date).

Both are processed by a scheduled POST to this Edge Function, which claims rows
server-side (service-role only — a desktop client cannot drive the queue)
and delivers via Resend.

Deploy (links the function to THIS project — adjust `<PROJECT_REF>`):

```bash
supabase functions deploy send-email
# REQUIRED secrets — none of these may end up in the repo / app / installer:
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set RESEND_FROM_EMAIL="DKS <noreply@your-domain.example>"
# A random trigger key the DB cron uses to authorize scheduled calls:
supabase secrets set DKS_TRIGGER_KEY="$(openssl rand -hex 32)"
# The function's URL for the in-DB schedule (replace the placeholder in
# ARENA/sql/email-notifications.sql §5 or set the settings row manually):
supabase db execute -c "insert into public.settings (key, value) values \
  ('email_worker_url', to_jsonb('https://<PROJECT_REF>.functions.supabase.co/send-email')) \
  on conflict (key) do update set value = excluded.value;"
```

### Notes, free-tier posture, and privacy

- The Resend **onboarding sender (`@resend.dev`)** is test-only: the email
  MUST come from a Resend-verified domain once you want real delivery.
- Without `RESEND_API_KEY` the function returns a quiet no-op; the user
  experience never degrades (local Windows alerts keep working).
- By default emails NEVER include passport/Civil ID values.
- Email failure never blocks login, approval, or local saves — failed rows
  requeue up to 3 attempts and then stay `failed` with a sanitized detail.
- Free Supabase projects pause after ~7 days of inactivity: the in-DB cron
  then simply pauses with it; nothing else is affected.
