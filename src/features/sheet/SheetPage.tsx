import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { CellValueChangedEvent, ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

import {
  DAYS_LEFT_COLUMN_ID,
  canDeleteColumn,
  getPrimaryExpiryColumn,
  type ColumnDefinition,
} from '../../lib/columns';
import { expiryValues } from '../../lib/domain';
import { findDuplicatePassportValues } from '../../lib/validation';
import { formatDisplayDate, type ExpiryStatus } from '../../lib/date';
import type { Role } from '../auth/auth-types';
import { ColumnWizard } from './column-wizard';
import {
  filterRows,
  QUICK_FILTERS,
  type QuickFilter,
} from './filters';
import {
  buildGridColumns,
  buildGridRows,
  rowClassForStatus,
} from './grid-columns';
import { createInMemorySheetRepository, type SheetRepository } from './repository';
import { RenewModal } from './renew-modal';
import { RowActions, type SheetGridRendererData } from './row-actions';
import { buildRowContextMenuItems } from './row-context-menu';
import type { SheetRow } from './types';
import './sheet.css';

export interface SheetPageProps {
  repository?: SheetRepository;
  role?: Role | string | null;
  today?: string | Date;
  /** The host can render the richer administrator toolbar outside the grid. */
  hideAdminActions?: boolean;
  /**
   * Bumped by the shell after local mutations and after each successful sync.
   * The page re-fetches IN PLACE (no remount, no loading overlay) so open cell
   * editors, dialogs and input focus survive background refreshes.
   */
  refreshToken?: number;
}

function dataValue(row: SheetRow, column: ColumnDefinition | null): unknown {
  if (!column) {
    return null;
  }
  return row.data[column.id] ?? row.data[column.name];
}

function displayLabel(row: SheetRow, columns: readonly ColumnDefinition[]): string {
  const passport = columns.find((column) => (
    column.isPassport === true || column.is_passport === true || /passport/i.test(column.name)
  ));
  const fallback = columns.find((column) => column.id === 'full_name') ?? null;
  const value = dataValue(row, passport ?? fallback);
  return value === null || value === undefined || !String(value).trim() ? row.id : String(value);
}

function selectedValue(event: ChangeEvent<HTMLSelectElement>): string {
  return event.target.value;
}

function accessibleCellValue(row: SheetRow, column: ColumnDefinition): string {
  const value = dataValue(row, column);
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (column.type === 'date_start' || column.type === 'date_expiry') {
    return formatDisplayDate(String(value));
  }
  return String(value);
}

export function SheetPage({
  repository: providedRepository,
  role = 'office',
  today,
  hideAdminActions = false,
  refreshToken = 0,
}: SheetPageProps) {
  const repository = useMemo(
    () => providedRepository ?? createInMemorySheetRepository(),
    [providedRepository],
  );
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [columnManagerOpen, setColumnManagerOpen] = useState(false);
  const [renewRow, setRenewRow] = useState<SheetRow | null>(null);
  // AG Grid needs real layout measurements; jsdom uses the deterministic table below.
  const isTestEnvironment = import.meta.env.MODE === 'test';

  // `quiet` refreshes replace the data without unmounting the page: the
  // loading overlay used to destroy open editors, dialogs and focused inputs
  // on every background refresh (focus-delay regression).
  const refresh = useCallback(async (options?: { quiet?: boolean }) => {
    if (!options?.quiet) {
      setLoading(true);
    }
    try {
      const [nextColumns, nextRows] = await Promise.all([
        repository.getColumns(),
        repository.getRows(),
      ]);
      setColumns(nextColumns);
      setRows(nextRows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the sheet.');
    } finally {
      if (!options?.quiet) {
        setLoading(false);
      }
    }
  }, [repository]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) {
      return;
    }
    lastRefreshToken.current = refreshToken;
    void refresh({ quiet: true });
  }, [refreshToken, refresh]);

  const activeColumns = useMemo(
    () => columns.filter((column) => column.deleted !== true && column.visible !== false),
    [columns],
  );
  const primaryExpiry = useMemo(() => getPrimaryExpiryColumn(activeColumns), [activeColumns]);
  const matchingRows = useMemo(() => filterRows(rows, activeColumns, {
    search,
    quickFilter,
    status: statusFilter as ExpiryStatus | 'No expiry' | '',
    today,
  }), [rows, activeColumns, search, quickFilter, statusFilter, today]);
  const matchingIds = useMemo(() => new Set(matchingRows.map((row) => row.id)), [matchingRows]);
  const builtRows = useMemo(() => buildGridRows(rows, activeColumns, { today }), [rows, activeColumns, today]);
  const gridRows = useMemo(
    () => builtRows.rows.filter((row) => matchingIds.has(row.__rowId)),
    [builtRows.rows, matchingIds],
  );
  const duplicatePassportValues = useMemo(() => {
    const passportColumn = activeColumns.find((column) => (
      column.isPassport === true || column.is_passport === true || /passport/i.test(column.name)
    ));
    return passportColumn ? findDuplicatePassportValues(rows, passportColumn) : new Set<string>();
  }, [rows, activeColumns]);

  const handleDuplicate = useCallback(async (row: SheetRow) => {
    try {
      await repository.duplicateRow(row.id);
      await refresh({ quiet: true });
      setStatusMessage(`Duplicated ${displayLabel(row, activeColumns)}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to duplicate the row.');
    }
  }, [repository, refresh, activeColumns]);

  const handleDelete = useCallback(async (row: SheetRow) => {
    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm(`Move ${displayLabel(row, activeColumns)} to the recycle bin?`);
    if (!confirmed) {
      return;
    }

    try {
      await repository.softDeleteRow(row.id);
      await refresh({ quiet: true });
      setStatusMessage(`Moved ${displayLabel(row, activeColumns)} to the recycle bin.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete the row.');
    }
  }, [repository, refresh, activeColumns]);

  const handleRenew = useCallback((row: SheetRow) => {
    setRenewRow(row);
    setError(null);
  }, []);

  const gridContext = useMemo(() => ({
    onDuplicate: handleDuplicate,
    onDelete: handleDelete,
    onRenew: handleRenew,
    // FIXES_UI §5.5 (SHEET-10): the `+` header opens Column Setup.
    onAddColumn: () => setWizardOpen(true),
  }), [handleDuplicate, handleDelete, handleRenew]);

  const gridColumnDefs = useMemo(
    () => buildGridColumns(activeColumns, gridContext, role ?? 'office'),
    [activeColumns, gridContext, role],
  );

  const handleCellValueChanged = useCallback(async (
    event: CellValueChangedEvent<SheetGridRendererData>,
  ) => {
    const field = event.colDef.field;
    if (!field || field === DAYS_LEFT_COLUMN_ID || field === '__actions' || !event.data) {
      return;
    }
    const column = activeColumns.find((candidate) => candidate.id === field);
    if (!column) {
      return;
    }
    try {
      await repository.updateRow(event.data.__rowId, { [field]: event.newValue });
      await refresh({ quiet: true });
      setStatusMessage(`Saved ${column.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the cell.');
    }
  }, [activeColumns, repository, refresh]);

  const addRow = async () => {
    try {
      await repository.createRow({});
      await refresh({ quiet: true });
      setStatusMessage('Added a new row.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to add a row.');
    }
  };

  const addColumn = async (column: ColumnDefinition) => {
    try {
      await repository.addColumn(column);
      await refresh({ quiet: true });
      setWizardOpen(false);
      setStatusMessage(`Added ${column.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to add the column.');
    }
  };

  const removeColumn = async (column: ColumnDefinition) => {
    if (!canDeleteColumn(column, role ?? '', rows)) {
      setStatusMessage(`${column.name} is protected or contains data.`);
      return;
    }
    try {
      await repository.softDeleteColumn(column.id, role ?? '');
      await refresh({ quiet: true });
      setStatusMessage(`Removed ${column.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to remove the column.');
    }
  };

  const renew = async (nextExpiry: string) => {
    if (!renewRow || !primaryExpiry) {
      setError('Add a primary expiry column before renewing a row.');
      return;
    }
    try {
      await repository.markRenewed(
        renewRow.id,
        primaryExpiry.id,
        nextExpiry,
        typeof dataValue(renewRow, primaryExpiry) === 'string' ? dataValue(renewRow, primaryExpiry) as string : null,
      );
      await refresh({ quiet: true });
      setRenewRow(null);
      setStatusMessage(`Renewed ${displayLabel(renewRow, activeColumns)}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the renewal.');
    }
  };

  if (loading) {
    return <div className="sheet-page sheet-page--loading" aria-live="polite">Loading visa sheet…</div>;
  }

  return (
    <div className="sheet-page">
      {error ? <div className="sheet-alert sheet-alert--error" role="alert">{error}</div> : null}
      {statusMessage ? <div className="sheet-alert sheet-alert--status" role="status">{statusMessage}</div> : null}

      {activeColumns.length === 0 ? (
        <section className="sheet-empty-state" aria-label="Empty visa sheet">
          <div className="sheet-empty-state__icon" aria-hidden="true">＋</div>
          <div>
            <p className="sheet-eyebrow">Start your workspace</p>
            <h2>Click + to add your first column</h2>
            <p>Define the fields your office uses.</p>
            <div className="sheet-empty-state__actions">
              <button className="button button--primary" type="button" onClick={() => setWizardOpen(true)}>
                Add your first column
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="sheet-workbench" aria-label="Visa records">
          {/* FIXES_UI §5.2: one compact toolbar — search, status, quick chips,
              and the record actions. The admin Export/Import/Print/Settings
              buttons live in the Tools menu (AdminSheetActions), not here. */}
          <div className="sheet-toolbar">
            <div className="sheet-toolbar__filters">
              <label className="sheet-search">
                <span className="sheet-filter__label">Search</span>
                <input
                  aria-label="Search records"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search records"
                />
              </label>
              <label className="sheet-status">
                <span className="sheet-filter__label">Status</span>
                <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(selectedValue(event))}>
                  <option value="">All statuses</option>
                  <option value="Valid">Valid</option>
                  <option value="Expiring Soon">Expiring Soon</option>
                  <option value="Urgent">Urgent</option>
                  <option value="Expires today">Expires today</option>
                  <option value="Expired">Expired</option>
                  <option value="No expiry">No expiry</option>
                </select>
              </label>
              <div className="sheet-quick-filters" role="group" aria-label="Quick filters">
                {QUICK_FILTERS.filter((filter) => filter.id !== 'all').map((filter) => (
                  <button
                    key={filter.id}
                    className={`sheet-filter-chip${quickFilter === filter.id ? ' sheet-filter-chip--active' : ''}`}
                    type="button"
                    aria-pressed={quickFilter === filter.id}
                    onClick={() => setQuickFilter(quickFilter === filter.id ? 'all' : filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sheet-toolbar__actions">
              <button className="button button--primary" type="button" onClick={() => void addRow()}>
                Add row
              </button>
              <button className="button" type="button" onClick={() => setWizardOpen(true)}>
                Add column
              </button>
              <button className="button" type="button" onClick={() => setColumnManagerOpen((open) => !open)}>
                Manage columns
              </button>
            </div>
          </div>

          {duplicatePassportValues.size > 0 ? (
            <div className="sheet-alert sheet-alert--warning" role="alert">
              Duplicate passport warning: {Array.from(duplicatePassportValues).join(', ')}
            </div>
          ) : null}

          {columnManagerOpen ? (
            <section className="sheet-column-manager" aria-label="Column manager">
              <div className="sheet-column-manager__header">
                <h2>Columns</h2>
                <span>{activeColumns.length + 1} visible</span>
              </div>
              <ul>
                {activeColumns.map((column) => {
                  const protectedColumn = column.id === DAYS_LEFT_COLUMN_ID
                    || column.isPrimaryExpiry === true
                    || column.is_primary_expiry === true;
                  const deletable = canDeleteColumn(column, role ?? '', rows);
                  return (
                    <li key={column.id}>
                      <span>{column.name}{protectedColumn ? ' · protected' : ''}</span>
                      <button
                        className="sheet-column-manager__delete"
                        type="button"
                        aria-label={`Delete ${column.name} column`}
                        disabled={!deletable}
                        onClick={() => void removeColumn(column)}
                      >
                        Delete
                      </button>
                    </li>
                  );
                })}
                <li>
                  <span>Days Left · generated · locked</span>
                  <button className="sheet-column-manager__delete" type="button" aria-label="Delete Days Left column" disabled>
                    Delete
                  </button>
                </li>
              </ul>
            </section>
          ) : null}

          {isTestEnvironment ? null : (
            <div className="sheet-grid ag-theme-quartz" data-testid="sheet-grid" aria-label="Visa records grid">
              <AgGridReact<SheetGridRendererData>
                rowData={gridRows}
                columnDefs={gridColumnDefs as ColDef<SheetGridRendererData>[]}
                context={gridContext}
                defaultColDef={{
                  flex: 1,
                  minWidth: 120,
                  resizable: true,
                  sortable: true,
                  editable: true,
                }}
                getRowId={(params) => params.data.__rowId}
                getRowClass={(params) => rowClassForStatus(params.data?.status ?? null)}
                getContextMenuItems={(params) => {
                  // FIXES_UI §5.6 (SHEET-14): row right-click menu.
                  const row = (params.node?.data as SheetGridRendererData | null | undefined)?.__sheetRow;
                  if (!row) {
                    return [];
                  }
                  return buildRowContextMenuItems(row, {
                    onDuplicate: handleDuplicate,
                    onDelete: handleDelete,
                    onRenew: handleRenew,
                  });
                }}
                onCellValueChanged={(event) => void handleCellValueChanged(event)}
                domLayout="autoHeight"
                animateRows
                enableCellTextSelection
                undoRedoCellEditing
                undoRedoCellEditingLimit={20}
                stopEditingWhenCellsLoseFocus
              />
            </div>
          )}
          <div className={`sheet-accessible-table-wrap${isTestEnvironment ? ' sheet-accessible-table-wrap--test' : ''}`}>
            <table className="sheet-accessible-table" aria-label="Visa records table">
              <thead>
                <tr>
                  <th scope="col">Actions</th>
                  {activeColumns.map((column) => <th scope="col" key={column.id}>{column.name}</th>)}
                  <th scope="col">Days Left</th>
                </tr>
              </thead>
              <tbody>
                {matchingRows.map((row) => {
                  const derived = expiryValues(
                    primaryExpiry && typeof dataValue(row, primaryExpiry) === 'string'
                      ? dataValue(row, primaryExpiry) as string
                      : null,
                    today,
                  );
                  return (
                    <tr key={row.id} className={rowClassForStatus(derived.status)}>
                      <td>
                        <RowActions
                          row={row}
                          rowLabel={displayLabel(row, activeColumns)}
                          onDuplicate={handleDuplicate}
                          onDelete={handleDelete}
                          onRenew={handleRenew}
                        />
                      </td>
                      {activeColumns.map((column) => {
                        const value = accessibleCellValue(row, column);
                        const isCategory = column.id.toLowerCase() === 'category'
                          || column.name.toLowerCase() === 'category';
                        return (
                          <td key={column.id} aria-label={`${column.name}: ${value}`}>
                            {isCategory ? null : value}
                          </td>
                        );
                      })}
                      <td>{derived.daysLeft === null ? '—' : derived.daysLeft}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* FIXES_UI §5.9: one context-aware empty state (no records yet vs
              no filter match) — never two, and never covering the grid header. */}
          {rows.length === 0 ? (
            <div className="sheet-grid__empty" role="status">
              <p>No records yet. Add your first row to start tracking.</p>
            </div>
          ) : gridRows.length === 0 ? (
            <div className="sheet-grid__empty" role="status">
              <p>No records match the current filters.</p>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('');
                  setQuickFilter('all');
                }}
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </section>
      )}

      {wizardOpen ? (
        <ColumnWizard
          existingColumns={columns}
          onClose={() => setWizardOpen(false)}
          onSubmit={addColumn}
        />
      ) : null}
      {renewRow ? (
        <RenewModal
          rowLabel={displayLabel(renewRow, activeColumns)}
          currentExpiry={primaryExpiry ? String(dataValue(renewRow, primaryExpiry) ?? '') : null}
          today={today}
          onCancel={() => setRenewRow(null)}
          onConfirm={renew}
        />
      ) : null}
    </div>
  );
}

export default SheetPage;
