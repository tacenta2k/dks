import { describe, expect, it } from 'vitest';

import {
  DRAFT_ROW_ID,
  GRID_KEYBOARD_PROPS,
  draftFocusTarget,
  isMeaningfulDraftValue,
  rowIndexOfRowId,
} from '../src/features/sheet/grid-behaviour';

/**
 * SHEET-11 / SHEET-12 — draft row and keyboard contract.
 */
describe('draft row creates exactly one record from a meaningful value', () => {
  it('treats blank values and focus/keystrokes without a commit as nothing', () => {
    expect(isMeaningfulDraftValue(undefined)).toBe(false);
    expect(isMeaningfulDraftValue(null)).toBe(false);
    expect(isMeaningfulDraftValue('')).toBe(false);
    expect(isMeaningfulDraftValue('   ')).toBe(false);
  });

  it('treats zero and explicit false as real values', () => {
    expect(isMeaningfulDraftValue(0)).toBe(true);
    expect(isMeaningfulDraftValue(false)).toBe(true);
    expect(isMeaningfulDraftValue('0')).toBe(true);
    expect(isMeaningfulDraftValue('Ahmed')).toBe(true);
  });

  it('uses a dedicated draft row id so it can never be mistaken for a record', () => {
    expect(DRAFT_ROW_ID).toBe('__draft');
  });
});

describe('grid keyboard contract (SHEET-12)', () => {
  it('commits with Enter/Tab, cancels with Esc, and supports undo/redo and paste', () => {
    expect(GRID_KEYBOARD_PROPS.enterNavigatesVertically).toBe(true);
    expect(GRID_KEYBOARD_PROPS.enterNavigatesVerticallyAfterEdit).toBe(true);
    expect(GRID_KEYBOARD_PROPS.undoRedoCellEditing).toBe(true);
    expect(GRID_KEYBOARD_PROPS.undoRedoCellEditingLimit).toBeGreaterThan(0);
    expect(GRID_KEYBOARD_PROPS.enableCellTextSelection).toBe(true);
    expect(GRID_KEYBOARD_PROPS.stopEditingWhenCellsLoseFocus).toBe(true);
    // Click-to-type (not single-click edit), so a click alone never edits.
    expect(GRID_KEYBOARD_PROPS.singleClickEdit).toBe(false);
    // Paste stays plain text: spreadsheet formulas are never copied as formulas.
    expect(GRID_KEYBOARD_PROPS.suppressCopyRowsToClipboard).toBe(true);
  });
});

/**
 * Draft-commit focus hand-off — resolved by stable row id, never by the draft
 * row's stale rowIndex. (The end-to-end reorder behaviour is covered by
 * tests/grid-tab-navigation.test.tsx.)
 */
describe('draft-commit focus hand-off', () => {
  const editable = ['full_name', 'visa_expiry', 'notes'];

  it('targets the NEXT editable column of the created record on Tab', () => {
    expect(draftFocusTarget('tab', 'row-42', 'full_name', editable)).toEqual({
      rowId: 'row-42',
      columnId: 'visa_expiry',
      draftColumnId: 'full_name',
    });
  });

  it('keeps continuous entry on the fresh draft for Enter', () => {
    expect(draftFocusTarget('enter', 'row-42', 'full_name', editable)).toEqual({
      rowId: DRAFT_ROW_ID,
      columnId: 'full_name',
      draftColumnId: 'full_name',
    });
    expect(draftFocusTarget(null, 'row-42', 'notes', editable).rowId).toBe(DRAFT_ROW_ID);
  });

  it('stays on the draft row when Tab leaves the last editable column', () => {
    expect(draftFocusTarget('tab', 'row-42', 'notes', editable)).toEqual({
      rowId: DRAFT_ROW_ID,
      columnId: 'notes',
      draftColumnId: 'notes',
    });
  });

  it('never targets a system column (Days Left / Actions are not editable)', () => {
    const target = draftFocusTarget('tab', 'row-42', 'full_name', editable);
    expect(editable).not.toContain('daysLeft');
    expect(target.columnId).toBe('visa_expiry');
  });

  it('resolves a row id to its CURRENT grid position', () => {
    const api = {
      getRowNode: (id: string) => (
        id === 'row-new' ? { rowIndex: 0 } : id === '__draft' ? { rowIndex: 7 } : undefined
      ),
    };
    expect(rowIndexOfRowId(api, 'row-new')).toBe(0);
    expect(rowIndexOfRowId(api, '__draft')).toBe(7);
    // Not in the row model yet (data not applied, or filtered out).
    expect(rowIndexOfRowId(api, 'row-missing')).toBeNull();
    // A node without a usable index is never a focus target.
    expect(rowIndexOfRowId({ getRowNode: () => ({ rowIndex: null }) }, 'row-new')).toBeNull();
    expect(rowIndexOfRowId({ getRowNode: () => ({ rowIndex: -1 }) }, 'row-new')).toBeNull();
    expect(rowIndexOfRowId({ getRowNode: () => undefined }, 'row-new')).toBeNull();
  });
});
