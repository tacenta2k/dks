import { describe, expect, it, vi } from 'vitest';
import { buildRowContextMenuItems } from '../src/features/sheet/row-context-menu';
import type { SheetRow } from '../src/features/sheet/types';

function makeRow(): SheetRow {
  return {
    id: 'r1',
    data: {
      name: 'Sam Example',
      passport_number: 'A1234567',
      visa_expiry: '2030-01-01',
    },
    deleted: false,
    deleted_at: null,
  };
}

describe('buildRowContextMenuItems (SHEET-14)', () => {
  it('returns Duplicate, Delete, and Mark renewed, each wired to the matching callback', () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const onRenew = vi.fn();
    const row = makeRow();
    const items = buildRowContextMenuItems(row, { onDuplicate, onDelete, onRenew });

    expect(items.map((item) => item.name)).toEqual(['Duplicate row', 'Delete row', 'Mark renewed']);
    items[0].action();
    expect(onDuplicate).toHaveBeenCalledWith(row);
    items[1].action();
    expect(onDelete).toHaveBeenCalledWith(row);
    items[2].action();
    expect(onRenew).toHaveBeenCalledWith(row);
  });
});
