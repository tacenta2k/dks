import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type {
  CellEditingStartedEvent,
  CellValueChangedEvent,
  ColDef,
  ColumnMovedEvent,
  GetContextMenuItemsParams,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IsFullWidthRowParams,
  PostSortRowsParams,
  RowClassParams,
  SelectionChangedEvent,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

import {
  DAYS_LEFT_COLUMN_ID,
  applyColumnOrder,
  columnDeleteBlockReason,
  getPrimaryExpiryColumn,
  sortColumnsByPosition,
  type ColumnDefinition,
} from '../../lib/columns';
import { expiryValues } from '../../lib/domain';
import { findDuplicateCivilIdValues, findDuplicatePassportValues } from '../../lib/validation';
import { formatDisplayDate, type StatusThresholds } from '../../lib/date';
import type { Role } from '../auth/auth-types';
import { ColumnWizard } from './column-wizard';
import {
  buildColumnContextMenuItems,
  columnIdFromHeaderTarget,
  duplicateColumnName,
  type ColumnMenuItem,
} from './column-context-menu';
import {
  DEFAULT_EXPIRING_SOON_THRESHOLD,
  QUICK_FILTERS,
  STATUS_FILTER_OPTIONS,
  filterRows,
  type DaysLeftRange,
  type QuickFilter,
  type StatusFilterValue,
} from './filters';
import {
  dashboardSheetFilter,
  type DashboardFilterId,
} from '../dashboard/selectors';
import {
  buildGridColumns,
  buildGridRows,
  isColumnEditableForRole,
  rowClassForStatus,
} from './grid-columns';
import {
  DRAFT_ROW_ID,
  DraftCreateIdentityBox,
  GRID_KEYBOARD_PROPS,
  columnOrderFromMovedEvent,
  createTabToNextCell,
  draftFocusTarget,
  isMeaningfulDraftValue,
  isRepeatOrComposingKey,
  rowIndexOfRowId,
  SHEET_SELECTION_COLUMN_DEF,
  sheetGridThemeClass,
  sheetRowSelectionOptions,
  type DraftFocusTarget,
} from './grid-behaviour';
import { GroupHeaderCell } from './group-header';
import { groupGridRows, groupableColumns, isGroupHeaderRow } from './grouping';
import { createInMemorySheetRepository, type SheetRepository } from './repository';
import { RenewModal } from './renew-modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { RowActions, type SheetGridRendererData } from './row-actions';
import { buildRowContextMenuItems } from './row-context-menu';
import {
  OVERFLOW_QUICK_FILTER_IDS,
  PRIMARY_QUICK_FILTER_IDS,
  useCollapsedQuickFilters,
} from './toolbar-layout';
import type { SheetRow } from './types';
import { can } from '../../lib/permissions';
import './sheet.css';

export interface SheetPageProps {
  repository?: SheetRepository;
  role?: Role | string | null;
  today?: string | Date;
  /**
   * R2-09: the Admin-only "Tools ▾" toolbar menu (Import / Export CSV /
   * Export Excel / Print-PDF). Absent for Office.
   */
  toolsMenu?: ReactNode;
  /** R2-07: AG Grid follows the app theme (no white panels in dark mode). */
  theme?: 'light' | 'dark';
  /** Workspace status thresholds (drives "Expiring soon" and row colours). */
  thresholds?: StatusThresholds;
  /**
   * Bumped by the shell after local mutations and after each successful sync.
   * The page re-fetches IN PLACE (no remount, no loading overlay) so open cell
   * editors, dialogs and input focus survive background refreshes.
   */
  refreshToken?: number;
  /**
   * Bug 3: optional host sync action for the toolbar Refresh button (the
   * full app supplies its existing Supabase sync run, exactly as it does for
   * the Dashboard). Without it, Refresh honestly reloads the local,
   * role-scoped repository only. The button itself renders for any role
   * with the `refresh` capability (Admin and Office).
   */
  onRefresh?: () => Promise<void>;
  /**
   * Tests only: mount the REAL AG Grid alongside the accessible table
   * (jsdom normally swaps the virtualised grid for the deterministic table,
   * so keyboard-editing e2e coverage needs to opt in explicitly).
   */
  renderGridInTests?: boolean;
  /**
   * Dashboard card navigation: open the sheet filtered to exactly the rows
   * the card counted. Re-applied whenever `dashboardFilterToken` changes.
   */
  dashboardFilter?: DashboardFilterId | null;
  dashboardFilterToken?: number;
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

/**
 * Sorting must never move the blank draft row away from the end of the list
 * (Community API: postSortRows). IMPORTANT: this callback must have a STABLE
 * identity — AG Grid v32 listens for the `postSortRows` grid-option change
 * and runs a full sort-stage refresh WITHOUT keepEditingRows whenever the
 * function reference changes, which destroys every open cell editor — the
 * post-commit refresh after a Tab re-renders this page, and handing the
 * grid a fresh arrow function used to kill the editor ~10ms after it opened
 * on the Tab target. Hoisted to module scope so the identity is stable.
 */
function pinDraftRowToEnd(params: PostSortRowsParams<SheetGridRendererData>): void {
  const nodes = params.nodes;
  if (!nodes) {
    return;
  }
  const draftIndex = nodes.findIndex(
    (node) => (node.data as SheetGridRendererData | undefined)?.__rowId === DRAFT_ROW_ID,
  );
  if (draftIndex >= 0 && draftIndex !== nodes.length - 1) {
    const [draftNode] = nodes.splice(draftIndex, 1);
    nodes.push(draftNode);
  }
}

/**
 * Grid options that never depend on render state. They are module constants so
 * their identity is stable across renders: ag-grid-react diffs props by
 * reference (`!==`) and applies a changed `defaultColDef` with `force: true`,
 * which fires AG Grid's `recreateColumnDefs` — a full column-tree rebuild
 * (createColumnTree + destroyColumnTree + valueCache.expire) on every render,
 * including each keystroke in the toolbar search box.
 */
const SHEET_DEFAULT_COL_DEF: ColDef<SheetGridRendererData> = Object.freeze({
  flex: 1,
  minWidth: 120,
  resizable: true,
  sortable: true,
  editable: true,
});

function sheetRowId(params: GetRowIdParams<SheetGridRendererData>): string {
  return params.data.__rowId;
}

function sheetRowClass(params: RowClassParams<SheetGridRendererData>): string {
  if (!params.data) {
    return '';
  }
  // R3 batch E: the draft row carries its own class so its cells keep visible
  // borders wherever it sits.
  if (params.data.__rowId === DRAFT_ROW_ID) {
    return 'sheet-draft-row';
  }
  if (isGroupHeaderRow(params.data)) {
    return '';
  }
  return rowClassForStatus(params.data.status ?? null);
}

function sheetIsFullWidthRow(params: IsFullWidthRowParams<SheetGridRendererData>): boolean {
  return isGroupHeaderRow(params.rowNode.data);
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

/**
 * Upper bound on the animation frames spent waiting for the refreshed row
 * model / rendered cell after a draft-row commit. Frames — not a timeout —
 * only bridge React's data commit to AG Grid's row render; the handoff target
 * itself is always re-resolved from the record's row id.
 */
const DRAFT_FOCUS_MAX_FRAMES = 30;

const SKELETON_ROW_COUNT = 8;
const SKELETON_CELL_WIDTHS = ['86%', '64%', '78%', '52%', '70%', '58%'];

/**
 * Immediate first paint for the Visa Sheet view. Navigation mounts a fresh
 * SheetPage whose snapshot read is async; this lightweight placeholder (plain
 * elements + CSS shimmer, no AG Grid, no data) renders on the first commit so
 * the click never shows a blank pause. Quiet in-place refreshes never reach
 * it — only the initial (non-quiet) load sets `loading`.
 */
function SheetLoadingSkeleton() {
  return (
    <div
      className="sheet-page sheet-loading-skeleton"
      data-testid="sheet-loading-skeleton"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="sheet-loading-skeleton__caption">Loading visa sheet…</p>
      <div className="sheet-loading-skeleton__toolbar" aria-hidden="true">
        <span className="sheet-skeleton-bar sheet-skeleton-bar--search" />
        <span className="sheet-skeleton-bar sheet-skeleton-bar--select" />
        {[0, 1, 2, 3, 4].map((index) => (
          <span key={index} className="sheet-skeleton-bar sheet-skeleton-bar--chip" />
        ))}
      </div>
      <div className="sheet-loading-skeleton__grid" aria-hidden="true">
        {Array.from({ length: SKELETON_ROW_COUNT }).map((_, rowIndex) => (
          <div className="sheet-skeleton-row" key={rowIndex}>
            {SKELETON_CELL_WIDTHS.map((width, cellIndex) => (
              <span
                key={cellIndex}
                className="sheet-skeleton-bar"
                style={{ width, animationDelay: `${(rowIndex * 60 + cellIndex * 40) % 700}ms` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SheetPage({
  repository: providedRepository,
  role = 'office',
  today,
  toolsMenu = null,
  theme = 'light',
  thresholds,
  refreshToken = 0,
  onRefresh,
  renderGridInTests = false,
  dashboardFilter = null,
  dashboardFilterToken = 0,
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
  // Exact internal window for dashboard cards without a chip (1 day,
  // 6 months, 1 year). Any chip/status interaction clears it.
  const [daysRange, setDaysRange] = useState<DaysLeftRange | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('');
  const [groupByColumnId, setGroupByColumnId] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [renewRow, setRenewRow] = useState<SheetRow | null>(null);
  // SET-11: row / column deletion confirms in-app instead of window.confirm.
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: 'row'; row: SheetRow }
    | { kind: 'rows'; rows: SheetRow[] }
    | { kind: 'column'; column: ColumnDefinition; populated: number }
    | null
  >(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Bug 4: ids of the rows checked for bulk delete. React owns the state so
  // the real grid, the test/host table and the "Delete selected (N)" count
  // can never disagree; AG Grid merely mirrors it (selectionChanged) and is
  // cleared through its API after a successful batch.
  const [selectedRowIds, setSelectedRowIds] = useState<readonly string[]>([]);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [columnMenu, setColumnMenu] = useState<{ column: ColumnDefinition; x: number; y: number } | null>(null);
  const [renameColumn, setRenameColumn] = useState<ColumnDefinition | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<GridApi<SheetGridRendererData> | null>(null);
  // AG Grid needs real layout measurements; jsdom uses the deterministic
  // table below unless a keyboard-editing e2e test opts into the real grid.
  // Build-time constant, not a runtime probe: the jsdom-only table below is
  // deleted from production bundles (see PERFORMANCE_AUDIT.md H3).
  const renderRealGrid = !__DKS_TEST_SURFACE__ || renderGridInTests;
  // FIXES_UI §5.2 "Smaller windows": the last two chips move into a menu.
  const collapsedFilters = useCollapsedQuickFilters();
  const moreFiltersRef = useRef<HTMLDivElement>(null);
  // Derived once per layout change instead of rebuilding these arrays (and
  // the chip elements that map over them) on every quiet-refresh render.
  const visibleQuickFilters = useMemo(
    () => QUICK_FILTERS
      .filter((filter) => filter.id !== 'all')
      .filter((filter) => (
        collapsedFilters
          ? (PRIMARY_QUICK_FILTER_IDS as readonly string[]).includes(filter.id)
          : true
      )),
    [collapsedFilters],
  );
  const overflowQuickFilters = useMemo(
    () => QUICK_FILTERS.filter((filter) => (
      (OVERFLOW_QUICK_FILTER_IDS as readonly string[]).includes(filter.id)
    )),
    [],
  );

  // The rows array of the LAST refresh, set the moment the snapshot is read
  // (before React re-renders). Comparing it by identity with the rows array
  // the current render is based on tells a draft-commit focus hand-off
  // whether the row set it sees is fresh or still one render behind.
  const latestRowsRef = useRef<readonly SheetRow[]>(rows);
  const renderedRowsRef = useRef<readonly SheetRow[]>(rows);
  renderedRowsRef.current = rows;

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
      latestRowsRef.current = nextRows;
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

  // Bug 3: the toolbar Refresh button (Admin AND Office, via the explicit
  // `refresh` capability). It runs the host sync first when one is supplied
  // — the SAME RLS-bounded sync run the background loop already performs —
  // then reloads the local snapshot in place. The repository read stays
  // role-scoped (Electron adapter → getSnapshot IPC with the session role),
  // so an Office refresh can never pull or show records outside the 3-day
  // window. Single-flight: the ref closes the gap before React re-renders
  // the button as disabled (same pattern as the Dashboard Refresh).
  const canRefresh = can(role, 'refresh');
  const [refreshing, setRefreshing] = useState(false);
  const manualRefreshInFlightRef = useRef(false);
  const handleManualRefresh = useCallback(async () => {
    if (!canRefresh || manualRefreshInFlightRef.current) {
      return;
    }
    manualRefreshInFlightRef.current = true;
    setRefreshing(true);
    let syncError: string | null = null;
    try {
      if (onRefresh) {
        try {
          await onRefresh();
        } catch (caught) {
          syncError = caught instanceof Error ? caught.message : 'Sync did not complete.';
        }
      }
      // Always reload locally afterwards: a failed sync must not discard the
      // device's current data or unsaved outbox work.
      await refresh({ quiet: true });
      setStatusMessage(syncError
        ? `Sync did not complete (${syncError}). Showing the latest local data.`
        : onRefresh
          ? 'Sync complete. Visa Sheet refreshed.'
          : 'Visa Sheet refreshed.');
    } finally {
      manualRefreshInFlightRef.current = false;
      setRefreshing(false);
    }
  }, [canRefresh, onRefresh, refresh]);

  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) {
      return;
    }
    lastRefreshToken.current = refreshToken;
    void refresh({ quiet: true });
  }, [refreshToken, refresh]);

  // Dashboard card navigation: apply the card's EXACT filter (existing chip
  // or status where equivalent, otherwise the internal days range) and clear
  // any search text so the sheet shows precisely the rows the card counted.
  // Null sentinel: the sheet remounts when navigating from the dashboard, so
  // the first effect run must apply the pending card filter too.
  const lastDashboardFilterToken = useRef<number | null>(null);
  useEffect(() => {
    if (lastDashboardFilterToken.current === dashboardFilterToken) {
      return;
    }
    lastDashboardFilterToken.current = dashboardFilterToken;
    if (!dashboardFilter) {
      return;
    }
    const target = dashboardSheetFilter(dashboardFilter);
    setSearch('');
    setQuickFilter(target.quickFilter);
    setStatusFilter(target.status);
    setDaysRange(target.daysRange);
  }, [dashboardFilter, dashboardFilterToken]);

  // Render the PERSISTED order: `position` is the saved column order
  // (SQLite/app_columns). Both the real grid and the accessible table read
  // this one list, so the two surfaces can never disagree about order.
  const activeColumns = useMemo(
    () => sortColumnsByPosition(columns)
      .filter((column) => column.deleted !== true && column.visible !== false),
    [columns],
  );
  const primaryExpiry = useMemo(() => getPrimaryExpiryColumn(activeColumns), [activeColumns]);
  const expiringSoonThreshold = thresholds?.expiringSoonFrom ?? DEFAULT_EXPIRING_SOON_THRESHOLD;
  const matchingRows = useMemo(() => filterRows(rows, activeColumns, {
    search,
    quickFilter,
    daysRange,
    status: statusFilter,
    today,
    expiringSoonThreshold,
    thresholds,
  }), [rows, activeColumns, search, quickFilter, daysRange, statusFilter, today, expiringSoonThreshold, thresholds]);
  const matchingIds = useMemo(() => new Set(matchingRows.map((row) => row.id)), [matchingRows]);

  // Bug 4: bulk delete is offered to exactly the roles that may soft-delete
  // a single row today (deny-by-default capability check, mirrored at IPC).
  const canBulkDelete = can(role, 'softDelete');
  const selectedIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const selectedRowsForDelete = useMemo(
    () => rows.filter((row) => row.deleted !== true && selectedIdSet.has(row.id)),
    [rows, selectedIdSet],
  );
  // Drop ids whose rows left the sheet (deleted elsewhere / sync) so the
  // count and the eventual batch can never target ghosts.
  useEffect(() => {
    setSelectedRowIds((current) => {
      if (current.length === 0) {
        return current;
      }
      const alive = new Set(rows.filter((row) => row.deleted !== true).map((row) => row.id));
      const next = current.filter((id) => alive.has(id));
      return next.length === current.length ? current : next;
    });
  }, [rows]);
  const allVisibleSelected = matchingRows.length > 0
    && matchingRows.every((row) => selectedIdSet.has(row.id));
  const someVisibleSelected = matchingRows.some((row) => selectedIdSet.has(row.id));

  const toggleRowSelected = useCallback((rowId: string, selected: boolean) => {
    setSelectedRowIds((current) => {
      if (selected) {
        return current.includes(rowId) ? current : [...current, rowId];
      }
      return current.filter((id) => id !== rowId);
    });
  }, []);

  // Select-all covers ONLY the currently matching (visible) rows.
  const toggleSelectAllVisible = useCallback((selected: boolean) => {
    setSelectedRowIds(selected ? matchingRows.map((row) => row.id) : []);
  }, [matchingRows]);

  // Keep React's selection in step with the grid's checkboxes (including
  // its filtered header select-all). Synthetic rows never carry a record.
  const handleSelectionChanged = useCallback((
    event: SelectionChangedEvent<SheetGridRendererData>,
  ) => {
    const ids = event.api.getSelectedNodes()
      .map((node) => node.data?.__sheetRow?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    setSelectedRowIds((current) => (
      current.length === ids.length && current.every((id) => ids.includes(id))
        ? current
        : ids
    ));
  }, []);

  const gridRowSelection = useMemo(
    () => sheetRowSelectionOptions<SheetGridRendererData>(canBulkDelete),
    [canBulkDelete],
  );
  const builtRows = useMemo(() => buildGridRows(rows, activeColumns, { today }), [rows, activeColumns, today]);
  const groupable = useMemo(() => groupableColumns(activeColumns), [activeColumns]);
  const groupColumn = useMemo(
    () => groupable.find((column) => column.id === groupByColumnId) ?? null,
    [groupable, groupByColumnId],
  );
  // SHEET-11 / R3 user decision: ONE blank draft row, placed immediately after
  // the last saved record (never pinned to the bottom of the viewport). The
  // first meaningful committed value turns it into a real record and a fresh
  // blank draft appears beneath it, because a draft is always appended here.
  const draftRow = useMemo(() => {
    const data: SheetGridRendererData = {
      __rowId: DRAFT_ROW_ID,
      daysLeft: null,
      status: null,
    };
    activeColumns.forEach((column) => {
      data[column.id] = null;
    });
    return data;
  }, [activeColumns]);

  const displayRows = useMemo(() => {
    const visibleRows = builtRows.rows.filter((row) => matchingIds.has(row.__rowId));
    const grouped = groupGridRows(visibleRows, groupColumn);
    return [...grouped, draftRow];
  }, [builtRows.rows, matchingIds, groupColumn, draftRow]);

  // -- Draft-row commit → focus handoff ------------------------------------
  // A draft commit moves the new record to its own place in the sheet (the
  // local store returns `ORDER BY updated_at DESC`, so it lands at the TOP)
  // and re-pins the blank draft row last. The grid row the user was editing
  // therefore no longer exists at the captured rowIndex, and the refreshed
  // rowData reaches the grid asynchronously. The handoff below keeps only
  // stable coordinates — the created record's row id + the target column id —
  // and resolves them against the LIVE row model (see applyPendingDraftFocus).
  const displayRowsRef = useRef<readonly SheetGridRendererData[]>(displayRows);
  displayRowsRef.current = displayRows;
  const pendingDraftFocusRef = useRef<DraftFocusTarget | null>(null);
  const draftFocusFrameRef = useRef<number | null>(null);
  const draftFocusFramesRef = useRef(0);

  /**
   * Land the cursor on the record a draft-row commit created, at its CURRENT
   * grid position.
   *
   * Returns true when the handoff is finished (applied, fallen back, or
   * dropped) and false while the refreshed data is still settling — the
   * caller then retries on the grid's model update / next frame. Nothing here
   * depends on the draft row's old rowIndex or on a fixed delay.
   */
  const applyPendingDraftFocus = useCallback((): boolean => {
    const api = gridApiRef.current;
    const target = pendingDraftFocusRef.current;
    if (!target || !api) {
      return true;
    }
    let rowId = target.rowId;
    let columnId = target.columnId;
    let rowIndex = rowIndexOfRowId(api, rowId);
    if (rowIndex === null) {
      if (displayRowsRef.current.some((row) => row.__rowId === target.rowId)) {
        // The refreshed rows are rendered but the grid has not applied them
        // to its row model yet — wait for the model update.
        return false;
      }
      if (renderedRowsRef.current !== latestRowsRef.current) {
        // The snapshot holding this record has been read but not rendered
        // yet, so the grid cannot show it yet — wait, never assume that it is
        // hidden.
        return false;
      }
      // The refreshed data settled WITHOUT this record (an active filter
      // hides it): keep continuous entry on the fresh draft row instead.
      const draftIndex = rowIndexOfRowId(api, DRAFT_ROW_ID);
      if (draftIndex === null) {
        pendingDraftFocusRef.current = null;
        return true;
      }
      rowId = DRAFT_ROW_ID;
      columnId = target.draftColumnId;
      rowIndex = draftIndex;
      pendingDraftFocusRef.current = { rowId, columnId, draftColumnId: target.draftColumnId };
    }
    try {
      // Close the transient editor the Tab gesture opened on the draft row
      // before the refreshed data arrived — one focused editor only.
      if (api.getEditingCells().length > 0) {
        api.stopEditing();
      }
      api.setFocusedCell(rowIndex, columnId);
      api.startEditingCell({ rowIndex, colKey: columnId });
      const started = api.getEditingCells().some((cell) => (
        cell.rowIndex === rowIndex && String(cell.column.getColId()) === columnId
      ));
      if (!started) {
        // Row model is current but this cell is not rendered yet: retry.
        return false;
      }
      pendingDraftFocusRef.current = null;
      return true;
    } catch {
      // The grid can be torn down between the refresh and the frame.
      pendingDraftFocusRef.current = null;
      return true;
    }
  }, []);

  /**
   * Retry a still-pending handoff once per animation frame (bounded by
   * DRAFT_FOCUS_MAX_FRAMES). Frames — not a timeout — only bridge the gap
   * between the row model update and the cell actually being rendered; both
   * the row index and the rendered cell are re-checked on every attempt.
   */
  const schedulePendingDraftFocus = useCallback(() => {
    if (draftFocusFrameRef.current !== null) {
      return; // a frame is already queued; it re-reads the pending target
    }
    function tick() {
      draftFocusFrameRef.current = null;
      if (applyPendingDraftFocus()) {
        draftFocusFramesRef.current = 0;
        return;
      }
      draftFocusFramesRef.current += 1;
      if (draftFocusFramesRef.current > DRAFT_FOCUS_MAX_FRAMES) {
        // Give up quietly instead of hijacking a later, unrelated focus.
        pendingDraftFocusRef.current = null;
        draftFocusFramesRef.current = 0;
        return;
      }
      draftFocusFrameRef.current = window.requestAnimationFrame(tick);
    }
    draftFocusFrameRef.current = window.requestAnimationFrame(tick);
  }, [applyPendingDraftFocus]);

  /** Try the handoff immediately, then keep retrying per frame if needed. */
  const flushPendingDraftFocus = useCallback(() => {
    if (applyPendingDraftFocus()) {
      draftFocusFramesRef.current = 0;
      return;
    }
    schedulePendingDraftFocus();
  }, [applyPendingDraftFocus, schedulePendingDraftFocus]);

  // AG Grid fires modelUpdated once the row model is rebuilt and every node
  // has its CURRENT row index (including the draft row's re-pin). The retry
  // is deferred to the next frame so the grid is never mutated inside its own
  // event dispatch, and so the target cell has a chance to render.
  const handleModelUpdated = useCallback(() => {
    if (pendingDraftFocusRef.current) {
      schedulePendingDraftFocus();
    }
  }, [schedulePendingDraftFocus]);

  useEffect(() => () => {
    if (draftFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFocusFrameRef.current);
      draftFocusFrameRef.current = null;
    }
  }, []);

  const duplicatePassportValues = useMemo(() => {
    const passportColumn = activeColumns.find((column) => (
      column.isPassport === true || column.is_passport === true || /passport/i.test(column.name)
    ));
    return passportColumn ? findDuplicatePassportValues(rows, passportColumn) : new Set<string>();
  }, [rows, activeColumns]);

  // Advisory duplicate Civil ID check — independent from the passport check,
  // across ACTIVE (non-deleted) rows of the FIRST active civil_id column.
  const duplicateCivilIdValues = useMemo(() => {
    const civilIdColumn = activeColumns.find((column) => column.type === 'civil_id');
    return civilIdColumn ? findDuplicateCivilIdValues(rows, civilIdColumn) : new Set<string>();
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

  const handleDelete = useCallback((row: SheetRow) => {
    setError(null);
    setPendingDelete({ kind: 'row', row });
  }, []);

  const confirmDelete = useCallback(async () => {
    const pending = pendingDelete;
    if (!pending || deleteBusy) {
      return;
    }
    setDeleteBusy(true);
    try {
      if (pending.kind === 'row') {
        await repository.softDeleteRow(pending.row.id);
        setSelectedRowIds((current) => current.filter((id) => id !== pending.row.id));
        setStatusMessage(`Moved ${displayLabel(pending.row, activeColumns)} to the recycle bin.`);
      } else if (pending.kind === 'rows') {
        // Bug 4: ONE bulk call down to the store's single transaction.
        // Adapters without it (older test doubles) fall back to the same
        // per-row soft deletes the single-row button already performs.
        const ids = pending.rows.map((row) => row.id);
        if (repository.softDeleteRows) {
          await repository.softDeleteRows(ids);
        } else {
          for (const row of pending.rows) {
            await repository.softDeleteRow(row.id);
          }
        }
        setSelectedRowIds([]);
        try {
          gridApiRef.current?.deselectAll();
        } catch {
          // The grid may already be gone; the quiet refresh re-renders it.
        }
        setStatusMessage(
          `Moved ${ids.length} row${ids.length === 1 ? '' : 's'} to the recycle bin.`,
        );
      } else {
        await repository.softDeleteColumn(pending.column.id, role ?? '');
        setStatusMessage(`Removed ${pending.column.name}.`);
      }
      await refresh({ quiet: true });
      setPendingDelete(null);
    } catch (caught) {
      // All-or-nothing: the store rolls the batch back; keep the dialog and
      // the selection so the user sees the error and can retry or cancel.
      setError(caught instanceof Error ? caught.message : 'Unable to delete.');
    } finally {
      setDeleteBusy(false);
    }
  }, [pendingDelete, deleteBusy, repository, role, refresh, activeColumns]);

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

  // Event callbacks and the context menu are grid *properties* too, so they
  // must keep a stable identity between renders (see SHEET_DEFAULT_COL_DEF).
  const handleGridReady = useCallback((event: GridReadyEvent<SheetGridRendererData>) => {
    gridApiRef.current = event.api;
  }, []);

  const getSheetContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<SheetGridRendererData>) => {
      // FIXES_UI §5.6 (SHEET-14): row right-click menu. Synthetic rows (group
      // header / pinned draft) have no menu.
      const data = params.node?.data as SheetGridRendererData | null | undefined;
      const row = data?.__sheetRow;
      if (!row || data?.__rowId === DRAFT_ROW_ID) {
        return [];
      }
      return buildRowContextMenuItems(row, {
        onDuplicate: handleDuplicate,
        onDelete: handleDelete,
        onRenew: handleRenew,
      });
    },
    [handleDelete, handleDuplicate, handleRenew],
  );

  /**
   * SHEET-12 Tab contract: the ordered editable user columns (system columns
   * # / Actions / + / Days Left are never tab targets). The same predicate as
   * buildGridColumns' editable flag keeps both sides in agreement.
   */
  const editableColumnIds = useMemo(
    () => activeColumns
      .filter((column) => isColumnEditableForRole(column, role ?? 'office'))
      .map((column) => column.id),
    [activeColumns, role],
  );

  // -- Column drag-reorder persistence ------------------------------------
  // AG Grid dragging is visual only: without this, the next columnDefs
  // rebuild (cell save, quiet refresh, navigation, restart) restored the
  // persisted `position` order and the dropped column snapped back. A
  // finished user drag now (1) updates local state optimistically so the
  // drop never flickers back, then (2) persists normalized positions
  // through the repository (SQLite first, durable outbox → Supabase) and
  // (3) quietly re-reads the canonical order. Drags are serialized so a
  // slow save can never overwrite a newer drop with a stale order.
  const activeColumnsRef = useRef(activeColumns);
  useEffect(() => {
    activeColumnsRef.current = activeColumns;
  }, [activeColumns]);
  const reorderQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persistColumnOrder = useCallback((orderedIds: readonly string[]) => {
    // Capture pre-drag positions BEFORE the optimistic update: the fallback
    // path diffs against these to touch only columns that actually moved.
    const before = activeColumnsRef.current;
    setColumns((current) => applyColumnOrder(current, orderedIds));
    const task = reorderQueueRef.current.then(async () => {
      try {
        if (repository.reorderColumns) {
          await repository.reorderColumns(orderedIds);
        } else {
          // Older adapters/test doubles: same normalized positions through
          // the existing per-column update path (changed columns only).
          for (const [index, columnId] of orderedIds.entries()) {
            const column = before.find((candidate) => candidate.id === columnId);
            if (column && (column.position ?? index) !== index) {
              await repository.updateColumn(columnId, { position: index });
            }
          }
        }
        await refresh({ quiet: true });
        setStatusMessage('Column order saved.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to save the column order.');
        // Restore the persisted order so the grid and the store agree.
        await refresh({ quiet: true });
      }
    });
    reorderQueueRef.current = task;
    return task;
  }, [repository, refresh]);

  const handleColumnMoved = useCallback((event: ColumnMovedEvent<SheetGridRendererData>) => {
    // Only a finished USER drag with a genuinely new user-column order
    // persists; programmatic/refresh-driven moves return null here, so a
    // background snapshot can never echo into a reorder write loop.
    const orderedIds = columnOrderFromMovedEvent(event, activeColumnsRef.current);
    if (orderedIds) {
      void persistColumnOrder(orderedIds);
    }
  }, [persistColumnOrder]);

  // Tab/Shift+Tab while editing commits and moves to the next/previous
  // editable column (createTabToNextCell: `true` = commit + stay).
  const handleTabToNextCell = useMemo(
    () => createTabToNextCell<SheetGridRendererData>(
      (columnId) => gridApiRef.current?.getColumn(columnId) ?? null,
      () => editableColumnIds,
    ),
    [editableColumnIds],
  );

  /**
   * Which key committed the draft row (Tab vs Enter)? Captured BEFORE the
   * grid consumes the key so the async create+refresh can restore focus with
   * Excel semantics: Tab lands editing the next editable column of the NEW
   * record; Enter keeps the continuous-entry focus on the fresh draft row.
   */
  const draftCommitIntentRef = useRef<'tab' | 'enter' | null>(null);
  const draftCreateInFlightRef = useRef(false);
  // Bug 2: one stable client identity per draft-row commit. It is reused by
  // every retry of that commit and rotates only when a NEW draft editing
  // session begins after a successful create (see DraftCreateIdentityBox).
  const draftCreateIdentityBox = useMemo(() => new DraftCreateIdentityBox(), []);
  const rememberGridKeyIntent = useCallback((event: ReactKeyboardEvent) => {
    // A held key's auto-repeat and an IME-confirming Enter are not new
    // commit gestures — they must neither re-arm the intent nor be treated
    // as another physical Enter/Tab press.
    if (isRepeatOrComposingKey(event)) {
      return;
    }
    if (event.key === 'Tab') {
      draftCommitIntentRef.current = 'tab';
    } else if (event.key === 'Enter') {
      draftCommitIntentRef.current = 'enter';
    } else if (event.key === 'Escape') {
      draftCommitIntentRef.current = null;
    }
  }, []);

  /** Bug 2: starting to edit the (fresh) draft row rotates a consumed identity. */
  const handleCellEditingStarted = useCallback((
    event: CellEditingStartedEvent<SheetGridRendererData>,
  ) => {
    if (event.data?.__rowId === DRAFT_ROW_ID) {
      draftCreateIdentityBox.prepareForNextDraftEdit();
    }
  }, [draftCreateIdentityBox]);

  const createFromDraft = useCallback(async (field: string, value: unknown) => {
    if (!field || field === DAYS_LEFT_COLUMN_ID || field === '__actions' || !isMeaningfulDraftValue(value)) {
      return;
    }
    // One physical Enter/Tab can be followed by AG Grid's focus-loss commit
    // or a key repeat while the first create is still awaiting the local
    // repository. Until that request settles, the synthetic draft is already
    // being turned into a record; a second call must not create another one.
    // This is an in-flight guard only — identical names remain legitimate
    // once the first record has been saved.
    if (draftCreateInFlightRef.current) {
      return;
    }
    draftCreateInFlightRef.current = true;
    try {
      // Bug 2, second layer: the in-flight guard above only covers calls
      // that OVERLAP. A repeated commit that lands after the first create
      // settles (focus-loss commit, held-Enter re-edit, IPC retry) carries
      // the same client id + idempotency key, so the repository/store can
      // recognise the retry and return the existing row instead of
      // inserting a duplicate. The identity rotates when the next draft
      // editing session begins (handleCellEditingStarted / draft inputs).
      const identity = draftCreateIdentityBox.ensure();
      const created = await repository.createRow({ [field]: value }, null, identity);
      draftCreateIdentityBox.markConsumed();
      await refresh({ quiet: true });
      setStatusMessage('Added a new record.');
      const api = gridApiRef.current;
      if (api) {
        // Excel semantics on the draft row: Tab creates the record AND lands
        // editing the NEXT editable column OF THAT NEW RECORD; Enter keeps
        // continuous entry on the fresh draft row. The handoff only records
        // stable coordinates (row id + column id) — the draft row's old
        // rowIndex is meaningless once the new record is placed at its own
        // position in the sheet.
        const intent = draftCommitIntentRef.current;
        draftCommitIntentRef.current = null;
        pendingDraftFocusRef.current = draftFocusTarget(intent, created.id, field, editableColumnIds);
        flushPendingDraftFocus();
      } else {
        draftCommitIntentRef.current = null;
        pendingDraftFocusRef.current = null;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to add the record.');
    } finally {
      draftCreateInFlightRef.current = false;
    }
  }, [repository, refresh, editableColumnIds, draftCreateIdentityBox, flushPendingDraftFocus]);

  const handleCellValueChanged = useCallback(async (
    event: CellValueChangedEvent<SheetGridRendererData>,
  ) => {
    const field = event.colDef.field;
    if (!field || field === DAYS_LEFT_COLUMN_ID || field === '__actions' || !event.data) {
      return;
    }
    if (event.data.__rowId === DRAFT_ROW_ID) {
      await createFromDraft(field, event.newValue);
      return;
    }
    if (isGroupHeaderRow(event.data)) {
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
  }, [activeColumns, repository, refresh, createFromDraft]);

  const handleCellValueChangedEvent = useCallback(
    (event: CellValueChangedEvent<SheetGridRendererData>) => void handleCellValueChanged(event),
    [handleCellValueChanged],
  );

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

  // SHEET-13 column header menu actions -------------------------------------
  const handleDuplicateColumn = useCallback(async (column: ColumnDefinition) => {
    try {
      await repository.addColumn({
        name: duplicateColumnName(column.name, columns.map((candidate) => candidate.name)),
        type: column.type,
        options: column.options,
        isPassport: column.isPassport === true || column.is_passport === true,
      });
      await refresh({ quiet: true });
      setStatusMessage(`Duplicated ${column.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to duplicate the column.');
    }
  }, [repository, refresh, columns]);

  const handleDeleteColumn = useCallback(async (column: ColumnDefinition) => {
    const blockReason = columnDeleteBlockReason(column, role ?? '', rows);
    if (blockReason !== null) {
      // The message must name the REAL blocker: a stale primary-expiry mark
      // on a non-expiry/deleted column is healed away and never reported as
      // "the primary expiry column", and protection is id-exact, never by
      // name — a user column called "Days Left" stays deletable.
      setStatusMessage(blockReason === 'system'
        ? 'Days Left is a generated system column and cannot be deleted.'
        : blockReason === 'primary'
          ? `${column.name} is the primary expiry column and cannot be deleted.`
          : 'Only an admin can delete a column that contains data.');
      return;
    }
    // SET-11: the dialog states how many records still hold a value in this
    // column, so an admin deleting populated data sees the count first.
    const populated = rows.filter((row) => isMeaningfulDraftValue(dataValue(row, column))).length;
    setError(null);
    setPendingDelete({ kind: 'column', column, populated });
  }, [role, rows]);

  const handleSetPrimary = useCallback(async (column: ColumnDefinition) => {
    try {
      for (const candidate of activeColumns.filter((item) => item.type === 'date_expiry')) {
        const primary = candidate.id === column.id;
        await repository.updateColumn(candidate.id, {
          isPrimaryExpiry: primary,
          is_primary_expiry: primary,
        });
      }
      await refresh({ quiet: true });
      setStatusMessage(`${column.name} is now the primary expiry.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to change the primary expiry.');
    }
  }, [activeColumns, repository, refresh]);

  const openRename = useCallback((column: ColumnDefinition) => {
    setRenameColumn(column);
    setRenameValue(column.name);
  }, []);

  const saveRename = useCallback(async () => {
    if (!renameColumn) {
      return;
    }
    const name = renameValue.trim();
    if (!name) {
      setError('Column name is required.');
      return;
    }
    try {
      await repository.updateColumn(renameColumn.id, { name });
      await refresh({ quiet: true });
      setRenameColumn(null);
      setStatusMessage(`Renamed to ${name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to rename the column.');
    }
  }, [renameColumn, renameValue, repository, refresh]);

  const columnMenuItems: ColumnMenuItem[] = useMemo(() => {
    if (!columnMenu) {
      return [];
    }
    return buildColumnContextMenuItems(columnMenu.column, {
      role,
      isPrimary: columnMenu.column.id === primaryExpiry?.id,
      onRename: openRename,
      onDuplicate: (column) => void handleDuplicateColumn(column),
      onDelete: (column) => void handleDeleteColumn(column),
      onSetPrimary: (column) => void handleSetPrimary(column),
    });
  }, [columnMenu, role, primaryExpiry?.id, openRename, handleDuplicateColumn, handleDeleteColumn, handleSetPrimary]);

  // Close the column menu on Escape / outside click.
  useEffect(() => {
    if (!moreFiltersOpen) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (moreFiltersRef.current && !moreFiltersRef.current.contains(event.target as Node)) {
        setMoreFiltersOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreFiltersOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [moreFiltersOpen]);

  useEffect(() => {
    if (!columnMenu) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setColumnMenu(null);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        setColumnMenu(null);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [columnMenu]);

  const handleGridContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const columnId = columnIdFromHeaderTarget(event.target as Element);
    if (!columnId) {
      return;
    }
    const column = activeColumns.find((candidate) => (
      candidate.id === columnId || candidate.name === columnId
    ));
    if (!column) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setColumnMenu({
      column,
      x: Math.max(0, event.clientX - rect.left),
      y: Math.max(0, event.clientY - rect.top),
    });
  }, [activeColumns]);

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

  // FIXES_UI §5.9: ONE context-aware empty state — never stacked with the
  // grid's own text, never covering the `+` header or the draft row. Rendered
  // as a non-blocking hint INSIDE the grid area (overlay), or inline next to
  // the accessible table in test/host environments.
  const emptyNotice = rows.length === 0 ? (
    <div className="sheet-grid__empty" role="status">
      <p>Type in the blank row below to add your first entry.</p>
    </div>
  ) : matchingRows.length === 0 ? (
    <div className="sheet-grid__empty" role="status">
      <p>No records match these filters.</p>
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
  ) : null;

  if (loading) {
    return <SheetLoadingSkeleton />;
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
          {/* FIXES_UI §5.2 / R2-04 / R2-09: ONE compact toolbar. Search, the
              final status dropdown, the five quick chips, Group by (only when
              a text/dropdown column exists) and the Admin-only Tools menu.
              Add row / Add column / Manage columns are gone. */}
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
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(selectedValue(event) as StatusFilterValue);
                    setDaysRange(null);
                  }}
                >
                  {STATUS_FILTER_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value || 'all'}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="sheet-quick-filters" role="group" aria-label="Quick filters">
                {visibleQuickFilters.map((filter) => (
                    <button
                      key={filter.id}
                      className={`sheet-filter-chip${quickFilter === filter.id ? ' sheet-filter-chip--active' : ''}`}
                      type="button"
                      aria-pressed={quickFilter === filter.id}
                      title={filter.label === 'Today' ? 'Days Left = 0' : `Days Left 0–${filter.id}`}
                      onClick={() => {
                        setQuickFilter(quickFilter === filter.id ? 'all' : filter.id);
                        setDaysRange(null);
                      }}
                    >
                      {filter.label}
                    </button>
                  ))}
                {collapsedFilters ? (
                  <div className="sheet-more-filters" ref={moreFiltersRef}>
                    <button
                      className={`sheet-filter-chip sheet-more-filters__button${(OVERFLOW_QUICK_FILTER_IDS as readonly string[]).includes(quickFilter) ? ' sheet-filter-chip--active' : ''}`}
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={moreFiltersOpen}
                      onClick={() => setMoreFiltersOpen((open) => !open)}
                    >
                      More filters <span aria-hidden="true">▾</span>
                    </button>
                    {moreFiltersOpen ? (
                      <div className="sheet-more-filters__menu" role="menu" aria-label="More filters">
                        {overflowQuickFilters.map((filter) => (
                            <button
                              key={filter.id}
                              className="sheet-more-filters__item"
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={quickFilter === filter.id}
                              onClick={() => {
                                setQuickFilter(quickFilter === filter.id ? 'all' : filter.id);
                                setDaysRange(null);
                                setMoreFiltersOpen(false);
                              }}
                            >
                              {filter.label}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {groupable.length > 0 ? (
                <label className="sheet-group-by">
                  <span className="sheet-filter__label">Group by</span>
                  <select
                    aria-label="Group by"
                    value={groupByColumnId}
                    onChange={(event) => setGroupByColumnId(event.target.value)}
                  >
                    <option value="">None</option>
                    {groupable.map((column) => (
                      <option value={column.id} key={column.id}>{column.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="sheet-toolbar__actions">
              {/* Bug 4: bulk soft-delete. Shown only when 1+ real rows are
                  checked, and only to roles that may soft-delete today.
                  The count is the live selection, so the confirm that
                  follows can state exactly what will move. */}
              {canBulkDelete && selectedRowsForDelete.length > 0 ? (
                <button
                  className="button button--danger"
                  type="button"
                  disabled={deleteBusy}
                  onClick={() => {
                    setError(null);
                    setPendingDelete({ kind: 'rows', rows: [...selectedRowsForDelete] });
                  }}
                >
                  {`Delete selected (${selectedRowsForDelete.length})`}
                </button>
              ) : null}
              {/* Bug 3: Refresh for every role with the `refresh` capability
                  (Admin and Office) — previously the Visa Sheet had no
                  Refresh button at all. Disabled (with the busy label)
                  while a refresh/sync is running. */}
              {canRefresh ? (
                <button
                  className="button button--secondary"
                  type="button"
                  aria-busy={refreshing}
                  disabled={refreshing}
                  onClick={() => void handleManualRefresh()}
                >
                  {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              ) : null}
              {toolsMenu}
            </div>
            {/* OW-04: Office sees only records created in the last 3 calendar
                days (Asia/Muscat). Admin UI is unchanged. */}
            {role === 'office' ? (
              <p className="sheet-toolbar__window-note" role="note">
                Showing records from the last 3 days.
              </p>
            ) : null}
          </div>

          {duplicatePassportValues.size > 0 ? (
            <div className="sheet-alert sheet-alert--warning" role="alert">
              Duplicate passport warning: {Array.from(duplicatePassportValues).join(', ')}
            </div>
          ) : null}

          {duplicateCivilIdValues.size > 0 ? (
            <div className="sheet-alert sheet-alert--warning" role="alert" aria-label="Duplicate Civil ID warning">
              Duplicate Civil ID warning: {Array.from(duplicateCivilIdValues).join(', ')}
            </div>
          ) : null}

          {renderRealGrid ? (
            <div
              className="sheet-grid-wrap"
                  onContextMenu={handleGridContextMenu}
                  onKeyDownCapture={rememberGridKeyIntent}
                  onPointerDownCapture={() => {
                    draftCommitIntentRef.current = null;
                    pendingDraftFocusRef.current = null;
                  }}
                >
                  {/* §5.9: single non-blocking hint floating inside the grid
                      area; the grid keeps filling the whole viewport below it
                      and stays clickable (the hint ignores pointer events). In
                      test/host environments the same ONE hint renders in flow
                      next to the accessible table instead — never both. */}
                  {__DKS_TEST_SURFACE__ ? null : emptyNotice}
              <div
                className={`sheet-grid ${sheetGridThemeClass(theme)}`}
                data-testid="sheet-grid"
                aria-label="Visa records grid"
                data-theme={theme}
              >
                <AgGridReact<SheetGridRendererData>
                  rowData={displayRows as SheetGridRendererData[]}
                  columnDefs={gridColumnDefs as ColDef<SheetGridRendererData>[]}
                  context={gridContext}
                  defaultColDef={SHEET_DEFAULT_COL_DEF}
                  getRowId={sheetRowId}
                  getRowClass={sheetRowClass}
                  // Sorting must never move the blank draft row away from the
                  // end of the list (Community API: postSortRows). The callback
                  // is hoisted to module scope so its identity NEVER changes —
                  // a new function reference after each render would trigger a
                  // full sort-stage grid refresh that destroys open editors.
                  postSortRows={pinDraftRowToEnd}
                  isFullWidthRow={sheetIsFullWidthRow}
                  fullWidthCellRenderer={GroupHeaderCell}
                  getContextMenuItems={getSheetContextMenuItems}
                  onGridReady={handleGridReady}
                  onCellValueChanged={handleCellValueChangedEvent}
                  onCellEditingStarted={handleCellEditingStarted}
                  // Bug 4: Community multi-row checkbox selection (header
                  // select-all = filtered rows only). Only roles allowed to
                  // soft-delete get it; selection mirrors into React state.
                  rowSelection={gridRowSelection}
                  selectionColumnDef={canBulkDelete ? SHEET_SELECTION_COLUMN_DEF : undefined}
                  onSelectionChanged={handleSelectionChanged}
                  // The refreshed row set reaches the grid asynchronously: a
                  // pending draft-commit focus handoff is resolved here, when
                  // the new row indexes are final.
                  onModelUpdated={handleModelUpdated}
                  // Header drag-reorder: persists the finished user drag as
                  // normalized `position` values (see persistColumnOrder).
                  onColumnMoved={handleColumnMoved}
                  // SHEET-12: Tab commits + edits the next editable column;
                  // Shift+Tab the previous one; system columns are skipped.
                  tabToNextCell={handleTabToNextCell}
                  domLayout="normal"
                  animateRows
                  {...GRID_KEYBOARD_PROPS}
                />
              </div>

              {columnMenu ? (
                <div
                  className="sheet-column-menu"
                  role="menu"
                  aria-label={`Column menu for ${columnMenu.column.name}`}
                  ref={menuRef}
                  style={{ left: columnMenu.x, top: columnMenu.y }}
                >
                  {columnMenuItems.map((item) => (
                    <button
                      className="sheet-column-menu__item"
                      type="button"
                      role="menuitem"
                      key={item.id}
                      disabled={item.disabled}
                      onClick={() => {
                        item.action();
                        setColumnMenu(null);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* jsdom-only surface: AG Grid needs layout geometry that jsdom does
              not provide, so keyboard/draft-row behaviour is asserted against
              this table instead. `__DKS_TEST_SURFACE__` is false in every
              production build, which removes the whole block — production
              renders the real grid above and nothing else. */}
          {__DKS_TEST_SURFACE__ ? (
            <div className="sheet-accessible-table-wrap sheet-accessible-table-wrap--test">
              <table className="sheet-accessible-table" aria-label="Visa records table">
                <thead>
                  <tr>
                    {/* Bug 4: same checkbox-selection surface as the grid
                        (header select-all covers only the filtered rows). */}
                    {canBulkDelete ? (
                      <th scope="col" className="sheet-select-cell">
                        <input
                          type="checkbox"
                          aria-label="Select all visible rows"
                          checked={allVisibleSelected}
                          disabled={matchingRows.length === 0}
                          ref={(element) => {
                            if (element) {
                              element.indeterminate = !allVisibleSelected && someVisibleSelected;
                            }
                          }}
                          onChange={(event) => toggleSelectAllVisible(event.target.checked)}
                        />
                      </th>
                    ) : null}
                    <th scope="col">Actions</th>
                    {activeColumns.map((column) => <th scope="col" key={column.id}>{column.name}</th>)}
                    {/* SHEET-10: the `+` add-column header (same surface as the
                        grid's pinned `+` column; the accessible table is only
                        rendered in test/host environments). */}
                    <th scope="col" className="sheet-add-column-th">
                      <button
                        className="sheet-add-column-header"
                        type="button"
                        aria-label="Add column"
                        title="Add column"
                        onClick={() => setWizardOpen(true)}
                      >
                        +
                      </button>
                    </th>
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
                        {canBulkDelete ? (
                          <td className="sheet-select-cell">
                            <input
                              type="checkbox"
                              aria-label={`Select row ${displayLabel(row, activeColumns)}`}
                              checked={selectedIdSet.has(row.id)}
                              onChange={(event) => toggleRowSelected(row.id, event.target.checked)}
                            />
                          </td>
                        ) : null}
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
                  {/* SHEET-11: the test/host table gets the same pinned draft
                      row, so the "first meaningful value creates one record"
                      behaviour is exercised without a layout engine. */}
                  <tr className="sheet-draft-row" aria-label="New record">
                    {canBulkDelete ? <td /> : null}
                    <td />
                    {activeColumns.map((column) => (
                      <td key={column.id}>
                        <input
                          className="sheet-draft-input"
                          aria-label={`New record ${column.name}`}
                          type="text"
                          defaultValue=""
                          onFocus={() => draftCreateIdentityBox.prepareForNextDraftEdit()}
                          onChange={() => draftCreateIdentityBox.prepareForNextDraftEdit()}
                          onBlur={(event) => {
                            const value = event.target.value;
                            if (isMeaningfulDraftValue(value)) {
                              event.target.value = '';
                              void createFromDraft(column.id, value);
                            }
                          }}
                          onKeyDown={(event) => {
                            // Bug 2: a held Enter (repeat) or an
                            // IME-confirming Enter must not commit again.
                            if (event.key === 'Enter' && !isRepeatOrComposingKey(event)) {
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </td>
                    ))}
                    <td />
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
          {/* In tests the one non-blocking hint sits in flow beside the table. */}
          {__DKS_TEST_SURFACE__ ? emptyNotice : null}
        </section>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'column'
            ? `Delete column "${pendingDelete.column.name}"?`
            : pendingDelete?.kind === 'rows'
              ? `Move ${pendingDelete.rows.length} row${pendingDelete.rows.length === 1 ? '' : 's'} to the Recycle Bin?`
              : 'Move this record to the Recycle Bin?'
        }
        confirmLabel={pendingDelete?.kind === 'column' ? 'Delete column' : 'Move to Recycle Bin'}
        destructive
        busy={deleteBusy}
        error={error}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleteBusy) {
            setPendingDelete(null);
          }
        }}
      >
        {pendingDelete?.kind === 'column' ? (
          <p>
            The column is removed from the sheet. Existing values in this column
            are not lost in the local database, but they stop being shown.
            {pendingDelete.populated > 0
              ? ` ${pendingDelete.populated} record${pendingDelete.populated === 1 ? '' : 's'} currently hold a value in it.`
              : ' It is currently empty.'}
          </p>
        ) : pendingDelete?.kind === 'rows' ? (
          <p>
            The selected record{pendingDelete.rows.length === 1 ? '' : 's'} can be restored
            individually from the Recycle Bin by an administrator.
          </p>
        ) : pendingDelete?.kind === 'row' ? (
          <p>
            {displayLabel(pendingDelete.row, activeColumns)} can be restored from
            the Recycle Bin by an administrator.
          </p>
        ) : null}
      </ConfirmDialog>
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
      {renameColumn ? (
        <div className="sheet-modal-backdrop" role="presentation">
          <section className="sheet-modal" role="dialog" aria-label="Rename column">
            <h2>Rename column</h2>
            <label className="sheet-modal__field">
              <span>Column name</span>
              <input
                aria-label="Column name"
                type="text"
                value={renameValue}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveRename();
                  }
                  if (event.key === 'Escape') {
                    setRenameColumn(null);
                  }
                }}
              />
            </label>
            <div className="sheet-modal__actions">
              <button className="button" type="button" onClick={() => setRenameColumn(null)}>
                Cancel
              </button>
              <button className="button button--primary" type="button" onClick={() => void saveRename()}>
                Save
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default SheetPage;
