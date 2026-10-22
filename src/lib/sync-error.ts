/**
 * Sync error hygiene (Blocker 3).
 *
 * Supabase/HTTP failures can embed credentials in their messages: JWTs,
 * `apikey=…` query strings, service-role keys, Basic auth headers. The sync
 * UI (and the outbox) must show the failure REASON without ever echoing a
 * secret. `sanitizeSyncError` is applied at every point where a raw error
 * message is stored or displayed:
 *   - per-item outbox `lastError` (markFailed),
 *   - the sync loop's `errors` list,
 *   - the global sync status `lastError`.
 */

// Full three-segment JWT first, then a lone eyJ… segment as a fallback.
const JWT_TRIPLE_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\b/g;
const RAW_KEY_PATTERN = /\b(?:sk|rk|pk|sb|key)-[A-Za-z0-9_-]{8,}\b/g;
const KEY_VALUE_PATTERN = /\b(?:api[_-]?key|access[_-]?token|secret|service[_-]?role|token)\b\s*[=:]\s*[^\s,;&"]+/gi;
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const USER_PASS_PATTERN = /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{3,}@/g;
const SERVICE_ROLE_WORD = /\bservice[\s_-]?role\b/gi;

const MAX_SYNC_ERROR_LENGTH = 400;

/**
 * Redact credentials from a raw error message and normalise whitespace.
 * Empty input yields '' (callers decide on a user-facing fallback).
 */
export function sanitizeSyncError(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  let text = String(raw);
  // Order matters: key=value pairs are redacted before the bare "service
  // role" wording is mapped to "service-key", so service_role=<value> loses
  // its value instead of keeping it.
  text = text.replace(JWT_TRIPLE_PATTERN, '[redacted]');
  text = text.replace(JWT_PATTERN, '[redacted]');
  text = text.replace(RAW_KEY_PATTERN, '[redacted]');
  text = text.replace(KEY_VALUE_PATTERN, '[redacted]');
  // "service role" is a well-known role name, not a secret: keep the meaning
  // while flagging it as key material when it appears as an error subject.
  text = text.replace(SERVICE_ROLE_WORD, 'service-key');
  text = text.replace(BASIC_AUTH_PATTERN, 'Basic [redacted]');
  text = text.replace(USER_PASS_PATTERN, '[redacted]@');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_SYNC_ERROR_LENGTH) {
    text = `${text.slice(0, MAX_SYNC_ERROR_LENGTH - 1)}…`;
  }
  return text;
}

/** Sanitised message with a safe fallback for empty input (UI sink). */
export function describeSyncError(raw: unknown): string {
  const text = sanitizeSyncError(raw);
  return text || 'Unknown sync error';
}
