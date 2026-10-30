import { getPrimaryExpiryColumn, type ColumnDefinition } from '../../lib/columns';
import { calculateDaysLeft, formatDisplayDate, isValidIsoDate } from '../../lib/date';
import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import type { SheetRow } from '../sheet/types';

export type CanonicalReportFilterId =
  | 'today'
  | 'week'
  | 'month'
  | '2-months'
  | '3-months'
  | '6-months'
  | '1-year'
  | 'expired'
  | 'all';

/** Common persisted spellings are accepted and normalized to the canonical ids. */
export type ReportFilterId = CanonicalReportFilterId
  | '2months'
  | '3months'
  | '6months'
  | '1year'
  | '2Months'
  | '3Months'
  | '6Months'
  | '1Year'
  | 'expiringToday'
  | 'expiringThisWeek'
  | 'expiringThisMonth'
  | 'within2Months'
  | 'within3Months'
  | 'within6Months'
  | 'within1Year';

export interface ReportFilterOption {
  id: CanonicalReportFilterId;
  label: string;
  maximumDays?: number;
}

export const REPORT_FILTERS: readonly ReportFilterOption[] = Object.freeze([
  { id: 'today', label: 'Today', maximumDays: 0 },
  { id: 'week', label: 'Week', maximumDays: 7 },
  { id: 'month', label: 'Month', maximumDays: 30 },
  { id: '2-months', label: '2 months', maximumDays: 60 },
  { id: '3-months', label: '3 months', maximumDays: 90 },
  { id: '6-months', label: '6 months', maximumDays: 180 },
  { id: '1-year', label: '1 year', maximumDays: 365 },
  { id: 'expired', label: 'Expired' },
  { id: 'all', label: 'All' },
]);

export interface ReportColumn extends Pick<ColumnDefinition, 'id' | 'name' | 'type'> {
  generated?: boolean;
}

export interface PrintReportRow {
  id: string;
  values: Record<string, unknown>;
  daysLeft: number | null;
  source: SheetRow;
}

export interface PrintReportModel {
  header: string;
  generatedAt: string;
  filter: CanonicalReportFilterId;
  filterSummary: string;
  columns: ReportColumn[];
  /** All active source columns let the view render a picker after model creation. */
  availableColumns: ReportColumn[];
  rows: PrintReportRow[];
  page: {
    pageSize: number;
    pageCount: number;
    totalRows: number;
  };
}

export interface PrintReportOptions {
  role?: Role | string | null;
  filter?: ReportFilterId;
  today?: string | Date;
  generatedAt?: string | Date;
  title?: string;
  selectedColumnIds?: readonly string[];
  pageSize?: number;
}

export interface PrintReportRequest extends PrintReportOptions {
  rows: readonly SheetRow[];
  columns: readonly ColumnDefinition[];
}

export interface PdfExportFile {
  fileName: string;
  mimeType: 'application/pdf';
  data: Uint8Array;
}

export interface PdfExportOptions {
  role?: Role | string | null;
  fileName?: string;
  save?: (file: PdfExportFile) => void;
}

function isPrintReportRequest(
  value: readonly SheetRow[] | PrintReportRequest,
): value is PrintReportRequest {
  return !Array.isArray(value);
}

export function assertPrintAccess(role: Role | string | null | undefined): void {
  if (!can(role, 'print')) {
    throw new Error('Only administrators can print or export reports.');
  }
}

function optionForFilter(filter: CanonicalReportFilterId): ReportFilterOption {
  return REPORT_FILTERS.find((candidate) => candidate.id === filter) ?? REPORT_FILTERS[REPORT_FILTERS.length - 1];
}

function filterSummary(filter: CanonicalReportFilterId): string {
  const option = optionForFilter(filter);
  if (filter === 'today') {
    return 'Expiring today';
  }
  if (filter === 'expired') {
    return 'Expired records';
  }
  if (filter === 'all') {
    return 'All records';
  }
  const label = option.label.toLowerCase();
  return `Expiring within ${label === 'week' || label === 'month' ? `1 ${label}` : label}`;
}

export function normalizeReportFilter(filter: ReportFilterId | undefined): CanonicalReportFilterId {
  if (!filter) {
    return 'all';
  }
  const compact = filter.toLowerCase().replace(/[\s_-]/g, '');
  switch (compact) {
    case 'today':
    case 'expiringtoday':
      return 'today';
    case 'week':
    case 'expiringthisweek':
      return 'week';
    case 'month':
    case 'expiringthismonth':
      return 'month';
    case '2months':
    case 'within2months':
      return '2-months';
    case '3months':
    case 'within3months':
      return '3-months';
    case '6months':
    case 'within6months':
      return '6-months';
    case '1year':
    case 'within1year':
      return '1-year';
    case 'expired':
      return 'expired';
    default:
      return 'all';
  }
}

function sourceValue(row: SheetRow, column: Pick<ColumnDefinition, 'id' | 'name'>): unknown {
  return row.data[column.id] ?? row.data[column.name] ?? '';
}

function activeReportColumns(columns: readonly ColumnDefinition[]): ReportColumn[] {
  return columns
    .filter((column) => column.deleted !== true)
    .map((column) => ({ id: column.id, name: column.name, type: column.type }));
}

function selectedReportColumns(
  columns: readonly ColumnDefinition[],
  selectedColumnIds?: readonly string[],
): ReportColumn[] {
  const active = activeReportColumns(columns);
  if (!selectedColumnIds) {
    return active;
  }
  const byId = new Map(active.map((column) => [column.id, column]));
  return selectedColumnIds
    .map((id) => byId.get(id))
    .filter((column): column is ReportColumn => Boolean(column));
}

function reportRowsMatch(daysLeft: number | null, filter: CanonicalReportFilterId): boolean {
  if (filter === 'all') {
    return true;
  }
  if (daysLeft === null) {
    return false;
  }
  if (filter === 'expired') {
    return daysLeft <= 0;
  }
  if (filter === 'today') {
    return daysLeft === 0;
  }
  const maximum = optionForFilter(filter).maximumDays;
  return maximum !== undefined && daysLeft >= 0 && daysLeft <= maximum;
}

function generatedAtValue(value?: string | Date): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
}

function printableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
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

function printableCellValue(value: unknown, column: Pick<ReportColumn, 'type'>): string {
  if (column.type === 'date_start' || column.type === 'date_expiry') {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    return formatDisplayDate(String(value));
  }
  return printableValue(value);
}

/**
 * Build the report's filtered, explicitly-selected, Days Left-ascending
 * representation.  No printing or file access occurs here.
 */
export function buildPrintReportModel(
  rows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options?: PrintReportOptions,
): PrintReportModel;
export function buildPrintReportModel(request: PrintReportRequest): PrintReportModel;
export function buildPrintReportModel(
  rowsOrRequest: readonly SheetRow[] | PrintReportRequest,
  providedColumns?: readonly ColumnDefinition[],
  providedOptions: PrintReportOptions = {},
): PrintReportModel {
  const request = isPrintReportRequest(rowsOrRequest) ? rowsOrRequest : null;
  const rows = request ? request.rows : rowsOrRequest as readonly SheetRow[];
  const columns = request ? request.columns : (providedColumns ?? []);
  const options: PrintReportOptions = request ?? providedOptions;
  if (options.role !== undefined && !can(options.role, 'print')) {
    throw new Error('Only administrators can build print reports.');
  }

  const filter = normalizeReportFilter(options.filter);
  const primaryExpiry = getPrimaryExpiryColumn(columns);
  const availableColumns = activeReportColumns(columns);
  const chosenColumns = selectedReportColumns(columns, options.selectedColumnIds);
  const reportColumns: ReportColumn[] = [
    ...chosenColumns.filter((column) => column.id !== 'daysLeft'),
    { id: 'daysLeft', name: 'Days Left', type: 'number', generated: true },
  ];

  const reportRows = rows
    .filter((row) => row.deleted !== true)
    .map((row) => {
      const expiryValue = primaryExpiry ? sourceValue(row, primaryExpiry) : null;
      const expiry = typeof expiryValue === 'string' && isValidIsoDate(expiryValue) ? expiryValue : null;
      const daysLeft = calculateDaysLeft(expiry, options.today);
      const values = chosenColumns.reduce<Record<string, unknown>>((record, column) => {
        record[column.id] = sourceValue(row, column);
        return record;
      }, {});
      return { id: row.id, values, daysLeft, source: row };
    })
    .filter((row) => reportRowsMatch(row.daysLeft, filter))
    .sort((left, right) => {
      if (left.daysLeft === null && right.daysLeft === null) {
        return left.id.localeCompare(right.id);
      }
      if (left.daysLeft === null) {
        return 1;
      }
      if (right.daysLeft === null) {
        return -1;
      }
      return left.daysLeft - right.daysLeft || left.id.localeCompare(right.id);
    });

  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 25));
  return {
    header: options.title?.trim() || 'DKS Expiry Report',
    generatedAt: generatedAtValue(options.generatedAt),
    filter,
    filterSummary: filterSummary(filter),
    columns: reportColumns,
    availableColumns,
    rows: reportRows,
    page: {
      pageSize,
      pageCount: Math.max(1, Math.ceil(reportRows.length / pageSize)),
      totalRows: reportRows.length,
    },
  };
}

function pdfFileName(fileName?: string): string {
  const value = fileName?.trim();
  if (!value) {
    return 'dks-report.pdf';
  }
  return value.toLowerCase().endsWith('.pdf') ? value : `${value}.pdf`;
}

/**
 * Create PDF bytes and optionally hand them to an application-owned saver.
 *
 * jsPDF and its table plugin are fetched here, on the first PDF export. The
 * permission check runs before the import so an Office caller is refused
 * without downloading anything, and the print dialog path never fetches them.
 */
export async function exportReportToPdf(
  model: PrintReportModel,
  options: PdfExportOptions = {},
): Promise<PdfExportFile> {
  assertPrintAccess(options.role);
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const document = new jsPDF();
  document.setProperties({ title: model.header, subject: model.filterSummary });
  document.setFontSize(16);
  document.text(model.header, 14, 18);
  document.setFontSize(9);
  const generatedDate = model.generatedAt.slice(0, 10);
  document.text(`${model.filterSummary} · Generated ${formatDisplayDate(generatedDate)}`, 14, 25);
  autoTable(document, {
    startY: 31,
    head: [model.columns.map((column) => column.name)],
    body: model.rows.map((row) => model.columns.map((column) => (
      column.generated
        ? printableValue(row.daysLeft)
        : printableCellValue(row.values[column.id], column)
    ))),
    styles: { fontSize: 8 },
  });
  const arrayBuffer = document.output('arraybuffer') as ArrayBuffer;
  const file: PdfExportFile = {
    fileName: pdfFileName(options.fileName),
    mimeType: 'application/pdf',
    data: new Uint8Array(arrayBuffer),
  };
  options.save?.(file);
  return file;
}

export const buildReportModel = buildPrintReportModel;
export const createPrintReportModel = buildPrintReportModel;
export const exportReportPdf = exportReportToPdf;
