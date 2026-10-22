/**
 * F2 end-to-end regression: the REAL AG Grid used by SheetPage must open the
 * DD/MM/YYYY date editor with progressive slash masking while typing, and the
 * typed date must COMMIT (this failed before: AG Grid v32's reactive custom
 * component proxy only commits values reported through `onValueChange`).
 *
 * This test mounts the actual AgGridReact with the actual buildGridColumns
 * output — the exact configuration the packaged app renders.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildGridColumns, buildGridRows } from '../src/features/sheet/grid-columns';
import type { SheetRow } from '../src/features/sheet/types';

beforeAll(() => {
  // AG Grid needs layout metrics that jsdom does not provide.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return Number(this.getAttribute('data-mock-width') ?? 800);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return Number(this.getAttribute('data-mock-height') ?? 600);
    },
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  window.HTMLElement.prototype.scrollTo = window.HTMLElement.prototype.scrollTo ?? (() => undefined);
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView ?? (() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const columns = [
  { id: 'name', name: 'Full Name', type: 'text', position: 0 },
  { id: 'visa_expiry', name: 'Visa expiry', type: 'date_expiry', position: 1, isPrimaryExpiry: true },
] as never;

const sourceRows: SheetRow[] = [
  { id: 'row-1', data: { name: 'Ahmed', visa_expiry: '2026-06-01' }, category: 'Employee', deleted: false },
];

function mountGrid(onCellValueChanged?: (event: unknown) => void) {
  const { rows } = buildGridRows(sourceRows, columns as never);
  const defs = buildGridColumns(columns as never, {
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onRenew: vi.fn(),
  }, 'admin') as ColDef[];

  return render(
    <div style={{ width: '900px', height: '500px' }}>
      <AgGridReact
        rowData={rows}
        columnDefs={defs}
        defaultColDef={{ flex: 1, minWidth: 120, resizable: true, sortable: true, editable: true }}
        getRowId={(params) => params.data.__rowId}
        onCellValueChanged={(event) => onCellValueChanged?.(event)}
      />
    </div>,
  );
}

async function openDateEditor(onCellValueChanged?: (event: unknown) => void): Promise<HTMLInputElement> {
  mountGrid(onCellValueChanged);
  const grid = document.querySelector('.ag-root') as HTMLElement;
  expect(grid).toBeTruthy();
  const cell = grid.querySelector('.ag-cell[col-id="visa_expiry"]') as HTMLElement;
  expect(cell).toBeTruthy();
  fireEvent.doubleClick(cell);
  const input = await screen.findByLabelText('Date (DD/MM/YYYY)');
  return input as HTMLInputElement;
}

describe('grid date editor end-to-end (F2)', () => {
  it('opens the DD/MM/YYYY editor (not the plain text editor) for date cells', async () => {
    const input = await openDateEditor();
    // If AG Grid fell back to agTextCellEditor, this input would not exist.
    expect(input).toBeInTheDocument();
    // The initial value must be displayed as DD/MM/YYYY.
    expect(input).toHaveValue('01/06/2026');
  }, 15_000);

  it('auto-inserts slashes progressively while typing 10012004', async () => {
    const input = await openDateEditor();
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '10' } });
    expect(input).toHaveValue('10/');
    fireEvent.change(input, { target: { value: '10/0' } });
    fireEvent.change(input, { target: { value: '10/01' } });
    expect(input).toHaveValue('10/01/');
    fireEvent.change(input, { target: { value: '10/01/2' } });
    fireEvent.change(input, { target: { value: '10/01/20' } });
    fireEvent.change(input, { target: { value: '10/01/200' } });
    fireEvent.change(input, { target: { value: '10/01/2004' } });
    expect(input).toHaveValue('10/01/2004');
  }, 15_000);

  it('normalizes pasted 10012004 / 10-01-2004 / 2004-01-10', async () => {
    for (const [pasted, shown] of [
      ['10012004', '10/01/2004'],
      ['10-01-2004', '10/01/2004'],
      ['2004-01-10', '10/01/2004'],
    ] as const) {
      const input = await openDateEditor();
      fireEvent.change(input, { target: { value: pasted } });
      expect(input).toHaveValue(shown);
      // Close the editor before the next mount.
      fireEvent.keyDown(input, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText('Date (DD/MM/YYYY)')).not.toBeInTheDocument());
    }
  }, 30_000);

  it('commits a typed date as storage YYYY-MM-DD (cell shows DD/MM/YYYY)', async () => {
    const commits: unknown[] = [];
    const input = await openDateEditor((event) => {
      commits.push(event);
    });
    fireEvent.change(input, { target: { value: '10012004' } });
    expect(input).toHaveValue('10/01/2004');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Date (DD/MM/YYYY)')).not.toBeInTheDocument());
    // The grid must have received the commit (this is the v32 reactive
    // custom component regression: the edit used to be dropped silently).
    expect(commits).toHaveLength(1);
    expect((commits[0] as { newValue?: unknown }).newValue).toBe('2004-01-10');
    const cell = (document.querySelector('.ag-root') as HTMLElement).querySelector('.ag-cell[col-id="visa_expiry"]');
    expect(cell?.textContent).toContain('10/01/2004');
  }, 15_000);

  it('keeps impossible dates as typed text on commit', async () => {
    const commits: unknown[] = [];
    const input = await openDateEditor((event) => {
      commits.push(event);
    });
    fireEvent.change(input, { target: { value: '31/02/2004' } });
    expect(input).toHaveValue('31/02/2004');
    expect(screen.getByRole('alert')).toHaveTextContent(/kept unchanged/i);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Date (DD/MM/YYYY)')).not.toBeInTheDocument());
    expect(commits).toHaveLength(1);
    // Impossible dates are kept exactly as typed (warned, never silently changed).
    expect((commits[0] as { newValue?: unknown }).newValue).toBe('31/02/2004');
  }, 15_000);

  it('clears the cell when the date is emptied', async () => {
    const commits: unknown[] = [];
    const input = await openDateEditor((event) => {
      commits.push(event);
    });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Date (DD/MM/YYYY)')).not.toBeInTheDocument());
    expect(commits).toHaveLength(1);
    const cell = (document.querySelector('.ag-root') as HTMLElement).querySelector('.ag-cell[col-id="visa_expiry"]');
    expect(cell?.textContent ?? '').not.toContain('01/06/2026');
  }, 15_000);
});
