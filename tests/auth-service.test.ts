import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';

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

function makeClient(options?: {
  profile?: Record<string, unknown> | null;
  profileError?: { message: string; code?: string } | null;
  restoredSession?: Session | null;
}) {
  let listener: ((event: string, nextSession: Session | null) => void) | undefined;
  const signInWithPassword = vi.fn().mockResolvedValue({ data: { session, user: session.user }, error: null });
  const getSession = vi.fn().mockResolvedValue({
    data: { session: options?.restoredSession ?? null },
    error: null,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const maybeSingle = vi.fn().mockResolvedValue({
    data: options?.profile === undefined
      ? { id: 'user-1', email: 'admin@example.com', role: 'admin' }
      : options.profile,
    error: options?.profileError ?? null,
  });

  const client: AuthClientLike = {
    auth: {
      signInWithPassword,
      getSession,
      signOut,
      onAuthStateChange: vi.fn((callback) => {
        listener = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
    })),
  };

  return {
    client,
    signInWithPassword,
    getSession,
    signOut,
    maybeSingle,
    emitAuthChange: (event: string, nextSession: Session | null) => listener?.(event, nextSession),
  };
}

describe('AuthService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('signs in and returns the authenticated session with its role profile', async () => {
    const fake = makeClient();
    const service = new AuthService(fake.client);

    const result = await service.signIn('admin@example.com', 'correct horse battery staple');

    expect(fake.signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    });
    expect(result.error).toBeNull();
    expect(result.data?.session).toBe(session);
    expect(result.data?.profile.role).toBe('admin');
  });

  it('restores a persisted session through the Supabase client', async () => {
    const fake = makeClient({ restoredSession: session });
    const service = new AuthService(fake.client);

    const result = await service.restoreSession();

    expect(fake.getSession).toHaveBeenCalledOnce();
    expect(result.data?.session).toBe(session);
    expect(result.data?.profile.email).toBe('admin@example.com');
  });

  it('signs out and returns Not authorized when the profile is missing', async () => {
    const fake = makeClient({ profile: null });
    const service = new AuthService(fake.client);

    const result = await service.signIn('admin@example.com', 'password');

    expect(fake.signOut).toHaveBeenCalledOnce();
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe('Not authorized');
    expect(result.error?.code).toBe('NOT_AUTHORIZED');
  });

  it('forwards auth state changes to subscribers and allows unsubscribe', async () => {
    const fake = makeClient();
    const service = new AuthService(fake.client);
    const listener = vi.fn();

    const unsubscribe = service.onAuthStateChange(listener);
    fake.emitAuthChange('SIGNED_IN', session);

    expect(listener).toHaveBeenCalledWith('SIGNED_IN', session);
    unsubscribe();
  });
});
