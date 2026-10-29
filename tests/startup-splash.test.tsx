import type { Session } from '@supabase/supabase-js';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { createAppStore } from '../src/lib/store';
import { App } from '../src/renderer/App';

/**
 * v0.1.7 — no login-form flash on start-up. While the persisted session is
 * being restored the App shows a neutral splash (logo + spinner); the
 * email/password AuthScreen appears only once restoration has finished AND
 * there is no session.
 */

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'user-admin',
    email: 'admin@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeClient(
  getSession: () => Promise<{ data: { session: Session | null }; error: null }>,
  profile: Record<string, unknown> | null = { id: 'user-admin', role: 'admin', email: 'admin@example.com' },
) {
  const client: AuthClientLike = {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session, user: session.user }, error: null }),
      getSession: vi.fn(getSession),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }) })),
      })),
    })),
  };
  return client;
}

describe('start-up session restore (v0.1.7 auth flicker)', () => {
  it('shows the neutral splash — never the login form — while a saved session restores', async () => {
    const pending = deferred<{ data: { session: Session | null }; error: null }>();
    const service = new AuthService(makeClient(() => pending.promise));

    render(<App authService={service} approvalService={null} />);

    // First paint: splash only. No email/password inputs, no sign-in copy.
    expect(screen.getByTestId('startup-splash')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading DKS' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to DKS' })).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({ data: { session }, error: null });
    });

    // Straight from the splash to the workspace.
    expect(await screen.findByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('renders the AuthScreen only after restoration finishes with no session', async () => {
    const pending = deferred<{ data: { session: Session | null }; error: null }>();
    const service = new AuthService(makeClient(() => pending.promise));

    render(<App authService={service} approvalService={null} />);
    expect(screen.getByTestId('startup-splash')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({ data: { session: null }, error: null });
    });

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument();
  });

  it('falls back to the AuthScreen when restoration fails', async () => {
    const client = makeClient(async () => { throw new Error('network down'); });
    const service = new AuthService(client);

    render(<App authService={service} approvalService={null} />);

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument();
  });

  it('never shows the splash when there is no configured client to restore from', () => {
    render(<App authService={new AuthService(null)} approvalService={null} demoMode={false} />);

    expect(screen.queryByTestId('startup-splash')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});

describe('store isRestoringSession flag', () => {
  it('starts true for a configured client and clears on every restore outcome', async () => {
    const withSession = createAppStore(new AuthService(makeClient(async () => ({ data: { session }, error: null }))), null);
    expect(withSession.getState().isRestoringSession).toBe(true);
    await withSession.getState().restoreSession();
    expect(withSession.getState().isRestoringSession).toBe(false);
    expect(withSession.getState().authStatus).toBe('authenticated');

    const withoutSession = createAppStore(new AuthService(makeClient(async () => ({ data: { session: null }, error: null }))), null);
    await withoutSession.getState().restoreSession();
    expect(withoutSession.getState().isRestoringSession).toBe(false);
    expect(withoutSession.getState().authStatus).toBe('unauthenticated');
  });

  it('is false for an unconfigured client and after a reset', () => {
    const store = createAppStore(new AuthService(null), null);
    expect(store.getState().isRestoringSession).toBe(false);

    const configured = createAppStore(new AuthService(makeClient(() => new Promise(() => undefined))), null);
    configured.getState().reset();
    expect(configured.getState().isRestoringSession).toBe(false);
  });

  it('keeps a restored Office session on the neutral checking state until approval resolves', async () => {
    const store = createAppStore(
      new AuthService(makeClient(
        async () => ({ data: { session }, error: null }),
        { id: 'user-admin', role: 'office', email: 'office@example.com' },
      )),
      {
        requestApproval: vi.fn(() => new Promise(() => undefined)),
        fetchMyRequest: vi.fn(() => new Promise(() => undefined)),
        listRequests: vi.fn(),
        decideRequest: vi.fn(),
        revokeRequest: vi.fn(),
        signOutAllOfficeSessions: vi.fn(),
      } as never,
    );

    await store.getState().restoreSession();

    await waitFor(() => expect(store.getState().authStatus).toBe('authenticated'));
    // Never a transient "cannot verify" state; the gate stays closed.
    expect(store.getState().sessionApproval).toBe('checking');
    expect(store.getState().isRestoringSession).toBe(false);
  });
});
