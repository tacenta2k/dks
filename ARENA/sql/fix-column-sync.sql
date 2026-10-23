-- ============================================================================
-- DKS — column sync: resolve a duplicate app_columns name (R3 batch B/G)
-- ============================================================================
--
-- RUN THIS FILE IN THE SUPABASE SQL EDITOR (Dashboard → SQL Editor → Run),
-- AFTER reading SECTION 0 (read-only preflight). It is idempotent and safe to
-- run more than once.
--
-- THE PROBLEM
--   public.app_columns.name is UNIQUE across the whole table (deleted columns
--   keep their name). Signing in to a fresh local database as OFFICE, the app
--   tried to INSERT a column that already existed on the server under the same
--   name, so the sync failed with:
--     Column Visa Expiry: duplicate key value violates unique constraint
--     "app_columns_name_key"
--   Office could not even see the existing row: the SELECT policy hides
--   `deleted = true` rows from Office, and an administrator deleting a column
--   leaves it in the table.
--
-- THE FIX
--   The client now asks the server which row owns a name before pushing a new
--   column. This function answers that question with the minimum information
--   needed to reconcile:
--
--     * identical type + options  → the client adopts the server id (rewriting
--       its own entry JSON keys) and updates that row. Nothing is renamed,
--       dropped or deleted.
--     * different type/options    → both versions stay; a conflict is recorded
--       for an administrator to resolve.
--     * no row with the name      → null, and the normal insert path runs.
--
--   It returns column DEFINITIONS only (never entry values). Both DKS roles may
--   call it, because both roles are allowed to create and edit columns; it is
--   not granted to `anon`, and it is read-only.
--
--   The unique constraint is deliberately NOT dropped or weakened. A partial
--   unique index would be a cleaner long-term shape, but changing it would let
--   two live columns share a name until every client is updated.
--
-- SCHEMA COMPATIBILITY (section 1)
--   The function and the sync client touch these app_columns fields:
--     name, type, options, position, visible,
--     is_primary_expiry, is_passport, deleted, deleted_at, updated_at
--   `supabase/schema.sql` creates all of them, but a production project that
--   was created from an older DKS schema may be missing some. SECTION 0 tells
--   you exactly which are present; SECTION 1 adds the missing ones with
--   `add column if not exists` (additive only — no drops, no renames, no data
--   rewritten). The function itself reads rows through `to_jsonb`, so it still
--   works if an optional field is absent.
--
-- THE UPSERT LOOPHOLE (R3 batch G)
--   The client no longer writes entries or columns through
--   `INSERT … ON CONFLICT DO UPDATE`. An upsert makes PostgreSQL evaluate the
--   INSERT policy even when the row already exists, which is what allowed the
--   "new row violates row-level security policy" path and made authorisation
--   depend on which half of the upsert the planner chose. Insert and update are
--   now separate, explicitly authorised operations.
--
-- SAFETY
--   * SECURITY DEFINER with a fixed search_path (no injection surface).
--   * No INSERT/UPDATE/DELETE of data, no RLS change, no grant to `anon`.
--   * Additive DDL only (add column if not exists).
--
-- ============================================================================
-- SECTION 0 — PREFLIGHT (READ-ONLY). Run these statements before SECTION 1.
-- ============================================================================
--
-- 0.1 Which fields the client/function need, and whether this project has
--     them. Any row with present = false and required = true must be fixed by
--     SECTION 1 below.
--
-- with expected(column_name, required, purpose) as (
--   values
--     ('name',              true,  'unique name; reconciliation key'),
--     ('type',              true,  'column type (text, date_expiry, …)'),
--     ('options',           true,  'dropdown options / currency'),
--     ('position',          true,  'sheet column order'),
--     ('visible',           true,  'hidden vs shown'),
--     ('is_primary_expiry', true,  'primary expiry flag'),
--     ('is_passport',       true,  'passport flag'),
--     ('deleted',           true,  'soft-deleted column definitions'),
--     ('deleted_at',        true,  'soft-delete timestamp'),
--     ('updated_at',        true,  'last-write-wins comparison'),
--     ('created_at',        false, 'audit only'),
--     ('created_by',        false, 'audit only')
-- )
-- select e.column_name,
--        e.required,
--        (c.column_name is not null) as present,
--        coalesce(c.data_type, '—') as data_type,
--        e.purpose,
--        case when c.column_name is null and e.required then 'MISSING — SECTION 1 adds it'
--             when c.column_name is null then 'absent (optional, tolerated)'
--             else 'ok' end as verdict
--   from expected e
--   left join information_schema.columns c
--     on c.table_schema = 'public'
--    and c.table_name = 'app_columns'
--    and c.column_name = e.column_name
--  order by e.required desc, e.column_name;
--
-- 0.2 Names that the case-sensitive unique constraint treats as distinct but
--     the app treats as the same column (informational; the function prefers a
--     live row and then the most recently updated one):
--
-- select lower(btrim(name)) as normalized_name, count(*) as variants,
--        string_agg(name, ', ' order by name) as names
--   from public.app_columns
--  group by 1
-- having count(*) > 1
--  order by 1;
--
-- 0.3 Policies on app_columns (the full expected list is in
--     ARENA/sql/fix-entries-rls.sql SECTION 0.1 and 2.1):
--
-- select policyname, cmd, permissive, roles::text
--   from pg_policies
--  where schemaname = 'public' and tablename = 'app_columns'
--  order by cmd, policyname;
--
-- ============================================================================
-- SECTION 1 — schema compatibility (additive, idempotent)
-- ============================================================================

begin;

-- Only adds what SECTION 0 reported as missing. Defaults match
-- supabase/schema.sql, and no existing value is rewritten.
alter table public.app_columns add column if not exists options jsonb not null default '{}'::jsonb;
alter table public.app_columns add column if not exists visible boolean not null default true;
alter table public.app_columns add column if not exists is_primary_expiry boolean not null default false;
alter table public.app_columns add column if not exists is_passport boolean not null default false;
alter table public.app_columns add column if not exists updated_at timestamptz not null default now();
alter table public.app_columns add column if not exists deleted boolean not null default false;
alter table public.app_columns add column if not exists deleted_at timestamptz;

-- ---------------------------------------------------------------------------
-- The read-only resolver
-- ---------------------------------------------------------------------------
-- Reads the row as jsonb so an optional/absent field cannot make the function
-- fail at call time, and picks the live row before a deleted one.
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

commit;

-- ============================================================================
-- SECTION 2 — VERIFICATION (READ-ONLY). Run after SECTION 1.
-- ============================================================================
--
-- 2.1 SECTION 0.1 now reports present = true for every required field.
--
-- 2.2 The function exists, is SECURITY DEFINER and is not callable by anon:
--
-- select p.proname, p.prosecdef as security_definer,
--        pg_get_userbyid(p.proowner) as owner,
--        has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname = 'resolve_duplicate_column';
-- -- Expected: one row, security_definer = true, anon_can_execute = false.
--
-- 2.3 Must return one row per column name, including soft-deleted definitions:
--
-- select id, name, type, deleted, updated_at from public.app_columns order by name;
--
-- 2.4 Must return the row that owns "Visa Expiry" for the signed-in account
--     (empty result means the name is free and the insert path may run):
--
-- select public.resolve_duplicate_column('Visa Expiry');
