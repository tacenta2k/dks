import {
  dropdownValues,
  type ColumnDefinition,
  type GridRowLike,
} from './columns';
import { isValidIsoDate, normalizeUserDateToIso } from './date';

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

/**
 * Normalise passport-like values for duplicate comparisons only.
 *
 * Passport numbers are plain text (F1): customers come from India, Pakistan,
 * Bangladesh, Oman and elsewhere, so no country-specific format is enforced.
 * Case and spacing differences are treated as the same value for the advisory
 * duplicate warning; the stored text itself is never rewritten.
 */
export function normalizePassportValue(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, '').toUpperCase()
    : '';
}

export const normalizePassport = normalizePassportValue;
export const normalizeOmanPassport = normalizePassportValue;
export const normaliseOmanPassport = normalizePassportValue;

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
  return new Set(Array.from(values ?? [], (value) => normalizePassportValue(value)));
}

/**
 * Return visual diagnostics for a cell.  This helper never throws and keeps
 * duplicate passport values as warnings so office users can still save a row.
 *
 * F1: passport values are plain text — no country-specific format check may
 * block saving.  Phone/email/number format issues stay visual-only warnings
 * where documented, and real type errors (dropdown/checkbox/number) only mark
 * the cell without throwing.
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
    // Plain text: never a format error. The only advisory diagnostic is a
    // non-blocking duplicate warning.
    const duplicates = options.duplicatePassportValues ?? options.duplicateValues;
    if (
      options.duplicatePassport === true
      || duplicateSet(duplicates).has(normalizePassportValue(value))
    ) {
      return warning('Duplicate passport value', 'duplicate-passport');
    }

    return ok();
  }

  switch (column.type) {
    case 'phone':
      return isPhone(value) ? ok() : warning('Enter a valid phone number', 'phone');
    case 'email':
      return isEmail(value) ? ok() : warning('Enter a valid email address', 'email');
    case 'number':
      return isFiniteNumber(value) ? ok() : error('Enter a number', 'number');
    case 'price':
      return isFiniteNumber(value) && hasAtMostThreeDecimals(value)
        ? ok()
        : error('Enter a price with up to 3 decimals', 'price');
    case 'date_start':
    case 'date_expiry':
      // Stored values are ISO; what-you-type/paste may be DD/MM/YYYY. An
      // impossible calendar date (31/02/2026) keeps its text and shows a
      // warning — it is never silently converted to a different date.
      if (isValidIsoDate(value)) {
        return ok();
      }
      if (typeof value === 'string') {
        const normalized = normalizeUserDateToIso(value);
        if (normalized.impossible) {
          return warning('Impossible date — check the day and month', 'date');
        }
        if (normalized.iso) {
          return ok();
        }
      }
      return error('Enter a date as DD/MM/YYYY', 'date');
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
 * Empty values are ignored; duplicate detection is advisory only and compares
 * plain text (no country-specific format requirement).
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
    if (isEmpty(raw)) {
      continue;
    }

    const normalized = normalizePassportValue(raw);
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return new Set(Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value));
}

export const duplicatePassportValues = findDuplicatePassportValues;
export const findDuplicatePassports = findDuplicatePassportValues;
export const detectDuplicatePassports = findDuplicatePassportValues;
