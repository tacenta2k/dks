-- ============================================================================
-- DKS — Office sign-in approval: REPAIR MIGRATION (write_audit_log fix)
-- ============================================================================
--
-- WHEN TO RUN THIS FILE:
--   Run it ONLY if you applied ARENA/sql/office-approval.sql BEFORE this
--   repair existed (i.e. you saw "Cannot verify sign-in approval —
--   record "old" has no field "deleted"" on the Office waiting screen, and
--   Admin did not see the pending request).
--   If you have NOT applied office-approval.sql yet, use the updated
--   office-approval.sql instead — it already contains this fix (§5c).
--
-- WHAT IT DOES (single idempotent statement, wrapped in one transaction):
--   Replaces public.write_audit_log() with a nested-guard body. The previous
--   body dereferenced OLD.deleted in the SAME expression as its scalar table
--   guard:
--       if tg_table_name = 'entries' and tg_op = 'UPDATE' and old.deleted ...
--   plpgsql dereferences record fields WHILE evaluating an expression, so
--   OLD.deleted was read on every admin_notifications insert (the audit
--   trigger admin_notifications_audit also uses write_audit_log), and
--   admin_notifications has no "deleted" column. Result: every insert into
--   admin_notifications — including the Office sign-in request notification
--   — failed with:  record "old" has no field "deleted"
--   The new body checks tg_table_name/tg_op first and only touches OLD/NEW
--   fields that the firing table really has. Nothing else changes.
--
-- This file never weakens RLS, never drops a policy, never touches data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §0 — READ-ONLY PREFLIGHT (run these SELECTs first; nothing is written)
-- ---------------------------------------------------------------------------
-- 1. Objects this repair expects to exist:
-- select 'office_signin_requests_table' as check_,
--        exists (select 1 from pg_tables where schemaname='public' and tablename='office_signin_requests');
-- select 'write_audit_log_fn' as check_,
--        count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname='public' and p.proname='write_audit_log';
--
-- 2. Triggers currently bound to the approval table — expect ONLY
--    office_signin_requests_notify_admin (and office_signin_requests_email_enqueue
--    if you also applied email-notifications.sql):
-- select tg.tgname, p.proname as function
--   from pg_trigger tg
--   join pg_class c on c.oid = tg.tgrelid
--   join pg_proc p on p.oid = tg.tgfoid
--  where c.relname = 'office_signin_requests'
--    and not tg.tgisinternal;
--
-- 3. The buggy pattern (combined guard + field deref in ONE IF) is visible in
--    the current function body — expect 'present (buggy)' BEFORE the fix:
-- select case
--          when pg_get_functiondef(
--                 'public.write_audit_log()'::regprocedure)
--               ~ 'tg_op = ''UPDATE''\s+and old\.deleted'
--          then 'present (buggy)' else 'absent (fixed)'
--        end as audit_entries_guard;

begin;

-- ---------------------------------------------------------------------------
-- §1 — the repaired audit trigger function (identical behaviour, safe order)
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
   -- behind this scalar-only outer IF: plpgsql dereferences record fields
   -- while evaluating an expression, so `tg_table_name = ... and old.deleted`
   -- in ONE condition crashed with `record "old" has no field "deleted"`
   -- whenever this shared audit trigger fired on a table without a "deleted"
   -- column (admin_notifications, renewals, app_columns).
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
-- §2 — READ-ONLY VERIFICATION (run after the repair; SELECT-only)
-- ---------------------------------------------------------------------------
-- 1. The audit function now nests its guards — expect 'absent (fixed)'
--    (the nested form has "if tg_table_name = 'entries' and tg_op = 'UPDATE' then"
--     with old.deleted only on the INNER line, so the tight pattern does not match):
-- select case
--          when pg_get_functiondef(
--                 'public.write_audit_log()'::regprocedure)
--               ~ 'tg_op = ''UPDATE''\s+and old\.deleted'
--          then 'present (buggy)' else 'absent (fixed)'
--        end as audit_entries_guard;
--
-- 2. Probe that an admin_notifications insert no longer crashes — run these
--    FOUR lines together as one SQL-editor batch; they roll everything back,
--    so nothing is stored (this replays exactly what the sign-in request
--    does internally):
-- begin;
-- insert into public.admin_notifications (type, message, payload, read, entry_id)
--   values ('repair_probe', 'repair probe', '{}'::jsonb, false, null);
-- select 'insert_ok' as probe_result;
-- rollback;
--    Expect the batch to print "insert_ok". If you instead see
--    "record "old" has no field "deleted"", STOP and report it.
--
-- 3. After this repair, re-run ARENA/sql/email-notifications.sql if its first
--    run ended with a ROLLBACK (an earlier revision inserted a bare (not
--    JSON-quoted) URL into settings and the whole file rolled back — fixed
--    in the current revision; it is safe to re-run end to end).
--
-- 4. Sign in as the Office account again: the waiting screen must now show
--    "pending" (not an error), and the Admin bell/panel must list the
--    request with Approve and Deny actions.
