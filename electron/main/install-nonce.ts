import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from 'electron';
import type { SqliteStore } from './sqlite';
import log from 'electron-log';

export const INSTALL_NONCE_FILE = 'install-nonce' as const;
export const SESSION_RESET_MARKER_FILE = 'session-reset-required' as const;
export const INSTALL_NONCE_META_KEY = 'installNonce' as const;

export function installerNoncePath(userDataPath: string): string {
  return join(userDataPath, INSTALL_NONCE_FILE);
}

export function resetMarkerPath(userDataPath: string): string {
  return join(userDataPath, SESSION_RESET_MARKER_FILE);
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

export function hasResetMarker(userDataPath: string): boolean {
  try {
    return existsSync(resetMarkerPath(userDataPath));
  } catch {
    return false;
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
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export interface EnforceSessionIsolationOptions {
  isPackaged: boolean;
  userDataPath: string;
  store?: Pick<SqliteStore, 'getInstallNonce' | 'setInstallNonce'> | null;
  session?: Pick<Session, 'clearStorageData'> | null;
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
}

/**
 * Enforce login matrix A–F.
 *
 * Owner requirements:
 * - A quit/reopen MUST preserve login (nonce match).
 * - B auto-update MUST preserve login (isUpdated preserves nonce+session, not fresh).
 * - C manual in-place upgrade MUST preserve login (existing install detected, preserves nonce).
 * - D legacy 0.1.4→0.1.5 in-place upgrade (existing install, no nonce file/DB) → mint nonce WITHOUT clearing (migration, login preserved). Do not introduce one-time logout for legacy.
 * - E genuine uninstall/reinstall → uninstall deletes session+nonce but preserves sqlite/outbox; new installer creates session-reset-required marker + new nonce; app clears chromium session, records new nonce, removes marker only after successful cleanup. Require email/password for Admin and Office. Office requires fresh Admin approval only after genuine uninstall/reinstall because the new Supabase Auth session_id is different.
 * - F first install on clean PC → treat as fresh (clearing nonexistent session harmless).
 *
 * Marker vs FileExists:
 * - Do NOT infer genuine fresh solely from FileExists install-nonce, because v0.1.4 has no nonce file — a legacy upgrade would be mis-detected as fresh.
 * - Installer sets isFreshInstall in customInit (isUpdated + registry hasPerUser/hasPerMachine) and creates session-reset-required marker ONLY for genuine fresh installs (first install or after uninstall). Legacy upgrades mint a nonce WITHOUT marker.
 *
 * App-level logic (before renderer):
 * - reset marker present → clear cookies/localstorage/indexdb + Session Storage fs, then store nonce and remove marker (fail-closed: if clear fails, do NOT consume marker or record nonce, block renderer, retry next launch).
 * - reset marker absent + stored null + installer nonce present → legacy migration: store nonce WITHOUT clearing (preserves login).
 * - reset marker absent + stored null + installer nonce absent → mint nonce without clearing (first-ever fallback, harmless).
 * - exact nonce match → preserve login.
 * - unexpected mismatch without marker → clear fail-closed (treat as reset condition).
 * - SQLite, rows, pending outbox survive uninstall/reinstall (installer never deletes dks-cache.sqlite; app-level clear uses clearStorageData, not file deletion).
 */
export async function enforceSessionIsolation(options: EnforceSessionIsolationOptions): Promise<boolean> {
  const logger = options.logger ?? log;
  if (!options.isPackaged) return true;
  if (!options.store) return true;
  const userDataPath = options.userDataPath;
  if (!userDataPath || typeof userDataPath !== 'string' || !userDataPath.trim()) return true;

  try {
    const installerNonce = readInstallerNonce(userDataPath);
    const hasMarker = hasResetMarker(userDataPath);
    const storedNonce = tryGetStoredNonce(options.store);

    // F/Genuine fresh install: marker present → must clear (covers first install and uninstall/reinstall)
    if (hasMarker) {
      logger.info('[dks] session-reset marker present — genuine fresh install, clearing Chromium session', {
        hasInstallerNonce: Boolean(installerNonce),
        hasStoredNonce: Boolean(storedNonce),
        installerPrefix: installerNonce ? installerNonce.slice(0, 8) + '…' : null,
        storedPrefix: storedNonce ? storedNonce.slice(0, 8) + '…' : null,
      });

      // If installer nonce is missing but marker present, something inconsistent — mint a fresh nonce and proceed to clear
      let nonceToStore = installerNonce;
      if (!nonceToStore) {
        const generated = generateInstallNonce();
        writeInstallerNonce(userDataPath, generated);
        nonceToStore = generated;
        logger.info('[dks] marker present but nonce file missing — minted replacement nonce', { prefix: nonceToStore.slice(0, 8) + '…' });
      }

      if (!options.session) {
        logger.warn('[dks] genuine fresh install but no session available to clear — will retry next launch (marker retained)');
        return false;
      }

      const cleared = await tryClearSession(options.session, logger, userDataPath);
      if (!cleared) {
        logger.error('[dks] session clear failed for genuine fresh install — marker retained, will retry next launch');
        return false;
      }

      trySetStoredNonce(options.store, nonceToStore);
      try {
        unlinkSync(resetMarkerPath(userDataPath));
      } catch {}
      logger.info('[dks] genuine fresh install — session cleared, new nonce stored, marker removed (login requires email/password for Admin and Office; Office needs fresh Admin approval due to new Auth session_id)');
      return true;
    }

    // Legacy migration: existing install detected by installer (hasPer*), but nonce absent from both file and DB (v0.1.4→0.1.5)
    // Marker absent + stored null + installer nonce present → store without clearing (preserve login)
    // This is the critical path that previously caused one-time logout.
    if (!storedNonce && installerNonce) {
      logger.info('[dks] legacy in-place upgrade detected (stored null, installer nonce present, no reset marker) — preserving login, storing nonce as migration', {
        installerPrefix: installerNonce.slice(0, 8) + '…',
      });
      trySetStoredNonce(options.store, installerNonce);
      return true;
    }

    if (!storedNonce && !installerNonce) {
      // Both missing: very first launch on clean PC with no installer file (should not happen with new installer, but handle)
      // For first install, the installer SHOULD have created both nonce+marker, so this is fallback — mint without clear is safe for legacy, but for true first install clearing is harmless.
      // We treat as migration without clear to avoid unnecessary logout on first install, but either is acceptable since session is empty.
      // To ensure first-install also gets a nonce, mint and store without clearing.
      const generated = generateInstallNonce();
      writeInstallerNonce(userDataPath, generated);
      trySetStoredNonce(options.store, generated);
      logger.info('[dks] no installer nonce and no stored nonce (no marker) — minted and stored without clearing (first-install fallback)', { prefix: generated.slice(0, 8) + '…' });
      return true;
    }

    if (installerNonce && storedNonce === installerNonce) {
      return true;
    }

    // Unexpected mismatch without marker — treat as reset condition, clear fail-closed
    logger.info('[dks] nonce mismatch without reset marker — unexpected, clearing session fail-closed', {
      hasInstallerNonce: Boolean(installerNonce),
      hasStoredNonce: Boolean(storedNonce),
      installerPrefix: installerNonce ? installerNonce.slice(0, 8) + '…' : null,
      storedPrefix: storedNonce ? storedNonce.slice(0, 8) + '…' : null,
    });

    if (!options.session) {
      logger.warn('[dks] nonce mismatch but no session available — will retry next launch');
      return false;
    }

    const cleared = await tryClearSession(options.session, logger, userDataPath);
    if (!cleared) {
      logger.error('[dks] session clear failed for mismatch — will retry next launch');
      return false;
    }

    // Only after successful clear do we record new nonce (if we have one)
    const nonceToStore = installerNonce ?? generateInstallNonce();
    if (!installerNonce) {
      writeInstallerNonce(userDataPath, nonceToStore);
    }
    trySetStoredNonce(options.store, nonceToStore);
    return true;
  } catch (error) {
    try {
      logger.warn('[dks] session isolation check failed', error);
    } catch {}
    return false;
  }
}

async function tryClearSession(
  session: Pick<Session, 'clearStorageData'>,
  logger: Pick<typeof log, 'info' | 'warn' | 'error'>,
  userDataPath: string,
): Promise<boolean> {
  try {
    await session.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb'],
    } as Parameters<Session['clearStorageData']>[0]);
  } catch (error) {
    try {
      logger.error('[dks] clearStorageData failed — will retry next launch, not recording new nonce', error);
    } catch {}
    return false;
  }

  try {
    const sessionStoragePath = join(userDataPath, 'Session Storage');
    if (existsSync(sessionStoragePath)) {
      rmSync(sessionStoragePath, { recursive: true, force: true });
      logger.info('[dks] Session Storage directory removed via fs');
    }
  } catch (error) {
    try {
      logger.warn('[dks] Session Storage fs cleanup failed', error);
    } catch {}
  }

  return true;
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
