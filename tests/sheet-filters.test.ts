import { describe, expect, it } from 'vitest';

import {
  QUICK_FILTERS,
  STATUS_FILTER_OPTIONS,
  matchesExpiringSoon,
  matchesQuickFilter,
} from '../src/features/sheet/filters';

/**
 * R2-04 — final Status dropdown + date chips (user decision).
 */
describe('sheet status dropdown and quick chips (R2-04)', () => {
  it('offers exactly the five agreed status options', () => {
    expect(STATUS_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      'All statuses',
      'Valid',
      'Expiring soon',
      'Expired',
      'No expiry',
    ]);
    const labels = STATUS_FILTER_OPTIONS.map((option) => option.label).join(' ');
    expect(labels).not.toContain('Urgent');
    expect(labels).not.toContain('Expires today');
  });

  it('offers exactly the five agreed date chips (no Expired / No expiry chip)', () => {
    expect(QUICK_FILTERS.filter((filter) => filter.id !== 'all').map((filter) => filter.label))
      .toEqual(['Today', '≤7d', '≤30d', '≤60d', '≤90d']);
  });

  it('implements the chip ranges: Today = 0, ≤Nd = 0…N, never past dates', () => {
    expect(matchesQuickFilter(0, 'today')).toBe(true);
    expect(matchesQuickFilter(1, 'today')).toBe(false);
    expect(matchesQuickFilter(-1, 'today')).toBe(false);

    expect(matchesQuickFilter(7, '7')).toBe(true);
    expect(matchesQuickFilter(0, '7')).toBe(true);
    expect(matchesQuickFilter(8, '7')).toBe(false);
    expect(matchesQuickFilter(-1, '7')).toBe(false);

    expect(matchesQuickFilter(30, '30')).toBe(true);
    expect(matchesQuickFilter(31, '30')).toBe(false);
    expect(matchesQuickFilter(null, '90')).toBe(false);
  });

  it('treats "Expiring soon" as every non-expired row up to the threshold', () => {
    for (const days of [0, 1, 7, 30, 89, 90]) {
      expect(matchesExpiringSoon(days, 90)).toBe(true);
    }
    expect(matchesExpiringSoon(91, 90)).toBe(false);
    expect(matchesExpiringSoon(-1, 90)).toBe(false);
    expect(matchesExpiringSoon(null, 90)).toBe(false);
    // Custom workspace threshold (expiring-soon = 60 days).
    expect(matchesExpiringSoon(60, 60)).toBe(true);
    expect(matchesExpiringSoon(61, 60)).toBe(false);
  });
});
