/**
 * Shared email helpers — pure TypeScript, no Deno/Node imports, so they can
 * be unit-tested with vitest from this repository AND bundled into the Edge
 * Function at deploy time.
 */

export interface EmailEnvelope {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** Minimal RFC-ish email validation (display addresses not supported). */
export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
}

/** Accepts a string, array, or comma-separated list; invalid entries drop out. */
export function recipientsFrom(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * The one-line pending-request email. Content is deliberately neutral —
 * NO request link, NO session data, NO staff identity (Office is a shared
 * account); it only tells the Admin to open DKS.
 */
export function buildOfficeApprovalEmail(requestedAt: string): EmailEnvelope {
  const requested = requestedAt ? formatTimestamp(requestedAt) : 'just now';
  const text = `Open DKS to review an Office sign-in request (submitted ${requested}).`;
  return {
    to: [],
    subject: 'DKS: an Office sign-in request is waiting for approval',
    text,
    html: `<p>${escapeHtml(text)}</p>`,
  };
}

export interface DigestEntry {
  /** Row display label (e.g. full name column) — never an id/passport/civil. */
  label: string;
  expiry: string;
  daysLeft: number | null;
}

/** Fields that must NEVER appear in email bodies by default. */
const SENSITIVE_KEY_PATTERN = /passport|civil|visa.?no|visa.?number|national.?id|iqama|\bid(no|number|num)?\b/i;

/**
 * Build the digest body. Only row labels + expiry/day counts — no passport,
 * no Civil ID, no ids. `entries` are pre-redacted/localhost-safe.
 */
export function buildExpiryDigestEmail(entries: readonly DigestEntry[], recipientLabel?: string | null): EmailEnvelope {
  const dayLabel = recipientLabel && recipientLabel.trim() ? recipientLabel.trim() : 'visa expiries';
  const lines = entries.map((entry) => {
    const days = entry.daysLeft === null ? 'unknown days left' : `${entry.daysLeft} day${entry.daysLeft === 1 ? '' : 's'} left`;
    return `- ${entry.label}: ${entry.expiry} (${days})`;
  });
  const headline = entries.length > 0
    ? `DKS expiry digest for ${dayLabel} — ${entries.length} item${entries.length === 1 ? '' : 's'} need attention.`
    : `DKS expiry digest for ${dayLabel} — nothing worth flagging today.`;
  const text = [headline, '', ...lines, '', 'Open DKS for the full list.'].join('\n');
  const html = [
    `<p>${escapeHtml(headline)}</p>`,
    entries.length > 0
      ? `<ul>${entries.map((entry) => `<li>${escapeHtml(entry.label)} — ${escapeHtml(entry.expiry)} (${entry.daysLeft === null ? 'unknown days left' : `${entry.daysLeft} days left`})</li>`).join('')}</ul>`
      : '',
    '<p>Open DKS for the full list.</p>',
  ].filter(Boolean).join('');
  return {
    to: [],
    subject: `DKS expiry digest — ${entries.length} item${entries.length === 1 ? '' : 's'}`,
    text,
    html,
  };
}

/**
 * Redact sensitive keys from an entries data record before assembling the
 * digest: passport/civil-id shaped keys are dropped; nothing but display
 * label + expiry should leave the server.
 */
export function redactEntryRecord(
  record: Record<string, unknown>,
  options: { labelKeys: readonly string[]; expiryKey: string | null },
): DigestEntry | null {
  const candidates: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue; // never touch passport/civil ids for email
    }
    candidates.push([key, value]);
  }

  const labelValue = options.labelKeys
    .map((key) => record[key])
    .find((value) => typeof value === 'string' && value.trim() !== '');
  // Fallback: FIRST non-sensitive string field (never an id field).
  const fallbackValue = candidates
    .map(([, value]) => value)
    .find((value) => typeof value === 'string' && value.trim() !== '');
  const label = typeof labelValue === 'string' && labelValue.trim().length > 0
    ? labelValue.trim()
    : typeof fallbackValue === 'string' && fallbackValue.trim().length > 0
      ? fallbackValue.trim()
      : '(unnamed entry)';

  if (!options.expiryKey) {
    return null;
  }
  const expiryRaw = record[options.expiryKey];
  if (typeof expiryRaw !== 'string' || expiryRaw.trim() === '') {
    return null;
  }

  return {
    label,
    expiry: expiryRaw,
    daysLeft: null,
  };
}

/** ISO-safe timestamp formatter for email bodies (no timezone claims). */
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 16);
  }
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Outbox processor statuses — the Edge Function handles only these. */
export const EMAIL_OUTBOX_KINDS = ['office_signin_request', 'expiry_digest'] as const;
export type EmailOutboxKind = (typeof EMAIL_OUTBOX_KINDS)[number];

/** Regular shape of one unsent email outbox row (sanitized for delivery). */
export interface EmailOutboxRow {
  id: string;
  kind: EmailOutboxKind;
  recipient: string | null;
  payload: Record<string, unknown> | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
}

/**
 * Deduplicated claim key for one outbox unit: at most one email per (kind,
 * dedupe key). Migration §unique index on (kind, dedupe_key) enforces this.
 */
export function dedupeKey(kind: EmailOutboxKind, parts: readonly string[]): string {
  return `${kind}:${parts.join(':')}`;
}
