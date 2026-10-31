import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildGridColumns } from '../src/features/sheet/grid-columns';

const sheetCss = readFileSync(resolve(__dirname, '../src/features/sheet/sheet.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  expect(index, `missing CSS rule ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  // Match rules starting at `selector` — the documented rule for the gutter
  // cell is the one that opens a block, not a comment mentioning it.
  return css.slice(open + 1, close);
}

function rowNumberColumn() {
  const columns = buildGridColumns([], {
    onDuplicate: () => undefined,
    onDelete: () => undefined,
    onRenew: () => undefined,
    onAddColumn: () => undefined,
  });
  const gutter = columns.find((column) => column.colId === '__rowNumber');
  expect(gutter).toBeDefined();
  return gutter!;
}

interface FakeNode {
  id: string;
  rowIndex: number;
  data: { __rowId: string; __sheetRow?: { id: string; data: Record<string, unknown> } };
}

function displayedApi(nodes: FakeNode[]) {
  return {
    forEachNodeAfterFilterAndSort: (callback: (node: FakeNode) => void) => {
      nodes.forEach(callback);
    },
    getDisplayedRowCount: () => nodes.length,
    getDisplayedRowAtIndex: (index: number) => nodes[index],
  };
}

/**
 * Bug 1 regression — the gutter showed 1,2,…,9, then "1" ×10, "2" ×10…
 *
 * The valueGetter always computed the full number; the column was locked at
 * 40px while Quartz pads cells 16px per side, leaving ~8px for the text and
 * clipping every second digit. These tests pin BOTH halves: the computed /
 * formatted values at 25+ and 105+ rows, and a column box wide enough (with
 * no maxWidth cap and trimmed cell padding) to actually render them.
 */
describe('row-number gutter (Bug 1)', () => {
  it('computes and formats full multi-digit display numbers for 105 rows', () => {
    const gutter = rowNumberColumn();
    const getter = gutter.valueGetter as ((params: never) => number | '') | undefined;
    const formatter = gutter.valueFormatter as
      | ((params: { value: unknown }) => string)
      | undefined;
    expect(getter).toBeTypeOf('function');
    expect(formatter).toBeTypeOf('function');

    const nodes: FakeNode[] = Array.from({ length: 105 }, (_, index) => ({
      id: `row-${index + 1}`,
      rowIndex: index,
      data: {
        __rowId: `row-${index + 1}`,
        __sheetRow: { id: `row-${index + 1}`, data: {} },
      },
    }));
    const api = displayedApi(nodes);
    const values = nodes.map((node) => getter?.({ data: node.data, node, api } as never));

    // Numeric (not string) values, sequential with no first-digit repeats.
    expect(values.every((value) => typeof value === 'number')).toBe(true);
    expect(values.slice(0, 25)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(values[9]).toBe(10);
    expect(values[10]).toBe(11);
    expect(values[19]).toBe(20);
    expect(values[99]).toBe(100);
    expect(values[104]).toBe(105);

    // The rendered text is the full number at 2, 3 and 4 digits.
    expect(values.map((value) => formatter?.({ value })).slice(8, 12))
      .toEqual(['9', '10', '11', '12']);
    expect(formatter?.({ value: values[19] })).toBe('20');
    expect(formatter?.({ value: values[99] })).toBe('100');
    expect(formatter?.({ value: 1000 })).toBe('1000');
    expect(formatter?.({ value: '' })).toBe('');
  });

  it('numbers by displayed position after sorting, not by record identity', () => {
    const gutter = rowNumberColumn();
    const getter = gutter.valueGetter as ((params: never) => number | '') | undefined;
    // Reverse-sorted display order: "row-30" is shown first.
    const nodes: FakeNode[] = Array.from({ length: 30 }, (_, index) => ({
      id: `row-${30 - index}`,
      rowIndex: index,
      data: {
        __rowId: `row-${30 - index}`,
        __sheetRow: { id: `row-${30 - index}`, data: {} },
      },
    }));
    const api = displayedApi(nodes);
    expect(nodes.map((node) => getter?.({ data: node.data, node, api } as never)))
      .toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('gives the column a box that fits 3+ digits and removes the width cap', () => {
    const gutter = rowNumberColumn();
    // 48px minimum with the trimmed 4px cell padding leaves >=40px of text
    // box — several tabular 11px digits. No maxWidth may re-clip the text.
    expect(gutter.width ?? 0).toBeGreaterThanOrEqual(56);
    expect(gutter.minWidth ?? 0).toBeGreaterThanOrEqual(48);
    expect(gutter.maxWidth).toBeUndefined();
    // Display position is derived, never a sortable string field.
    expect(gutter.sortable).toBe(false);
    expect(gutter.field).toBeUndefined();
  });

  it('trims the gutter cell padding and uses tabular numerals in both themes', () => {
    const body = ruleBody(sheetCss, '.sheet-row-number-cell {');
    expect(body).toContain('padding-left: 4px !important');
    expect(body).toContain('padding-right: 4px !important');
    expect(body).toContain('font-variant-numeric: tabular-nums');
    // Theme token (resolves per light/dark theme), never a hard-coded colour.
    expect(body).toContain('var(--color-text-subtle)');
  });
});
