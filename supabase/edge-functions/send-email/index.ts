/**
 * send-email — outbox processor (server-side ONLY).
 *
 * Triggered by a scheduled job (pg_cron + pg_net) every minute. On each tick
 * it claims pending `public.email_outbox` rows (SERVER-side atomic claim via
 * the `claim_email_outbox` RPC — never a desktop client), sends them through
 * Resend, and records only a sanitized delivery status.
 *
 * Secrets (Edge Function environment — never in this repo):
 *   RESEND_API_KEY      — the Resend API key (REQUIRED for anything to send).
 *   DKS_TRIGGER_KEY     — a random key shared with the DB; the scheduled job
 *                         (inside Postgres) sends it as `x-dks-trigger-key`
 *                         so random HTTP callers cannot drive the queue.
 *   RESEND_FROM_EMAIL   — sender address e.g. 'DKS <noreply@your-domain.example>'.
 *                         Default: the Resend onboarding sender (test-only;
 *                         see deployment notes before going live).
 *
 * Deploy-time notes:
 *   - Content is deliberately minimal (row labels + expiry only; no passport,
 *     no Civil ID, no internal ids — see _shared/email.ts redaction).
 *   - Email failure NEVER blocks anything: rows get requeued up to 3 attempts
 *     and are then left 'failed' alongside a sanitized delivery_log entry.
 */

import {
  buildExpiryDigestEmail,
  buildOfficeApprovalEmail,
  recipientsFrom,
  type DigestEntry,
  type EmailOutboxRow,
  isValidEmail,
} from '../_shared/email.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';
const MAX_ATTEMPTS = 3;

interface Env {
  supabaseUrl: string;
  serviceRoleKey: string;
  triggerKey: string;
  resendApiKey: string | null;
  fromEmail: string;
}

function env(): Env | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const triggerKey = Deno.env.get('DKS_TRIGGER_KEY');
  if (!supabaseUrl || !serviceRoleKey || !triggerKey) {
    return null;
  }
  return {
    supabaseUrl,
    serviceRoleKey,
    triggerKey,
    resendApiKey: Deno.env.get('RESEND_API_KEY')?.trim() ?? null,
    fromEmail: Deno.env.get('RESEND_FROM_EMAIL')?.trim() || 'DKS <onboarding@resend.dev>',
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Supabase PostgREST call with the function-local service role. */
async function rpc(envValue: Env, name: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${envValue.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: envValue.serviceRoleKey,
      authorization: `Bearer ${envValue.serviceRoleKey}`,
    },
    body: JSON.stringify(params),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`rpc ${name} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return text.trim() ? JSON.parse(text) : null;
}

function recipientFor(row: EmailOutboxRow): string | null {
  const direct = typeof row.recipient === 'string' && isValidEmail(row.recipient) ? row.recipient.trim().toLowerCase() : null;
  if (direct) {
    return direct;
  }
  const fallback = recipientsFrom(row.payload?.adminEmail ?? row.payload?.recipient ?? null);
  return fallback[0] ?? null;
}

function buildEmail(row: EmailOutboxRow): { subject: string; text: string; html: string } | null {
  if (row.kind === 'office_signin_request') {
    const requestedAt = typeof row.payload?.requestedAt === 'string' ? (row.payload as { requestedAt: string }).requestedAt : '';
    const email = buildOfficeApprovalEmail(requestedAt);
    return { subject: email.subject, text: email.text, html: email.html };
  }
  if (row.kind === 'expiry_digest') {
    const rawEntries = Array.isArray(row.payload?.entries) ? row.payload.entries : [];
    const entries: DigestEntry[] = rawEntries
      .map((entry) => {
        const candidate = entry as Record<string, unknown>;
        return {
          label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : '(unnamed entry)',
          expiry: typeof candidate.expiry === 'string' ? candidate.expiry : '',
          daysLeft: typeof candidate.daysLeft === 'number' && Number.isFinite(candidate.daysLeft) ? candidate.daysLeft : null,
        };
      });
    const email = buildExpiryDigestEmail(entries);
    return { subject: email.subject, text: email.text, html: email.html };
  }
  return null;
}

async function deliver(envValue: Env, row: EmailOutboxRow): Promise<{ delivered: boolean; detail: string }> {
  const recipient = recipientFor(row);
  const email = buildEmail(row);
  if (!recipient || !email) {
    return { delivered: false, detail: 'no-valid-recipient-or-content' };
  }
  if (!envValue.resendApiKey) {
    // Quiet no-op: Resend optional by design. Recorded but never fails the run.
    return { delivered: false, detail: 'resend-not-configured' };
  }
  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${envValue.resendApiKey}`,
      },
      body: JSON.stringify({
        from: envValue.fromEmail,
        to: [recipient],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      return { delivered: false, detail: `resend-http-${response.status}: ${bodyText.slice(0, 160)}` };
    }
    return { delivered: true, detail: 'sent' };
  } catch (error) {
    return { delivered: false, detail: error instanceof Error ? error.message.slice(0, 160) : 'unknown-send-error' };
  }
}

Deno.serve(async (request) => {
  const envValue = env();
  if (!envValue) {
    // Function deployed without required env; fail quietly per design.
    return json({ ok: false, reason: 'function-not-configured' }, 500);
  }

  const given = request.headers.get('x-dks-trigger-key');
  if (!given || given !== envValue.triggerKey) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method-not-allowed' }, 405);
  }

  const result = { claimed: 0, delivered: 0, failed: 0, perRow: [] as unknown[] };

  try {
    const claimed = (await rpc(envValue, 'claim_email_outbox', { p_limit: 5 })) as EmailOutboxRow[] | null;
    const rows = Array.isArray(claimed) ? claimed : [];
    result.claimed = rows.length;

    for (const row of rows) {
      try {
        const outcome = await deliver(envValue, row);
        if (outcome.delivered) {
          result.delivered += 1;
        } else {
          result.failed += 1;
        }
        const completed = await rpc(envValue, 'complete_email_outbox', {
          p_id: row.id,
          p_delivered: outcome.delivered,
          p_detail: outcome.detail,
          p_recipient: recipientFor(row),
          p_max_attempts: MAX_ATTEMPTS,
        });
        result.perRow.push(completed ?? outcome);
      } catch (rowError) {
        result.failed += 1;
        result.perRow.push({ id: row.id, error: rowError instanceof Error ? rowError.message.slice(0, 160) : 'unknown' });
      }
    }
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 240) : 'unknown',
      ...result,
    }, 500);
  }

  return json({ ok: true, ...result });
});
