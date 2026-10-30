// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  type ErrorReportWorkerEnv,
  MAX_ERROR_REPORT_BYTES,
  handleErrorReportRequest,
  resetWorkerRateStateForTests,
} from '../supabase/edge-functions/_shared/error-report';

const TEST_ENV: ErrorReportWorkerEnv = {
  supabaseUrl: 'https://project.supabase.co',
  supabaseAnonKey: 'sb_anon_test_key',
  serviceRoleKey: 'sb_service_role_secret',
  githubToken: 'github_pat_server_only_secret',
  githubRepo: 'tacenta2k/dks',
};

const VALID_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI4NDY1MzZhZi1mM2M2LTQ3YzEtODU1OS1kMTM0NDJjMTQ5MGEifQ.signature_part_12345';

function makeValidPayload(overrides?: Record<string, unknown>) {
  return {
    fingerprint: '0123456789abcdef0123456789abcdef01234567',
    category: 'sync',
    severity: 'error',
    code: 'SYNC_OUTBOX_TERMINAL',
    component: 'renderer/supabase-sync',
    process: 'renderer',
    appVersion: '1.1.3',
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.22631',
    electronVersion: '33.4.0',
    packaged: true,
    sqliteSchemaVersion: 4,
    httpStatus: 500,
    postgresCode: '42501',
    occurrences: 2,
    firstOccurredAt: '2026-10-29T10:00:00Z',
    lastOccurredAt: '2026-10-29T10:05:00Z',
    ...overrides,
  };
}

describe('report-error Edge Function worker', () => {
  it('handles OPTIONS preflight, rejects non-POST (405), and requires application/json (415)', async () => {
    const preflight = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', { method: 'OPTIONS' }),
      { env: TEST_ENV },
    );
    expect(preflight.status).toBe(204);

    const getRes = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', { method: 'GET' }),
      { env: TEST_ENV },
    );
    expect(getRes.status).toBe(405);

    const wrongType = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      }),
      { env: TEST_ENV },
    );
    expect(wrongType.status).toBe(415);
  });

  it('enforces the 4 KiB request size limit even without Content-Length (413)', async () => {
    const hugeBody = JSON.stringify({
      ...makeValidPayload(),
      padding: 'x'.repeat(MAX_ERROR_REPORT_BYTES + 200),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(hugeBody));
        controller.close();
      },
    });
    const req = new Request('https://project.supabase.co/functions/v1/report-error', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_JWT}`,
        'Content-Type': 'application/json',
      },
      body: stream,
      // @ts-expect-error Node undici duplex option for streaming Request
      duplex: 'half',
    });

    const res = await handleErrorReportRequest(req, { env: TEST_ENV });
    expect(res.status).toBe(413);
  });

  it('rejects missing/malformed tokens (401), unapproved sessions (403), and non-allowlisted fields (400)', async () => {
    const noAuth = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV },
    );
    expect(noAuth.status).toBe(401);

    // Payload with PII or extra field rejected with 400 BEFORE calling Supabase or GitHub:
    const fetchNeverCalled = vi.fn();
    const badPayload = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload({ customerEmail: 'customer@example.com' })),
      }),
      { env: TEST_ENV, fetchImpl: fetchNeverCalled as unknown as typeof fetch },
    );
    expect(badPayload.status).toBe(400);
    expect(fetchNeverCalled).not.toHaveBeenCalled();

    // Unapproved Office session -> verify_error_report_caller returns 403 -> worker returns 403:
    const deniedFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'An approved DKS session is required' }), {
        status: 403,
      }),
    );
    const forbidden = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV, fetchImpl: deniedFetch as unknown as typeof fetch },
    );
    expect(forbidden.status).toBe(403);
    expect(deniedFetch).toHaveBeenCalledTimes(1);
  });

  it('enforces server-side 429 rate limits with Retry-After and skips GitHub when workspace reporting is disabled', async () => {
    resetWorkerRateStateForTests();

    const disabledFetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authorized: true,
          user_id: '846536af-f3c6-47c1-8559-d13442c1490a',
          role: 'admin',
          reporting_enabled: false,
        }),
        { status: 200 },
      ),
    );
    const disabledRes = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV, fetchImpl: disabledFetch as unknown as typeof fetch },
    );
    expect(disabledRes.status).toBe(200);
    await expect(disabledRes.json()).resolves.toMatchObject({ ok: true, action: 'disabled' });
    expect(disabledFetch).toHaveBeenCalledTimes(1);

    const rateLimitedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorized: true,
            user_id: '846536af-f3c6-47c1-8559-d13442c1490a',
            role: 'office',
            reporting_enabled: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            action: 'rate_limited_user',
            retry_after_seconds: 600,
          }),
          { status: 200 },
        ),
      );

    const rlRes = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV, fetchImpl: rateLimitedFetch as unknown as typeof fetch },
    );
    expect(rlRes.status).toBe(429);
    expect(rlRes.headers.get('retry-after')).toBe('600');
  });

  it('creates a sanitized public-safe GitHub Issue (with 422 missing-label fallback) and honors GitHub secondary rate-limit Retry-After', async () => {
    resetWorkerRateStateForTests();
    const githubBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/rest/v1/rpc/verify_error_report_caller')) {
        return new Response(
          JSON.stringify({
            authorized: true,
            user_id: '846536af-f3c6-47c1-8559-d13442c1490a',
            role: 'admin',
            reporting_enabled: true,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/rest/v1/rpc/ingest_error_report')) {
        return new Response(
          JSON.stringify({
            ok: true,
            action: 'create_issue',
            event_id: '11111111-1111-1111-1111-111111111111',
            issue_number: null,
            total_occurrences: 2,
            platforms: ['win32-x64'],
          }),
          { status: 200 },
        );
      }
      if (url === 'https://api.github.com/repos/tacenta2k/dks/issues') {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        githubBodies.push(parsed);
        if (Array.isArray(parsed.labels)) {
          return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
        }
        return new Response(
          JSON.stringify({
            number: 77,
            html_url: 'https://github.com/tacenta2k/dks/issues/77',
          }),
          { status: 201 },
        );
      }
      if (url.endsWith('/rest/v1/rpc/complete_error_report_delivery')) {
        return new Response(JSON.stringify({ ok: true, status: 'issue_created' }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const created = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      ok: true,
      action: 'issue_created',
      issueNumber: 77,
    });
    expect(githubBodies).toHaveLength(2);
    const sentIssue = githubBodies[1];
    expect(String(sentIssue.title)).toContain('SYNC_OUTBOX_TERMINAL');
    expect(String(sentIssue.body)).toContain('0123456789abcdef0123456789abcdef01234567');
    // Confirm reporter UUID and GitHub PAT NEVER appear in the public GitHub issue body!
    expect(String(sentIssue.body)).not.toContain('846536af-f3c6-47c1-8559-d13442c1490a');
    expect(String(sentIssue.body)).not.toContain('github_pat_server_only_secret');

    // Now simulate GitHub returning 429 with Retry-After: 90 -> sets in-worker cooldown!
    let ghApiCalls = 0;
    const gh429Fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/verify_error_report_caller')) {
        return new Response(
          JSON.stringify({
            authorized: true,
            user_id: '846536af-f3c6-47c1-8559-d13442c1490a',
            role: 'admin',
            reporting_enabled: true,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/ingest_error_report')) {
        return new Response(
          JSON.stringify({
            ok: true,
            action: 'comment_issue',
            event_id: '22222222-2222-2222-2222-222222222222',
            issue_number: 77,
            total_occurrences: 5,
            platforms: ['win32-x64'],
          }),
          { status: 200 },
        );
      }
      if (url.includes('api.github.com')) {
        ghApiCalls += 1;
        return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
          status: 429,
          headers: { 'retry-after': '90' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const ghLimited = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV, fetchImpl: gh429Fetch as unknown as typeof fetch, nowMs: () => 1_000_000 },
    );
    expect(ghLimited.status).toBe(429);
    expect(ghLimited.headers.get('retry-after')).toBe('90');
    expect(ghApiCalls).toBe(1);

    // Immediate next request within the 90s cooldown does NOT call api.github.com again!
    const cooledDown = await handleErrorReportRequest(
      new Request('https://project.supabase.co/functions/v1/report-error', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VALID_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeValidPayload()),
      }),
      { env: TEST_ENV, fetchImpl: gh429Fetch as unknown as typeof fetch, nowMs: () => 1_010_000 },
    );
    expect(cooledDown.status).toBe(429);
    expect(ghApiCalls).toBe(1);

    resetWorkerRateStateForTests();
  });
});
