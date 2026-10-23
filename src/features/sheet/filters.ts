import {
  calculateDaysLeft,
  statusForDays,
  type ExpiryStatus,
  type StatusThresholds,
} from '../../lib/date';
import { getPrimaryExpiryColumn, type ColumnDefinition } from '../../lib/columns';
import type { SheetRow } from './types';

/**
 * R2-04 (user decision, overrides FIXES_UI §5.2 for these two lists):
 *
 * Status dropdown: All statuses · Valid · Expiring soon · Expired · No expiry
 *   "Urgent" and "Expires today" are gone from the dropdown — they still exist
 *   as row colours / Days Left badges.
 *
 * Quick chips: Today · ≤7d · ≤30d · ≤60d · ≤90d
 *   The old "Expired" and "No expiry" chips are gone (they live in the
 *   dropdown). Chips are single-select and clicking the active chip clears it.
 */
export type QuickFilter = 'all' | 'today' | '7' | '30' | '60' | '90';

export const QUICK_FILTERS: ReadonlyArray<{ id: QuickFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: '7', label: '≤7d' },
  { id: '30', label: '≤30d' },
  { id: '60', label: '≤60d' },
  { id: '90', label: '≤90d' },
];

/** Status dropdown values (R2-04). */
export type StatusFilterValue = '' | 'Valid' | 'Expiring soon' | 'Expired' | 'No expiry';

export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: StatusFilterValue; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'Valid', label: 'Valid' },
  { value: 'Expiring soon', label: 'Expiring soon' },
  { value: 'Expired', label: 'Expired' },
  { value: 'No expiry', label: 'No expiry' },
];

export const DEFAULT_EXPIRING_SOON_THRESHOLD = 90;

export interface SheetFilterOptions {
  search?: string;
  quickFilter?: QuickFilter;
  status?: StatusFilterValue | ExpiryStatus | 'No expiry' | '';
  today?: string | Date;
  /**
   * R2-04: "Expiring soon" = every non-expired row with
   * `0 <= days left <= threshold`.
   */
  expiringSoonThreshold?: number;
  /** Workspace status thresholds (Valid / Expired stay consistent with them). */
  thresholds?: StatusThresholds;
}

function valueForColumn(row: SheetRow, column: ColumnDefinition): unknown {
  return row.data[column.id] ?? row.data[column.name];
}

export function primaryExpiryValue(
  row: SheetRow,
  columns: readonly ColumnDefinition[],
): string | null {
  const primary = getPrimaryExpiryColumn(columns);
  if (!primary) {
    return null;
  }

  const value = valueForColumn(row, primary);
  return typeof value === 'string' && value.trim() ? value : null;
}

export function daysLeftForRow(
  row: SheetRow,
  columns: readonly ColumnDefinition[],
  today?: string | Date,
): number | null {
  return calculateDaysLeft(primaryExpiryValue(row, columns), today);
}

export function statusForRow(
  row: SheetRow,
  columns: readonly ColumnDefinition[],
  today?: string | Date,
): ExpiryStatus | null {
  return statusForDays(daysLeftForRow(row, columns, today));
}

export function matchesQuickFilter(daysLeft: number | null, filter: QuickFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (daysLeft === null) {
    return false;
  }
  if (filter === 'today') {
    // "Today" means exactly 0 days left. Past dates are never in a future chip.
    return daysLeft === 0;
  }

  const upperBound = Number(filter);
  return daysLeft >= 0 && daysLeft <= upperBound;
}

/**
 * R2-04: "Expiring soon" covers every non-expired row from today (0 days) up
 * to the expiring-soon threshold. It is deliberately NOT `statusForDays()`'s
 * "Expiring Soon" band (which excludes the urgent/today rows).
 */
export function matchesExpiringSoon(
  daysLeft: number | null,
  threshold = DEFAULT_EXPIRING_SOON_THRESHOLD,
): boolean {
  return daysLeft !== null && daysLeft >= 0 && daysLeft <= threshold;
}

export function matchesStatusFilter(
  status: StatusFilterValue | ExpiryStatus | 'No expiry' | '',
  daysLeft: number | null,
  threshold = DEFAULT_EXPIRING_SOON_THRESHOLD,
): boolean {
  if (!status) {
    return true;
  }
  if (status === 'No expiry') {
    return daysLeft === null;
  }
  if (status === 'Expiring soon') {
    return matchesExpiringSoon(daysLeft, threshold);
  }
  if (status === 'Expired') {
    // Today (0 days) is never Expired; Expired is strictly past dates.
    return daysLeft !== null && daysLeft < 0;
  }
  if (status === 'Valid') {
    return daysLeft !== null && daysLeft > threshold;
  }
  return statusForDays(daysLeft) === status;
}

function searchableText(row: SheetRow, columns: readonly ColumnDefinition[]): string {
  return [
    row.id,
    row.category ?? '',
    ...columns.map((column) => valueForColumn(row, column)),
  ]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join(' ');
}

export function filterRows(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options: SheetFilterOptions = {},
): SheetRow[] {
  const search = options.search?.trim().toLowerCase() ?? '';
  const quickFilter = options.quickFilter ?? 'all';
  const threshold = options.expiringSoonThreshold
    ?? options.thresholds?.expiringSoonFrom
    ?? DEFAULT_EXPIRING_SOON_THRESHOLD;

  return rows.filter((row) => {
    if (row.deleted === true) {
      return false;
    }

    const daysLeft = daysLeftForRow(row, columns, options.today);

    return (!search || searchableText(row, columns).includes(search))
      && matchesQuickFilter(daysLeft, quickFilter)
      && matchesStatusFilter(options.status ?? '', daysLeft, threshold);
  });
}
