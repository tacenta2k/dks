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
 * The first active date_expiry definition is always the single primary.
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

  return copied.map((column, index) => ({
    ...column,
    isPrimaryExpiry: firstExpiryIndex >= 0 && index === firstExpiryIndex,
    is_primary_expiry: firstExpiryIndex >= 0 && index === firstExpiryIndex,
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
