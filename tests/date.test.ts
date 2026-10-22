import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLDS,
  calculateDaysLeft,
  formatDateTyping,
  formatDisplayDate,
  normalizeUserDateToIso,
  statusForDays,
  toStorableDateValue,
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
    // "Today" is not "Expired": 0 days is its own status (FIXES_UI 9.2).
    expect(statusForDays(0)).toBe('Expires today');
    expect(statusForDays(-1)).toBe('Expired');
    expect(statusForDays(null)).toBeNull();
    expect(DEFAULT_THRESHOLDS.urgentFrom).toBe(1);
  });

  it('accepts custom threshold boundaries', () => {
    expect(statusForDays(121, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Valid');
    expect(statusForDays(60, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Expiring Soon');
    expect(statusForDays(6, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Urgent');
    expect(statusForDays(0, { validAbove: 120, expiringSoonFrom: 60, urgentFrom: 7 })).toBe('Expires today');
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

describe('user-facing DD/MM/YYYY dates (F2)', () => {
  it('displays ISO values as DD/MM/YYYY without timezone shifts', () => {
    expect(formatDisplayDate('2026-01-02')).toBe('02/01/2026');
    expect(formatDisplayDate('2026-12-31')).toBe('31/12/2026');
    expect(formatDisplayDate(null)).toBe('');
    expect(formatDisplayDate('')).toBe('');
  });

  it('inserts separators progressively while typing', () => {
    expect(formatDateTyping('1')).toBe('1');
    expect(formatDateTyping('10')).toBe('10/');
    expect(formatDateTyping('100')).toBe('10/0');
    expect(formatDateTyping('1001')).toBe('10/01/');
    expect(formatDateTyping('10012')).toBe('10/01/2');
    expect(formatDateTyping('10012004')).toBe('10/01/2004');
    // Non-digits typed or pasted are ignored for formatting purposes.
    expect(formatDateTyping('10/01/2004')).toBe('10/01/2004');
    expect(formatDateTyping('')).toBe('');
  });

  it('normalises pasted values to ISO storage form', () => {
    expect(normalizeUserDateToIso('10012004')).toEqual({ iso: '2004-01-10', impossible: false });
    expect(normalizeUserDateToIso('10-01-2004')).toEqual({ iso: '2004-01-10', impossible: false });
    expect(normalizeUserDateToIso('10/01/2004')).toEqual({ iso: '2004-01-10', impossible: false });
    expect(normalizeUserDateToIso('2004-01-10')).toEqual({ iso: '2004-01-10', impossible: false });
    expect(normalizeUserDateToIso('2004/01/10')).toEqual({ iso: '2004-01-10', impossible: false });
  });

  it('flags impossible calendar dates without converting them', () => {
    expect(normalizeUserDateToIso('31/02/2026')).toEqual({ iso: null, impossible: true });
    expect(normalizeUserDateToIso('2026-02-30')).toEqual({ iso: null, impossible: true });
    // toStorableDateValue keeps impossible text exactly as typed.
    expect(toStorableDateValue('31/02/2026')).toBe('31/02/2026');
    expect(toStorableDateValue('10/01/2004')).toBe('2004-01-10');
    expect(toStorableDateValue('2004-01-10')).toBe('2004-01-10');
    expect(toStorableDateValue('')).toBe('');
    expect(toStorableDateValue(null)).toBeNull();
  });
});
