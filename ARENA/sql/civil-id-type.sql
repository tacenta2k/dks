-- ============================================================================
-- DKS — Civil ID column type (MIGRATION, additive + metadata-only)
-- ============================================================================
--
-- Adds 'civil_id' to the public.app_columns type CHECK constraint so the
-- app can create Civil ID columns. Values are plain strings (leading zeroes
-- preserved); the app enforces NO country-specific format.
--
-- NON-DESTRUCTIVE: only a check constraint is replaced (one metadata DDL);
-- no rows are rewritten, no columns dropped, no functions touched.
--
-- This is the ONLY Supabase change required for the Civil ID feature.
-- PREREQUISITE: identical constraint-text change in supabase/schema.sql
-- (fresh installs) ships in the same release; this file migrates the LIVE db.
-- ============================================================================

begin;

-- §0 — READ-ONLY PREFLIGHT (safe standalone):
--   select count(*) as unsupported_existing
--     from public.app_columns
--    where type not in ('text','number','phone','email','price',
--                       'date_start','date_expiry','dropdown','checkbox','notes','civil_id');
-- (must be 0 before applying — otherwise the new check would fail on old rows).

-- §1 — widen the type check constraint (name is postgres's default)
alter table public.app_columns drop constraint if exists app_columns_type_check;
alter table public.app_columns
  add constraint app_columns_type_check
  check (type in (
    'text', 'number', 'phone', 'email', 'price',
    'date_start', 'date_expiry', 'dropdown', 'checkbox', 'notes',
    'civil_id'
  ));

commit;

-- §2 — READ-ONLY VERIFICATION:
--   insert into public.app_columns (name, type, created_by)
--     select 'TMP civil id check', 'civil_id', auth.uid();
--   delete from public.app_columns where name = 'TMP civil id check';
--   -- a bogus type must still fail:
--   -- insert into public.app_columns (name, type, created_by)
--   --   values ('TMP bogus', 'not-a-type', auth.uid());  -- expect 23514
