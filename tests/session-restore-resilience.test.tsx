import type { Session } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyAuthError, RESTORE_UNREACHABLE_CODE } from '../src/features/auth/auth-errors';
import { AuthService, type AuthClientLike, type AuthStateListener } from '../src/features/auth/auth-service';
import { createAppStore, RESTORE_RETRY_DELAYS_MS } from '../src/lib/store';
import { App } from '../src/renderer/App';

/**
 * v0.1.8 — Issue A (app layer) + follow-up (b).
 *
 * A saved Supabase session must survive a transient failure on the first
 * launch after an update (network not up yet, server 5xx, timeout): the
 * restore retries with back-off instead of swapping the session for the
 * email/password form. Definitive failures (no session, refresh token
 * rejected, NOT_AUTHORIZED) behave exactly as before. The 20 s splash
 * fallback always ends on a usable login form.
 */

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'someone@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

type GetSession = () => Promise<{ data: { session: Session | null }; error: unknown }>;

function retryableFetchError() {
  return Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
}

function makeClient(options: {
  getSession: GetSession;
  profile?: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  onListen?: (listener: AuthStateListener) => void;
  signIn?: () => Promise<unknown>;
}) {
  const profile = options.profile ?? (async () => ({ data: { id: 'user-1', role: 'admin', email: 'someone@example.com' }, error: null }));
  const maybeSingle = vi.fn(profile);
  const client: AuthClientLike = {
    auth: {
      signInWithPassword: vi.fn(options.signIn ?? (async () => ({ data: { session, user: session.user }, error: null }))) as never,
      getSession: vi.fn(options.getSession) as never,
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn((listener: AuthStateListener) => {
        options.onListen?.(listener);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }) as never,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
    })) as never,
  };
  return { client, maybeSingle };
}

const noSleep = { sleep: async () => undefined };

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyAuthError', () => {
  it('treats network / timeout / 5xx / 429 as transient', () => {
    expect(classifyAuthError({ message: 'x', cause: retryableFetchError() })).toBe('transient');
    expect(classifyAuthError({ message: 'TypeError: Failed to fetch' })).toBe('transient');
    expect(classifyAuthError({ message: 'x', cause: { status: 503 } })).toBe('transient');
    expect(classifyAuthError({ message: 'x', cause: { status: 429 } })).toBe('transient');
    expect(classifyAuthError({ message: 'request timed out' })).toBe('transient');
    expect(classifyAuthError({ message: 'x', code: 'PROFILE_LOAD_FAILED' })).toBe('transient');
  });

  it('treats a rejected session / refresh token and authorisation failures as definitive', () => {
    expect(classifyAuthError({ message: 'Invalid Refresh Token: Already Used', cause: Object.assign(new Error('Invalid Refresh Token: Already Used'), { name: 'AuthApiError', status: 400 }) })).toBe('definitive');
    expect(classifyAuthError({ message: 'x', cause: { status: 401 } })).toBe('definitive');
    expect(classifyAuthError({ message: 'not allowed', code: 'NOT_AUTHORIZED' })).toBe('definitive');
    expect(classifyAuthError({ message: 'something unknown' })).toBe('definitive');
    expect(classifyAuthError(null)).toBe('definitive');
  });
});

describe('store.restoreSession — transient failures keep the saved session', () => {
  it('retries a transient failure and lands on the workspace without a password', async () => {
    let calls = 0;
    const { client } = makeClient({
      getSession: async () => {
        calls += 1;
        if (calls < 3) return { data: { session: null }, error: retryableFetchError() };
        return { data: { session }, error: null };
      },
    });
    const store = createAppStore(new AuthService(client), null, noSleep);
    await store.getState().restoreSession();
    expect(calls).toBe(3);
    expect(store.getState().authStatus).toBe('authenticated');
    expect(store.getState().authError).toBeNull();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it('a transient PROFILE fetch failure is retried too (session valid, profile request lost)', async () => {
    let profileCalls = 0;
    const { client } = makeClient({
      getSession: async () => ({ data: { session }, error: null }),
      profile: async () => {
        profileCalls += 1;
        if (profileCalls === 1) return { data: null, error: { message: 'Failed to fetch', code: '' } };
        return { data: { id: 'user-1', role: 'admin', email: 'someone@example.com' }, error: null };
      },
    });
    const store = createAppStore(new AuthService(client), null, noSleep);
    await store.getState().restoreSession();
    expect(profileCalls).toBe(2);
    expect(store.getState().authStatus).toBe('authenticated');
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it('after the bounded retries it shows the "saved sign-in kept" error — and NEVER signs out', async () => {
    const getSession = vi.fn(async () => ({ data: { session: null }, error: retryableFetchError() }));
    const { client } = makeClient({ getSession });
    const sleeps: number[] = [];
    const store = createAppStore(new AuthService(client), null, { sleep: async (ms) => { sleeps.push(ms); } });
    await store.getState().restoreSession();
    expect(getSession).toHaveBeenCalledTimes(1 + RESTORE_RETRY_DELAYS_MS.length);
    expect(sleeps).toEqual([...RESTORE_RETRY_DELAYS_MS]);
    expect(RESTORE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(20_000); // inside the splash window
    expect(store.getState().authStatus).toBe('error');
    expect(store.getState().authError?.code).toBe(RESTORE_UNREACHABLE_CODE);
    expect(store.getState().isRestoringSession).toBe(false);
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it('a definitive rejection (refresh token already used) is NOT retried — login form as before', async () => {
    const rejected = Object.assign(new Error('Invalid Refresh Token: Already Used'), { name: 'AuthApiError', status: 400 });
    const getSession = vi.fn(async () => ({ data: { session: null }, error: rejected }));
    const { client } = makeClient({ getSession });
    const store = createAppStore(new AuthService(client), null, noSleep);
    await store.getState().restoreSession();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(store.getState().authStatus).toBe('error');
    expect(store.getState().authError?.code).not.toBe(RESTORE_UNREACHABLE_CODE);
  });

  it('NOT_AUTHORIZED is NOT retried and is not weakened', async () => {
    const getSession = vi.fn(async () => ({ data: { session }, error: null }));
    const { client } = makeClient({ getSession, profile: async () => ({ data: null, error: { message: 'no rows', code: 'PGRST116' } }) });
    const store = createAppStore(new AuthService(client), null, noSleep);
    await store.getState().restoreSession();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(store.getState().authStatus).toBe('unauthorized');
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it('a user who signs in while the restore is retrying wins; the late restore is discarded', async () => {
    const { client } = makeClient({ getSession: async () => ({ data: { session: null }, error: retryableFetchError() }) });
    let releaseSleep!: () => void;
    const store = createAppStore(new AuthService(client), null, {
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve; }),
    });
    const restoring = store.getState().restoreSession();
    await waitFor(() => expect(releaseSleep).toBeTypeOf('function'));
    await store.getState().signIn('someone@example.com', 'pw');
    expect(store.getState().authStatus).toBe('authenticated');
    releaseSleep();
    await restoring;
    expect(store.getState().authStatus).toBe('authenticated');
  });
});

describe('auth listener — no duplicate/racing profile loads, no eject on a blip', () => {
  it('SIGNED_IN emitted inside signIn() does not start a second profile load or discard the result', async () => {
    let listener!: AuthStateListener;
    const { client, maybeSingle } = makeClient({
      getSession: async () => ({ data: { session: null }, error: null }),
      onListen: (l) => { listener = l; },
      signIn: async () => {
        listener('SIGNED_IN', session); // auth-js notifies BEFORE signInWithPassword resolves
        return { data: { session, user: session.user }, error: null };
      },
    });
    const approval = {
      requestApproval: vi.fn(async () => ({ data: { id: 'r1', userId: 'user-1', status: 'pending', requestedAt: '', decidedAt: null, decidedBy: null, authSessionId: 's' }, error: null })),
      fetchMyRequest: vi.fn(async () => ({ data: null, error: null })),
      listRequests: vi.fn(), decideRequest: vi.fn(), revokeRequest: vi.fn(), signOutAllOfficeSessions: vi.fn(),
    };
    maybeSingle.mockImplementation(async () => ({ data: { id: 'user-1', role: 'office', email: 'o@example.com' }, error: null }));
    const store = createAppStore(new AuthService(client), approval as never, noSleep);
    await store.getState().signIn('o@example.com', 'pw');
    await waitFor(() => expect(store.getState().sessionApproval).toBe('pending'));
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    // signIn's own Office path ran (direct request), not the restart-recovery read.
    expect(approval.requestApproval).toHaveBeenCalledTimes(1);
    expect(approval.fetchMyRequest).not.toHaveBeenCalled();
  });

  it('TOKEN_REFRESHED + transient profile failure keeps an authenticated user signed in (fresh token adopted)', async () => {
    let listener!: AuthStateListener;
    let failProfile = false;
    const { client } = makeClient({
      getSession: async () => ({ data: { session }, error: null }),
      onListen: (l) => { listener = l; },
      profile: async () => (failProfile
        ? { data: null, error: { message: 'Failed to fetch', code: '' } }
        : { data: { id: 'user-1', role: 'admin', email: 'someone@example.com' }, error: null }),
    });
    const store = createAppStore(new AuthService(client), null, noSleep);
    await store.getState().restoreSession();
    expect(store.getState().authStatus).toBe('authenticated');
    failProfile = true;
    const refreshed = { ...session, access_token: 'access-token-2' } as Session;
    listener('TOKEN_REFRESHED', refreshed);
    await waitFor(() => expect(store.getState().session?.access_token).toBe('access-token-2'));
    expect(store.getState().authStatus).toBe('authenticated');
    expect(store.getState().profile?.id).toBe('user-1');
  });

  it('TOKEN_REFRESHED + NOT_AUTHORIZED still ends the session (not weakened)', async () => {
    let listener!: AuthStateListener;
    let deny = false;
    const { client } = makeClient({
      getSession: async () => ({ data: { session }, error: null }),
      onListen: (l) => { listener = l; },
      profile: async () => (deny
        ? { data: null, error: { message: 'permission denied', code: '42501' } }
        : { data: { id: 'user-1', role: 'admin', email: 'someone@example.com' }, error: null }),
    });
    const store = createAppStore(new AuthService(client), null, noSleep);
    await store.getState().restoreSession();
    deny = true;
    listener('TOKEN_REFRESHED', session);
    await waitFor(() => expect(store.getState().authStatus).toBe('unauthorized'));
    expect(store.getState().session).toBeNull();
  });
});

describe('App — follow-up (b): splash fallback and retry never strand the user', () => {
  it('after 20 s of a hanging restore the LOGIN FORM renders (not a broken state) and sign-in works', async () => {
    vi.useFakeTimers();
    const { client } = makeClient({ getSession: () => new Promise(() => undefined) });
    render(<App authService={new AuthService(client)} approvalService={null} />);
    expect(screen.getByTestId('startup-splash')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(19_999); });
    expect(screen.getByTestId('startup-splash')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(2); });

    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument();
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(email).toBeEnabled();
    expect(password).toBeEnabled();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    vi.useRealTimers();

    fireEvent.change(email, { target: { value: 'someone@example.com' } });
    fireEvent.change(password, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
  });

  it('server unreachable → login form + "Retry saved sign-in"; Retry restores WITHOUT a password', async () => {
    let online = false;
    const { client } = makeClient({
      getSession: async () => (online
        ? { data: { session }, error: null }
        : { data: { session: null }, error: retryableFetchError() }),
    });
    render(<App authService={new AuthService(client)} approvalService={null} storeOptions={noSleep} />);

    const retry = await screen.findByRole('button', { name: 'Retry saved sign-in' });
    expect(screen.getByText(/Your saved sign-in is kept/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeEnabled(); // the form is still usable
    expect(client.auth.signOut).not.toHaveBeenCalled();

    online = true;
    fireEvent.click(retry);
    expect(await screen.findByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('no Retry button for an ordinary signed-out start', async () => {
    const { client } = makeClient({ getSession: async () => ({ data: { session: null }, error: null }) });
    render(<App authService={new AuthService(client)} approvalService={null} storeOptions={noSleep} />);
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry saved sign-in' })).not.toBeInTheDocument();
  });
});
