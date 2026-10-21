/**
 * Date helpers for DKS expiry values.
 *
 * Expiry values are stored as ISO calendar dates (YYYY-MM-DD), rather than
 * timestamps.  Parsing them through `new Date(isoDate)` would interpret the
 * value as UTC and can move a displayed date backwards or forwards for users
 * in a non-UTC timezone.  The helpers below deliberately operate on calendar
 * components and only use UTC midnight for an integer day-number calculation.
 */

export type ExpiryStatus = 'Valid' | 'Expiring Soon' | 'Urgent' | 'Expires today' | 'Expired';

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

/** Map a day count to the user-facing expiry status.
 *
 * The reviewed UI spec keeps "Expires today" (days = 0) distinct from
 * "Expired" (the date has already passed).
 */
export function statusForDays(
  days: number | null | undefined,
  thresholds: StatusThresholds = {},
): ExpiryStatus | null {
  if (days === null || days === undefined || !Number.isFinite(days)) {
    return null;
  }

  const resolved = resolveThresholds(thresholds);

  if (days < 0) {
    return 'Expired';
  }

  if (days === 0) {
    return 'Expires today';
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

// ---------------------------------------------------------------------------
// User-facing DD/MM/YYYY handling (F2)
//
// The database stores YYYY-MM-DD.  Everything the user sees — grid cells,
// CSV, Excel, print, PDF — uses DD/MM/YYYY.  Typing inserts separators
// progressively and pasted values are normalised; impossible calendar dates
// (31/02/2026) are reported and never silently converted to another date.
// ---------------------------------------------------------------------------

const DISPLAY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DASHED_DATE_PATTERN = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

export interface NormalizedUserDate {
  /** ISO calendar date when the input is a real calendar date. */
  iso: string | null;
  /** True when the input looks like a date but is not a possible calendar day. */
  impossible: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Render a stored ISO date (or a Date) as the user-facing DD/MM/YYYY text. */
export function formatDisplayDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    const parts = dateToCalendarParts(value);
    return parts ? `${pad(parts.day)}/${pad(parts.month)}/${parts.year}` : '';
  }
  const text = String(value).trim();
  const isoParts = parseIsoParts(text);
  if (isoParts) {
    return `${pad(isoParts.day)}/${pad(isoParts.month)}/${isoParts.year}`;
  }
  const display = DISPLAY_DATE_PATTERN.exec(text);
  if (display) {
    return `${pad(Number(display[1]))}/${pad(Number(display[2]))}/${display[3]}`;
  }
  return text;
}

export const toDisplayDate = formatDisplayDate;
export const formatDdMmYyyy = formatDisplayDate;

/** Parse DD/MM/YYYY (or dashed/compact variants) into ISO without timezone drift. */
export function normalizeUserDateToIso(value: string | Date | null | undefined): NormalizedUserDate {
  if (value instanceof Date) {
    const parts = dateToCalendarParts(value);
    return parts
      ? { iso: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, impossible: false }
      : { iso: null, impossible: false };
  }
  if (value === null || value === undefined) {
    return { iso: null, impossible: false };
  }

  const text = String(value).trim();
  if (!text) {
    return { iso: null, impossible: false };
  }

  // Already ISO.
  if (ISO_DATE_PATTERN.test(text)) {
    return { iso: parseIsoParts(text) ? text : null, impossible: !parseIsoParts(text) };
  }

  const display = DISPLAY_DATE_PATTERN.exec(text) ?? DASHED_DATE_PATTERN.exec(text);
  if (display) {
    const day = Number(display[1]);
    const month = Number(display[2]);
    const year = Number(display[3]);
    const candidate = { year, month, day };
    if (!parseIsoParts(`${year}-${pad(month)}-${pad(day)}`)) {
      return { iso: null, impossible: true };
    }
    return { iso: `${candidate.year}-${pad(candidate.month)}-${pad(candidate.day)}`, impossible: false };
  }

  // Compact digits typed without separators: DDMMYYYY (10012004 → 10/01/2004).
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  if (compact) {
    return normalizeUserDateToIso(`${compact[1]}/${compact[2]}/${compact[3]}`);
  }

  // ISO with slashes: YYYY/MM/DD.
  const isoSlashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (isoSlashed) {
    return normalizeUserDateToIso(`${isoSlashed[1]}-${pad(Number(isoSlashed[2]))}-${pad(Number(isoSlashed[3]))}`);
  }

  return { iso: null, impossible: false };
}

export const parseUserDate = normalizeUserDateToIso;
export const userDateToIso = normalizeUserDateToIso;

/**
 * Format keystrokes inside a date field while the user is typing.
 * `10` → `10/`, `1001` → `10/01/`, `10012004` → `10/01/2004`.
 */
export function formatDateTyping(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (!digits) {
    return '';
  }
  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);

  if (digits.length <= 2) {
    return digits.length === 2 ? `${day}/` : day;
  }
  if (digits.length <= 4) {
    return digits.length === 4 ? `${day}/${month}/` : `${day}/${month}`;
  }
  return `${day}/${month}/${year}`;
}

export const formatDateInputTyping = formatDateTyping;

/** True when a stored value is a real ISO calendar date. */
export function isIsoDateValue(value: unknown): boolean {
  return isValidIsoDate(value);
}

/** True when the value is a user-facing DD/MM/YYYY date (valid calendar day). */
export function isDisplayDate(value: unknown): boolean {
  return typeof value === 'string' && normalizeUserDateToIso(value).iso !== null
    && DISPLAY_DATE_PATTERN.test(value.trim());
}

/**
 * Convert a cell value to the form stored in `data` for date-type columns:
 * valid user input becomes ISO; impossible or unparseable text stays exactly
 * as typed so the user can see and correct it (never silently rewritten).
 */
export function toStorableDateValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const text = String(value);
  if (!text.trim()) {
    return '';
  }
  if (isValidIsoDate(text.trim())) {
    return text.trim();
  }
  const normalized = normalizeUserDateToIso(text);
  return normalized.impossible || !normalized.iso ? text : normalized.iso;
}
