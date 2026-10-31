/**
 * Visa Sheet scroll-performance regressions (synthetic data only).
 *
 * Owner report: after the sheet was made full-height, scrolling it in
 * `npm run dev` felt laggy. Investigation (real grid, jsdom harness):
 *
 *  1. DEMONSTRATED BOTTLENECK — the row-number gutter's valueGetter walked
 *     the ENTIRE displayed model (`api.forEachNodeAfterFilterAndSort`) for
 *     EVERY rendered gutter cell, on every scroll repaint: O(viewport × N)
 *     callback invocations (measured pre-fix with the real getter: 40
 *     visible cells = 8,040 calls at N=200; 40,040 at N=1,000; 200,040 at
 *     N=5,000 — and that count excludes AG Grid's own per-node overhead).
 *     The enlarged viewport multiplies the cells per repaint, which is
 *     why the height fix made it noticeable. Fix: when no synthetic rows
 *     are interleaved (Group-by off — the draft row is the only synthetic
 *     row and postSortRows forces it last), the display number is exactly
 *     rowIndex + 1, O(1). Grouped views keep exact counting.
 *
 *  2. Row/column virtualization WAS and IS enabled (domLayout "normal",
 *     nothing suppresses it): 500 synthetic records render ~25 logical
 *     rows of DOM here. The grid-prop contract (incl. animateRows off) is
 *     pinned in tests/sheet-grid-config-stability.test.tsx.
 *
 *  3. Remaining per-scroll costs are AG's row recycling + one React cell
 *     renderer (RowActions) per visible row, amplified in dev by React's
 *     development build + StrictMode double rendering and Vite's
 *     unminified modules. That part is dev-mode overhead, absent from the
 *     production bundle; it was NOT measured head-to-head (no GUI in the
 *     CI sandbox) and jsdom cannot prove visual smoothness — the tests
 *     below assert algorithmic/config properties only.
 */
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildGridColumns, type GridColumnCallbacks } from '../src/features/sheet/grid-columns';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { SheetGridRendererData } from '../src/features/sheet/row-actions';

const baseCallbacks: GridColumnCallbacks = {
  onDuplicate: () => undefined,
  onDelete: () => undefined,
  onRenew: () => undefined,
  onAddColumn: () => undefined,
};

interface FakeNode {
  id: string;
  rowIndex: number;
  data: SheetGridRendererData;
}

function realNode(index: number, rowIndex: number): FakeNode {
  return {
    id: `row-${index}`,
    rowIndex,
    data: {
      __rowId: `row-${index}`,
      __sheetRow: { id: `row-${index}`, data: {}, deleted: false } as never,
      daysLeft: null,
      status: null,
    },
  };
}

function fakeApi(nodes: FakeNode[]) {
  let walks = 0;
  let callbacksIntoModel = 0;
  return {
    api: {
      forEachNodeAfterFilterAndSort: (cb: (node: FakeNode) => void) => {
        walks += 1;
        for (const node of nodes) {
          callbacksIntoModel += 1;
          cb(node);
        }
      },
      getDisplayedRowCount: () => nodes.length,
      getDisplayedRowAtIndex: (i: number) => nodes[i],
    },
    walks: () => walks,
    callbacksIntoModel: () => callbacksIntoModel,
  };
}

function gutterGetter(callbacks: GridColumnCallbacks) {
  const gutter = buildGridColumns([], callbacks).find((c) => c.colId === '__rowNumber');
  expect(gutter?.valueGetter).toBeTypeOf('function');
  return gutter?.valueGetter as (p: never) => number | '';
}

describe('row-number gutter scroll cost', () => {
  it('O(1) fast path: no model walk when only the draft row is synthetic', () => {
    const getter = gutterGetter({ ...baseCallbacks, syntheticRowsInterleaved: () => false });
    const n = 5000;
    const nodes = Array.from({ length: n }, (_, i) => realNode(i, i));
    nodes.push({
      id: '__draft',
      rowIndex: n,
      data: { __rowId: '__draft', daysLeft: null, status: null },
    });
    const { api, walks, callbacksIntoModel } = fakeApi(nodes);

    // One scroll repaint of 40 visible gutter cells near the end.
    const values = nodes.slice(n - 40, n).map((node) => getter({
      data: node.data, node, api,
    } as never));
    expect(values[0]).toBe(n - 39);
    expect(values[39]).toBe(n);
    // Pre-fix this repaint cost 40 full model walks (200,040 callbacks).
    expect(walks()).toBe(0);
    expect(callbacksIntoModel()).toBe(0);

    // Synthetic rows stay unnumbered.
    const draft = nodes[n];
    expect(getter({ data: draft.data, node: draft, api } as never)).toBe('');
  });

  it('grouped view (interleaved synthetic rows) still counts exactly', () => {
    const getter = gutterGetter({ ...baseCallbacks, syntheticRowsInterleaved: () => true });
    const header = (label: string, rowIndex: number): FakeNode => ({
      id: `__group:${label}`,
      rowIndex,
      data: {
        __rowId: `__group:${label}`,
        __groupHeader: label,
        daysLeft: null,
        status: null,
      },
    });
    const nodes = [
      header('A', 0), realNode(0, 1), realNode(1, 2),
      header('B', 3), realNode(2, 4),
      { id: '__draft', rowIndex: 5, data: { __rowId: '__draft', daysLeft: null, status: null } },
    ];
    const { api, walks } = fakeApi(nodes);
    expect(getter({ data: nodes[1].data, node: nodes[1], api } as never)).toBe(1);
    expect(getter({ data: nodes[2].data, node: nodes[2], api } as never)).toBe(2);
    expect(getter({ data: nodes[4].data, node: nodes[4], api } as never)).toBe(3);
    expect(getter({ data: nodes[0].data, node: nodes[0], api } as never)).toBe('');
    expect(walks()).toBeGreaterThan(0); // exact-count path really engaged
  });

  it('without the hint (unit harnesses) keeps the exact legacy counting', () => {
    const getter = gutterGetter(baseCallbacks);
    const nodes = Array.from({ length: 25 }, (_, i) => realNode(i, i));
    nodes.push({
      id: '__draft',
      rowIndex: 25,
      data: { __rowId: '__draft', daysLeft: null, status: null },
    });
    const { api } = fakeApi(nodes);
    // Continuous numbering beyond 9 preserved (Bug 1 semantics).
    expect(getter({ data: nodes[9].data, node: nodes[9], api } as never)).toBe(10);
    expect(getter({ data: nodes[10].data, node: nodes[10], api } as never)).toBe(11);
    expect(getter({ data: nodes[19].data, node: nodes[19], api } as never)).toBe(20);
  });
});

beforeAll(() => {
  // Same layout-metric stubs as tests/grid-tab-navigation.test.tsx.
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

describe('grid row virtualization stays enabled on the real grid', () => {
  it('500 synthetic records render only a viewport-sized slice of rows', async () => {
    const repository = createInMemorySheetRepository({
      rows: Array.from({ length: 500 }, (_, i) => ({
        id: `synth-${i}`,
        data: { full_name: `Synthetic Person ${i}`, visa_expiry: '2027-01-22', notes: '' },
        category: null,
        deleted: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    });
    await repository.addColumn({ id: 'full_name', name: 'Full Name', type: 'text' });
    await repository.addColumn({ id: 'visa_expiry', name: 'Visa expiry', type: 'date_expiry' });
    await repository.addColumn({ id: 'notes', name: 'Notes', type: 'text' });
    const { unmount } = render(
      <div style={{ width: '1200px', height: '700px' }}>
        <SheetPage repository={repository} role="office" renderGridInTests />
      </div>,
    );
    await waitFor(() => expect(document.querySelector('.ag-root')).toBeTruthy());
    await waitFor(() => expect(document.querySelectorAll('.ag-row').length).toBeGreaterThan(0));
    const logicalRows = new Set<number>();
    document.querySelectorAll('.ag-row').forEach((row) => {
      logicalRows.add(Number((row as HTMLElement).getAttribute('row-index')));
    });
    // ~25 measured with the harness metrics; the bound is about
    // virtualization being ON (slice), not the exact count.
    expect(logicalRows.size).toBeGreaterThan(5);
    expect(logicalRows.size).toBeLessThan(120);
    unmount();
  }, 60_000);
});
