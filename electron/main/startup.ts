export interface StartHiddenContext {
  /** `app.getLoginItemSettings()` result, injectable for tests/diagnostics. */
  loginSettings?: LoginItemSettings;
}

export interface LoginItemSettings {
  wasOpenedAtLogin?: boolean;
  wasOpenedAsHidden?: boolean;
  openAtLogin?: boolean;
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
