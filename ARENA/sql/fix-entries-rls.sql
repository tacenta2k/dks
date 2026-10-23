-- ============================================================================
-- DKS — entries row-level security fix (R2-01) + audit-log clear (R2-10)
-- ============================================================================
--
-- RUN THIS FILE IN THE SUPABASE SQL EDITOR (Dashboard → SQL Editor → Run),
-- AFTER reading SECTION 0 (read-only preflight). It is idempotent: every
-- object is dropped-if-exists first, so it can be run again safely after a
-- later DKS update that extends this same file.
--
-- WHAT IT FIXES
--   Signed in as OFFICE, editing or deleting a row that was created by ADMIN
--   failed with:
--     new row violates row-level security policy for table "entries"
--   because the previous UPDATE policy's WITH CHECK only accepted rows whose
--   deleted/attribution columns matched one specific shape, and the client
--   used an "INSERT … ON CONFLICT DO UPDATE" upsert whose INSERT half was
--   also being policy-checked.  (The client no longer upserts entries or
--   columns at all — see R3 batch G notes below — so the INSERT policy can
--   only ever be evaluated for a real INSERT again.)
--
-- REQUIRED BEHAVIOUR (and what this file implements)
--   1. Any authenticated DKS account (admin or office) may INSERT a row.
--      The insert must carry created_by = auth.uid() and must not be born
--      already deleted.
--   2. Any authenticated DKS account may UPDATE any NON-deleted row:
--        - edit values (including rows created by the other account);
--        - soft delete it (deleted = true, deleted_at set, deleted_by set).
--      Office cannot see or update an already-deleted row, so Office cannot
--      restore. Restoring stays admin-only via public.restore_entry().
--   3. Both roles can update rows created by either account: created_by is
--      NEVER part of the authorization test for UPDATE.
--   4. created_by never changes after insert: a BEFORE UPDATE trigger copies
--      OLD.created_by onto NEW.created_by. updated_by is stamped server-side
--      from auth.uid() on every UPDATE, so a client cannot attribute an edit
--      to another account.
--   5. Hard DELETE stays admin-only (policy unchanged, recreated below).
--   6. Admin keeps the full path: sees deleted rows, restores them with
--      restore_entry(), permanently deletes with permanently_delete_entry().
--   7. Clearing the audit log is admin-only, uses ONE scoped statement
--      (`where id is not null`) and leaves exactly one traceable entry whose
--      timestamp is Oman local time (Asia/Muscat), because the business day
--      is the Oman day regardless of the PC's timezone.
--
-- SAFETY
--   * Row level security is NOT disabled anywhere.
--   * Nothing is granted to `anon` (anon stays revoked by the base schema).
--   * No service-role key, no SECURITY DEFINER bypass for edits, no widening
--     of Admin-only operations.
--   * No table columns, rows or data are dropped or rewritten.
--   * A guard aborts the whole transaction when an UNEXPECTED permissive
--     policy exists on entries / audit_log / app_columns. PostgreSQL ORs
--     permissive policies together, so one forgotten broad policy would
--     silently re-open access; this file refuses to "succeed" while one is
--     still there.
--
-- ============================================================================
-- SECTION 0 — PREFLIGHT (READ-ONLY). Run these statements ONE AT A TIME
-- before the migration below. They change nothing.
-- ============================================================================
--
-- 0.1 What the server currently has, and whether it is expected.
--     Expected: exactly the ten policies in the `expected` list below.
--     Anything reported as UNEXPECTED must be reviewed (and dropped if it is
--     an old DKS policy) before running SECTION 1.
--
-- with expected(tablename, policyname, cmd) as (
--   values
--     ('entries',     'entries_select_authenticated',     'SELECT'),
--     ('entries',     'entries_insert_authenticated',     'INSERT'),
--     ('entries',     'entries_update_authenticated',     'UPDATE'),
--     ('entries',     'entries_delete_admin',             'DELETE'),
--     ('audit_log',   'audit_log_select_admin',           'SELECT'),
--     ('audit_log',   'audit_log_insert_authenticated',   'INSERT'),
--     ('app_columns', 'app_columns_select_authenticated', 'SELECT'),
--     ('app_columns', 'app_columns_insert_authenticated', 'INSERT'),
--     ('app_columns', 'app_columns_update_authenticated', 'UPDATE'),
--     ('app_columns', 'app_columns_delete_admin',         'DELETE')
-- ),
-- actual as (
--   select tablename, policyname, cmd, permissive, roles::text as roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('entries', 'audit_log', 'app_columns')
-- )
-- select coalesce(e.tablename, a.tablename)   as table_name,
--        coalesce(e.policyname, a.policyname) as policy_name,
--        coalesce(a.cmd, e.cmd)               as command,
--        a.permissive,
--        a.roles,
--        case
--          when a.policyname is null then 'MISSING — recreate with supabase/schema.sql'
--          when e.policyname is null and a.permissive = 'PERMISSIVE'
--            then 'UNEXPECTED permissive policy — review and drop before SECTION 1'
--          when e.policyname is null
--            then 'unexpected restrictive policy (only narrows access)'
--          when a.cmd is distinct from e.cmd then 'WRONG COMMAND — this file recreates it'
--          else 'ok'
--        end as verdict
--   from expected e
--   full join actual a
--     on a.tablename = e.tablename
--    and a.policyname = e.policyname
--  order by 1, 6 desc, 3, 2;
--
-- 0.2 Row level security must be enabled on all three tables.
--
-- select c.relname as table_name, c.relrowsecurity as rls_enabled,
--        c.relforcerowsecurity as rls_forced
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public'
--    and c.relname in ('entries', 'app_columns', 'audit_log')
--  order by 1;
--
-- 0.3 No DELETE/UPDATE policy may exist on the audit log (clearing is the
--     RPC only). This statement must return zero rows.
--
-- select policyname, cmd, permissive
--   from pg_policies
--  where schemaname = 'public'
--    and tablename = 'audit_log'
--    and cmd in ('DELETE', 'UPDATE', 'ALL');
--
-- 0.4 The app_columns column check lives at the top of
--     ARENA/sql/fix-column-sync.sql (it is that migration's dependency).
--     Run it before that file, not before this one.
--
-- ============================================================================
-- SECTION 1 — the migration
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Guard: refuse to run while an unexpected permissive policy exists
-- ---------------------------------------------------------------------------
-- PostgreSQL combines PERMISSIVE policies with OR. A leftover broad policy
-- ("entries_all_authenticated", an old "office can do anything" rule, a DELETE
-- policy on audit_log, …) would keep working even after every policy below is
-- recreated. RESTRICTIVE policies only narrow access, so they are allowed and
-- reported by 0.1 as informational.
--
-- The two audit_log delete policies are listed as known-obsolete because this
-- same transaction drops them in section 4.
do $$
declare
  v_unexpected text;
begin
  select string_agg(
           format('%s.%s (%s)', p.tablename, p.policyname, p.cmd),
           E'\n' order by p.tablename, p.policyname
         )
    into v_unexpected
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('entries', 'audit_log', 'app_columns')
     and p.permissive = 'PERMISSIVE'
     and (p.tablename, p.policyname, p.cmd) not in (
       ('entries',     'entries_select_authenticated',     'SELECT'),
       ('entries',     'entries_insert_authenticated',     'INSERT'),
       ('entries',     'entries_update_authenticated',     'UPDATE'),
       ('entries',     'entries_delete_admin',             'DELETE'),
       ('audit_log',   'audit_log_select_admin',           'SELECT'),
       ('audit_log',   'audit_log_insert_authenticated',   'INSERT'),
       ('app_columns', 'app_columns_select_authenticated', 'SELECT'),
       ('app_columns', 'app_columns_insert_authenticated', 'INSERT'),
       ('app_columns', 'app_columns_update_authenticated', 'UPDATE'),
       ('app_columns', 'app_columns_delete_admin',         'DELETE'),
       -- removed below, in this transaction
       ('audit_log',   'audit_log_delete_admin',           'DELETE'),
       ('audit_log',   'audit_log_delete_authenticated',   'DELETE')
     );

  if v_unexpected is not null then
    raise exception 'DKS RLS migration aborted: unexpected permissive policies exist:%',
      E'\n' || v_unexpected
      using errcode = '42501',
            hint = 'Permissive policies are OR-ed together, so an unknown one can widen access. '
                   'Review SECTION 0.1, drop the old policy(s), then run this file again.';
  end if;

  -- RLS must be on for the policies below to mean anything.
  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('entries', 'app_columns', 'audit_log')
       and c.relrowsecurity = false
  ) then
    raise exception 'DKS RLS migration aborted: row level security is disabled on a DKS table'
      using errcode = '42501';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. created_by is immutable after insert; updated_by is server-stamped
-- ---------------------------------------------------------------------------
-- The client sends created_by only on INSERT.  Even if a future client (or a
-- manual REST call) tries to rewrite it on UPDATE, the stored creator is kept.
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

drop trigger if exists entries_keep_created_by on public.entries;
create trigger entries_keep_created_by
before update on public.entries
for each row execute function public.entries_keep_created_by();

-- R3 batch G: attribution cannot be forged.  auth.uid() is the caller's
-- authenticated account (also inside SECURITY DEFINER functions), so an Office
-- account cannot write updated_by = the admin's id, and an admin restore is
-- attributed to the admin. When there is no JWT (SQL editor, service role)
-- the value provided by the caller is left untouched.
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

drop trigger if exists entries_stamp_updated_by on public.entries;
create trigger entries_stamp_updated_by
before update on public.entries
for each row execute function public.entries_stamp_updated_by();

-- ---------------------------------------------------------------------------
-- 3. Office can never move a deleted row back to active (no restore path)
-- ---------------------------------------------------------------------------
-- The UPDATE policy below already hides deleted rows from Office, so a manual
-- restore attempt matches zero rows.  This trigger turns a bypass attempt
-- (for example a future policy regression) into a hard error instead of a
-- silent restore.
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

drop trigger if exists entries_guard_office_restore on public.entries;
create trigger entries_guard_office_restore
before update on public.entries
for each row execute function public.guard_office_restore();

-- ---------------------------------------------------------------------------
-- 4. SELECT — unchanged: everyone sees live rows, Admin also sees deleted rows
--    INSERT — any authenticated DKS account, own rows only, never pre-deleted
--    UPDATE — the actual fix (Office: live rows only)
--    DELETE — administrator only
--    audit_log — SELECT/INSERT only; no DELETE and no UPDATE policy at all
-- ---------------------------------------------------------------------------
alter table public.entries enable row level security;

drop policy if exists entries_select_authenticated on public.entries;
create policy entries_select_authenticated
on public.entries for select to authenticated
using (not deleted or public.is_admin());

drop policy if exists entries_insert_authenticated on public.entries;
create policy entries_insert_authenticated
on public.entries for insert to authenticated
with check (
  auth.uid() is not null
  and (public.is_admin() or public.is_office())
  and created_by = auth.uid()
  and deleted is false
  and deleted_at is null
  and deleted_by is null
);

-- USING  : which existing rows may be updated.
--            Admin → any row (including deleted, needed by restore_entry()).
--            Office → live rows only (so a deleted row can never be restored
--                     or edited by Office).
-- WITH CHECK : which resulting rows are accepted.
--            Admin → anything.
--            Office → either a live row (normal edit, attribution columns
--                     cleared) or a freshly soft-deleted row (deleted_at set,
--                     deleted_by already set to the acting account).
-- created_by is deliberately absent from both clauses: the trigger above
-- keeps it immutable, and it must never decide whether an edit is allowed.
drop policy if exists entries_update_authenticated on public.entries;
create policy entries_update_authenticated
on public.entries for update to authenticated
using (
  public.is_admin()
  or (public.is_office() and deleted is false)
)
with check (
  public.is_admin()
  or (
    public.is_office()
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

-- ---------------------------------------------------------------------------
-- 5. AUDIT LOG — administrator-only clear (R2-10 / R3 batch G)
-- ---------------------------------------------------------------------------
-- The Audit Log page has a "Clear audit log" action.  It must never be a
-- client-side DELETE: there is no DELETE policy on public.audit_log for
-- anyone, so an Office account cannot empty the log even by calling the HTTP
-- API directly.  The only path is this SECURITY DEFINER function, which
-- re-checks the caller's role server-side.
--
-- Two details that were wrong before:
--   * the DELETE had no predicate. A `DELETE` without a WHERE clause is the
--     request shape servers reject with "DELETE requires a WHERE clause"
--     (and it also reads as an accident in review). `where id is not null`
--     is true for every row (id is NOT NULL / identity primary key), so the
--     effect is identical and the statement is safe-delete compatible.
--   * the message was stamped in UTC. DKS is operated in Oman, so the
--     displayed time is now Asia/Muscat; the wording is unchanged:
--       Audit log cleared by Admin on DD/MM/YYYY HH:mm
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

  -- Scoped on purpose: an unfiltered DELETE is rejected by REST layers and
  -- hides intent. `id` is the identity primary key, so no row is excluded.
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

-- Belt and braces: no direct DELETE policy may exist on the audit log.
drop policy if exists audit_log_delete_admin on public.audit_log;
drop policy if exists audit_log_delete_authenticated on public.audit_log;

commit;

-- ============================================================================
-- SECTION 2 — VERIFICATION (READ-ONLY). Run after SECTION 1.
-- ============================================================================
--
-- 2.1 Every expected policy is present with the expected command, and nothing
--     unexpected remains. Every row must read `ok`.
--
-- select p.tablename, p.policyname, p.cmd, p.permissive, p.roles::text
--   from pg_policies p
--  where p.schemaname = 'public'
--    and p.tablename in ('entries', 'audit_log', 'app_columns')
--  order by 1, 3, 2;
--
-- Expected (ten rows, all PERMISSIVE, all granted to {authenticated}):
--   entries      entries_select_authenticated      SELECT  (not deleted or is_admin())
--   entries      entries_insert_authenticated      INSERT  (auth.uid() not null and created_by = auth.uid() and not deleted)
--   entries      entries_update_authenticated      UPDATE  (is_admin() or (is_office() and not deleted))
--   entries      entries_delete_admin              DELETE  (is_admin())
--   audit_log    audit_log_select_admin            SELECT  (is_admin())
--   audit_log    audit_log_insert_authenticated    INSERT  (actor = auth.uid() or actor is null)
--   app_columns  app_columns_select_authenticated  SELECT
--   app_columns  app_columns_insert_authenticated  INSERT
--   app_columns  app_columns_update_authenticated  UPDATE
--   app_columns  app_columns_delete_admin          DELETE  (is_admin())
--
-- 2.2 The audit log still has no DELETE/UPDATE policy (zero rows):
--
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'audit_log'
--    and cmd in ('DELETE', 'UPDATE', 'ALL');
--
-- 2.3 The clear function keeps exactly one traceable entry, stamped in Oman
--     time (this is destructive — run it only if you intend to clear):
--
-- select public.clear_audit_log();            -- admin session only
-- select action, details->>'message' as message, created_at
--   from public.audit_log order by id;
-- -- Expected: one row, action = 'clear_audit',
-- --           message = 'Audit log cleared by Admin on DD/MM/YYYY HH:mm'
-- --           matching Oman local time (Asia/Muscat).
