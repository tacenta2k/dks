import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_CARD_DEFINITIONS,
  dashboardSheetFilter,
  getDashboardSummary,
  type DashboardFilterId,
} from '../src/features/dashboard/selectors';
import {
  QUICK_FILTERS,
  STATUS_FILTER_OPTIONS,
  filterRows,
  matchesQuickFilter,
  matchesStatusFilter,
} from '../src/features/sheet/filters';
import { REPORT_FILTERS } from '../src/features/print/print-service';
import type { ColumnDefinition } from '../src/lib/columns';
import type { SheetRow } from '../src/features/sheet/types';

const TODAY = '2026-01-01';
const columns: ColumnDefinition[] = [
  { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true },
];

function isoPlusDays(days: number): string {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const BOUNDARY_DAYS = [-1, 0, 1, 2, 7, 8, 30, 31, 90, 91, 180, 181, 365, 366];

function boundaryRows(): SheetRow[] {
  return [
    ...BOUNDARY_DAYS.map((days) => ({
      id: `day-${days}`,
      data: { visa_expiry: isoPlusDays(days) },
    })),
    { id: 'no-expiry', data: {} },
    { id: 'invalid-expiry', data: { visa_expiry: '31/02/2026' } },
    { id: 'deleted-today', data: { visa_expiry: isoPlusDays(0) }, deleted: true },
  ];
}

function cardCount(id: DashboardFilterId, rows: SheetRow[]): number {
  const summary = getDashboardSummary(rows, columns, { today: TODAY });
  return summary.cards.find((card) => card.id === id)?.count ?? -1;
}

describe('dashboard cumulative card set', () => {
  it('defines exactly the nine cards in the specified order', () => {
    expect(DASHBOARD_CARD_DEFINITIONS).toEqual([
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
    const labels = DASHBOARD_CARD_DEFINITIONS.map((card) => card.label);
    expect(labels).not.toContain('Within 2 months');
  });

  it('counts every window boundary exactly (0-based cumulative)', () => {
    const rows = boundaryRows();
    expect(cardCount('all', rows)).toBe(16);
    expect(cardCount('expiresToday', rows)).toBe(1); // day 0 only
    expect(cardCount('expiresIn1Day', rows)).toBe(2); // days 0, 1
    expect(cardCount('expiringThisWeek', rows)).toBe(4); // + 2, 7
    expect(cardCount('expiringThisMonth', rows)).toBe(6); // + 8, 30
    expect(cardCount('within3Months', rows)).toBe(8); // + 31, 90
    expect(cardCount('within6Months', rows)).toBe(10); // + 91, 180
    expect(cardCount('within1Year', rows)).toBe(12); // + 181, 365
    expect(cardCount('expired', rows)).toBe(1); // day -1 only
  });

  it('puts day 0 in every upcoming card and never in Expired', () => {
    const rows: SheetRow[] = [{ id: 'today', data: { visa_expiry: TODAY } }];
    for (const id of ['expiresToday', 'expiresIn1Day', 'expiringThisWeek', 'expiringThisMonth', 'within3Months', 'within6Months', 'within1Year'] as const) {
      expect(cardCount(id, rows)).toBe(1);
    }
    expect(cardCount('expired', rows)).toBe(0);
    expect(cardCount('all', rows)).toBe(1);
  });

  it('counts Expires today as exactly day 0 (not -1, 1, or 2)', () => {
    const rows: SheetRow[] = [-1, 0, 1, 2].map((days) => ({
      id: `d${days}`,
      data: { visa_expiry: isoPlusDays(days) },
    }));
    expect(cardCount('expiresToday', rows)).toBe(1);
    // The intentional overlap: day 0 is ALSO inside the 1-day card (0..1).
    expect(cardCount('expiresIn1Day', rows)).toBe(2);
    expect(cardCount('expired', rows)).toBe(1);
    const todaySet = filterRows(rows, columns, { today: TODAY, ...dashboardSheetFilter('expiresToday') });
    expect(todaySet.map((row) => row.id)).toEqual(['d0']);
  });

  it('counts null/invalid expiry only in Total entries', () => {
    const rows: SheetRow[] = [
      { id: 'blank', data: {} },
      { id: 'empty', data: { visa_expiry: '' } },
      { id: 'impossible', data: { visa_expiry: '2026-02-30' } },
      { id: 'garbage', data: { visa_expiry: 'not-a-date' } },
    ];
    expect(cardCount('all', rows)).toBe(4);
    for (const id of ['expiresToday', 'expiresIn1Day', 'expiringThisWeek', 'expiringThisMonth', 'within3Months', 'within6Months', 'within1Year', 'expired'] as const) {
      expect(cardCount(id, rows)).toBe(0);
    }
  });

  it('keeps cumulative nesting: today ⊆ 1 day ⊆ week ⊆ month ⊆ 3m ⊆ 6m ⊆ 1y', () => {
    const rows = boundaryRows();
    const sets = (['expiresToday', 'expiresIn1Day', 'expiringThisWeek', 'expiringThisMonth', 'within3Months', 'within6Months', 'within1Year'] as const)
      .map((id) => new Set(filterRows(rows, columns, { today: TODAY, ...dashboardSheetFilter(id) }).map((row) => row.id)));
    for (let index = 1; index < sets.length; index += 1) {
      for (const rowId of sets[index - 1]) {
        expect(sets[index].has(rowId)).toBe(true);
      }
      expect(sets[index].size).toBeGreaterThan(sets[index - 1].size);
    }
  });

  it('maps every card to a sheet filter returning exactly the counted set', () => {
    const rows = boundaryRows();
    const summary = getDashboardSummary(rows, columns, { today: TODAY });
    for (const card of summary.cards) {
      const filtered = filterRows(rows, columns, { today: TODAY, ...dashboardSheetFilter(card.id) });
      expect(filtered.length).toBe(card.count);
    }

    // The 1-day card includes day 0 AND day 1 — and nothing else.
    const oneDay = filterRows(rows, columns, { today: TODAY, ...dashboardSheetFilter('expiresIn1Day') });
    expect(oneDay.map((row) => row.id).sort()).toEqual(['day-0', 'day-1']);

    // Expired is strictly the past; day 366 and no-expiry rows appear only in Total.
    const expired = filterRows(rows, columns, { today: TODAY, ...dashboardSheetFilter('expired') });
    expect(expired.map((row) => row.id)).toEqual(['day--1']);
    const total = filterRows(rows, columns, { today: TODAY, ...dashboardSheetFilter('all') });
    expect(total.map((row) => row.id)).toContain('day-366');
    expect(total.map((row) => row.id)).toContain('no-expiry');
    expect(total.map((row) => row.id)).not.toContain('deleted-today');
  });

  it('reuses existing sheet filters where they are exactly equivalent', () => {
    // The Today chip is exactly daysLeft === 0.
    expect(dashboardSheetFilter('expiresToday')).toEqual({ quickFilter: 'today', status: '', daysRange: null });
    expect(dashboardSheetFilter('expiringThisWeek')).toEqual({ quickFilter: '7', status: '', daysRange: null });
    expect(dashboardSheetFilter('expiringThisMonth')).toEqual({ quickFilter: '30', status: '', daysRange: null });
    expect(dashboardSheetFilter('within3Months')).toEqual({ quickFilter: '90', status: '', daysRange: null });
    expect(dashboardSheetFilter('expired')).toEqual({ quickFilter: 'all', status: 'Expired', daysRange: null });
    // No chip exists for these windows: exact internal ranges instead.
    expect(dashboardSheetFilter('expiresIn1Day').daysRange).toEqual({ min: 0, max: 1 });
    expect(dashboardSheetFilter('within6Months').daysRange).toEqual({ min: 0, max: 180 });
    expect(dashboardSheetFilter('within1Year').daysRange).toEqual({ min: 0, max: 365 });
  });
});

describe('sheet and print surfaces unchanged by the dashboard override', () => {
  it('keeps the visible quick-filter chips exactly as they were', () => {
    expect(QUICK_FILTERS).toEqual([
      { id: 'all', label: 'All' },
      { id: 'today', label: 'Today' },
      { id: '7', label: '≤7d' },
      { id: '30', label: '≤30d' },
      { id: '60', label: '≤60d' },
      { id: '90', label: '≤90d' },
    ]);
    // Chip semantics are untouched: Today is exactly day 0.
    expect(matchesQuickFilter(0, 'today')).toBe(true);
    expect(matchesQuickFilter(1, 'today')).toBe(false);
    expect(matchesQuickFilter(-1, 'today')).toBe(false);
    expect(matchesQuickFilter(60, '60')).toBe(true);
    expect(matchesQuickFilter(61, '60')).toBe(false);
    expect(matchesQuickFilter(null, 'all')).toBe(true);
  });

  it('keeps the status dropdown options and semantics', () => {
    expect(STATUS_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      '',
      'Valid',
      'Expiring soon',
      'Expired',
      'No expiry',
    ]);
    expect(matchesStatusFilter('Expired', -1)).toBe(true);
    expect(matchesStatusFilter('Expired', 0)).toBe(false);
    expect(matchesStatusFilter('No expiry', null)).toBe(true);
  });

  it('keeps the print report presets unchanged (including 2 months)', () => {
    expect(REPORT_FILTERS.map((filter) => [filter.id, filter.label, filter.maximumDays ?? null])).toEqual([
      ['today', 'Today', 0],
      ['week', 'Week', 7],
      ['month', 'Month', 30],
      ['2-months', '2 months', 60],
      ['3-months', '3 months', 90],
      ['6-months', '6 months', 180],
      ['1-year', '1 year', 365],
      ['expired', 'Expired', null],
      ['all', 'All', null],
    ]);
  });
});
