import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from 'electron';
import type { SqliteStore } from './sqlite';
import log from 'electron-log';

export const INSTALL_NONCE_FILE = 'install-nonce' as const;
export const INSTALL_NONCE_META_KEY = 'installNonce' as const;

export function installerNoncePath(userDataPath: string): string {
  return join(userDataPath, INSTALL_NONCE_FILE);
}

export function readInstallerNonce(userDataPath: string): string | null {
  try {
    const raw = readFileSync(installerNoncePath(userDataPath), 'utf8');
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed || null;
  } catch {
    return null;
  }
}

export function writeInstallerNonce(userDataPath: string, nonce: string): void {
  try {
    const trimmed = typeof nonce === 'string' ? nonce.trim() : '';
    if (!trimmed) return;
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(installerNoncePath(userDataPath), trimmed, 'utf8');
  } catch (error) {
    try {
      log.warn('[dks] failed to write install nonce', error);
    } catch {}
  }
}

export function generateInstallNonce(): string {
  try {
    return randomUUID();
  } catch {
    // Fallback when crypto is unavailable (very old Node test stub)
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export interface EnforceSessionIsolationOptions {
  /** app.isPackaged — skip entirely when false (dev). */
  isPackaged: boolean;
  /** Resolved userData path (app.getPath('userData')). */
  userDataPath: string;
  /** Open SQLite store (must be opened). When undefined, check is skipped. */
  store?: Pick<SqliteStore, 'getInstallNonce' | 'setInstallNonce'> | null;
  /** session.defaultSession — cleared when nonce mismatches. */
  session?: Pick<Session, 'clearStorageData'> | null;
  /** Logger (electron-log). */
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
}

/**
 * Enforce fresh-install isolation.
 *
 * Returns true if no action was needed or cleanup succeeded and nonce was recorded.
 * Returns false if cleanup was required but failed — caller must NOT consider the
 * session cleared and must NOT record the new nonce, so next launch retries.
 * This prevents silently resuming an old session after a failed cleanup.
 */
export async function enforceSessionIsolation(options: EnforceSessionIsolationOptions): Promise<boolean> {
  const logger = options.logger ?? log;
  if (!options.isPackaged) return true;
  if (!options.store) return true;
  const userDataPath = options.userDataPath;
  if (!userDataPath || typeof userDataPath !== 'string' || !userDataPath.trim()) return true;

  try {
    let installerNonce = readInstallerNonce(userDataPath);

    // First run from an old installer that never wrote a nonce, or the file
    // was deleted: mint one so future reinstalls are detectable.
    if (!installerNonce) {
      const generated = generateInstallNonce();
      writeInstallerNonce(userDataPath, generated);
      installerNonce = generated;
      const stored = tryGetStoredNonce(options.store);
      if (!stored) {
        // First ever launch — just record, do not wipe a non-existent session.
        trySetStoredNonce(options.store, installerNonce);
        logger.info('[dks] install nonce created for first launch', { nonce: installerNonce.slice(0, 8) + '…' });
        return true;
      }
      // File was missing but DB already has a nonce (e.g., manual delete or
      // old build): treat as fresh install and fall through to clear.
      logger.info('[dks] install nonce file was missing — treating as fresh install', {
        storedNoncePrefix: stored.slice(0, 8) + '…',
      });
    }

    const storedNonce = tryGetStoredNonce(options.store);
    if (installerNonce && storedNonce === installerNonce) {
      return true;
    }

    logger.info('[dks] fresh install detected — clearing Chromium session storages', {
      hasInstallerNonce: Boolean(installerNonce),
      hasStoredNonce: Boolean(storedNonce),
      installerPrefix: installerNonce ? installerNonce.slice(0, 8) + '…' : null,
      storedPrefix: storedNonce ? storedNonce.slice(0, 8) + '…' : null,
    });

    if (!options.session) {
      logger.warn('[dks] fresh install detected but no session available to clear — will retry next launch');
      return false;
    }

    // Use documented Electron 34 clearStorageData options.
    // For Electron 34 (Chromium 130) the valid storages are:
    //   'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache',
    //   'websql', 'serviceworkers', 'cachestorage'
    // There is no 'sessionstorage' or 'indexeddb' (with e) — those are invalid and throw.
    // We must include 'indexdb' (no e) and not rely on a fallback.
    try {
      await options.session.clearStorageData({
        // Documented options for Electron 34, including indexdb
        storages: ['cookies', 'localstorage', 'indexdb'],
      } as Parameters<Session['clearStorageData']>[0]);
    } catch (error) {
      logger.error('[dks] clearStorageData failed — will retry next launch, not recording new nonce', error);
      return false;
    }

    // Session Storage is not covered by clearStorageData's storages list.
    // It lives at %APPDATA%\DKS\Session Storage on disk. Remove it via fs.
    // This is best-effort but we log if it fails; the critical storages above
    // have already been cleared, so we can proceed to record nonce.
    try {
      const sessionStoragePath = join(userDataPath, 'Session Storage');
      if (existsSync(sessionStoragePath)) {
        rmSync(sessionStoragePath, { recursive: true, force: true });
        logger.info('[dks] Session Storage directory removed via fs');
      }
    } catch (error) {
      logger.warn('[dks] Session Storage fs cleanup failed', error);
      // Non-fatal: main storages already cleared, still record nonce
    }

    // Only after successful cleanup do we record the new nonce.
    trySetStoredNonce(options.store, installerNonce);
    logger.info('[dks] session storages cleared for fresh install', {
      storages: ['cookies', 'localstorage', 'indexdb', 'Session Storage (fs)'],
    });
    return true;
  } catch (error) {
    try {
      logger.warn('[dks] session isolation check failed', error);
    } catch {}
    return false;
  }
}

function tryGetStoredNonce(store: Pick<SqliteStore, 'getInstallNonce'>): string | null {
  try {
    const v = store.getInstallNonce();
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function trySetStoredNonce(store: Pick<SqliteStore, 'setInstallNonce'>, nonce: string): void {
  try {
    store.setInstallNonce(nonce);
  } catch {}
}
