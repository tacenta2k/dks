import type {
  CellClassParams,
  ColDef,
  ValueGetterParams,
} from 'ag-grid-community';

import {
  DAYS_LEFT_COLUMN_ID,
  DAYS_LEFT_COLUMN_NAME,
  dropdownValues,
  getPrimaryExpiryColumn,
  type ColumnDefinition,
} from '../../lib/columns';
import { expiryValues } from '../../lib/domain';
import { findDuplicatePassportValues, validateCell } from '../../lib/validation';
import { RowActionsCell, type RowActionsContext, type SheetGridRendererData } from './row-actions';
import type { SheetRow } from './types';

export interface BuildGridRowsOptions {
  today?: string | Date;
}

export interface GridColumnCallbacks extends RowActionsContext {
}

export interface BuiltGridRows {
  rows: SheetGridRendererData[];
  duplicatePassportValues: Set<string>;
}

function columnValue(row: SheetRow, column: ColumnDefinition): unknown {
  return row.data[column.id] ?? row.data[column.name];
}

function rowLabel(row: SheetRow, columns: readonly ColumnDefinition[]): string {
  const passport = columns.find((column) => column.isPassport === true || column.is_passport === true);
  const preferred = passport
    ? columnValue(row, passport)
    : row.data.passport ?? row.data.Passport ?? row.data.full_name ?? row.data.FullName;
  if (preferred !== null && preferred !== undefined && String(preferred).trim()) {
    return String(preferred);
  }
  return row.id;
}

export function buildGridRows(
  sourceRows: readonly SheetRow[],
  columns: readonly ColumnDefinition[],
  options: BuildGridRowsOptions = {},
): BuiltGridRows {
  const passportColumn = columns.find((column) => (
    column.isPassport === true
    || column.is_passport === true
    || /passport/i.test(column.name)
  ));
  const duplicatePassportValues = passportColumn
    ? findDuplicatePassportValues(sourceRows, passportColumn)
    : new Set<string>();
  const primaryExpiry = getPrimaryExpiryColumn(columns);

  return {
    duplicatePassportValues,
    rows: sourceRows
      .filter((row) => row.deleted !== true)
      .map((row) => {
        const expiryValue = primaryExpiry ? columnValue(row, primaryExpiry) : null;
        const derived = expiryValues(
          typeof expiryValue === 'string' ? expiryValue : null,
          options.today,
        );
        const diagnostics: Record<string, ReturnType<typeof validateCell>> = {};
        columns.forEach((column) => {
          diagnostics[column.id] = validateCell(columnValue(row, column), column, {
            duplicatePassportValues,
          });
        });

        const data: SheetGridRendererData = {
          __rowId: row.id,
          __sheetRow: row,
          __rowLabel: rowLabel(row, columns),
          daysLeft: derived.daysLeft,
          status: derived.status,
          __diagnostics: diagnostics,
        };
        columns.forEach((column) => {
          data[column.id] = columnValue(row, column);
        });
        return data;
      }),
  };
}

function diagnosticClass(
  params: CellClassParams<SheetGridRendererData>,
  columnId: string,
  severity: 'warning' | 'error',
): boolean {
  const diagnostics = params.data?.__diagnostics as Record<string, ReturnType<typeof validateCell>> | undefined;
  return diagnostics?.[columnId]?.severity === severity;
}

export function buildGridColumns(
  columns: readonly ColumnDefinition[],
  callbacks: GridColumnCallbacks,
  role: 'admin' | 'office' | string = 'admin',
): ColDef<SheetGridRendererData>[] {
  const userColumns: ColDef<SheetGridRendererData>[] = columns
    .filter((column) => column.deleted !== true && column.visible !== false)
    .map((column) => {
      const definition: ColDef<SheetGridRendererData> = {
        field: column.id,
        colId: column.id,
        headerName: column.name,
        headerTooltip: column.isPrimaryExpiry ? 'Primary expiry date' : column.name,
        // Primary status controls which expiry drives derived values, not whether
        // an office user may edit that expiry value.
        editable: column.type === 'date_expiry'
          || !(column.isPrimaryExpiry === true || column.is_primary_expiry === true)
          || role === 'admin',
        sortable: true,
        filter: true,
        resizable: true,
        minWidth: 130,
        cellClassRules: {
          'sheet-cell--warning': (params) => diagnosticClass(params, column.id, 'warning'),
          'sheet-cell--error': (params) => diagnosticClass(params, column.id, 'error'),
        },
        tooltipValueGetter: (params) => {
          const diagnostics = params.data?.__diagnostics as Record<string, ReturnType<typeof validateCell>> | undefined;
          return diagnostics?.[column.id]?.message ?? String(params.value ?? '');
        },
      };

      if (column.type === 'dropdown') {
        definition.cellEditor = 'agSelectCellEditor';
        definition.cellEditorParams = { values: [...dropdownValues(column.options)] };
      }
      if (column.type === 'number' || column.type === 'price') {
        definition.type = 'numericColumn';
      }
      return definition;
    });

  const actionsColumn: ColDef<SheetGridRendererData> = {
    colId: '__actions',
    headerName: 'Actions',
    pinned: 'left',
    lockPosition: true,
    suppressMovable: true,
    sortable: false,
    filter: false,
    editable: false,
    width: 245,
    minWidth: 245,
    cellRenderer: RowActionsCell,
  };

  const daysLeftColumn: ColDef<SheetGridRendererData> = {
    colId: DAYS_LEFT_COLUMN_ID,
    headerName: DAYS_LEFT_COLUMN_NAME,
    field: 'daysLeft',
    pinned: 'right',
    lockPosition: 'right',
    suppressMovable: true,
    suppressHeaderMenuButton: true,
    editable: false,
    sortable: true,
    filter: 'agNumberColumnFilter',
    width: 125,
    minWidth: 125,
    cellClass: 'sheet-days-left-cell',
    valueGetter: (params: ValueGetterParams<SheetGridRendererData>) => params.data?.daysLeft ?? null,
    comparator: (left: number | null, right: number | null) => {
      if (left === right) {
        return 0;
      }
      if (left === null || left === undefined) {
        return 1;
      }
      if (right === null || right === undefined) {
        return -1;
      }
      return left - right;
    },
    valueFormatter: (params) => params.value === null || params.value === undefined ? '—' : String(params.value),
  };

  return [actionsColumn, ...userColumns, daysLeftColumn];
}

export function rowClassForStatus(status: string | null): string {
  switch (status) {
    case 'Expired':
      return 'sheet-row--expired';
    case 'Urgent':
      return 'sheet-row--urgent';
    case 'Expiring Soon':
      return 'sheet-row--expiring';
    case 'Valid':
      return 'sheet-row--valid';
    default:
      return '';
  }
}
