import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { createAppStore } from '../src/lib/store';
import { setTimingSink, startTimingSpan } from '../src/lib/timing';

/**
 * v0.1.8 Issue B — sign-in timing logs. They must say WHERE the time goes and
 * must never contain credentials or customer data.
 */

const EMAIL = 'private.person@example.com';
const PASSWORD = 'S3cret-Pa55word!';
const session = {
  access_token: 'eyJhbGciOi.ACCESS-TOKEN-VALUE.sig',
  refresh_token: 'REFRESH-TOKEN-VALUE',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: { id: 'user-uuid-1234', email: EMAIL, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00.000Z' },
} as Session;

function client(profileRole: 'admin' | 'office' = 'admin'): AuthClientLike {
  return {
    auth: {
      signInWithPassword: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { data: { session, user: session.user }, error: null };
      }) as never,
      getSession: vi.fn(async () => ({ data: { session }, error: null })) as never,
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) as never,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 10));
            return { data: { id: 'user-uuid-1234', email: EMAIL, role: profileRole, full_name: 'Private Person' }, error: null };
          }),
        })),
      })),
    })) as never,
  };
}

let restoreSink: (() => void) | undefined;
afterEach(() => restoreSink?.());

function capture(): string[] {
  const lines: string[] = [];
  restoreSink = setTimingSink((line) => lines.push(line));
  return lines;
}

function assertNoSecrets(lines: string[]) {
  const joined = lines.join('\n');
  for (const secret of [EMAIL, PASSWORD, 'ACCESS-TOKEN-VALUE', 'REFRESH-TOKEN-VALUE', 'user-uuid-1234', 'Private Person', '@']) {
    expect(joined).not.toContain(secret);
  }
}

describe('sign-in timing logs', () => {
  it('emits one sign-in line with the auth call and profile fetch split out', async () => {
    const lines = capture();
    const store = createAppStore(new AuthService(client()), null);
    await store.getState().signIn(EMAIL, PASSWORD);
    const signin = lines.filter((l) => l.startsWith('[dks:timing] signin '));
    expect(signin).toHaveLength(1);
    expect(signin[0]).toMatch(/^\[dks:timing\] signin auth=\d+ms profile=\d+ms total=\d+ms outcome=ok role=admin$/);
    const auth = Number(/auth=(\d+)ms/.exec(signin[0])![1]);
    expect(auth).toBeGreaterThanOrEqual(25);
    assertNoSecrets(lines);
  });

  it('a failed sign-in logs the error CODE only', async () => {
    const lines = capture();
    const c = client();
    (c.auth.signInWithPassword as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { message: `Invalid login credentials for ${EMAIL}`, code: 'invalid_credentials', status: 400 },
    });
    const store = createAppStore(new AuthService(c), null);
    await store.getState().signIn(EMAIL, PASSWORD);
    expect(lines.find((l) => l.includes(' signin '))).toMatch(/outcome=error code=invalid_credentials$/);
    assertNoSecrets(lines);
  });

  it('restore logs session/profile phases and attempts', async () => {
    const lines = capture();
    const store = createAppStore(new AuthService(client()), null);
    await store.getState().restoreSession();
    expect(lines.find((l) => l.startsWith('[dks:timing] restore '))).toMatch(/session=\d+ms profile=\d+ms total=\d+ms outcome=ok role=admin attempts=1$/);
    assertNoSecrets(lines);
  });

  it('only allow-listed keys with safe values are ever written', () => {
    const lines = capture();
    const span = startTimingSpan('signin');
    span.mark('auth');
    span.end({ outcome: 'ok', code: EMAIL, role: 'admin', email: EMAIL, token: 'abc' } as never);
    expect(lines[0]).toMatch(/^\[dks:timing\] signin auth=\d+ms total=\d+ms outcome=ok role=admin$/);
    assertNoSecrets(lines);
  });

  it('the main process forwards ONLY [dks:timing] renderer lines to main.log', () => {
    const main = readFileSync(resolve(__dirname, '../electron/main/index.ts'), 'utf8');
    expect(main).toContain("export const RENDERER_TIMING_PREFIX = '[dks:timing] ';");
    expect(main).toMatch(/candidate\.startsWith\(RENDERER_TIMING_PREFIX\)/);
    expect(main).toContain('forwardRendererDiagnostics(window);');
  });
});
