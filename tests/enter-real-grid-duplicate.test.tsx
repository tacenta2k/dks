/**
 * Bug 2 REDUX — the one-Enter duplicate LOOP on the REAL AG Grid.
 *
 * Why this file exists: the previous Bug 2 tests
 * (tests/enter-duplicate-rows.test.tsx) drove the jsdom accessible-table
 * surface and direct repository calls. They pinned the retry/idempotency
 * layers correctly but were structurally incapable of seeing the actual
 * production failure, and stayed green while the owner still got several
 * identical rows from ONE Enter on Linux/Electron. This suite drives the
 * REAL SheetPage grid (renderGridInTests) exactly once per scenario.
 *
 * The loop these tests pin (Phase 1 reproduction, logged):
 *   Enter commits draft "Name"
 *   -> createFromDraft creates the row and the focus handoff
 *      (applyPendingDraftFocus) reopened an editor on the draft BEFORE AG
 *      Grid applied the refreshed rowData — on the stale draft node whose
 *      data object AG had just mutated with "Name"
 *   -> cellEditingStarted rotated the dedupe identity
 *   -> AG swapped the draft node's data to a fresh blank draft; when that
 *      editor was stopped (handoff retry stopEditing / focus loss), AG
 *      wrote the editor's pre-held "Name" into the blank draft and fired
 *      cellValueChanged on __draft again
 *   -> another create with the rotated identity; repeat per refresh.
 * Pre-fix, the "production refresh loop" test below produced 4 rows
 * (5 create calls) from a single Enter. The fix (fresh-draft generation,
 * model-freshness gate on the handoff, cancelling transient draft
 * editors, and ignoring no-input re-commits of a session-start value)
 * makes every scenario below land on exactly one row.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeAll, describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import {
  draftValuesEqual,
  isDraftSessionStartRecommit,
} from '../src/features/sheet/grid-behaviour';
import { createInMemorySheetRepository, type SheetRepository } from '../src/features/sheet/repository';

beforeAll(() => {
  // AG Grid needs layout metrics jsdom does not provide (same harness as
  // tests/grid-tab-navigation.test.tsx).
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return Number(this.getAttribute('data-mock-width') ?? 800); },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return Number(this.getAttribute('data-mock-height') ?? 600); },
  });
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  (window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  window.HTMLElement.prototype.scrollTo = window.HTMLElement.prototype.scrollTo ?? (() => undefined);
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView ?? (() => undefined);
});

interface CreateCall { identityId?: string }

function seededRow(index: number) {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `seed-${index}`,
    data: { full_name: `Existing ${index}`, visa_expiry: '2027-01-22', notes: '' },
    category: null,
    deleted: false,
    updatedAt: ts,
    updated_at: ts,
  };
}

async function makeRepository(seedCount: number, createDelayMs = 0) {
  const repository = createInMemorySheetRepository({
    rows: Array.from({ length: seedCount }, (_, i) => seededRow(i)),
  });
  await repository.addColumn({ id: 'full_name', name: 'Full Name', type: 'text' });
  await repository.addColumn({ id: 'visa_expiry', name: 'Visa expiry', type: 'date_expiry' });
  await repository.addColumn({ id: 'notes', name: 'Notes', type: 'text' });

  const calls: CreateCall[] = [];
  const originalCreate = repository.createRow.bind(repository);
  repository.createRow = async (data, category, options) => {
    calls.push({ identityId: options?.id });
    if (createDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, createDelayMs));
    }
    return originalCreate(data, category, options);
  };
  // Production order: SQLite returns newest first, so a created record
  // lands at the TOP and the draft row's index shifts — part of the loop.
  const readRows = repository.getRows.bind(repository);
  repository.getRows = async () => [...(await readRows())].sort((l, r) => (
    (r.updated_at ?? '').localeCompare(l.updated_at ?? '')
  ));
  return { repository, calls };
}

function rowsByIndex(): Map<number, HTMLElement[]> {
  const map = new Map<number, HTMLElement[]>();
  document.querySelectorAll(
    '.ag-center-cols-container, .ag-pinned-left-cols-container, .ag-pinned-right-cols-container',
  ).forEach((container) => {
    container.querySelectorAll('.ag-row').forEach((row) => {
      const index = Number((row as HTMLElement).getAttribute('row-index'));
      const list = map.get(index) ?? [];
      list.push(row as HTMLElement);
      map.set(index, list);
    });
  });
  return map;
}
function logicalRowIndexes(): number[] {
  return Array.from(rowsByIndex().keys()).sort((a, b) => a - b);
}
function cellInRow(index: number, colId: string): HTMLElement | null {
  for (const row of rowsByIndex().get(index) ?? []) {
    const cell = row.querySelector(`.ag-cell[col-id="${colId}"]`);
    if (cell) return cell as HTMLElement;
  }
  return null;
}
function isDraftRow(index: number): boolean {
  return (rowsByIndex().get(index) ?? []).some((r) => r.classList.contains('sheet-draft-row'));
}
function editingCell(): HTMLElement | null {
  return document.querySelector('.ag-cell-inline-editing');
}
function draftLastIndex(): number {
  return logicalRowIndexes().at(-1) as number;
}
async function settle(ms: number) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
function view(repository: SheetRepository, refreshToken = 0) {
  return (
    <div style={{ width: '1200px', height: '700px' }}>
      <SheetPage repository={repository} role="office" renderGridInTests refreshToken={refreshToken} />
    </div>
  );
}
async function renderSheet(repository: SheetRepository) {
  const result = render(view(repository));
  await waitFor(() => expect(document.querySelector('.ag-root')).toBeTruthy());
  await settle(300);
  const viewport = document.querySelector('.ag-body-viewport') as HTMLElement;
  viewport.scrollTop = 1_000_000;
  fireEvent.scroll(viewport);
  await waitFor(() => expect(isDraftRow(draftLastIndex())).toBe(true));
  return result;
}
async function openDraftNameEditor(): Promise<HTMLInputElement> {
  const existing = editingCell()?.querySelector('input') as HTMLInputElement | null;
  if (existing && editingCell()?.closest('.ag-row')?.getAttribute('row-id') === '__draft') {
    return existing;
  }
  fireEvent.doubleClick(cellInRow(draftLastIndex(), 'full_name') as HTMLElement);
  return waitFor<HTMLInputElement>(() => {
    const candidate = editingCell()?.querySelector('input');
    expect(candidate, 'draft name editor must open').toBeTruthy();
    return candidate as HTMLInputElement;
  });
}
function typeName(input: HTMLInputElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}
async function countNamed(repository: SheetRepository, name: string): Promise<number> {
  return (await repository.getRows()).filter((r) => r.data.full_name === name).length;
}

describe('Bug 2 redux — session-start recommit predicate (pure)', () => {
  it('flags only meaningful start values committed back unchanged', () => {
    expect(isDraftSessionStartRecommit('John Test', 'John Test')).toBe(true);
    expect(isDraftSessionStartRecommit(null, 'John Test')).toBe(false);
    expect(isDraftSessionStartRecommit('', 'John Test')).toBe(false);
    expect(isDraftSessionStartRecommit(undefined, 'John Test')).toBe(false);
    expect(isDraftSessionStartRecommit('John Test', 'Mary Test')).toBe(false);
    expect(isDraftSessionStartRecommit('John Test', 'John Test Jr')).toBe(false);
    expect(isDraftSessionStartRecommit(42, '42')).toBe(true);
    expect(draftValuesEqual(null, undefined)).toBe(true);
    expect(draftValuesEqual(0, '0')).toBe(true);
    expect(draftValuesEqual('a', 'b')).toBe(false);
  });
});

describe('Bug 2 redux — ONE Enter on the real grid creates exactly one row', () => {
  it('single Enter on a seeded sheet: one row, and the fresh draft is blank', async () => {
    const { repository, calls } = await makeRepository(5);
    const { unmount } = await renderSheet(repository);

    const input = await openDraftNameEditor();
    typeName(input, 'John Test');
    // ONE Enter: keydown + keyup, repeat=false. Nothing else.
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyUp(input, { key: 'Enter' });

    await waitFor(async () => expect(await countNamed(repository, 'John Test')).toBe(1));
    await settle(1500); // let handoff frames / model updates fully drain
    expect(await countNamed(repository, 'John Test')).toBe(1);
    expect(calls).toHaveLength(1);
    // The leak assertion that failed pre-fix: the fresh draft must be empty.
    expect(cellInRow(draftLastIndex(), 'full_name')?.textContent?.trim()).toBe('');
    unmount();
  }, 60_000);

  it('THE LOOP: one Enter + production post-create refreshes + editor stops still create one row', async () => {
    const { repository, calls } = await makeRepository(5);
    const result = await renderSheet(repository);

    const input = await openDraftNameEditor();
    typeName(input, 'Polluted Person');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyUp(input, { key: 'Enter' });
    await settle(600);

    // Production: the create triggers sync; a healthy sync bumps
    // repositoryRevision -> pageRefreshToken -> SheetPage quiet refresh.
    result.rerender(view(repository, 1));
    await settle(800);
    // Pre-fix this was already 2 rows with no further input.
    expect(await countNamed(repository, 'Polluted Person')).toBe(1);

    // Stop whatever editor the grid/handoff has open on the draft the way
    // the grid itself does on focus loss; if none is open, open the draft
    // editor WITHOUT typing (mirrors the handoff's own reopen + stop).
    let editorInput = editingCell()?.querySelector('input') as HTMLInputElement | null;
    if (!editorInput) {
      editorInput = await openDraftNameEditor();
      expect(editorInput.value).toBe(''); // born blank post-fix; was "Polluted Person"
      result.rerender(view(repository, 2));
      await settle(400);
      editorInput = (editingCell()?.querySelector('input') as HTMLInputElement | null) ?? editorInput;
    }
    fireEvent.focusOut(editorInput);
    fireEvent.blur(editorInput);
    await settle(1200);

    expect(await countNamed(repository, 'Polluted Person')).toBe(1);
    expect(calls).toHaveLength(1);
    expect(cellInRow(draftLastIndex(), 'full_name')?.textContent?.trim()).toBe('');
    result.unmount();
  }, 60_000);

  it('held Enter (repeat keydowns landing on the reopened draft editor) creates one row', async () => {
    const { repository, calls } = await makeRepository(3, 40);
    const { unmount } = await renderSheet(repository);

    const input = await openDraftNameEditor();
    typeName(input, 'Held Key Person');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(async () => expect(await countNamed(repository, 'Held Key Person')).toBe(1));
    // Held key: repeats keep arriving at whatever editor/input now exists.
    for (let i = 0; i < 6; i += 1) {
      const target = (editingCell()?.querySelector('input') as HTMLInputElement | null) ?? input;
      fireEvent.keyDown(target, { key: 'Enter', repeat: true });
      await settle(60);
    }
    await settle(1200);
    expect(await countNamed(repository, 'Held Key Person')).toBe(1);
    expect(calls).toHaveLength(1);
    unmount();
  }, 60_000);

  it('two separate editing sessions with the same name create two rows (legitimate)', async () => {
    const { repository, calls } = await makeRepository(2);
    const { unmount } = await renderSheet(repository);

    const first = await openDraftNameEditor();
    typeName(first, 'Twin Person');
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(async () => expect(await countNamed(repository, 'Twin Person')).toBe(1));
    await settle(1000);

    // A genuinely new session: type the identical name into the BLANK draft.
    const second = await openDraftNameEditor();
    expect(second.value).toBe('');
    typeName(second, 'Twin Person');
    fireEvent.keyDown(second, { key: 'Enter' });
    await waitFor(async () => expect(await countNamed(repository, 'Twin Person')).toBe(2));
    await settle(1000);
    expect(await countNamed(repository, 'Twin Person')).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].identityId).toBeTruthy();
    expect(calls[1].identityId).toBeTruthy();
    expect(calls[1].identityId).not.toBe(calls[0].identityId);
    unmount();
  }, 60_000);
});
