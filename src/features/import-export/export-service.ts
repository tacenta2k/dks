import * as XLSX from 'xlsx';

import {
  DAYS_LEFT_COLUMN_ID,
  DAYS_LEFT_COLUMN_NAME,
  getPrimaryExpiryColumn,
  type ColumnDefinition,
} from '../../lib/columns';
import { calculateDaysLeft, formatDisplayDate, isValidIsoDate } from '../../lib/date';
import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import type { SheetRow } from '../sheet/types';

export interface ExportRequest {
  role?: Role | string | null;
  rows: readonly SheetRow[];
  /** The caller supplies the current, explicit column set and its order. */
  columns: readonly ColumnDefinition[];
  /** Restrict the supplied set without changing its declared order. */
  selectedColumnIds?: readonly string[];
  fileName?: string;
  sheetName?: string;
  /** Local calendar date used to compute the exported Days Left column. */
  today?: string | Date;
}

export interface CsvExportArtifact {
  fileName: string;
  mimeType: 'text/csv;charset=utf-8';
  data: string;
  columns: ColumnDefinition[];
  rowCount: number;
}

export interface XlsxExportArtifact {
  fileName: string;
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  data: Uint8Array;
  columns: ColumnDefinition[];
  rowCount: number;
}

export type ExportArtifact = CsvExportArtifact | XlsxExportArtifact;

export type ExportSaveCallback = (artifact: ExportArtifact) => void;

function isSheetRowArray(value: ExportRequest | readonly SheetRow[]): value is readonly SheetRow[] {
  return Array.isArray(value);
}

export function assertExportAccess(role: Role | string | null | undefined): void {
  if (!can(role, 'export')) {
    throw new Error('Only administrators can export records.');
  }
}

function selectedColumns(request: ExportRequest): ColumnDefinition[] {
  // Only visible user columns are exported; deleted/hidden columns and the
  // `+` action column never appear in files. Days Left is appended below.
  const activeColumns = request.columns.filter((column) => (
    column.deleted !== true && column.visible !== false
  ));
  const chosen = !request.selectedColumnIds
    ? activeColumns.map((column) => ({ ...column }))
    : (() => {
      const byId = new Map(activeColumns.map((column) => [column.id, column]));
      return request.selectedColumnIds
        .map((id) => byId.get(id))
        .filter((column): column is ColumnDefinition => Boolean(column))
        .map((column) => ({ ...column }));
    })();

  const daysLeftColumn: ColumnDefinition = {
    id: DAYS_LEFT_COLUMN_ID,
    name: DAYS_LEFT_COLUMN_NAME,
    type: 'number',
    position: chosen.length,
    visible: true,
  };
  return [...chosen, daysLeftColumn];
}

function cellValue(row: SheetRow, column: ColumnDefinition): unknown {
  return row.data[column.id] ?? row.data[column.name] ?? '';
}

function isDateColumn(column: ColumnDefinition): boolean {
  return column.type === 'date_start' || column.type === 'date_expiry';
}

/**
 * Render one cell for a file export. Dates appear as DD/MM/YYYY (F2); the
 * generated Days Left column carries the numeric day count computed from the
 * primary expiry column.
 */
function exportCell(row: SheetRow, column: ColumnDefinition, request: ExportRequest): unknown {
  if (column.id === DAYS_LEFT_COLUMN_ID) {
    const primary = getPrimaryExpiryColumn(request.columns.filter((candidate) => candidate.deleted !== true));
    const raw = primary ? cellValue(row, primary) : null;
    const iso = typeof raw === 'string' && isValidIsoDate(raw.trim()) ? raw.trim() : null;
    return iso ? calculateDaysLeft(iso, request.today) : '';
  }
  const value = cellValue(row, column);
  if (isDateColumn(column) && typeof value === 'string' && value.trim()) {
    return formatDisplayDate(value.trim()) || value;
  }
  return value;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function csvCell(value: unknown): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function fileNameWithExtension(fileName: string | undefined, extension: 'csv' | 'xlsx'): string {
  const fallback = `dks-export.${extension}`;
  const value = fileName?.trim();
  if (!value) {
    return fallback;
  }
  return value.toLowerCase().endsWith(`.${extension}`) ? value : `${value}.${extension}`;
}

/** Build a CSV artifact without opening a dialog or writing to disk. */
export function createCsvExport(request: ExportRequest): CsvExportArtifact;
export function createCsvExport(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options?: Omit<ExportRequest, 'rows' | 'columns'>,
): CsvExportArtifact;
export function createCsvExport(
  requestOrRows: ExportRequest | readonly SheetRow[],
  providedColumns?: readonly ColumnDefinition[],
  providedOptions: Omit<ExportRequest, 'rows' | 'columns'> = {},
): CsvExportArtifact {
  const request: ExportRequest = isSheetRowArray(requestOrRows)
    ? { ...providedOptions, rows: requestOrRows, columns: providedColumns ?? [] }
    : requestOrRows;
  assertExportAccess(request.role);
  const columns = selectedColumns(request);
  const lines = [
    columns.map((column) => csvCell(column.name)).join(','),
    ...request.rows.map((row) => columns.map((column) => csvCell(exportCell(row, column, request))).join(',')),
  ];

  return {
    fileName: fileNameWithExtension(request.fileName, 'csv'),
    mimeType: 'text/csv;charset=utf-8',
    data: `${lines.join('\r\n')}\r\n`,
    columns,
    rowCount: request.rows.length,
  };
}

/** Build an XLSX artifact without opening a dialog or writing to disk. */
export function createXlsxExport(request: ExportRequest): XlsxExportArtifact;
export function createXlsxExport(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options?: Omit<ExportRequest, 'rows' | 'columns'>,
): XlsxExportArtifact;
export function createXlsxExport(
  requestOrRows: ExportRequest | readonly SheetRow[],
  providedColumns?: readonly ColumnDefinition[],
  providedOptions: Omit<ExportRequest, 'rows' | 'columns'> = {},
): XlsxExportArtifact {
  const request: ExportRequest = isSheetRowArray(requestOrRows)
    ? { ...providedOptions, rows: requestOrRows, columns: providedColumns ?? [] }
    : requestOrRows;
  assertExportAccess(request.role);
  const columns = selectedColumns(request);
  const values = [
    columns.map((column) => column.name),
    ...request.rows.map((row) => columns.map((column) => exportCell(row, column, request))),
  ];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(values);
  XLSX.utils.book_append_sheet(workbook, worksheet, request.sheetName?.trim() || 'DKS Export');
  const written = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const data = written instanceof Uint8Array
    ? written
    : new Uint8Array(written as ArrayBuffer);

  return {
    fileName: fileNameWithExtension(request.fileName, 'xlsx'),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data,
    columns,
    rowCount: request.rows.length,
  };
}

/** Invoke an application-provided save callback for a CSV artifact. */
export function saveCsvExport(request: ExportRequest & { save: ExportSaveCallback }): CsvExportArtifact {
  const artifact = createCsvExport(request);
  request.save(artifact);
  return artifact;
}

/** Invoke an application-provided save callback for an XLSX artifact. */
export function saveXlsxExport(request: ExportRequest & { save: ExportSaveCallback }): XlsxExportArtifact {
  const artifact = createXlsxExport(request);
  request.save(artifact);
  return artifact;
}

/** Convenience API for callers that already have rows and columns separately. */
export function exportRowsToCsv(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options: Omit<ExportRequest, 'rows' | 'columns'> = {},
): string {
  return createCsvExport({ ...options, rows, columns }).data;
}

/** Convenience API for callers that already have rows and columns separately. */
export function exportRowsToXlsx(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options: Omit<ExportRequest, 'rows' | 'columns'> = {},
): Uint8Array {
  return createXlsxExport({ ...options, rows, columns }).data;
}

export const exportToCsv = createCsvExport;
export const exportToXlsx = createXlsxExport;
export const buildCsvExport = createCsvExport;
export const buildXlsxExport = createXlsxExport;

/** String-oriented aliases for hosts that do not need artifact metadata. */
export const csvForRows = exportRowsToCsv;
export const xlsxForRows = exportRowsToXlsx;
