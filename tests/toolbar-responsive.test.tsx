import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';
import {
  OVERFLOW_QUICK_FILTER_IDS,
  PRIMARY_QUICK_FILTER_IDS,
  QUICK_FILTER_COLLAPSE_WIDTH,
  shouldCollapseQuickFilters,
} from '../src/features/sheet/toolbar-layout';

/**
 * FIXES_UI §5.2 "Smaller windows" (R2-13): the toolbar stays one compact row.
 * Search shrinks first and the less-used date chips collapse into a
 * `More filters ▾` menu.
 */
const originalWidth = window.innerWidth;

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

afterEach(() => {
  setWidth(originalWidth);
});

describe('toolbar layout', () => {
  it('collapses below the threshold only', () => {
    expect(shouldCollapseQuickFilters(QUICK_FILTER_COLLAPSE_WIDTH)).toBe(false);
    expect(shouldCollapseQuickFilters(QUICK_FILTER_COLLAPSE_WIDTH - 1)).toBe(true);
    expect(shouldCollapseQuickFilters(1440)).toBe(false);
    expect(shouldCollapseQuickFilters(0)).toBe(false);
    // Every chip is either primary or in the overflow menu — none disappear.
    expect([...PRIMARY_QUICK_FILTER_IDS, ...OVERFLOW_QUICK_FILTER_IDS]).toEqual(['today', '7', '30', '60', '90']);
  });

  it('keeps all five chips visible on a wide window', async () => {
    setWidth(1440);
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="admin" today="2026-01-01" />);

    const group = await screen.findByRole('group', { name: 'Quick filters' });
    expect(within(group).getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '≤90d' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /More filters/ })).not.toBeInTheDocument();
  });

  it('moves the last two chips into More filters on a narrow window', async () => {
    setWidth(900);
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="admin" today="2026-01-01" />);

    const group = await screen.findByRole('group', { name: 'Quick filters' });
    expect(within(group).getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: '≤90d' })).not.toBeInTheDocument();

    const more = within(group).getByRole('button', { name: /More filters/ });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'More filters' });
    expect(within(menu).getByRole('menuitemcheckbox', { name: '≤60d' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: '≤90d' })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: '≤90d' }));
    expect(screen.queryByRole('menu', { name: 'More filters' })).not.toBeInTheDocument();

    // The chosen overflow filter stays applied and re-checking it clears it.
    fireEvent.click(within(group).getByRole('button', { name: /More filters/ }));
    const reopened = screen.getByRole('menu', { name: 'More filters' });
    expect(within(reopened).getByRole('menuitemcheckbox', { name: '≤90d' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(reopened).getByRole('menuitemcheckbox', { name: '≤60d' }));
    fireEvent.click(within(group).getByRole('button', { name: /More filters/ }));
    const third = screen.getByRole('menu', { name: 'More filters' });
    expect(within(third).getByRole('menuitemcheckbox', { name: '≤60d' })).toHaveAttribute('aria-checked', 'true');
    expect(within(third).getByRole('menuitemcheckbox', { name: '≤90d' })).toHaveAttribute('aria-checked', 'false');
  });
});
