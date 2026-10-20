import { useMemo } from 'react';

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

function rowLabel(row: SheetRow, columns: readonly ColumnDefinition[]): string {
  const preferred = columns.find((column) => /name|passport/i.test(column.name) || column.id === 'name');
  const value = preferred ? row.data[preferred.id] ?? row.data[preferred.name] : null;
  return value === null || value === undefined || String(value).trim() === '' ? row.id : String(value);
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
      <header>
        <p>Admin tools</p>
        <h1>Recycle bin</h1>
        <p>{deleted.length} deleted {deleted.length === 1 ? 'record' : 'records'}</p>
      </header>
      {deleted.length === 0 ? (
        <p>No deleted records.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Record</th>
              {activeColumns.map((column) => <th scope="col" key={column.id}>{column.name}</th>)}
              <th scope="col">Deleted at</th>
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
                    {row.updatedAt ?? row.updated_at ?? '—'}
                  </td>
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
