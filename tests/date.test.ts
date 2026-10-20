import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLDS,
  calculateDaysLeft,
  statusForDays,
} from '../src/lib/date';
import { colorForStatus, formatOmanRial } from '../src/lib/domain';

describe('local calendar expiry dates', () => {
  it('calculates days from ISO calendar dates without applying a timezone shift', () => {
    expect(calculateDaysLeft('2026-01-02', '2026-01-01')).toBe(1);
    expect(calculateDaysLeft('2026-01-01', '2026-01-02')).toBe(-1);
    expect(calculateDaysLeft('2024-03-01', '2024-02-28')).toBe(2);
  });

  it('returns null when the primary expiry is empty or not a valid ISO date', () => {
    expect(calculateDaysLeft('', '2026-01-01')).toBeNull();
    expect(calculateDaysLeft('   ', '2026-01-01')).toBeNull();
    expect(calculateDaysLeft(null, '2026-01-01')).toBeNull();
    expect(calculateDaysLeft('2026-02-30', '2026-01-01')).toBeNull();
  });

  it('uses the documented default status boundaries', () => {
    expect(statusForDays(91)).toBe('Valid');
    expect(statusForDays(90)).toBe('Expiring Soon');
    expect(statusForDays(30)).toBe('Expiring Soon');
    expect(statusForDays(29)).toBe('Urgent');
    expect(statusForDays(1)).toBe('Urgent');
    expect(statusForDays(0)).toBe('Expired');
    expect(statusForDays(-1)).toBe('Expired');
    expect(statusForDays(null)).toBeNull();
    expect(DEFAULT_THRESHOLDS.urgentFrom).toBe(1);
  });

  it('accepts custom threshold boundaries', () => {
    expect(statusForDays(121, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Valid');
    expect(statusForDays(60, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Expiring Soon');
    expect(statusForDays(6, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Urgent');
    expect(statusForDays(0, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Expired');
  });

  it('formats OMR with exactly three decimal places', () => {
    expect(formatOmanRial(12)).toBe('ر.ع. 12.000');
    expect(formatOmanRial(12.4)).toBe('ر.ع. 12.400');
    expect(formatOmanRial('12.3456')).toBe('ر.ع. 12.346');
  });

  it('uses default status colors and accepts per-status overrides', () => {
    expect(colorForStatus('Valid')).toMatch(/^#/);
    expect(colorForStatus('Urgent', { Urgent: '#123456' })).toBe('#123456');
    expect(colorForStatus('Expiring Soon', { expiringSoon: '#abcdef' })).toBe('#abcdef');
    expect(colorForStatus(null)).toBeNull();
  });
});
