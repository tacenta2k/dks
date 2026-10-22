import type { ColDef } from 'ag-grid-community';
import type { SheetGridRendererData } from './row-actions';

/**
 * FIXES_UI §5.5 (SHEET-10): the compact `+` add-column header. Pinned before
 * Days Left, it opens Column Setup when clicked. It is intentionally not a
 * data column: no field, no sort/filter/drag, and blank body cells.
 */
export interface AddColumnHeaderParams {
  onAddColumn?: () => void;
}

export function AddColumnHeader(params: AddColumnHeaderParams) {
  return (
    <button
      type="button"
      className="sheet-add-column-header"
      aria-label="Add column"
      title="Add column"
      onClick={(event) => {
        event.stopPropagation();
        params.onAddColumn?.();
      }}
    >
      +
    </button>
  );
}

/** Blank body cell so the `+` column has an empty body (FIXES_UI §5.5). */
export function AddColumnBlankCell(): null {
  return null;
}

export type AddColumnColDef = ColDef<SheetGridRendererData>;
