// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqliteStore, type SqliteStore } from '../electron/main/sqlite';
import { BackupService } from '../electron/main/backup-service';
import { fingerprintDigest } from '../electron/main/backup-snapshot';
import { BACKUP_ENVELOPE_MAGIC, keyIdFromKey } from '../electron/main/backup-crypto';

const APP_VERSION = '0.1.11';

let dir: string;
let userDataPath: string;
let store: SqliteStore;

interface FakeWorker {
  online: boolean;
  storedSha: string | null;
  uploads: number;
  heads: number;
  lastUploadHeaders: Record<string, string> | null;
  stored: Map<string, { size: number; sha: string }>;
  fetchImpl: typeof fetch;
}

function createFakeWorker(): FakeWorker {
  const stored = new Map<string, { size: number; sha: string }>();
  const worker: FakeWorker = {
    online: true,
    storedSha: null,
    uploads: 0,
    heads: 0,
    lastUploadHeaders: null,
    stored,
    fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!worker.online) {
        throw new TypeError('network down');
      }

      if (url.endsWith('/health')) {
        return Response.json({ ok: true, r2: true, detail: null });
      }

      if (url.endsWith('/v1/backups') && init?.method === 'POST') {
        worker.uploads += 1;
        const headers = init?.headers as Record<string, string> | undefined;
        worker.lastUploadHeaders = { ...(headers ?? {}) };
        const body = Buffer.from(init.body as ArrayBuffer);
        if (body.subarray(0, 6).toString('ascii') !== BACKUP_ENVELOPE_MAGIC) {
          return Response.json({ error: { code: 'BAD_REQUEST', message: 'not an envelope' } }, { status: 400 });
        }
        const key = `backups/2026/10/2026-10-31/080000-${String(worker.uploads).padStart(12, '0')}.sqlite.enc`;
        // The real Worker streams straight to R2 and cannot hash the body, so it
        // stores the checksum the desktop app declared. Echo that here; the
        // local digest is kept only so `storedSha` can be tampered with.
        const declared = String(headers?.['x-dks-ciphertext-sha256'] ?? '');
        const digest = await crypto.subtle.digest('SHA-256', body.buffer as ArrayBuffer);
        const computed = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        expect(declared).toBe(computed);
        stored.set(key, { size: body.byteLength, sha: computed });
        return Response.json({ id: key, key, size: body.byteLength, ciphertextSha256: declared }, { status: 201 });
      }

      const headMatch = /\/v1\/backups\/(.+)$/.exec(url);
      if (headMatch && init?.method === 'HEAD') {
        worker.heads += 1;
        const key = decodeURIComponent(headMatch[1]);
        const found = stored.get(key);
        if (!found) {
          return Response.json({ error: { code: 'NOT_FOUND', message: 'gone' } }, { status: 404 });
        }
        return new Response(null, {
          status: 200,
          headers: {
            'x-dks-ciphertext-sha256': worker.storedSha ?? found.sha,
            'x-dks-size': String(found.size),
          },
        });
      }

      return Response.json({ error: { code: 'NOT_FOUND', message: 'no route' } }, { status: 404 });
    }) as unknown as typeof fetch,
  };
  return worker;
}

let worker: FakeWorker;
let service: BackupService;
let clock: Date;

function pendingFiles(): string[] {
  const pendingDir = join(userDataPath, 'backups', 'pending');
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir).filter((name) => name.endsWith('.sqlite.enc'));
}

function seed(rows = 40): void {
  store.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0 });
  for (let index = 0; index < rows; index += 1) {
    store.createEntry({
      id: `entry-${String(index).padStart(4, '0')}`,
      category: 'Employee',
      data: { Name: `Synthetic ${String(index)}` },
    });
  }
}

/** Drains the outbox rows that seeding creates, without touching the network. */
function clearOutbox(): void {
  for (const item of store.listOutbox('all')) {
    store.markOutboxSynced(item.id);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dks-backup-service-'));
  userDataPath = join(dir, 'DKS');
  store = createSqliteStore(join(userDataPath, 'dks-cache.sqlite'));
  seed();
  clearOutbox();
  worker = createFakeWorker();
  clock = new Date('2026-10-31T08:00:00.000Z');
  service = new BackupService({
    store,
    userDataPath,
    appVersion: APP_VERSION,
    now: () => clock,
    fetchImpl: worker.fetchImpl,
    // The clock is frozen, so waiting has to move it: waitForOutboxDrain reads
    // now() to decide when its budget is up.
    sleep: async (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    autoLaunchCheck: false,
    keyOverrideForTests: Buffer.alloc(32, 7),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  // Cloud backup ships off: an administrator turns it on before anything is
  // uploaded, and this harness stands in for that administrator.
  service.setEnabled(true);
  service.setWorkerUrl('https://dks-backup.example.workers.dev');
  service.setSession({ role: 'admin', accessToken: 'test-access-token' });
});

afterEach(() => {
  service.stopHourlyTimer();
  try {
    store.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('offline queue', () => {
  it('keeps an encrypted snapshot queued while offline and uploads nothing', async () => {
    worker.online = false;
    const result = await service.runNow('manual');

    expect(result.outcome).toBe('pending');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(pendingFiles()).toHaveLength(1);

    const state = service.getState();
    expect(state.lastSuccessAt).toBeNull();
    expect(state.pendingUploads).toBe(1);
    expect(state.lastOutcome).toBe('pending');
    expect(worker.uploads).toBe(0);
  });

  it('uploads the queued file on the next run and deletes it only after the checksum is confirmed', async () => {
    worker.online = false;
    await service.runNow('manual');
    expect(pendingFiles()).toHaveLength(1);

    worker.online = true;
    clock = new Date('2026-10-31T09:00:00.000Z');
    const result = await service.runNow('hourly');

    expect(result.outcome).toBe('verified');
    expect(result.objectKey).toMatch(/^backups\/2026\/10\/2026-10-31\/080000-[0-9a-f]{12}\.sqlite\.enc$/);
    expect(worker.uploads).toBe(1);
    expect(worker.heads).toBe(1);
    expect(pendingFiles()).toEqual([]);

    const state = service.getState();
    expect(state.lastSuccessAt).not.toBeNull();
    expect(state.lastSuccessDate).toBe('2026-10-31');
    expect(state.pendingUploads).toBe(0);
    expect(state.lastFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never lets a stale queued snapshot make newer data look backed up', async () => {
    const currentFingerprint = (): string => fingerprintDigest(store.computeBackupFingerprint());

    // Offline: snapshot A is queued, holding the data as it is now.
    worker.online = false;
    await service.runNow('manual');
    const fingerprintA = currentFingerprint();
    expect(pendingFiles()).toHaveLength(1);

    // The data changes while still offline.
    store.createEntry({ id: 'entry-added-offline', category: 'Employee', data: { Name: 'Offline edit' } });
    clearOutbox();
    const fingerprintB = currentFingerprint();
    expect(fingerprintB).not.toBe(fingerprintA);

    // Back online: the queued snapshot A uploads. It is NOT the current state.
    worker.online = true;
    clock = new Date('2026-10-31T09:00:00.000Z');
    const first = await service.runNow('hourly');
    expect(first.outcome).toBe('verified');
    expect(worker.uploads).toBe(1);
    expect(pendingFiles()).toEqual([]);

    // The confirmation must name the snapshot that was uploaded, not the
    // database as it stands now — otherwise the newer edit is skipped forever.
    expect(service.getState().lastFingerprint).toBe(fingerprintA);
    expect(service.getState().lastFingerprint).not.toBe(fingerprintB);

    // The next run therefore still sees a change and uploads snapshot B.
    clock = new Date('2026-10-31T10:00:00.000Z');
    const second = await service.runNow('hourly');
    expect(second.outcome).toBe('verified');
    expect(worker.uploads).toBe(2);
    expect(second.objectKey).not.toBe(first.objectKey);
    expect(service.getState().lastFingerprint).toBe(fingerprintB);

    // And once caught up, it stops uploading.
    clock = new Date('2026-10-31T11:00:00.000Z');
    const third = await service.runNow('hourly');
    expect(third.outcome).toBe('no_changes');
    expect(worker.uploads).toBe(2);
  });

  it('keeps the file queued when the stored checksum does not match', async () => {
    worker.online = false;
    await service.runNow('manual');

    worker.online = true;
    worker.storedSha = 'f'.repeat(64);
    clock = new Date('2026-10-31T09:00:00.000Z');
    const result = await service.runNow('hourly');

    expect(result.outcome).toBe('pending');
    expect(result.detail).toMatch(/checksum/i);
    expect(pendingFiles()).toHaveLength(1);
    expect(service.getState().lastSuccessAt).toBeNull();
  });

  it('records a "checked, no changes" event and uploads nothing when the data is unchanged', async () => {
    await service.runNow('manual');
    expect(pendingFiles()).toEqual([]);

    clock = new Date('2026-10-31T09:00:00.000Z');
    const unchanged = await service.runNow('hourly');
    expect(unchanged.outcome).toBe('no_changes');
    expect(worker.uploads).toBe(1);
    expect(service.listEvents().some((event) => event.outcome === 'no_changes')).toBe(true);
  });

  it('refuses to snapshot while local changes are still unpushed', async () => {
    store.enqueueOutbox({
      idempotencyKey: 'still-pending',
      operation: 'entry:update',
      entityType: 'entry',
      entityId: 'entry-0001',
      payload: { name: 'unpushed' },
    });

    const result = await service.runNow('manual');
    expect(result.outcome).toBe('incomplete');
    expect(result.detail).toBe('snapshot incomplete: pending local changes');
    expect(pendingFiles()).toEqual([]);
    expect(worker.uploads).toBe(0);
    expect(service.getState().lastSuccessAt).toBeNull();
  });

  it('attaches the key id and the local-cache label to every upload', async () => {
    const result = await service.runNow('manual');
    expect(result.outcome).toBe('verified');

    const headers = worker.lastUploadHeaders as Record<string, string>;
    const expectedKeyId = keyIdFromKey(Buffer.alloc(32, 7));
    expect(headers['x-dks-key-id']).toBe(expectedKeyId);
    // What the snapshot covers travels with the bytes, not just in the UI.
    expect(headers['x-dks-source']).toBe('local-cache');
    expect(headers['x-dks-ciphertext-sha256']).toMatch(/^[0-9a-f]{64}$/);

    const state = service.getState();
    expect(state.source).toBe('local-cache');
    expect(state.keyId).toBe(expectedKeyId);
    expect(state.lastOutcome).toBe('verified');
  });

  it('is off until an administrator turns it on', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'dks-backup-default-'));
    const otherStore = createSqliteStore(join(otherDir, 'DKS', 'dks-cache.sqlite'));
    try {
      const fresh = new BackupService({
        store: otherStore,
        userDataPath: join(otherDir, 'DKS'),
        appVersion: APP_VERSION,
        now: () => clock,
        fetchImpl: worker.fetchImpl,
        sleep: async () => undefined,
        autoLaunchCheck: false,
        keyOverrideForTests: Buffer.alloc(32, 7),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      expect(fresh.getState().enabled).toBe(false);
      const result = await fresh.runNow('hourly');
      expect(result.outcome).toBe('no_changes');
      expect(result.detail).toBe('Cloud backup is turned off');
      expect(worker.uploads).toBe(0);
      const pendingDir = join(otherDir, 'DKS', 'backups', 'pending');
      expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toEqual([]);
    } finally {
      otherStore.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('runs once when two triggers land together', async () => {
    const [first, second] = await Promise.all([service.runNow('manual'), service.runNow('hourly')]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toContain('verified');
    expect(worker.uploads).toBe(1);
    expect(pendingFiles()).toEqual([]);
  });

  it('does not snapshot while signed out, so nothing can pile up', async () => {
    service.setSession(null);
    const result = await service.runNow('manual');
    expect(result.outcome).toBe('no_changes');
    expect(pendingFiles()).toEqual([]);
    expect(worker.uploads).toBe(0);
  });

  it('does nothing while the admin toggle is off', async () => {
    service.setEnabled(false);
    const result = await service.runNow('manual');
    expect(result.outcome).toBe('no_changes');
    expect(result.detail).toMatch(/turned off/i);
    expect(pendingFiles()).toEqual([]);
  });

  it('reports health from the Worker', async () => {
    expect(await service.healthCheck()).toEqual({ ok: true, reachable: true, r2Bound: true, detail: null });
    worker.online = false;
    expect(await service.healthCheck()).toMatchObject({ ok: false, reachable: false });
  });
});

describe('before-quit budget', () => {
  it('finishes inside the budget and reports the outcome', async () => {
    const result = await service.runBeforeQuit(5_000);
    expect(result.outcome).toBe('verified');
  });

  it('leaves the work queued when the budget expires, and still returns', async () => {
    const slow = new BackupService({
      store,
      userDataPath,
      appVersion: APP_VERSION,
      now: () => clock,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return Response.json({ error: { code: 'UNAVAILABLE', message: 'slow' } }, { status: 503 });
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      autoLaunchCheck: false,
      keyOverrideForTests: Buffer.alloc(32, 7),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    slow.setWorkerUrl('https://dks-backup.example.workers.dev');
    slow.setSession({ role: 'admin', accessToken: 'test-access-token' });

    const result = await slow.runBeforeQuit(20);
    expect(result.outcome).toBe('pending');
    expect(result.detail).toMatch(/next launch/i);
  });
});
