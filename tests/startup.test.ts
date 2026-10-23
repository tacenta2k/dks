import { describe, expect, it } from 'vitest';

import { shouldStartHidden, startupRegistration } from '../electron/main/startup';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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


/**
 * R3 batch D — Windows startup registration.
 *
 * Exactly one mechanism may write the startup entry, it must be named DKS, and
 * a development run must never register `electron.exe`.
 */
describe('startup registration (R3 batch D)', () => {
  const execPath = 'C:\\Users\\Aswin\\AppData\\Local\\Programs\\DKS\\DKS.exe';

  it('registers the packaged executable only, named DKS, and shows the window', () => {
    const registration = startupRegistration({
      isPackaged: true,
      platform: 'win32',
      execPath,
      appName: 'DKS',
    });

    expect(registration.reason).toBe('packaged');
    expect(registration.settings).toEqual(expect.objectContaining({
      openAtLogin: true,
      openAsHidden: false,
      path: execPath,
    }));
    // Nothing in the registration may put the app in a hidden/tray-only state.
    expect(registration.settings.args ?? []).not.toContain('--hidden');
    expect(registration.settings.args ?? []).not.toContain('--autostart');
  });

  it('never registers a development run (no electron.exe entry)', () => {
    const registration = startupRegistration({
      isPackaged: false,
      platform: 'win32',
      execPath: 'C:\\dev\\dks\\node_modules\\electron\\dist\\electron.exe',
    });
    expect(registration.reason).toBe('development');
    expect(registration.settings.openAtLogin).toBe(false);
    expect(registration.settings.path).toBeUndefined();
  });

  it('does not pretend to register on an unsupported platform', () => {
    const registration = startupRegistration({
      isPackaged: true,
      platform: 'linux',
      execPath: '/usr/bin/dks',
    });
    expect(registration.settings.openAtLogin).toBe(false);
  });

  it('keeps exactly one startup mechanism in the tree', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // `auto-launch` writes the same Windows Run key as Electron itself; two
    // writers is how duplicate "DKS"/stale entries appear in the Startup list.
    expect(pkg.dependencies?.['auto-launch']).toBeUndefined();

    const main = readFileSync(resolve(__dirname, '..', 'electron/main/index.ts'), 'utf8');
    expect(main).toContain('app.setLoginItemSettings(');
    // The comment above the function names the removed package; what must not
    // exist is an actual import or client instance.
    expect(main).not.toMatch(/from 'auto-launch'/);
    expect(main).not.toContain('new AutoLaunch');
  });
});
