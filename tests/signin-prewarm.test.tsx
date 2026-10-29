import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PREWARM_TTL_MS,
  isSupabaseConnectionWarm,
  prewarmSupabaseConnection,
  resetSupabasePrewarm,
} from '../src/lib/supabase';

/**
 * v0.1.8 Issue B fix — the connection to Supabase is opened while the sign-in
 * form is visible, so the password request no longer pays DNS/TCP/TLS on the
 * click path. Pure optimisation: no credentials, never awaited by sign-in.
 */

const config = { url: 'https://project.supabase.co/', publishableKey: 'sb_publishable_PUBLIC' };

afterEach(() => {
  resetSupabasePrewarm();
  vi.restoreAllMocks();
});

describe('prewarmSupabaseConnection', () => {
  it('sends ONE unauthenticated GET /auth/v1/health with only the public key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(prewarmSupabaseConnection(config, fetchImpl as never)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/auth/v1/health');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ apikey: 'sb_publishable_PUBLIC' });
    expect(init.body).toBeUndefined();
    expect(isSupabaseConnectionWarm()).toBe(true);
  });

  it('dedupes concurrent calls and throttles to one request per TTL', async () => {
    let t = 1_000_000;
    const now = () => t;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await Promise.all([
      prewarmSupabaseConnection(config, fetchImpl as never, now),
      prewarmSupabaseConnection(config, fetchImpl as never, now),
    ]);
    await prewarmSupabaseConnection(config, fetchImpl as never, now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += PREWARM_TTL_MS + 1;
    expect(isSupabaseConnectionWarm(now)).toBe(false);
    await prewarmSupabaseConnection(config, fetchImpl as never, now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a failed warm-up is harmless: resolves false, not marked warm, retried next time', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(prewarmSupabaseConnection(config, fetchImpl as never)).resolves.toBe(false);
    expect(isSupabaseConnectionWarm()).toBe(false);
    await prewarmSupabaseConnection(config, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without configuration', async () => {
    const fetchImpl = vi.fn();
    await expect(prewarmSupabaseConnection(null, fetchImpl as never)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('AuthScreen triggers the warm-up', () => {
  it('on mount and on email/password focus (throttling lives in the helper)', async () => {
    const supabaseModule = await import('../src/lib/supabase');
    const spy = vi.spyOn(supabaseModule, 'prewarmSupabaseConnection').mockResolvedValue(true);
    const { AuthScreen } = await import('../src/features/auth/AuthScreen');
    render(<AuthScreen health={{ configured: true, reachable: 'unknown', authenticated: false, error: null }} />);
    expect(spy).toHaveBeenCalledTimes(1);
    fireEvent.focus(screen.getByLabelText('Email'));
    fireEvent.focus(screen.getByLabelText('Password'));
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('never warms an unconfigured (demo) screen', async () => {
    const supabaseModule = await import('../src/lib/supabase');
    const spy = vi.spyOn(supabaseModule, 'prewarmSupabaseConnection').mockResolvedValue(true);
    const { AuthScreen } = await import('../src/features/auth/AuthScreen');
    render(<AuthScreen />);
    fireEvent.focus(screen.getByLabelText('Email'));
    expect(spy).not.toHaveBeenCalled();
  });
});
