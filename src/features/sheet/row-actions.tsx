import type { ICellRendererParams } from 'ag-grid-community';
import type { SheetRow } from './types';

export interface SheetGridRendererData {
  __rowId: string;
  /** Absent on synthetic rows (group headers, the draft row). */
  __sheetRow?: SheetRow;
  __rowLabel?: string;
  /** Set on a Group-by header row (SHEET-04). */
  __groupHeader?: string;
  __rowCount?: number;
  daysLeft: number | null;
  status: string | null;
  [key: string]: unknown;
}

export interface RowActionsContext {
  onDuplicate: (row: SheetRow) => void | Promise<void>;
  onDelete: (row: SheetRow) => void | Promise<void>;
  onRenew: (row: SheetRow) => void;
}

export interface RowActionsProps {
  row: SheetRow;
  rowLabel: string;
  onDuplicate: (row: SheetRow) => void | Promise<void>;
  onDelete: (row: SheetRow) => void | Promise<void>;
  onRenew: (row: SheetRow) => void;
}

function stopPropagation(event: React.MouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
}

function ActionIcon({ kind }: { kind: 'duplicate' | 'delete' | 'renew' }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false as const,
  };
  if (kind === 'duplicate') {
    return (
      <svg {...common}>
        <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
        <path d="M15.5 8.5V6.9A2.4 2.4 0 0 0 13.1 4.5H6.9A2.4 2.4 0 0 0 4.5 6.9v6.2a2.4 2.4 0 0 0 2.4 2.4h1.6" />
      </svg>
    );
  }
  if (kind === 'delete') {
    return (
      <svg {...common}>
        <path d="M5 7.5h14" />
        <path d="M9.8 7.5V5.6h4.4v1.9" />
        <path d="M7 7.5l.9 11.4h8.2L17 7.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4.8 12a7.2 7.2 0 1 0 2.3-5.3" />
      <path d="M4.5 4.8v4.4h4.4" />
    </svg>
  );
}

/**
 * USER DECISION (R2-09) — the Actions column stays, but compact: three
 * icon-only 24px buttons (duplicate / delete / renew) with tooltips, sized to
 * fit inside the row without overflowing.
 */
export function RowActions({
  row,
  rowLabel,
  onDuplicate,
  onDelete,
  onRenew,
}: RowActionsProps) {
  return (
    <div className="sheet-row-actions" aria-label={`Actions for ${rowLabel}`}>
      <button
        className="sheet-row-actions__button"
        type="button"
        aria-label={`Duplicate row ${rowLabel}`}
        title="Duplicate row"
        onClick={(event) => {
          stopPropagation(event);
          void onDuplicate(row);
        }}
      >
        <ActionIcon kind="duplicate" />
      </button>
      <button
        className="sheet-row-actions__button"
        type="button"
        aria-label={`Delete row ${rowLabel}`}
        title="Delete row"
        onClick={(event) => {
          stopPropagation(event);
          void onDelete(row);
        }}
      >
        <ActionIcon kind="delete" />
      </button>
      <button
        className="sheet-row-actions__button sheet-row-actions__button--renew"
        type="button"
        aria-label={`Mark renewed for ${rowLabel}`}
        title="Mark renewed"
        onClick={(event) => {
          stopPropagation(event);
          onRenew(row);
        }}
      >
        <ActionIcon kind="renew" />
      </button>
    </div>
  );
}

export function RowActionsCell(
  params: ICellRendererParams<SheetGridRendererData> & { context?: RowActionsContext },
) {
  const data = params.data;
  const context = params.context;
  if (!data || !data.__sheetRow || !context) {
    return null;
  }

  return (
    <RowActions
      row={data.__sheetRow}
      rowLabel={data.__rowLabel ?? data.__rowId}
      onDuplicate={context.onDuplicate}
      onDelete={context.onDelete}
      onRenew={context.onRenew}
    />
  );
}
