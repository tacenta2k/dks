/**
 * R7: the packaged Windows build failed with
 * `No handler registered for 'dks:local:get-snapshot'` because the local
 * SQLite store could not be opened (the bundled `better_sqlite3.node` had been
 * compiled for the wrong runtime ABI). The catch block used to log and walk
 * away, so the renderer only saw a bare "no handler" error.
 *
 * This module turns the raw failure into bounded, user-safe text that is
 * written to `%APPDATA%\DKS\logs\main.log` and returned through IPC. It has no
 * Electron imports so it can be unit-tested directly.
 */

export interface LocalStoreFailure {
  /** Bounded, user-safe reason (no stack trace, no absolute app paths). */
  message: string;
  /** Absolute path of the DKS main log when electron-log can resolve it. */
  logPath: string | null;
  /** True when the native module binary was built for another runtime. */
  abiMismatch: boolean;
}

/** Fallback shown when electron-log has not produced a path yet. */
export const LOCAL_STORE_LOG_FALLBACK = '%APPDATA%\\DKS\\logs\\main.log';

/**
 * A wrong-ABI native module is the failure this round exists for
 * (`npm rebuild better-sqlite3` leaves a Node-ABI build that Electron cannot
 * dlopen). A missing binding file is reported the same way because the user
 * action is identical: reinstall DKS.
 */
export const LOCAL_STORE_ABI_HINT =
  'The bundled SQLite module was built for a different Electron version; reinstall DKS.';

const MAX_DETAIL_LENGTH = 120;
const DEFAULT_DETAIL = 'the local database could not be opened';

const NATIVE_MODULE_PATTERN = new RegExp(
  [
    'NODE_MODULE_VERSION',
    'compiled against a different Node\\.js version',
    'was compiled against a different',
    'Cannot find module .*better_sqlite3\\.node',
    'not a valid Win32 application',
    'invalid ELF header',
    'dlopen',
  ].join('|'),
  'i',
);

/** Collapse newlines/indentation so a multi-line error stays one UI line. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isNativeModuleAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  return NATIVE_MODULE_PATTERN.test(message);
}

/**
 * Node's ABI error starts with a long absolute path and only then explains
 * itself, so a plain truncation would drop the sentence that matters.
 * Distil it to the two ABI numbers instead.
 */
function describeAbiMismatch(collapsed: string): string {
  const numbers = [...collapsed.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((match) => match[1]);
  if (numbers.length >= 2) {
    return `the SQLite native module was built for ABI ${numbers[0]} but this build needs ABI ${numbers[1]}`;
  }
  return 'the SQLite native module was built for a different runtime ABI';
}

/** Bounded, single-line description of the thrown value. */
export function describeLocalStoreError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const collapsed = collapseWhitespace(raw);
  if (!collapsed) {
    return DEFAULT_DETAIL;
  }
  if (NATIVE_MODULE_PATTERN.test(collapsed)) {
    return describeAbiMismatch(collapsed);
  }
  return collapsed.length > MAX_DETAIL_LENGTH
    ? `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

export function createLocalStoreFailure(
  error: unknown,
  logPath?: string | null,
): LocalStoreFailure {
  const trimmedLogPath = typeof logPath === 'string' && logPath.trim()
    ? logPath.trim()
    : null;
  return {
    message: describeLocalStoreError(error),
    logPath: trimmedLogPath,
    abiMismatch: isNativeModuleAbiMismatch(error),
  };
}

/**
 * The single sentence every unregistered local channel returns. The renderer
 * shows the first half verbatim, so it must start with the plain-language
 * headline instead of an IPC wrapper.
 */
export function localStoreUnavailableMessage(
  failure: LocalStoreFailure,
  context?: string,
): string {
  const parts = [`Local database unavailable: ${failure.message}`];
  if (failure.abiMismatch) {
    parts.push(LOCAL_STORE_ABI_HINT);
  }
  if (context) {
    parts.push(`(${context})`);
  }
  parts.push(`Log: ${failure.logPath ?? LOCAL_STORE_LOG_FALLBACK}`);
  return parts.join(' ');
}
