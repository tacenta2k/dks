/**
 * SHEET-12 end-to-end regression — Excel-style keyboard on the REAL AG Grid.
 *
 * Tab commits and starts editing the NEXT editable column (Shift+Tab the
 * previous one), skipping the system columns (# / Actions / + / Days Left).
 * On the pinned draft row, typing column 1 + Tab creates the record AND lands
 * editing column 2 of that new row; Enter commits + keeps continuous-entry
 * focus on the fresh draft; Escape cancels.
 *
 * Draft-row Tab hand-off regression: the local store returns
 * `ORDER BY updated_at DESC`, so the committed record moves to the TOP of the
 * sheet while the cursor was on the BOTTOM draft row. The hand-off must follow
 * that same new record by ROW ID (never the draft row's old rowIndex, and
 * never a fixed frame) — including when the new row is scrolled out of view,
 * which is when the old implementation silently lost the editor.
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

/**
 * Reproduce the PRODUCTION row order: electron/main/sqlite.ts returns
 * `SELECT * FROM entries ORDER BY updated_at DESC, id`, so a freshly created
 * record lands at the TOP of the sheet — the opposite end from the draft row
 * the user typed in. The in-memory repository appends instead, so without
 * this wrapper the reordering that triggers the bug never happens.
 */
function withNewestRecordFirst(repository: SheetRepository): SheetRepository {
  const readRows = repository.getRows.bind(repository);
  repository.getRows = async () => [...(await readRows())].sort((left, right) => (
    (right.updated_at ?? '').localeCompare(left.updated_at ?? '')
  ));
  return repository;
}

/**
 * Seed records with DISTINCT, deliberately old `updated_at` values so the
 * record created during the test is always the newest (deterministic top row,
 * no reliance on millisecond timing).
 */
function seededRow(index: number, data: Record<string, unknown>) {
  const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `seed-row-${index}`,
    data,
    category: null,
    deleted: false,
    updatedAt,
    updated_at: updatedAt,
  };
}

/** Scroll the grid viewport to the bottom draft row, like a user would. */
async function scrollGridToBottom(): Promise<void> {
  const viewport = document.querySelector('.ag-body-viewport') as HTMLElement | null;
  expect(viewport, 'grid body viewport should exist').toBeTruthy();
  (viewport as HTMLElement).scrollTop = 1_000_000;
  fireEvent.scroll(viewport as HTMLElement);
  await waitFor(() => {
    expect(isDraftRow(logicalRowIndexes().at(-1) as number)).toBe(true);
  });
}

/** The grid row that currently renders `rowId` (undefined while not rendered). */
function rowElementById(rowId: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll('.ag-row'))
    .find((row) => (row as HTMLElement).getAttribute('row-id') === rowId) as HTMLElement | undefined;
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
    const [created] = await repository.getRows();
    await waitFor(() => {
      const editing = editingCell();
      expect(editing?.getAttribute('col-id')).toBe(expiryId);
      expect(isDraftRow(logicalRowIndexes()[0])).toBe(false);
      // …the editor is inside the CREATED record's row, matched by its stable
      // row id — not merely "the first row".
      expect(editing?.closest('.ag-row')?.getAttribute('row-id')).toBe(created.id);
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

  it('draft row: Tab follows the new record to the TOP of the sheet (reorder) and keeps Tabbing in it', async () => {
    // The reported repro: an existing sheet, the draft row at the BOTTOM, a
    // record committed from its first cell. The store orders by updated_at
    // DESC, so the new record moves to the TOP — the draft row's old rowIndex
    // is stale, and the new row can even be outside the rendered viewport.
    const seeded = Array.from({ length: 20 }, (_, index) => seededRow(index, {
      full_name: `Existing ${index}`,
      visa_expiry: '2027-01-22',
      notes: '',
    }));
    const repository = withNewestRecordFirst(createInMemorySheetRepository({ rows: seeded }));
    await repository.addColumn({ id: 'full_name', name: 'Full Name', type: 'text' });
    await repository.addColumn({ id: 'visa_expiry', name: 'Visa expiry', type: 'date_expiry' });
    await repository.addColumn({ id: 'notes', name: 'Notes', type: 'text' });
    const columns = columnIds(await repository.getColumns());
    const [nameId, expiryId, notesId] = columns;

    await renderSheet(repository);
    await waitFor(() => expect(logicalRowIndexes().length).toBeGreaterThan(0));
    // The cursor is on the bottom draft row, which only renders once the grid
    // is scrolled down — the top of the sheet is NOT rendered here.
    await scrollGridToBottom();
    const draftIndex = logicalRowIndexes().at(-1) as number;
    const draftNameCell = cellInRow(draftIndex, nameId);
    expect(draftNameCell, 'draft row first cell must be rendered').toBeTruthy();

    // 1 + 2: edit the first draft cell, type a value, press Tab.
    fireEvent.doubleClick(draftNameCell as HTMLElement);
    const nameEditor = await typeInEditor('Zara');
    fireEvent.keyDown(nameEditor, { key: 'Tab' });

    // 3: exactly one record was created, and it moved to the TOP.
    await waitFor(async () => {
      expect(await repository.getRows()).toHaveLength(seeded.length + 1);
    });
    const rowsAfterCommit = await repository.getRows();
    const created = rowsAfterCommit.filter((row) => row.data.full_name === 'Zara');
    expect(created).toHaveLength(1);
    const createdId = created[0].id;
    expect(rowsAfterCommit[0].id).toBe(createdId); // newest first, like SQLite
    await waitFor(() => {
      expect(rowElementById(createdId)?.getAttribute('row-index')).toBe('0');
    });

    // 4: focus/editing is on the NEXT editable column of THAT SAME new row,
    // even though the row that was being edited no longer exists at its old
    // rowIndex — and even though the new row had to be scrolled into view.
    await waitFor(() => {
      const editing = editingCell();
      expect(editing, 'an editor must be open after the reorder').toBeTruthy();
      expect(editing?.getAttribute('col-id')).toBe(expiryId);
      expect(editing?.closest('.ag-row')?.getAttribute('row-id')).toBe(createdId);
    });
    // Keyboard focus follows the same cell: AG Grid moved browser focus onto
    // that cell and opened its editor (in jsdom the cell element holds focus,
    // in the packaged app the editor input inside it) — no extra click and no
    // second Tab is needed to keep navigating.
    const focusedEditor = editingCell();
    expect(focusedEditor?.contains(document.activeElement)).toBe(true);
    expect(focusedEditor?.classList.contains('ag-cell-focus')).toBe(true);
    // Generated/system columns are never Tab targets.
    expect(editingCell()?.getAttribute('col-id')).not.toBe('daysLeft');
    expect(editingCell()?.getAttribute('col-id')).not.toBe('__actions');

    // 5: the NEXT Tab continues forward in the same record, without creating
    // a duplicate row and without jumping to the draft or another record.
    const expiryInput = editingCell()?.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(expiryInput, { key: 'Tab' });
    await waitFor(() => {
      const editing = editingCell();
      expect(editing?.getAttribute('col-id')).toBe(notesId);
      expect(editing?.closest('.ag-row')?.getAttribute('row-id')).toBe(createdId);
    });
    const rowsAfterSecondTab = await repository.getRows();
    expect(rowsAfterSecondTab).toHaveLength(seeded.length + 1);
    expect(rowsAfterSecondTab.filter((row) => row.data.full_name === 'Zara')).toHaveLength(1);
    expect(rowsAfterSecondTab[0].id).toBe(createdId);
  }, 60_000);

  it('draft row: a filter that hides the created record keeps entry on the fresh draft row', async () => {
    const repository = withNewestRecordFirst(createInMemorySheetRepository({
      rows: [seededRow(0, { full_name: 'Existing', visa_expiry: '2027-01-22', notes: '' })],
    }));
    await repository.addColumn({ id: 'full_name', name: 'Full Name', type: 'text' });
    await repository.addColumn({ id: 'visa_expiry', name: 'Visa expiry', type: 'date_expiry' });
    await repository.addColumn({ id: 'notes', name: 'Notes', type: 'text' });
    const [nameId] = columnIds(await repository.getColumns());

    await renderSheet(repository);
    // Only rows matching the search stay displayed, so the record created
    // below is not part of the grid at all.
    fireEvent.change(screen.getByLabelText('Search records'), { target: { value: 'Existing' } });
    await waitFor(() => expect(logicalRowIndexes()).toHaveLength(2)); // one record + draft

    const draftIndex = logicalRowIndexes().at(-1) as number;
    fireEvent.doubleClick(cellInRow(draftIndex, nameId) as HTMLElement);
    const nameEditor = await typeInEditor('Zara');
    fireEvent.keyDown(nameEditor, { key: 'Tab' });

    await waitFor(async () => expect(await repository.getRows()).toHaveLength(2));
    // Nothing to navigate to in the created record: continuous entry stays on
    // the fresh draft row in the column the user was typing in — focus is
    // never lost and no second record appears.
    await waitFor(() => {
      const editing = editingCell();
      expect(editing?.getAttribute('col-id')).toBe(nameId);
      expect(editing?.closest('.ag-row')?.getAttribute('row-id')).toBe('__draft');
    });
    expect(await repository.getRows()).toHaveLength(2);
  }, 60_000);

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
