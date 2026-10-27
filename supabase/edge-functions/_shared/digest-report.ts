/**
 * DKS daily expiry report — shared model, window/order selection, value
 * formatting, masking, and HTML/plain-text rendering.
 *
 * Pure TypeScript (no Deno/Node/Electron imports) so the SAME code is unit
 * tested with vitest from this repository and bundled into the `send-email`
 * Edge Function at deploy time. The PDF renderer lives in ./digest-pdf.ts.
 *
 * Business rules implemented here (and mirrored by
 * ARENA/sql/expiry-digest-report.sql):
 *   - 30-day window for THIS report only (expired + today + 1..30).
 *   - daysLeft recomputed from the Asia/Muscat business calendar on every run.
 *   - ordering: expired (most overdue first) → today → upcoming 1..30 asc.
 *   - passport / Civil ID masked by default unless an Admin opted in.
 */

import { escapeHtml } from './email.ts';
import { formatDisplayDate, isValidIsoDate } from '../../../src/lib/date.ts';

/** Window for the email/PDF report. Deliberately NOT the workspace setting. */
export const EXPIRY_REPORT_WINDOW_DAYS = 30;

/** Hard cap on records carried in one report (email summary + PDF summary). */
export const MAX_REPORT_RECORDS = 200;

/** Hard cap on records that get a full per-column detail block in the PDF. */
export const MAX_DETAIL_RECORDS = 100;

export const EMPTY_VALUE = '—';
export const UNNAMED_LABEL = 'Unnamed record';

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
export type ReportEntryStatus = 'Expired' | 'Expires today' | `Expires in ${number} days`;

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
  return `Expires in ${daysLeft} days`;
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
  includeFullIds?: boolean;
  entries: readonly RawReportEntry[];
  totalQualifying?: number;
}

export function buildDigestReportModel(input: BuildDigestReportModelInput): DigestReportModel {
  const columns = normalizeReportColumns(input.columns);
  const currency = normalizeCurrency(input.currency ?? null);
  const includeFullIds = input.includeFullIds === true;
  const qualifying = selectReportEntries(input.entries, columns, input.reportDateIso);
  const totalQualifying = Number.isFinite(input.totalQualifying)
    ? Math.max(0, Math.trunc(input.totalQualifying ?? 0))
    : qualifying.length;
  // The summary table is capped; the full qualifying count is carried
  // separately so truncation is always visible to the reader.
  const entries = qualifying.slice(0, MAX_REPORT_RECORDS);
  const truncated = totalQualifying > entries.length;

  return {
    reportDate: input.reportDateIso,
    reportDateDisplay: isoToDisplayDate(input.reportDateIso),
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
// HTML + plain-text rendering
// ---------------------------------------------------------------------------

export function pdfAttachmentFileName(reportDateIso: string): string {
  return `DKS-expiry-report-${reportDateIso}.pdf`;
}

function statusColor(status: ReportEntryStatus): string {
  if (status === 'Expired') {
    return '#8a1c1c';
  }
  if (status === 'Expires today') {
    return '#b3261e';
  }
  return '#8a5a00';
}

function daysLeftText(daysLeft: number): string {
  return String(daysLeft);
}

function summaryLine(model: DigestReportModel): string {
  const { summary } = model;
  return [
    `Total listed: ${summary.total}`,
    `Expired: ${summary.expired}`,
    `Expires today: ${summary.today}`,
    `Within 7 days: ${summary.within7}`,
    `Within 30 days: ${summary.within30}`,
  ].join(' · ');
}

function summaryTableRowsHtml(model: DigestReportModel): string {
  return model.entries.map((entry, index) => {
    const color = statusColor(entry.status);
    return [
      '<tr>',
      `<td style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:#666;">${index + 1}</td>`,
      `<td style="padding:7px 8px;border-bottom:1px solid #e6e6e6;">${escapeHtml(entry.label)}</td>`,
      `<td style="padding:7px 8px;border-bottom:1px solid #e6e6e6;">${escapeHtml(isoToDisplayDate(entry.expiry))}</td>`,
      `<td style="padding:7px 8px;border-bottom:1px solid #e6e6e6;">${escapeHtml(daysLeftText(entry.daysLeft))}</td>`,
      `<td style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:${color};font-weight:700;">${escapeHtml(entry.status)}</td>`,
      '</tr>',
    ].join('');
  }).join('');
}

function noticesHtml(model: DigestReportModel): string {
  const notes: string[] = [];
  if (model.truncated) {
    notes.push(
      `This report shows the ${model.entries.length} most urgent of ${model.totalQualifying} records `
      + 'expiring within 30 days.',
    );
  }
  if (model.entries.length === 0) {
    notes.push('All clear — nothing expiring within the next 30 days.');
  }
  if (!model.includeFullIds && model.columns.some((column) => column.sensitive)) {
    notes.push('Passport and Civil ID values are masked in the attached PDF.');
  }
  return notes.map((note) => `<p style="margin:10px 0 0;color:#555;font-size:13px;">${escapeHtml(note)}</p>`).join('');
}

export function renderDigestHtml(model: DigestReportModel): string {
  const empty = model.entries.length === 0;
  const rows = empty
    ? ''
    : `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f4f5f7;text-align:left;">
          <th style="padding:8px;border-bottom:1px solid #d0d0d0;width:28px;">#</th>
          <th style="padding:8px;border-bottom:1px solid #d0d0d0;">Record</th>
          <th style="padding:8px;border-bottom:1px solid #d0d0d0;width:90px;">Expiry</th>
          <th style="padding:8px;border-bottom:1px solid #d0d0d0;width:70px;">Days left</th>
          <th style="padding:8px;border-bottom:1px solid #d0d0d0;width:110px;">Status</th>
        </tr>
      </thead>
      <tbody>${summaryTableRowsHtml(model)}</tbody>
    </table>`;

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>DKS Daily Expiry Report</title></head>',
    '<body style="margin:0;padding:16px;background:#f6f7f9;',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328;">',
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e4e8;',
    'border-radius:10px;padding:20px;">',
    `<h1 style="margin:0 0 4px;font-size:20px;">DKS Daily Expiry Report</h1>`,
    `<p style="margin:0 0 12px;color:#57606a;font-size:13px;">Report date: ${escapeHtml(model.reportDateDisplay)}</p>`,
    `<p style="margin:0 0 6px;font-size:13px;"><strong>Summary</strong></p>`,
    `<p style="margin:0 0 14px;color:#3d444d;font-size:13px;">${escapeHtml(summaryLine(model))}</p>`,
    noticesHtml(model),
    rows,
    '<hr style="border:none;border-top:1px solid #e2e4e8;margin:18px 0 10px;">',
    `<p style="margin:0;font-size:13px;color:#3d444d;">A PDF with the full Visa Sheet columns is attached: `
    + `<strong>${escapeHtml(model.pdfFileName)}</strong>.</p>`,
    '</div></body></html>',
  ].join('');
}

export function renderDigestText(model: DigestReportModel): string {
  const lines = [
    'DKS Daily Expiry Report',
    `Report date: ${model.reportDateDisplay}`,
    '',
    'Summary',
    summaryLine(model),
    '',
  ];
  if (model.truncated) {
    lines.push(
      `This report shows the ${model.entries.length} most urgent of ${model.totalQualifying} `
      + 'records expiring within 30 days.',
      '',
    );
  }
  if (model.entries.length === 0) {
    lines.push('All clear — nothing expiring within the next 30 days.', '');
  } else {
    lines.push(
      '# Record Expiry Days left Status',
      ...model.entries.map((entry, index) =>
        `${index + 1} ${entry.label} ${isoToDisplayDate(entry.expiry)} ${entry.daysLeft} ${entry.status}`,
      ),
    );
    lines.push('');
  }
  if (!model.includeFullIds && model.columns.some((column) => column.sensitive)) {
    lines.push('Passport and Civil ID values are masked in the attached PDF.', '');
  }
  lines.push(`A PDF with the full Visa Sheet columns is attached: ${model.pdfFileName}`);
  return lines.join('\n');
}
