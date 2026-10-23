/**
 * SHEET-12 end-to-end regression — Excel-style keyboard on the REAL AG Grid.
 *
 * Tab commits and starts editing the NEXT editable column (Shift+Tab the
 * previous one), skipping the system columns (# / Actions / + / Days Left).
 * On the pinned draft row, typing column 1 + Tab creates the record AND lands
 * editing column 2 of that new row; Enter commits + keeps continuous-entry
 * focus on the fresh draft; Escape cancels.
 *
 * The REAL SheetPage drives its REAL grid (renderGridInTests opt-in) against
 * the in-memory repository — the exact wiring the packaged app runs.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeAll, describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository, type SheetRepository } from '../src/features/sheet/repository';
import {
  createTabToNextCell,
  nextTabbableColumnId,
} from '../src/features/sheet/grid-behaviour';
import type { Column } from 'ag-grid-community';

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

async function seedRepository(): Promise<SheetRepository> {
  const repository = createInMemorySheetRepository();
  await repository.addColumn({ name: 'Full Name', type: 'text' });
  await repository.addColumn({ name: 'Visa expiry', type: 'date_expiry' });
  await repository.addColumn({ name: 'Notes', type: 'text' });
  return repository;
}

function columnIds(repositoryRowsCols: { id: string }[]): string[] {
  return repositoryRowsCols.map((column) => column.id);
}

async function renderSheet(repository: SheetRepository) {
  const renderResult = render(
    <div style={{ width: '1200px', height: '700px' }}>
      <SheetPage repository={repository} role="office" renderGridInTests />
    </div>,
  );
  await waitFor(() => {
    expect(document.querySelector('.ag-root')).toBeTruthy();
  });
  return renderResult;
}

/**
 * One logical grid row (by row-index) spans up to three containers in AG Grid
 * v32 — pinned-left (row # / Actions / first data column), center, and
 * pinned-right (+ / Days Left). Querying just one container can find a
 * different row's cells; this merges the three DOM rows that share an index.
 */
function rowsByIndex(): Map<number, HTMLElement[]> {
  const map = new Map<number, HTMLElement[]>();
  document.querySelectorAll('.ag-center-cols-container, .ag-pinned-left-cols-container, .ag-pinned-right-cols-container')
    .forEach((container) => {
      container.querySelectorAll('.ag-row').forEach((row) => {
        const index = Number((row as HTMLElement).getAttribute('row-index'));
        const list = map.get(index) ?? [];
        list.push(row as HTMLElement);
        map.set(index, list);
      });
    });
  return map;
}

/** Distinct logical row indexes, in grid order. */
function logicalRowIndexes(): number[] {
  return Array.from(rowsByIndex().keys()).sort((left, right) => left - right);
}

/** Every cell for `colId` in the logical row at `index` (any pinned region). */
function cellInRow(index: number, colId: string): HTMLElement | null {
  for (const row of rowsByIndex().get(index) ?? []) {
    const cell = row.querySelector(`.ag-cell[col-id="${colId}"]`);
    if (cell) {
      return cell as HTMLElement;
    }
  }
  return null;
}

function isDraftRow(index: number): boolean {
  return (rowsByIndex().get(index) ?? [])
    .some((row) => row.classList.contains('sheet-draft-row'));
}

function editingCell(): HTMLElement | null {
  return document.querySelector('.ag-cell-inline-editing');
}

function gridCell(colId: string): HTMLElement {
  const cell = document.querySelector(`.ag-cell[col-id="${colId}"]`);
  expect(cell, `grid cell for ${colId} should exist`).toBeTruthy();
  return cell as HTMLElement;
}

/**
 * Types into the open editor — REAL keyboard input semantics: the DOM `input`
 * event is what keeps AG Grid's editor model in sync (its `getValue()` reads
 * the model, not the raw DOM node; real typing always fires `input`).
 */
async function typeInEditor(value: string): Promise<HTMLInputElement> {
  const input = await waitFor<HTMLInputElement>(() => {
    const editing = editingCell();
    const candidate = editing?.querySelector('input');
    expect(candidate, 'an editor input must be open').toBeTruthy();
    return candidate as HTMLInputElement;
  });
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
  return input;
}

describe('nextTabbableColumnId (pure contract)', () => {
  const ids = ['name', 'visa_expiry', 'notes'];
  it('steps forward and backwards, stopping at the row edges', () => {
    expect(nextTabbableColumnId('name', ids, false)).toBe('visa_expiry');
    expect(nextTabbableColumnId('visa_expiry', ids, false)).toBe('notes');
    expect(nextTabbableColumnId('notes', ids, false)).toBeNull(); // commit + stay
    expect(nextTabbableColumnId('notes', ids, true)).toBe('visa_expiry');
    expect(nextTabbableColumnId('visa_expiry', ids, true)).toBe('name');
    expect(nextTabbableColumnId('name', ids, true)).toBeNull();
    expect(nextTabbableColumnId('daysLeft', ids, false)).toBeNull();
  });

  it('createTabToNextCell returns the next editable position or true to stay', () => {
    const fakeColumn = (id: string) => ({ getColId: () => id }) as unknown as Column<unknown>;
    const tabToNext = createTabToNextCell(fakeColumn, () => ids);
    const params = (colId: string, backwards = false) => ({
      backwards,
      editing: true,
      previousCellPosition: { rowIndex: 3, rowPinned: null, column: fakeColumn(colId) },
      nextCellPosition: null,
      api: {} as never,
      context: undefined,
    }) as unknown as Parameters<typeof tabToNext>[0];
    const moved = tabToNext(params('name'));
    expect(moved).not.toBe(true);
    expect((moved as { column: Column }).column.getColId()).toBe('visa_expiry');
    expect((moved as { rowIndex: number }).rowIndex).toBe(3); // same row
    expect(tabToNext(params('notes'))).toBe(true); // edge: commit + stay
    expect(tabToNext(params('name', true))).toBe(true);
    const back = tabToNext(params('notes', true));
    expect((back as { column: Column }).column.getColId()).toBe('visa_expiry');
  });
});

describe('Grid Tab navigation end-to-end (SHEET-12)', () => {
  it('Tab while editing commits and starts editing the NEXT editable column', async () => {
    const repository = await seedRepository();
    await repository.createRow({ full_name: 'Ada', visa_expiry: '2027-01-22', notes: '' });
    const columns = columnIds(await repository.getColumns());
    const expiryId = columns[1];
    const notesId = columns[2];

    await renderSheet(repository);

    const nameCell = gridCell('full_name');
    fireEvent.doubleClick(nameCell);
    const nameEditor = await typeInEditor('Ada Byron');
    fireEvent.keyDown(nameEditor, { key: 'Tab' });

    // Editing continues in the very next editable column (system columns are
    // never targets — there is a pinned Actions/# on the left and
    // +/Days Left on the right).
    await waitFor(() => {
      expect(editingCell()?.getAttribute('col-id')).toBe(expiryId);
    });
    // …and the typed value committed to the store.
    await waitFor(async () => {
      const [row] = await repository.getRows();
      expect(row?.data.full_name).toBe('Ada Byron');
    });

    // Tab from the LAST editable column commits + keeps the grid engaged.
    const notesEditor = await typeInEditor('last');
    fireEvent.keyDown(notesEditor, { key: 'Tab' });
    await waitFor(() => {
      expect(editingCell()?.getAttribute('col-id')).toBe(notesId);
    });
  }, 30_000);

  it('Shift+Tab moves to the PREVIOUS editable column', async () => {
    const repository = await seedRepository();
    await repository.createRow({ full_name: 'Ada', visa_expiry: '2027-01-22', notes: '' });
    const columns = columnIds(await repository.getColumns());
    const expiryId = columns[1];

    await renderSheet(repository);

    fireEvent.doubleClick(gridCell(expiryId));
    const input = await screen.findByLabelText('Date (DD/MM/YYYY)');
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });

    await waitFor(() => {
      expect(editingCell()?.getAttribute('col-id')).toBe('full_name');
    });
  }, 30_000);

  it('a date_expiry cell commits its DD/MM/YYYY text on Tab', async () => {
    const repository = await seedRepository();
    await repository.createRow({ full_name: 'Ada', visa_expiry: '2027-01-22', notes: '' });
    const columns = columnIds(await repository.getColumns());
    const expiryId = columns[1];
    const notesId = columns[2];

    await renderSheet(repository);

    fireEvent.doubleClick(gridCell(expiryId));
    const input = await screen.findByLabelText('Date (DD/MM/YYYY)');
    fireEvent.change(input, { target: { value: '10012028' } });
    expect(input).toHaveValue('10/01/2028');
    fireEvent.keyDown(input, { key: 'Tab' });

    await waitFor(async () => {
      const [row] = await repository.getRows();
      expect(row?.data.visa_expiry ?? row?.data[columns[1]]).toBe('2028-01-10');
    });
    await waitFor(() => {
      expect(editingCell()?.getAttribute('col-id')).toBe(notesId);
    });
  }, 30_000);

  it('draft row: typing column 1 + Tab creates the record AND lands editing column 2 of the NEW row', async () => {
    const repository = await seedRepository();
    const columns = columnIds(await repository.getColumns());
    const expiryId = columns[1];

    await renderSheet(repository);

    // The draft is the only row before any record exists.
    expect(logicalRowIndexes()).toHaveLength(1);
    expect(isDraftRow(logicalRowIndexes()[0])).toBe(true);

    const draftNameCell = cellInRow(logicalRowIndexes()[0], 'full_name');
    expect(draftNameCell).toBeTruthy();
    fireEvent.doubleClick(draftNameCell as HTMLElement);
    const nameEditor = await typeInEditor('Zara');
    fireEvent.keyDown(nameEditor, { key: 'Tab' });

    await waitFor(async () => {
      expect(await repository.getRows()).toHaveLength(1);
    });

    // Editing is now ON THE CREATED RECORD's second column — not the fresh
    // draft, not outside the grid, not simply closed.
    await waitFor(() => {
      const editing = editingCell();
      expect(editing?.getAttribute('col-id')).toBe(expiryId);
      expect(isDraftRow(logicalRowIndexes()[0])).toBe(false);
      expect(
        (rowsByIndex().get(logicalRowIndexes()[0]) ?? [])
          .some((row) => row.contains(editing as Node)),
      ).toBe(true);
    });

    // A fresh blank draft row sits beneath the record.
    const indexes = logicalRowIndexes();
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    expect(isDraftRow(indexes[indexes.length - 1])).toBe(true);
  }, 30_000);

  it('draft row: Enter commits and keeps continuous-entry focus on the fresh draft', async () => {
    const repository = await seedRepository();
    await renderSheet(repository);

    const draftNameCell = cellInRow(logicalRowIndexes().at(-1) as number, 'full_name');
    fireEvent.doubleClick(draftNameCell as HTMLElement);
    const nameEditor = await typeInEditor('Noor');
    fireEvent.keyDown(nameEditor, { key: 'Enter' });

    await waitFor(async () => {
      expect(await repository.getRows()).toHaveLength(1);
    });

    await waitFor(() => {
      const indexes = logicalRowIndexes();
      const lastIndex = indexes[indexes.length - 1];
      const editing = editingCell();
      expect(editing?.getAttribute('col-id')).toBe('full_name');
      expect(isDraftRow(lastIndex)).toBe(true);
      expect(
        (rowsByIndex().get(lastIndex) ?? [])
          .some((row) => row.contains(editing as Node)),
      ).toBe(true);
    });
  }, 30_000);

  it('Escape cancels the edit without committing anything', async () => {
    const repository = await seedRepository();
    await repository.createRow({ full_name: 'Ada', visa_expiry: '2027-01-22', notes: '' });
    await renderSheet(repository);

    fireEvent.doubleClick(gridCell('full_name'));
    const input = await typeInEditor('DISCARD ME');
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => {
      expect(editingCell()).toBeNull();
    });
    const rowsNow = await repository.getRows();
    expect(rowsNow).toHaveLength(1);
    expect(rowsNow[0].data.full_name).toBe('Ada');
  }, 30_000);
});
