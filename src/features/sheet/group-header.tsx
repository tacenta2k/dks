import type { ICellRendererParams } from 'ag-grid-community';

import type { SheetGridRendererData } from './row-actions';

/**
 * Full-width Group-by header (SHEET-04). Rendered for synthetic rows only;
 * it is not a record, so it has no row actions and is excluded from exports,
 * counts, print and sync.
 */
export function GroupHeaderCell(params: ICellRendererParams<SheetGridRendererData>) {
  const label = params.data?.__groupHeader;
  if (!label) {
    return null;
  }
  const count = typeof params.data?.__rowCount === 'number' ? params.data.__rowCount : null;
  return (
    <div className="sheet-group-header" role="rowheader" aria-label={`Group ${label}`}>
      <span className="sheet-group-header__label">{label}</span>
      {count !== null ? <span className="sheet-group-header__count">{count}</span> : null}
    </div>
  );
}

export default GroupHeaderCell;
