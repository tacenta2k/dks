// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTICS_IPC_CHANNELS,
  registerDiagnosticsIpcHandlers,
} from '../electron/main/diagnostics-ipc';
import { MainErrorReporter } from '../electron/main/error-reporter';
import type { LocalIpcMain, LocalSessionClearance, LocalSessionRole } from '../electron/main/local-ipc';
import { createLocalStoreFailure } from '../electron/main/local-store-diagnostics';
import { createSqliteStore, type SqliteStore } from '../electron/main/sqlite';
import { can } from '../src/lib/permissions';

function createTempStore(): SqliteStore {
  return createSqliteStore({ filename: ':memory:' });
}

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const ipcMain: LocalIpcMain = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  return { ipcMain, handlers };
}

describe('diagnostics permissions & IPC authorization boundary', () => {
  it('grants adminStatus capability ONLY to admin role', () => {
    expect(can('admin', 'adminStatus')).toBe(true);
    expect(can('office', 'adminStatus')).toBe(false);
    expect(can(null, 'adminStatus')).toBe(false);
    expect(can(undefined, 'adminStatus')).toBe(false);
  });

  it('enforces Admin-only access on get-admin-status and set-error-reporting-enabled while allowing cleared Office sessions to queue safe reports', () => {
    const store = createTempStore();
    try {
      let clearance: LocalSessionClearance = 'office-pending';
      let sessionRole: LocalSessionRole | null = null;
      const reporter = new MainErrorReporter({
        store,
        appVersion: '1.1.3',
        packaged: true,
      });
      const { ipcMain, handlers } = fakeIpcMain();

      registerDiagnosticsIpcHandlers({
        ipcMain,
        reporter,
        getStore: () => store,
        getStoreFailure: () => null,
        sessionClearance: () => clearance,
        sessionRole: () => sessionRole,
        getUpdaterState: () => ({ status: 'idle' }),
        appVersion: '1.1.3',
        packaged: true,
      });

      // 1. Pending Office session (`clearance = 'office-pending'`): blocked on ALL session/admin channels,
      //    even if a forged renderer payload claims `{ role: 'admin' }`!
      sessionRole = 'office';
      expect(() =>
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.getAdminStatus)?.({}, { role: 'admin' }),
      ).toThrow(/administrator role is required/);
      expect(() =>
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.setErrorReportingEnabled)?.({}, { role: 'admin', enabled: false }),
      ).toThrow(/administrator role is required/);
      expect(() =>
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.claimErrorReports)?.({}, { role: 'office', limit: 3 }),
      ).toThrow(/Waiting for admin approval/);

      // 2. Approved Office session (`clearance = 'allowed', sessionRole = 'office'`):
      //    still blocked from Admin Status & setting mutation, even if payload spoofs `{ role: 'admin' }`!
      clearance = 'allowed';
      expect(() =>
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.getAdminStatus)?.({}, { role: 'admin' }),
      ).toThrow(/administrator role is required/);
      expect(() =>
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.setErrorReportingEnabled)?.({}, { role: 'admin', enabled: false }),
      ).toThrow(/administrator role is required/);

      // Cleared Office CAN capture & claim background diagnostic reports:
      expect(
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.captureError)?.({}, {
          category: 'sync',
          severity: 'error',
          code: 'SYNC_REMOTE_FAILED',
          component: 'renderer/sync',
        }),
      ).toEqual({ accepted: true, reason: undefined });

      const claimed = handlers.get(DIAGNOSTICS_IPC_CHANNELS.claimErrorReports)?.({}, {
        role: 'office',
        limit: 3,
      }) as Array<{ fingerprint: string }>;
      expect(claimed).toHaveLength(1);
      expect(
        handlers.get(DIAGNOSTICS_IPC_CHANNELS.completeErrorReport)?.({}, {
          role: 'office',
          fingerprint: claimed[0].fingerprint,
          outcome: 'delivered',
        }),
      ).toEqual({ ok: true });

      // 3. Admin session (`clearance = 'allowed', sessionRole = 'admin'`): full truthful status + toggle control.
      sessionRole = 'admin';
      const status = handlers.get(DIAGNOSTICS_IPC_CHANNELS.getAdminStatus)?.({}, { role: 'admin' }) as {
        appVersion: string;
        localStore: { available: boolean; schemaVersion: number };
        errorReporting: { enabled: boolean; lastDeliveryOutcome: string };
      };
      expect(status.appVersion).toBe('1.1.3');
      expect(status.localStore).toEqual({
        available: true,
        schemaVersion: 4,
        failureCode: null,
      });
      expect(status.errorReporting.enabled).toBe(true);
      expect(status.errorReporting.lastDeliveryOutcome).toBe('delivered');

      const disabledSummary = handlers.get(DIAGNOSTICS_IPC_CHANNELS.setErrorReportingEnabled)?.({}, {
        role: 'admin',
        enabled: false,
      }) as { enabled: boolean };
      expect(disabledSummary.enabled).toBe(false);
      expect(store.getErrorReportingEnabledMeta()).toBe(false);
    } finally {
      store.close();
    }
  });

  it('returns truthful ABI_MISMATCH status to Admin even when SQLite failed to open', () => {
    const abiFailure = createLocalStoreFailure(
      new Error(
        'was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 132.',
      ),
    );
    const { ipcMain, handlers } = fakeIpcMain();
    const reporter = new MainErrorReporter({
      appVersion: '1.1.3',
      packaged: true,
    });

    registerDiagnosticsIpcHandlers({
      ipcMain,
      reporter,
      getStore: () => undefined,
      getStoreFailure: () => abiFailure,
      sessionClearance: () => 'allowed',
      sessionRole: () => 'admin',
      appVersion: '1.1.3',
      packaged: true,
    });

    const status = handlers.get(DIAGNOSTICS_IPC_CHANNELS.getAdminStatus)?.({}, { role: 'admin' }) as {
      localStore: { available: boolean; schemaVersion: number | null; failureCode: string | null };
      sync: { status: string; pendingOutboxCount: number };
    };
    expect(status.localStore).toEqual({
      available: false,
      schemaVersion: null,
      failureCode: 'ABI_MISMATCH',
    });
    expect(status.sync.status).toBe('unknown');
  });
});
