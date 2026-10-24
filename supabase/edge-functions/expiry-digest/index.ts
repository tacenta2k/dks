/**
 * DKS expiry-digest Edge Function skeleton.
 *
 * The scheduler can POST a precomputed digest to this function.  Resend is
 * intentionally optional: a project without RESEND_API_KEY gets a quiet 204
 * response, so local/offline operation never depends on email delivery.
 * Deploy this function with the normal Supabase JWT gateway protection.
 */

type DigestEntry = {
  label?: unknown;
  expiry?: unknown;
  daysLeft?: unknown;
};

type DigestRequest = {
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  entries?: unknown;
  summary?: unknown;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function recipientsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function defaultMessage(body: DigestRequest): { text: string; html: string } {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const lines = entries.map((entry) => {
    const item = (entry ?? {}) as DigestEntry;
    return `${String(item.label ?? 'Entry')}: ${String(item.expiry ?? 'No expiry')} (${String(item.daysLeft ?? 'unknown')} days left)`;
  });
  const text = typeof body.summary === 'string'
    ? body.summary
    : lines.length > 0
      ? lines.join('\n')
      : 'No expiry items require attention.';

  return {
    text,
    html: `<h1>DKS expiry digest</h1><pre>${escapeHtml(text)}</pre>`,
  };
}

Deno.serve(async (request) => {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');

  // Missing email configuration is an expected deployment state.  Do not log
  // it and do not make a network request in that case.
  if (!resendApiKey) {
    return new Response(null, { status: 204 });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST required' }, 405);
  }

  let body: DigestRequest;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse({ error: 'Request body must be an object' }, 400);
    }
    body = parsed as DigestRequest;
  } catch {
    return jsonResponse({ error: 'Request body must be JSON' }, 400);
  }

  const recipients = recipientsFrom(body.to ?? Deno.env.get('EXPIRY_DIGEST_TO'));
  const from = Deno.env.get('RESEND_FROM_EMAIL');
  if (!from || recipients.length === 0) {
    return jsonResponse({ error: 'Email recipient and sender are not configured' }, 400);
  }

  const fallback = defaultMessage(body);
  const text = typeof body.text === 'string' ? body.text : fallback.text;
  const html = typeof body.html === 'string' ? body.html : fallback.html;
  const subject = typeof body.subject === 'string' && body.subject.trim().length > 0
    ? body.subject
    : 'DKS expiry digest';

  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject,
        text,
        html,
      }),
    });

    if (!resendResponse.ok) {
      return jsonResponse({ error: 'Email delivery failed' }, 502);
    }

    const result = (await resendResponse.json().catch(() => ({}))) as { id?: unknown };
    return jsonResponse({ ok: true, id: typeof result.id === 'string' ? result.id : null });
  } catch {
    return jsonResponse({ error: 'Email delivery failed' }, 502);
  }
});
// NOTE (v2): the daily digest is now built server-side by
// public.enqueue_expiry_digest() into public.email_outbox and delivered by the
// sibling `send-email` Edge Function. This standalone manual-trigger endpoint
// stays as an operator fallback (POST a precomputed digest); both paths are
// optional and fail quietly without RESEND_API_KEY.
