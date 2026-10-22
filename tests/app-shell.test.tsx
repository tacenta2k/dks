/**
 * App shell behaviour through the REAL authenticated flow.
 *
 * These tests previously clicked the offline-demo "Continue to workspace"
 * entry, which only exists when Supabase is unconfigured — on machines with a
 * configured .env the button never renders and the tests failed. They now
 * sign in through the real AuthService (form sign-in or restored session),
 * exactly like production, with no login bypass.
 */
import type { Session } from '@supabase/supabase-js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { App } from '../src/renderer/App';

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

function makeClient(profile: Record<string, unknown> | null, restoredSession: Session | null = null) {
  const client: AuthClientLike = {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session, user: session.user }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: restoredSession }, error: null }),
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

async function signInThroughForm() {
  await screen.findByRole('heading', { name: 'Sign in to DKS' });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  return waitFor(() => expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument());
}

describe('DKS renderer shell', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the real sign-in screen before a session is available', async () => {
    const service = new AuthService(makeClient(null));
    render(<App authService={service} />);

    expect(await screen.findByRole('heading', { name: 'Sign in to DKS' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders the dashboard shell after signing in through the real login form', async () => {
    const client = makeClient({ id: 'user-1', role: 'admin' });
    const service = new AuthService(client);
    render(<App authService={service} />);

    await signInThroughForm();

    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'password',
    });
    expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Your workspace is ready for the next step.')).toBeInTheDocument();
  });

  it('switches between dashboard and sheet from the sidebar with a restored session', async () => {
    const service = new AuthService(makeClient({ id: 'user-1', role: 'admin' }, session));
    render(<App authService={service} initialView="dashboard" />);

    await screen.findByRole('banner', { name: 'DKS top bar' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Sheet' }));

    expect(screen.getByRole('heading', { name: 'Visa sheet' })).toBeInTheDocument();
    expect(screen.getByText('Your visa records will appear here in STEP 4.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Dashboard' })).toHaveAttribute('aria-current', 'false');
  });

  it('changes and persists the selected theme from the top bar after sign-in', async () => {
    const service = new AuthService(makeClient({ id: 'user-1', role: 'admin' }, session));
    render(<App authService={service} />);

    await screen.findByRole('banner', { name: 'DKS top bar' });

    fireEvent.click(screen.getByRole('button', { name: /theme: system/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('dks.theme-preference')).toBe('dark');
  });
});
