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
 * Two kinds ride the same queue:
 *   - office_signin_request: unchanged notification-only email. NO attachment,
 *     NO approval link, NO session data (Approve/Deny stays inside DKS).
 *   - expiry_digest: a clean HTML report + a plain-text fallback + exactly ONE
 *     in-memory PDF attachment carrying every active Visa Sheet column.
 *
 * Privacy: passport / Civil ID values are masked by default everywhere
 * (HTML, text, PDF). The PDF is generated in memory and discarded after the
 * send — it is never written to disk, Storage, or a database table.
 *
 * Deploy-time notes:
 *   - Email failure NEVER blocks anything: rows get requeued up to 3 attempts
 *     and are then left 'failed' alongside a sanitized delivery_log entry.
 *   - If PDF generation fails, the HTML/text report is still delivered (with a
 *     sanitized detail noting the fallback) rather than sending nothing.
 */

import { jsPDF } from 'npm:jspdf';

import { bytesToBase64 } from '../_shared/base64.ts';
import { PDF_DOCUMENT_OPTIONS, renderDigestPdf, type PdfDocument } from '../_shared/digest-pdf.ts';
import { buildOutboxEmail, sanitizeDetail, type OutboxEmail } from '../_shared/outbox-email.ts';
import {
  recipientsFrom,
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

interface ResendAttachment {
  filename: string;
  content: string;
  content_type: string;
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

/**
 * Render the digest PDF in memory. Two passes: the first counts pages so the
 * footer can print "Page X of Y" on the second, final pass.
 *
 * jsPDF is the ONLY dependency; it runs in Deno (npm specifier) and Node. Its
 * standard WinAnsi fonts cannot encode non-Latin scripts, so unsupported
 * characters are replaced with a visible marker and reported by the renderer.
 */
function generateExpiryPdf(model: NonNullable<OutboxEmail['model']>, jsPDFClass: unknown): Uint8Array {
  // Landscape A4 in POINTS (jsPDF defaults to portrait millimetres).
  const factory = (jsPDFClass as { new (options?: unknown): PdfDocument });
  const probe = new factory(PDF_DOCUMENT_OPTIONS);
  const first = renderDigestPdf(probe, model, { totalPages: 0 });

  const doc = new factory(PDF_DOCUMENT_OPTIONS);
  renderDigestPdf(doc, model, { totalPages: first.pages });

  const arrayBuffer = doc.output('arraybuffer') as ArrayBuffer;
  return new Uint8Array(arrayBuffer);
}

async function deliver(envValue: Env, row: EmailOutboxRow): Promise<{ delivered: boolean; detail: string }> {
  const recipient = recipientFor(row);
  const built = buildOutboxEmail(row);
  if (!recipient || !built) {
    return { delivered: false, detail: 'no-valid-recipient-or-content' };
  }
  if (!envValue.resendApiKey) {
    // Quiet no-op: Resend optional by design. Recorded but never fails the run.
    return { delivered: false, detail: 'resend-not-configured' };
  }

  let attachments: ResendAttachment[] = [];
  let pdfFallback: string | undefined;
  if (built.model && built.pdfFileName) {
    try {
      const bytes = generateExpiryPdf(built.model, jsPDF);
      attachments = [{
        filename: built.pdfFileName,
        content: bytesToBase64(bytes),
        content_type: 'application/pdf',
      }];
    } catch {
      // Prefer delivering the HTML/text report without the attachment over
      // sending nothing. The sanitized detail records the fallback honestly.
      attachments = [];
      pdfFallback = 'delivered-without-pdf';
    }
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
        subject: built.subject,
        text: built.text,
        html: built.html,
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      return { delivered: false, detail: `resend-http-${response.status}: ${sanitizeDetail(bodyText)}` };
    }
    return { delivered: true, detail: pdfFallback ?? 'sent' };
  } catch (error) {
    return {
      delivered: false,
      detail: sanitizeDetail(error instanceof Error ? error.message : 'unknown-send-error'),
    };
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
