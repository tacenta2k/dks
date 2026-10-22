declare const __DKS_VERSION__: string;

/** Public project home for the "Made by Tacenta" link in About. */
export const TACENTA_GITHUB_URL = 'https://github.com/tacenta2k';

/**
 * The version shown in About must be the real build version, never a guessed
 * or placeholder string. Priority: explicit prop → Electron `app.getVersion()`
 * → the version baked in from package.json at build time.
 */
export function resolveAppVersion(explicit?: string | null): string {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  if (typeof window !== 'undefined' && window.dks?.appVersion) {
    return window.dks.appVersion;
  }
  try {
    if (typeof __DKS_VERSION__ === 'string' && __DKS_VERSION__) {
      return __DKS_VERSION__;
    }
  } catch {
    // Running somewhere without the build-time define (plain node scripts).
  }
  return 'unknown';
}

/**
 * Opens a link in the system browser through the preload bridge. The main
 * process only accepts https URLs on the allowlisted hosts. When the bridge is
 * unavailable (browser preview, tests) it falls back to a new tab so the
 * control still does something sensible.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.dks : undefined;
  if (api?.openExternal) {
    try {
      return (await api.openExternal(url)) === true;
    } catch {
      return false;
    }
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
