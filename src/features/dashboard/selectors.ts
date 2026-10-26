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
import type { DaysLeftRange, QuickFilter, StatusFilterValue } from '../sheet/filters';

export type DashboardFilterId =
  | 'all'
  | 'expiresToday'
  | 'expiresIn1Day'
  | 'expiringThisWeek'
  | 'expiringThisMonth'
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

/**
 * The exact nine summary cards, in display order. Windows are CUMULATIVE
 * and start at day 0: an entry expiring today is inside the 1-day, week,
 * month, 3-month, 6-month and 1-year cards (it is never "Expired" — that
 * card is strictly daysLeft < 0), and additionally has its own
 * "Expires today" card (daysLeft === 0; the overlap with the 1-day card is
 * intentional). Entries with no usable expiry count only toward
 * "Total entries".
 */
export const DASHBOARD_CARD_DEFINITIONS: ReadonlyArray<
  Pick<DashboardCard, 'id' | 'label'>
> = Object.freeze([
  { id: 'all', label: 'Total entries' },
  { id: 'expiresToday', label: 'Expires today' },
  { id: 'expiresIn1Day', label: 'Expires in 1 day' },
  { id: 'expiringThisWeek', label: 'This week' },
  { id: 'expiringThisMonth', label: 'This month' },
  { id: 'within3Months', label: '3 months' },
  { id: 'within6Months', label: '6 months' },
  { id: 'within1Year', label: '1 year' },
  { id: 'expired', label: 'Expired' },
]);

/** Inclusive upper bound (days left) for each cumulative upcoming window. */
export const DASHBOARD_WINDOW_MAX_DAYS: Partial<Record<DashboardFilterId, number>> = Object.freeze({
  expiresIn1Day: 1,
  expiringThisWeek: 7,
  expiringThisMonth: 30,
  within3Months: 90,
  within6Months: 180,
  within1Year: 365,
});

export interface DashboardSheetFilter {
  quickFilter: QuickFilter;
  status: StatusFilterValue;
  daysRange: DaysLeftRange | null;
}

/**
 * The exact Visa Sheet filter for a dashboard card: the filtered sheet shows
 * precisely the rows the card counted. Existing sheet filters are reused
 * where they are already equivalent (≤7d/≤30d/≤90d chips are 0-based
 * cumulative ranges; "Expired" is the status dropdown). The 1-day, 6-month
 * and 1-year cards have no chip, so they use the sheet's internal exact
 * days-range filter instead — the visible chip set is unchanged.
 */
export function dashboardSheetFilter(filter: DashboardFilterId): DashboardSheetFilter {
  switch (filter) {
    case 'all':
      return { quickFilter: 'all', status: '', daysRange: null };
    case 'expiresToday':
      // The existing "Today" chip is exactly daysLeft === 0.
      return { quickFilter: 'today', status: '', daysRange: null };
    case 'expiresIn1Day':
      return { quickFilter: 'all', status: '', daysRange: { min: 0, max: 1 } };
    case 'expiringThisWeek':
      return { quickFilter: '7', status: '', daysRange: null };
    case 'expiringThisMonth':
      return { quickFilter: '30', status: '', daysRange: null };
    case 'within3Months':
      return { quickFilter: '90', status: '', daysRange: null };
    case 'within6Months':
      return { quickFilter: 'all', status: '', daysRange: { min: 0, max: 180 } };
    case 'within1Year':
      return { quickFilter: 'all', status: '', daysRange: { min: 0, max: 365 } };
    case 'expired':
      return { quickFilter: 'all', status: 'Expired', daysRange: null };
    default:
      return { quickFilter: 'all', status: '', daysRange: null };
  }
}

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
  // Cumulative windows include day 0: an entry expiring TODAY is inside
  // every upcoming card (1-day through 1-year) and is never Expired.
  return days !== null && days >= 0 && days <= maximum;
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
  // Expired is strictly past dates (daysLeft < 0); day 0 belongs to every
  // upcoming cumulative window instead.
  const expiredCount = daysByRow.filter(({ days }) => days !== null && days < 0).length;
  const cardCounts: Record<DashboardFilterId, number> = {
    all: activeRows.length,
    expiresToday: daysByRow.filter(({ days }) => days === 0).length,
    expiresIn1Day: countWithin(DASHBOARD_WINDOW_MAX_DAYS.expiresIn1Day!),
    expiringThisWeek: countWithin(DASHBOARD_WINDOW_MAX_DAYS.expiringThisWeek!),
    expiringThisMonth: countWithin(DASHBOARD_WINDOW_MAX_DAYS.expiringThisMonth!),
    within3Months: countWithin(DASHBOARD_WINDOW_MAX_DAYS.within3Months!),
    within6Months: countWithin(DASHBOARD_WINDOW_MAX_DAYS.within6Months!),
    within1Year: countWithin(DASHBOARD_WINDOW_MAX_DAYS.within1Year!),
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
