import type { Session } from '@supabase/supabase-js';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

import type { ThemePreference } from './types';
import { AuthService } from '../features/auth/auth-service';
import {
  createOfficeApprovalService,
  type OfficeApprovalService,
  type OfficeSessionSignOutSummary,
  type OfficeSigninRequest,
} from '../features/auth/office-approval-service';
import type {
  AuthError,
  AuthResult,
  AuthStatus,
  Profile,
  SupabaseHealth,
} from '../features/auth/auth-types';

export type SyncStatus = 'offline' | 'checking' | 'healthy' | 'error';

/**
 * Office sign-in approval — the office-sign-in gate runs only after password
 * authentication, adds ZERO trust to any client value.
 *
 *   'not-required'  Admin session (or demo) — never gated.
 *   'checking'      server round-trip in progress (never renders workspace).
 *   'pending'       waiting for Admin's decision (waiting screen).
 *   'approved'      server confirmed this signed session is approved.
 *   'denied'        Admin denied the request (blocked screen).
 *   'revoked'       Admin revoked an earlier approval (blocked screen).
 *   'error'         the approval flow failed (cannot verify; never opens).
 */
export type SessionApprovalState =
  | 'not-required'
  | 'checking'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'error';

export interface AppStore {
  session: Session | null;
  profile: Profile | null;
  authStatus: AuthStatus;
  authError: AuthError | null;
  syncStatus: SyncStatus;
  theme: ThemePreference;
  health: SupabaseHealth;
  /** Office-only sign-in approval state; meaningless for Admin/demo. */
  sessionApproval: SessionApprovalState;
  sessionApprovalRequest: OfficeSigninRequest | null;
  sessionApprovalError: AuthError | null;
  signIn: (email: string, password: string) => Promise<void>;
  restoreSession: () => Promise<void>;
  signOut: () => Promise<void>;
  setDemoSession: (email?: string) => void;
  setTheme: (theme: ThemePreference) => void;
  reset: () => void;
  /**
   * Office flow only: ask the server for the CURRENT signed session's
   * approval status (and, on the very first login, submit the request).
   * Never asserts access itself — server response drives the transition.
   */
  submitOfficeApprovalRequest: () => Promise<void>;
  refreshSessionApproval: () => Promise<void>;
  /** Admin-only server action: terminate every Office Auth session. */
  signOutAllOfficeSessions: () => Promise<AuthResult<OfficeSessionSignOutSummary>>;
}

const EMPTY_HEALTH: SupabaseHealth = {
  configured: false,
  reachable: 'unknown',
  authenticated: false,
  error: null,
};

const EMPTY_SESSION_APPROVAL: Pick<
  AppStore,
  'sessionApproval' | 'sessionApprovalRequest' | 'sessionApprovalError'
> = {
  sessionApproval: 'not-required',
  sessionApprovalRequest: null,
  sessionApprovalError: null,
};

function initialState(health: SupabaseHealth): Pick<
  AppStore,
  'session' | 'profile' | 'authStatus' | 'authError' | 'syncStatus' | 'theme' | 'health' | 'sessionApproval' | 'sessionApprovalRequest' | 'sessionApprovalError'
> {
  return {
    session: null,
    profile: null,
    authStatus: 'unauthenticated',
    authError: null,
    syncStatus: 'offline',
    theme: 'system',
    health,
    ...EMPTY_SESSION_APPROVAL,
  };
}

function errorHealth(health: SupabaseHealth, error: AuthError | null): SupabaseHealth {
  return {
    ...health,
    authenticated: false,
    reachable: error ? 'unreachable' : health.reachable,
    error: error?.message ?? null,
  };
}

export function createAppStore(
  authService = new AuthService(),
  approvalService: OfficeApprovalService | null = createOfficeApprovalService(),
): StoreApi<AppStore> {
  let authRequestId = 0;
  const serviceHealth: SupabaseHealth = {
    ...EMPTY_HEALTH,
    configured: authService.isConfigured,
  };

  /**
   * Applies the server-reported approval status for an Office profile.
   * Never touches Admin sessions and never trusts client data — the status
   * is whatever the RPC said about THIS signed session.
   */
  function applyApprovalStatus(
    set: (partial: Partial<AppStore>) => void,
    request: OfficeSigninRequest | null,
    error: AuthError | null,
  ): void {
    if (error) {
      set({
        sessionApproval: 'error',
        sessionApprovalRequest: null,
        sessionApprovalError: error,
      });
      return;
    }
    if (!request) {
      set({
        sessionApproval: 'error',
        sessionApprovalRequest: null,
        sessionApprovalError: {
          message: 'No approval status was returned for this session.',
          code: 'APPROVAL_STATUS_MISSING',
        },
      });
      return;
    }
    set({
      sessionApproval: request.status,
      sessionApprovalRequest: request,
      sessionApprovalError: null,
    });
  }

  const store = createStore<AppStore>((set, get) => ({
    ...initialState(serviceHealth),

    signIn: async (email, password) => {
      const requestId = ++authRequestId;
      set({ authStatus: 'loading', authError: null });
      const result = await authService.signIn(email, password);
      if (requestId !== authRequestId && result.error?.code !== 'NOT_AUTHORIZED') {
        return;
      }

      if (result.error || !result.data) {
        set({
          session: null,
          profile: null,
          authStatus: result.error?.code === 'NOT_AUTHORIZED' ? 'unauthorized' : 'error',
          authError: result.error,
          health: errorHealth(get().health, result.error),
          ...EMPTY_SESSION_APPROVAL,
        });
        return;
      }

      set({
        session: result.data.session,
        profile: result.data.profile,
        authStatus: 'authenticated',
        authError: null,
        health: {
          ...get().health,
          reachable: 'reachable',
          authenticated: true,
          error: null,
        },
        ...EMPTY_SESSION_APPROVAL,
      });

      // Office-only: this signed session needs Admin approval BEFORE any
      // workspace traffic (server-side RLS enforces the same boundary).
      if (result.data.profile.role === 'office') {
        void get().submitOfficeApprovalRequest();
      }
    },

    restoreSession: async () => {
      const requestId = ++authRequestId;
      set({ authStatus: 'loading', authError: null });
      const result = await authService.restoreSession();
      if (requestId !== authRequestId && result.error?.code !== 'NOT_AUTHORIZED') {
        return;
      }

      if (result.error) {
        set({
          session: null,
          profile: null,
          authStatus: result.error.code === 'NOT_AUTHORIZED' ? 'unauthorized' : 'error',
          authError: result.error,
          health: errorHealth(get().health, result.error),
        });
        return;
      }

      if (!result.data) {
        set({
          session: null,
          profile: null,
          authStatus: 'unauthenticated',
          authError: null,
          health: {
            ...get().health,
            reachable: authService.isConfigured ? 'reachable' : 'unknown',
            authenticated: false,
            error: null,
          },
          ...EMPTY_SESSION_APPROVAL,
        });
        return;
      }

      set({
        session: result.data.session,
        profile: result.data.profile,
        authStatus: 'authenticated',
        authError: null,
        health: {
          ...get().health,
          reachable: 'reachable',
          authenticated: true,
          error: null,
        },
        ...EMPTY_SESSION_APPROVAL,
      });

      // Office-only: a persisted, still-valid approved session re-validates
      // on restart (no new request); revoked/denied stops the workspace here.
      if (result.data.profile.role === 'office') {
        void get().refreshSessionApproval();
      }
    },

    signOut: async () => {
      const requestId = ++authRequestId;
      const result = await authService.signOut();
      if (requestId !== authRequestId) {
        return;
      }
      set({
        session: null,
        profile: null,
        authStatus: result.error ? 'error' : 'unauthenticated',
        authError: result.error,
        health: result.error ? errorHealth(get().health, result.error) : {
          ...get().health,
          authenticated: false,
          error: null,
        },
        ...EMPTY_SESSION_APPROVAL,
      });
    },

    setDemoSession: (email = 'demo@dks.local') => {
      authRequestId += 1;
      const demoSession = {
        access_token: 'offline-demo',
        refresh_token: 'offline-demo',
        expires_in: 0,
        token_type: 'bearer',
        user: {
          id: 'offline-demo-user',
          email,
          aud: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: new Date(0).toISOString(),
        },
      } as Session;

      set({
        session: demoSession,
        profile: { id: demoSession.user.id, email, role: 'admin', fullName: 'Offline demo' },
        authStatus: 'demo',
        authError: null,
        health: { ...EMPTY_HEALTH },
        ...EMPTY_SESSION_APPROVAL,
      });
    },

    setTheme: (theme) => set({ theme }),

    reset: () => {
      authRequestId += 1;
      set(initialState(serviceHealth));
    },

    submitOfficeApprovalRequest: async () => {
      if (get().profile?.role !== 'office') {
        set({ ...EMPTY_SESSION_APPROVAL });
        return;
      }
      if (!approvalService) {
        set({
          sessionApproval: 'error',
          sessionApprovalRequest: null,
          sessionApprovalError: {
            message: 'Supabase is not configured — the approval request cannot reach the server.',
            code: 'APPROVAL_NOT_CONFIGURED',
          },
        });
        return;
      }
      set({ sessionApproval: 'checking', sessionApprovalError: null });
      const result = await approvalService.requestApproval();
      applyApprovalStatus(set, result.data, result.error);
    },

    refreshSessionApproval: async () => {
      if (get().profile?.role !== 'office') {
        set({ ...EMPTY_SESSION_APPROVAL });
        return;
      }
      if (!approvalService) {
        set({
          sessionApproval: 'error',
          sessionApprovalRequest: null,
          sessionApprovalError: {
            message: 'Supabase is not configured — the approval status cannot reach the server.',
            code: 'APPROVAL_NOT_CONFIGURED',
          },
        });
        return;
      }
      set({ sessionApprovalError: null });
      const result = await approvalService.fetchMyRequest();
      if (result.error) {
        applyApprovalStatus(set, null, result.error);
        return;
      }
      // No row at all for this session: the flow never started (edge case —
      // e.g. DB was re-initialised since login) → open the request now.
      if (!result.data) {
        set({ sessionApproval: 'checking' });
        const requested = await approvalService.requestApproval();
        applyApprovalStatus(set, requested.data, requested.error);
        return;
      }
      applyApprovalStatus(set, result.data, null);
    },

    signOutAllOfficeSessions: async () => {
      if (get().profile?.role !== 'admin') {
        return {
          data: null,
          error: {
            message: 'Only an administrator can sign out Office sessions.',
            code: 'NOT_AUTHORIZED',
          },
        };
      }
      if (!approvalService) {
        return {
          data: null,
          error: {
            message: 'Supabase is not configured, so Office sessions cannot be signed out.',
            code: 'APPROVAL_NOT_CONFIGURED',
          },
        };
      }
      return approvalService.signOutAllOfficeSessions();
    },
  }));

  authService.onAuthStateChange((_event, session) => {
    const requestId = ++authRequestId;
    if (!session) {
      store.setState({
        session: null,
        profile: null,
        authStatus: 'unauthenticated',
        authError: null,
        health: {
          ...store.getState().health,
          authenticated: false,
        },
        ...EMPTY_SESSION_APPROVAL,
      });
      return;
    }

    void authService.loadProfile(session.user.id).then((result) => {
      if (requestId !== authRequestId) {
        return;
      }

      if (result.error || !result.data) {
        store.setState({
          session: null,
          profile: null,
          authStatus: result.error?.code === 'NOT_AUTHORIZED' ? 'unauthorized' : 'error',
          authError: result.error,
          ...EMPTY_SESSION_APPROVAL,
        });
        return;
      }

      store.setState({
        session,
        profile: result.data,
        authStatus: 'authenticated',
        authError: null,
        health: {
          ...store.getState().health,
          reachable: 'reachable',
          authenticated: true,
          error: null,
        },
      });

      // Token refresh / profile re-sync: an office session re-validates its
      // approval so a revocation takes effect promptly on this window.
      if (result.data.role === 'office') {
        void store.getState().refreshSessionApproval();
      } else {
        store.setState({ ...EMPTY_SESSION_APPROVAL });
      }
    });
  });

  return store;
}

export const appStore = createAppStore();

export const useAppStore = Object.assign(
  <T>(selector: (state: AppStore) => T): T => useStore(appStore, selector),
  appStore,
) as (<T>(selector: (state: AppStore) => T) => T) & StoreApi<AppStore>;
