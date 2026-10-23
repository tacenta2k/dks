import { describe, expect, it, vi } from 'vitest';

import type { ColumnDefinition } from '../src/lib/columns';
import {
  buildColumnContextMenuItems,
  columnIdFromHeaderTarget,
  duplicateColumnName,
  isSystemColumnId,
} from '../src/features/sheet/column-context-menu';

const textColumn: ColumnDefinition = { id: 'name', name: 'Name', type: 'text' };
const expiryColumn: ColumnDefinition = {
  id: 'visa_expiry',
  name: 'Visa Expiry',
  type: 'date_expiry',
  isPrimaryExpiry: true,
};

function context(role: 'admin' | 'office', isPrimary = false) {
  return {
    role,
    isPrimary,
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onSetPrimary: vi.fn(),
  };
}

describe('column header right-click menu (SHEET-13, R2-09)', () => {
  it('offers Rename / Duplicate column / Delete column and no Hide option', () => {
    const callbacks = context('office');
    const items = buildColumnContextMenuItems(textColumn, callbacks);

    expect(items.map((item) => item.label)).toEqual([
      'Rename',
      'Duplicate column',
      'Delete column',
    ]);
    expect(items.map((item) => item.label).join(' ')).not.toContain('Hide');

    items[0].action();
    items[1].action();
    items[2].action();
    expect(callbacks.onRename).toHaveBeenCalledWith(textColumn);
    expect(callbacks.onDuplicate).toHaveBeenCalledWith(textColumn);
    expect(callbacks.onDelete).toHaveBeenCalledWith(textColumn);
  });

  it('lets only an admin set a Date (Expiry) column as the primary expiry', () => {
    const officeCallbacks = context('office');
    expect(buildColumnContextMenuItems(expiryColumn, officeCallbacks))
      .toHaveLength(3);

    const adminCallbacks = context('admin', false);
    const adminItems = buildColumnContextMenuItems(expiryColumn, adminCallbacks);
    expect(adminItems.map((item) => item.label)).toContain('Set as Primary Expiry');
    adminItems.find((item) => item.id === 'set-primary')?.action();
    expect(adminCallbacks.onSetPrimary).toHaveBeenCalledWith(expiryColumn);

    // The current primary shows its state and does nothing when clicked.
    const currentPrimary = buildColumnContextMenuItems(expiryColumn, context('admin', true));
    const item = currentPrimary.find((entry) => entry.id === 'set-primary');
    expect(item?.label).toBe('Primary expiry (current)');
    expect(item?.disabled).toBe(true);
  });

  it('never opens on system columns (row numbers, Actions, +, Days Left)', () => {
    for (const id of ['__rowNumber', '__actions', '__addColumn', 'daysLeft']) {
      expect(isSystemColumnId(id)).toBe(true);
    }
    expect(isSystemColumnId('name')).toBe(false);

    const header = document.createElement('div');
    header.className = 'ag-header-cell';
    header.setAttribute('col-id', 'daysLeft');
    expect(columnIdFromHeaderTarget(header)).toBeNull();

    header.setAttribute('col-id', 'name');
    expect(columnIdFromHeaderTarget(header)).toBe('name');

    const bodyCell = document.createElement('div');
    bodyCell.className = 'ag-cell';
    expect(columnIdFromHeaderTarget(bodyCell)).toBeNull();
  });

  it('names a duplicated column "Original (copy)" without colliding', () => {
    expect(duplicateColumnName('Name', ['Name'])).toBe('Name (copy)');
    expect(duplicateColumnName('Name', ['Name', 'Name (copy)'])).toBe('Name (copy 2)');
    expect(duplicateColumnName('  Name  ', ['Name', 'name (COPY)'])).toBe('Name (copy 2)');
  });
});
