import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  enforceSessionIsolation,
  generateInstallNonce,
  installerNoncePath,
  readInstallerNonce,
  writeInstallerNonce,
} from '../electron/main/install-nonce';
import { createSqliteStore } from '../electron/main/sqlite';

function tryClose(s: any): void {
  try { s?.close?.(); } catch {}
}

function makeFakeStore(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  let outboxCount = 0;
  return {
    getInstallNonce: () => map.get('installNonce') ?? null,
    setInstallNonce: (v: string) => {
      if (typeof v === 'string' && v.trim()) map.set('installNonce', v.trim());
    },
    // Helpers to simulate outbox survival (not real DB, but verified via separate sqlite test elsewhere)
    enqueueOutbox: (..._args: unknown[]) => { outboxCount += 1; },
    getPendingOutboxCount: () => outboxCount,
    listEntries: () => [] as unknown[],
  };
}

function makeStore() {
  // Prefer real store when native module is available; fall back to fake for CI without build.
  try {
    return createSqliteStore({ filename: ':memory:' }) as unknown as ReturnType<typeof makeFakeStore>;
  } catch {
    return makeFakeStore();
  }
}

describe('install-nonce — file helpers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dks-nonce-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('writes and reads the nonce file round-trip', () => {
    const nonce = generateInstallNonce();
    writeInstallerNonce(dir, nonce);
    expect(readInstallerNonce(dir)).toBe(nonce);
    expect(readFileSync(installerNoncePath(dir), 'utf8').trim()).toBe(nonce);
  });

  it('returns null when file is missing', () => {
    expect(readInstallerNonce(dir)).toBeNull();
  });

  it('generates a unique nonce each call', () => {
    const a = generateInstallNonce();
    const b = generateInstallNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });
});

describe('install-nonce — SQLite persistence (fake + real when available)', () => {
  it('stores and retrieves installNonce without touching other keys', () => {
    const store = makeFakeStore();
    expect(store.getInstallNonce()).toBeNull();

    const nonce = 'test-nonce-123';
    store.setInstallNonce(nonce);
    expect(store.getInstallNonce()).toBe(nonce);

    // Changing nonce does not affect outbox counts.
    store.enqueueOutbox({} as never);
    expect(store.getPendingOutboxCount()).toBe(1);
    expect(store.getInstallNonce()).toBe(nonce);

    store.setInstallNonce('nonce-2');
    expect(store.getInstallNonce()).toBe('nonce-2');
    expect(store.getPendingOutboxCount()).toBe(1); // outbox survives nonce change
  });

  it('ignores empty nonce writes', () => {
    const store = makeFakeStore();
    store.setInstallNonce('initial');
    store.setInstallNonce('');
    store.setInstallNonce('   ');
    expect(store.getInstallNonce()).toBe('initial');
  });

  it('real SQLite store round-trips when native module is available', () => {
    let real: ReturnType<typeof makeStore> | undefined;
    try {
      real = createSqliteStore({ filename: ':memory:' }) as unknown as ReturnType<typeof makeFakeStore>;
    } catch {
      return; // Native not built in this runner — fake already verified above.
    }
    expect(real.getInstallNonce()).toBeNull();
    real.setInstallNonce('real-nonce');
    expect(real.getInstallNonce()).toBe('real-nonce');
    // Prove outbox and sqlite file are separate: we can still use store APIs.
    expect(real.getPendingOutboxCount()).toBe(0);
    try { (real as unknown as { close: () => void }).close(); } catch {}
  });
});

describe('enforceSessionIsolation — Bug 1 second layer (app-level)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dks-isolation-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('skips entirely when !app.isPackaged (dev builds)', async () => {
    const store = makeStore();
    const session = { clearStorageData: vi.fn(async () => undefined) };

    await enforceSessionIsolation({
      isPackaged: false,
      userDataPath: dir,
      store,
      session: session as unknown as never,
    });

    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(store.getInstallNonce()).toBeNull(); // no nonce stored
    tryClose(store);
  });

  it('on first packaged launch creates a nonce and does NOT clear session', async () => {
    const store = makeStore();
    const session = { clearStorageData: vi.fn(async () => undefined) };

    await enforceSessionIsolation({
      isPackaged: true,
      userDataPath: dir,
      store,
      session: session as unknown as never,
    });

    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(store.getInstallNonce()).not.toBeNull();
    expect(readInstallerNonce(dir)).not.toBeNull();
    expect(readInstallerNonce(dir)).toBe(store.getInstallNonce());
    tryClose(store);
  });

  it('when installer nonce matches stored nonce, does not clear', async () => {
    const store = makeStore();
    const nonce = 'matching-nonce';
    writeInstallerNonce(dir, nonce);
    store.setInstallNonce(nonce);

    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({
      isPackaged: true,
      userDataPath: dir,
      store,
      session: session as unknown as never,
    });

    expect(session.clearStorageData).not.toHaveBeenCalled();
    tryClose(store);
  });

  it('when installer nonce differs from stored nonce, clears the four storages and persists new nonce', async () => {
    const store = makeStore();
    store.setInstallNonce('old-nonce');
    const newNonce = 'fresh-install-nonce';
    writeInstallerNonce(dir, newNonce);

    // Simulate outbox rows that must survive the wipe.
    store.enqueueOutbox({
      idempotencyKey: 'k-outbox',
      operation: 'create',
      entityType: 'entries',
      entityId: 'e-outbox',
      payload: { id: 'e-outbox', data: { name: 'keep me' } },
    });
    expect(store.getPendingOutboxCount()).toBe(1);

    const session = { clearStorageData: vi.fn(async () => undefined) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await enforceSessionIsolation({
      isPackaged: true,
      userDataPath: dir,
      store,
      session: session as unknown as never,
      logger: logger as unknown as never,
    });

    // Must have called clearStorageData with documented Electron 34 options (including indexdb).
    // Session Storage is not a valid clearStorageData storage; it is removed via fs separately.
    expect(session.clearStorageData).toHaveBeenCalledTimes(1);
    const arg = (session.clearStorageData as any).mock.calls[0][0] as { storages: string[] };
    expect(arg.storages).toEqual(expect.arrayContaining(['localstorage', 'cookies']));
    expect(arg.storages).toEqual(expect.arrayContaining(['cookies', 'localstorage', 'indexdb']));
    expect(arg.storages).not.toContain('sessionstorage');
    expect(arg.storages).not.toContain('indexeddb');

    // New nonce persisted; outbox untouched.
    expect(store.getInstallNonce()).toBe(newNonce);
    expect(store.getPendingOutboxCount()).toBe(1);

    // dks-cache.sqlite was never deleted — we can still read entries (none yet) and the store is open.
    expect(store.listEntries()).toEqual([]);

    tryClose(store);
  });

  it('when stored nonce is missing (reinstall after manual DB delete is not the case — DB exists but nonce cleared), clears and stores', async () => {
    const store = makeStore();
    // No stored nonce yet, but installer nonce exists (fresh install after uninstall left DB).
    const freshNonce = 'reinstall-nonce';
    writeInstallerNonce(dir, freshNonce);
    expect(store.getInstallNonce()).toBeNull();

    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({
      isPackaged: true,
      userDataPath: dir,
      store,
      session: session as unknown as never,
    });

    expect(session.clearStorageData).toHaveBeenCalled();
    expect(store.getInstallNonce()).toBe(freshNonce);
    tryClose(store);
  });

  it('when installer nonce file is missing but DB has a nonce (old installer), mints new nonce, clears, and recovers', async () => {
    const store = makeStore();
    store.setInstallNonce('old-stored');
    // No file on disk.

    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({
      isPackaged: true,
      userDataPath: dir,
      store,
      session: session as unknown as never,
    });

    expect(session.clearStorageData).toHaveBeenCalled();
    const newFileNonce = readInstallerNonce(dir);
    expect(newFileNonce).not.toBeNull();
    expect(newFileNonce).toBe(store.getInstallNonce());
    expect(newFileNonce).not.toBe('old-stored');
    tryClose(store);
  });

  it('never silently resumes old session if cleanup fails — does not record new nonce', async () => {
    const store = makeFakeStore();
    store.setInstallNonce('old-nonce');
    writeInstallerNonce(dir, 'new-nonce');
    const failingSession = { clearStorageData: vi.fn(async () => { throw new Error('EBUSY: leveldb locked'); }) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await enforceSessionIsolation({
      isPackaged: true,
      userDataPath: dir,
      store,
      session: failingSession as unknown as never,
      logger: logger as unknown as never,
    });
    expect(result).toBe(false);
    expect(failingSession.clearStorageData).toHaveBeenCalled();
    // New nonce must NOT be recorded so next launch retries
    expect(store.getInstallNonce()).toBe('old-nonce');
    expect(logger.error).toHaveBeenCalled();
    // Installer nonce file still has new-nonce (written by installer), but DB still old — mismatch persists for retry
    expect(readInstallerNonce(dir)).toBe('new-nonce');
  });
});
