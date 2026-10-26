import type {
  CellClassParams,
  ColDef,
  ValueGetterParams,
} from 'ag-grid-community';

import {
  ACTIONS_COLUMN_ID,
  ADD_COLUMN_COLUMN_ID,
  DAYS_LEFT_COLUMN_ID,
  DAYS_LEFT_COLUMN_NAME,
  ROW_NUMBER_COLUMN_ID,
  dropdownValues,
  getPrimaryExpiryColumn,
  type ColumnDefinition,
} from '../../lib/columns';
import { expiryValues } from '../../lib/domain';
import { formatDisplayDate, toStorableDateValue } from '../../lib/date';
import { findDuplicateCivilIdValues, findDuplicatePassportValues, validateCell } from '../../lib/validation';
import { DateCellEditor } from './date-editor';
import { AddColumnHeader } from './add-column-header';
import { RowActionsCell, type RowActionsContext, type SheetGridRendererData } from './row-actions';
import type { SheetRow } from './types';

export interface BuildGridRowsOptions {
  today?: string | Date;
}

export interface GridColumnCallbacks extends RowActionsContext {
  /** FIXES_UI §5.5 (SHEET-10): opens Column Setup from the `+` header. */
  onAddColumn?: () => void;
}

export interface BuiltGridRows {
  rows: SheetGridRendererData[];
  duplicatePassportValues: Set<string>;
  duplicateCivilIdValues: Set<string>;
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
  const civilIdColumn = columns.find((column) => column.type === 'civil_id' && column.deleted !== true);
  const duplicateCivilIdValues = civilIdColumn
    ? findDuplicateCivilIdValues(sourceRows, civilIdColumn)
    : new Set<string>();
  const primaryExpiry = getPrimaryExpiryColumn(columns);

  return {
    duplicatePassportValues,
    duplicateCivilIdValues,
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
            duplicateCivilIdValues,
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

/**
 * Whether a data column is editable for the given role. Primary status
 * controls which expiry drives derived values, not whether an office user may
 * edit that expiry value. Shared by the grid definitions and the Tab
 * navigation contract (both must agree on what is editable).
 */
export function isColumnEditableForRole(
  column: ColumnDefinition,
  role: 'admin' | 'office' | string,
): boolean {
  return column.type === 'date_expiry'
    || !(column.isPrimaryExpiry === true || column.is_primary_expiry === true)
    || role === 'admin';
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
        editable: isColumnEditableForRole(column, role),
        sortable: true,
        filter: true,
        resizable: true,
        // Ordinary user columns are drag-reorderable (AG Grid Community
        // header drag). lockPinned stays off so a column can be dragged
        // into/out of the frozen first-column slot; the finished move is
        // persisted via `position` and these defs then re-derive exactly
        // one pinned-left first column from the saved order.
        suppressMovable: false,
        lockPinned: false,
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
      if (column.type === 'date_start' || column.type === 'date_expiry') {
        // Dates display and type as DD/MM/YYYY while storage stays YYYY-MM-DD.
        definition.cellEditor = DateCellEditor;
        definition.valueFormatter = (params) => {
          const value = params.value;
          if (value === null || value === undefined || value === '') {
            return '';
          }
          return formatDisplayDate(String(value));
        };
        definition.valueParser = (params) => {
          const value = params.newValue;
          if (value === null || value === undefined || value === '') {
            return value;
          }
          // Impossible dates keep the typed text (warned by diagnostics);
          // never silently change it to empty or another date.
          return toStorableDateValue(value) ?? String(value);
        };
      }
      if (column.type === 'number' || column.type === 'price') {
        definition.type = 'numericColumn';
      }
      return definition;
    });

  // FIXES_UI §5.3 (SHEET-06): freeze the first data column so it stays visible
  // while scrolling horizontally across many columns. `pinned` is set
  // EXPLICITLY on every user column ('left' for the current first, null for
  // the rest): AG Grid reuses Column objects when defs are re-applied and
  // only re-syncs pinning when the new def defines `pinned`, so leaving it
  // undefined would keep a demoted first column frozen after a reorder.
  userColumns.forEach((definition, index) => {
    userColumns[index] = { ...definition, pinned: index === 0 ? 'left' : null };
  });

  // FIXES_UI §5.3 (SHEET-06): row-number gutter pinned left. AG Grid v32 has no
  // `rowNumbers` colDef property, so the number is derived from the node index.
  const rowNumberColumn: ColDef<SheetGridRendererData> = {
    colId: ROW_NUMBER_COLUMN_ID,
    headerName: '',
    pinned: 'left',
    lockPosition: true,
    lockPinned: true,
    suppressMovable: true,
    // Display numbers come from AG Grid's current displayed-row model, not
    // source-array position or the record id. Count only real records so
    // sorting/filtering keeps one continuous 1, 2, …, 9, 10 sequence, while
    // the synthetic draft/group-header rows stay unnumbered. When AG Grid
    // cannot supply that model (for example in a unit harness), a valid
    // node.rowIndex is the only fallback; never invent row 1.
    valueGetter: (params: ValueGetterParams<SheetGridRendererData>): number | '' => {
      if (!params.data?.__sheetRow) {
        return '';
      }
      const api = params.api;
      const rowIndex = params.node?.rowIndex;
      if (api && params.node && typeof api.forEachNodeAfterFilterAndSort === 'function') {
        let displayNumber = 0;
        let found = false;
        api.forEachNodeAfterFilterAndSort((candidate) => {
          if (found || !candidate.data?.__sheetRow) {
            return;
          }
          displayNumber += 1;
          if (candidate === params.node || (candidate.id != null && candidate.id === params.node?.id)) {
            found = true;
          }
        });
        if (found) {
          return displayNumber;
        }
      }
      if (
        api
        && typeof rowIndex === 'number'
        && rowIndex >= 0
        && typeof api.getDisplayedRowCount === 'function'
        && typeof api.getDisplayedRowAtIndex === 'function'
      ) {
        const displayedCount = Math.min(api.getDisplayedRowCount(), rowIndex + 1);
        let displayNumber = 0;
        for (let index = 0; index < displayedCount; index += 1) {
          if (api.getDisplayedRowAtIndex(index)?.data?.__sheetRow) {
            displayNumber += 1;
          }
        }
        if (displayNumber > 0) {
          return displayNumber;
        }
      }
      return typeof rowIndex === 'number' && rowIndex >= 0 ? rowIndex + 1 : '';
    },
    sortable: false,
    filter: false,
    editable: false,
    width: 40,
    minWidth: 40,
    maxWidth: 40,
    cellClass: 'sheet-row-number-cell',
  };

  const actionsColumn: ColDef<SheetGridRendererData> = {
    colId: ACTIONS_COLUMN_ID,
    headerName: 'Actions',
    pinned: 'left',
    lockPosition: true,
    lockPinned: true,
    suppressMovable: true,
    sortable: false,
    filter: false,
    editable: false,
    // USER DECISION (R2-09): three compact icon-only buttons fit inside a
    // ~100px column; nothing overflows the row or needs an overlay.
    width: 100,
    minWidth: 100,
    maxWidth: 100,
    cellClass: 'sheet-actions-cell',
    cellRenderer: RowActionsCell,
  };

  // FIXES_UI §5.5 (SHEET-10): the `+` add-column header, pinned before Days
  // Left. Opens Column Setup; blank body; no sort/filter/drag/menu.
  const addColumnColumn: ColDef<SheetGridRendererData> = {
    colId: ADD_COLUMN_COLUMN_ID,
    headerName: '',
    headerComponent: AddColumnHeader,
    headerComponentParams: { onAddColumn: callbacks.onAddColumn },
    pinned: 'right',
    lockPosition: 'right',
    lockPinned: true,
    suppressMovable: true,
    suppressHeaderMenuButton: true,
    sortable: false,
    filter: false,
    editable: false,
    width: 46,
    minWidth: 46,
    maxWidth: 46,
  };

  const daysLeftColumn: ColDef<SheetGridRendererData> = {
    colId: DAYS_LEFT_COLUMN_ID,
    headerName: DAYS_LEFT_COLUMN_NAME,
    field: 'daysLeft',
    pinned: 'right',
    lockPosition: 'right',
    lockPinned: true,
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

  return [rowNumberColumn, actionsColumn, ...userColumns, addColumnColumn, daysLeftColumn];
}

export function rowClassForStatus(status: string | null): string {
  switch (status) {
    case 'Expired':
      return 'sheet-row--expired';
    case 'Expires today':
      return 'sheet-row--today';
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
