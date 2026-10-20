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
      'date_start', 'date_expiry', 'dropdown', 'checkbox', 'notes'
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

   if tg_table_name = 'entries'
      and tg_op = 'UPDATE'
      and old.deleted is false
      and new.deleted is true
      and public.is_office()
   then
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

  if not public.is_admin() and not public.is_office() then
    raise exception 'Only office or admin users may inspect columns'
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

  if not public.is_admin() and not public.is_office() then
    raise exception 'Only office or admin users may delete columns'
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
  if auth.uid() is null or (not public.is_admin() and not public.is_office()) then
    raise exception 'Only office or administrator users may renew entries'
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

revoke all on public.profiles,
  public.app_columns,
  public.entries,
  public.renewals,
  public.audit_log,
  public.admin_notifications,
  public.settings,
  public.alert_snoozes,
  public.sync_sessions from anon;
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

-- Both roles may work with active column definitions.  Direct DELETE is an
-- administrator operation; office deletion goes through the empty-column RPC
-- and the trigger repeats the empty-column check for direct soft deletes.
drop policy if exists app_columns_select_authenticated on public.app_columns;
create policy app_columns_select_authenticated
on public.app_columns for select to authenticated
using (not deleted or public.is_admin());

drop policy if exists app_columns_insert_authenticated on public.app_columns;
create policy app_columns_insert_authenticated
on public.app_columns for insert to authenticated
with check (
  (public.is_admin() or public.is_office())
  and created_by = auth.uid()
);

drop policy if exists app_columns_update_authenticated on public.app_columns;
create policy app_columns_update_authenticated
on public.app_columns for update to authenticated
using (public.is_admin() or (public.is_office() and not deleted))
with check (
  public.is_admin()
  or (
    public.is_office()
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
using (not deleted or public.is_admin());

drop policy if exists entries_insert_authenticated on public.entries;
create policy entries_insert_authenticated
on public.entries for insert to authenticated
with check (
  (public.is_admin() or public.is_office())
  and created_by = auth.uid()
  and not deleted
);

drop policy if exists entries_update_authenticated on public.entries;
create policy entries_update_authenticated
on public.entries for update to authenticated
using (public.is_admin() or (public.is_office() and not deleted))
with check (
  public.is_admin()
  or (
    public.is_office()
    and (
      (not deleted and deleted_at is null and deleted_by is null)
      or (deleted and deleted_at is not null and deleted_by = auth.uid())
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
  or exists (
    select 1
      from public.entries e
     where e.id = entry_id
       and not e.deleted
  )
);

-- Renewal writes are performed by renew_entry, which validates the role and
-- writes the immutable snapshot before updating the entry JSON.

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
on public.audit_log for select to authenticated
using (public.is_admin());

drop policy if exists audit_log_insert_authenticated on public.audit_log;
create policy audit_log_insert_authenticated
on public.audit_log for insert to authenticated
with check (actor = auth.uid() or actor is null);

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
using (true);

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
using (user_id = auth.uid() or public.is_admin());

drop policy if exists alert_snoozes_insert_authenticated on public.alert_snoozes;
create policy alert_snoozes_insert_authenticated
on public.alert_snoozes for insert to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists alert_snoozes_update_authenticated on public.alert_snoozes;
create policy alert_snoozes_update_authenticated
on public.alert_snoozes for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists alert_snoozes_delete_authenticated on public.alert_snoozes;
create policy alert_snoozes_delete_authenticated
on public.alert_snoozes for delete to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists sync_sessions_select_authenticated on public.sync_sessions;
create policy sync_sessions_select_authenticated
on public.sync_sessions for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists sync_sessions_insert_authenticated on public.sync_sessions;
create policy sync_sessions_insert_authenticated
on public.sync_sessions for insert to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists sync_sessions_update_authenticated on public.sync_sessions;
create policy sync_sessions_update_authenticated
on public.sync_sessions for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists sync_sessions_delete_authenticated on public.sync_sessions;
create policy sync_sessions_delete_authenticated
on public.sync_sessions for delete to authenticated
using (user_id = auth.uid() or public.is_admin());

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
