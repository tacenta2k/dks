/**
 * SHEET-11 (draft row) and SHEET-12 (keyboard) shared, testable pieces.
 *
 * AG Grid Community already provides click-to-type, F2 / double-click editing,
 * Enter/Tab/Esc, Delete-clears-cell, Ctrl+C/V and undo/redo when configured.
 * The options below are the explicit contract used by <AgGridReact>, and the
 * draft-row helper defines exactly what counts as the "first meaningful value"
 * (focus or keystrokes alone must never create a record).
 */
import type { CellPosition, Column, ColumnMovedEvent, GridApi, TabToNextCellParams } from 'ag-grid-community';

import { extractUserColumnOrder, type ColumnDefinition } from '../../lib/columns';

export const DRAFT_ROW_ID = '__draft';

/** AG Grid Community keyboard contract for the sheet (SHEET-12). */
export const GRID_KEYBOARD_PROPS = Object.freeze({
  // Click a cell, then type to edit; F2 / double-click also edit.
  singleClickEdit: false,
  // Enter commits and moves down (not sideways).
  enterNavigatesVertically: true,
  enterNavigatesVerticallyAfterEdit: true,
  // Tab commits and moves right (AG Grid default), Esc cancels the edit.
  stopEditingWhenCellsLoseFocus: true,
  // Ctrl+Z / Ctrl+Y for supported edits.
  undoRedoCellEditing: true,
  undoRedoCellEditingLimit: 20,
  // Ctrl+C / Ctrl+V: plain text values, formulas are never interpreted.
  enableCellTextSelection: true,
  suppressCopyRowsToClipboard: true,
  suppressCutToClipboard: true,
} as const);

/**
 * Is this a value that should create the draft record?
 *
 * `0` and `false` are meaningful (an explicit numeric zero / unchecked box),
 * empty strings, null and undefined are not. Keystrokes are only evaluated
 * when the cell editor commits, so typing can never create several rows.
 */
export function isMeaningfulDraftValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean') {
    return true;
  }
  return true;
}

/** R2-07: the grid theme class follows the app theme (no white dark panels). */
export function sheetGridThemeClass(theme: 'light' | 'dark' | string): string {
  return theme === 'dark'
    ? 'ag-theme-quartz ag-theme-quartz-dark'
    : 'ag-theme-quartz';
}

/* --------------------------------------------------------------------------
 * SHEET-12 — Excel-style Tab / Shift+Tab while editing.
 *
 * Tab commits the current editor AND starts editing the next editable column;
 * Shift+Tab goes backwards. The system/utility columns (#, Actions, +, Days
 * Left) are never tab targets — the caller supplies the ordered editable user
 * column ids, so the skip is by contract, not by guessing from the rendered
 * grid. At a row edge Tab simply commits and stays (focus never escapes the
 * grid); on the pinned draft row the DRAFT-COMMIT path then refocuses the
 * created record.
 * ------------------------------------------------------------------------ */

/**
 * The next editable user column id when tabbing from `currentId`, or null at
 * the row edges. `backwards` is Shift+Tab. Pure — fully unit testable.
 */
export function nextTabbableColumnId(
  currentId: string,
  editableColumnIds: readonly string[],
  backwards: boolean,
): string | null {
  const index = editableColumnIds.indexOf(currentId);
  if (index === -1) {
    return null;
  }
  return editableColumnIds[index + (backwards ? -1 : 1)] ?? null;
}

/**
 * AG Grid `tabToNextCell` callback implementing the Tab contract. AG Grid's
 * own machinery stops the current editor and starts editing the returned
 * cell; returning `true` commits and keeps focus on the current cell.
 *
 * `resolveColumn` maps a column id to the live AG Grid Column (grid API),
 * `editableColumnIds` supplies the ordered tabbable columns for the session.
 */
export function createTabToNextCell<TData>(
  resolveColumn: (columnId: string) => Column<TData> | null,
  editableColumnIds: () => readonly string[],
): (params: TabToNextCellParams<TData>) => boolean | CellPosition {
  return (params: TabToNextCellParams<TData>): boolean | CellPosition => {
    const ids = editableColumnIds();
    if (ids.length === 0) {
      return true; // nothing editable: commit + stay in the grid
    }
    const currentId = String(params.previousCellPosition.column.getColId());
    const nextId = ids.includes(currentId)
      ? nextTabbableColumnId(currentId, ids, params.backwards)
      // Tabbing from a system column (e.g. after clicking #/Actions): jump to
      // the first (or last) editable user column instead of escaping the grid.
      : params.backwards
        ? ids[ids.length - 1]
        : ids[0];
    if (!nextId) {
      return true; // row edge: commit + stay
    }
    const column = resolveColumn(nextId);
    if (!column) {
      return true;
    }
    return {
      rowIndex: params.previousCellPosition.rowIndex,
      rowPinned: params.previousCellPosition.rowPinned ?? null,
      column,
    };
  };
}

/* --------------------------------------------------------------------------
 * Column drag-reorder persistence.
 *
 * AG Grid Community header dragging moves columns visually and reports the
 * gesture through ColumnMovedEvent (`finished: true` only at drop). The
 * grid keeps NO durable state: SheetPage rebuilds `columnDefs` from the
 * persisted `position` order on every refresh, so an unpersisted drag
 * snapped back. The helpers below turn a finished USER drag into the
 * persistable user-column order; SheetPage saves it through the repository
 * (SQLite `app_columns.position` → durable outbox → Supabase).
 *
 * Only genuine UI drags count. Moves reported with an `api` (or any other
 * programmatic) source, and unfinished intermediate drag steps, never
 * persist — together with the "order actually changed" check inside
 * `extractUserColumnOrder`, that keeps quiet background refreshes and
 * remote-snapshot rebuilds from echoing into reorder writes.
 * ------------------------------------------------------------------------ */

/** Structural subset of GridApi used to read the visual column order. */
export interface DisplayedColumnApi {
  getDisplayedLeftColumns: () => readonly Pick<Column, 'getColId'>[];
  getDisplayedCenterColumns: () => readonly Pick<Column, 'getColId'>[];
  getDisplayedRightColumns: () => readonly Pick<Column, 'getColId'>[];
}

/** Visual left→right displayed column ids: pinned-left + centre + pinned-right. */
export function displayedColumnIds(api: DisplayedColumnApi): string[] {
  return [
    ...api.getDisplayedLeftColumns(),
    ...api.getDisplayedCenterColumns(),
    ...api.getDisplayedRightColumns(),
  ].map((column) => String(column.getColId()));
}

/**
 * The new user-column order for a finished user drag, or null when the
 * event must not persist anything (unfinished, programmatic, system-only,
 * or the order is unchanged). `activeColumns` is the currently persisted
 * display order (already position-sorted by the caller).
 */
export function columnOrderFromMovedEvent<TData>(
  event: Pick<ColumnMovedEvent<TData>, 'finished' | 'source'> & { api?: GridApi<TData> | null },
  activeColumns: readonly ColumnDefinition[],
): string[] | null {
  if (!event || event.finished !== true) {
    return null;
  }
  if (event.source !== 'uiColumnDragged' && event.source !== 'uiColumnMoved') {
    return null;
  }
  if (!event.api) {
    return null;
  }
  return extractUserColumnOrder(displayedColumnIds(event.api), activeColumns);
}
