/**
 * A Realtime-triggered refresh must be QUIET: it uses the same refreshToken
 * path as every other background sync, and it must not close an open cell
 * editor or lose the text being typed.
 *
 * The REAL SheetPage drives the REAL AG Grid here (renderGridInTests), with a
 * repository mutation standing in for the pulled remote change.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeAll, describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository, type SheetRepository } from '../src/features/sheet/repository';

beforeAll(() => {
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
  await repository.addColumn({ name: 'Notes', type: 'text' });
  await repository.createRow({ full_name: 'Ada', notes: 'first' });
  return repository;
}

function editingCell(): HTMLElement | null {
  return document.querySelector('.ag-cell-inline-editing');
}

describe('open cell editor survives a Realtime-triggered quiet refresh', () => {
  it('keeps the editor and the typed text when the pulled data refreshes the sheet', async () => {
    const repository = await seedRepository();
    const [row] = await repository.getRows();

    const view = render(
      <div style={{ width: '1200px', height: '700px' }}>
        <SheetPage repository={repository} role="office" refreshToken={0} renderGridInTests />
      </div>,
    );
    await waitFor(() => expect(document.querySelector('.ag-root')).toBeTruthy());

    const nameCell = document.querySelector('.ag-cell[col-id="full_name"]') as HTMLElement;
    expect(nameCell).toBeTruthy();
    fireEvent.doubleClick(nameCell);

    const input = await waitFor(() => {
      const candidate = editingCell()?.querySelector('input');
      expect(candidate, 'a text editor must be open').toBeTruthy();
      return candidate as HTMLInputElement;
    });
    fireEvent.input(input, { target: { value: 'Ada Byron (typing)' } });

    // Another PC saved a different record; the coalesced Realtime wake-up ran
    // the existing pull and bumped the refresh token.
    await repository.createRow({ full_name: 'Grace', notes: 'second' });
    await repository.updateRow(row!.id, { full_name: 'Ada', notes: 'changed on the other PC' });

    view.rerender(
      <div style={{ width: '1200px', height: '700px' }}>
        <SheetPage repository={repository} role="office" refreshToken={1} renderGridInTests />
      </div>,
    );

    // The refresh really happened (the second record is on screen)…
    await waitFor(() => {
      expect(document.body.textContent).toContain('Grace');
    });
    // …and the editor is still open with the in-progress value intact.
    const stillEditing = editingCell();
    expect(stillEditing).not.toBeNull();
    expect(stillEditing?.getAttribute('col-id')).toBe('full_name');
    expect(editingCell()?.querySelector('input')).toBe(input);
    expect(input).toHaveValue('Ada Byron (typing)');
  }, 30_000);
});
