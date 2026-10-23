import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom reports a 1024px window, which is narrower than the desktop window DKS
// runs in. Components that adapt to width (the Visa Sheet toolbar collapses its
// last quick filters below 1080px) should be tested at the real desktop size
// unless a test deliberately overrides `window.innerWidth`.
Object.defineProperty(window, 'innerWidth', {
  configurable: true,
  writable: true,
  value: 1440,
});

afterEach(() => {
  cleanup();
});
