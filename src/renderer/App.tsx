import { useEffect, useState } from 'react';

import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../lib/theme';
import type { AppView, ThemePreference } from '../lib/types';
import { AppShell } from './components/AppShell';
import { LoginPlaceholder } from './components/LoginPlaceholder';

export interface AppProps {
  initialView?: AppView;
  initialThemePreference?: ThemePreference;
  startInWorkspace?: boolean;
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
}: AppProps) {
  const [isWorkspaceVisible, setIsWorkspaceVisible] = useState(startInWorkspace);
  const [activeView, setActiveView] = useState<AppView>(initialView);
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    initialThemePreference ?? loadThemePreference(),
  );
  const [systemDark, setSystemDark] = useState(getSystemDarkPreference);
  const resolvedTheme = resolveTheme(themePreference, systemDark);

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

  const handleThemeChange = (preference: ThemePreference) => {
    setThemePreference(preference);
    saveThemePreference(preference);
  };

  if (!isWorkspaceVisible) {
    return <LoginPlaceholder onContinue={() => setIsWorkspaceVisible(true)} />;
  }

  return (
    <AppShell
      activeView={activeView}
      onNavigate={setActiveView}
      themePreference={themePreference}
      resolvedTheme={resolvedTheme}
      onThemeChange={handleThemeChange}
    />
  );
}
