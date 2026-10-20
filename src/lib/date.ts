/**
 * Date helpers for DKS expiry values.
 *
 * Expiry values are stored as ISO calendar dates (YYYY-MM-DD), rather than
 * timestamps.  Parsing them through `new Date(isoDate)` would interpret the
 * value as UTC and can move a displayed date backwards or forwards for users
 * in a non-UTC timezone.  The helpers below deliberately operate on calendar
 * components and only use UTC midnight for an integer day-number calculation.
 */

export type ExpiryStatus = 'Valid' | 'Expiring Soon' | 'Urgent' | 'Expired';

export interface StatusThresholds {
  /** A value strictly above this number is considered Valid. */
  validAbove?: number;
  /** The inclusive lower bound for Expiring Soon. */
  expiringSoonFrom?: number;
  /** The first positive day in the Urgent band (kept as metadata for settings). */
  urgentFrom?: number;
  /** Values at or below this number are Expired. */
  expiredAt?: number;
  /** SQL/settings aliases accepted for persisted threshold objects. */
  greenAbove?: number;
  yellowFrom?: number;
  yellowTo?: number;
  urgentTo?: number;
}

export interface ResolvedStatusThresholds {
  validAbove: number;
  expiringSoonFrom: number;
  yellowTo: number;
  urgentFrom: number;
  urgentTo: number;
  expiredAt: number;
}

export const DEFAULT_THRESHOLDS: Readonly<ResolvedStatusThresholds> = Object.freeze({
  validAbove: 90,
  expiringSoonFrom: 30,
  yellowTo: 90,
  urgentFrom: 1,
  urgentTo: 29,
  expiredAt: 0,
});

const DAY_MS = 86_400_000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseIsoParts(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = ISO_DATE_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
  ) {
    return null;
  }

  return { year, month, day };
}

/** Return true only for a valid ISO calendar date, without timezone parsing. */
export function isValidIsoDate(value: unknown): value is string {
  return parseIsoParts(value) !== null;
}

/**
 * Convert a calendar date to an integer day number.  The resulting number is
 * never exposed as a timestamp; UTC midnight is used solely so subtraction is
 * independent of the machine's timezone and daylight-saving transitions.
 */
function calendarDayNumber(value: CalendarDate): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  return Math.floor(date.getTime() / DAY_MS);
}

function dateToCalendarParts(value: Date): CalendarDate | null {
  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
  };
}

function todayParts(value?: string | Date): CalendarDate | null {
  if (value instanceof Date) {
    return dateToCalendarParts(value);
  }

  if (typeof value === 'string') {
    return parseIsoParts(value);
  }

  return dateToCalendarParts(new Date());
}

/**
 * Calculate local calendar days from `today` until an ISO expiry date.
 *
 * Empty and malformed expiry values intentionally return null.  A caller can
 * therefore distinguish “no primary expiry” from an already expired record.
 */
export function calculateDaysLeft(
  isoDate: string | null | undefined,
  today?: string | Date,
): number | null {
  const expiryParts = parseIsoParts(isoDate);
  const todayCalendar = todayParts(today);

  if (!expiryParts || !todayCalendar) {
    return null;
  }

  return calendarDayNumber(expiryParts) - calendarDayNumber(todayCalendar);
}

export function resolveThresholds(
  thresholds: StatusThresholds = {},
): ResolvedStatusThresholds {
  const validAbove = thresholds.validAbove
    ?? thresholds.greenAbove
    ?? DEFAULT_THRESHOLDS.validAbove;
  const expiringSoonFrom = thresholds.expiringSoonFrom
    ?? thresholds.yellowFrom
    ?? DEFAULT_THRESHOLDS.expiringSoonFrom;
  const urgentFrom = thresholds.urgentFrom
    ?? DEFAULT_THRESHOLDS.urgentFrom;
  const yellowTo = thresholds.yellowTo
    ?? validAbove;
  const urgentTo = thresholds.urgentTo
    ?? (expiringSoonFrom - 1);
  const expiredAt = thresholds.expiredAt
    ?? DEFAULT_THRESHOLDS.expiredAt;

  return {
    validAbove: Number.isFinite(validAbove) ? validAbove : DEFAULT_THRESHOLDS.validAbove,
    expiringSoonFrom: Number.isFinite(expiringSoonFrom)
      ? expiringSoonFrom
      : DEFAULT_THRESHOLDS.expiringSoonFrom,
    yellowTo: Number.isFinite(yellowTo) ? yellowTo : DEFAULT_THRESHOLDS.yellowTo,
    urgentFrom: Number.isFinite(urgentFrom) ? urgentFrom : DEFAULT_THRESHOLDS.urgentFrom,
    urgentTo: Number.isFinite(urgentTo) ? urgentTo : DEFAULT_THRESHOLDS.urgentTo,
    expiredAt: Number.isFinite(expiredAt) ? expiredAt : DEFAULT_THRESHOLDS.expiredAt,
  };
}

/** Map a day count to the user-facing expiry status. */
export function statusForDays(
  days: number | null | undefined,
  thresholds: StatusThresholds = {},
): ExpiryStatus | null {
  if (days === null || days === undefined || !Number.isFinite(days)) {
    return null;
  }

  const resolved = resolveThresholds(thresholds);

  if (days <= resolved.expiredAt) {
    return 'Expired';
  }

  if (days > resolved.validAbove) {
    return 'Valid';
  }

  if (days >= resolved.expiringSoonFrom && days <= resolved.yellowTo) {
    return 'Expiring Soon';
  }

  if (days >= resolved.urgentFrom && days <= resolved.urgentTo) {
    return 'Urgent';
  }

  // Keep the display total for a malformed/gapped custom configuration.  The
  // normal defaults and contiguous custom ranges take the branches above.
  return 'Urgent';
}

export const daysLeftFor = calculateDaysLeft;
export const calculateDaysRemaining = calculateDaysLeft;
export const getExpiryStatus = statusForDays;
export const DEFAULT_STATUS_THRESHOLDS = DEFAULT_THRESHOLDS;
export const getStatusForDays = statusForDays;
