/**
 * SHEET-11 (draft row) and SHEET-12 (keyboard) shared, testable pieces.
 *
 * AG Grid Community already provides click-to-type, F2 / double-click editing,
 * Enter/Tab/Esc, Delete-clears-cell, Ctrl+C/V and undo/redo when configured.
 * The options below are the explicit contract used by <AgGridReact>, and the
 * draft-row helper defines exactly what counts as the "first meaningful value"
 * (focus or keystrokes alone must never create a record).
 */
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
