// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqliteStore, type SqliteStore } from '../electron/main/sqlite';
import { BackupService } from '../electron/main/backup-service';

/**
 * One designated Admin backup PC.
 *
 * Only that PC may run automatic backups or start a manual one; a second Admin
 * PC must never create a parallel backup lineage. The device id is an opaque
 * random value, never anything identifying about the machine.
 */

const APP_VERSION = '0.1.11';
const WORKER_URL = 'https://dks-backup.example.workers.dev';

let dir: string;
let userDataPath: string;
let store: SqliteStore;
let clock: Date;
let uploads: number;

function createService(): BackupService {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({ ok: true, r2: true, detail: null });
    }
    if (url.endsWith('/v1/backups') && init?.method === 'POST') {
      uploads += 1;
      const key = `backups/2026/10/2026-10-31/080000-${String(uploads).padStart(12, '0')}.sqlite.enc`;
      return Response.json({ id: key, key, size: 100, ciphertextSha256: 'c'.repeat(64) }, { status: 201 });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'no route' } }, { status: 404 });
  }) as unknown as typeof fetch;

  return new BackupService({
    store,
    userDataPath,
    appVersion: APP_VERSION,
    now: () => clock,
    fetchImpl,
    sleep: async (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    autoLaunchCheck: false,
    keyOverrideForTests: Buffer.alloc(32, 7),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
}

/** Configure a service the way an administrator would on the backup PC. */
function armService(service: BackupService, designated: boolean): BackupService {
  service.setEnabled(true);
  service.setWorkerUrl(WORKER_URL);
  service.setSession({ role: 'admin', accessToken: 'test-access-token' });
  service.setDesignation({
    deviceId: designated ? service.deviceId() : 'ff'.repeat(16),
    label: designated ? 'This PC' : 'Another Admin PC',
    designatedAt: '2026-10-01T06:00:00.000Z',
  });
  return service;
}

/** Stand in for the renderer reporting a fully successful authorized pull. */
function markCacheSynced(): void {
  store.setSyncStatus({
    status: 'healthy',
    lastPullAt: new Date().toISOString(),
    lastPullComplete: true,
    lastPullRows: store.listEntries(true).length,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dks-backup-designation-'));
  userDataPath = join(dir, 'DKS');
  store = createSqliteStore(join(userDataPath, 'dks-cache.sqlite'));
  store.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0 });
  for (let index = 0; index < 5; index += 1) {
    store.createEntry({
      id: `entry-${String(index).padStart(4, '0')}`,
      category: 'Employee',
      data: { Name: `Synthetic ${String(index)}` },
    });
  }
  for (const item of store.listOutbox('all')) store.markOutboxSynced(item.id);
  uploads = 0;
  clock = new Date('2026-10-31T08:00:00.000Z');
  markCacheSynced();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('device identity', () => {
  it('is a stable 32-hex random id, generated once per PC', () => {
    const service = createService();
    const first = service.deviceId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(service.deviceId()).toBe(first);

    // A second service over the same store reads the SAME id back from disk.
    const reopened = createService();
    expect(reopened.deviceId()).toBe(first);
  });

  it('never derives the id or label from the hostname or user name', () => {
    const service = createService();
    const id = service.deviceId();
    const label = service.deviceLabel();
    const host = hostname();

    expect(id.toLowerCase()).not.toContain(host.toLowerCase());
    expect(label.toLowerCase()).not.toContain(host.toLowerCase());
    expect(process.env.USERNAME ?? process.env.USER ?? '').not.toBe('');
    for (const candidate of [process.env.USERNAME, process.env.USER, process.env.COMPUTERNAME]) {
      if (candidate && candidate.length > 2) {
        expect(id.toLowerCase()).not.toContain(candidate.toLowerCase());
        expect(label.toLowerCase()).not.toContain(candidate.toLowerCase());
      }
    }
    // The default label is derived from the random id, not the machine.
    expect(label).toBe(`DKS-${id.slice(0, 6).toUpperCase()}`);
  });

  it('accepts an administrator-chosen label and caps its length', () => {
    const service = createService();
    service.setDeviceLabel('Front desk');
    expect(service.deviceLabel()).toBe('Front desk');
    service.setDeviceLabel('x'.repeat(200));
    expect(service.deviceLabel()).toHaveLength(60);
    service.setDeviceLabel('   ');
    expect(service.deviceLabel()).toBe(`DKS-${service.deviceId().slice(0, 6).toUpperCase()}`);
  });

  it('refuses a designation that is not a valid device id', () => {
    const service = createService();
    service.setDesignation({ deviceId: 'nope', label: 'x', designatedAt: null });
    expect(service.isDesignatedDevice()).toBe(false);
    expect(service.getState().designatedDeviceId).toBeNull();
    service.setDesignation('nonsense');
    expect(service.isDesignatedDevice()).toBe(false);
  });
});

describe('automatic backup runs only on the designated PC', () => {
  it('runs T1/T2/T3 on the designated Admin PC', async () => {
    const service = armService(createService(), true);
    expect(service.isDesignatedDevice()).toBe(true);
    expect(service.getState().designated).toBe(true);

    const result = await service.runNow('manual');
    expect(result.outcome).toBe('pending');
    expect(uploads).toBe(1);

    // T2: the next Muscat day triggers another run.
    clock = new Date('2026-11-01T08:00:00.000Z');
    markCacheSynced();
    store.createEntry({ id: 'entry-new', category: 'Employee', data: { Name: 'New' } });
    for (const item of store.listOutbox('all')) store.markOutboxSynced(item.id);
    markCacheSynced();
    const second = await service.runNow('hourly');
    expect(second.outcome).toBe('pending');
    expect(uploads).toBe(2);
  });

  it('skips automatic backup on a non-designated Admin PC', async () => {
    const service = armService(createService(), false);
    expect(service.getState().designated).toBe(false);
    expect(service.getState().designatedDeviceLabel).toBe('Another Admin PC');

    for (const trigger of ['launch', 'hourly', 'quit'] as const) {
      const result = await service.runNow(trigger);
      expect(result.outcome).toBe('no_changes');
      expect(result.detail).toBe('Automatic backup runs on another designated Admin PC');
    }
    expect(uploads).toBe(0);
  });

  it('refuses a manual "Back up now" on a non-designated Admin PC', async () => {
    const service = armService(createService(), false);
    const result = await service.runNow('manual');
    expect(result.outcome).toBe('no_changes');
    expect(result.detail).toBe('Back up now is only available on the designated backup PC');
    expect(uploads).toBe(0);
  });

  it('says so when no PC has been designated yet', async () => {
    const service = createService();
    service.setEnabled(true);
    service.setWorkerUrl(WORKER_URL);
    service.setSession({ role: 'admin', accessToken: 'test-access-token' });

    const result = await service.runNow('hourly');
    expect(result.outcome).toBe('no_changes');
    expect(result.detail).toBe('No Admin PC is designated for cloud backup yet');
    expect(uploads).toBe(0);
  });

  it('follows a transfer of the designation between PCs', async () => {
    const service = createService();
    service.setEnabled(true);
    service.setWorkerUrl(WORKER_URL);
    service.setSession({ role: 'admin', accessToken: 'test-access-token' });

    // Another PC holds the duty: nothing runs here.
    service.setDesignation({ deviceId: 'ff'.repeat(16), label: 'Other', designatedAt: null });
    expect((await service.runNow('hourly')).outcome).toBe('no_changes');

    // The duty is transferred to this PC: backups start, with no restart.
    service.setDesignation({ deviceId: service.deviceId(), label: 'This PC', designatedAt: null });
    expect(service.isDesignatedDevice()).toBe(true);
    expect((await service.runNow('hourly')).outcome).toBe('pending');
    expect(uploads).toBe(1);
  });

  it('refuses an Office credential so an Office PC can never arm the scheduler', () => {
    const service = armService(createService(), true);
    expect(service.setSession({ role: 'office', accessToken: 'tok' })).toBe(false);
    expect(service.getState().connection).toBe('signed_out');
  });

  it('sends only the opaque device id, never the hostname', async () => {
    const service = armService(createService(), true);
    await service.runNow('manual');

    const fetchMock = (service as unknown as { fetchImpl: typeof fetch }).fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const uploadCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/v1/backups'));
    expect(uploadCall).toBeDefined();
    const headers = (uploadCall?.[1] as { headers: Record<string, string> }).headers;
    expect(headers['x-dks-device-id']).toBe(service.deviceId());
    expect(headers['x-dks-device-id']).toMatch(/^[0-9a-f]{32}$/);

    const serialized = JSON.stringify(headers).toLowerCase();
    expect(serialized).not.toContain(hostname().toLowerCase());
  });
});

describe('backup waits for a provably complete cache', () => {
  it('refuses to snapshot before this PC has completed a full sync', async () => {
    const service = armService(createService(), true);
    store.setSyncStatus({
      status: 'healthy',
      lastPullAt: null,
      lastPullComplete: false,
      lastPullRows: null,
    });

    const result = await service.runNow('manual');
    expect(result.outcome).toBe('incomplete');
    expect(result.detail).toBe('snapshot skipped: This PC has not completed a full sync of the local cache yet');
    expect(uploads).toBe(0);
    expect(service.getState().lastSuccessAt).toBeNull();
    expect(service.listEvents().some((event) => event.outcome === 'verified')).toBe(false);
  });

  it('refuses to snapshot when the last pull did not read every page', async () => {
    const service = armService(createService(), true);
    store.setSyncStatus({
      status: 'healthy',
      lastPullAt: new Date().toISOString(),
      lastPullComplete: false,
      lastPullRows: 1000,
    });

    const result = await service.runNow('manual');
    expect(result.outcome).toBe('incomplete');
    expect(result.detail).toMatch(/did not read every page/);
    expect(uploads).toBe(0);
  });

  it('refuses to snapshot a cache that changed after the last full sync', async () => {
    const service = armService(createService(), true);
    // A local edit lands after the pull. It has been PUSHED (so the outbox is
    // empty) but never pulled back, so the cache is ahead of the last full sync.
    store.createEntry({ id: 'entry-after-pull', category: 'Employee', data: { Name: 'Late edit' } });
    for (const item of store.listOutbox('all')) store.markOutboxSynced(item.id);

    const result = await service.runNow('manual');
    expect(result.outcome).toBe('incomplete');
    expect(result.detail).toBe('snapshot skipped: The local cache changed after the last full sync');
    expect(uploads).toBe(0);
    expect(service.getState().cacheComplete).toBe(false);

    // Once that edit has been pulled back into a fully complete cache, the
    // backup proceeds.
    markCacheSynced();
    clock = new Date('2026-10-31T09:00:00.000Z');
    expect(service.getState().cacheComplete).toBe(true);
    expect((await service.runNow('manual')).outcome).toBe('pending');
    expect(uploads).toBe(1);
  });

  it('still refuses when local changes are unpushed, before completeness is even considered', async () => {
    const service = armService(createService(), true);
    store.createEntry({ id: 'entry-unpushed', category: 'Employee', data: { Name: 'Unpushed' } });

    const result = await service.runNow('manual');
    expect(result.outcome).toBe('incomplete');
    expect(result.detail).toBe('snapshot incomplete: pending local changes');
    expect(uploads).toBe(0);
  });
});
