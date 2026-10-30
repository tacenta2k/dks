import * as os from 'node:os';

import {
  type ErrorReportingStatusSummary,
  MainErrorReporter,
  type SanitizedErrorReportEvent,
  sanitizeAppVersion,
  sanitizeArch,
  sanitizeElectronVersion,
  sanitizeOsRelease,
  sanitizePlatform,
} from './error-reporter';
import type { LocalIpcMain, LocalSessionClearance, LocalSessionRole } from './local-ipc';
import type { LocalStoreFailure } from './local-store-diagnostics';
import type { SqliteStore } from './sqlite';
import type { SyncStatus } from './sync';
import type { UpdateState, UpdateStatus } from './updater';

export const DIAGNOSTICS_IPC_CHANNELS = Object.freeze({
  getAdminStatus: 'dks:diagnostics:get-admin-status',
  captureError: 'dks:diagnostics:capture-error',
  claimErrorReports: 'dks:diagnostics:claim-error-reports',
  completeErrorReport: 'dks:diagnostics:complete-error-report',
  setErrorReportingEnabled: 'dks:diagnostics:set-error-reporting-enabled',
  syncWorkspaceErrorReporting: 'dks:diagnostics:sync-workspace-error-reporting',
});

export type DiagnosticsIpcChannel =
  (typeof DIAGNOSTICS_IPC_CHANNELS)[keyof typeof DIAGNOSTICS_IPC_CHANNELS];

export interface AdminLocalStatusSnapshot {
  appVersion: string;
  packaged: boolean;
  platform: 'win32' | 'darwin' | 'linux' | 'unknown';
  arch: 'x64' | 'arm64' | 'ia32' | 'unknown';
  osRelease: string;
  electronVersion: string | null;
  localStore: {
    available: boolean;
    schemaVersion: number | null;
    failureCode: 'ABI_MISMATCH' | 'OPEN_FAILED' | null;
  };
  sync: {
    status: SyncStatus | 'unknown';
    lastSyncAt: string | null;
    pendingOutboxCount: number;
    failedOutboxCount: number;
    terminalOutboxCount: number;
  };
  updater: {
    status: UpdateStatus;
    version: string | null;
    errorKind: 'check' | 'download' | null;
    errorCode: string | null;
  };
  errorReporting: ErrorReportingStatusSummary;
}

export interface DiagnosticsIpcDependencies {
  reporter: MainErrorReporter;
  getStore: () => SqliteStore | undefined;
  getStoreFailure: () => LocalStoreFailure | null;
  getUpdaterState?: () => UpdateState;
  sessionClearance?: () => LocalSessionClearance;
  sessionRole?: () => LocalSessionRole | null;
  appVersion: string;
  packaged: boolean;
  platform?: string;
  arch?: string;
  osRelease?: string;
  electronVersion?: string | null;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;
const COMPLETE_OUTCOMES = new Set([
  'delivered',
  'suppressed_remote',
  'disabled',
  'retry',
  'terminal',
]);
const SAFE_UPDATER_CODE_PATTERN = /^[A-Z0-9_.:-]{2,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeUpdaterErrorCode(state: UpdateState | undefined): string | null {
  if (!state || state.status !== 'error') return null;
  if (typeof state.errorCode === 'string') {
    const normalized = state.errorCode.trim().toUpperCase();
    if (SAFE_UPDATER_CODE_PATTERN.test(normalized)) {
      return normalized;
    }
  }
  return state.errorKind === 'download' ? 'UPDATER_DOWNLOAD_FAILED' : 'UPDATER_CHECK_FAILED';
}

function assertAdminAuthorized(
  payload: unknown,
  clearance: LocalSessionClearance,
  reportedRole: LocalSessionRole | null,
): void {
  if (clearance === 'office-pending') {
    throw new Error('administrator role is required');
  }
  if (reportedRole === 'office') {
    throw new Error('administrator role is required');
  }
  if (!isRecord(payload) || payload.role !== 'admin') {
    throw new Error('administrator role is required');
  }
}

function assertClearedSession(
  payload: unknown,
  clearance: LocalSessionClearance,
  reportedRole: LocalSessionRole | null,
): 'admin' | 'office' {
  if (clearance === 'office-pending') {
    throw new Error('Waiting for admin approval — session is not cleared.');
  }
  if (reportedRole === 'admin' || reportedRole === 'office') {
    return reportedRole;
  }
  if (isRecord(payload) && (payload.role === 'admin' || payload.role === 'office')) {
    return payload.role;
  }
  throw new Error('authenticated session role is required');
}

export function createDiagnosticsIpcHandlers(dependencies: DiagnosticsIpcDependencies) {
  const getClearance = dependencies.sessionClearance ?? (() => 'allowed' as LocalSessionClearance);
  const getRole = dependencies.sessionRole ?? (() => null);
  const appVersion = sanitizeAppVersion(dependencies.appVersion);
  const packaged = dependencies.packaged === true;
  const platform = sanitizePlatform(dependencies.platform ?? process.platform);
  const arch = sanitizeArch(dependencies.arch ?? process.arch);
  const osRelease = sanitizeOsRelease(dependencies.osRelease ?? os.release());
  const electronVersion = sanitizeElectronVersion(
    dependencies.electronVersion ?? process.versions?.electron ?? null,
  );

  return {
    [DIAGNOSTICS_IPC_CHANNELS.getAdminStatus]: (payload: unknown): AdminLocalStatusSnapshot => {
      assertAdminAuthorized(payload, getClearance(), getRole());

      const store = dependencies.getStore();
      const failure = dependencies.getStoreFailure();
      const updaterState = dependencies.getUpdaterState?.();

      let localStoreAvailable = false;
      let schemaVersion: number | null = null;
      let syncStatus: SyncStatus | 'unknown' = 'unknown';
      let lastSyncAt: string | null = null;
      let pendingOutboxCount = 0;
      let failedOutboxCount = 0;
      let terminalOutboxCount = 0;

      if (store) {
        try {
          schemaVersion = store.getMigrationVersion();
          const syncState = store.getSyncStatus();
          const outboxSummary = store.getOutboxSummary();
          localStoreAvailable = true;
          syncStatus = syncState.status;
          lastSyncAt = syncState.lastSyncAt ?? null;
          pendingOutboxCount = outboxSummary.pendingCount;
          failedOutboxCount = outboxSummary.failedCount;
          terminalOutboxCount = outboxSummary.terminalCount;
        } catch {
          localStoreAvailable = false;
        }
      }

      const failureCode: 'ABI_MISMATCH' | 'OPEN_FAILED' | null = localStoreAvailable
        ? null
        : failure?.abiMismatch
          ? 'ABI_MISMATCH'
          : failure
            ? 'OPEN_FAILED'
            : 'OPEN_FAILED';

      return {
        appVersion,
        packaged,
        platform,
        arch,
        osRelease,
        electronVersion,
        localStore: {
          available: localStoreAvailable,
          schemaVersion,
          failureCode: localStoreAvailable ? null : failureCode,
        },
        sync: {
          status: syncStatus,
          lastSyncAt,
          pendingOutboxCount,
          failedOutboxCount,
          terminalOutboxCount,
        },
        updater: {
          status: updaterState?.status ?? (packaged ? 'idle' : 'disabled'),
          version: typeof updaterState?.version === 'string' ? updaterState.version : null,
          errorKind: updaterState?.errorKind ?? null,
          errorCode: sanitizeUpdaterErrorCode(updaterState),
        },
        errorReporting: dependencies.reporter.getStatusSummary(),
      };
    },

    [DIAGNOSTICS_IPC_CHANNELS.captureError]: (payload: unknown): {
      accepted: boolean;
      reason?: string;
    } => {
      const result = dependencies.reporter.capture(payload, 'renderer');
      return {
        accepted: result.accepted,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },

    [DIAGNOSTICS_IPC_CHANNELS.claimErrorReports]: (payload: unknown): SanitizedErrorReportEvent[] => {
      assertClearedSession(payload, getClearance(), getRole());
      const limit = isRecord(payload) && typeof payload.limit === 'number'
        ? Math.max(1, Math.min(3, Math.trunc(payload.limit)))
        : 3;
      return dependencies.reporter.claimReady(limit);
    },

    [DIAGNOSTICS_IPC_CHANNELS.completeErrorReport]: (payload: unknown): { ok: boolean } => {
      assertClearedSession(payload, getClearance(), getRole());
      if (!isRecord(payload)) {
        throw new Error('complete error report input must be an object');
      }
      const fingerprint = payload.fingerprint;
      if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
        throw new Error('valid report fingerprint is required');
      }
      const outcome = payload.outcome;
      if (typeof outcome !== 'string' || !COMPLETE_OUTCOMES.has(outcome)) {
        throw new Error('valid delivery outcome is required');
      }
      const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : null;
      const retryAfterSeconds = typeof payload.retryAfterSeconds === 'number' && Number.isFinite(payload.retryAfterSeconds)
        ? payload.retryAfterSeconds
        : null;
      dependencies.reporter.completeDelivery({
        fingerprint,
        outcome: outcome as 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal',
        errorCode,
        retryAfterSeconds,
      });
      return { ok: true };
    },

    [DIAGNOSTICS_IPC_CHANNELS.setErrorReportingEnabled]: (payload: unknown): ErrorReportingStatusSummary => {
      assertAdminAuthorized(payload, getClearance(), getRole());
      if (!isRecord(payload) || typeof payload.enabled !== 'boolean') {
        throw new Error('enabled must be a boolean');
      }
      dependencies.reporter.setEnabled(payload.enabled);
      return dependencies.reporter.getStatusSummary();
    },

    [DIAGNOSTICS_IPC_CHANNELS.syncWorkspaceErrorReporting]: (payload: unknown): { ok: boolean; enabled: boolean } => {
      assertClearedSession(payload, getClearance(), getRole());
      if (!isRecord(payload) || typeof payload.enabled !== 'boolean') {
        throw new Error('enabled must be a boolean');
      }
      dependencies.reporter.setEnabled(payload.enabled);
      return { ok: true, enabled: dependencies.reporter.isEnabled() };
    },
  };
}

export function registerDiagnosticsIpcHandlers(
  dependencies: DiagnosticsIpcDependencies & { ipcMain: LocalIpcMain },
): () => void {
  const handlers = createDiagnosticsIpcHandlers(dependencies);
  const channels = Object.values(DIAGNOSTICS_IPC_CHANNELS);

  for (const channel of channels) {
    dependencies.ipcMain.removeHandler?.(channel);
    dependencies.ipcMain.handle(channel, (_event, payload) => handlers[channel](payload));
  }

  return () => {
    for (const channel of channels) {
      dependencies.ipcMain.removeHandler?.(channel);
    }
  };
}
