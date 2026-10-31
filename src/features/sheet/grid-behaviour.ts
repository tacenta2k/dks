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

/* --------------------------------------------------------------------------
 * Bug 2 — one Enter must create exactly one row.
 *
 * Two small, pure pieces carry the contract (SheetPage wires them in):
 *
 * 1. `isRepeatOrComposingKey` — a HELD Enter fires repeated keydowns
 *    (`event.repeat`), and Enter that merely confirms an IME composition
 *    candidate fires while `isComposing` (legacy keyCode 229). Neither is a
 *    new commit gesture, so neither may (re)trigger the draft create.
 *
 * 2. `DraftCreateIdentityBox` — the draft row's create carries a stable
 *    client-generated row id + idempotency key. Every retry of the SAME
 *    draft commit (focus-loss commit after Enter, a replayed
 *    cell-value-changed, an IPC retry) reuses that identity, so the layers
 *    below can turn it into "return the existing row" instead of a second
 *    insert. The identity rotates only when a NEW draft editing session
 *    begins after a successful create — typing the same name again in the
 *    fresh draft row is a legitimate new record with a fresh identity.
 * ------------------------------------------------------------------------ */

/** Structural subset of KeyboardEvent / React.KeyboardEvent we need. */
export interface KeyEventLike {
  repeat?: unknown;
  isComposing?: unknown;
  keyCode?: unknown;
  nativeEvent?: { isComposing?: unknown; keyCode?: unknown } | null;
}

export function isRepeatOrComposingKey(event: KeyEventLike | null | undefined): boolean {
  if (!event) {
    return false;
  }
  return event.repeat === true
    || event.isComposing === true
    || event.nativeEvent?.isComposing === true
    || event.keyCode === 229
    || event.nativeEvent?.keyCode === 229;
}

export interface DraftCreateIdentity {
  id: string;
  idempotencyKey: string;
}

let draftIdentityCounter = 0;

function defaultDraftRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  draftIdentityCounter += 1;
  return `draft-${Date.now()}-${draftIdentityCounter}-${Math.random().toString(16).slice(2)}`;
}

export class DraftCreateIdentityBox {
  private current: (DraftCreateIdentity & { consumed: boolean }) | null = null;

  public constructor(private readonly mintId: () => string = defaultDraftRowId) {}

  /** The identity for the draft commit now in progress (minted on first use). */
  public ensure(): DraftCreateIdentity {
    if (!this.current) {
      const id = this.mintId();
      this.current = { id, idempotencyKey: `entry:create:${id}`, consumed: false };
    }
    return { id: this.current.id, idempotencyKey: this.current.idempotencyKey };
  }

  /** The current identity created its row; keep it for replay dedupe. */
  public markConsumed(): void {
    if (this.current) {
      this.current.consumed = true;
    }
  }

  /** A new draft editing session: a consumed identity rotates to a fresh one. */
  public prepareForNextDraftEdit(): void {
    if (this.current?.consumed) {
      this.current = null;
    }
  }
}

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
 * Draft-row commit → focus handoff.
 *
 * The draft row is synthetic: committing it creates a REAL record whose place
 * in the sheet is decided by the repository (the local store returns
 * `ORDER BY updated_at DESC`, so a new record lands at the TOP) and by the
 * draft row being pinned last. The draft row's rowIndex before the commit is
 * therefore meaningless afterwards, and no single animation frame is a safe
 * moment to act on. The only stable coordinates are the new record's row id
 * and the target column id; `rowIndexOfRowId` resolves those to the row's
 * CURRENT grid position once the refreshed data has reached the row model.
 * ------------------------------------------------------------------------ */

/** Where the cursor must land after a draft-row commit. */
export interface DraftFocusTarget {
  /** Stable row id to land in — the created record, or the fresh draft. */
  rowId: string;
  /** Editable user column id to edit in that record. */
  columnId: string;
  /**
   * Column to keep editing on the fresh draft when the created record is not
   * displayed (e.g. an active filter hides it): continuous entry then falls
   * back to the same column the user typed in.
   */
  draftColumnId: string;
}

/**
 * The logical record + column a draft commit must hand the cursor to.
 *
 * Tab continues into the NEXT editable user column of the created record;
 * Enter (and Tab at the last editable column) keeps continuous entry on the
 * fresh draft row, exactly as before. `createdRowId` is always supplied, but
 * it is only used for the Tab case — the draft row id stays synthetic.
 */
export function draftFocusTarget(
  intent: 'tab' | 'enter' | null,
  createdRowId: string,
  committedColumnId: string,
  editableColumnIds: readonly string[],
): DraftFocusTarget {
  const nextColumnId = intent === 'tab'
    ? nextTabbableColumnId(committedColumnId, editableColumnIds, false)
    : null;
  if (nextColumnId) {
    return { rowId: createdRowId, columnId: nextColumnId, draftColumnId: committedColumnId };
  }
  return { rowId: DRAFT_ROW_ID, columnId: committedColumnId, draftColumnId: committedColumnId };
}

/** Structural subset of GridApi needed to resolve a row's position. */
export interface RowLookupApi {
  getRowNode: (id: string) => { rowIndex?: number | null } | undefined | null;
}

/**
 * The row's CURRENT index in the grid row model, or null when the row is not
 * in the model (not applied yet, or not displayed because of a filter).
 * Never trust a rowIndex captured before a data/model update.
 */
export function rowIndexOfRowId(api: RowLookupApi, rowId: string): number | null {
  const node = api.getRowNode(rowId);
  if (!node || typeof node.rowIndex !== 'number' || node.rowIndex < 0) {
    return null;
  }
  return node.rowIndex;
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
