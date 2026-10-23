import { useEffect, useState } from 'react';

/**
 * FIXES_UI §5.2 "Smaller windows" — search shrinks first, then the less-used
 * quick filters move into a `More filters ▾` menu. The toolbar must stay one
 * compact row and never overflow the window horizontally.
 *
 * The threshold is a pure function so the behaviour is testable without a real
 * layout engine.
 */
export const QUICK_FILTER_COLLAPSE_WIDTH = 1080;

/** Filters that stay visible when space is tight (most useful first). */
export const PRIMARY_QUICK_FILTER_IDS = ['today', '7', '30'] as const;

/** Filters that move into the `More filters ▾` menu on narrow windows. */
export const OVERFLOW_QUICK_FILTER_IDS = ['60', '90'] as const;

export function shouldCollapseQuickFilters(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < QUICK_FILTER_COLLAPSE_WIDTH;
}

/** Tracks the current window width and re-renders on resize. */
export function useCollapsedQuickFilters(): boolean {
  const read = (): number => (typeof window === 'undefined' ? QUICK_FILTER_COLLAPSE_WIDTH : window.innerWidth);
  const [collapsed, setCollapsed] = useState(() => shouldCollapseQuickFilters(read()));

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const onResize = () => setCollapsed(shouldCollapseQuickFilters(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return collapsed;
}
