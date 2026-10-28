import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  enforceSessionIsolation,
  generateInstallNonce,
  installerNoncePath,
  resetMarkerPath,
  readInstallerNonce,
  writeInstallerNonce,
  hasResetMarker,
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
    enqueueOutbox: (..._args: unknown[]) => { outboxCount += 1; },
    getPendingOutboxCount: () => outboxCount,
    listEntries: () => [] as unknown[],
  };
}

function makeStore() {
  try {
    return createSqliteStore({ filename: ':memory:' }) as unknown as ReturnType<typeof makeFakeStore>;
  } catch {
    return makeFakeStore();
  }
}

describe('install-nonce — file helpers', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dks-nonce-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

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

  it('detects session-reset-required marker', () => {
    expect(hasResetMarker(dir)).toBe(false);
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
    expect(hasResetMarker(dir)).toBe(true);
    rmSync(resetMarkerPath(dir), { force: true });
    expect(hasResetMarker(dir)).toBe(false);
  });
});

describe('enforceSessionIsolation — login matrix A–F', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dks-isolation-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('skips entirely when !app.isPackaged (dev builds)', async () => {
    const store = makeStore();
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: false, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(store.getInstallNonce()).toBeNull();
    tryClose(store);
  });

  it('A. quit/reopen — same nonce preserves login (no clear)', async () => {
    const store = makeStore();
    const nonce = 'matching-nonce-A';
    writeInstallerNonce(dir, nonce);
    store.setInstallNonce(nonce);
    const session = { clearStorageData: vi.fn(async () => undefined) };
    const result = await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(result).toBe(true);
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(hasResetMarker(dir)).toBe(false);
    tryClose(store);
  });

  it('B. automatic update — preserves nonce/session (isUpdated path, marker absent)', async () => {
    const store = makeStore();
    const nonce = 'auto-update-nonce';
    writeInstallerNonce(dir, nonce);
    store.setInstallNonce(nonce);
    // Simulate auto-update: installer preserved nonce, no marker
    expect(hasResetMarker(dir)).toBe(false);
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(store.getInstallNonce()).toBe(nonce);
    tryClose(store);
  });

  it('C. manual in-place upgrade — preserves nonce/session (existing install, preserved file)', async () => {
    const store = makeStore();
    const nonce = 'manual-inplace-nonce';
    writeInstallerNonce(dir, nonce);
    store.setInstallNonce(nonce);
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).not.toHaveBeenCalled();
    tryClose(store);
  });

  it('D. legacy 0.1.4 → 0.1.5 in-place — stored null + installer nonce present, no marker → preserve and store without clearing', async () => {
    const store = makeStore();
    const legacyNonce = 'fresh-0.1.5-nonce-for-legacy';
    writeInstallerNonce(dir, legacyNonce);
    expect(store.getInstallNonce()).toBeNull();
    expect(hasResetMarker(dir)).toBe(false);
    const session = { clearStorageData: vi.fn(async () => undefined) };
    const result = await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(result).toBe(true);
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(store.getInstallNonce()).toBe(legacyNonce);
    expect(hasResetMarker(dir)).toBe(false);
    tryClose(store);
  });

  it('D2. legacy with no file and no stored nonce — mints without clearing', async () => {
    const store = makeStore();
    expect(readInstallerNonce(dir)).toBeNull();
    expect(store.getInstallNonce()).toBeNull();
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).not.toHaveBeenCalled();
    const minted = readInstallerNonce(dir);
    expect(minted).not.toBeNull();
    expect(store.getInstallNonce()).toBe(minted);
    expect(hasResetMarker(dir)).toBe(false);
    tryClose(store);
  });

  it('E. genuine uninstall/reinstall — marker present + new nonce → clear session, store new nonce, remove marker, sqlite/outbox intact', async () => {
    const store = makeStore();
    // Simulate prior install's DB with old nonce and outbox surviving uninstall
    store.setInstallNonce('old-nonce-before-uninstall');
    try { store.enqueueOutbox({ idempotencyKey: 'k-old-1', entityType: 'entry', entityId: 'e1', operation: 'upsert', payload: {} } as never); } catch { (store as unknown as { enqueueOutbox: (a: unknown)=>void }).enqueueOutbox({} as never); }
    expect(store.getPendingOutboxCount()).toBe(1);
    // Uninstall deletes session files + nonce but preserves sqlite — now reinstall creates new nonce + marker
    const newNonce = 'reinstall-new-nonce-E';
    writeInstallerNonce(dir, newNonce);
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
    expect(hasResetMarker(dir)).toBe(true);
    const session = { clearStorageData: vi.fn(async () => undefined) };
    const result = await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(result).toBe(true);
    expect(session.clearStorageData).toHaveBeenCalledTimes(1);
    const arg = (session.clearStorageData as any).mock.calls[0][0] as { storages: string[] };
    expect(arg.storages).toEqual(expect.arrayContaining(['cookies', 'localstorage', 'indexdb']));
    expect(store.getInstallNonce()).toBe(newNonce);
    expect(hasResetMarker(dir)).toBe(false);
    expect(store.getPendingOutboxCount()).toBe(1); // outbox survives
    expect(store.listEntries()).toEqual([]);
    tryClose(store);
  });

  it('F. first install on clean PC — marker present (genuine fresh) → clear once (harmless on empty) and store', async () => {
    const store = makeStore();
    const firstNonce = 'first-install-nonce-F';
    writeInstallerNonce(dir, firstNonce);
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).toHaveBeenCalledTimes(1);
    expect(store.getInstallNonce()).toBe(firstNonce);
    expect(hasResetMarker(dir)).toBe(false);
    tryClose(store);
  });

  it('1. stored null + explicit in-place upgrade (legacy) → preserve session and store nonce', async () => {
    const store = makeStore();
    const inplaceNonce = 'inplace-upgrade-nonce-1';
    writeInstallerNonce(dir, inplaceNonce);
    expect(store.getInstallNonce()).toBeNull();
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(store.getInstallNonce()).toBe(inplaceNonce);
    tryClose(store);
  });

  it('2. stored null + genuine fresh-install marker → clear once and store', async () => {
    const store = makeStore();
    const freshNonce = 'fresh-install-nonce-2';
    writeInstallerNonce(dir, freshNonce);
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).toHaveBeenCalledTimes(1);
    expect(store.getInstallNonce()).toBe(freshNonce);
    expect(hasResetMarker(dir)).toBe(false);
    tryClose(store);
  });

  it('3. same nonce on quit/reopen → preserve', async () => {
    const store = makeStore();
    const nonce = 'same-nonce-3';
    writeInstallerNonce(dir, nonce);
    store.setInstallNonce(nonce);
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).not.toHaveBeenCalled();
    tryClose(store);
  });

  it('6. uninstall/reinstall → clear session, new nonce, SQLite/outbox intact', async () => {
    const store = makeStore();
    store.setInstallNonce('pre-uninstall-nonce');
    // Simulate sqlite rows and outbox that must survive
    try { store.enqueueOutbox({ idempotencyKey: 'k-pre-1', entityType: 'entry', entityId: 'e2', operation: 'upsert', payload: { name: 'keep' } } as never); } catch { (store as unknown as { enqueueOutbox: (a: unknown)=>void }).enqueueOutbox({ payload: { name: 'keep' } } as never); }
    const oldCount = store.getPendingOutboxCount();
    const newNonce = 'post-uninstall-nonce-6';
    writeInstallerNonce(dir, newNonce);
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).toHaveBeenCalled();
    expect(store.getInstallNonce()).toBe(newNonce);
    expect(store.getPendingOutboxCount()).toBe(oldCount);
    expect(hasResetMarker(dir)).toBe(false);
    tryClose(store);
  });

  it('7. cleanup failure → renderer does not open and reset marker remains', async () => {
    const store = makeStore();
    store.setInstallNonce('old-nonce-7');
    const newNonce = 'new-nonce-7';
    writeInstallerNonce(dir, newNonce);
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
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
    expect(store.getInstallNonce()).toBe('old-nonce-7'); // not updated
    expect(hasResetMarker(dir)).toBe(true); // marker retained for retry
    expect(readInstallerNonce(dir)).toBe(newNonce); // file still has new nonce, mismatch persists for retry
    expect(logger.error).toHaveBeenCalled();
  });

  it('when installer nonce differs without marker — unexpected mismatch → clear fail-closed', async () => {
    const store = makeStore();
    store.setInstallNonce('old-nonce-mismatch');
    writeInstallerNonce(dir, 'new-nonce-mismatch');
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    expect(session.clearStorageData).toHaveBeenCalled();
    expect(store.getInstallNonce()).toBe('new-nonce-mismatch');
    tryClose(store);
  });

  it('uses documented Electron 34 storages (cookies, localstorage, indexdb) — no sessionstorage/indexeddb', async () => {
    const store = makeStore();
    store.setInstallNonce('old-nonce');
    writeInstallerNonce(dir, 'new-nonce-storage-check');
    writeFileSync(resetMarkerPath(dir), '1', 'utf8');
    const session = { clearStorageData: vi.fn(async () => undefined) };
    await enforceSessionIsolation({ isPackaged: true, userDataPath: dir, store, session: session as unknown as never });
    const arg = (session.clearStorageData as any).mock.calls[0][0];
    expect(arg.storages).toEqual(expect.arrayContaining(['cookies', 'localstorage', 'indexdb']));
    expect(arg.storages).not.toContain('sessionstorage');
    expect(arg.storages).not.toContain('indexeddb');
    tryClose(store);
  });
});
