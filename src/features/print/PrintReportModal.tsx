import { useMemo, useState } from 'react';

import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import {
  buildPrintReportModel,
  normalizeReportFilter,
  REPORT_FILTERS,
  type PrintReportModel,
  type ReportFilterId,
} from './print-service';
import type { ColumnDefinition } from '../../lib/columns';
import type { SheetRow } from '../sheet/types';

export interface PrintReportModalProps {
  open?: boolean;
  model?: PrintReportModel;
  rows?: readonly SheetRow[];
  columns?: readonly ColumnDefinition[];
  role?: Role | string | null;
  filter?: ReportFilterId;
  selectedColumnIds?: readonly string[];
  today?: string | Date;
  onClose?: () => void;
  /** The host decides how/where to invoke printing. */
  onPrint?: (model: PrintReportModel) => void;
  /** The host decides how/where to save generated PDF bytes. */
  onExportPdf?: (model: PrintReportModel) => void;
}

function valueForRow(row: PrintReportModel['rows'][number], id: string): string {
  if (id === 'daysLeft') {
    return row.daysLeft === null ? '—' : String(row.daysLeft);
  }
  const value = row.values[id];
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

export interface PrintReportViewProps {
  model: PrintReportModel;
}

/** Render-only report view that can be placed in a modal or print stylesheet. */
export function PrintReportView({ model }: PrintReportViewProps) {
  return (
    <div className="print-report-view" aria-label="Report preview">
      <p>Generated {model.generatedAt} · {model.page.totalRows} rows</p>
      <table>
        <thead><tr>{model.columns.map((column) => <th key={column.id}>{column.name}</th>)}</tr></thead>
        <tbody>
          {model.rows.map((row) => (
            <tr key={row.id}>
              {model.columns.map((column) => <td key={column.id}>{valueForRow(row, column.id)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PrintReportModal({
  open = false,
  model: providedModel,
  rows,
  columns,
  role,
  filter: initialFilter,
  selectedColumnIds: initialSelectedColumnIds,
  today,
  onClose,
  onPrint,
  onExportPdf,
}: PrintReportModalProps) {
  const [filter, setFilter] = useState<ReportFilterId>(
    normalizeReportFilter(initialFilter ?? providedModel?.filter),
  );
  const defaultColumnIds = providedModel?.columns
    .filter((column) => !column.generated)
    .map((column) => column.id)
    ?? columns?.filter((column) => column.deleted !== true).map((column) => column.id)
    ?? [];
  const [selectedColumnIds, setSelectedColumnIds] = useState<string[]>(
    [...(initialSelectedColumnIds ?? defaultColumnIds)],
  );
  const hasPrintAccess = can(role, 'print');

  const derivedModel = useMemo(() => {
    if (hasPrintAccess && rows && columns) {
      return buildPrintReportModel(rows, columns, {
        role,
        filter,
        selectedColumnIds,
        today,
      });
    }
    return providedModel ?? null;
  }, [columns, filter, hasPrintAccess, providedModel, role, rows, selectedColumnIds, today]);

  if (!open) {
    return null;
  }

  if (!hasPrintAccess) {
    return (
      <div className="print-report-modal" role="alert">
        Only administrators can print or export reports.
      </div>
    );
  }

  if (!derivedModel) {
    return (
      <div className="print-report-modal" role="dialog" aria-label="Print report" aria-modal="true">
        <p>No report data is available.</p>
        <button type="button" onClick={() => onClose?.()}>Close</button>
      </div>
    );
  }

  const pickerColumns = derivedModel.availableColumns;
  return (
    <div className="print-report-modal" role="dialog" aria-label="Print report" aria-modal="true">
      <div className="print-report-modal__header">
        <div>
          <p>DKS admin report</p>
          <h2>{derivedModel.header}</h2>
          <p>{derivedModel.filterSummary}</p>
        </div>
        <button type="button" aria-label="Close print report" onClick={() => onClose?.()}>Close</button>
      </div>

      <div className="print-report-modal__controls">
        <label>
          Filter
          <select
            aria-label="Report filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as ReportFilterId)}
          >
            {REPORT_FILTERS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <fieldset aria-label="Report columns">
          <legend>Columns</legend>
          {pickerColumns.map((column) => (
            <label key={column.id}>
              <input
                type="checkbox"
                checked={selectedColumnIds.includes(column.id)}
                onChange={() => setSelectedColumnIds((current) => (
                  current.includes(column.id)
                    ? current.filter((id) => id !== column.id)
                    : [...current, column.id]
                ))}
              />
              {column.name}
            </label>
          ))}
          <label>
            <input type="checkbox" checked disabled />
            Days Left (ascending)
          </label>
        </fieldset>
      </div>

      <PrintReportView model={derivedModel} />

      <div className="print-report-modal__actions">
        <button type="button" onClick={() => onPrint?.(derivedModel)}>Print report</button>
        <button type="button" onClick={() => onExportPdf?.(derivedModel)}>Export PDF</button>
      </div>
    </div>
  );
}

export default PrintReportModal;
