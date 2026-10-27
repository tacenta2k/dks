/**
 * Outbox email assembly — pure, dependency-free, shared by the `send-email`
 * Edge Function and the vitest suite.
 *
 * Keeping this out of the Edge Function file means the email CONTENT (subject,
 * HTML, plain text, attachment decision) is unit tested without pulling the
 * Deno-only `npm:jspdf` import into the test program.
 *
 * The digest body stays short (one sentence + counts + record names/days left);
 * the per-column table only ever exists in the in-memory PDF attachment.
 */

import {
  buildDigestReportModel,
  muscatTodayIso,
  renderDigestHtml,
  renderDigestText,
  type DigestReportModel,
} from './digest-report.ts';
import { buildOfficeApprovalEmail, type EmailOutboxRow } from './email.ts';

export interface OutboxEmail {
  subject: string;
  text: string;
  html: string;
  /** Present only for the expiry digest; drives the in-memory PDF. */
  model: DigestReportModel | null;
  pdfFileName: string | null;
  /** Office sign-in notifications are ALWAYS attachment-free. */
  hasAttachment: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function buildOutboxEmail(
  row: Pick<EmailOutboxRow, 'kind' | 'payload'>,
): OutboxEmail | null {
  if (row.kind === 'office_signin_request') {
    const payload = asRecord(row.payload) ?? {};
    const requestedAt = typeof payload.requestedAt === 'string' ? payload.requestedAt : '';
    const email = buildOfficeApprovalEmail(requestedAt);
    return {
      subject: email.subject,
      text: email.text,
      html: email.html,
      model: null,
      pdfFileName: null,
      hasAttachment: false,
    };
  }

  if (row.kind === 'expiry_digest') {
    const payload = asRecord(row.payload) ?? {};
    const model = buildDigestReportModel({
      reportDateIso: typeof payload.reportDate === 'string' && payload.reportDate.trim()
        ? payload.reportDate.trim()
        : muscatTodayIso(),
      columns: Array.isArray(payload.columns) ? payload.columns : [],
      currency: payload.currency,
      // Admin-only PDF: full identifiers unless the row explicitly opted out.
      includeFullIds: payload.includeFullIds !== false,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      totalQualifying: typeof payload.totalQualifying === 'number' ? payload.totalQualifying : undefined,
    });
    return {
      subject: `DKS Daily Expiry Report — ${model.reportDateDisplay}`,
      text: renderDigestText(model),
      html: renderDigestHtml(model),
      model,
      pdfFileName: model.pdfFileName,
      hasAttachment: true,
    };
  }

  return null;
}

/**
 * Keep delivery details short and free of anything that could echo a secret
 * or a record payload; control characters are stripped.
 */
export function sanitizeDetail(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
