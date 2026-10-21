import * as XLSX from 'xlsx';

import type { ColumnDefinition } from '../../lib/columns';
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

export interface ImportPreview {
  fileName: string;
  headers: string[];
  /** At most the first twenty non-header rows, keyed by their source headers. */
  rows: Array<Record<string, unknown>>;
  /** Matrix form is retained for callers that need exact source positions. */
  rawRows: unknown[][];
  mappings: ImportMapping[];
  unmappedHeaders: string[];
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
    if (header.trim()) {
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
  return {
    fileName: parsed.fileName,
    headers,
    rows: previewRows(headers, dataRows, mappings, columns),
    rawRows: dataRows.slice(0, 20).map((row) => [...row]),
    mappings,
    unmappedHeaders,
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
      const suggested: ColumnInput = {
        id: uniqueColumnId(header, columns),
        name: header,
        type: 'text',
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
