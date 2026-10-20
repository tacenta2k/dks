import type { Session } from '@supabase/supabase-js';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

import type { ThemePreference } from './types';
import { AuthService } from '../features/auth/auth-service';
import type {
  AuthError,
  AuthStatus,
  Profile,
  SupabaseHealth,
} from '../features/auth/auth-types';

export type SyncStatus = 'offline' | 'checking' | 'healthy' | 'error';

export interface AppStore {
  session: Session | null;
  profile: Profile | null;
  authStatus: AuthStatus;
  authError: AuthError | null;
  syncStatus: SyncStatus;
  theme: ThemePreference;
  health: SupabaseHealth;
  signIn: (email: string, password: string) => Promise<void>;
  restoreSession: () => Promise<void>;
  signOut: () => Promise<void>;
  setDemoSession: (email?: string) => void;
  setTheme: (theme: ThemePreference) => void;
  reset: () => void;
}

const EMPTY_HEALTH: SupabaseHealth = {
  configured: false,
  reachable: 'unknown',
  authenticated: false,
  error: null,
};

function initialState(health: SupabaseHealth): Pick<
  AppStore,
  'session' | 'profile' | 'authStatus' | 'authError' | 'syncStatus' | 'theme' | 'health'
> {
  return {
    session: null,
    profile: null,
    authStatus: 'unauthenticated',
    authError: null,
    syncStatus: 'offline',
    theme: 'system',
    health,
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

export function createAppStore(authService = new AuthService()): StoreApi<AppStore> {
  let authRequestId = 0;
  const serviceHealth: SupabaseHealth = {
    ...EMPTY_HEALTH,
    configured: authService.isConfigured,
  };
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
      });
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
      });
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
      });
    },

    setTheme: (theme) => set({ theme }),

    reset: () => {
      authRequestId += 1;
      set(initialState(serviceHealth));
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
    });
  });

  return store;
}

export const appStore = createAppStore();

export const useAppStore = Object.assign(
  <T>(selector: (state: AppStore) => T): T => useStore(appStore, selector),
  appStore,
) as (<T>(selector: (state: AppStore) => T) => T) & StoreApi<AppStore>;
