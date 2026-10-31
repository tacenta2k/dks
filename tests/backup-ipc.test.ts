// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BACKUP_IPC_CHANNELS } from '../electron/main/backup-types';
import type { BackupService } from '../electron/main/backup-service';
import { createBackupIpcHandlers, registerBackupIpcHandlers } from '../electron/main/backup-ipc';
import type { LocalIpcMain, LocalSessionClearance, LocalSessionRole } from '../electron/main/local-ipc';

/**
 * Admin enforcement for the backup bridge.
 *
 * The boundary is the main process: a renderer that claims `role: 'admin'`
 * without an admin session must get nothing. The preload validators are
 * defence-in-depth, not the boundary — and the Worker re-checks the signed
 * JWT anyway.
 */

function createServiceStub() {
  return {
    calls: [] as Array<[string, unknown]>,
    getState: vi.fn(() => ({ enabled: true })),
    runNow: vi.fn(async (trigger: string) => ({ outcome: 'verified', trigger })),
    list: vi.fn(async () => ({ year: 2026, month: 10, backups: [], nextCursor: null })),
    download: vi.fn(async () => ({ filePath: '/tmp/x', sizeBytes: 1, sha256: 'a' })),
    testDrill: vi.fn(async () => ({ ok: true })),
    setupKeyGenerate: vi.fn(async () => ({ ok: true, recoveryKey: 'r' })),
    setupKeyConfirm: vi.fn(async () => ({ ok: true })),
    setupKeyConfigure: vi.fn(async () => ({ ok: true })),
    healthCheck: vi.fn(async () => ({ ok: true, reachable: true, r2Bound: true, detail: null })),
    setSession: vi.fn(() => true),
  };
}

function createIpcMain() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const removed: string[] = [];
  const ipcMain: LocalIpcMain = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      removed.push(channel);
      handlers.delete(channel);
    },
  };
  return {
    ipcMain,
    removed,
    channels: () => [...handlers.keys()],
    // Mirrors Electron: a handler that throws rejects the renderer's invoke().
    send: async (channel: string, payload?: unknown) => {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`no handler for ${channel}`);
      return listener({ sender: {} }, payload);
    },
    has: (channel: string) => handlers.has(channel),
  };
}

/** A handler may throw synchronously (Electron turns that into a rejection). */
function invoke(handler: (payload?: unknown) => unknown, payload?: unknown): Promise<unknown> {
  return Promise.resolve().then(() => handler(payload));
}

const ADMIN_CHANNELS = [
  BACKUP_IPC_CHANNELS.getState,
  BACKUP_IPC_CHANNELS.runNow,
  BACKUP_IPC_CHANNELS.list,
  BACKUP_IPC_CHANNELS.download,
  BACKUP_IPC_CHANNELS.testDrill,
  BACKUP_IPC_CHANNELS.setupKey,
  BACKUP_IPC_CHANNELS.healthCheck,
] as const;

const ADMIN_PAYLOADS: Record<string, unknown> = {
  [BACKUP_IPC_CHANNELS.getState]: { role: 'admin' },
  [BACKUP_IPC_CHANNELS.runNow]: { role: 'admin', trigger: 'manual' },
  [BACKUP_IPC_CHANNELS.list]: { role: 'admin', year: 2026, month: 10 },
  [BACKUP_IPC_CHANNELS.download]: { role: 'admin', objectKey: 'backups/2026/10/2026-10-31/080000-abc123abc123.sqlite.enc' },
  [BACKUP_IPC_CHANNELS.testDrill]: { role: 'admin' },
  [BACKUP_IPC_CHANNELS.setupKey]: { role: 'admin', action: 'generate' },
  [BACKUP_IPC_CHANNELS.healthCheck]: { role: 'admin' },
};

describe('main-process admin enforcement', () => {
  it('refuses every admin channel without an admin payload', async () => {
    for (const payload of [undefined, null, {}, { role: 'staff' }, { role: 'office' }, 'admin']) {
      const service = createServiceStub();
      const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
      for (const channel of ADMIN_CHANNELS) {
        await expect(invoke(handlers[channel], payload)).rejects.toThrow(/administrator role is required/);
      }
      expect(service.runNow).not.toHaveBeenCalled();
      expect(service.healthCheck).not.toHaveBeenCalled();
    }
  });

  it('refuses a non-admin session even when the payload claims admin', async () => {
    // 'office' is the real case; 'staff' stands in for any future role.
    for (const role of ['office', 'staff'] as LocalSessionRole[]) {
      const service = createServiceStub();
      const handlers = createBackupIpcHandlers({
        service: service as unknown as BackupService,
        sessionRole: () => role,
      });
      await expect(invoke(handlers[BACKUP_IPC_CHANNELS.getState], { role: 'admin' }))
        .rejects.toThrow(/administrator role is required/);
    }
  });

  it('refuses an office session awaiting approval on every admin channel', async () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({
      service: service as unknown as BackupService,
      sessionClearance: () => 'office-pending' as LocalSessionClearance,
    });
    for (const channel of ADMIN_CHANNELS) {
      await expect(invoke(handlers[channel], ADMIN_PAYLOADS[channel])).rejects.toThrow();
    }
    await expect(
      invoke(handlers[BACKUP_IPC_CHANNELS.setSession], { role: 'admin', accessToken: 'tok' }),
    ).rejects.toThrow(/admin approval/);
  });

  it('lets an admin through on every admin channel', async () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    expect(await handlers[BACKUP_IPC_CHANNELS.getState]({ role: 'admin' })).toEqual({ enabled: true });
    expect(await handlers[BACKUP_IPC_CHANNELS.runNow]({ role: 'admin', trigger: 'hourly' })).toMatchObject({ outcome: 'verified' });
    expect(await handlers[BACKUP_IPC_CHANNELS.list]({ role: 'admin', year: 2026, month: 10 })).toMatchObject({ backups: [] });
    expect(await handlers[BACKUP_IPC_CHANNELS.healthCheck]({ role: 'admin' })).toMatchObject({ ok: true });
    expect(service.runNow).toHaveBeenCalledWith('hourly');
  });

  it('treats an unrecognised trigger as manual instead of trusting it', async () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    await handlers[BACKUP_IPC_CHANNELS.runNow]({ role: 'admin', trigger: 'drop-table' });
    expect(service.runNow).toHaveBeenCalledWith('manual');
  });

  it('validates the history window before touching the service', async () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    for (const bad of [
      { role: 'admin', year: 1999, month: 1 },
      { role: 'admin', year: 2026, month: 13 },
      { role: 'admin', year: 2026, month: 0 },
      { role: 'admin', year: '2026', month: 10 },
      { role: 'admin', year: 2026 },
    ]) {
      await expect(invoke(handlers[BACKUP_IPC_CHANNELS.list], bad)).rejects.toThrow();
    }
    expect(service.list).not.toHaveBeenCalled();
  });

  it('refuses a download path that is not a server-issued object key', async () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    for (const objectKey of ['../secrets.txt', 'backups/../../etc/passwd', 'backups\\2026\\x.sqlite.enc', '', 'not-a-key']) {
      await expect(
        invoke(handlers[BACKUP_IPC_CHANNELS.download], { role: 'admin', objectKey }),
      ).rejects.toThrow();
    }
    expect(service.download).not.toHaveBeenCalled();
  });

  it('accepts a drill request and rejects an unknown key-setup step', async () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    expect(await handlers[BACKUP_IPC_CHANNELS.testDrill]({ role: 'admin' })).toEqual({ ok: true });
    expect(await handlers[BACKUP_IPC_CHANNELS.setupKey]({ role: 'admin', action: 'wipe' })).toEqual({
      ok: false,
      message: 'Unknown key setup step',
    });
  });
});

describe('session credential push', () => {
  it('clears the credential on sign-out without needing a role', () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    expect(handlers[BACKUP_IPC_CHANNELS.setSession](null)).toEqual({ ok: true });
    expect(service.setSession).toHaveBeenCalledWith(null);
  });

  it('accepts an approved office credential so office PCs still back up', () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({
      service: service as unknown as BackupService,
      sessionClearance: () => 'allowed' as LocalSessionClearance,
    });
    expect(handlers[BACKUP_IPC_CHANNELS.setSession]({ role: 'office', accessToken: 'tok' })).toEqual({ ok: true });
    expect(service.setSession).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'office', accessToken: 'tok' }),
    );
  });

  it('refuses a credential with no role at all', () => {
    const service = createServiceStub();
    const handlers = createBackupIpcHandlers({ service: service as unknown as BackupService });
    expect(() => handlers[BACKUP_IPC_CHANNELS.setSession]({ accessToken: 'tok' })).toThrow(/role is required/);
  });
});

describe('handler registration', () => {
  it('registers exactly the eight backup channels and hands over only the payload', async () => {
    const service = createServiceStub();
    const harness = createIpcMain();
    const unregister = registerBackupIpcHandlers({
      service: service as unknown as BackupService,
      ipcMain: harness.ipcMain,
    });

    expect(harness.channels().sort()).toEqual([...Object.values(BACKUP_IPC_CHANNELS)].sort());
    expect(harness.channels()).toHaveLength(8);

    await harness.send(BACKUP_IPC_CHANNELS.getState, { role: 'admin' });
    expect(service.getState).toHaveBeenCalledTimes(1);

    // The Electron event object must never reach the handler as its payload.
    await expect(harness.send(BACKUP_IPC_CHANNELS.getState)).rejects.toThrow(
      /administrator role is required/,
    );

    unregister();
    expect(harness.channels()).toEqual([]);
    // 8 removed when the handlers were installed, 8 more on unregister.
    expect(harness.removed).toHaveLength(16);
  });

  it('replaces a handler left behind by an earlier registration', () => {
    const service = createServiceStub();
    const harness = createIpcMain();
    harness.ipcMain.handle(BACKUP_IPC_CHANNELS.getState, () => 'stale');
    registerBackupIpcHandlers({ service: service as unknown as BackupService, ipcMain: harness.ipcMain });
    expect(harness.removed).toContain(BACKUP_IPC_CHANNELS.getState);
  });
});
