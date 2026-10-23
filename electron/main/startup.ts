export interface LoginItemSettings {
  wasOpenedAtLogin?: boolean;
  wasOpenedAsHidden?: boolean;
  openAtLogin?: boolean;
  launchItems?: unknown[];
}

export interface StartHiddenContext {
  /** `app.getLoginItemSettings()` result, injectable for tests/diagnostics. */
  loginSettings?: LoginItemSettings;
}

/**
 * SYNC-09 — the DKS window must be visible for a normal launch and for
 * `npm run dev`; the app must never come up tray-only by accident.
 *
 * Only an explicit command-line flag may start the window hidden. Earlier
 * versions also hid the window whenever Windows reported `openAtLogin` (the
 * user's preference, which DKS enables on first run) or
 * `wasOpenedAtLogin`, so both `npm run dev` and an ordinary desktop launch
 * after using the app produced an invisible window with no explanation.
 * Autostart now opens the window normally; "minimise to tray" remains a
 * deliberate user action.
 *
 * `loginSettings` is accepted for diagnostics/tests but deliberately does not
 * change the outcome.
 */
export function shouldStartHidden(
  argv: readonly string[] = process.argv,
  _context: StartHiddenContext = {},
): boolean {
  return argv.some((argument) => ['--hidden', '--autostart', '--startup'].includes(argument));
}

export interface StartupRegistrationInput {
  /** `app.isPackaged`. A development run must never register itself. */
  isPackaged: boolean;
  platform?: string;
  /** `process.execPath` — the executable Windows will launch at sign-in. */
  execPath: string;
  /** `app.getName()`; must be DKS so the registry value is `DKS`. */
  appName?: string;
}

export interface StartupRegistration {
  /** Value for `app.setLoginItemSettings`. */
  settings: {
    openAtLogin: boolean;
    openAsHidden: boolean;
    path?: string;
    args?: string[];
  };
  /** Why this decision was made (logged once at startup). */
  reason: 'packaged' | 'development';
}

/**
 * R3 batch D — one startup-registration mechanism, one identity.
 *
 * DKS registers itself with Electron's native `app.setLoginItemSettings`
 * (which writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<app
 * name>` on Windows). The `auto-launch` package is no longer a dependency: two
 * mechanisms writing the same place is how a PC ends up with several "DKS"
 * startup entries, and it also left an unused module in the shipped app.
 *
 * Rules:
 *   - only a packaged build may register — `npm run dev` used to write a
 *     registry entry pointing at `node_modules/electron/dist/electron.exe`,
 *     which is a stale launch target the moment the repo moves;
 *   - the registration always names the current executable explicitly;
 *   - no `--hidden` argument: autostart opens the window normally.
 */
export function startupRegistration({
  isPackaged,
  platform = process.platform,
  execPath,
  appName = 'DKS',
}: StartupRegistrationInput): StartupRegistration {
  // Electron only implements login items on macOS and Windows. Anywhere else
  // the call is a silent no-op, so do not pretend it was registered.
  const supported = platform === 'win32' || platform === 'darwin';
  if (!isPackaged || !supported) {
    return {
      settings: { openAtLogin: false, openAsHidden: false },
      reason: 'development',
    };
  }

  return {
    settings: {
      openAtLogin: true,
      openAsHidden: false,
      path: execPath,
      // Some Electron/Windows combinations need the app name here as well.
      args: [`--dks-startup=${encodeURIComponent(appName)}`],
    },
    reason: 'packaged',
  };
}
