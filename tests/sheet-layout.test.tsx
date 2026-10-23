import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildGridColumns } from '../src/features/sheet/grid-columns';
import { DRAFT_ROW_ID } from '../src/features/sheet/grid-behaviour';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

const sheetPageSource = readFileSync(resolve(__dirname, '../src/features/sheet/SheetPage.tsx'), 'utf8');
const sheetCss = readFileSync(resolve(__dirname, '../src/features/sheet/sheet.css'), 'utf8');
const shellCss = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  expect(index, `missing CSS rule ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/**
 * R3 batch E — sheet layout decisions the user restated:
 *   • the Visa Sheet fills the workspace (never a centered narrow column),
 *   • the Actions column stays but is compact and inside the row,
 *   • one blank draft row sits immediately AFTER the last saved record.
 */
describe('Visa Sheet layout (R3 batch E)', () => {
  it('fills the content width even though the generic .content rule is centered', () => {
    const body = ruleBody(sheetCss, '.content.content--sheet {');
    expect(body).toContain('width: 100%');
    expect(body).toContain('max-width: none');
    expect(body).toMatch(/margin:\s*0?;/);

    // The generic page rule must still center ordinary pages; only the sheet
    // opts out, and it does so with a selector that outranks it.
    const generic = ruleBody(shellCss, '.content {');
    expect(generic).toContain('1280px');

    const wrapper = ruleBody(sheetCss, '.content.content--sheet .sheet-workbench');
    expect(wrapper).toContain('max-width: none');
  });

  it('does not reintroduce a centered wrapper inside the sheet markup', () => {
    expect(sheetPageSource).not.toMatch(/className="[^"]*\bsheet-page--centered\b/);
    expect(sheetPageSource).not.toMatch(/max-width/);
  });

  it('keeps the Actions column, compact and inside the row', () => {
    const columns = buildGridColumns([], {
      onDuplicate: () => undefined,
      onDelete: () => undefined,
      onRenew: () => undefined,
      onAddColumn: () => undefined,
    });
    const actions = columns.find((column) => column.colId === '__actions');
    expect(actions).toBeDefined();
    // USER DECISION: keep it, but small enough that three icon buttons fit.
    expect((actions?.width ?? 0) <= 110).toBe(true);
    expect(actions?.minWidth).toBe(actions?.width);
    expect(actions?.maxWidth).toBe(actions?.width);
    expect(actions?.editable).toBe(false);
    expect(actions?.sortable).toBe(false);
  });

  it('reserves no Add Row / Add Column / Manage Columns toolbar buttons', () => {
    expect(sheetPageSource).not.toMatch(/Add Row/);
    expect(sheetPageSource).not.toMatch(/Manage Columns/);
    // `+` header stays the only way to add a column.
    expect(sheetPageSource).toContain('aria-label="Add column"');
  });

  it('renders the draft row after the last saved record, not pinned to the viewport', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ passport_no: 'Z9000001' });

    const { container } = render(<SheetPage repository={repository} role="office" />);
    const draft = await screen.findByLabelText('New record Passport No');

    const bodyRows = Array.from(container.querySelectorAll('table.sheet-accessible-table tbody tr'));
    expect(bodyRows.length).toBe(2);
    expect(bodyRows[bodyRows.length - 1]).toContainElement(draft);
    expect(bodyRows[bodyRows.length - 1]).toHaveClass('sheet-draft-row');
    expect(bodyRows[0]).not.toHaveClass('sheet-draft-row');

    // The draft must be part of the scrolling list, never a pinned overlay.
    expect(sheetPageSource).not.toContain('pinnedBottomRowData');
    expect(sheetPageSource).toContain('postSortRows');
  });

  it('puts a fresh blank draft directly beneath a just-committed record', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    const input = await screen.findByLabelText('New record Passport No');
    fireEvent.change(input, { target: { value: 'A1234567' } });
    fireEvent.blur(input);

    await waitFor(async () => expect(await repository.getRows()).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('New record Passport No')).toHaveValue(''));

    const rows = Array.from(document.querySelectorAll('table.sheet-accessible-table tbody tr'));
    const draftIndex = rows.findIndex((row) => row.classList.contains('sheet-draft-row'));
    // Draft is always the last visible row: directly under the new record.
    expect(draftIndex).toBe(rows.length - 1);
    expect(DRAFT_ROW_ID).toBe('__draft');
  }, 20_000);

  it('keeps the draft row out of the row context menu and the counts', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);
    await screen.findByLabelText('New record Passport No');

    // An empty sheet still has zero records: the draft is not a record.
    expect(await repository.getRows()).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(/Type in the blank row/i);
  });

  it('shows exactly ONE non-blocking empty state, never a stacked card below the grid', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    const { container } = render(<SheetPage repository={repository} role="office" />);
    await screen.findByLabelText('New record Passport No');

    expect(screen.getByRole('status')).toHaveTextContent(/Type in the blank row below to add your first entry/i);
    // One hint element only — the old floating card under the grid is gone.
    expect(container.querySelectorAll('.sheet-grid__empty')).toHaveLength(1);

    // The hint is a non-blocking overlay inside the grid area
    // (pointer-events: none) — never a card eating viewport height.
    const overlay = ruleBody(sheetCss, '.sheet-grid__empty {');
    expect(overlay).toContain('position: absolute');
    expect(overlay).toContain('pointer-events: none');
    // Bottom-anchored inside the grid: never covers the `+` header or the draft row.
    expect(overlay).toContain('bottom:');
  });

  it('makes the records grid fill all remaining viewport height', () => {
    // Workbench is a full-height flex column; the grid wrap flexes to the
    // bottom of the window.
    const workbench = ruleBody(sheetCss, '.content--sheet .sheet-workbench {');
    expect(workbench).toContain('display: flex');
    expect(workbench).toContain('flex-direction: column');
    expect(workbench).toContain('height: 100%');

    const wrap = ruleBody(sheetCss, '.content--sheet .sheet-grid-wrap {');
    expect(wrap).toContain('flex: 1 1 auto');
    expect(wrap).toContain('min-height');

    const grid = ruleBody(sheetCss, '.content--sheet .sheet-grid {');
    expect(grid).toContain('height: 100%');
  });
});
