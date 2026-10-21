import { getPrimaryExpiryColumn, type ColumnDefinition } from '../../lib/columns';
import {
  colorForStatus,
  DEFAULT_STATUS_COLORS,
  statusForDays,
  type StatusColors,
} from '../../lib/domain';
import {
  calculateDaysLeft,
  isValidIsoDate,
  type ExpiryStatus,
  type StatusThresholds,
} from '../../lib/date';
import type { SheetRow } from '../sheet/types';

export type DashboardFilterId =
  | 'all'
  | 'expiringToday'
  | 'expiringThisWeek'
  | 'expiringThisMonth'
  | 'within2Months'
  | 'within3Months'
  | 'within6Months'
  | 'within1Year'
  | 'expired';

export interface DashboardCard {
  id: DashboardFilterId;
  label: string;
  count: number;
}

export interface DashboardStatusDatum {
  name: ExpiryStatus;
  value: number;
  color: string;
}

export interface DashboardMonthDatum {
  key: string;
  month: string;
  count: number;
}

export interface DashboardSummary {
  totalEntries: number;
  cards: DashboardCard[];
  statusPie: DashboardStatusDatum[];
  nextTwelveMonths: DashboardMonthDatum[];
}

export interface DashboardSelectorOptions {
  today?: string | Date;
  thresholds?: StatusThresholds;
  colors?: Partial<StatusColors> | Record<string, string>;
}

export const DASHBOARD_CARD_DEFINITIONS: ReadonlyArray<
  Pick<DashboardCard, 'id' | 'label'>
> = Object.freeze([
  { id: 'all', label: 'Total entries' },
  { id: 'expiringToday', label: 'Expiring today' },
  { id: 'expiringThisWeek', label: 'Expiring this week' },
  { id: 'expiringThisMonth', label: 'Expiring this month' },
  { id: 'within2Months', label: 'Within 2 months' },
  { id: 'within3Months', label: 'Within 3 months' },
  { id: 'within6Months', label: 'Within 6 months' },
  { id: 'within1Year', label: 'Within 1 year' },
  { id: 'expired', label: 'Expired' },
]);

const STATUS_ORDER: readonly ExpiryStatus[] = [
  'Valid',
  'Expiring Soon',
  'Urgent',
  'Expires today',
  'Expired',
];

interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

function calendarParts(value?: string | Date): CalendarParts {
  if (typeof value === 'string' && isValidIsoDate(value)) {
    return {
      year: Number(value.slice(0, 4)),
      month: Number(value.slice(5, 7)),
      day: Number(value.slice(8, 10)),
    };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }

  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function dataValue(row: SheetRow, column: ColumnDefinition | null): unknown {
  if (!column) {
    return null;
  }

  return row.data[column.id] ?? row.data[column.name] ?? null;
}

function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year: number, monthIndex: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthIndex, 1)));
}

function monthOffset(year: number, month: number, startYear: number, startMonth: number): number {
  return (year - startYear) * 12 + month - startMonth;
}

function withinDays(days: number | null, maximum: number): boolean {
  // Keep the window cards aligned with the sheet's quick filters: today has
  // its own card, while a future window starts tomorrow.
  return days !== null && days > 0 && days <= maximum;
}

/**
 * Build all dashboard aggregates from the same calendar-day and status helpers
 * used by the sheet.  The selector is pure so it can be reused by an offline
 * store, tests, or a future remote repository without changing the UI.
 */
export function getDashboardSummary(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options: DashboardSelectorOptions = {},
): DashboardSummary {
  const primaryExpiry = getPrimaryExpiryColumn(columns);
  const activeRows = rows.filter((row) => row.deleted !== true);
  const thresholds = options.thresholds ?? {};
  const colors = options.colors ?? DEFAULT_STATUS_COLORS;
  const daysByRow = activeRows.map((row) => {
    const expiryValue = dataValue(row, primaryExpiry);
    const expiry = typeof expiryValue === 'string' && isValidIsoDate(expiryValue)
      ? expiryValue
      : null;
    const days = calculateDaysLeft(expiry, options.today);
    return { expiry, days, status: statusForDays(days, thresholds) };
  });

  const countWithin = (maximum: number) => daysByRow.filter(({ days }) => withinDays(days, maximum)).length;
  // "Expires today" (days = 0) is a distinct status; Expired counts only
  // dates that have already passed.
  const expiredCount = daysByRow.filter(({ status }) => status === 'Expired').length;
  const cardCounts: Record<DashboardFilterId, number> = {
    all: activeRows.length,
    expiringToday: daysByRow.filter(({ days }) => days === 0).length,
    expiringThisWeek: countWithin(7),
    expiringThisMonth: countWithin(30),
    within2Months: countWithin(60),
    within3Months: countWithin(90),
    within6Months: countWithin(180),
    within1Year: countWithin(365),
    expired: expiredCount,
  };

  const cards = DASHBOARD_CARD_DEFINITIONS.map(({ id, label }) => ({
    id,
    label,
    count: cardCounts[id],
  }));

  const statusCounts = new Map<ExpiryStatus, number>(STATUS_ORDER.map((status) => [status, 0]));
  for (const { status } of daysByRow) {
    if (status) {
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
  }

  const statusPie = STATUS_ORDER.map((status) => ({
    name: status,
    value: statusCounts.get(status) ?? 0,
    color: colorForStatus(status, colors) ?? DEFAULT_STATUS_COLORS[status],
  }));

  const today = calendarParts(options.today);
  const nextTwelveMonths = Array.from({ length: 12 }, (_, offset) => {
    const absoluteMonth = today.month - 1 + offset;
    const year = today.year + Math.floor(absoluteMonth / 12);
    const monthNumber = (absoluteMonth % 12) + 1;
    const key = monthKey(year, monthNumber);
    const count = daysByRow.filter(({ expiry, days }) => {
      if (!expiry || days === null || days < 0) {
        return false;
      }
      const expiryYear = Number(expiry.slice(0, 4));
      const expiryMonth = Number(expiry.slice(5, 7));
      return monthOffset(expiryYear, expiryMonth, today.year, today.month) === offset;
    }).length;

    return {
      key,
      month: monthLabel(year, monthNumber - 1),
      count,
    };
  });

  return {
    totalEntries: activeRows.length,
    cards,
    statusPie,
    nextTwelveMonths,
  };
}

export const selectDashboardSummary = getDashboardSummary;
export const buildDashboardSummary = getDashboardSummary;
export const buildStatusPieData = (
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options?: DashboardSelectorOptions,
) => getDashboardSummary(rows, columns, options).statusPie;
export const buildNextTwelveMonths = (
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options?: DashboardSelectorOptions,
) => getDashboardSummary(rows, columns, options).nextTwelveMonths;
