import * as XLSX from 'xlsx';

import { isReservedSystemColumnName, type ColumnDefinition } from '../../lib/columns';
import { formatDisplayDate, toStorableDateValue } from '../../lib/date';
import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import type { AuditPayload } from '../audit/audit-types';
import type { SheetRepository } from '../sheet/repository';
import type { ColumnInput } from '../sheet/types';

export type ImportSource =
  | string
  | ArrayBuffer
  | Uint8Array
  | Blob
  | { name?: string; arrayBuffer: () => Promise<ArrayBuffer> };

export interface ImportActor {
  id: string;
  name?: string | null;
}

export interface ImportMapping {
  header: string;
  sourceIndex: number;
  columnId: string;
  columnName: string;
}

export type ImportColumnType = 'text' | 'date_start' | 'date_expiry' | 'civil_id';

export interface ImportDateSuggestion {
  header: string;
  type: 'date_start' | 'date_expiry' | 'civil_id';
}

/** A header is mapped onto an existing non-date column that holds date-like values. */
export interface ImportDateMappedToText {
  header: string;
  columnId: string;
  columnName: string;
}

export interface ImportPreview {
  fileName: string;
  headers: string[];
  /** At most the first twenty non-header rows, keyed by their source headers. */
  rows: Array<Record<string, unknown>>;
  /** Matrix form is retained for callers that need exact source positions. */
  rawRows: unknown[][];
  mappings: ImportMapping[];
  unmappedHeaders: string[];
  /** Unmapped headers whose header or values look date-like, with a suggested date type. */
  suggestedColumnTypes: ImportDateSuggestion[];
  /** Mapped headers whose target column is plain text but whose values look date-like. */
  dateMappedToText: ImportDateMappedToText[];
  totalRows: number;
  truncated: boolean;
}

export interface ImportRecord {
  data: Record<string, unknown>;
  sourceRowNumber: number;
}

export type CreateColumnCallback = (
  header: string,
  suggested: ColumnInput,
) => ColumnDefinition | ColumnInput | null | undefined | Promise<ColumnDefinition | ColumnInput | null | undefined>;

export interface ImportOptions {
  role?: Role | string | null;
  columns: readonly ColumnDefinition[];
  fileName?: string;
  actor?: ImportActor;
  /** Optional application-owned column creation hook for otherwise-unmapped headers. */
  createColumn?: CreateColumnCallback;
  /** A repository is accepted as a convenience for future adapters; it is never required. */
  repository?: Pick<SheetRepository, 'addColumn'>;
  /** Set false to surface unmapped headers as an error instead of ignoring them. */
  ignoreUnmapped?: boolean;
  /**
   * User-chosen types for UNMAPPED headers (from the import preview dialog),
   * keyed by header. Without an explicit choice the service falls back to
   * `suggestImportColumnType` so date-like data never silently becomes text.
   */
  newColumnTypes?: Record<string, ImportColumnType>;
}

export interface ImportResult {
  records: ImportRecord[];
  preview: ImportPreview;
  columns: ColumnDefinition[];
  mappings: ImportMapping[];
  unmappedHeaders: string[];
  auditPayload: AuditPayload;
}

interface ParsedSource {
  fileName: string;
  matrix: unknown[][];
}

export function assertImportAccess(role: Role | string | null | undefined): void {
  if (!can(role, 'import')) {
    throw new Error('Only administrators can import records.');
  }
}

function sourceFileName(source: ImportSource, explicit?: string): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (typeof source === 'object' && source !== null && 'name' in source && typeof source.name === 'string') {
    return source.name.trim() || 'import';
  }
  return 'import';
}

async function sourceForXlsx(source: ImportSource): Promise<string | ArrayBuffer | Uint8Array> {
  if (typeof source === 'string' || source instanceof Uint8Array || source instanceof ArrayBuffer) {
    return source;
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  return new Uint8Array(await source.arrayBuffer());
}

async function parseSource(source: ImportSource, fileName?: string): Promise<ParsedSource> {
  const input = await sourceForXlsx(source);
  const resolvedName = sourceFileName(source, fileName);
  const isCsvText = typeof input === 'string' || /\.csv$/i.test(resolvedName);

  if (isCsvText) {
    // CSV is parsed as plain text. Letting a spreadsheet library guess types
    // rewrites user-entered dates (10/01/2004 becomes a US-locale value) and
    // strips leading zeroes from text such as passport numbers.
    const text = typeof input === 'string'
      ? input
      : new TextDecoder('utf-8').decode(input instanceof Uint8Array ? input : new Uint8Array(input));
    return { fileName: resolvedName, matrix: parseCsvMatrix(text) };
  }

  const workbook = XLSX.read(input, {
    type: 'array',
    raw: true,
    cellDates: false,
  });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { fileName: resolvedName, matrix: [] };
  }
  const firstSheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
    header: 1,
    defval: '',
    raw: true,
  });
  return {
    fileName: resolvedName,
    matrix: matrix.map((row) => Array.isArray(row) ? row : []),
  };
}

/** Minimal RFC-4180-style CSV matrix parser (quotes, commas, escaped quotes). */
export function parseCsvMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\r' && text[index + 1] === '\n') {
      pushRow();
      index += 2;
      continue;
    }
    if (char === '\n' || char === '\r') {
      pushRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  return rows;
}

const EXCEL_SERIAL_MIN = 20_000;
const EXCEL_SERIAL_MAX = 80_000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function isExcelDateSerial(value: number): boolean {
  return Number.isFinite(value) && value >= EXCEL_SERIAL_MIN && value <= EXCEL_SERIAL_MAX;
}

function excelSerialToIso(value: number): string | null {
  const date = new Date(EXCEL_EPOCH_UTC + Math.round(value) * 86_400_000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function excelSerialToDisplay(value: number): string {
  const iso = excelSerialToIso(value);
  return iso ? formatDisplayDate(iso) : String(value);
}

/**
 * Date-likeness detection for import (NOT a validity check): 31/02/2004 still
 * counts as "looks like a date" so the preview can offer a date column; the
 * impossible value is only resolved later by toStorableDateValue.
 */
const DATE_VALUE_PATTERNS = [
  /^\d{1,2}\/\d{1,2}\/\d{4}$/, // DD/MM/YYYY (and D/M/YYYY)
  /^\d{4}-\d{1,2}-\d{1,2}$/, // YYYY-MM-DD
  /^\d{4}\/\d{1,2}\/\d{1,2}$/, // YYYY/MM/DD
  /^\d{8}$/, // DDMMYYYY compact (10012004)
] as const;

function plausibleCalendarParts(day: number, month: number, year: number): boolean {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2199;
}

export function isDateLikeValue(value: unknown): boolean {
  if (typeof value === 'number' && isExcelDateSerial(value)) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const text = value.trim();
  if (!text || text.length > 11) {
    return false;
  }
  const dashIso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (dashIso) {
    return plausibleCalendarParts(Number(dashIso[3]), Number(dashIso[2]), Number(dashIso[1]));
  }
  const slashIso = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (slashIso) {
    return plausibleCalendarParts(Number(slashIso[3]), Number(slashIso[2]), Number(slashIso[1]));
  }
  const ddMmYyyy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (ddMmYyyy) {
    return plausibleCalendarParts(Number(ddMmYyyy[1]), Number(ddMmYyyy[2]), Number(ddMmYyyy[3]));
  }
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  if (compact) {
    return plausibleCalendarParts(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }
  return DATE_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Sample values under one source header (first 20 data rows, non-empty). */
export function sampleHeaderValues(
  rawRows: readonly unknown[][],
  sourceIndex: number,
): unknown[] {
  return rawRows.slice(0, 20)
    .map((row) => row[sourceIndex])
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

/**
 * Suggest a column type for an UNMAPPED import header.
 * Header hints win (Expiry/Expiration → date_expiry, Start/Issued → date_start);
 * otherwise a majority of date-like sample values yields a date column
 * (default date_expiry — the preview dialog lets the user pick either).
 * Returns null when neither header nor values look date-like.
 */
export function suggestImportColumnType(
  header: string,
  sampleValues: readonly unknown[],
): 'date_start' | 'date_expiry' | 'civil_id' | null {
  const normalized = header.trim().toLowerCase();
  // Civil ID headers map onto the dedicated string type (plain strings with
  // leading zeroes preserved, no format rule).
  if (/civil\s*(id|no|number)|civilid|cpf\b/.test(normalized)) {
    return 'civil_id';
  }
  const headerExpiry = /expir|expiration|lapse|valid.*until|due\s*date/.test(normalized);
  const headerStart = /start|issu|join|hire|arrival|onboard|commenc|valid.*from|birth|dob/.test(normalized);
  if (headerExpiry) {
    return 'date_expiry';
  }
  if (headerStart) {
    return 'date_start';
  }
  const nonEmpty = sampleValues.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (nonEmpty.length === 0) {
    return /date|day\b/.test(normalized) ? 'date_expiry' : null;
  }
  const dateCount = nonEmpty.filter((value) => isDateLikeValue(value)).length;
  const dateRatio = dateCount / nonEmpty.length;
  const valueLike = nonEmpty.length >= 2 ? dateRatio >= 0.6 : dateCount === 1;
  if (valueLike || /date|day\b/.test(normalized)) {
    return 'date_expiry';
  }
  return null;
}

/**
 * Safe conversion of an EXISTING text column's values to a date column.
 * Valid dates become ISO (YYYY-MM-DD); impossible or non-date text is kept
 * exactly as typed — never silently dropped or rewritten.
 */
export function convertColumnDateValues(
  values: readonly unknown[],
): { converted: number; kept: number; nextValues: unknown[] } {
  let converted = 0;
  let kept = 0;
  const nextValues = values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      kept += 1;
      return value;
    }
    const next = toStorableDateValue(value);
    if (typeof next === 'string' && next !== value && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
      converted += 1;
      return next;
    }
    kept += 1;
    return value;
  });
  return { converted, kept, nextValues };
}

/** Display form used by the import preview table. */
function previewCell(value: unknown, columnType: string | undefined): unknown {
  if (columnType === 'date_start' || columnType === 'date_expiry') {
    if (typeof value === 'number' && isExcelDateSerial(value)) {
      return excelSerialToDisplay(value);
    }
    if (typeof value === 'string' && value.trim()) {
      return formatDisplayDate(value.trim()) || value;
    }
  }
  return value;
}

/** Storage form used when writing imported values into row data. */
function importedValue(value: unknown, columnType: string | undefined): unknown {
  if (columnType === 'date_start' || columnType === 'date_expiry') {
    if (typeof value === 'number' && isExcelDateSerial(value)) {
      return excelSerialToIso(value) ?? value;
    }
    return toStorableDateValue(value);
  }
  return value;
}

function normaliseHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function columnForHeader(header: string, columns: readonly ColumnDefinition[]): ColumnDefinition | null {
  const identity = normaliseHeader(header);
  if (!identity) {
    return null;
  }
  return columns.find((column) => (
    normaliseHeader(column.id) === identity || normaliseHeader(column.name) === identity
  )) ?? null;
}

function mappingsForHeaders(
  headers: readonly string[],
  columns: readonly ColumnDefinition[],
): { mappings: ImportMapping[]; unmappedHeaders: string[] } {
  const mappings: ImportMapping[] = [];
  const unmappedHeaders: string[] = [];
  headers.forEach((header, sourceIndex) => {
    if (!header.trim()) {
      return;
    }
    // The generated "Days Left" system column must never be persisted as a
    // user column: an incoming "Days Left" header is skipped entirely — never
    // mapped onto a legacy column of the same name and never auto-created.
    if (isReservedSystemColumnName(header)) {
      return;
    }
    const column = columnForHeader(header, columns);
    if (column) {
      mappings.push({ header, sourceIndex, columnId: column.id, columnName: column.name });
    } else if (!unmappedHeaders.includes(header)) {
      unmappedHeaders.push(header);
    }
  });
  return { mappings, unmappedHeaders };
}

function previewRows(
  headers: readonly string[],
  rawRows: readonly unknown[][],
  mappings: readonly ImportMapping[],
  columns: readonly ColumnDefinition[],
): Array<Record<string, unknown>> {
  const typeByHeader = new Map(mappings.map((mapping) => [
    mapping.header,
    columns.find((column) => column.id === mapping.columnId)?.type,
  ]));
  return rawRows.slice(0, 20).map((row) => headers.reduce<Record<string, unknown>>((record, header, index) => {
    // Reserved system headers (the generated Days Left column) are neither
    // imported nor previewed as importable data.
    if (header.trim() && !isReservedSystemColumnName(header)) {
      record[header] = previewCell(row[index] ?? '', typeByHeader.get(header));
    }
    return record;
  }, {}));
}

function makePreview(parsed: ParsedSource, columns: readonly ColumnDefinition[]): ImportPreview {
  const headerRow = parsed.matrix[0] ?? [];
  const headers = headerRow.map((value) => String(value ?? '').trim());
  const dataRows = parsed.matrix.slice(1);
  const { mappings, unmappedHeaders } = mappingsForHeaders(headers, columns);

  const suggestedColumnTypes: ImportDateSuggestion[] = [];
  const dateMappedToText: ImportDateMappedToText[] = [];
  headers.forEach((header, sourceIndex) => {
    if (!header.trim() || isReservedSystemColumnName(header)) {
      return;
    }
    const samples = sampleHeaderValues(dataRows, sourceIndex);
    const mapped = mappings.find((mapping) => mapping.header === header);
    if (mapped) {
      // A header mapped onto an existing NON-DATE column with date-like values
      // must not be silently treated as a date column — surface it instead.
      const target = columns.find((column) => column.id === mapped.columnId);
      const isDateColumn = target?.type === 'date_start' || target?.type === 'date_expiry';
      if (!isDateColumn && samples.some((value) => isDateLikeValue(value))) {
        dateMappedToText.push({
          header,
          columnId: mapped.columnId,
          columnName: mapped.columnName,
        });
      }
      return;
    }
    const suggested = unmappedHeaders.includes(header)
      ? suggestImportColumnType(header, samples)
      : null;
    if (suggested) {
      suggestedColumnTypes.push({ header, type: suggested });
    }
  });

  return {
    fileName: parsed.fileName,
    headers,
    rows: previewRows(headers, dataRows, mappings, columns),
    rawRows: dataRows.slice(0, 20).map((row) => [...row]),
    mappings,
    unmappedHeaders,
    suggestedColumnTypes,
    dateMappedToText,
    totalRows: dataRows.length,
    truncated: dataRows.length > 20,
  };
}

function slug(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return result || 'imported_column';
}

function uniqueColumnId(name: string, columns: readonly ColumnDefinition[]): string {
  const used = new Set(columns.map((column) => column.id));
  const base = slug(name);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  return candidate;
}

function asColumnDefinition(
  value: ColumnDefinition | ColumnInput,
  header: string,
  columns: readonly ColumnDefinition[],
): ColumnDefinition {
  const id = value.id?.trim() || uniqueColumnId(header, columns);
  return {
    ...value,
    id,
    name: value.name?.trim() || header,
    position: ('position' in value ? value.position : undefined) ?? columns.length,
  };
}

function isNonEmptyRow(row: readonly unknown[]): boolean {
  return row.some((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

function valueForSourceRow(row: readonly unknown[], index: number): unknown {
  const value = row[index];
  return value === null || value === undefined ? '' : value;
}

/** Parse and preview the source without invoking column creation callbacks. */
export async function previewImport(source: ImportSource, options: ImportOptions): Promise<ImportPreview> {
  assertImportAccess(options.role);
  const parsed = await parseSource(source, options.fileName);
  return makePreview(parsed, options.columns);
}

/** Parse a source, resolve mappings, and return row records plus an audit payload. */
export async function importRows(source: ImportSource, options: ImportOptions): Promise<ImportResult> {
  assertImportAccess(options.role);
  const parsed = await parseSource(source, options.fileName);
  const sourcePreview = makePreview(parsed, options.columns);
  let columns = options.columns.map((column) => ({ ...column }));
  let mappings = [...sourcePreview.mappings];
  const unresolved = [...sourcePreview.unmappedHeaders];

  for (const header of sourcePreview.unmappedHeaders) {
    let created: ColumnDefinition | ColumnInput | null | undefined;
    if (options.createColumn) {
      // User choice from the preview dialog wins; otherwise the detection
      // fallback applies so date-like data never silently becomes text.
      const samples = sampleHeaderValues(
        parsed.matrix.slice(1),
        sourcePreview.headers.findIndex((candidate) => candidate === header),
      );
      const chosenType: ImportColumnType = options.newColumnTypes?.[header]
        ?? suggestImportColumnType(header, samples)
        ?? 'text';
      const suggested: ColumnInput = {
        id: uniqueColumnId(header, columns),
        name: header,
        type: chosenType,
      };
      created = await options.createColumn(header, suggested);
      if (created && options.repository && !('position' in created) && created.id) {
        created = await options.repository.addColumn(created);
      }
    }

    if (!created) {
      continue;
    }

    const column = asColumnDefinition(created, header, columns);
    columns = [...columns, column];
    const sourceIndex = sourcePreview.headers.findIndex((candidate) => candidate === header);
    mappings = [...mappings, {
      header,
      sourceIndex,
      columnId: column.id,
      columnName: column.name,
    }];
    const index = unresolved.indexOf(header);
    if (index >= 0) {
      unresolved.splice(index, 1);
    }
  }

  if (unresolved.length > 0 && options.ignoreUnmapped === false) {
    throw new Error(`Unmapped import columns: ${unresolved.join(', ')}`);
  }

  const records: ImportRecord[] = [];
  const rawRows = parsed.matrix.slice(1);
  const columnTypeById = new Map(columns.map((column) => [column.id, column.type]));
  rawRows.forEach((row, rowIndex) => {
    if (!isNonEmptyRow(row)) {
      return;
    }
    const data = mappings.reduce<Record<string, unknown>>((record, mapping) => {
      const value = valueForSourceRow(row, mapping.sourceIndex);
      if (value !== '') {
        // Date columns store ISO (YYYY-MM-DD); DD/MM/YYYY (and compact/dashed
        // variants) are normalised on import. Impossible dates keep their text
        // so the row-level preview can surface the problem instead of silently
        // rewriting it. Text-like values keep leading zeroes as typed.
        const columnType = columnTypeById.get(mapping.columnId);
        record[mapping.columnId] = importedValue(value, columnType);
      }
      return record;
    }, {});
    records.push({ data, sourceRowNumber: rowIndex + 2 });
  });

  const timestamp = new Date().toISOString();
  const auditPayload: AuditPayload = {
    action: 'import',
    actorId: options.actor?.id ?? null,
    actor: options.actor?.name ?? null,
    timestamp,
    details: {
      fileName: parsed.fileName,
      importedRows: records.length,
      mappedColumns: mappings.map((mapping) => mapping.columnId),
      unmappedHeaders: unresolved,
    },
  };

  return {
    records,
    preview: sourcePreview,
    columns,
    mappings,
    unmappedHeaders: unresolved,
    auditPayload,
  };
}

export const parseImportPreview = previewImport;
export const buildImportPreview = previewImport;
export const importSpreadsheet = importRows;
