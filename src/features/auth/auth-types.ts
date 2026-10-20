import type { Session } from '@supabase/supabase-js';

export type Role = 'admin' | 'office';

export interface UserProfile {
  id: string;
  email: string;
  role: Role;
  fullName?: string | null;
}

export type Profile = UserProfile;

export type AuthStatus =
  | 'idle'
  | 'loading'
  | 'authenticated'
  | 'unauthenticated'
  | 'unauthorized'
  | 'error'
  | 'demo';

export interface AuthError {
  message: string;
  code?: string;
  cause?: unknown;
}

export interface AuthResult<T> {
  data: T | null;
  error: AuthError | null;
}

export interface AuthenticatedIdentity {
  session: Session;
  profile: UserProfile;
}

export type SupabaseReachability = 'unknown' | 'reachable' | 'unreachable';

export interface SupabaseHealth {
  configured: boolean;
  reachable: SupabaseReachability;
  authenticated: boolean;
  error: string | null;
}

export type AuthChangeEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'PASSWORD_RECOVERY'
  | (string & {});
