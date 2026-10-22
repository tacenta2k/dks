import type { ResolvedTheme, ThemePreference } from './types';

export type { ResolvedTheme, ThemePreference } from './types';

export const THEME_STORAGE_KEY = 'dks.theme-preference';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value as ThemePreference);
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemDark ? 'dark' : 'light';
  }

  return preference;
}

function getStorage(): Storage | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** R2-08: does this PC already hold a personal theme choice? */
export function hasSavedThemePreference(storage: Storage | undefined = getStorage()): boolean {
  if (!storage) {
    return false;
  }
  try {
    return isThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function loadThemePreference(storage: Storage | undefined = getStorage()): ThemePreference {
  if (!storage) {
    return DEFAULT_THEME_PREFERENCE;
  }

  try {
    const savedPreference = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(savedPreference) ? savedPreference : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A restricted storage context should not prevent the renderer from loading.
  }
}
