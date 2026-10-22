import { describe, expect, it } from 'vitest';

import {
  DRAFT_ROW_ID,
  GRID_KEYBOARD_PROPS,
  isMeaningfulDraftValue,
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
