import { describe, expect, it } from 'vitest';

import type { ColumnDefinition } from '../src/lib/columns';
import {
  UNGROUPED_LABEL,
  groupGridRows,
  groupableColumns,
  isGroupHeaderRow,
} from '../src/features/sheet/grouping';
import type { SheetGridRendererData } from '../src/features/sheet/row-actions';

const columns: ColumnDefinition[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'type', name: 'Visa type', type: 'dropdown' },
  { id: 'expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true },
  { id: 'price', name: 'Fee', type: 'price' },
];

function row(id: string, values: Record<string, unknown>): SheetGridRendererData {
  return {
    __rowId: id,
    daysLeft: null,
    status: null,
    ...values,
  } as SheetGridRendererData;
}

describe('Visa Sheet Group by (SHEET-04)', () => {
  it('lists only existing Text / Dropdown columns', () => {
    expect(groupableColumns(columns).map((column) => column.name)).toEqual(['Name', 'Visa type']);
    expect(groupableColumns([{ id: 'x', name: 'Hidden', type: 'text', visible: false }])).toEqual([]);
    expect(groupableColumns([{ id: 'y', name: 'Gone', type: 'text', deleted: true }])).toEqual([]);
  });

  it('inserts a full-width header before each group, ordered by label', () => {
    const rows = [
      row('1', { name: 'Zara', type: 'Work' }),
      row('2', { name: 'Ahmed', type: 'Visit' }),
      row('3', { name: 'Priya', type: 'Work' }),
    ];

    const grouped = groupGridRows(rows, columns[1]);

    expect(grouped).toHaveLength(5);
    expect(isGroupHeaderRow(grouped[0] as never)).toBe(true);
    expect((grouped[0] as SheetGridRendererData).__groupHeader).toBe('Visit');
    expect((grouped[0] as SheetGridRendererData).__rowCount).toBe(1);
    expect((grouped[1] as SheetGridRendererData).__rowId).toBe('2');
    expect((grouped[2] as SheetGridRendererData).__groupHeader).toBe('Work');
    expect((grouped[2] as SheetGridRendererData).__rowCount).toBe(2);
    // Real rows keep their existing order inside the group.
    expect((grouped[3] as SheetGridRendererData).__rowId).toBe('1');
    expect((grouped[4] as SheetGridRendererData).__rowId).toBe('3');
  });

  it('puts blank values in a "No value" group and never groups when None is selected', () => {
    const blank = groupGridRows([row('1', { type: '' })], columns[1]);
    expect((blank[0] as SheetGridRendererData).__groupHeader).toBe(UNGROUPED_LABEL);

    const ungrouped = groupGridRows([row('1', { type: 'Work' })], null);
    expect(ungrouped).toHaveLength(1);
    expect(isGroupHeaderRow(ungrouped[0] as never)).toBe(false);
  });

  it('group headers are synthetic: no record id, no row data, no days left', () => {
    const [header] = groupGridRows([row('1', { type: 'Work' })], columns[1]);
    const data = header as SheetGridRendererData;
    expect(data.__sheetRow).toBeUndefined();
    expect(data.daysLeft).toBeNull();
    expect(data.status).toBeNull();
  });
});
