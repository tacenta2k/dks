import {
  DEFAULT_THRESHOLDS,
  DEFAULT_STATUS_THRESHOLDS,
  calculateDaysLeft,
  resolveThresholds,
  statusForDays,
  type ExpiryStatus,
  type ResolvedStatusThresholds,
  type StatusThresholds,
} from './date';

export {
  DEFAULT_THRESHOLDS,
  DEFAULT_STATUS_THRESHOLDS,
  calculateDaysLeft,
  resolveThresholds,
  statusForDays,
};
export type { ExpiryStatus, ResolvedStatusThresholds, StatusThresholds } from './date';

export interface StatusColors {
  Valid: string;
  'Expiring Soon': string;
  Urgent: string;
  'Expires today': string;
  Expired: string;
}

export const DEFAULT_STATUS_COLORS: Readonly<StatusColors> = Object.freeze({
  Valid: '#16a34a',
  'Expiring Soon': '#eab308',
  Urgent: '#f97316',
  'Expires today': '#dc2626',
  Expired: '#7f1d1d',
});

export interface StatusPresentation {
  status: ExpiryStatus | null;
  color: string | null;
}

function normaliseStatusColorKey(value: string): ExpiryStatus | null {
  const compact = value.toLowerCase().replace(/[^a-z]/g, '');

  if (compact === 'valid' || compact === 'green') {
    return 'Valid';
  }
  if (compact === 'expiringsoon' || compact === 'yellow') {
    return 'Expiring Soon';
  }
  if (compact === 'urgent' || compact === 'orange') {
    return 'Urgent';
  }
  if (compact === 'expirestoday' || compact === 'today' || compact === 'red') {
    return 'Expires today';
  }
  if (compact === 'expired' || compact === 'darkred' || compact === 'gray' || compact === 'grey') {
    return 'Expired';
  }

  return null;
}

/** Return a customizable status color with a safe default fallback. */
export function colorForStatus(
  status: ExpiryStatus | null | undefined,
  colors: Partial<StatusColors> | Record<string, string> = {},
): string | null {
  if (!status) {
    return null;
  }

  const supplied = Object.entries(colors).reduce<Partial<StatusColors>>((result, [key, value]) => {
    if (typeof value !== 'string' || !value.trim()) {
      return result;
    }
    const normalised = normaliseStatusColorKey(key);
    if (normalised) {
      result[normalised] = value;
    }
    return result;
  }, {});

  return supplied[status] ?? DEFAULT_STATUS_COLORS[status];
}

export const statusColorFor = colorForStatus;
export const statusColor = colorForStatus;

export function expiryPresentation(
  days: number | null | undefined,
  thresholds: StatusThresholds = {},
  colors: Partial<StatusColors> | Record<string, string> = {},
): StatusPresentation {
  const status = statusForDays(days, thresholds);
  return { status, color: colorForStatus(status, colors) };
}

function finiteAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/** Format an Omani Rial amount using the application's required 3 decimals. */
export function formatOmanRial(value: unknown): string {
  const amount = finiteAmount(value);
  if (amount === null) {
    return '';
  }

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
    useGrouping: true,
  }).format(amount);

  return `ر.ع. ${formatted}`;
}

export const formatOMR = formatOmanRial;
export const formatOmr = formatOmanRial;
export const formatOmaniRial = formatOmanRial;
export const formatPrice = formatOmanRial;
export const formatCurrency = formatOmanRial;
export const STATUS_COLORS = DEFAULT_STATUS_COLORS;
export const DEFAULT_COLORS = DEFAULT_STATUS_COLORS;
export const getDaysLeft = calculateDaysLeft;
export const deriveDaysLeft = calculateDaysLeft;
export const getStatusForDays = statusForDays;

export function statusForExpiryDate(
  isoDate: string | null | undefined,
  today?: string | Date,
  thresholds: StatusThresholds = {},
): ExpiryStatus | null {
  return statusForDays(calculateDaysLeft(isoDate, today), thresholds);
}

export const getExpiryStatusForDate = statusForExpiryDate;

/** Derive both values used by a grid row from its primary ISO expiry value. */
export function expiryValues(
  isoDate: string | null | undefined,
  today?: string | Date,
  thresholds: StatusThresholds = {},
  colors: Partial<StatusColors> | Record<string, string> = {},
): { daysLeft: number | null; status: ExpiryStatus | null; color: string | null } {
  const daysLeft = calculateDaysLeft(isoDate, today);
  const presentation = expiryPresentation(daysLeft, thresholds, colors);
  return { daysLeft, ...presentation };
}
