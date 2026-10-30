import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom reports a 1024px window, which is narrower than the desktop window DKS
// runs in. Components that adapt to width (the Visa Sheet toolbar collapses its
// last quick filters below 1080px) should be tested at the real desktop size
// unless a test deliberately overrides `window.innerWidth`.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1440,
  });
}

// Screens are lazily imported (see LazyView), so the first render of a route
// also pays Vite's on-demand transform of that chunk — several hundred ms on
// Linux and over a second on a cold Windows CI runner. The 1s default made
// "wait for the lazy view" assertions flaky there; the ceiling is raised for
// every query, not replaced with fixed sleeps.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
