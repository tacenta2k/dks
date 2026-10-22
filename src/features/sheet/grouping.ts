import type { ColumnDefinition } from '../../lib/columns';
import type { SheetGridRendererData } from './row-actions';

/**
 * SHEET-04 / R2-13 — Group by, without AG Grid Enterprise.
 *
 * Native row grouping is an Enterprise feature, so DKS inserts synthetic
 * full-width "group header" rows into the (already filtered) row data instead.
 * Those rows:
 *   - are never real records (no id, no data, no row actions);
 *   - are excluded from counts, exports, print/PDF and sync payloads;
 *   - are rendered by `GroupHeaderCell` through AG Grid's Community
 *     `isFullWidthRow` + `fullWidthCellRenderer` options.
 */
export const GROUP_HEADER_PREFIX = '__group:';

export const UNGROUPED_LABEL = 'No value';

export function isGroupHeaderRow(row: { __groupHeader?: string } | null | undefined): boolean {
  return typeof row?.__groupHeader === 'string';
}

/** Only existing user Text / Dropdown columns can group (plus "None"). */
export function groupableColumns(columns: readonly ColumnDefinition[]): ColumnDefinition[] {
  return columns.filter((column) => (
    column.deleted !== true
    && column.visible !== false
    && (column.type === 'text' || column.type === 'dropdown')
    && column.id !== '__daysLeft'
  ));
}

export interface GroupableRow {
  __rowId: string;
  __groupHeader?: string;
  [key: string]: unknown;
}

/**
 * Insert a group header row before each group. Groups are ordered by label
 * (case-insensitive) and the rows inside a group keep their existing order, so
 * the grid stays stable across refreshes.
 */
export function groupGridRows<T extends GroupableRow>(
  rows: readonly T[],
  column: ColumnDefinition | null,
): Array<T | SheetGridRendererData> {
  if (!column) {
    return [...rows];
  }

  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const raw = (row as Record<string, unknown>)[column.id];
    const label = raw === null || raw === undefined || String(raw).trim() === ''
      ? UNGROUPED_LABEL
      : String(raw).trim();
    const bucket = buckets.get(label) ?? [];
    bucket.push(row);
    buckets.set(label, bucket);
  }

  const result: Array<T | SheetGridRendererData> = [];
  for (const label of [...buckets.keys()].sort((left, right) => (
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  ))) {
    const members = buckets.get(label) ?? [];
    result.push({
      __rowId: `${GROUP_HEADER_PREFIX}${label}`,
      __groupHeader: label,
      __rowCount: members.length,
      daysLeft: null,
      status: null,
    } as unknown as SheetGridRendererData);
    result.push(...members);
  }
  return result;
}
