import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { createOfficeApprovalService } from '../src/features/auth/office-approval-service';
import { createAppStore } from '../src/lib/store';
import { prewarmSupabaseConnection, resetSupabasePrewarm } from '../src/lib/supabase';
import { setTimingSink } from '../src/lib/timing';

/**
 * v0.1.8 Issue B — the sign-in request waterfall, measured with the REAL
 * supabase-js client + real AuthService + real store against a fake fetch.
 *
 * Measured before (be1aad9, same harness, 200 ms RTT): Admin = token, then TWO
 * identical profile GETs (the auth listener raced signIn); Office additionally
 * my_office_signin → request_office_signin (signIn's own request was skipped
 * because the listener bumped the request id) = 4 serial round trips.
 * Now: Admin = token → profile; Office = token → profile → request_office_signin.
 */

const URL_BASE = 'https://example.supabase.co';
const now = Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: now + 3600, session_id: 's1', role: 'authenticated', aud: 'authenticated' })}.sig`;

interface Hit { path: string; start: number; end: number }

function harness(role: 'admin' | 'office', options: { rtt?: number; coldSetupRtts?: number } = {}) {
  const rtt = options.rtt ?? 20;
  const hits: Hit[] = [];
  let t0 = Date.now();
  let connectionOpenUntil = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url ?? String(input));
    const start = Date.now() - t0;
    // MODEL (not a measurement): a request on a cold connection first pays
    // `coldSetupRtts` round trips of DNS/TCP/TLS; the connection then stays up.
    const setup = options.coldSetupRtts && Date.now() > connectionOpenUntil ? options.coldSetupRtts * rtt : 0;
    await new Promise((r) => setTimeout(r, setup + rtt));
    connectionOpenUntil = Date.now() + 60_000;
    hits.push({ path: url.pathname, start, end: Date.now() - t0 });
    let body: unknown = {};
    if (url.pathname.endsWith('/auth/v1/token')) body = { access_token: jwt, refresh_token: 'r1', expires_in: 3600, expires_at: now + 3600, token_type: 'bearer', user: { id: 'u1', email: 'x@y.z', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
    if (url.pathname.endsWith('/rest/v1/profiles')) body = { id: 'u1', email: 'x@y.z', role, full_name: 'X' };
    if (url.pathname.endsWith('/rpc/my_office_signin')) body = null;
    if (url.pathname.endsWith('/rpc/request_office_signin')) body = { id: 'req1', user_id: 'u1', status: 'pending', requested_at: new Date().toISOString(), auth_session_id: 's1' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createClient(URL_BASE, 'pk', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
  const store = createAppStore(new AuthService(client as unknown as AuthClientLike), createOfficeApprovalService(client as never));
  return {
    store,
    hits,
    fetchImpl,
    resetClock: () => { t0 = Date.now(); hits.length = 0; },
  };
}

let restoreSink: (() => void) | undefined;
afterEach(() => { restoreSink?.(); resetSupabasePrewarm(); });

describe('sign-in waterfall (real supabase-js)', () => {
  it('Admin: exactly one password grant, then exactly one profile read — nothing else on the button path', async () => {
    restoreSink = setTimingSink(() => undefined);
    const h = harness('admin');
    await h.store.getState().signIn('x@y.z', 'pw');
    expect(h.store.getState().authStatus).toBe('authenticated');
    expect(h.hits.map((x) => x.path)).toEqual(['/auth/v1/token', '/rest/v1/profiles']);
    expect(h.hits[1].start).toBeGreaterThanOrEqual(h.hits[0].end - 2); // serial: profile needs the JWT
  });

  it('Office: password grant → profile → ONE request_office_signin (no extra my_office_signin round trip)', async () => {
    restoreSink = setTimingSink(() => undefined);
    const h = harness('office');
    await h.store.getState().signIn('x@y.z', 'pw');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.hits.map((x) => x.path)).toEqual(['/auth/v1/token', '/rest/v1/profiles', '/rest/v1/rpc/request_office_signin']);
    expect(h.store.getState().sessionApproval).toBe('pending');
  });

  it('MODEL: with a cold connection, the warm-up while the form is shown removes setup from the click path', async () => {
    const lines: string[] = [];
    restoreSink = setTimingSink((l) => lines.push(l));
    const rtt = 40;

    const cold = harness('admin', { rtt, coldSetupRtts: 3 });
    await cold.store.getState().signIn('x@y.z', 'pw');
    const coldAuth = cold.hits[0].end - cold.hits[0].start;

    const warm = harness('admin', { rtt, coldSetupRtts: 3 });
    await prewarmSupabaseConnection({ url: URL_BASE, publishableKey: 'pk' }, warm.fetchImpl);
    warm.resetClock();
    await warm.store.getState().signIn('x@y.z', 'pw');
    const warmAuth = warm.hits[0].end - warm.hits[0].start;

    expect(warm.hits.map((x) => x.path)).toEqual(['/auth/v1/token', '/rest/v1/profiles']); // health was before the click
    expect(coldAuth - warmAuth).toBeGreaterThanOrEqual(3 * rtt - 15);
    expect(lines.filter((l) => l.includes(' signin ')).at(-1)).toMatch(/warm=yes$/);
    expect(lines.filter((l) => l.includes(' signin '))[0]).toMatch(/warm=no$/);
  });
});
