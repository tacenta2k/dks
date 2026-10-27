/**
 * DKS daily expiry report — shared model, window/order selection, value
 * formatting, masking, and HTML/plain-text rendering.
 *
 * Pure TypeScript (no Deno/Node/Electron imports) so the SAME code is unit
 * tested with vitest from this repository and bundled into the `send-email`
 * Edge Function at deploy time. The PDF renderer lives in ./digest-pdf.ts.
 *
 * Business rules implemented here (and mirrored by
 * ARENA/sql/expiry-digest-report.sql + ARENA/sql/digest-full-columns.sql):
 *   - 30-day window for THIS report only (expired + today + 1..30).
 *   - daysLeft recomputed from the Asia/Muscat business calendar on every run.
 *   - ordering: expired (most overdue first) → today → upcoming 1..30 asc.
 *   - FULL passport / Civil ID values are the default: the PDF is addressed to
 *     the Admin mailbox only, and the Admin must be able to phone the customer
 *     from the email alone. Setting `email_notifications.include_full_ids` to
 *     false is an explicit opt-out (values are then masked).
 *   - the email body stays short; the attached landscape grid PDF carries the
 *     per-column detail.
 */

import { escapeHtml } from './email.ts';
import { formatDisplayDate, isValidIsoDate } from '../../../src/lib/date.ts';

/** Window for the email/PDF report. Deliberately NOT the workspace setting. */
export const EXPIRY_REPORT_WINDOW_DAYS = 30;

/** Hard cap on records carried in one report (email list + PDF grid rows). */
export const MAX_REPORT_RECORDS = 200;

export const EMPTY_VALUE = '—';
export const UNNAMED_LABEL = 'Unnamed record';

/** One-line body sentence. The table lives in the attachment, never inline. */
export const DIGEST_ATTACHMENT_SENTENCE = 'Your DKS daily expiry summary is attached.';
/** Calm one-pager headline when nothing qualifies. */
export const DIGEST_EMPTY_HEADLINE = 'No expiries to flag today';
/**
 * The HTML/text body may list record names + days left, but it stays short:
 * the full grid is only ever in the PDF attachment.
 */
export const MAX_INLINE_LIST_ITEMS = 15;

/** Landscape A4 — the grid needs the width, not the height. */
export const PDF_PAGE_ORIENTATION = 'landscape' as const;

/** Supabase primary keys are UUIDs — never use one as a display label. */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MASK_FULL = '••••••';
export const MASK_PREFIX = '••••';

export const DKS_BUSINESS_TIME_ZONE = 'Asia/Muscat';

export type ReportColumnType =
  | 'text'
  | 'number'
  | 'phone'
  | 'email'
  | 'price'
  | 'date_start'
  | 'date_expiry'
  | 'dropdown'
  | 'checkbox'
  | 'notes'
  | 'civil_id';

/**
 * Status text is shown (not only coloured) in both media. The 1..30 band
 * carries its own countdown so a reader never has to guess how urgent a row is.
 */
export type ReportEntryStatus =
  | 'Expired'
  | 'Expires today'
  | `Expires in ${number} day`
  | `Expires in ${number} days`;

export interface ReportColumn {
  id: string;
  name: string;
  type: ReportColumnType;
  position: number;
  visible: boolean;
  isPrimaryExpiry: boolean;
  isPassport: boolean;
  /** type === 'civil_id' || is_passport || name matches /passport/i. */
  sensitive: boolean;
}

export interface ReportEntry {
  /** Internal entry id — used for stable ordering only, NEVER displayed. */
  id: string;
  label: string;
  expiry: string;
  daysLeft: number;
  status: ReportEntryStatus;
  data: Record<string, unknown>;
}

export interface SummaryCounts {
  total: number;
  expired: number;
  today: number;
  within7: number;
  within30: number;
}

export interface CurrencySettings {
  code: string;
  symbol: string;
  decimals: number;
}

export interface DigestReportModel {
  reportDate: string;
  reportDateDisplay: string;
  /** ISO instant the report was rendered; shown as Asia/Muscat date + time. */
  reportGeneratedAt: string;
  /** `DD/MM/YYYY HH:mm` in Asia/Muscat, e.g. `26/10/2026 14:05`. */
  reportDateTimeDisplay: string;
  columns: ReportColumn[];
  currency: CurrencySettings;
  includeFullIds: boolean;
  entries: ReportEntry[];
  totalQualifying: number;
  truncated: boolean;
  summary: SummaryCounts;
  pdfFileName: string;
}

export interface RawReportEntry {
  id?: unknown;
  expiry?: unknown;
  daysLeft?: unknown;
  data?: unknown;
  deleted?: unknown;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Resolve a stored cell using the SAME keying the app uses:
 * `data[column.id] ?? data[column.name]`. New writes key by column id (slug);
 * the name fallback keeps legacy/imported rows working.
 */
export function resolveEntryValue(
  data: Record<string, unknown>,
  column: Pick<ReportColumn, 'id' | 'name'>,
): unknown {
  if (!data) {
    return undefined;
  }
  return data[column.id] ?? data[column.name];
}

/**
 * A column is sensitive when its type is civil_id, the is_passport flag is
 * set, or its name mentions passport. Verified from the real app_columns
 * flags — never assumed from a hard-coded list.
 */
export function isSensitiveColumn(
  column: Pick<ReportColumn, 'type' | 'isPassport' | 'name'>,
): boolean {
  return column.type === 'civil_id'
    || column.isPassport === true
    || /passport/i.test(column.name);
}

/**
 * Mask an identifier so it cannot be reconstructed. Scheme (documented):
 *   - empty stays empty (the caller renders "—");
 *   - length >= 6 → "•••• " + last 4 characters;
 *   - shorter than 6 → fully masked "••••••".
 */
export function maskIdentifier(value: unknown): string {
  const text = stringValue(value);
  if (!text) {
    return '';
  }
  if (text.length >= 6) {
    return `${MASK_PREFIX} ${text.slice(-4)}`;
  }
  return MASK_FULL;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function checkboxLabel(value: unknown): string | null {
  if (isBlank(value)) {
    return null;
  }
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'True') {
    return 'Yes';
  }
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'False') {
    return 'No';
  }
  const text = String(value).trim().toLowerCase();
  if (text === 'yes' || text === 'y' || text === 'on') {
    return 'Yes';
  }
  if (text === 'no' || text === 'n' || text === 'off') {
    return 'No';
  }
  return String(value);
}

function normalizeCurrency(value: unknown): CurrencySettings {
  const record = asRecord(value);
  const decimals = Number(record?.decimals);
  return {
    code: stringValue(record?.code) ?? 'OMR',
    symbol: stringValue(record?.symbol) ?? 'ر.ع.',
    decimals: Number.isFinite(decimals) ? Math.max(0, Math.min(6, Math.trunc(decimals))) : 3,
  };
}

export function formatPrice(
  value: unknown,
  currency: CurrencySettings,
  options: { asciiSafe?: boolean } = {},
): string {
  if (isBlank(value)) {
    return EMPTY_VALUE;
  }
  const amount = toFiniteNumber(value);
  if (amount === null) {
    // Unparseable but present: keep the stored text rather than blanking it.
    return String(value);
  }
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
    useGrouping: true,
  }).format(amount);

  let symbol = currency.symbol;
  if (options.asciiSafe && !isWinAnsiEncodable(symbol)) {
    // The PDF font is WinAnsi-only; fall back to the ISO code so the amount
    // never renders as "???". The email body keeps the configured symbol.
    symbol = currency.code;
  }
  return `${symbol} ${formatted}`;
}

/**
 * Render one stored cell the way DKS displays it. `includeFullIds` only ever
 * releases a sensitive value; it never changes formatting of safe columns.
 */
export function formatReportValue(
  value: unknown,
  column: Pick<ReportColumn, 'type' | 'sensitive'>,
  options: { includeFullIds: boolean; currency: CurrencySettings; asciiSafe?: boolean },
): string {
  if (column.sensitive && !options.includeFullIds) {
    return isBlank(value) ? EMPTY_VALUE : maskIdentifier(value);
  }

  if (isBlank(value)) {
    return EMPTY_VALUE;
  }

  switch (column.type) {
    case 'date_start':
    case 'date_expiry':
      // Valid ISO/display dates render DD/MM/YYYY; impossible or unparseable
      // values keep their stored text (never silently blanked).
      return formatDisplayDate(String(value));
    case 'price':
      return formatPrice(value, options.currency, { asciiSafe: options.asciiSafe });
    case 'checkbox':
      return checkboxLabel(value) ?? EMPTY_VALUE;
    default:
      // text / notes / phone / email / number / dropdown / civil_id:
      // preserve the stored text exactly (leading zeroes, identifiers).
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * The characters cp1252 (WinAnsi) maps onto bytes 0x80-0x9f. A PDF standard
 * font encodes these, but they are NOT contiguous Unicode code points, so the
 * range check below alone would wrongly reject them — including the bullet
 * (U+2022) used for masked identifiers.
 */
const WINANSI_SUPPLEMENTAL = new Set([
  0x20ac, // €
  0x201a, // ‚
  0x0192, // ƒ
  0x201e, // „
  0x2026, // …
  0x2020, // †
  0x2021, // ‡
  0x02c6, // ˆ
  0x2030, // ‰
  0x0160, // Š
  0x2039, // ‹
  0x0152, // Œ
  0x017d, // Ž
  0x2018, // ‘
  0x2019, // ’
  0x201c, // “
  0x201d, // ”
  0x2022, // •  — mask prefix
  0x2013, // –
  0x2014, // —
  0x02dc, // ˜
  0x2122, // ™
  0x0161, // š
  0x203a, // ›
  0x0153, // œ
  0x017e, // ž
  0x0178, // Ÿ
]);

function isWinAnsiCodePoint(code: number): boolean {
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
    return true;
  }
  return WINANSI_SUPPLEMENTAL.has(code);
}

/** True when every character can be encoded by a WinAnsi (PDF standard) font. */
export function isWinAnsiEncodable(value: string): boolean {
  for (const char of value) {
    if (!isWinAnsiCodePoint(char.codePointAt(0) ?? 0)) {
      return false;
    }
  }
  return true;
}

/**
 * Replace characters a WinAnsi PDF font cannot encode with a visible marker
 * so the document never silently emits blank or garbled text. The caller is
 * told (via the returned flag) so it can print an explicit notice.
 */
export function sanitizePdfText(value: string): { text: string; unsupported: boolean } {
  let unsupported = false;
  let out = '';
  for (const char of value) {
    if (isWinAnsiCodePoint(char.codePointAt(0) ?? 0)) {
      out += char;
    } else {
      unsupported = true;
      out += '?';
    }
  }
  return { text: out, unsupported };
}

// ---------------------------------------------------------------------------
// Asia/Muscat business calendar
// ---------------------------------------------------------------------------

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Calendar parts of `value` (Date or ISO string) in Asia/Muscat. */
export function muscatCalendarParts(value?: string | Date): CalendarDate | null {
  const date = value instanceof Date
    ? value
    : new Date(value === undefined ? Date.now() : String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DKS_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}

/** The current Asia/Muscat calendar date as YYYY-MM-DD. */
export function muscatTodayIso(value?: string | Date): string {
  const parts = muscatCalendarParts(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : '';
}

/**
 * `DD/MM/YYYY HH:mm` in Asia/Muscat. This is the report "date and time" printed
 * on the PDF header and footer; the day boundary itself still comes from
 * `muscatTodayIso`, never from UTC.
 */
export function muscatDateTimeDisplay(value?: string | Date): string {
  const date = value instanceof Date
    ? value
    : new Date(value === undefined ? Date.now() : String(value));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DKS_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const display = `${pick('day')}/${pick('month')}/${pick('year')} ${pick('hour')}:${pick('minute')}`;
  return /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(display) ? display : '';
}

/** A stored ISO date rendered as the user-facing DD/MM/YYYY text. */
export function isoToDisplayDate(iso: string): string {
  return formatDisplayDate(iso);
}

// ---------------------------------------------------------------------------
// Column normalisation + label policy
// ---------------------------------------------------------------------------

const RESERVED_COLUMN_IDS = new Set([
  'daysLeft',
  '__rowNumber',
  '__actions',
  '__addColumn',
]);

function sortByPosition(columns: readonly ReportColumn[]): ReportColumn[] {
  return columns
    .map((column, index) => ({ column, index }))
    .sort((left, right) => left.column.position - right.column.position || left.index - right.index)
    .map((entry) => entry.column);
}

export function normalizeReportColumn(raw: unknown): ReportColumn | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const id = stringValue(record.id);
  const name = stringValue(record.name);
  if (!id || !name || RESERVED_COLUMN_IDS.has(id)) {
    return null;
  }
  const rawType = stringValue(record.type) ?? 'text';
  const type = (['text', 'number', 'phone', 'email', 'price', 'date_start', 'date_expiry',
    'dropdown', 'checkbox', 'notes', 'civil_id'].includes(rawType)
    ? rawType
    : 'text') as ReportColumnType;
  const isPassport = record.isPassport === true || record.is_passport === true;
  const sensitive = isSensitiveColumn({ type, isPassport, name });
  const position = Number(record.position);
  return {
    id,
    name,
    type,
    position: Number.isFinite(position) ? position : 0,
    visible: record.visible !== false,
    isPrimaryExpiry: record.isPrimaryExpiry === true || record.is_primary_expiry === true,
    isPassport,
    sensitive,
  };
}

/**
 * Active, visible, non-system user columns in the workspace's saved order.
 * Adding/renaming/reordering a Visa Sheet column changes this list; the PDF
 * and email pick it up automatically with no code change.
 */
export function normalizeReportColumns(raw: unknown): ReportColumn[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const columns = raw
    .map(normalizeReportColumn)
    .filter((column): column is ReportColumn => column !== null)
    .filter((column) => column.visible !== false);
  return sortByPosition(columns);
}

/**
 * Conservative human-readable row label. Never a raw UUID, never a sensitive
 * identifier. Order: name-ish column → first text-like column → first
 * non-sensitive value → "Unnamed record".
 */
export function rowLabel(
  data: Record<string, unknown>,
  columns: readonly ReportColumn[],
): string {
  const active = columns.filter((column) => column.visible !== false);
  const safe = active.filter((column) => !column.sensitive);
  const preferred = safe.filter((column) => /name/i.test(column.name) || /name/i.test(column.id));
  const textLike = safe.filter((column) => ['text', 'notes', 'phone', 'email'].includes(column.type));
  const rest = safe.filter((column) => !preferred.includes(column) && !textLike.includes(column));

  for (const column of [...preferred, ...textLike, ...rest]) {
    const value = stringValue(resolveEntryValue(data, column));
    if (value) {
      return value;
    }
  }

  // Last resort: first plain text value in the payload. Never a sensitive
  // identifier, never the record's own UUID id, never any other UUID-shaped
  // value — an invented label would leak by accident.
  const sensitiveIds = new Set(active.filter((column) => column.sensitive).map((column) => column.id));
  for (const [key, value] of Object.entries(data)) {
    const label = stringValue(value);
    if (!label || UUID_LIKE.test(label) || sensitiveIds.has(key)) {
      continue;
    }
    return label;
  }

  return UNNAMED_LABEL;
}

// ---------------------------------------------------------------------------
// Window selection + ordering
// ---------------------------------------------------------------------------

export function statusForDaysLeft(daysLeft: number): ReportEntryStatus {
  if (daysLeft < 0) {
    return 'Expired';
  }
  if (daysLeft === 0) {
    return 'Expires today';
  }
  // The countdown is part of the status, so it is text (not colour) in both
  // the HTML summary and the PDF.
  return `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}

/**
 * The "Days left" grid column is written as a sentence, not a bare integer:
 *   -3 → "Expired 3 days ago" · 0 → "Expires today" · 12 → "12 days left".
 * Status stays the terse band label (`Expired`, `Expires today`,
 * `Expires in 12 days`); both are text, so neither relies on colour.
 */
export function formatDaysLeft(daysLeft: number): string {
  if (!Number.isFinite(daysLeft)) {
    return EMPTY_VALUE;
  }
  const days = Math.trunc(daysLeft);
  if (days < 0) {
    const ago = Math.abs(days);
    return `Expired ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  if (days === 0) {
    return 'Expires today';
  }
  return `${days} day${days === 1 ? '' : 's'} left`;
}

/** True for the two red bands (expired / today); 1..7 is amber. */
export function isCriticalDaysLeft(daysLeft: number): boolean {
  return daysLeft <= 0;
}

export function isSoonDaysLeft(daysLeft: number): boolean {
  return daysLeft >= 1 && daysLeft <= 7;
}

function isoDayNumber(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return Number.NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

/**
 * Apply the report window and ordering to raw entries. `todayIso` is the
 * Asia/Muscat calendar date; daysLeft is recomputed fresh on every run and a
 * previous stored value is never reused.
 *
 * Included: daysLeft < 0 (expired), 0 (today), 1..30 (expiring soon).
 * Excluded: daysLeft > 30, missing/malformed/impossible expiry, soft-deleted.
 */
export function selectReportEntries(
  rawEntries: readonly RawReportEntry[],
  columns: readonly ReportColumn[],
  todayIso: string,
): ReportEntry[] {
  const today = isoDayNumber(todayIso);
  const out: ReportEntry[] = [];

  for (const raw of rawEntries) {
    const record = asRecord(raw);
    if (!record) {
      continue;
    }
    // Defense in depth: the SQL already excludes soft-deleted rows.
    if (record.deleted === true) {
      continue;
    }
    const data = asRecord(record.data);
    if (!data) {
      continue;
    }
    const expiry = stringValue(record.expiry);
    if (!expiry || !isValidIsoDate(expiry)) {
      continue;
    }
    const daysLeft = isoDayNumber(expiry) - today;
    if (!Number.isFinite(daysLeft) || daysLeft > EXPIRY_REPORT_WINDOW_DAYS) {
      continue;
    }
    const id = stringValue(record.id) ?? '';
    out.push({
      id,
      label: rowLabel(data, columns),
      expiry,
      daysLeft,
      status: statusForDaysLeft(daysLeft),
      data,
    });
  }

  // Expired first (oldest expiry first) → today → upcoming 1..30 ascending.
  // Stable tie-breakers: label, then the internal id (never displayed).
  out.sort((left, right) => (
    left.expiry < right.expiry ? -1
      : left.expiry > right.expiry ? 1
        : left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  ));
  return out;
}

export function computeSummary(entries: readonly ReportEntry[]): SummaryCounts {
  let expired = 0;
  let today = 0;
  let within7 = 0;
  let within30 = 0;
  for (const entry of entries) {
    if (entry.daysLeft < 0) {
      expired += 1;
    } else if (entry.daysLeft === 0) {
      today += 1;
    }
    if (entry.daysLeft >= 1 && entry.daysLeft <= 7) {
      within7 += 1;
    }
    if (entry.daysLeft >= 1 && entry.daysLeft <= EXPIRY_REPORT_WINDOW_DAYS) {
      within30 += 1;
    }
  }
  return { total: entries.length, expired, today, within7, within30 };
}

export interface BuildDigestReportModelInput {
  reportDateIso: string;
  columns: readonly unknown[];
  currency?: unknown;
  /** Omitted → FULL values (the product default). Only an explicit false masks. */
  includeFullIds?: boolean;
  /**
   * ISO instant the model is built at. Defaults to `Date.now()`; tests pass a
   * fixed value so the printed date/time is deterministic.
   */
  generatedAt?: string | Date;
  entries: readonly RawReportEntry[];
  totalQualifying?: number;
}

export function buildDigestReportModel(input: BuildDigestReportModelInput): DigestReportModel {
  const columns = normalizeReportColumns(input.columns);
  const currency = normalizeCurrency(input.currency ?? null);
  // Admin-only PDF: full identifiers are the default. `false` is the explicit
  // opt-out (Settings → Notifications) and the only way to mask them.
  const includeFullIds = input.includeFullIds !== false;
  const qualifying = selectReportEntries(input.entries, columns, input.reportDateIso);
  const totalQualifying = Number.isFinite(input.totalQualifying)
    ? Math.max(0, Math.trunc(input.totalQualifying ?? 0))
    : qualifying.length;
  // The grid is capped; the full qualifying count is carried separately so
  // truncation is always visible to the reader.
  const entries = qualifying.slice(0, MAX_REPORT_RECORDS);
  const truncated = totalQualifying > entries.length;
  const generatedAt = input.generatedAt === undefined
    ? new Date()
    : (input.generatedAt instanceof Date ? input.generatedAt : new Date(input.generatedAt));
  const safeGeneratedAt = Number.isNaN(generatedAt.getTime()) ? new Date() : generatedAt;

  return {
    reportDate: input.reportDateIso,
    reportDateDisplay: isoToDisplayDate(input.reportDateIso),
    reportGeneratedAt: safeGeneratedAt.toISOString(),
    reportDateTimeDisplay: muscatDateTimeDisplay(safeGeneratedAt),
    columns,
    currency,
    includeFullIds,
    entries,
    totalQualifying,
    truncated,
    summary: computeSummary(entries),
    pdfFileName: pdfAttachmentFileName(input.reportDateIso),
  };
}

// ---------------------------------------------------------------------------
// Summary strip + email body (HTML + plain text)
// ---------------------------------------------------------------------------

export function pdfAttachmentFileName(reportDateIso: string): string {
  return `DKS-expiry-report-${reportDateIso}.pdf`;
}

export interface SummaryCountItem {
  label: 'Expired' | 'Today' | 'Next 7' | 'Next 30' | 'Total';
  value: number;
}

/**
 * Summary counts in the order printed on the PDF strip and in the email body:
 * Expired → Today → Next 7 → Next 30 → Total.
 */
export function summaryCountItems(model: DigestReportModel): SummaryCountItem[] {
  return [
    { label: 'Expired', value: model.summary.expired },
    { label: 'Today', value: model.summary.today },
    { label: 'Next 7', value: model.summary.within7 },
    { label: 'Next 30', value: model.summary.within30 },
    { label: 'Total', value: model.summary.total },
  ];
}

export function summaryLine(model: DigestReportModel): string {
  return summaryCountItems(model).map((item) => `${item.label}: ${item.value}`).join(' · ');
}

/** `26/10/2026 14:05 (Asia/Muscat)` — the report date AND time. */
export function reportDateTimeLabel(model: DigestReportModel): string {
  const stamp = model.reportDateTimeDisplay || model.reportDateDisplay;
  return `${stamp} (${DKS_BUSINESS_TIME_ZONE})`;
}

/** Shown on the last page (and in the body) whenever the 200-row cap bites. */
export function truncationNote(model: DigestReportModel): string | null {
  if (!model.truncated) {
    return null;
  }
  return `This report shows the ${model.entries.length} most urgent of ${model.totalQualifying} `
    + 'records expiring within 30 days.';
}

/** Honest note when the Admin opted out of full identifiers. */
export function maskingNote(model: DigestReportModel): string | null {
  if (model.includeFullIds || !model.columns.some((column) => column.sensitive)) {
    return null;
  }
  return 'Passport and Civil ID values are masked in the attached PDF.';
}

export const EMPTY_DAY_NOTE = 'All clear — nothing expiring within the next 30 days.';

/**
 * Amounts fall back to the ISO currency code when the configured symbol cannot
 * be encoded by the PDF font (e.g. the Arabic OMR symbol). The report says so
 * instead of printing `???`.
 */
export function currencyFallbackNote(model: DigestReportModel): string | null {
  const hasPriceColumn = model.columns.some((column) => column.type === 'price');
  if (!hasPriceColumn || isWinAnsiEncodable(model.currency.symbol)) {
    return null;
  }
  return `The currency symbol cannot be encoded by the PDF font, so amounts show the `
    + `${model.currency.code} code instead.`;
}

function daysLeftColorHex(daysLeft: number): string {
  if (isCriticalDaysLeft(daysLeft)) {
    return '#b3261e';
  }
  return isSoonDaysLeft(daysLeft) ? '#8a5a00' : '#1f2328';
}

function inlineListEntries(model: DigestReportModel): ReportEntry[] {
  return model.entries.slice(0, MAX_INLINE_LIST_ITEMS);
}

function bodyNotes(model: DigestReportModel): string[] {
  const notes: string[] = [];
  if (model.entries.length === 0) {
    notes.push(EMPTY_DAY_NOTE);
  }
  const truncation = truncationNote(model);
  if (truncation) {
    notes.push(truncation);
  }
  const masked = maskingNote(model);
  if (masked) {
    notes.push(masked);
  }
  if (
    model.includeFullIds
    && model.entries.length > 0
    && model.columns.some((column) => column.sensitive)
  ) {
    notes.push('Full Passport and Civil ID values are included in the attached PDF.');
  }
  return notes;
}

function listHtml(model: DigestReportModel): string {
  if (model.entries.length === 0) {
    return '';
  }
  const items = inlineListEntries(model).map((entry) => [
    '<li style="margin:0 0 4px;font-size:13px;">',
    `${escapeHtml(entry.label)} — `,
    `<span style="color:${daysLeftColorHex(entry.daysLeft)};font-weight:600;">`,
    `${escapeHtml(formatDaysLeft(entry.daysLeft))}</span>`,
    '</li>',
  ].join('')).join('');
  const remaining = model.entries.length - inlineListEntries(model).length;
  const more = remaining > 0
    ? `<p style="margin:6px 0 0;color:#57606a;font-size:13px;">+${remaining} more in the attached PDF.</p>`
    : '';
  const total = model.totalQualifying - model.entries.length;
  const truncatedMore = total > 0
    ? `<p style="margin:6px 0 0;color:#57606a;font-size:13px;">${total} further records are not listed in this report.</p>`
    : '';
  return `<ul style="margin:10px 0 0;padding-left:18px;">${items}</ul>${more}${truncatedMore}`;
}

/**
 * The email body is deliberately short: a headline, the date/time, the five
 * counts, the "attached" sentence and (optionally) record names + days left.
 * It never carries a full Passport / Civil ID value — not even when the PDF
 * does — so the body can never become a second copy of the table.
 */
export function renderDigestHtml(model: DigestReportModel): string {
  const empty = model.entries.length === 0;
  const headline = empty ? DIGEST_EMPTY_HEADLINE : 'DKS Daily Expiry Report';
  const notes = bodyNotes(model)
    .map((note) => `<p style="margin:10px 0 0;color:#555;font-size:13px;">${escapeHtml(note)}</p>`)
    .join('');

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>DKS Daily Expiry Report</title></head>',
    '<body style="margin:0;padding:16px;background:#f6f7f9;',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328;">',
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e4e8;',
    'border-radius:10px;padding:20px;">',
    `<h1 style="margin:0 0 4px;font-size:20px;">${escapeHtml(headline)}</h1>`,
    `<p style="margin:0 0 10px;color:#57606a;font-size:13px;">Report date: `
    + `${escapeHtml(reportDateTimeLabel(model))}</p>`,
    `<p style="margin:0 0 12px;color:#3d444d;font-size:13px;">${escapeHtml(summaryLine(model))}</p>`,
    `<p style="margin:0;color:#1f2328;font-size:14px;font-weight:600;">${DIGEST_ATTACHMENT_SENTENCE}</p>`,
    listHtml(model),
    notes,
    '<hr style="border:none;border-top:1px solid #e2e4e8;margin:18px 0 10px;">',
    `<p style="margin:0;font-size:13px;color:#3d444d;">Attachment: `
    + `<strong>${escapeHtml(model.pdfFileName)}</strong> `
    + '(landscape A4 grid, one row per record, every visible Visa Sheet column).</p>',
    '</div></body></html>',
  ].join('');
}

export function renderDigestText(model: DigestReportModel): string {
  const empty = model.entries.length === 0;
  const lines = [
    empty ? DIGEST_EMPTY_HEADLINE : 'DKS Daily Expiry Report',
    `Report date: ${reportDateTimeLabel(model)}`,
    summaryLine(model),
    '',
    DIGEST_ATTACHMENT_SENTENCE,
  ];
  if (!empty) {
    lines.push('');
    for (const entry of inlineListEntries(model)) {
      lines.push(`- ${entry.label} — ${formatDaysLeft(entry.daysLeft)}`);
    }
    const remaining = model.entries.length - inlineListEntries(model).length;
    if (remaining > 0) {
      lines.push(`+${remaining} more in the attached PDF.`);
    }
  }
  const notes = bodyNotes(model);
  if (notes.length > 0) {
    lines.push('', ...notes);
  }
  lines.push('', `Attachment: ${model.pdfFileName}`);
  return lines.join('\n');
}
