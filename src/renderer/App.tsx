import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { createAuthService, AuthService } from '../features/auth/auth-service';
import { AuthScreen } from '../features/auth/AuthScreen';
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../lib/theme';
import type { AppView, ThemePreference } from '../lib/types';
import { isSupabaseConfigured } from '../lib/supabase';
import { AppShell } from './components/AppShell';
import { createAppStore } from '../lib/store';

export interface AppProps {
  initialView?: AppView;
  initialThemePreference?: ThemePreference;
  startInWorkspace?: boolean;
  authService?: AuthService;
  demoMode?: boolean;
}

function getSystemDarkPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function App({
  initialView = 'dashboard',
  initialThemePreference,
  startInWorkspace = false,
  authService: providedAuthService,
  demoMode,
}: AppProps) {
  const [authService] = useState(() => providedAuthService ?? createAuthService());
  const [appStore] = useState(() => createAppStore(authService));
  const [activeView, setActiveView] = useState<AppView>(initialView);
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    initialThemePreference ?? loadThemePreference(),
  );
  const [systemDark, setSystemDark] = useState(getSystemDarkPreference);
  const resolvedTheme = resolveTheme(themePreference, systemDark);
  const authStatus = useStore(appStore, (state) => state.authStatus);
  const authError = useStore(appStore, (state) => state.authError);
  const session = useStore(appStore, (state) => state.session);
  const profile = useStore(appStore, (state) => state.profile);
  const health = useStore(appStore, (state) => state.health);
  const isDevelopment = import.meta.env.DEV || import.meta.env.MODE === 'test';
  const demoAvailable =
    !isSupabaseConfigured() && !authService.isConfigured && isDevelopment && (demoMode ?? true);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    let mediaQuery: MediaQueryList;
    try {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }

    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };

    mediaQuery.addEventListener?.('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener?.('change', handleSystemThemeChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (authService.isConfigured) {
      void appStore.getState().restoreSession();
      return undefined;
    }

    appStore.getState().reset();
    if (demoAvailable && startInWorkspace) {
      appStore.getState().setDemoSession();
    }

    return undefined;
  }, [appStore, authService, demoAvailable, startInWorkspace]);

  const handleThemeChange = (preference: ThemePreference) => {
    setThemePreference(preference);
    appStore.getState().setTheme(preference);
    saveThemePreference(preference);
  };

  const isWorkspaceVisible = authStatus === 'authenticated' || authStatus === 'demo';

  if (!isWorkspaceVisible) {
    return (
      <AuthScreen
        onSignIn={(email, password) => appStore.getState().signIn(email, password)}
        authStatus={authStatus}
        authError={authError?.message ?? null}
        health={health}
        demoAvailable={demoAvailable}
        onDemoContinue={() => appStore.getState().setDemoSession()}
      />
    );
  }

  return (
    <AppShell
      activeView={activeView}
      onNavigate={setActiveView}
      themePreference={themePreference}
      resolvedTheme={resolvedTheme}
      onThemeChange={handleThemeChange}
      profile={profile}
      userEmail={session?.user.email ?? null}
      health={health}
      isDemoMode={authStatus === 'demo'}
      onLogout={() => appStore.getState().signOut()}
    />
  );
}
