import { useMemo } from 'react';

import { formatLocalDateTime } from '../../lib/date';
import { rowDisplayLabel } from '../../lib/labels';
import { can } from '../../lib/permissions';
import type { ColumnDefinition } from '../../lib/columns';
import type { Role } from '../auth/auth-types';
import type { SheetRow } from '../sheet/types';

export interface RecycleBinPageProps {
  rows?: readonly SheetRow[];
  columns?: readonly ColumnDefinition[];
  role?: Role | string | null;
  onRestore?: (row: SheetRow) => void | Promise<void>;
  onPermanentDelete?: (row: SheetRow) => void | Promise<void>;
}

/** Human label (S2): never a raw row id like `row-7ce65046-…`. */
function rowLabel(row: SheetRow, columns: readonly ColumnDefinition[]): string {
  return rowDisplayLabel(row, columns);
}

function deletedAtText(row: SheetRow): string {
  const raw = row.deletedAt ?? row.deleted_at ?? row.updatedAt ?? row.updated_at;
  return raw ? formatLocalDateTime(raw) : '—';
}

function deletedByText(row: SheetRow): string | null {
  const raw = row.deletedBy ?? row.deleted_by ?? row.updatedBy ?? row.updated_by;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function displayValue(row: SheetRow, column: ColumnDefinition): string {
  const value = row.data[column.id] ?? row.data[column.name];
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

/** Pure selector used by the page and by repository-backed hosts. */
export function deletedRows(rows: readonly SheetRow[]): SheetRow[] {
  return rows.filter((row) => row.deleted === true);
}

export function RecycleBinPage({
  rows = [],
  columns = [],
  role,
  onRestore,
  onPermanentDelete,
}: RecycleBinPageProps) {
  const deleted = useMemo(() => deletedRows(rows), [rows]);
  const activeColumns = columns.filter((column) => column.deleted !== true);

  if (!can(role, 'recycleBin')) {
    return (
      <section className="recycle-bin-page" role="alert" aria-label="Recycle bin access denied">
        Only administrators can access the recycle bin.
      </section>
    );
  }

  return (
    <section className="recycle-bin-page" aria-label="Recycle bin">
      {/* FIXES_UI §7: the page title lives in the top bar; the "Admin tools"
          eyebrow and duplicate h1 are removed. A compact count is kept. */}
      {deleted.length > 0 ? (
        <p className="recycle-bin-page__count">{deleted.length} deleted {deleted.length === 1 ? 'record' : 'records'}</p>
      ) : null}
      {deleted.length === 0 ? (
        <p>No deleted records.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Record</th>
              {activeColumns.map((column) => <th scope="col" key={column.id}>{column.name}</th>)}
              <th scope="col">Deleted at</th>
              <th scope="col">Deleted by</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {deleted.map((row) => {
              const label = rowLabel(row, activeColumns);
              return (
                <tr key={row.id}>
                  <th scope="row">{label}</th>
                  {activeColumns.map((column) => <td key={column.id}>{displayValue(row, column)}</td>)}
                  <td>
                    <time dateTime={row.deletedAt ?? row.deleted_at ?? row.updatedAt ?? row.updated_at}>
                      {deletedAtText(row)}
                    </time>
                  </td>
                  <td>{deletedByText(row) ?? '—'}</td>
                  <td>
                    {can(role, 'restore') ? (
                      <button type="button" onClick={() => void onRestore?.(row)}>
                        Restore {label}
                      </button>
                    ) : null}
                    {can(role, 'permanentDelete') ? (
                      <button type="button" onClick={() => void onPermanentDelete?.(row)}>
                        Permanently delete {label}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default RecycleBinPage;
