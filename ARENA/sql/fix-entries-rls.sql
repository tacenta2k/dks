-- ============================================================================
-- DKS — entries row-level security fix (R2-01) + audit-log clear (R2-10)
-- ============================================================================
--
-- RUN THIS FILE IN THE SUPABASE SQL EDITOR (Dashboard → SQL Editor → Run).
-- It is idempotent: every object is dropped-if-exists first, so it can be run
-- again safely after a later DKS update that extends this same file.
--
-- WHAT IT FIXES
--   Signed in as OFFICE, editing or deleting a row that was created by ADMIN
--   failed with:
--     new row violates row-level security policy for table "entries"
--   because the previous UPDATE policy's WITH CHECK only accepted rows whose
--   deleted/attribution columns matched one specific shape, and the client
--   used an "INSERT … ON CONFLICT DO UPDATE" upsert whose INSERT half was
--   also being policy-checked.
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
--      OLD.created_by onto NEW.created_by. The client stamps created_by on
--      INSERT only and updated_by on UPDATE.
--   5. Hard DELETE stays admin-only (policy unchanged, recreated below).
--   6. Admin keeps the full path: sees deleted rows, restores them with
--      restore_entry(), permanently deletes with permanently_delete_entry().
--
-- SAFETY
--   * Row level security is NOT disabled.
--   * Nothing is granted to `anon` (anon stays revoked by the base schema).
--   * No service-role key, no SECURITY DEFINER bypass for edits, no widening
--     of Admin-only operations.
--   * No table columns, rows or data are dropped or rewritten.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. created_by is immutable after insert
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
  return new;
end;
$$;

drop trigger if exists entries_keep_created_by on public.entries;
create trigger entries_keep_created_by
before update on public.entries
for each row execute function public.entries_keep_created_by();

-- ---------------------------------------------------------------------------
-- 2. Office can never move a deleted row back to active (no restore path)
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
-- 3. SELECT — unchanged: everyone sees live rows, Admin also sees deleted rows
-- ---------------------------------------------------------------------------
alter table public.entries enable row level security;

drop policy if exists entries_select_authenticated on public.entries;
create policy entries_select_authenticated
on public.entries for select to authenticated
using (not deleted or public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. INSERT — any authenticated DKS account, own rows only, never pre-deleted
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. UPDATE — the actual fix
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6. DELETE — administrator only (unchanged, recreated for clarity)
-- ---------------------------------------------------------------------------
drop policy if exists entries_delete_admin on public.entries;
create policy entries_delete_admin
on public.entries for delete to authenticated
using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. AUDIT LOG — administrator-only clear (R2-10)
-- ---------------------------------------------------------------------------
-- The Audit Log page has a "Clear audit log" action.  It must never be a
-- client-side DELETE: there is no DELETE policy on public.audit_log for
-- anyone, so an Office account cannot empty the log even by calling the HTTP
-- API directly.  The only path is this SECURITY DEFINER function, which
-- re-checks the caller's role server-side.
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
      || to_char(now() at time zone 'UTC', 'DD/MM/YYYY HH24:MI')
  );

  delete from public.audit_log;

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

-- ---------------------------------------------------------------------------
-- Verification (run separately, optional)
-- ---------------------------------------------------------------------------
-- The policies above are visible in:
--   select policyname, cmd, qual, with_check
--     from pg_policies
--    where schemaname = 'public' and tablename = 'entries';
--
-- Expected:
--   entries_select_authenticated  SELECT  (not deleted or is_admin())
--   entries_insert_authenticated  INSERT  (auth.uid() is not null and ...)
--   entries_update_authenticated  UPDATE  (is_admin() or (is_office() and not deleted))
--   entries_delete_admin          DELETE  (is_admin())
--
-- Audit log: `select * from pg_policies where tablename = 'audit_log';`
-- must show SELECT + INSERT only (no DELETE, no UPDATE).  Clearing goes
-- through public.clear_audit_log(text).
