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
  importRows as parseImportRows,
  previewImport,
  type ImportActor,
  type ImportPreview,
  type ImportSource,
} from '../import-export/import-service';
import { AuditLogPage, type AuditProfile } from '../audit/AuditLogPage';
import { PrintReportModal } from '../print/PrintReportModal';
import {
  exportReportToPdf,
  type PdfExportFile,
  type PrintReportModel,
} from '../print/print-service';
import { RecycleBinPage } from '../recycle-bin/RecycleBinPage';
import {
  createInMemorySheetRepository,
  type SheetRepository,
} from '../sheet/repository';
import type {
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

function isConfirmed(message: string): boolean {
  return typeof window === 'undefined' || typeof window.confirm !== 'function'
    ? true
    : window.confirm(message);
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
}: {
  preview: ImportPreview;
  onClose: () => void;
  onImport: () => void;
  importing: boolean;
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
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sourceFile, setSourceFile] = useState<ImportSource | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextColumns, nextRows] = await Promise.all([
        repository.getColumns(),
        repository.getRows(),
      ]);
      setColumns(nextColumns);
      setRows(nextRows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load admin sheet actions.');
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveExport = onSaveExport ?? saveArtifactWithBrowserFallback;

  const exportRows = async (format: AdminExportFormat) => {
    if (!can(role, 'export')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const artifact = format === 'xlsx'
        ? createXlsxExport({ role, rows: activeRows(rows), columns })
        : createCsvExport({ role, rows: activeRows(rows), columns });
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
      const source = await importSourceForFile(file);
      const nextPreview = await previewImport(source, { role, columns, fileName: file.name });
      setSourceFile(source);
      setSourceFileName(file.name);
      setPreview(nextPreview);
      setStatus(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to preview the import file.');
    } finally {
      setBusy(false);
    }
  };

  const createColumn = useCallback(async (header: string) => {
    try {
      return await repository.addColumn({ name: header, type: 'text' });
    } catch {
      return null;
    }
  }, [repository]);

  const confirmImport = async () => {
    if (!sourceFile || !preview || !can(role, 'import')) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await parseImportRows(sourceFile, {
        role,
        columns,
        fileName: sourceFileName ?? preview.fileName,
        actor: actor ? { id: actor.id, name: actor.name ?? actor.email } : undefined,
        createColumn,
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
      await refresh();
      onRepositoryChanged?.();
      setStatus(`Imported ${records.length} mapped ${records.length === 1 ? 'record' : 'records'}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to import records.');
    } finally {
      setBusy(false);
    }
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
      <section className="admin-sheet-actions" aria-label="Admin sheet actions">
        <div className="admin-sheet-actions__heading">
          <div>
            <p className="admin-eyebrow">Administrator tools</p>
            <h2>Manage records</h2>
          </div>
          {loading ? <span className="admin-sheet-actions__loading">Loading…</span> : null}
        </div>
        <div className="admin-sheet-actions__buttons">
           {can(role, 'export') ? (
             <>
               <p className="admin-inline-message admin-inline-message--warning">
                 Exported files contain sensitive data. Protect them and delete them when no longer needed.
               </p>
               <button className="button button--quiet" type="button" disabled={busy} onClick={() => void exportRows('csv')}>
                Export CSV
              </button>
              <button className="button button--quiet" type="button" disabled={busy} onClick={() => void exportRows('xlsx')}>
                Export Excel
              </button>
            </>
          ) : null}
          {can(role, 'import') ? (
            <>
              <button className="button button--quiet" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
                Import file
              </button>
              <input
                ref={fileInput}
                className="admin-file-input"
                aria-label="Import CSV or Excel file"
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                onChange={(event) => void onFileChange(event)}
              />
            </>
          ) : null}
          {can(role, 'print') ? (
            <button className="button button--quiet" type="button" onClick={() => setReportOpen(true)}>
              Print
            </button>
          ) : null}
        </div>
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

  const restore = async (row: SheetRow) => {
    if (busyRowId) {
      return;
    }
    if (!isConfirmed(`Restore ${displayRowLabel(row, columns)} to the active sheet?`)) {
      return;
    }
    if (!repository.restoreRow) {
      setError('This repository does not support restoring rows.');
      return;
    }
    setBusyRowId(row.id);
    setStatus(null);
    try {
      await repository.restoreRow(row.id, actorOptions(actor));
      await refresh();
      onRepositoryChanged?.();
      setStatus(`Restored ${displayRowLabel(row, columns)}.`);
    } catch (caught) {
      // The row must remain visible in the Recycle Bin until the restore has
      // actually succeeded.
      setError(caught instanceof Error ? caught.message : 'Unable to restore the row.');
    } finally {
      setBusyRowId(null);
    }
  };

  const permanentDelete = async (row: SheetRow) => {
    if (busyRowId) {
      return;
    }
    if (!isConfirmed(`Permanently delete ${displayRowLabel(row, columns)}? This cannot be undone.`)) {
      return;
    }
    if (!repository.permanentDeleteRow) {
      setError('This repository does not support permanent deletion.');
      return;
    }
    setBusyRowId(row.id);
    setStatus(null);
    try {
      await repository.permanentDeleteRow(row.id, actorOptions(actor));
      await refresh();
      onRepositoryChanged?.();
      setStatus(`Permanently deleted ${displayRowLabel(row, columns)}.`);
    } catch (caught) {
      // Never hide the record when deletion failed; surface the real error.
      setError(caught instanceof Error ? caught.message : 'Unable to permanently delete the row.');
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
        onRestore={restore}
        onPermanentDelete={permanentDelete}
      />
    </div>
  );
}

export function AdminAuditLogPanel({
  repository: providedRepository,
  role,
  profiles = [],
}: AdminToolsProps & { profiles?: readonly AuditProfile[] }) {
  const repository = useMemo(
    () => providedRepository ?? createInMemorySheetRepository(),
    [providedRepository],
  );
  const [entries, setEntries] = useState<SheetAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!repository.getAuditHistory) {
        setEntries([]);
        return;
      }
      try {
        const history = await repository.getAuditHistory();
        if (mounted) {
          setEntries(history);
          setError(null);
        }
      } catch (caught) {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : 'Unable to load the audit log.');
        }
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

  return (
    <div className="admin-panel">
      {error ? <p className="admin-inline-message admin-inline-message--error" role="alert">{error}</p> : null}
      <AuditLogPage role={role} entries={entries} profiles={profiles} />
    </div>
  );
}

export default AdminSheetActions;
