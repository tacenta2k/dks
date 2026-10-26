import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { can } from '../../lib/permissions';
import { rowDisplayLabel } from '../../lib/labels';
import type { ColumnDefinition } from '../../lib/columns';
import type { Role } from '../auth/auth-types';
import {
  createCsvExport,
  createXlsxExport,
  type ExportArtifact,
  type ExportSaveCallback,
} from '../import-export/export-service';
import {
  convertColumnDateValues,
  importRows as parseImportRows,
  previewImport,
  type ImportActor,
  type ImportColumnType,
  type ImportPreview,
  type ImportSource,
} from '../import-export/import-service';
import { AuditLogPage, type AuditProfile } from '../audit/AuditLogPage';
import {
  AUDIT_CLEAR_CONFIRMATION,
  auditClearMessage,
  clearRemoteAuditLog,
  isAuditClearConfirmation,
  type AuditClearRemoteClient,
} from '../audit/audit-service';
import { PrintReportModal } from '../print/PrintReportModal';
import {
  exportReportToPdf,
  type PdfExportFile,
  type PrintReportModel,
} from '../print/print-service';
import { RecycleBinPage } from '../recycle-bin/RecycleBinPage';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  createInMemorySheetRepository,
  type SheetRepository,
} from '../sheet/repository';
import type {
  ColumnInput,
  SheetAuditEntry,
  SheetImportRecord,
  SheetRow,
} from '../sheet/types';
import './admin.css';

export interface AdminActor extends ImportActor {
  email?: string | null;
}

export interface AdminToolsProps {
  repository?: SheetRepository;
  role?: Role | string | null;
  actor?: AdminActor | null;
  onSaveExport?: ExportSaveCallback;
  onSavePdf?: (file: PdfExportFile) => void;
  onPrint?: (model: PrintReportModel) => void;
  onRepositoryChanged?: () => void;
  /** Bumped after local mutations / successful syncs; panels re-fetch in
   *  place so remounts cannot steal focus from user inputs. */
  refreshToken?: number;
}

export type AdminExportFormat = 'csv' | 'xlsx';

function activeRows(rows: readonly SheetRow[]): SheetRow[] {
  return rows.filter((row) => row.deleted !== true);
}

/**
 * Browser-safe artifact saving used when Electron has not supplied a native
 * file dialog callback.  The callback remains the preferred integration seam.
 */
export function saveArtifactWithBrowserFallback(artifact: ExportArtifact | PdfExportFile): void {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    return;
  }

  const data = artifact.data instanceof Uint8Array
    ? new Uint8Array(artifact.data)
    : artifact.data;
  const blob = new Blob([data as BlobPart], { type: artifact.mimeType });
  const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : null;
  if (!url) {
    return;
  }

  const link = document.createElement('a');
  link.href = url;
  link.download = artifact.fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } catch {
    // Some embedded/browser test environments expose a URL API but do not
    // implement anchor navigation. The injected saver has already been given
    // a chance before this fallback is reached.
  } finally {
    link.remove();
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  }
}

export async function exportCurrentRows(
  repository: SheetRepository,
  role: Role | string | null | undefined,
  format: AdminExportFormat = 'csv',
  save: ExportSaveCallback = saveArtifactWithBrowserFallback,
): Promise<ExportArtifact> {
  const [columns, rows] = await Promise.all([repository.getColumns(), repository.getRows()]);
  const request = { role, columns, rows: activeRows(rows) };
  if (format === 'xlsx') {
    const artifact = createXlsxExport(request);
    save(artifact);
    return artifact;
  }

  const artifact = createCsvExport(request);
  save(artifact);
  return artifact;
}

function actorOptions(actor: AdminActor | null | undefined): {
  actorId?: string | null;
  actor?: string | null;
} {
  return {
    actorId: actor?.id ?? null,
    actor: actor?.name ?? actor?.email ?? null,
  };
}

/**
 * Human-readable row label for confirmations and status messages (S1/S2):
 * never a raw record id. Delegates to the shared `rowDisplayLabel` helper so
 * toasts, the Recycle Bin and notifications stay consistent.
 */
export function displayRowLabel(row: SheetRow, columns: readonly ColumnDefinition[]): string {
  return rowDisplayLabel(row, columns);
}

async function importSourceForFile(file: File): Promise<ImportSource> {
  if (typeof file.arrayBuffer === 'function') {
    return file;
  }

  if (typeof FileReader === 'undefined') {
    throw new Error('This browser cannot read import files.');
  }

  return {
    name: file.name,
    arrayBuffer: () => new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read the import file.'));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
          return;
        }
        reject(new Error('Unable to read the import file.'));
      };
      reader.readAsArrayBuffer(file);
    }),
  };
}

function ImportPreviewDialog({
  preview,
  onClose,
  onImport,
  importing,
  columnTypes,
  onColumnTypeChange,
  conversions,
  onConversionChange,
}: {
  preview: ImportPreview;
  onClose: () => void;
  onImport: () => void;
  importing: boolean;
  /** User-chosen type per unmapped header (new column creation). */
  columnTypes: Record<string, ImportColumnType>;
  onColumnTypeChange: (header: string, type: ImportColumnType) => void;
  /** User choice per mapped-to-text date column: 'keep' | 'date_start' | 'date_expiry'. */
  conversions: Record<string, 'keep' | 'date_start' | 'date_expiry'>;
  onConversionChange: (columnId: string, choice: 'keep' | 'date_start' | 'date_expiry') => void;
}) {
  return (
    <div className="admin-dialog-backdrop">
      <section className="admin-dialog" role="dialog" aria-label="Import preview" aria-modal="true">
        <header className="admin-dialog__header">
          <div>
            <p className="admin-eyebrow">Import preview</p>
            <h2>{preview.fileName}</h2>
            <p>{preview.totalRows} data rows · {preview.mappings.length} mapped columns</p>
          </div>
          <button className="button" type="button" onClick={onClose}>Close</button>
        </header>

        {preview.unmappedHeaders.length > 0 ? (
          <p className="admin-dialog__warning" role="status">
            New columns will be created for: {preview.unmappedHeaders.join(', ')}
          </p>
        ) : null}

        {preview.suggestedColumnTypes.length > 0 ? (
          <div className="admin-dialog__types" aria-label="New column types">
            <p className="admin-dialog__types-title">Column types</p>
            {preview.suggestedColumnTypes.map((suggestion) => (
              <label key={`${suggestion.header}-type`} className="admin-dialog__type-row">
                <span>
                  {suggestion.header}
                  {' — '}
                  {suggestion.type === 'civil_id' ? 'looks like a Civil ID' : 'looks like dates'}
                </span>
                <select
                  aria-label={`Type for ${suggestion.header}`}
                  value={columnTypes[suggestion.header] ?? suggestion.type}
                  onChange={(event) => onColumnTypeChange(suggestion.header, event.target.value as ImportColumnType)}
                >
                  <option value="date_expiry">Date (expiry)</option>
                  <option value="date_start">Date (start)</option>
                  <option value="text">Text</option>
                  <option value="civil_id">Civil ID</option>
                </select>
              </label>
            ))}
          </div>
        ) : null}

        {preview.dateMappedToText.length > 0 ? (
          <div className="admin-dialog__types" aria-label="Date columns mapped to text">
            {preview.dateMappedToText.map((warning) => (
              <label key={`${warning.columnId}-convert`} className="admin-dialog__type-row admin-dialog__type-row--warning">
                <span>
                  “{warning.header}” is mapped to the text column “{warning.columnName}” but contains date-like values.
                </span>
                <select
                  aria-label={`Date handling for ${warning.columnName}`}
                  value={conversions[warning.columnId] ?? 'keep'}
                  onChange={(event) => onConversionChange(warning.columnId, event.target.value as 'keep' | 'date_start' | 'date_expiry')}
                >
                  <option value="keep">Keep as text</option>
                  <option value="date_expiry">Convert to Date (expiry)</option>
                  <option value="date_start">Convert to Date (start)</option>
                </select>
              </label>
            ))}
          </div>
        ) : null}

        <div className="admin-dialog__table-wrap">
          <table>
            <thead>
              <tr>{preview.headers.map((header) => <th scope="col" key={header}>{header || 'Unnamed'}</th>)}</tr>
            </thead>
            <tbody>
              {preview.rows.map((row, rowIndex) => (
                <tr key={`${preview.fileName}-${rowIndex}`}>
                  {preview.headers.map((header) => <td key={`${rowIndex}-${header}`}>{String(row[header] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="admin-dialog__actions">
          <button className="button" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="button" disabled={importing} onClick={onImport}>
            {importing ? 'Importing…' : 'Import mapped records'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function AdminSheetActions({
  repository: providedRepository,
  role,
  actor,
  onSaveExport,
  onSavePdf,
  onPrint,
  onRepositoryChanged,
}: AdminToolsProps) {
  const repository = useMemo(
    () => providedRepository ?? createInMemorySheetRepository(),
    [providedRepository],
  );
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // R7 follow-up: the toolbar loads its own snapshot, independently of the
  // grid. Exporting/printing before that read resolved produced an EMPTY
  // artifact (0 rows, no columns) — the intermittent admin-features failure.
  // These refs make every action wait for the real loaded state.
  const snapshotReady = useRef(false);
  const snapshotLoad = useRef<Promise<boolean> | null>(null);
  // State is captured by the click handler's closure; after awaiting the load
  // the closure still holds the pre-load arrays, so the loaded snapshot is also
  // mirrored into refs and read from there.
  const columnsRef = useRef<ColumnDefinition[]>([]);
  const rowsRef = useRef<SheetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sourceFile, setSourceFile] = useState<ImportSource | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  // User choices in the import preview: new column types (per unmapped
  // header) and safe conversions of text columns that hold date-like values.
  const [importColumnTypes, setImportColumnTypes] = useState<Record<string, ImportColumnType>>({});
  const [importConversions, setImportConversions] = useState<Record<string, 'keep' | 'date_start' | 'date_expiry'>>({});
  const [reportOpen, setReportOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toolsRef = useRef<HTMLElement>(null);

  // R2-09: the Administrator Tools card became a compact "Tools ▾" menu.
  // Escape / outside click closes it; picking an item closes it too.
  useEffect(() => {
    if (!toolsOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setToolsOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (toolsRef.current && target && !toolsRef.current.contains(target)) {
        setToolsOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [toolsOpen]);

  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    snapshotReady.current = false;
    try {
      const [nextColumns, nextRows] = await Promise.all([
        repository.getColumns(),
        repository.getRows(),
      ]);
      columnsRef.current = nextColumns;
      rowsRef.current = nextRows;
      setColumns(nextColumns);
      setRows(nextRows);
      setError(null);
      snapshotReady.current = true;
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load admin sheet actions.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    const pending = refresh();
    snapshotLoad.current = pending;
    return () => {
      // A late resolution must not flip the flag for a newer repository.
      if (snapshotLoad.current === pending) {
        snapshotLoad.current = null;
        snapshotReady.current = false;
      }
    };
  }, [refresh]);

  /**
   * Resolves once the toolbar's snapshot has been read. Returns false when the
   * read failed, so callers can report it instead of exporting/printing an
   * empty sheet.
   */
  const ensureSnapshotLoaded = useCallback(async (): Promise<boolean> => {
    if (snapshotReady.current) {
      return true;
    }
    const pending = snapshotLoad.current ?? refresh();
    snapshotLoad.current = pending;
    await pending;
    if (snapshotLoad.current === pending) {
      snapshotLoad.current = null;
    }
    return snapshotReady.current;
  }, [refresh]);

  const saveExport = onSaveExport ?? saveArtifactWithBrowserFallback;

  const exportRows = async (format: AdminExportFormat) => {
    if (!can(role, 'export')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Never export a half-loaded snapshot: wait for the real loaded state.
      if (!(await ensureSnapshotLoaded())) {
        setError('The sheet data could not be loaded, so nothing was exported.');
        return;
      }
      const loadedRows = activeRows(rowsRef.current);
      const loadedColumns = columnsRef.current;
      const artifact = format === 'xlsx'
        ? createXlsxExport({ role, rows: loadedRows, columns: loadedColumns })
        : createCsvExport({ role, rows: loadedRows, columns: loadedColumns });
      // The service builds pure artifacts; invoke the injected/native saver here.
      saveExport(artifact);
      setStatus(`Exported ${artifact.rowCount} rows as ${format === 'xlsx' ? 'Excel' : 'CSV'}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to export rows.');
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !can(role, 'import')) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Column mapping is built from the snapshot, so wait for it first.
      if (!(await ensureSnapshotLoaded())) {
        setError('The sheet data could not be loaded, so the file was not imported.');
        return;
      }
      const source = await importSourceForFile(file);
      const nextPreview = await previewImport(source, {
        role,
        columns: columnsRef.current,
        fileName: file.name,
      });
      const initialTypes: Record<string, ImportColumnType> = {};
      for (const header of nextPreview.unmappedHeaders) {
        initialTypes[header] = nextPreview.suggestedColumnTypes.find((s) => s.header === header)?.type ?? 'text';
      }
      const initialConversions: Record<string, 'keep' | 'date_start' | 'date_expiry'> = {};
      for (const warning of nextPreview.dateMappedToText) {
        initialConversions[warning.columnId] = 'keep';
      }
      setSourceFile(source);
      setSourceFileName(file.name);
      setImportColumnTypes(initialTypes);
      setImportConversions(initialConversions);
      setPreview(nextPreview);
      setStatus(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to preview the import file.');
    } finally {
      setBusy(false);
    }
  };

  const createColumn = useCallback(async (header: string, suggested: ColumnInput) => {
    try {
      // The service suggests date types for date-like headers/values; the
      // preview dialog can override either choice before import.
      const type = importColumnTypes[header] ?? suggested.type ?? 'text';
      return await repository.addColumn({ name: suggested.name, type });
    } catch {
      return null;
    }
  }, [repository, importColumnTypes]);

  const confirmImport = async () => {
    if (!sourceFile || !preview || !can(role, 'import')) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Safe conversions chosen in the preview: an existing TEXT column that
      // holds date-like values may be converted to a date column. Valid values
      // become ISO (YYYY-MM-DD); impossible/non-date text is kept exactly as
      // typed — nothing is silently rewritten or dropped.
      const conversionNotes: string[] = [];
      for (const [columnId, choice] of Object.entries(importConversions)) {
        if (choice === 'keep') {
          continue;
        }
        const target = columns.find((column) => column.id === columnId);
        if (!target) {
          continue;
        }
        await repository.updateColumn(columnId, { type: choice });
        const currentRows = (await repository.getRows()).filter((row) => row.deleted !== true);
        const values = currentRows.map((row) => row.data[columnId]);
        const { nextValues } = convertColumnDateValues(values);
        let index = 0;
        for (const row of currentRows) {
          const next = nextValues[index];
          index += 1;
          if (next !== row.data[columnId]) {
            await repository.updateRow(row.id, { [columnId]: next });
          }
        }
        // Report only over non-empty cells: empty cells are not "kept as
        // text", they simply have no value.
        const report = convertColumnDateValues(values.filter((value) => value !== '' && value != null));
        if (report.converted > 0) {
          conversionNotes.push(
            `Converted ${report.converted} of ${report.nextValues.length} values in “${target.name}” to dates`
            + (report.kept > 0 ? ` (${report.kept} kept as text)` : ''),
          );
        }
      }

      // The in-memory `columns` list still carries the pre-conversion types;
      // pass the updated list so imported values for converted columns are
      // normalised to ISO exactly like any other date column.
      const importColumns = columns.map((column) => {
        const choice = importConversions[column.id];
        return choice && choice !== 'keep' ? { ...column, type: choice } : column;
      });
      const result = await parseImportRows(sourceFile, {
        role,
        columns: importColumns,
        fileName: sourceFileName ?? preview.fileName,
        actor: actor ? { id: actor.id, name: actor.name ?? actor.email } : undefined,
        createColumn,
        newColumnTypes: importColumnTypes,
      });
      const records: SheetImportRecord[] = result.records.map((record) => ({
        data: record.data,
        sourceRowNumber: record.sourceRowNumber,
      }));
      const repositoryOptions = {
        ...actorOptions(actor),
        fileName: sourceFileName ?? preview.fileName,
      };
      if (repository.importRows) {
        await repository.importRows(records, repositoryOptions);
      } else {
        for (const record of records) {
          await repository.createRow(record.data, record.category ?? null);
        }
      }
      setPreview(null);
      setSourceFile(null);
      setSourceFileName(null);
      setImportColumnTypes({});
      setImportConversions({});
      await refresh();
      onRepositoryChanged?.();
      const importedMessage = `Imported ${records.length} mapped ${records.length === 1 ? 'record' : 'records'}.`;
      setStatus(conversionNotes.length > 0 ? `${importedMessage} ${conversionNotes.join(' ')}` : importedMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to import records.');
    } finally {
      setBusy(false);
    }
  };

  const openReport = async () => {
    if (!(await ensureSnapshotLoaded())) {
      setError('The sheet data could not be loaded, so the report was not opened.');
      return;
    }
    setReportOpen(true);
  };

  const handlePrint = (model: PrintReportModel) => {
    if (onPrint) {
      onPrint(model);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      try {
        window.print();
      } catch {
        // Printing is a best-effort browser capability; the report remains
        // available in the modal when a host blocks the print dialog.
      }
    }
  };

  const handlePdf = (model: PrintReportModel) => {
    exportReportToPdf(model, {
      role,
      save: onSavePdf ?? saveArtifactWithBrowserFallback,
    });
  };

  if (!can(role, 'export') && !can(role, 'import') && !can(role, 'print')) {
    return null;
  }

  return (
    <>
      <section className="sheet-tools" aria-label="Admin sheet actions" ref={toolsRef}>
        <button
          className="sheet-tools__button"
          type="button"
          aria-haspopup="menu"
          aria-expanded={toolsOpen}
          disabled={busy}
          onClick={() => setToolsOpen((open) => !open)}
        >
          Tools <span aria-hidden="true">▾</span>
        </button>
        {toolsOpen ? (
          <div className="sheet-tools__menu" role="menu" aria-label="Sheet tools">
            {can(role, 'import') ? (
              <button
                className="sheet-tools__item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setToolsOpen(false);
                  fileInput.current?.click();
                }}
              >
                Import file
              </button>
            ) : null}
            {can(role, 'export') ? (
              <>
                <button
                  className="sheet-tools__item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setToolsOpen(false);
                    void exportRows('csv');
                  }}
                >
                  Export CSV
                </button>
                <button
                  className="sheet-tools__item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setToolsOpen(false);
                    void exportRows('xlsx');
                  }}
                >
                  Export Excel
                </button>
              </>
            ) : null}
            {can(role, 'print') ? (
              <button
                className="sheet-tools__item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setToolsOpen(false);
                  void openReport();
                }}
              >
                Print / PDF report
              </button>
            ) : null}
            <p className="sheet-tools__note">
              Exported files contain sensitive data. Protect them and delete them when no longer needed.
            </p>
          </div>
        ) : null}
        <input
          ref={fileInput}
          className="admin-file-input"
          aria-label="Import CSV or Excel file"
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          onChange={(event) => void onFileChange(event)}
        />
        {loading ? <span className="sheet-tools__loading">Loading…</span> : null}
        {error ? <p className="admin-inline-message admin-inline-message--error" role="alert">{error}</p> : null}
        {status ? <p className="admin-inline-message" role="status">{status}</p> : null}
      </section>

      {preview ? (
        <ImportPreviewDialog
          preview={preview}
          importing={busy}
          onClose={() => {
            setPreview(null);
            setSourceFile(null);
            setSourceFileName(null);
          }}
          onImport={() => void confirmImport()}
          columnTypes={importColumnTypes}
          onColumnTypeChange={(header, type) => setImportColumnTypes((current) => ({ ...current, [header]: type }))}
          conversions={importConversions}
          onConversionChange={(columnId, choice) => setImportConversions((current) => ({ ...current, [columnId]: choice }))}
        />
      ) : null}

      <PrintReportModal
        open={reportOpen}
        rows={activeRows(rows)}
        columns={columns}
        role={role}
        onClose={() => setReportOpen(false)}
        onPrint={handlePrint}
        onExportPdf={handlePdf}
      />
    </>
  );
}

export function AdminRecycleBinPanel({
  repository: providedRepository,
  role,
  actor,
  onRepositoryChanged,
  refreshToken = 0,
}: AdminToolsProps) {
  const repository = useMemo(
    () => providedRepository ?? createInMemorySheetRepository(),
    [providedRepository],
  );
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    { kind: 'restore' | 'permanent-delete'; row: SheetRow } | null
  >(null);

  const refresh = useCallback(async () => {
    try {
      const [nextRows, nextColumns] = await Promise.all([
        repository.getRows(),
        repository.getColumns(),
      ]);
      setRows(nextRows);
      setColumns(nextColumns);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the recycle bin.');
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
    void refresh();
  }, [refreshToken, refresh]);

  /**
   * SET-11 / R2-14 — restore and permanent delete confirm in an in-app dialog
   * (red button for the destructive action, Cancel as the safe default, Esc
   * closes, no double submit, failure stays visible) instead of a native
   * window.confirm.
   */
  const askRestore = (row: SheetRow) => {
    if (busyRowId) {
      return;
    }
    setError(null);
    setPendingAction({ kind: 'restore', row });
  };

  const askPermanentDelete = (row: SheetRow) => {
    if (busyRowId) {
      return;
    }
    setError(null);
    setPendingAction({ kind: 'permanent-delete', row });
  };

  const confirmPendingAction = async () => {
    const pending = pendingAction;
    if (!pending || busyRowId) {
      return;
    }
    const label = displayRowLabel(pending.row, columns);
    if (pending.kind === 'restore' && !repository.restoreRow) {
      setError('This repository does not support restoring rows.');
      return;
    }
    if (pending.kind === 'permanent-delete' && !repository.permanentDeleteRow) {
      setError('This repository does not support permanent deletion.');
      return;
    }
    setBusyRowId(pending.row.id);
    setStatus(null);
    try {
      if (pending.kind === 'restore') {
        await repository.restoreRow!(pending.row.id, actorOptions(actor));
        setStatus(`Restored ${label}.`);
      } else {
        await repository.permanentDeleteRow!(pending.row.id, actorOptions(actor));
        setStatus(`Permanently deleted ${label}.`);
      }
      await refresh();
      onRepositoryChanged?.();
      setPendingAction(null);
    } catch (caught) {
      // The row must remain visible (and the dialog open) until the operation
      // has actually succeeded.
      setError(
        caught instanceof Error
          ? caught.message
          : pending.kind === 'restore'
            ? 'Unable to restore the row.'
            : 'Unable to permanently delete the row.',
      );
    } finally {
      setBusyRowId(null);
    }
  };

  if (!can(role, 'recycleBin')) {
    return null;
  }

  return (
    <div className="admin-panel">
      {error ? <p className="admin-inline-message admin-inline-message--error" role="alert">{error}</p> : null}
      {status ? <p className="admin-inline-message" role="status">{status}</p> : null}
      <RecycleBinPage
        role={role}
        rows={rows}
        columns={columns}
        onRestore={askRestore}
        onPermanentDelete={askPermanentDelete}
      />
      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.kind === 'restore' ? 'Restore this record?' : 'Permanently delete this record?'}
        confirmLabel={pendingAction?.kind === 'restore' ? 'Restore' : 'Delete permanently'}
        destructive={pendingAction?.kind !== 'restore'}
        busy={busyRowId !== null}
        error={error}
        onConfirm={confirmPendingAction}
        onCancel={() => {
          if (busyRowId === null) {
            setPendingAction(null);
          }
        }}
      >
        {pendingAction ? (
          pendingAction.kind === 'restore' ? (
            <p>{displayRowLabel(pendingAction.row, columns)} returns to the active sheet.</p>
          ) : (
            <p>
              {displayRowLabel(pendingAction.row, columns)} is removed for good.
              This cannot be undone.
            </p>
          )
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

export function AdminAuditLogPanel({
  repository: providedRepository,
  role,
  profiles = [],
  actorLabel,
  remoteClient,
}: AdminToolsProps & {
  profiles?: readonly AuditProfile[];
  /** Signed-in administrator name used in the clear-audit entry (R2-10). */
  actorLabel?: string | null;
  /** Supabase client used for the admin-only `clear_audit_log` RPC (R2-10). */
  remoteClient?: AuditClearRemoteClient | null;
}) {
  const repository = useMemo(
    () => providedRepository ?? createInMemorySheetRepository(),
    [providedRepository],
  );
  const [entries, setEntries] = useState<SheetAuditEntry[]>([]);
  const [auditColumns, setAuditColumns] = useState<ColumnDefinition[]>([]);
  const [auditRows, setAuditRows] = useState<SheetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!repository.getAuditHistory) {
        setEntries([]);
        return;
      }
      const [historyResult, columnsResult, rowsResult] = await Promise.allSettled([
        repository.getAuditHistory(),
        repository.getColumns(),
        repository.getRows(),
      ]);
      if (!mounted) {
        return;
      }
      if (columnsResult.status === 'fulfilled') {
        setAuditColumns(columnsResult.value);
      }
      if (rowsResult.status === 'fulfilled') {
        setAuditRows(rowsResult.value);
      }
      if (historyResult.status === 'fulfilled') {
        setEntries(historyResult.value);
        setError(null);
      } else {
        setError(
          historyResult.reason instanceof Error
            ? historyResult.reason.message
            : 'Unable to load the audit log.',
        );
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [repository]);

  if (!can(role, 'auditLog')) {
    return null;
  }

  const clearAuditLog = async () => {
    if (!isAuditClearConfirmation(confirmation) || clearing) {
      return;
    }
    const message = auditClearMessage((actorLabel ?? '').trim() || 'Admin');
    setClearing(true);
    setError(null);
    setStatus(null);
    let remoteCleared = false;
    try {
      // R3 batch C: remote first, and only through the admin RPC. If the
      // server refuses (Office caller, offline, migration not run) nothing is
      // removed locally, so the mirror keeps matching the server and a retry
      // cannot erase history that was already cleared.
      await clearRemoteAuditLog(remoteClient ?? null, message);
      remoteCleared = true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to clear the audit log.');
      setClearing(false);
      return;
    }

    try {
      if (repository.clearAuditLog) {
        setEntries(await repository.clearAuditLog(message));
      } else {
        setEntries([]);
      }
      setStatus(message);
      setConfirmingClear(false);
      setConfirmation('');
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : 'unknown error';
      // Be explicit about the half-done state instead of implying nothing
      // happened: the server log is gone, only this PC's copy is stale.
      setError(
        remoteCleared
          ? `The server audit log was cleared, but this PC's copy could not be updated (${reason}). Sync again to refresh it.`
          : reason,
      );
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="admin-panel">
      {error ? <p className="admin-inline-message admin-inline-message--error" role="alert">{error}</p> : null}
      {status ? <p className="admin-inline-message" role="status">{status}</p> : null}
      <div className="admin-panel__toolbar">
        <button
          className="button button--danger"
          type="button"
          onClick={() => {
            setConfirmation('');
            setConfirmingClear(true);
          }}
        >
          Clear audit log
        </button>
      </div>
      <AuditLogPage
        role={role}
        entries={entries}
        profiles={profiles}
        columns={auditColumns}
        rows={auditRows}
      />
      {confirmingClear ? (
        <div
          className="admin-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !clearing) {
              setConfirmingClear(false);
            }
          }}
        >
          <div className="admin-dialog" role="dialog" aria-modal="true" aria-label="Clear audit log">
            <h2>Clear the audit log?</h2>
            <p>
              {entries.length > 0
                ? `All ${entries.length} recorded ${entries.length === 1 ? 'action' : 'actions'} will be permanently removed for every PC.`
                : 'The audit log is cleared for every PC.'} One entry recording
              this clear stays in the log. This cannot be undone.
            </p>
            <p className="admin-dialog__hint">
              Clearing happens on the server first, in one transaction, so a
              failure leaves the log untouched.
            </p>
            <p className="admin-dialog__hint">
              Type <strong>{AUDIT_CLEAR_CONFIRMATION}</strong> to confirm.
            </p>
            <input
              aria-label="Type DELETE to confirm"
              autoFocus
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setConfirmingClear(false);
                }
                if (event.key === 'Enter') {
                  void clearAuditLog();
                }
              }}
            />
            <div className="admin-dialog__actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={clearing}
                onClick={() => setConfirmingClear(false)}
              >
                Cancel
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={clearing || !isAuditClearConfirmation(confirmation)}
                onClick={() => void clearAuditLog()}
              >
                {clearing ? 'Clearing…' : 'Clear audit log'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default AdminSheetActions;
