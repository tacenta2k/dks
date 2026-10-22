-- ============================================================================
-- DKS — column sync: resolve a duplicate app_columns name (R3 batch B)
-- ============================================================================
--
-- RUN THIS FILE IN THE SUPABASE SQL EDITOR (Dashboard → SQL Editor → Run).
-- It is idempotent and safe to run more than once.
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
--   Note: the unique constraint is deliberately NOT dropped or weakened. A
--   partial unique index would be a cleaner long-term shape, but changing it
--   would let two live columns share a name until every client is updated.
--
-- SAFETY
--   * SECURITY DEFINER with a fixed search_path (no injection surface).
--   * No INSERT/UPDATE/DELETE, no RLS change, no grant to `anon`.

begin;

create or replace function public.resolve_duplicate_column(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.app_columns;
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

  -- Prefer a live row; otherwise report the deleted one that owns the name.
  select *
    into v_row
    from public.app_columns
   where lower(btrim(name)) = lower(btrim(p_name))
   order by deleted asc, updated_at desc
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'type', v_row.type,
    'options', coalesce(v_row.options, '{}'::jsonb),
    'position', v_row.position,
    'deleted', v_row.deleted,
    'deleted_at', v_row.deleted_at,
    'is_primary_expiry', v_row.is_primary_expiry,
    'is_passport', v_row.is_passport,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.resolve_duplicate_column(text) from public;
grant execute on function public.resolve_duplicate_column(text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run separately, optional)
-- ---------------------------------------------------------------------------
-- Must return one row per column name, including soft-deleted definitions:
--   select id, name, type, deleted from public.app_columns order by name;
--
-- Must return the row that owns "Visa Expiry" for the signed-in account:
--   select public.resolve_duplicate_column('Visa Expiry');
