import type { Session } from '@supabase/supabase-js';

import { createSupabaseClient, supabase } from '../../lib/supabase';
import type {
  AuthChangeEvent,
  AuthError,
  AuthenticatedIdentity,
  AuthResult,
  Profile,
  Role,
} from './auth-types';

export interface AuthResponseData {
  session: Session | null;
  user: Session['user'] | null;
}

export interface AuthClientError {
  message: string;
  code?: string;
  status?: number;
}

export interface AuthClientLike {
  auth: {
    signInWithPassword: (credentials: {
      email: string;
      password: string;
    }) => Promise<{ data: AuthResponseData; error: AuthClientError | null }>;
    getSession: () => Promise<{
      data: { session: Session | null };
      error: AuthClientError | null;
    }>;
    signOut: (options?: { scope?: 'global' | 'local' | 'others' }) => Promise<{ error: AuthClientError | null }>;
    onAuthStateChange: (
      callback: (event: AuthChangeEvent, session: Session | null) => void,
    ) => {
      data?: { subscription?: { unsubscribe: () => void } };
      error?: AuthClientError | null;
    };
  };
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle?: () => Promise<{
          data: Record<string, unknown> | null;
          error: AuthClientError | null;
        }>;
        single?: () => Promise<{
          data: Record<string, unknown> | null;
          error: AuthClientError | null;
        }>;
      };
    };
  };
}

export type AuthStateListener = (event: AuthChangeEvent, session: Session | null) => void;

const NOT_AUTHORIZED: AuthError = {
  code: 'NOT_AUTHORIZED',
  message: 'Not authorized',
};

function toAuthError(error: unknown, fallback: string, code?: string): AuthError {
  if (error && typeof error === 'object' && 'message' in error) {
    const source = error as { message?: unknown; code?: unknown };
    return {
      message: typeof source.message === 'string' ? source.message : fallback,
      code: typeof source.code === 'string' ? source.code : code,
      cause: error,
    };
  }

  return { message: fallback, code, cause: error };
}

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'office';
}

function isUnauthorizedProfileError(error: AuthClientError): boolean {
  const code = error.code?.toLowerCase();
  const message = error.message.toLowerCase();
  return (
    code === 'pgrst116' ||
    code === '42501' ||
    error.status === 401 ||
    error.status === 403 ||
    message.includes('not authorized') ||
    message.includes('permission denied') ||
    message.includes('profile not found') ||
    message.includes('no rows')
  );
}

export class AuthService {
  private readonly client: AuthClientLike | null;

  constructor(client?: AuthClientLike | null) {
    this.client = client === undefined ? supabase ?? createSupabaseClient() : client;
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  get authClient(): AuthClientLike | null {
    return this.client;
  }

  async signIn(email: string, password: string): Promise<AuthResult<AuthenticatedIdentity>> {
    if (!this.client) {
      return {
        data: null,
        error: {
          code: 'NOT_CONFIGURED',
          message: 'Supabase is not configured.',
        },
      };
    }

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      return {
        data: null,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Enter your email and password.',
        },
      };
    }

    try {
      const result = await this.client.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (result.error) {
        return { data: null, error: toAuthError(result.error, 'Unable to sign in.') };
      }

      if (!result.data.session) {
        return {
          data: null,
          error: {
            code: 'SESSION_MISSING',
            message: 'Sign-in did not return a session.',
          },
        };
      }

      return this.withProfile(result.data.session);
    } catch (error) {
      return { data: null, error: toAuthError(error, 'Unable to sign in.') };
    }
  }

  async restoreSession(): Promise<AuthResult<AuthenticatedIdentity | null>> {
    if (!this.client) {
      return { data: null, error: null };
    }

    try {
      const result = await this.client.auth.getSession();
      if (result.error) {
        return { data: null, error: toAuthError(result.error, 'Unable to restore the session.') };
      }

      if (!result.data.session) {
        return { data: null, error: null };
      }

      return this.withProfile(result.data.session);
    } catch (error) {
      return { data: null, error: toAuthError(error, 'Unable to restore the session.') };
    }
  }

  async signOut(): Promise<AuthResult<null>> {
    if (!this.client) {
      return { data: null, error: null };
    }

    try {
      // Explicit sign-out is for this device. Supabase's default global scope
      // would also revoke every other device using a shared account; the
      // separate admin-only Office action is the intentional global path.
      const result = await this.client.auth.signOut({ scope: 'local' });
      return result.error
        ? { data: null, error: toAuthError(result.error, 'Unable to sign out.') }
        : { data: null, error: null };
    } catch (error) {
      return { data: null, error: toAuthError(error, 'Unable to sign out.') };
    }
  }

  async loadProfile(userId: string): Promise<AuthResult<Profile>> {
    if (!this.client) {
      return {
        data: null,
        error: { code: 'NOT_CONFIGURED', message: 'Supabase is not configured.' },
      };
    }

    if (!userId) {
      await this.signOut();
      return { data: null, error: NOT_AUTHORIZED };
    }

    try {
      const selected = this.client.from('profiles').select('*').eq('id', userId);
      const query = selected as typeof selected & {
        then?: PromiseLike<{
          data: Record<string, unknown> | null;
          error: AuthClientError | null;
        }>['then'];
      };
      const result = query.maybeSingle
        ? await query.maybeSingle()
        : query.single
          ? await query.single()
          : query.then
            ? await (query as unknown as Promise<{
                data: Record<string, unknown> | null;
                error: AuthClientError | null;
              }>)
            : { data: null, error: { message: 'Profile query is unavailable.', code: 'PROFILE_QUERY' } };

      if (result.error) {
        // Supabase uses PGRST116 for a missing single row. Treat that as an
        // authorization failure, while preserving real network/query errors.
        if (isUnauthorizedProfileError(result.error)) {
          await this.signOut();
          return { data: null, error: NOT_AUTHORIZED };
        }

        return {
          data: null,
          error: toAuthError(result.error, 'Unable to load your profile.', 'PROFILE_LOAD_FAILED'),
        };
      }

      if (!result.data || !isRole(result.data.role)) {
        await this.signOut();
        return { data: null, error: NOT_AUTHORIZED };
      }

      return {
        data: {
          id: typeof result.data.id === 'string' ? result.data.id : userId,
          email: typeof result.data.email === 'string' ? result.data.email : '',
          role: result.data.role,
          fullName: typeof result.data.full_name === 'string' ? result.data.full_name : null,
        },
        error: null,
      };
    } catch (error) {
      return {
        data: null,
        error: toAuthError(error, 'Unable to load your profile.', 'PROFILE_LOAD_FAILED'),
      };
    }
  }

  onAuthStateChange(listener: AuthStateListener): () => void {
    if (!this.client) {
      return () => undefined;
    }

    try {
      const result = this.client.auth.onAuthStateChange(listener);
      return result.data?.subscription?.unsubscribe ?? (() => undefined);
    } catch {
      return () => undefined;
    }
  }

  subscribe(listener: AuthStateListener): () => void {
    return this.onAuthStateChange(listener);
  }

  private async withProfile(session: Session): Promise<AuthResult<AuthenticatedIdentity>> {
    const profileResult = await this.loadProfile(session.user.id);
    if (profileResult.error || !profileResult.data) {
      return { data: null, error: profileResult.error ?? NOT_AUTHORIZED };
    }

    return {
      data: { session, profile: profileResult.data },
      error: null,
    };
  }
}

export function createAuthService(client?: AuthClientLike | null): AuthService {
  return new AuthService(client);
}
