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
import { classifyAuthError, RESTORE_UNREACHABLE_CODE } from '../features/auth/auth-errors';
import { startTimingSpan } from './timing';
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
  /**
   * v0.1.7 — true from app start until the persisted session has been
   * restored (or found absent). While true the App renders a neutral splash,
   * never the email/password AuthScreen, so an already signed-in user does not
   * see the login form flash before the dashboard. Cleared by the FIRST
   * terminal auth outcome from any path (restore, auth-state event, sign-in,
   * demo, reset, sign-out).
   */
  isRestoringSession: boolean;
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
  /** Keep the denied/revoked gate visible while clearing this device's Auth session. */
  endOfficeSessionAfterDecision: () => Promise<void>;
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
  'session' | 'profile' | 'authStatus' | 'authError' | 'isRestoringSession' | 'syncStatus' | 'theme' | 'health' | 'sessionApproval' | 'sessionApprovalRequest' | 'sessionApprovalError'
> {
  return {
    session: null,
    profile: null,
    authStatus: 'unauthenticated',
    authError: null,
    isRestoringSession: false,
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

/**
 * v0.1.8 (Issue A) — back-off between restore attempts when the failure is
 * TRANSIENT (network/timeout/5xx). Sum ≈ 15 s, i.e. inside the 20 s splash
 * (RESTORE_SPLASH_MAX_MS in App.tsx), so a short outage right after an update
 * no longer replaces a valid saved session with the email/password form.
 */
export const RESTORE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export const RESTORE_UNREACHABLE_MESSAGE =
  'Cannot reach the DKS server right now. Your saved sign-in is kept — check the connection and press Retry, or sign in again.';

export interface AppStoreOptions {
  restoreRetryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAppStore(
  authService = new AuthService(),
  approvalService: OfficeApprovalService | null = createOfficeApprovalService(),
  options: AppStoreOptions = {},
): StoreApi<AppStore> {
  let authRequestId = 0;
  let approvalRequestId = 0;
  let preserveOfficeGate = false;
  let explicitSignOut = false;
  // While an explicit signIn()/restoreSession() is in flight, THAT flow owns
  // the outcome. auth-js emits SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED
  // from inside those calls; reacting to them started a second, racing
  // profile load whose (possibly transient) failure could overwrite the
  // result and which bumped authRequestId so signIn() discarded its own
  // result (and skipped submitOfficeApprovalRequest).
  let ownedAuthFlows = 0;
  const restoreRetryDelays = options.restoreRetryDelaysMs ?? RESTORE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
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
    // A configured client always restores a persisted session on start-up;
    // an unconfigured (demo/test) client has nothing to restore.
    isRestoringSession: authService.isConfigured,

    signIn: async (email, password) => {
      preserveOfficeGate = false;
      approvalRequestId += 1;
      const requestId = ++authRequestId;
      set({ authStatus: 'loading', authError: null, isRestoringSession: false });
      // Issue B: auth=<password grant> profile=<profiles row> total=<button busy>.
      const span = startTimingSpan('signin');
      ownedAuthFlows += 1;
      let result: Awaited<ReturnType<typeof authService.signIn>>;
      try {
        result = await authService.signIn(email, password);
      } finally {
        ownedAuthFlows -= 1;
      }
      if (requestId !== authRequestId && result.error?.code !== 'NOT_AUTHORIZED') {
        span.end({ outcome: 'superseded' });
        return;
      }

      if (result.error || !result.data) {
        span.end({ outcome: 'error', code: result.error?.code ?? 'unknown' });
        set({
          session: null,
          profile: null,
          authStatus: result.error?.code === 'NOT_AUTHORIZED' ? 'unauthorized' : 'error',
          isRestoringSession: false,
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
        isRestoringSession: false,
        authError: null,
        health: {
          ...get().health,
          reachable: 'reachable',
          authenticated: true,
          error: null,
        },
        ...EMPTY_SESSION_APPROVAL,
      });

      span.end({ outcome: 'ok', role: result.data.profile.role });

      // Office-only: this signed session needs Admin approval BEFORE any
      // workspace traffic (server-side RLS enforces the same boundary).
      if (result.data.profile.role === 'office') {
        void get().submitOfficeApprovalRequest();
      }
    },

    restoreSession: async () => {
      preserveOfficeGate = false;
      approvalRequestId += 1;
      const requestId = ++authRequestId;
      set({ authStatus: 'loading', authError: null });
      const span = startTimingSpan('restore');
      ownedAuthFlows += 1;
      let result: Awaited<ReturnType<typeof authService.restoreSession>>;
      let attempts = 1;
      try {
        result = await authService.restoreSession();
        // v0.1.8 (Issue A): a TRANSIENT failure (network, timeout, 5xx) says
        // nothing about the saved session — auth-js keeps it on disk. Retry
        // with back-off instead of showing the password form. Definitive
        // failures (no session, refresh token rejected, NOT_AUTHORIZED) fall
        // straight through exactly as before.
        for (const delay of restoreRetryDelays) {
          if (!result.error || classifyAuthError(result.error) !== 'transient') break;
          if (requestId !== authRequestId) break;
          await sleep(delay);
          span.mark('backoff');
          if (requestId !== authRequestId) break;
          attempts += 1;
          result = await authService.restoreSession();
        }
      } finally {
        ownedAuthFlows -= 1;
      }
      if (requestId !== authRequestId && result.error?.code !== 'NOT_AUTHORIZED') {
        span.end({ outcome: 'superseded', attempts });
        return;
      }

      if (result.error) {
        const transient = classifyAuthError(result.error) === 'transient';
        span.end({ outcome: transient ? 'unreachable' : 'error', code: result.error.code ?? 'unknown', attempts });
        const shownError: AuthError = transient
          ? { message: RESTORE_UNREACHABLE_MESSAGE, code: RESTORE_UNREACHABLE_CODE, cause: result.error }
          : result.error;
        set({
          session: null,
          profile: null,
          authStatus: result.error.code === 'NOT_AUTHORIZED' ? 'unauthorized' : 'error',
          isRestoringSession: false,
          authError: shownError,
          health: errorHealth(get().health, shownError),
        });
        return;
      }

      if (!result.data) {
        span.end({ outcome: 'no-session', attempts });
        set({
          session: null,
          profile: null,
          authStatus: 'unauthenticated',
          isRestoringSession: false,
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
        isRestoringSession: false,
        authError: null,
        health: {
          ...get().health,
          reachable: 'reachable',
          authenticated: true,
          error: null,
        },
        ...EMPTY_SESSION_APPROVAL,
        // A restored Office session shows the neutral "Opening your session…"
        // gate while its approval is re-validated — never a transient
        // "cannot verify" state. The gate stays closed either way.
        ...(result.data.profile.role === 'office' ? { sessionApproval: 'checking' as const } : {}),
      });
      span.end({ outcome: 'ok', role: result.data.profile.role, attempts });

      // Office-only: a persisted, still-valid approved session re-validates
      // on restart (no new request); revoked/denied stops the workspace here.
      if (result.data.profile.role === 'office') {
        void get().refreshSessionApproval();
      }
    },

    signOut: async () => {
      preserveOfficeGate = false;
      approvalRequestId += 1;
      const requestId = ++authRequestId;
      explicitSignOut = true;
      const result = await authService.signOut();
      explicitSignOut = false;
      if (requestId !== authRequestId) {
        return;
      }
      set({
        session: null,
        profile: null,
        authStatus: result.error ? 'error' : 'unauthenticated',
        isRestoringSession: false,
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
        isRestoringSession: false,
        authError: null,
        health: { ...EMPTY_HEALTH },
        ...EMPTY_SESSION_APPROVAL,
      });
    },

    setTheme: (theme) => set({ theme }),

    reset: () => {
      preserveOfficeGate = false;
      approvalRequestId += 1;
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
      const approvalId = ++approvalRequestId;
      const authId = authRequestId;
      set({ sessionApproval: 'checking', sessionApprovalError: null });
      const approvalSpan = startTimingSpan('office-approval');
      const result = await approvalService.requestApproval();
      approvalSpan.mark('approval_request');
      approvalSpan.end({ outcome: result.error ? 'error' : (result.data?.status ?? 'none'), role: 'office' });
      if (approvalId !== approvalRequestId || authId !== authRequestId || get().profile?.role !== 'office') return;
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
      const approvalId = ++approvalRequestId;
      const authId = authRequestId;
      set({ sessionApprovalError: null });
      const result = await approvalService.fetchMyRequest();
      if (approvalId !== approvalRequestId || authId !== authRequestId || get().profile?.role !== 'office') return;
      if (result.error) {
        applyApprovalStatus(set, null, result.error);
        return;
      }
      // No row at all for this session: the flow never started (edge case —
      // e.g. DB was re-initialised since login) → open the request now.
      if (!result.data) {
        set({ sessionApproval: 'checking' });
        const requested = await approvalService.requestApproval();
        if (approvalId !== approvalRequestId || authId !== authRequestId || get().profile?.role !== 'office') return;
        applyApprovalStatus(set, requested.data, requested.error);
        return;
      }
      applyApprovalStatus(set, result.data, null);
    },

    endOfficeSessionAfterDecision: async () => {
      const decision = get().sessionApproval;
      if (get().profile?.role !== 'office' || (decision !== 'denied' && decision !== 'revoked') || preserveOfficeGate) return;
      // Preserve only the gate copy, not the access token. Auth's SIGNED_OUT
      // callback must not replace the explanatory gate with the login form.
      preserveOfficeGate = true;
      approvalRequestId += 1;
      const requestId = ++authRequestId;
      const result = await authService.signOut(); // scope: 'local'
      if (requestId !== authRequestId) return;
      set({
        session: null,
        authStatus: 'unauthenticated',
        isRestoringSession: false,
        health: { ...get().health, authenticated: false },
        ...(result.error ? { sessionApprovalError: result.error } : {}),
      });
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
    if (preserveOfficeGate) return;
    // signIn()/restoreSession() in flight own the outcome (see ownedAuthFlows).
    if (ownedAuthFlows > 0) return;
    // App start: restoreSession() (always called on mount when Supabase is
    // configured) owns the first session read; INITIAL_SESSION would only
    // start a duplicate, racing profile load.
    if (_event === 'INITIAL_SESSION' && store.getState().isRestoringSession) return;
    const requestId = ++authRequestId;
    if (!session) {
      const current = store.getState();
      if (!explicitSignOut && current.authStatus === 'authenticated' && current.profile?.role === 'office') {
        // An Auth refresh may discover that the administrator deleted this
        // session before Realtime delivers the revoked-row event. Fail closed
        // and show the same gate; the App fences IPC and clears local Auth.
        approvalRequestId += 1;
        store.setState({ session: null, sessionApproval: 'revoked', sessionApprovalError: null });
        return;
      }
      store.setState({
        session: null,
        profile: null,
        authStatus: 'unauthenticated',
        isRestoringSession: false,
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
        const current = store.getState();
        // v0.1.8 (Issue A): a token refresh succeeded (Supabase issued this
        // session) but the profile re-read hit a network blip. Keep the
        // signed-in user on the same identity instead of throwing them to the
        // login form; only adopt the fresh token. NOT_AUTHORIZED and other
        // definitive errors still end the session below.
        if (
          result.error
          && classifyAuthError(result.error) === 'transient'
          && current.authStatus === 'authenticated'
          && current.profile?.id === session.user.id
        ) {
          store.setState({
            session,
            health: { ...current.health, reachable: 'unreachable', error: result.error.message },
          });
          return;
        }
        store.setState({
          session: null,
          profile: null,
          authStatus: result.error?.code === 'NOT_AUTHORIZED' ? 'unauthorized' : 'error',
          isRestoringSession: false,
          authError: result.error,
          ...EMPTY_SESSION_APPROVAL,
        });
        return;
      }

      store.setState({
        session,
        profile: result.data,
        authStatus: 'authenticated',
        isRestoringSession: false,
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
