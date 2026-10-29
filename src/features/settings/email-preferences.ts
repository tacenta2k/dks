import type { AuthError, AuthResult } from '../auth/auth-types';
import { isValidEmail } from '../../../supabase/edge-functions/_shared/email';

/** Narrow Supabase client surface for the settings table (key/value rows). */
export interface EmailPrefsClient {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    upsert: (
      values: readonly Record<string, unknown>[],
      options?: { onConflict?: string },
    ) => PromiseLike<{
      data: readonly unknown[] | null;
      error: { message: string } | null;
    }>;
  };
}

/**
 * Email notification preferences — Admin-managed on the SERVER (the
 * `settings` table include the key and RLS already gates writes to Admin;
 * the Resend API key itself NEVER leaves the Edge Function env: no field for
 * it exists anywhere in the app bundle).
 *
 * Free-tier shape:
 *   enabled              — master switch; when false SQL never enqueues.
 *   adminEmail           — ONE recipient for pending Office sign-in requests.
 *   expiryDigestEnabled  — daily batch switch.
 *   expiryRecipients     — explicit list of digest recipients.
 *   includeFullIds       — put FULL Passport / Civil ID values in the emailed
 *                          PDF. Default ON: the digest is addressed to the
 *                          Admin mailbox only and the Admin must be able to
 *                          call the customer from the email alone. Turning it
 *                          OFF masks the identifiers in the PDF; the HTML /
 *                          text body never carries them in either case.
 */

export const EMAIL_PREFS_SETTINGS_KEY = 'email_notifications';

export interface EmailNotificationPrefs {
  enabled: boolean;
  adminEmail: string | null;
  expiryDigestEnabled: boolean;
  expiryRecipients: string[];
  includeFullIds: boolean;
}

export const EMPTY_EMAIL_PREFS: EmailNotificationPrefs = {
  enabled: false,
  adminEmail: null,
  expiryDigestEnabled: false,
  expiryRecipients: [],
  // Full identifiers are the product default (owner decision, 2026-10-27).
  includeFullIds: true,
};

function toError(message: string, code?: string, cause?: unknown): AuthError {
  return { message, code, cause };
}

function parseBoolean(value: unknown, fallback = false): boolean {
  // Only an explicit JSON false opts out; a missing key keeps the default.
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return fallback;
}

function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return isValidEmail(trimmed) ? trimmed : null;
}

function parseRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const email = item.trim().toLowerCase();
    if (isValidEmail(email) && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

export function parseEmailPrefs(value: unknown): EmailNotificationPrefs {
  const record = (value ?? null) as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return { ...EMPTY_EMAIL_PREFS };
  }
  return {
    enabled: parseBoolean(record.enabled),
    adminEmail: parseEmail(record.admin_email) ?? null,
    expiryDigestEnabled: parseBoolean(record.expiry_digest_enabled),
    expiryRecipients: parseRecipients(record.expiry_recipients),
    includeFullIds: parseBoolean(record.include_full_ids, true),
  };
}

export function emailPrefsToRecord(prefs: EmailNotificationPrefs): Record<string, unknown> {
  return {
    enabled: prefs.enabled === true,
    admin_email: prefs.adminEmail && isValidEmail(prefs.adminEmail) ? prefs.adminEmail.trim().toLowerCase() : null,
    expiry_digest_enabled: prefs.expiryDigestEnabled === true,
    expiry_recipients: prefs.expiryRecipients.filter((item) => isValidEmail(item)),
    include_full_ids: prefs.includeFullIds === true,
  };
}

/**
 * Settings → Notifications must never feel like it "hangs".
 *
 * Two independent problems made the email section slow:
 *  1. every mount of the section issued a NEW network round-trip (switching
 *     tabs back and forth re-fetched each time), and
 *  2. a slow/stalled request had no ceiling, so the section sat on its loader
 *     until the transport gave up (or forever).
 *
 * The cache below makes a repeat open instant, the in-flight map makes two
 * concurrent opens share ONE request, and the timeout turns a stalled request
 * into a normal, retryable error so the form is usable immediately.
 */
export const EMAIL_PREFS_LOAD_TIMEOUT_MS = 8_000;

interface EmailPrefsCacheEntry {
  prefs: EmailNotificationPrefs;
  loadedAt: number;
}

/** Resolved prefs per client (a WeakMap: no leak when a session is replaced). */
const emailPrefsCache = new WeakMap<object, EmailPrefsCacheEntry>();
/** In-flight request per client, shared by every caller. */
const emailPrefsInFlight = new WeakMap<object, Promise<AuthResult<EmailNotificationPrefs>>>();

/** Clears the memoized prefs (saves, sign-out, an explicit refresh). */
export function clearEmailNotificationPrefsCache(client?: EmailPrefsClient | null): void {
  if (client) {
    emailPrefsCache.delete(client);
    emailPrefsInFlight.delete(client);
    return;
  }
  // WeakMap has no clear(): the next client object simply gets a fresh entry.
}

/** The last successfully loaded prefs for this client, if any (synchronous). */
export function peekEmailNotificationPrefs(
  client: EmailPrefsClient | null | undefined,
): EmailNotificationPrefs | null {
  if (!client) {
    return null;
  }
  const cached = emailPrefsCache.get(client);
  return cached ? { ...cached.prefs } : null;
}

function rememberEmailPrefs(client: EmailPrefsClient, prefs: EmailNotificationPrefs): void {
  emailPrefsCache.set(client, { prefs: { ...prefs }, loadedAt: Date.now() });
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The server did not answer in time.'));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchEmailNotificationPrefs(
  client: EmailPrefsClient,
  timeoutMs: number,
): Promise<AuthResult<EmailNotificationPrefs>> {
  try {
    const result = await withTimeout(
      client.from('settings').select('key,value').eq('key', EMAIL_PREFS_SETTINGS_KEY).maybeSingle(),
      timeoutMs,
    );
    if (result.error) {
      return {
        data: { ...EMPTY_EMAIL_PREFS },
        error: toError(result.error.message, 'EMAIL_PREFS_LOAD_FAILED', result.error),
      };
    }
    const record = result.data as Record<string, unknown> | null;
    const prefs = parseEmailPrefs(record?.value);
    rememberEmailPrefs(client, prefs);
    return { data: prefs, error: null };
  } catch (caught) {
    return {
      data: { ...EMPTY_EMAIL_PREFS },
      error: toError('Unable to load email preferences.', 'EMAIL_PREFS_LOAD_FAILED', caught),
    };
  }
}

/**
 * Load the Admin email preferences.
 *
 * `{ cached: true }` returns the memoized value without touching the network
 * (used for the first paint); a plain call shares any in-flight request and is
 * bounded by `timeoutMs`.
 */
export async function loadEmailNotificationPrefs(
  client: EmailPrefsClient,
  options: { timeoutMs?: number; cached?: boolean; refresh?: boolean } = {},
): Promise<AuthResult<EmailNotificationPrefs>> {
  const timeoutMs = options.timeoutMs ?? EMAIL_PREFS_LOAD_TIMEOUT_MS;
  if (!options.refresh) {
    const cached = emailPrefsCache.get(client);
    if (cached) {
      return { data: { ...cached.prefs }, error: null };
    }
    if (options.cached) {
      return { data: { ...EMPTY_EMAIL_PREFS }, error: null };
    }
  }
  const inFlight = emailPrefsInFlight.get(client);
  if (inFlight) {
    return inFlight;
  }
  const request = fetchEmailNotificationPrefs(client, timeoutMs).finally(() => {
    emailPrefsInFlight.delete(client);
  });
  emailPrefsInFlight.set(client, request);
  return request;
}

/**
 * Warm the cache without blocking anything (Settings → Notifications opens on
 * a warmed client instead of a spinner). Failures are silent: the section
 * loads (and reports) on its own when it opens.
 */
export function primeEmailNotificationPrefs(
  client: EmailPrefsClient | null | undefined,
): void {
  if (!client || emailPrefsCache.has(client)) {
    return;
  }
  void loadEmailNotificationPrefs(client).catch(() => undefined);
}

export async function saveEmailNotificationPrefs(
  client: EmailPrefsClient,
  prefs: EmailNotificationPrefs,
): Promise<AuthResult<EmailNotificationPrefs>> {
  try {
    const rows = [{
      key: EMAIL_PREFS_SETTINGS_KEY,
      value: emailPrefsToRecord(prefs),
    }];
    const result = await client
      .from('settings')
      .upsert(rows, { onConflict: 'key' });
    if (result.error) {
      return {
        data: null,
        error: toError(result.error.message, 'EMAIL_PREFS_SAVE_FAILED', result.error),
      };
    }
    const saved = parseEmailPrefs(emailPrefsToRecord(prefs));
    rememberEmailPrefs(client, saved);
    return { data: saved, error: null };
  } catch (caught) {
    return {
      data: null,
      error: toError('Unable to save email preferences.', 'EMAIL_PREFS_SAVE_FAILED', caught),
    };
  }
}

/**
 * Validation for the Settings UI: no empty recipients, no placeholders, and
 * the Admin email is REQUIRED before the master switch may go ON (emailing
 * "whoever the onboarding sender allows" is a free-tier trap — we'd rather
 * leave delivery disabled than send nothing).
 */
export function validateEmailPrefs(prefs: EmailNotificationPrefs): string | null {
  if (!prefs.enabled) {
    return null; // OFF is always valid
  }
  if (!prefs.adminEmail || !isValidEmail(prefs.adminEmail)) {
    return 'Enter the administrator email for approval requests before enabling email.';
  }
  if (prefs.expiryDigestEnabled && prefs.expiryRecipients.length === 0) {
    return 'Add at least one digest recipient or keep the daily digest off.';
  }
  const bad = prefs.expiryRecipients.filter((recipient) => !isValidEmail(recipient));
  if (bad.length > 0) {
    return `These recipients are not valid email addresses: ${bad.join(', ')}`;
  }
  return null;
}
