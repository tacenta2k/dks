import { describe, expect, it } from 'vitest';

import { shouldStartHidden } from '../electron/main/startup';

/**
 * SYNC-09 — `npm run dev` (and a normal desktop launch) must show the window.
 * Only an explicit flag may start hidden; the OS "open at login" preference is
 * not proof that this launch was an autostart.
 */
describe('main-process startup visibility (SYNC-09)', () => {
  it('shows the window for a plain launch and for npm run dev', () => {
    expect(shouldStartHidden([])).toBe(false);
    expect(shouldStartHidden(['node', 'electron/main/index.js'])).toBe(false);
    expect(shouldStartHidden([], { loginSettings: { openAtLogin: true } })).toBe(false);
    expect(shouldStartHidden([], { loginSettings: { wasOpenedAtLogin: true } })).toBe(false);
    expect(shouldStartHidden([], { loginSettings: { wasOpenedAsHidden: true } })).toBe(false);
  });

  it('starts hidden only when explicitly asked', () => {
    expect(shouldStartHidden(['--hidden'])).toBe(true);
    expect(shouldStartHidden(['dks.exe', '--autostart'])).toBe(true);
    expect(shouldStartHidden(['--startup'])).toBe(true);
  });
});
