import {
  calculateDaysLeft,
  statusForDays,
  type ExpiryStatus,
} from '../../lib/date';
import { getPrimaryExpiryColumn, type ColumnDefinition } from '../../lib/columns';
import type { SheetRow } from './types';

export type QuickFilter = 'all' | 'expired' | '7' | '30' | '60' | '90' | 'no-expiry';

export const QUICK_FILTERS: ReadonlyArray<{ id: QuickFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'expired', label: 'Expired' },
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '60', label: '60 days' },
  { id: '90', label: '90 days' },
  { id: 'no-expiry', label: 'No expiry' },
];

export interface SheetFilterOptions {
  search?: string;
  quickFilter?: QuickFilter;
  status?: ExpiryStatus | 'No expiry' | '';
  today?: string | Date;
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

function matchesQuickFilter(daysLeft: number | null, filter: QuickFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'no-expiry') {
    return daysLeft === null;
  }
  if (daysLeft === null) {
    return false;
  }
  if (filter === 'expired') {
    // "Today" (Days Left = 0) is never Expired; Expired is strictly past dates.
    return daysLeft < 0;
  }

  const upperBound = Number(filter);
  return daysLeft >= 0 && daysLeft <= upperBound;
}

export { matchesQuickFilter };

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

  return rows.filter((row) => {
    if (row.deleted === true) {
      return false;
    }

    const daysLeft = daysLeftForRow(row, columns, options.today);
    const status = statusForDays(daysLeft);

    return (!search || searchableText(row, columns).includes(search))
      && matchesQuickFilter(daysLeft, quickFilter)
      && (!options.status || (options.status === 'No expiry' ? status === null : status === options.status));
  });
}
