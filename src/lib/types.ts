export type ThemePreference = 'light' | 'dark' | 'system';

export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export type AppView = 'dashboard' | 'sheet';

export interface DksWindowApi {
  platform: string;
  appVersion: string;
  minimizeToTray: () => void;
  quit: () => void;
}

declare global {
  interface Window {
    dks?: DksWindowApi;
  }
}
