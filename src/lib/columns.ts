export const COLUMN_TYPES = [
  'text',
  'number',
  'phone',
  'email',
  'price',
  'date_start',
  'date_expiry',
  'dropdown',
  'checkbox',
  'notes',
  'civil_id',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export type DropdownOptions =
  | readonly string[]
  | {
      values?: readonly string[];
      options?: readonly string[];
      choices?: readonly string[];
    };

export interface ColumnDefinition {
  id: string;
  name: string;
  type: ColumnType;
  options?: DropdownOptions;
  position?: number;
  visible?: boolean;
  isPrimaryExpiry?: boolean;
  is_primary_expiry?: boolean;
  isPassport?: boolean;
  is_passport?: boolean;
  deleted?: boolean;
  updatedAt?: string;
  updated_at?: string;
}

export interface GridRowLike {
  id?: string;
  data?: Record<string, unknown> | null;
  deleted?: boolean;
}

export interface ColumnValidationResult {
  valid: boolean;
  errors: string[];
}

/** The generated, read-only column is intentionally not a user column type. */
export const DAYS_LEFT_COLUMN_ID = 'daysLeft';
export const DAYS_LEFT_COLUMN_NAME = 'Days Left';
export const DAYS_LEFT_COLUMN_TYPE = 'number' as const;

/**
 * AG Grid system/utility column ids rendered around the user columns:
 * the `#` row-number gutter and Actions (pinned left), the `+` add-column
 * header and Days Left (pinned right). They are UI furniture only — never
 * persisted as user columns and never part of a saved column order.
 */
export const ROW_NUMBER_COLUMN_ID = '__rowNumber';
export const ACTIONS_COLUMN_ID = '__actions';
export const ADD_COLUMN_COLUMN_ID = '__addColumn';

export const GRID_SYSTEM_COLUMN_IDS: ReadonlySet<string> = new Set([
  ROW_NUMBER_COLUMN_ID,
  ACTIONS_COLUMN_ID,
  ADD_COLUMN_COLUMN_ID,
  DAYS_LEFT_COLUMN_ID,
]);

export function isGridSystemColumnId(value: unknown): boolean {
  return typeof value === 'string' && GRID_SYSTEM_COLUMN_IDS.has(value);
}

function normaliseIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isActive(column: ColumnDefinition): boolean {
  return column.deleted !== true;
}

export function isSupportedColumnType(value: unknown): value is ColumnType {
  return typeof value === 'string' && (COLUMN_TYPES as readonly string[]).includes(value);
}

/**
 * Is this column the generated, read-only "Days Left" SYSTEM column?
 *
 * Protection is strictly by column id (`col.id === 'daysLeft'`) — NEVER by
 * name. A previously persisted user column that happens to be NAMED "Days
 * Left" (e.g. `days_left` from an older import/layout) must stay deletable;
 * matching on the name blocked its deletion forever.
 */
export function isDaysLeftColumn(
  column: Pick<ColumnDefinition, 'id' | 'name'> | null | undefined,
): boolean {
  return column?.id === DAYS_LEFT_COLUMN_ID;
}

/** Exact-id protection; clearer name for new call sites. */
export const isSystemDaysLeftColumn = isDaysLeftColumn;

/**
 * "Days Left" as a NAME is reserved for the generated system column: the
 * column wizard must refuse it and imports must never persist an incoming
 * "Days Left" header as a user column. Used for NAME checks only — never for
 * delete protection (that is id-exact, see above).
 */
export function isReservedSystemColumnName(value: unknown): boolean {
  return typeof value === 'string'
    && normaliseIdentity(value).replace(/[ _-]/g, '') === 'daysleft';
}

/**
 * A LIVE primary-expiry is the only primary flag allowed to block deletion:
 * the column must still be active (not soft-deleted) and of type date_expiry.
 * Stale `is_primary_expiry` marks on deleted or non-expiry columns are junk
 * (auto-healed elsewhere) and must never block a delete.
 */
export function isLivePrimaryExpiryColumn(
  column: Pick<ColumnDefinition, 'type' | 'deleted'> & {
    isPrimaryExpiry?: boolean;
    is_primary_expiry?: boolean;
  } | null | undefined,
): boolean {
  return !!column
    && column.type === 'date_expiry'
    && column.deleted !== true
    && (column.isPrimaryExpiry === true || column.is_primary_expiry === true);
}

/**
 * Enforce the local column invariants without mutating the caller's objects.
 *
 * Primary-expiry selection mirrors `SqliteStore.repairPrimaryExpiry`: an
 * existing single LIVE primary (an administrator's explicit "set as primary"
 * choice) is preserved as-is. First-by-position is only the deterministic
 * heal for zero or ambiguous marks. Preserving the flagged primary matters
 * for column reordering: dragging one expiry column past another changes
 * positions only and must never silently redesignate which date drives
 * Days Left / alerts.
 */
export function normalizeColumns(columns: readonly ColumnDefinition[]): ColumnDefinition[] {
  const copied = columns.map((column, index) => ({
    ...column,
    position: column.position ?? index,
    visible: column.visible ?? true,
    deleted: column.deleted ?? false,
  }));

  const firstExpiryIndex = copied.reduce<number>((firstIndex, column, index, all) => {
    if (!isActive(column) || column.type !== 'date_expiry') {
      return firstIndex;
    }
    if (firstIndex < 0) {
      return index;
    }
    const first = all[firstIndex];
    return (column.position ?? index) < (first.position ?? firstIndex) ? index : firstIndex;
  }, -1);

  const flaggedPrimaryIndexes = copied.flatMap((column, index) => (
    isLivePrimaryExpiryColumn(column) ? [index] : []
  ));
  const primaryIndex = flaggedPrimaryIndexes.length === 1
    ? flaggedPrimaryIndexes[0]
    : firstExpiryIndex;

  return copied.map((column, index) => ({
    ...column,
    isPrimaryExpiry: primaryIndex >= 0 && index === primaryIndex,
    is_primary_expiry: primaryIndex >= 0 && index === primaryIndex,
  }));
}

export const normaliseColumns = normalizeColumns;
export const enforceColumnRules = normalizeColumns;

export function getPrimaryExpiryColumn(
  columns: readonly ColumnDefinition[],
): ColumnDefinition | null {
  return columns.find(
    (column) => isActive(column)
      && column.type === 'date_expiry'
      && (column.isPrimaryExpiry === true || column.is_primary_expiry === true),
  ) ?? columns.find(
    (column) => isActive(column) && column.type === 'date_expiry',
  ) ?? null;
}

/**
 * Column order is persisted in `app_columns.position` (SQLite is the source
 * of truth locally; `listColumns` already returns `ORDER BY position, id`).
 * Rendering must sort by position too — array order alone is not the
 * contract, and trusting it is what made a dragged column snap back to its
 * persisted slot on the next rebuild. The sort is stable: equal/missing
 * positions keep their incoming relative order, so legacy snapshots render
 * deterministically until a reorder normalizes positions to 0..n-1.
 */
export function sortColumnsByPosition(
  columns: readonly ColumnDefinition[],
): ColumnDefinition[] {
  return columns
    .map((column, index) => ({ column, index }))
    .sort((left, right) => {
      const leftPosition = left.column.position ?? left.index;
      const rightPosition = right.column.position ?? right.index;
      return leftPosition - rightPosition || left.index - right.index;
    })
    .map((entry) => entry.column);
}

/** The user-visible sheet columns in their persisted display order. */
export function orderedActiveColumns(
  columns: readonly ColumnDefinition[],
): ColumnDefinition[] {
  return sortColumnsByPosition(columns)
    .filter((column) => column.deleted !== true && column.visible !== false);
}

/**
 * Apply a user-chosen column order, returning a NEW column list whose
 * active columns carry normalized positions (0..n-1, no gaps/duplicates).
 *
 * `orderedIds` lists active user columns in their new display order. Any
 * active column it omits (e.g. a hidden column the grid never displayed)
 * keeps its current relative order after the listed ones. Deleted columns
 * are returned untouched. Unknown, duplicate and system-column ids are
 * ignored defensively — a grid can report ids (`__actions`, `daysLeft`, …)
 * that must never be persisted. Only `position` changes: identity, name,
 * type, options, visibility, passport and primary-expiry flags all survive.
 */
export function applyColumnOrder(
  columns: readonly ColumnDefinition[],
  orderedIds: readonly string[],
): ColumnDefinition[] {
  const current = sortColumnsByPosition(columns);
  const byId = new Map(current.map((column) => [column.id, column]));
  const listed: ColumnDefinition[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (typeof id !== 'string' || seen.has(id) || isGridSystemColumnId(id)) {
      continue;
    }
    const column = byId.get(id);
    if (!column || column.deleted === true) {
      continue;
    }
    seen.add(id);
    listed.push(column);
  }
  const unlistedActive = current.filter(
    (column) => column.deleted !== true && !seen.has(column.id),
  );
  const deleted = current.filter((column) => column.deleted === true);
  return [
    ...[...listed, ...unlistedActive].map((column, position) => ({ ...column, position })),
    ...deleted.map((column) => ({ ...column })),
  ];
}

function sameIdSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Derive the persistable user-column order from the grid's displayed column
 * ids (which include the system columns), or null when there is nothing to
 * save. Returning null for "same order as already persisted" is the guard
 * that keeps programmatic refreshes (defs rebuilt from a snapshot) from
 * echoing back as reorder writes — no sync/outbox write loop.
 */
export function extractUserColumnOrder(
  displayedColumnIds: readonly string[],
  columns: readonly ColumnDefinition[],
): string[] | null {
  const currentIds = orderedActiveColumns(columns).map((column) => column.id);
  const currentSet = new Set(currentIds);
  const userIds = displayedColumnIds.filter((id) => currentSet.has(id));
  if (userIds.length !== currentIds.length || new Set(userIds).size !== userIds.length) {
    return null;
  }
  return sameIdSequence(userIds, currentIds) ? null : userIds;
}

export function validateColumnDefinitions(
  columns: readonly ColumnDefinition[],
): ColumnValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const active = columns.filter(isActive);
  const activeExpiry = active.filter((column) => column.type === 'date_expiry');
  const primaries = active.filter(
    (column) => column.isPrimaryExpiry === true || column.is_primary_expiry === true,
  );

  for (const column of columns) {
    if (!column.id.trim()) {
      errors.push('Column ids are required');
    }
    if (!column.name.trim()) {
      errors.push('Column names are required');
    }
    if (!isSupportedColumnType(column.type)) {
      errors.push(`Unsupported column type: ${String(column.type)}`);
    }

    const id = normaliseIdentity(column.id);
    const name = normaliseIdentity(column.name);
    if (id && ids.has(id)) {
      errors.push(`Duplicate column id: ${column.id}`);
    }
    if (name && names.has(name)) {
      errors.push(`Duplicate column name: ${column.name}`);
    }
    ids.add(id);
    names.add(name);

    if ((column.isPrimaryExpiry || column.is_primary_expiry) && column.type !== 'date_expiry') {
      errors.push('The primary expiry column must use date_expiry type');
    }
  }

  if (activeExpiry.length > 0 && primaries.length !== 1) {
    errors.push('Exactly one active primary expiry column is required');
  }

  return { valid: errors.length === 0, errors };
}

export const validateColumns = validateColumnDefinitions;

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value === 'string' ? value.trim().length > 0 : true;
}

export function activeRowHasColumnValue(
  rows: readonly GridRowLike[],
  column: Pick<ColumnDefinition, 'id' | 'name'>,
): boolean {
  return rows.some((row) => {
    if (row.deleted === true) {
      return false;
    }

    const data = row.data ?? row as unknown as Record<string, unknown>;
    return hasValue(data[column.name]) || (
      column.id !== column.name && hasValue(data[column.id])
    );
  });
}

/**
 * Why a column currently cannot be deleted, or null when it can.
 *   - 'system'      → the generated Days Left column (id `daysLeft`)
 *   - 'primary'     → the LIVE date_expiry primary
 *   - 'office-data' → an office role asked to delete a populated column
 */
export function columnDeleteBlockReason(
  column: ColumnDefinition,
  role: 'admin' | 'office' | string,
  rows: readonly GridRowLike[] = [],
): 'system' | 'primary' | 'office-data' | null {
  if (isDaysLeftColumn(column)) {
    return 'system';
  }
  if (isLivePrimaryExpiryColumn(column)) {
    return 'primary';
  }
  if (role === 'admin') {
    return null;
  }
  if (role === 'office') {
    return activeRowHasColumnValue(rows, column) ? 'office-data' : null;
  }
  return 'office-data';
}

/** Office users may soft-delete only empty, non-protected user columns. */
export function canDeleteColumnForOffice(
  column: ColumnDefinition,
  activeRows: readonly GridRowLike[],
): boolean {
  return columnDeleteBlockReason(column, 'office', activeRows) === null;
}

export function canDeleteColumn(
  column: ColumnDefinition,
  role: 'admin' | 'office' | string,
  rows: readonly GridRowLike[] = [],
): boolean {
  return columnDeleteBlockReason(column, role, rows) === null;
}

export const canOfficeDeleteColumn = canDeleteColumnForOffice;
export const canDeleteOfficeColumn = canDeleteColumnForOffice;
export const isProtectedColumn = isDaysLeftColumn;
export const ensurePrimaryExpiryColumn = normalizeColumns;
export const ensureExactlyOnePrimaryExpiry = normalizeColumns;

export function assertColumnDefinitions(columns: readonly ColumnDefinition[]): void {
  const result = validateColumnDefinitions(columns);
  if (!result.valid) {
    throw new Error(result.errors.join('; '));
  }
}

export function softDeleteColumnForOffice(
  columns: readonly ColumnDefinition[],
  columnId: string,
  activeRows: readonly GridRowLike[],
): ColumnDefinition[] {
  const target = columns.find((column) => column.id === columnId);
  if (!target || !canDeleteColumnForOffice(target, activeRows)) {
    return [...columns];
  }

  return columns.map((column) => (
    column.id === columnId
      ? { ...column, deleted: true, visible: false }
      : { ...column }
  ));
}

export function dropdownValues(options: DropdownOptions | undefined): readonly string[] {
  if (Array.isArray(options)) {
    return options as readonly string[];
  }

  if (!options || typeof options !== 'object') {
    return [];
  }

  const objectOptions = options as Exclude<DropdownOptions, readonly string[]>;
  return objectOptions.values ?? objectOptions.options ?? objectOptions.choices ?? [];
}
