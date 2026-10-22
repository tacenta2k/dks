import type { SheetRow } from './types';

export interface RowContextCallbacks {
  onDuplicate: (row: SheetRow) => void | Promise<void>;
  onDelete: (row: SheetRow) => void | Promise<void>;
  onRenew: (row: SheetRow) => void;
}

/** A single AG Grid context-menu item (Community `IMenuItem` shape). */
export interface RowMenuItem {
  name: string;
  action: () => void;
}

/**
 * FIXES_UI §5.6 (SHEET-14): the row right-click menu, built for AG Grid
 * Community `getContextMenuItems`. Mirrors the in-cell actions (Duplicate,
 * Delete, Mark renewed); Copy/Paste remain in the grid's default menu.
 * Permissions are enforced by the repository/service the callbacks call.
 */
export function buildRowContextMenuItems(
  row: SheetRow,
  callbacks: RowContextCallbacks,
): RowMenuItem[] {
  return [
    { name: 'Duplicate row', action: () => { void callbacks.onDuplicate(row); } },
    { name: 'Delete row', action: () => { void callbacks.onDelete(row); } },
    { name: 'Mark renewed', action: () => { callbacks.onRenew(row); } },
  ];
}
