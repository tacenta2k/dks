-- ============================================================================
-- DKS — Office sign-in requires Admin approval  (MIGRATION v1)
-- ============================================================================
--
-- WHAT THIS CHANGES (review before running — additive, non-destructive):
--
--  1. NEW table public.office_signin_requests — one row per (Office user,
--     authenticated Auth session); status pending → approved / denied, and
--     approved → revoked (admin actions via RPCs only).
--  2. NEW SECURITY DEFINER functions:
--       request_office_signin()   — Office: create/refresh own pending request
--       my_office_signin()        — Office: read own latest request row
--       decide_office_signin()    — Admin: approve or deny
--       revoke_office_signin()    — Admin: revoke a granted approval
--       office_session_is_approved() — the approval check used by RLS + RPCs
--  3. RLS POLICIES REPLACED (dropped + recreated, same names) on:
--       entries, app_columns, renewals, audit_log, settings,
--       alert_snoozes, sync_sessions
--     Office clauses now require office_session_is_approved() in addition to
--     the role check. Admin behaviour is byte-for-byte unchanged.
--     profiles is untouched (an Office user must still read its OWN profile —
--     that is the minimum information needed to sign in and sign out).
--  4. OFFICE-CALLABLE SECURITY DEFINER RPCs hardened: renew_entry,
--     office_delete_empty_column, column_is_empty now refuse unapproved
--     Office sessions with SQLSTATE 42501 (Admin paths unchanged).
--  5. NEW trigger office_signin_requests_notify_admin mirrors the existing
--     Office-delete pattern: an Admin-only admin_notifications row on every
--     new pending request (no staff identity — the Office account is shared).
--  6. §5c REPAIRS write_audit_log(): nested scalar guards so the shared audit
--     trigger no longer dereferences OLD.deleted when it fires on a table
--     without a "deleted" column (the crash that broke this migration's
--     sign-in flow on databases created from the original schema.sql).
--
-- SECURITY MODEL:
--  - Approval is bound to the SIGNED JWT's `session_id` claim
--    (auth.sessions.id) — never to a device id, email, localStorage flag or
--    any client-supplied identifier. Every check is evaluated server-side
--    from auth.jwt(), so a browser/Electron renderer cannot spoof it.
--  - Revocation flips status to 'revoked': RLS is re-evaluated per query, so
--    EVERY subsequent online request fails immediately.
--  - Nothing in this file permits a request to read/write rows that v didn't
--    already have: it can only tighten access.
--
-- KNOWN PRECONDITION:
--  - The Supabase Auth (GoTrue v2+) JWT must carry the `session_id` claim.
--    New projects do; if yours doesn't, request_office_signin() raises a
--    clear SQLSTATE 42501 error instead of locking ANYONE in (see the
--    function body and the verification query in §6).
--
-- DO NOT RUN ON A LIVE DATABASE BEFORE REVIEW: run §0 (preflight, read-only)
-- first, then §1–§5 in order, then §6 (verification, read-only).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- §0 — READ-ONLY PREFLIGHT (copy-paste into the SQL editor first; every
-- statement below is SELECT-only and safe to run standalone)
-- ---------------------------------------------------------------------------
-- select 'profiles' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='profiles');
-- select 'already_migrated' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='office_signin_requests');
-- select 'entries_policies' as check_, count(*) from pg_policies where schemaname='public' and tablename='entries';
-- select 'is_admin_fn' as check_, count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public' and p.proname='is_admin';
-- select 'unexpected_type' as check_, count(*) from public.app_columns
--   where type not in ('text','number','phone','email','price','date_start','date_expiry','dropdown','checkbox','notes');
--
-- Expect: profiles=true, already_migrated=false, entries_policies>0,
-- is_admin_fn=1, unexpected_type=0. Stop and review if any step fails.

-- ---------------------------------------------------------------------------
-- §1 — approval-request table (new; nothing existing is touched)
-- ---------------------------------------------------------------------------
create table if not exists public.office_signin_requests (
  id uuid primary key default gen_random_uuid(),

  -- Who's asking (the shared Office Supabase user) — never client supplied.
  user_id uuid not null
    references public.profiles(id) on delete cascade,

  -- THE BINDING: the signed auth session (auth.sessions.id) the request was
  -- opened from. Written server-side from auth.jwt() only.
  auth_session_id uuid not null,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'revoked')),

  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,

  -- Optional admin-set expiry of the GRANT (null = tied to the auth session
  -- itself, which is the default and most conservative binding).
  expires_at timestamptz,

  updated_at timestamptz not null default now(),

  -- One row per (user, session). A new request for a denied/revoked session
  -- reuses the same row (see request_office_signin), so the row doubles as
  -- the session's audit trail over its lifecycle.
  unique (user_id, auth_session_id)
);

create index if not exists office_signin_requests_status_idx
  on public.office_signin_requests (status, requested_at desc);

alter table public.office_signin_requests enable row level security;

-- SELECT: a user may see ONLY its own requests; Admin sees everything.
-- Nothing else (insert/update/delete) is exposed to the client: ALL writes
-- flow through SECURITY DEFINER RPCs below so auth_session_id can never be
-- spoofed from the renderer.
drop policy if exists office_signin_requests_select_own_or_admin on public.office_signin_requests;
create policy office_signin_requests_select_own_or_admin
  on public.office_signin_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Deny direct client writes by NOT granting them:
revoke insert, update, delete on public.office_signin_requests from authenticated;
revoke insert, update, delete on public.office_signin_requests from anon;
grant select on public.office_signin_requests to authenticated;

-- ---------------------------------------------------------------------------
-- §2 — the approval check used by every policy + RPC
-- ---------------------------------------------------------------------------

-- TRUE when the caller is admin, or an office user whose CURRENT signed
-- session carries an approved, unexpired, un-revoked request row.
create or replace function public.office_session_is_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.is_admin() then true
      when not public.is_office() then false
      else exists (
        select 1
        from public.office_signin_requests r
        where r.user_id = auth.uid()
          and r.auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
          and r.status = 'approved'
          and (r.expires_at is null or r.expires_at > now())
      )
    end;
$$;

comment on function public.office_session_is_approved()
  is 'Admin always true; Office true only when this signed session has an approved, live grant.';

-- ---------------------------------------------------------------------------
-- §3 — RPCs (all SECURITY DEFINER; the client never touches the table)
-- ---------------------------------------------------------------------------

-- Office: open (or re-open) the pending request for THIS signed session.
-- Returns the CURRENT row in every case so the client can fall through to
-- its status — an already-approved session short-circuits to 'approved'.
create or replace function public.request_office_signin()
returns public.office_signin_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid;
  v_row public.office_signin_requests%rowtype;
begin
  if v_uid is null or not public.is_office() then
    raise exception 'Only Office users may request sign-in approval'
      using errcode = '42501';
  end if;

  v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_session is null then
    raise exception 'This Supabase Auth session does not carry a signed session_id claim; upgrade Supabase Auth or sign in again. Session-specific approval cannot be verified.'
      using errcode = '42501';
  end if;

  select * into v_row
    from public.office_signin_requests
   where user_id = v_uid
     and auth_session_id = v_session
   for update;

  if found then
    -- Re-request after denial/revocation: start a fresh pending round on the
    -- same row (the row keeps one signed binding per session).
    if v_row.status in ('denied', 'revoked') then
      update public.office_signin_requests
         set status = 'pending',
             requested_at = now(),
             decided_at = null,
             decided_by = null,
             expires_at = null,
             updated_at = now()
       where id = v_row.id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  insert into public.office_signin_requests (user_id, auth_session_id)
  values (v_uid, v_session)
  returning * into v_row;

  return v_row;
end;
$$;

-- Office: read the status of THIS signed session's request (polling + restart).
create or replace function public.my_office_signin()
returns public.office_signin_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.office_signin_requests%rowtype;
  v_session uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_session is null then
    return null;
  end if;

  select * into v_row
    from public.office_signin_requests
   where user_id = auth.uid()
     and auth_session_id = v_session;

  return v_row;
end;
$$;

-- Admin: approve or deny.
create or replace function public.decide_office_signin(p_request_id uuid, p_decision text)
returns public.office_signin_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.office_signin_requests%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only administrators may decide Office sign-in requests'
      using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'denied') then
    raise exception 'Decision must be approved or denied' using errcode = '22023';
  end if;

  select * into v_row
    from public.office_signin_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'Request not found' using errcode = '22023';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'Request is not pending anymore' using errcode = '22023';
  end if;

  update public.office_signin_requests
     set status = p_decision,
         decided_at = now(),
         decided_by = auth.uid(),
         updated_at = now()
   where id = p_request_id
  returning * into v_row;

  return v_row;
end;
$$;

-- Admin: revoke a granted approval (immediate server-side effect via RLS).
create or replace function public.revoke_office_signin(p_request_id uuid)
returns public.office_signin_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.office_signin_requests%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only administrators may revoke Office sessions'
      using errcode = '42501';
  end if;

  select * into v_row
    from public.office_signin_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'Request not found' using errcode = '22023';
  end if;

  if v_row.status <> 'approved' then
    raise exception 'Only an approved session can be revoked' using errcode = '22023';
  end if;

  update public.office_signin_requests
     set status = 'revoked',
         decided_at = now(),
         decided_by = auth.uid(),
         updated_at = now()
   where id = p_request_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.request_office_signin() to authenticated;
grant execute on function public.my_office_signin() to authenticated;
grant execute on function public.decide_office_signin(uuid, text) to authenticated;
grant execute on function public.revoke_office_signin(uuid) to authenticated;
grant execute on function public.office_session_is_approved() to authenticated;

-- ---------------------------------------------------------------------------
-- §4 — RLS rewrites: Office clauses now require the approved session
--        (always recreated with the SAME policy names; Admin parts identical)
-- ---------------------------------------------------------------------------

-- --- app_columns ---
drop policy if exists app_columns_select_authenticated on public.app_columns;
create policy app_columns_select_authenticated
  on public.app_columns for select to authenticated
  using (public.is_admin() or (not deleted and public.is_office() and public.office_session_is_approved()));

drop policy if exists app_columns_insert_authenticated on public.app_columns;
create policy app_columns_insert_authenticated
  on public.app_columns for insert to authenticated
  with check (
    (public.is_admin() or (public.is_office() and public.office_session_is_approved()))
    and created_by = auth.uid()
  );

drop policy if exists app_columns_update_authenticated on public.app_columns;
create policy app_columns_update_authenticated
  on public.app_columns for update to authenticated
  using (public.is_admin() or (public.is_office() and public.office_session_is_approved() and not deleted))
  with check (
    public.is_admin()
    or (
      public.is_office()
      and public.office_session_is_approved()
      and (
        (not deleted and deleted_at is null)
        or (deleted and deleted_at is not null)
      )
    )
  );

-- app_columns_delete_admin: unchanged (admin-only).

-- --- entries ---
drop policy if exists entries_select_authenticated on public.entries;
create policy entries_select_authenticated
  on public.entries for select to authenticated
  using (public.is_admin() or (not deleted and public.is_office() and public.office_session_is_approved()));

drop policy if exists entries_insert_authenticated on public.entries;
create policy entries_insert_authenticated
  on public.entries for insert to authenticated
  with check (
    auth.uid() is not null
    and (public.is_admin() or (public.is_office() and public.office_session_is_approved()))
    and created_by = auth.uid()
    and deleted is false
    and deleted_at is null
    and deleted_by is null
  );

drop policy if exists entries_update_authenticated on public.entries;
create policy entries_update_authenticated
  on public.entries for update to authenticated
  using (
    public.is_admin()
    or (public.is_office() and public.office_session_is_approved() and deleted is false)
  )
  with check (
    public.is_admin()
    or (
      public.is_office()
      and public.office_session_is_approved()
      and (
        (deleted is false and deleted_at is null and deleted_by is null)
        or (deleted is true and deleted_at is not null and (deleted_by is null or deleted_by = auth.uid()))
      )
    )
  );

-- entries_delete_admin: unchanged (admin-only).

-- --- renewals ---
drop policy if exists renewals_select_authenticated on public.renewals;
create policy renewals_select_authenticated
  on public.renewals for select to authenticated
  using (
    public.is_admin()
    or (
      public.is_office()
      and public.office_session_is_approved()
      and exists (
        select 1 from public.entries e
        where e.id = entry_id and not e.deleted
      )
    )
  );
-- renewals writes happen only via renew_entry (security definer) — guarded below.

-- --- audit_log ---
-- office may insert its own actions (POST-edit/commit side-effects); gate it.
-- The original actor constraint (actor = auth.uid() or actor is null) is
-- PRESERVED — attribution can never be forged through a direct insert.
drop policy if exists audit_log_insert_authenticated on public.audit_log;
create policy audit_log_insert_authenticated
  on public.audit_log for insert to authenticated
  with check (
    (actor = auth.uid() or actor is null)
    and (public.is_admin() or (public.is_office() and public.office_session_is_approved()))
  );
-- audit_log select: unchanged (admin-only).

-- --- settings (workspace configuration, e.g. thresholds + email prefs) ---
drop policy if exists settings_select_authenticated on public.settings;
create policy settings_select_authenticated
  on public.settings for select to authenticated
  using (public.is_admin() or (public.is_office() and public.office_session_is_approved()));
-- settings insert/update/delete: unchanged (admin-only).

-- --- alert_snoozes (own rows; customer alert visibility) ---
drop policy if exists alert_snoozes_select_authenticated on public.alert_snoozes;
create policy alert_snoozes_select_authenticated
  on public.alert_snoozes for select to authenticated
  using (user_id = auth.uid() and public.office_session_is_approved() or public.is_admin());

drop policy if exists alert_snoozes_insert_authenticated on public.alert_snoozes;
create policy alert_snoozes_insert_authenticated
  on public.alert_snoozes for insert to authenticated
  with check (
    (user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin()
  );

drop policy if exists alert_snoozes_update_authenticated on public.alert_snoozes;
create policy alert_snoozes_update_authenticated
  on public.alert_snoozes for update to authenticated
  using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin())
  with check ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists alert_snoozes_delete_authenticated on public.alert_snoozes;
create policy alert_snoozes_delete_authenticated
  on public.alert_snoozes for delete to authenticated
  using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

-- --- sync_sessions (operational; customer-data-adjacent sync state) ---
drop policy if exists sync_sessions_select_authenticated on public.sync_sessions;
create policy sync_sessions_select_authenticated
  on public.sync_sessions for select to authenticated
  using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists sync_sessions_insert_authenticated on public.sync_sessions;
create policy sync_sessions_insert_authenticated
  on public.sync_sessions for insert to authenticated
  with check ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists sync_sessions_update_authenticated on public.sync_sessions;
create policy sync_sessions_update_authenticated
  on public.sync_sessions for update to authenticated
  using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin())
  with check ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists sync_sessions_delete_authenticated on public.sync_sessions;
create policy sync_sessions_delete_authenticated
  on public.sync_sessions for delete to authenticated
  using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

-- ---------------------------------------------------------------------------
-- §5 — office-callable SECURITY DEFINER RPC hardening
--        (REPLACE bodies of the office paths; admin paths unchanged)
-- ---------------------------------------------------------------------------

-- renew_entry: TWO-LINE policy change inside the ORIGINAL body — the office
-- branch gains `and public.office_session_is_approved()`; every other line
-- (errcodes, guards, snapshot insert) is byte-identical to schema.sql v1.
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

-- office_delete_empty_column: TWO-LINE change inside the ORIGINAL body — the
-- office branch gains the approval check; admin keeps working unchanged,
-- primary-expiry guard and the office empty-column check survive verbatim.
create or replace function public.office_delete_empty_column(p_column_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  column_row public.app_columns%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not public.is_admin() and not (public.is_office() and public.office_session_is_approved()) then
    raise exception 'Only office users with an approved session or administrators may delete columns'
      using errcode = '42501';
  end if;

  select *
    into column_row
    from public.app_columns
   where id = p_column_id
     and not deleted
   for update;

  if not found then
    raise exception 'Column does not exist' using errcode = '22023';
  end if;

  if column_row.is_primary_expiry then
    raise exception 'The primary expiry column cannot be deleted'
      using errcode = '42501';
  end if;

  if public.is_office() and not public.column_is_empty(p_column_id) then
    raise exception 'Office users may only delete empty columns'
      using errcode = '23514';
  end if;

  update public.app_columns
     set deleted = true,
         visible = false,
         deleted_at = now(),
         updated_at = now()
   where id = p_column_id;

  return true;
end;
$$;

-- column_is_empty: read-only helper; office callers must hold an approved
-- session. (Admin and approved-Office behaviour otherwise unchanged.)
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

  return not exists (
    select 1
      from public.entries
     where not deleted
       and nullif(trim(data ->> column_name), '') is not null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- §5b — Admin notification on new pending request (mirrors the existing
--        Office-delete notification trigger; shared Office account, so the
--        message never identifies an individual staff member)
-- ---------------------------------------------------------------------------
create or replace function public.office_signin_request_notify_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_notifications (type, message, payload, read, entry_id)
  values (
    'office_signin_request',
    'Office sign-in request — pending approval since ' || to_char(new.requested_at, 'YYYY-MM-DD HH24:MI'),
    jsonb_build_object(
      'request_id', new.id,
      'requested_at', new.requested_at,
      'user_id', new.user_id
    ),
    false,
    null
  );
  return new;
end;
$$;

drop trigger if exists office_signin_requests_notify_admin on public.office_signin_requests;
create trigger office_signin_requests_notify_admin
after insert on public.office_signin_requests
for each row execute function public.office_signin_request_notify_admin();

-- ---------------------------------------------------------------------------
-- §5c — REPAIR public.write_audit_log() (latent bug, any table without a
--        "deleted" column)
--
-- Root cause of the sign-in failure "Cannot verify sign-in approval —
-- record "old" has no field "deleted"":
--   The shared audit trigger ran for EVERY insert into admin_notifications
--   (including the new sign-in notification above), and its entries
--   soft-delete branch evaluated
--     if tg_table_name = 'entries' and tg_op = 'UPDATE' and old.deleted ...
--   as ONE expression. plpgsql dereferences record fields while evaluating
--   it, so OLD.deleted was read even though TG_TABLE_NAME was
--   'admin_notifications' — a table with no "deleted" column. The insert
--   (and therefore request_office_signin) always failed.
-- Fix: nest the field dereferences behind a scalar-only outer IF so they are
-- only evaluated for real entries UPDATEs. Behaviour is otherwise unchanged.
-- (The same repair ships standalone in ARENA/sql/office-approval-fix.sql for
-- databases that already applied an earlier revision of this migration.)
-- ---------------------------------------------------------------------------
create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  audit_entry_id uuid;
  before_snapshot jsonb;
  after_snapshot jsonb;
  row_snapshot jsonb;
  row_label text;
begin
  if tg_op = 'DELETE' then
    row_snapshot := to_jsonb(old);
    before_snapshot := row_snapshot;
    after_snapshot := null;
  else
    row_snapshot := to_jsonb(new);
    before_snapshot := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
    after_snapshot := row_snapshot;
  end if;

  if tg_table_name = 'entries' and tg_op <> 'DELETE' then
    audit_entry_id := new.id;
  elsif tg_table_name = 'renewals' then
    audit_entry_id := new.entry_id;
  elsif tg_table_name = 'admin_notifications' then
    if tg_op = 'DELETE' then
      audit_entry_id := old.entry_id;
    else
      audit_entry_id := new.entry_id;
    end if;
  else
    audit_entry_id := null;
  end if;

  insert into public.audit_log (actor, entry_id, action, snapshot, details)
  values (
    auth.uid(),
    audit_entry_id,
    lower(tg_op),
    jsonb_build_object('before', before_snapshot, 'after', after_snapshot),
    jsonb_build_object(
      'table', tg_table_name,
      'record_id', coalesce(row_snapshot ->> 'id', 'unknown')
     )
   );

   -- Keep record-field dereferences inside this nested branch (scalar guard
   -- outside) — see the §5c header comment for the plpgsql failure mode.
   if tg_table_name = 'entries' and tg_op = 'UPDATE' then
     if old.deleted is false and new.deleted is true and public.is_office() then
       select coalesce(
         nullif(trim(new.data ->> 'Name'), ''),
         (
           select nullif(trim(new.data ->> c.name), '')
             from public.app_columns c
            where not c.deleted
              and c.type in ('text', 'notes')
            order by c.position
            limit 1
         ),
         new.id::text
       )
         into row_label;

       insert into public.admin_notifications (type, message, payload, read, entry_id)
       values (
         'delete',
         'Office deleted ' || row_label || ' on ' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
         jsonb_build_object(
           'entry_id', new.id,
           'row_label', row_label,
           'deleted_by', auth.uid()
         ),
         false,
         new.id
       );
     end if;
   end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- §6 — READ-ONLY VERIFICATION (run after the migration; SELECT-only)
-- ---------------------------------------------------------------------------
-- select 'table_exists' as check_, exists (select 1 from pg_tables where schemaname='public' and tablename='office_signin_requests');
-- select 'rls_enabled' as check_, count(*) from pg_tables where schemaname='public' and tablename='office_signin_requests' and rowsecurity;
-- select 'grants' as check_, grantee, privilege_type from information_schema.role_table_grants
--   where table_schema='public' and table_name='office_signin_requests';
-- select 'new_policy' as check_, count(*) from pg_policies where schemaname='public' and tablename='office_signin_requests';
-- select 'entries_select_has_gate' as check_, (qual like '%office_session_is_approved%')
--   from pg_policies where schemaname='public' and tablename='entries' and policyname='entries_select_authenticated';
--
-- Manual session-claim sanity check (only possible while signed in as the
-- user being approved — run in the SQL editor with that user's JWT or in a
-- SECURITY DEFINER helper):
--   select nullif(auth.jwt() ->> 'session_id', '')::uuid;
-- If this returns NULL, §2's request_office_signin() will refuse loudly
-- instead of locking anyone in.
