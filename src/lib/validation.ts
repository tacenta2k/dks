import {
  dropdownValues,
  type ColumnDefinition,
  type GridRowLike,
} from './columns';
import { isValidIsoDate } from './date';

export type DiagnosticSeverity = 'none' | 'warning' | 'error';

export interface CellDiagnostic {
  /** False only when the value should be rejected by the editor. */
  valid: boolean;
  severity: DiagnosticSeverity;
  message?: string;
  code?: string;
}

export interface CellValidationOptions {
  duplicatePassportValues?: Iterable<string>;
  duplicateValues?: Iterable<string>;
  duplicatePassport?: boolean;
}

function ok(): CellDiagnostic {
  return { valid: true, severity: 'none' };
}

function warning(message: string, code: string): CellDiagnostic {
  return { valid: true, severity: 'warning', message, code };
}

function error(message: string, code: string): CellDiagnostic {
  return { valid: false, severity: 'error', message, code };
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (
    typeof value === 'string' && value.trim().length === 0
  );
}

/** Normalise the two accepted Oman passport representations for comparisons. */
export function normalizeOmanPassport(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, '').toUpperCase()
    : '';
}

/** Oman passport: one letter + seven digits, or eight digits; spaces ignored. */
export function isValidOmanPassport(value: unknown): boolean {
  const normalized = normalizeOmanPassport(value);
  return /^[A-Z]\d{7}$/.test(normalized) || /^\d{8}$/.test(normalized);
}

export const validateOmanPassport = isValidOmanPassport;
export const validatePassport = isValidOmanPassport;
export const isValidPassport = isValidOmanPassport;
export const normalizePassport = normalizeOmanPassport;
export const normaliseOmanPassport = normalizeOmanPassport;

function isFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim().replace(/,/g, '')));
}

function hasAtMostThreeDecimals(value: unknown): boolean {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return false;
    }
    return Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().replace(/,/g, '');
  return /^[-+]?\d+(?:\.\d{1,3})?$/.test(normalized);
}

function isEmail(value: unknown): boolean {
  return typeof value === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isPhone(value: unknown): boolean {
  if (typeof value !== 'string') {
    return typeof value === 'number' && Number.isFinite(value);
  }

  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  return /^[+]?[-()\s\d]+$/.test(trimmed) && digits.length >= 7;
}

function isCheckbox(value: unknown): boolean {
  return typeof value === 'boolean'
    || value === 0
    || value === 1
    || value === 'true'
    || value === 'false';
}

function duplicateSet(values: Iterable<string> | undefined): Set<string> {
  return new Set(Array.from(values ?? [], (value) => normalizeOmanPassport(value)));
}

/**
 * Return visual diagnostics for a cell.  This helper never throws and keeps
 * duplicate passport values as warnings so office users can still save a row.
 */
export function validateCell(
  value: unknown,
  column: ColumnDefinition,
  options: CellValidationOptions = {},
): CellDiagnostic {
  if (isEmpty(value)) {
    return ok();
  }

  const passportColumn = column.isPassport === true
    || column.is_passport === true
    || /passport/i.test(column.name);

  if (passportColumn) {
    if (!isValidOmanPassport(value)) {
      return error('Enter an Oman passport (one letter + 7 digits or 8 digits)', 'passport');
    }

    const duplicates = options.duplicatePassportValues ?? options.duplicateValues;
    if (
      options.duplicatePassport === true
      || duplicateSet(duplicates).has(normalizeOmanPassport(value))
    ) {
      return warning('Duplicate passport value', 'duplicate-passport');
    }

    return ok();
  }

  switch (column.type) {
    case 'phone':
      return isPhone(value) ? ok() : error('Enter a valid phone number', 'phone');
    case 'email':
      return isEmail(value) ? ok() : error('Enter a valid email address', 'email');
    case 'number':
      return isFiniteNumber(value) ? ok() : error('Enter a number', 'number');
    case 'price':
      return isFiniteNumber(value) && hasAtMostThreeDecimals(value)
        ? ok()
        : error('Enter a price with up to 3 decimals', 'price');
    case 'date_start':
    case 'date_expiry':
      return isValidIsoDate(value) ? ok() : error('Enter a valid ISO date (YYYY-MM-DD)', 'date');
    case 'dropdown':
      return dropdownValues(column.options).some((option) => option === String(value))
        ? ok()
        : error('Choose one of the configured options', 'dropdown');
    case 'checkbox':
      return isCheckbox(value) ? ok() : error('Enter a checkbox value', 'checkbox');
    case 'text':
    case 'notes':
      return ok();
    default:
      return ok();
  }
}

export const getCellDiagnostic = validateCell;
export const validateValue = validateCell;

function rowData(row: GridRowLike | Record<string, unknown>): Record<string, unknown> {
  if ('data' in row && row.data && typeof row.data === 'object') {
    return row.data as Record<string, unknown>;
  }
  return row as Record<string, unknown>;
}

/**
 * Return normalized passport values that occur in more than one active row.
 * Invalid and empty values are ignored; duplicate detection is advisory only.
 */
export function findDuplicatePassportValues(
  rows: readonly (GridRowLike | Record<string, unknown>)[],
  passportColumn: string | Pick<ColumnDefinition, 'id' | 'name'> = 'Passport',
): Set<string> {
  const columnNames = typeof passportColumn === 'string'
    ? [passportColumn]
    : [passportColumn.name, passportColumn.id];
  const counts = new Map<string, number>();

  for (const row of rows) {
    if ('deleted' in row && row.deleted === true) {
      continue;
    }

    const data = rowData(row);
    const raw = columnNames.map((name) => data[name]).find((value) => !isEmpty(value));
    if (isEmpty(raw) || !isValidOmanPassport(raw)) {
      continue;
    }

    const normalized = normalizeOmanPassport(raw);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return new Set(Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value));
}

export const duplicatePassportValues = findDuplicatePassportValues;
export const findDuplicatePassports = findDuplicatePassportValues;
export const detectDuplicatePassports = findDuplicatePassportValues;
