import { DAYS_LEFT_COLUMN_ID, type ColumnDefinition } from '../../lib/columns';

/**
 * SHEET-13 / R2-09 — user-column header right-click menu.
 *
 * Community-compatible: rendered by DKS from the grid's `contextmenu` event
 * (AG Grid's own header menu button is suppressed). System columns
 * (row numbers, Actions, `+`, Days Left) never show this menu, and there is no
 * Hide option.
 */
export interface ColumnMenuContext {
  role: string | null | undefined;
  isPrimary: boolean;
  onRename: (column: ColumnDefinition) => void;
  onDuplicate: (column: ColumnDefinition) => void;
  onDelete: (column: ColumnDefinition) => void;
  onSetPrimary?: (column: ColumnDefinition) => void;
}

export interface ColumnMenuItem {
  id: 'rename' | 'duplicate' | 'delete' | 'set-primary';
  label: string;
  disabled?: boolean;
  action: () => void;
}

export const SYSTEM_COLUMN_IDS = Object.freeze([
  '__rowNumber',
  '__actions',
  '__addColumn',
  DAYS_LEFT_COLUMN_ID,
]);

export function isSystemColumnId(columnId: string): boolean {
  return SYSTEM_COLUMN_IDS.includes(columnId as typeof SYSTEM_COLUMN_IDS[number]);
}

/**
 * The header cell's `col-id` attribute is the only stable hook available in
 * Community; return null for body cells and system columns.
 */
export function columnIdFromHeaderTarget(target: Element | null): string | null {
  const headerCell = target?.closest?.('.ag-header-cell');
  if (!headerCell) {
    return null;
  }
  const columnId = headerCell.getAttribute('col-id');
  if (!columnId || isSystemColumnId(columnId)) {
    return null;
  }
  return columnId;
}

export function buildColumnContextMenuItems(
  column: ColumnDefinition,
  context: ColumnMenuContext,
): ColumnMenuItem[] {
  const items: ColumnMenuItem[] = [
    { id: 'rename', label: 'Rename', action: () => context.onRename(column) },
    { id: 'duplicate', label: 'Duplicate column', action: () => context.onDuplicate(column) },
    { id: 'delete', label: 'Delete column', action: () => context.onDelete(column) },
  ];

  const isExpiry = column.type === 'date_expiry';
  if (context.role === 'admin' && isExpiry && context.onSetPrimary) {
    items.push({
      id: 'set-primary',
      label: context.isPrimary ? 'Primary expiry (current)' : 'Set as Primary Expiry',
      disabled: context.isPrimary,
      action: () => {
        if (!context.isPrimary) {
          context.onSetPrimary?.(column);
        }
      },
    });
  }

  return items;
}

/** Default name for a duplicated column: "Original Name (copy)" (then copy 2…). */
export function duplicateColumnName(
  originalName: string,
  existingNames: readonly string[],
): string {
  const used = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const base = `${originalName.trim()} (copy)`;
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  let index = 2;
  while (used.has(`${originalName.trim()} (copy ${index})`.toLowerCase())) {
    index += 1;
  }
  return `${originalName.trim()} (copy ${index})`;
}
