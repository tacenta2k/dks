import { useMemo, useState } from 'react';

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
  /**
   * Admin-only bulk permanent delete. The host owns the typed-DELETE
   * confirmation dialog and the per-row delete path; the page only renders
   * the toolbar button when the bin is non-empty.
   */
  onDeleteAll?: () => void;
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
  onDeleteAll,
}: RecycleBinPageProps) {
  const deleted = useMemo(() => deletedRows(rows), [rows]);
  const activeColumns = columns.filter((column) => column.deleted !== true);
  const [search, setSearch] = useState('');

  // FIXES_UI §7/§8 (RBIN-02): one compact search/count toolbar. The count is
  // the number of visible (filtered) items; the Admin-only "Delete all"
  // action sits beside it and disappears with the toolbar when the bin is
  // empty (the whole toolbar only renders for a non-empty bin).
  const searchTerms = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!searchTerms) {
      return deleted;
    }
    return deleted.filter((row) => {
      if (rowLabel(row, activeColumns).toLowerCase().includes(searchTerms)) {
        return true;
      }
      return activeColumns.some((column) => {
        const value = displayValue(row, column);
        return value !== '—' && value.toLowerCase().includes(searchTerms);
      });
    });
  }, [activeColumns, deleted, searchTerms]);

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
          eyebrow and duplicate h1 are removed. A compact search/count toolbar. */}
      {deleted.length > 0 ? (
        <div className="recycle-bin-toolbar" role="group" aria-label="Recycle bin search and count">
          <input
            className="recycle-bin-toolbar__search"
            aria-label="Search deleted records"
            type="search"
            value={search}
            placeholder="Search deleted records…"
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="recycle-bin-page__count" data-testid="recycle-bin-count">
            {visible.length} {visible.length === 1 ? 'item' : 'items'}
          </span>
          {can(role, 'permanentDelete') && onDeleteAll ? (
            <button
              type="button"
              className="button button--danger recycle-bin-toolbar__delete-all"
              onClick={onDeleteAll}
            >
              Delete all
            </button>
          ) : null}
        </div>
      ) : null}
      {deleted.length === 0 ? (
        <p className="recycle-bin-page__empty">Recycle Bin is empty</p>
      ) : visible.length === 0 ? (
        <p className="recycle-bin-page__empty">No deleted records match this search</p>
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
                    <div className="recycle-bin-actions">
                      {can(role, 'restore') ? (
                        <button
                          type="button"
                          className="recycle-bin-action recycle-bin-action--restore"
                          onClick={() => void onRestore?.(row)}
                        >
                          Restore
                        </button>
                      ) : null}
                      {can(role, 'permanentDelete') ? (
                        <button
                          type="button"
                          className="recycle-bin-action recycle-bin-action--delete"
                          onClick={() => void onPermanentDelete?.(row)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
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
