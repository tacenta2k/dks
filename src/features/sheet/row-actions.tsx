import type { ICellRendererParams } from 'ag-grid-community';
import type { SheetRow } from './types';

export interface SheetGridRendererData {
  __rowId: string;
  __sheetRow: SheetRow;
  __rowLabel: string;
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

/** Small, keyboard-accessible renderer kept before the locked Days Left column. */
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
        Duplicate
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
        Delete
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
        Renew
      </button>
    </div>
  );
}

export function RowActionsCell(
  params: ICellRendererParams<SheetGridRendererData> & { context?: RowActionsContext },
) {
  const data = params.data;
  const context = params.context;
  if (!data || !context) {
    return null;
  }

  return (
    <RowActions
      row={data.__sheetRow}
      rowLabel={data.__rowLabel}
      onDuplicate={context.onDuplicate}
      onDelete={context.onDelete}
      onRenew={context.onRenew}
    />
  );
}
