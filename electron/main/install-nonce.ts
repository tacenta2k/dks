import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

export async function enforceSessionIsolation(options: EnforceSessionIsolationOptions): Promise<void> {
  const logger = options.logger ?? log;
  if (!options.isPackaged) return;
  if (!options.store) return;
  const userDataPath = options.userDataPath;
  if (!userDataPath || typeof userDataPath !== 'string' || !userDataPath.trim()) return;

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
        return;
      }
      // File was missing but DB already has a nonce (e.g., manual delete or
      // old build): treat as fresh install and fall through to clear.
      logger.info('[dks] install nonce file was missing — treating as fresh install', {
        storedNoncePrefix: stored.slice(0, 8) + '…',
      });
    }

    const storedNonce = tryGetStoredNonce(options.store);
    if (installerNonce && storedNonce === installerNonce) {
      return;
    }

    logger.info('[dks] fresh install detected — clearing Chromium session storages', {
      hasInstallerNonce: Boolean(installerNonce),
      hasStoredNonce: Boolean(storedNonce),
      installerPrefix: installerNonce ? installerNonce.slice(0, 8) + '…' : null,
      storedPrefix: storedNonce ? storedNonce.slice(0, 8) + '…' : null,
    });

    if (options.session) {
      try {
        // Must NEVER delete dks-cache.sqlite — that lives at the userData root
        // and is the customer data + outbox. This call touches only the four
        // Chromium storages that hold the Supabase JWT.
        // Task specifies: ['localstorage','sessionstorage','indexeddb','cookies'].
        // Electron spells one of them 'indexdb' (no e); try both for robustness.
        try {
          await options.session.clearStorageData({
            storages: ['cookies', 'localstorage', 'sessionstorage', 'indexeddb'] as unknown as string[],
          } as Parameters<Session['clearStorageData']>[0]);
        } catch {
          await options.session.clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb'] as unknown as string[],
          } as Parameters<Session['clearStorageData']>[0]);
        }
        logger.info('[dks] session storages cleared for fresh install', {
          storages: ['cookies', 'localstorage', 'sessionstorage', 'indexeddb'],
        });
      } catch (error) {
        logger.warn('[dks] clearStorageData failed during fresh-install handling', error);
      }
    } else {
      logger.warn('[dks] fresh install detected but no session available to clear');
    }

    trySetStoredNonce(options.store, installerNonce);
  } catch (error) {
    try {
      logger.warn('[dks] session isolation check failed', error);
    } catch {}
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
