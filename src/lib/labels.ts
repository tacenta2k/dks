import type { ColumnDefinition } from './columns';

export interface LabelRowLike {
  id: string;
  data?: Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Human-readable row label for toasts, Recycle Bin, audit details and
 * notifications (S1/S2). Order: name/passport-ish column, first text-like
 * column, first non-empty value, then the stable text "Unnamed record".
 *
 * A raw row UUID is NEVER shown.
 */
export function rowDisplayLabel(
  row: LabelRowLike,
  columns: readonly (Pick<ColumnDefinition, 'id' | 'name' | 'type'> & { deleted?: boolean })[] = [],
): string {
  const data = row.data ?? {};
  const active = columns.filter((column) => column.deleted !== true);
  const preferred = active.filter((column) => /name|passport/i.test(column.name) || /name|passport/i.test(column.id));
  const textLike = active.filter((column) => ['text', 'notes', 'phone', 'email'].includes(column.type));
  const rest = active.filter((column) => !preferred.includes(column) && !textLike.includes(column));

  for (const column of [...preferred, ...textLike, ...rest]) {
    const value = stringValue(data[column.id]) ?? stringValue(data[column.name]);
    if (value) {
      return value;
    }
  }

  for (const value of Object.values(data)) {
    const label = stringValue(value);
    if (label) {
      return label;
    }
  }

  return 'Unnamed record';
}
