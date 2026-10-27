-- DKS STEP 3: Supabase schema
--
-- Apply this script to a Supabase project after creating the two Auth users
-- listed in the seed section below.  Auth owns passwords and sessions; this
-- file only creates the application profile rows and never stores a secret.
-- The script is intended to be run as one SQL Editor transaction on a fresh
-- project.  It is idempotent for objects owned by this deliverable.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role text not null default 'office' check (role in ('admin', 'office')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_columns (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null default 'text'
    check (type in (
      'text', 'number', 'phone', 'email', 'price',
      'date_start', 'date_expiry', 'dropdown', 'checkbox', 'notes',
      'civil_id'
    )),
  options jsonb not null default '{}'::jsonb,
  position integer not null default 0 check (position >= 0),
  visible boolean not null default true,
  is_primary_expiry boolean not null default false,
  is_passport boolean not null default false,
  created_by uuid not null default auth.uid()
    references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- These two lifecycle columns keep deleted column definitions recoverable.
  -- They do not change the public column-definition API above.
  deleted boolean not null default false,
  deleted_at timestamptz
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null default '{}'::jsonb,
  category text not null default 'Employee'
    check (category in ('Employee', 'Family', 'Client')),
  deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  last_renewed_at timestamptz,
  created_by uuid not null default auth.uid()
    references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete set null,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.renewals (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries(id) on delete cascade,
  old_expiry date,
  new_expiry date not null,
  snapshot jsonb not null default '{}'::jsonb,
  renewed_by uuid not null default auth.uid()
    references public.profiles(id) on delete restrict,
  renewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid references public.profiles(id) on delete set null,
  entry_id uuid references public.entries(id) on delete set null,
  action text not null,
  snapshot jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_notifications (
  id bigint generated always as identity primary key,
  type text not null default 'expiry',
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  entry_id uuid references public.entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.alert_snoozes (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  snoozed_until timestamptz not null,
  dismissed_until_expiry_change boolean not null default false,
  expiry_value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entry_id, user_id)
);

create table if not exists public.sync_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references public.profiles(id) on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per (Office user, signed Auth session) for the sign-in approval
-- gate. auth_session_id is written server-side from auth.jwt() only; clients
-- can SELECT their own rows, every write flows through SECURITY DEFINER RPCs.
create table if not exists public.office_signin_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  auth_session_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'revoked')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, auth_session_id)
);

create index if not exists office_signin_requests_status_idx
  on public.office_signin_requests (status, requested_at desc);

-- ---------------------------------------------------------------------------
-- Role helpers, timestamp/audit triggers, and guarded RPCs
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Both accounts may edit live rows.  The creator must not change afterwards,
-- and Office must never be able to restore a deleted row through an UPDATE.
create or replace function public.entries_keep_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- R3 batch G: attribution cannot be forged. auth.uid() is the caller's
-- authenticated account (also inside SECURITY DEFINER functions), so Office
-- cannot write updated_by = the admin's id and an admin restore is attributed
-- to the admin. When there is no JWT (SQL editor, service role) the value the
-- caller supplied is left untouched.
create or replace function public.entries_stamp_updated_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.guard_office_restore()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and public.is_office() then
    if old.deleted is true and new.deleted is false then
      raise exception 'Only administrators may restore entries'
        using errcode = '42501';
    end if;
    if old.deleted is true then
      raise exception 'Only administrators may update deleted entries'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and role = 'admin'
  );
$$;

create or replace function public.is_office()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and role = 'office'
  );
$$;

create or replace function public.guard_primary_expiry_column()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflicting_id uuid;
begin
  if tg_op = 'DELETE' then
    if old.is_primary_expiry then
      raise exception 'The primary expiry column cannot be deleted'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if public.is_office() then
    if tg_op = 'INSERT' and new.is_primary_expiry then
      raise exception 'Office users cannot change the primary expiry setting'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE'
       and new.is_primary_expiry is distinct from old.is_primary_expiry
    then
      raise exception 'Office users cannot change the primary expiry setting'
        using errcode = '42501';
    end if;
  end if;

  if new.is_primary_expiry and (new.deleted or not new.visible) then
    raise exception 'The primary expiry column must remain visible and active'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and old.is_primary_expiry then
    if not new.is_primary_expiry and not public.is_admin() then
      raise exception 'The primary expiry column cannot be unset'
        using errcode = '42501';
    end if;
    if new.name is distinct from old.name or new.type is distinct from old.type then
      raise exception 'The primary expiry column name and type cannot change'
        using errcode = '42501';
    end if;
  end if;

  if public.is_office()
     and tg_op = 'UPDATE'
     and not old.deleted
     and new.deleted
     and exists (
       select 1
         from public.entries
        where not deleted
          and nullif(trim(data ->> old.name), '') is not null
     )
  then
    raise exception 'Office users may only delete empty columns'
      using errcode = '23514';
  end if;

  if new.is_primary_expiry and new.type <> 'date_expiry' then
    raise exception 'The primary expiry column must have date_expiry type'
      using errcode = '23514';
  end if;

  if new.is_primary_expiry then
    select id
      into conflicting_id
      from public.app_columns
     where is_primary_expiry
       and not deleted
       and id <> new.id
     limit 1;

    if conflicting_id is not null then
      raise exception 'Only one primary expiry column is allowed'
        using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.guard_primary_expiry_value()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  primary_name text;
  expiry_value text;
begin
  select name
    into primary_name
    from public.app_columns
   where is_primary_expiry
     and not deleted
     and visible
   limit 1;

  if primary_name is null then
    return new;
  end if;

  expiry_value := nullif(trim(new.data ->> primary_name), '');
  if expiry_value is null then
    return new;
  end if;

  if expiry_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Primary expiry must be an ISO date (YYYY-MM-DD)'
      using errcode = '22007';
  end if;

  begin
    perform expiry_value::date;
  exception when others then
    raise exception 'Primary expiry must be a valid calendar date'
      using errcode = '22007';
  end;

  return new;
end;
$$;

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

  -- Do not retain a foreign key to an entry being permanently deleted.  For
  -- renewal and entry changes the entry remains available and is recorded.
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

   -- Record-field dereferences (old.deleted / new.deleted) MUST stay nested
   -- behind scalar-only guards: plpgsql dereferences record fields while
   -- evaluating an expression, so `tg_table_name = ... and old.deleted ...`
   -- in ONE combined condition crashes with
   --   record "old" has no field "deleted"
   -- whenever this shared audit trigger fires on a table that has no
   -- "deleted" column (admin_notifications, renewals, app_columns).
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

create or replace function public.restore_entry(p_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only administrators may restore entries'
      using errcode = '42501';
  end if;

  update public.entries
     set deleted = false,
         deleted_at = null,
         deleted_by = null,
         updated_by = auth.uid(),
         version = version + 1,
         updated_at = now()
   where id = p_entry_id
     and deleted;

  return found;
end;
$$;

create or replace function public.permanently_delete_entry(p_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only administrators may permanently delete entries'
      using errcode = '42501';
  end if;

  delete from public.entries
   where id = p_entry_id;

  return found;
end;
$$;

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

-- ---------------------------------------------------------------------------
-- Office sign-in approval (session-bound; RLS + RPCs gate Office access)
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

-- Office: open (or re-open) the pending request for THIS signed session.
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

-- Office: read the status of THIS signed session's request.
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

-- Admin: sign out every Office Auth session and revoke every live Office
-- approval. The acting administrator is not an Office profile and is
-- therefore untouched. Deleting auth.sessions prevents refresh-token use;
-- revoking the approval rows also makes any not-yet-expired access token
-- fail DKS's session-bound RLS immediately.
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

-- Admin notification on every new pending request (shared Office account —
-- the message never identifies an individual staff member).
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

-- ---------------------------------------------------------------------------
-- Indexes and triggers
-- ---------------------------------------------------------------------------

create unique index if not exists one_primary_expiry_column
  on public.app_columns (is_primary_expiry)
  where is_primary_expiry and not deleted;

create index if not exists app_columns_position_idx
  on public.app_columns (position)
  where not deleted;

create index if not exists entries_updated_at_idx
  on public.entries (updated_at desc);

create index if not exists entries_active_idx
  on public.entries (deleted, updated_at desc);

create index if not exists entries_category_idx
  on public.entries (category)
  where not deleted;

create index if not exists renewals_entry_id_idx
  on public.renewals (entry_id, renewed_at desc);

create index if not exists audit_log_created_at_idx
  on public.audit_log (created_at desc);

create index if not exists audit_log_entry_id_idx
  on public.audit_log (entry_id, created_at desc);

create index if not exists admin_notifications_unread_idx
  on public.admin_notifications (read, created_at desc)
  where not read;

create index if not exists alert_snoozes_entry_idx
  on public.alert_snoozes (entry_id, user_id, snoozed_until);

create index if not exists sync_sessions_user_idx
  on public.sync_sessions (user_id, updated_at desc);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists app_columns_set_updated_at on public.app_columns;
create trigger app_columns_set_updated_at
before update on public.app_columns
for each row execute function public.set_updated_at();

drop trigger if exists entries_set_updated_at on public.entries;
create trigger entries_set_updated_at
before update on public.entries
for each row execute function public.set_updated_at();

drop trigger if exists renewals_set_updated_at on public.renewals;
create trigger renewals_set_updated_at
before update on public.renewals
for each row execute function public.set_updated_at();

drop trigger if exists admin_notifications_set_updated_at on public.admin_notifications;
create trigger admin_notifications_set_updated_at
before update on public.admin_notifications
for each row execute function public.set_updated_at();

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
before update on public.settings
for each row execute function public.set_updated_at();

drop trigger if exists alert_snoozes_set_updated_at on public.alert_snoozes;
create trigger alert_snoozes_set_updated_at
before update on public.alert_snoozes
for each row execute function public.set_updated_at();

drop trigger if exists sync_sessions_set_updated_at on public.sync_sessions;
create trigger sync_sessions_set_updated_at
before update on public.sync_sessions
for each row execute function public.set_updated_at();

drop trigger if exists app_columns_primary_expiry_guard on public.app_columns;
create trigger app_columns_primary_expiry_guard
before insert or update or delete on public.app_columns
for each row execute function public.guard_primary_expiry_column();

drop trigger if exists entries_keep_created_by on public.entries;
create trigger entries_keep_created_by
before update on public.entries
for each row execute function public.entries_keep_created_by();

drop trigger if exists entries_stamp_updated_by on public.entries;
create trigger entries_stamp_updated_by
before update on public.entries
for each row execute function public.entries_stamp_updated_by();

drop trigger if exists entries_guard_office_restore on public.entries;
create trigger entries_guard_office_restore
before update on public.entries
for each row execute function public.guard_office_restore();

drop trigger if exists entries_primary_expiry_guard on public.entries;
create trigger entries_primary_expiry_guard
before insert or update on public.entries
for each row execute function public.guard_primary_expiry_value();

drop trigger if exists app_columns_audit on public.app_columns;
create trigger app_columns_audit
after insert or update or delete on public.app_columns
for each row execute function public.write_audit_log();

drop trigger if exists entries_audit on public.entries;
create trigger entries_audit
after insert or update or delete on public.entries
for each row execute function public.write_audit_log();

drop trigger if exists renewals_audit on public.renewals;
create trigger renewals_audit
after insert on public.renewals
for each row execute function public.write_audit_log();

drop trigger if exists admin_notifications_audit on public.admin_notifications;
create trigger admin_notifications_audit
after insert or update or delete on public.admin_notifications
for each row execute function public.write_audit_log();

drop trigger if exists office_signin_requests_notify_admin on public.office_signin_requests;
create trigger office_signin_requests_notify_admin
after insert on public.office_signin_requests
for each row execute function public.office_signin_request_notify_admin();

-- ---------------------------------------------------------------------------
-- Exact Auth-linked profile seeds and application defaults
-- ---------------------------------------------------------------------------

insert into public.profiles (id, email, role)
values
  (
    '846536af-f3c6-47c1-8559-d13442c1490a',
    'shahabasnavas123@gmail.com',
    'admin'
  ),
  (
    '2a959122-d789-4f2e-8fdf-958260c2e3f9',
    'amervisamedical1dks@gmail.com',
    'office'
  )
on conflict (id) do update
  set email = excluded.email,
      role = excluded.role,
      updated_at = now();

insert into public.settings (key, value)
values
  (
    'thresholds',
    '{"validAbove": 90, "expiringSoonFrom": 30, "urgentFrom": 1, "expiredAt": 0, "colors": {"Valid": "#2f9e72", "Expiring Soon": "#d6a72c", "Urgent": "#e87836", "Expired": "#d15b5b"}}'::jsonb
  ),
  ('notification_days', '[90, 60, 30, 15, 7, 1, 0]'::jsonb),
  ('daily_summary_enabled', 'true'::jsonb),
  ('currency', '{"code": "OMR", "symbol": "ر.ع.", "decimals": 3}'::jsonb),
  ('theme', '"light"'::jsonb),
  ('primary_expiry_column_id', '""'::jsonb)
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.app_columns enable row level security;
alter table public.entries enable row level security;
alter table public.renewals enable row level security;
alter table public.audit_log enable row level security;
alter table public.admin_notifications enable row level security;
alter table public.settings enable row level security;
alter table public.alert_snoozes enable row level security;
alter table public.sync_sessions enable row level security;
alter table public.office_signin_requests enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.app_columns,
  public.entries,
  public.renewals,
  public.audit_log,
  public.admin_notifications,
  public.settings,
  public.alert_snoozes,
  public.sync_sessions
to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Office sign-in requests: read-only for the client, writes only via the
-- SECURITY DEFINER RPCs above (auth_session_id can never be client-supplied).
grant select on public.office_signin_requests to authenticated;
revoke insert, update, delete on public.office_signin_requests from authenticated;

revoke all on public.profiles,
  public.app_columns,
  public.entries,
  public.renewals,
  public.audit_log,
  public.admin_notifications,
  public.settings,
  public.alert_snoozes,
  public.sync_sessions from anon;
revoke all on public.office_signin_requests from anon;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all functions in schema public from public;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_office() to authenticated;
grant execute on function public.column_is_empty(uuid) to authenticated;
grant execute on function public.office_delete_empty_column(uuid) to authenticated;
grant execute on function public.restore_entry(uuid) to authenticated;
grant execute on function public.permanently_delete_entry(uuid) to authenticated;
grant execute on function public.renew_entry(uuid, date) to authenticated;
grant execute on function public.office_session_is_approved() to authenticated;
grant execute on function public.request_office_signin() to authenticated;
grant execute on function public.my_office_signin() to authenticated;
grant execute on function public.decide_office_signin(uuid, text) to authenticated;
grant execute on function public.revoke_office_signin(uuid) to authenticated;
grant execute on function public.sign_out_all_office_sessions() to authenticated;

-- Profiles are readable by the signed-in user, while only administrators may
-- create, change, or remove profiles (and therefore roles).
drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert
on public.profiles for insert to authenticated
with check (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update
on public.profiles for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete
on public.profiles for delete to authenticated
using (public.is_admin());

-- A user may see ONLY its own sign-in requests; Admin sees everything.
-- All writes flow through the SECURITY DEFINER RPCs above.
drop policy if exists office_signin_requests_select_own_or_admin on public.office_signin_requests;
create policy office_signin_requests_select_own_or_admin
on public.office_signin_requests for select to authenticated
using (user_id = auth.uid() or public.is_admin());

-- Both roles may work with active column definitions.  Direct DELETE is an
-- administrator operation; office deletion goes through the empty-column RPC
-- and the trigger repeats the empty-column check for direct soft deletes.
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

drop policy if exists app_columns_delete_admin on public.app_columns;
create policy app_columns_delete_admin
on public.app_columns for delete to authenticated
using (public.is_admin());

-- Office users can create/edit active rows and mark an active row deleted.
-- The policy has no path from a deleted row back to active, and there is no
-- office DELETE policy.  Administrators have the restore and hard-delete path.
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

-- The UPDATE policy never tests created_by: either account may edit (or soft
-- delete) any live row, including rows created by the other account.  Office
-- cannot see or update an already-deleted row, so restoring stays an
-- administrator-only operation (restore_entry).  created_by is kept immutable
-- by the entries_keep_created_by trigger.
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

drop policy if exists entries_delete_admin on public.entries;
create policy entries_delete_admin
on public.entries for delete to authenticated
using (public.is_admin());

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
         and not e.deleted
    )
  )
);

-- Renewal writes are performed by renew_entry, which validates the role and
-- writes the immutable snapshot before updating the entry JSON.

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
on public.audit_log for select to authenticated
using (public.is_admin());

-- R3 batch B: app_columns.name is unique across the table (deleted columns
-- keep their name), and Office cannot SELECT a deleted row. The client asks
-- this read-only function which row owns a name before pushing a new column,
-- so a duplicate name is reconciled instead of failing the sync forever.
create or replace function public.resolve_duplicate_column(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in before resolving columns'
      using errcode = '42501';
  end if;

  if not (public.is_admin() or public.is_office()) then
    raise exception 'Only DKS accounts may resolve columns'
      using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    return null;
  end if;

  -- Read the row as jsonb so an optional/absent app_columns field cannot make
  -- the function fail at call time; prefer the live row, then the newest.
  select to_jsonb(c)
    into v_row
    from public.app_columns c
   where lower(btrim(c.name)) = lower(btrim(p_name))
   order by coalesce((to_jsonb(c) ->> 'deleted')::boolean, false) asc,
            coalesce((to_jsonb(c) ->> 'updated_at')::timestamptz, '-infinity'::timestamptz) desc
   limit 1;

  if v_row is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row -> 'id',
    'name', v_row ->> 'name',
    'type', coalesce(v_row ->> 'type', 'text'),
    'options', coalesce(v_row -> 'options', '{}'::jsonb),
    'position', coalesce((v_row ->> 'position')::integer, 0),
    'deleted', coalesce((v_row ->> 'deleted')::boolean, false),
    'deleted_at', v_row -> 'deleted_at',
    'is_primary_expiry', coalesce((v_row ->> 'is_primary_expiry')::boolean, false),
    'is_passport', coalesce((v_row ->> 'is_passport')::boolean, false),
    'updated_at', v_row -> 'updated_at'
  );
end;
$$;

revoke all on function public.resolve_duplicate_column(text) from public;
grant execute on function public.resolve_duplicate_column(text) to authenticated;

drop policy if exists audit_log_insert_authenticated on public.audit_log;
create policy audit_log_insert_authenticated
on public.audit_log for insert to authenticated
with check (
  (actor = auth.uid() or actor is null)
  and (public.is_admin() or (public.is_office() and public.office_session_is_approved()))
);

-- R2-10: clearing the audit log is an administrator-only operation.  There is
-- deliberately NO delete policy on public.audit_log; the only path is this
-- SECURITY DEFINER function, which re-checks the role server-side and leaves
-- exactly one entry describing the clear.
drop policy if exists audit_log_delete_admin on public.audit_log;
drop policy if exists audit_log_delete_authenticated on public.audit_log;

create or replace function public.clear_audit_log(p_message text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only administrators may clear the audit log'
      using errcode = '42501';
  end if;

  v_message := coalesce(
    nullif(btrim(p_message), ''),
    'Audit log cleared by Admin on '
      || to_char(now() at time zone 'Asia/Muscat', 'DD/MM/YYYY HH24:MI')
  );

  -- Scoped on purpose: an unfiltered DELETE is rejected by REST layers with
  -- "DELETE requires a WHERE clause" and hides intent. `id` is the identity
  -- primary key, so every row is still removed.
  delete from public.audit_log
   where id is not null;

  insert into public.audit_log (actor, entry_id, action, snapshot, details)
  values (
    auth.uid(),
    null,
    'clear_audit',
    '{}'::jsonb,
    jsonb_build_object('message', v_message)
  );
end;
$$;

revoke all on function public.clear_audit_log(text) from public;
grant execute on function public.clear_audit_log(text) to authenticated;

drop policy if exists admin_notifications_select_admin on public.admin_notifications;
create policy admin_notifications_select_admin
on public.admin_notifications for select to authenticated
using (public.is_admin());

drop policy if exists admin_notifications_insert_admin on public.admin_notifications;
create policy admin_notifications_insert_admin
on public.admin_notifications for insert to authenticated
with check (public.is_admin());

drop policy if exists admin_notifications_update_admin on public.admin_notifications;
create policy admin_notifications_update_admin
on public.admin_notifications for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists admin_notifications_delete_admin on public.admin_notifications;
create policy admin_notifications_delete_admin
on public.admin_notifications for delete to authenticated
using (public.is_admin());

drop policy if exists settings_select_authenticated on public.settings;
create policy settings_select_authenticated
on public.settings for select to authenticated
using (public.is_admin() or (public.is_office() and public.office_session_is_approved()));

drop policy if exists settings_insert_admin on public.settings;
create policy settings_insert_admin
on public.settings for insert to authenticated
with check (public.is_admin());

drop policy if exists settings_update_admin on public.settings;
create policy settings_update_admin
on public.settings for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists settings_delete_admin on public.settings;
create policy settings_delete_admin
on public.settings for delete to authenticated
using (public.is_admin());

drop policy if exists alert_snoozes_select_authenticated on public.alert_snoozes;
create policy alert_snoozes_select_authenticated
on public.alert_snoozes for select to authenticated
using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists alert_snoozes_insert_authenticated on public.alert_snoozes;
create policy alert_snoozes_insert_authenticated
on public.alert_snoozes for insert to authenticated
with check ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists alert_snoozes_update_authenticated on public.alert_snoozes;
create policy alert_snoozes_update_authenticated
on public.alert_snoozes for update to authenticated
using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin())
with check ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

drop policy if exists alert_snoozes_delete_authenticated on public.alert_snoozes;
create policy alert_snoozes_delete_authenticated
on public.alert_snoozes for delete to authenticated
using ((user_id = auth.uid() and public.office_session_is_approved()) or public.is_admin());

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

-- Realtime is used for cross-PC settings and administrator notifications.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'settings'
    ) then
      execute 'alter publication supabase_realtime add table public.settings';
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'admin_notifications'
    ) then
      execute 'alter publication supabase_realtime add table public.admin_notifications';
    end if;
  end if;
end;
$$;

-- ============================================================================
-- OPTIONAL EMAIL NOTIFICATIONS (Resend) — fresh-install surface
-- ============================================================================
--
-- The same surfaces live in ARENA/sql/email-notifications.sql (existing
-- deployments) and ARENA/sql/expiry-digest-report.sql (digest upgrade). They
-- are included here so a FRESH project gets the complete deliverable from one
-- script. Everything below is additive and idempotent; no existing object is
-- dropped. The Resend API key lives only in Edge Function secrets.
--
-- Privacy: the digest payload carries only column metadata + record data; the
-- Edge Function masks passport / Civil ID values by default and never logs
-- raw values. The PDF is generated in memory and never persisted.
-- ============================================================================

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

insert into public.settings (key, value)
values ('email_notifications', jsonb_build_object(
  'enabled', false,
  'admin_email', null,
  'expiry_digest_enabled', false,
  'expiry_recipients', jsonb_build_array(),
  'include_full_ids', false
))
on conflict (key) do nothing;

insert into public.settings (key, value)
values ('email_trigger_key', to_jsonb(gen_random_uuid()::text))
on conflict (key) do nothing;

-- One email per NEW pending Office sign-in request (dedupe key = request id).
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

  if coalesce((v_prefs ->> 'enabled')::boolean, false) is not true or v_admin_email is null then
    return new;
  end if;

  insert into public.email_outbox (kind, dedupe_key, recipient, payload)
  values (
    'office_signin_request',
    'office_signin_request:' || new.id::text,
    v_admin_email,
    jsonb_build_object('requestedAt', new.requested_at, 'adminEmail', v_admin_email)
  )
  on conflict (kind, dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists office_signin_requests_email_enqueue on public.office_signin_requests;
create trigger office_signin_requests_email_enqueue
after insert on public.office_signin_requests
for each row execute function public.office_signin_request_email_enqueue();

-- Service-role-only outbox claim/complete.
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

revoke execute on function public.claim_email_outbox(integer) from public, anon, authenticated;
revoke execute on function public.complete_email_outbox(uuid, boolean, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer) to service_role;
grant execute on function public.complete_email_outbox(uuid, boolean, text, text, integer) to service_role;

-- Strict ISO parse helper for the digest window.
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
  c record;
begin
  select value into v_prefs from public.settings where key = 'email_notifications';

  if coalesce((v_prefs ->> 'expiry_digest_enabled')::boolean, false) is not true then
    return 0;
  end if;

  v_recipients := coalesce(v_prefs -> 'expiry_recipients', '[]'::jsonb);
  if jsonb_typeof(v_recipients) <> 'array' or jsonb_array_length(v_recipients) = 0 then
    return 0;
  end if;

  v_include_full := coalesce((v_prefs ->> 'include_full_ids')::boolean, false);

  select c.id::text, c.name
    into v_primary_id, v_primary_name
    from public.app_columns c
   where c.is_primary_expiry and not c.deleted and c.visible
   limit 1;

  if v_primary_id is null then
    return 0;
  end if;

  v_muscat_today := (now() at time zone 'Asia/Muscat')::date;

  select jsonb_agg(jsonb_build_object(
           'id', c.id::text,
           'name', c.name,
           'type', c.type,
           'position', c.position,
           'visible', c.visible,
           'isPrimaryExpiry', c.is_primary_expiry,
           'isPassport', c.is_passport,
           'sensitive', (c.type = 'civil_id' or c.is_passport or c.name ~* 'passport')
         ) order by c.position, c.id)
    into v_columns
    from public.app_columns c
   where not c.deleted and c.visible;

  select value into v_currency from public.settings where key = 'currency';
  if v_currency is null or jsonb_typeof(v_currency) <> 'object' then
    v_currency := '{"code":"OMR","symbol":"ر.ع.","decimals":3}'::jsonb;
  end if;

  for c in
    select *
      from (
        select e.id,
               e.data,
               public.dks_parse_iso_date(
                 coalesce(e.data ->> v_primary_id, e.data ->> v_primary_name)
               ) as expiry_date
          from public.entries e
         where not e.deleted
       ) candidate
     where candidate.expiry_date is not null
       and candidate.expiry_date - v_muscat_today <= 30
     order by candidate.expiry_date asc, candidate.id asc
  loop
    v_rows := v_rows + 1;
    if v_rows <= v_max then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', c.id::text,
        'expiry', to_char(c.expiry_date, 'YYYY-MM-DD'),
        'daysLeft', c.expiry_date - v_muscat_today,
        'data', c.data
      ));
    end if;
  end loop;

  v_total := v_rows;

  for v_recipient in
    select trim(both '"' from recipient::text)
      from jsonb_array_elements(v_recipients) as recipient
     where jsonb_typeof(recipient) = 'string'
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

-- Scheduled delivery (pg_cron + pg_net). Skipped cleanly when unavailable.
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
    perform cron.schedule(
      'dks-expiry-digest-daily',
      '0 7 * * *',
      $cron$
      perform public.enqueue_expiry_digest();
      $cron$
    );
  end if;
exception when others then
  raise notice 'email schedule install skipped: %', sqlerrm;
end $$;

insert into public.settings (key, value)
values ('email_worker_url', to_jsonb('https://<PROJECT_REF>.functions.supabase.co/send-email'::text))
on conflict (key) do nothing;
