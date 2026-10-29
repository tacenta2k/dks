import type { AuthError } from './auth-types';

/**
 * v0.1.8 (Issue A) — is an auth/profile failure TRANSIENT (network, timeout,
 * server 5xx/429: the saved session may be perfectly valid) or DEFINITIVE
 * (the server rejected the session/refresh token, or the profile is not
 * authorised)?
 *
 * Only the restore/refresh *presentation* uses this: a transient failure keeps
 * the persisted session and retries instead of replacing it with the
 * email/password form. It never grants access — the workspace still requires
 * a session AND a loaded profile, Office still requires server approval, and
 * RLS still enforces everything server-side.
 *
 * Unknown errors are DEFINITIVE (the old behaviour) so nothing can strand the
 * user on a spinner.
 */
export type AuthErrorKind = 'transient' | 'definitive';

/** Code used for the "server unreachable, saved sign-in kept" restore outcome. */
export const RESTORE_UNREACHABLE_CODE = 'RESTORE_UNREACHABLE' as const;

const TRANSIENT_MESSAGE = /failed to fetch|fetch failed|networkerror|network request failed|network error|load failed|timed? ?out|timeout|econn(reset|refused|aborted)|enotfound|eai_again|etimedout|err_internet_disconnected|err_network|err_name_not_resolved|err_connection|socket hang up|aborterror|the user aborted/i;

function readStatus(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function readName(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

export function classifyAuthError(error: AuthError | null | undefined): AuthErrorKind {
  if (!error) return 'definitive';
  if (error.code === 'NOT_AUTHORIZED' || error.code === 'SESSION_MISSING' || error.code === 'NOT_CONFIGURED') {
    return 'definitive';
  }
  if (error.code === RESTORE_UNREACHABLE_CODE) return 'transient';

  const cause = error.cause;
  const name = readName(cause);
  if (name === 'AuthRetryableFetchError') return 'transient';
  // auth-js: AuthApiError / AuthSessionMissingError / AuthInvalidTokenResponseError
  // are the server (or the client library) definitively rejecting the session.
  if (name === 'AuthApiError' || name === 'AuthSessionMissingError' || name === 'AuthInvalidTokenResponseError') {
    return 'definitive';
  }

  const status = readStatus(cause);
  if (status !== null) {
    if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
    if (status >= 400) return 'definitive';
  }

  // A non-authorisation PostgREST/network failure while loading the profile
  // (auth-service maps 401/403/PGRST116/42501 to NOT_AUTHORIZED first).
  if (error.code === 'PROFILE_LOAD_FAILED') return 'transient';

  const causeMessage = cause && typeof cause === 'object' && typeof (cause as { message?: unknown }).message === 'string'
    ? (cause as { message: string }).message
    : '';
  if (TRANSIENT_MESSAGE.test(error.message) || TRANSIENT_MESSAGE.test(causeMessage) || TRANSIENT_MESSAGE.test(name)) {
    return 'transient';
  }
  return 'definitive';
}

export function isTransientAuthError(error: AuthError | null | undefined): boolean {
  return classifyAuthError(error) === 'transient';
}
