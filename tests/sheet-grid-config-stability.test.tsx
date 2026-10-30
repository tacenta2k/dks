/**
 * H2 regression: the AG Grid configuration SheetPage hands to AgGridReact.
 *
 * ag-grid-react diffs its props by reference, and a new `defaultColDef`
 * object sends AG Grid through `recreateColumnDefs()` — a full column-tree
 * rebuild — on every parent render (an unrelated sync refresh, a toolbar
 * keystroke). `postSortRows` has the same cost for the sort stage, and
 * `getRowClass` triggers a row-CSS post-process. Those four, plus `getRowId`,
 * `isFullWidthRow` and `onGridReady`, are asserted here.
 *
 * `getContextMenuItems` and `onCellValueChanged` are deliberately NOT
 * asserted: they close over the current row handlers, so their identity
 * follows the data on purpose. AG Grid only reads them when a menu opens or a
 * cell commits — neither is a column-tree trigger.
 *
 * jsdom has no grid layout, so the wiring test captures the REAL props
 * SheetPage passes and re-renders the page the way background refreshes do.
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository, type SheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

const gridCapture = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('ag-grid-react', () => ({
  AgGridReact: (props: Record<string, unknown>) => {
    gridCapture.props = props;
    return <div data-testid="mock-ag-grid" />;
  },
}));

async function seededRepository(): Promise<SheetRepository> {
  const repository = createInMemorySheetRepository();
  await seedFixtureColumns(repository);
  await repository.createRow({ name: 'Ada Lovelace', passport_no: 'A-1', country: 'UK', visa_expiry: '2027-01-02' });
  await repository.createRow({ name: 'Grace Hopper', passport_no: 'B-2', country: 'US', visa_expiry: '2099-12-31' });
  return repository;
}

function currentProps(): Record<string, unknown> {
  const props = gridCapture.props;
  expect(props, 'AgGridReact should have been rendered').not.toBeNull();
  return props as Record<string, unknown>;
}

describe('visa sheet grid configuration', () => {
  beforeEach(() => {
    gridCapture.props = null;
  });

  it('keeps defaultColDef and the other render-independent props referentially stable across rerenders', async () => {
    const repository = await seededRepository();
    const { rerender } = render(
      <SheetPage repository={repository} role="admin" refreshToken={0} renderGridInTests />,
    );

    await waitFor(() => expect(gridCapture.props).not.toBeNull(), { timeout: 10_000 });
    const first = currentProps();
    const firstConfig = {
      defaultColDef: first.defaultColDef,
      getRowId: first.getRowId,
      getRowClass: first.getRowClass,
      isFullWidthRow: first.isFullWidthRow,
      onGridReady: first.onGridReady,
      postSortRows: first.postSortRows,
    };
    expect(firstConfig.defaultColDef).toEqual({
      flex: 1,
      minWidth: 120,
      resizable: true,
      sortable: true,
      editable: true,
    });

    // A background refresh: the shell bumps refreshToken after a sync. The
    // page re-renders and re-reads the repository; the grid config must not
    // change identity, or AG Grid rebuilds every column (and drops editors).
    rerender(<SheetPage repository={repository} role="admin" refreshToken={1} renderGridInTests />);
    await waitFor(() => expect(gridCapture.props).not.toBe(first));

    const second = currentProps();
    expect(second.defaultColDef).toBe(firstConfig.defaultColDef);
    expect(second.getRowId).toBe(firstConfig.getRowId);
    expect(second.getRowClass).toBe(firstConfig.getRowClass);
    expect(second.isFullWidthRow).toBe(firstConfig.isFullWidthRow);
    expect(second.onGridReady).toBe(firstConfig.onGridReady);
    expect(second.postSortRows).toBe(firstConfig.postSortRows);
    // Same edit path still wired: a changed callback is a callback swap, not a
    // column rebuild.
    expect(typeof second.getContextMenuItems).toBe('function');
    expect(typeof second.onCellValueChanged).toBe('function');
  });

  it('drives search through the real grid rowData, not the jsdom table', async () => {
    const repository = await seededRepository();
    const { getByLabelText } = render(
      <SheetPage repository={repository} role="admin" refreshToken={0} renderGridInTests />,
    );

    await waitFor(() => expect(gridCapture.props).not.toBeNull(), { timeout: 10_000 });
    const rowIds = () => (currentProps().rowData as { __rowId: string }[]).map((row) => row.__rowId);
    expect(rowIds().length).toBeGreaterThanOrEqual(2);

    fireEvent.change(getByLabelText('Search records'), { target: { value: 'Grace' } });

    await waitFor(() => {
      const rendered = currentProps().rowData as { __sheetRow?: { data?: { name?: string } } }[];
      const names = rendered.map((row) => row.__sheetRow?.data?.name).filter(Boolean);
      expect(names).toContain('Grace Hopper');
      expect(names).not.toContain('Ada Lovelace');
    });
  });
});
