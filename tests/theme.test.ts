import { beforeEach, describe, expect, it } from 'vitest';

import {
  THEME_STORAGE_KEY,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../src/lib/theme';

describe('resolveTheme', () => {
  it('keeps an explicit light preference light', () => {
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('keeps an explicit dark preference dark', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('uses the operating system when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('theme preference persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('loads system when no preference has been saved', () => {
    expect(loadThemePreference()).toBe('system');
  });

  it('round-trips a supported preference through local storage', () => {
    saveThemePreference('dark');

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(loadThemePreference()).toBe('dark');
  });

  it('ignores an invalid saved value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');

    expect(loadThemePreference()).toBe('system');
  });
});
