import type { Session } from '@supabase/supabase-js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

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
    email: 'office@example.com',
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

describe('configured authentication flow', () => {
  it('restores a session and shows the office identity without admin navigation', async () => {
    const service = new AuthService(makeClient({ id: 'user-1', role: 'office' }, session));

    render(<App authService={service} />);

    expect(await screen.findByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    expect(screen.getByText('office@example.com')).toBeInTheDocument();
    expect(screen.getByText('Office')).toBeInTheDocument();
    expect(screen.getByText('Supabase healthy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /admin tools/i })).not.toBeInTheDocument();
  });

  it('shows the real login form and signs in with submitted credentials', async () => {
    const client = makeClient({ id: 'user-1', role: 'admin' });
    const service = new AuthService(client);

    render(<App authService={service} />);

    await screen.findByRole('heading', { name: 'Sign in to DKS' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument());
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'password',
    });
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /admin tools/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export data' })).toBeInTheDocument();
  });

  it('returns to the login screen after logout', async () => {
    const client = makeClient({ id: 'user-1', role: 'office' }, session);
    const service = new AuthService(client);

    render(<App authService={service} />);
    await screen.findByRole('banner', { name: 'DKS top bar' });

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in to DKS' })).toBeInTheDocument();
    expect(client.auth.signOut).toHaveBeenCalledOnce();
  });

  it('displays Not authorized and does not open the shell when the profile is unauthorized', async () => {
    const client = makeClient(null, session);
    const service = new AuthService(client);

    render(<App authService={service} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized');
    expect(screen.queryByRole('banner', { name: 'DKS top bar' })).not.toBeInTheDocument();
    expect(client.auth.signOut).toHaveBeenCalledOnce();
  });
});
