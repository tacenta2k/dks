/**
 * R7: the packaged Windows app showed "Offline — saved locally" while every
 * `dks:local:*` call was actually failing because the SQLite store never
 * opened. The renderer must distinguish "no cloud connection" from "the local
 * database is not available at all".
 */

export const LOCAL_STORE_ERROR_HEADLINE = 'Local database unavailable';

const MAX_MESSAGE_LENGTH = 320;

/**
 * Turns a rejected `window.dks.local` call into one bounded line.
 *
 * Electron wraps handler rejections as
 * `Error invoking remote method 'dks:local:get-snapshot': Error: <message>`,
 * so the wrapper is stripped before the message is shown.
 */
export function localStoreErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const unwrapped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!unwrapped) {
    return 'The local database could not be opened. See the DKS main log for details.';
  }

  return unwrapped.length > MAX_MESSAGE_LENGTH
    ? `${unwrapped.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`
    : unwrapped;
}
