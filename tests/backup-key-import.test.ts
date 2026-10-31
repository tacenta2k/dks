// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BetterSqlite3 from 'better-sqlite3';
import {
  encryptBackup,
  fixedKeyForTests,
  formatRecoveryKey,
  keyIdFromKey,
  keyVerificationHash,
  parseRecoveryKey,
  type BackupMetadata,
  type SafeStorageLike,
} from '../electron/main/backup-crypto';
import { BackupService } from '../electron/main/backup-service';
import { createSnapshot } from '../electron/main/backup-snapshot';
import { createSqliteStore, type SqliteStore } from '../electron/main/sqlite';

/**
 * Recovery-key import: the replacement-PC path.
 *
 * A backup key is generated on one PC and wrapped by that PC's OS key store, so
 * without an import flow a backup made on the old machine could never be opened
 * again. These tests prove the import works, fails closed, and never leaves the
 * plaintext key behind.
 */

const OBJECT_KEY = 'backups/2026/10/2026-10-31/080000-abcdef012345.sqlite.enc';
const KEY_A = fixedKeyForTests('pc-a');
const KEY_B = fixedKeyForTests('pc-b');
const RECOVERY_A = formatRecoveryKey(KEY_A);

let dir: string;
let userDataPath: string;
let store: SqliteStore;
let dbFile: string;
let payload: Buffer;
let metadata: BackupMetadata;
let logs: string[];

/** Every text value in the local database, for the plaintext-leak sweep. */
function dumpDatabase(): string {
  const database = new BetterSqlite3(dbFile, { readonly: true, fileMustExist: true });
  try {
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const parts: string[] = [];
    for (const table of tables) {
      const rows = database.prepare(`SELECT * FROM "${table}"`).all();
      parts.push(JSON.stringify(rows));
    }
    return parts.join('\n');
  } finally {
    database.close();
  }
}

function everyFileUnder(path: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  if (!existsSync(path)) return out;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      out.push(...everyFileUnder(full));
      continue;
    }
    const raw = readFileSync(full);
    out.push({ path: full, text: `${raw.toString('utf8')} ${raw.toString('base64')}` });
  }
  return out;
}

function createLogger() {
  logs = [];
  return {
    info: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
  };
}

function createService(overrides: { userDataPath?: string; safeStorage?: SafeStorageLike | null } = {}): BackupService {
  const workerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/health')) {
      return Response.json({ ok: true, r2: true, detail: null });
    }
    if (url.includes('/v1/backups?')) {
      return Response.json({
        year: 2026,
        month: 10,
        backups: [{
          id: OBJECT_KEY,
          key: OBJECT_KEY,
          day: '2026-10-31',
          sizeBytes: payload.byteLength,
          createdAt: '2026-10-31T08:00:12.000Z',
          fingerprint: metadata.fingerprint,
          plaintextSha256: metadata.plaintextSha256,
          schemaVersion: '4',
          appVersion: '0.1.11',
          recordCount: 40,
          keyId: metadata.keyId,
          source: 'local-cache',
          outcome: 'verified',
        }],
        nextCursor: null,
      });
    }
    const headers = {
      'x-dks-plaintext-sha256': metadata.plaintextSha256,
      'x-dks-ciphertext-sha256': '',
      'x-dks-fingerprint': metadata.fingerprint,
      'x-dks-schema-version': '4',
      'x-dks-record-counts': 'entries=40',
      'x-dks-created-at': '2026-10-31T08:00:12.000Z',
      'x-dks-app-version': '0.1.11',
      'x-dks-key-id': metadata.keyId,
      'x-dks-source': 'local-cache',
      'x-dks-size': String(payload.byteLength),
    };
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(new Uint8Array(payload), { status: 200, headers });
  }) as unknown as typeof fetch;

  const service = new BackupService({
    store,
    userDataPath: overrides.userDataPath ?? userDataPath,
    appVersion: '0.1.11',
    now: () => new Date('2026-10-31T09:00:00.000Z'),
    fetchImpl: workerFetch,
    sleep: async () => undefined,
    autoLaunchCheck: false,
    ...(overrides.safeStorage === undefined ? {} : { safeStorage: overrides.safeStorage }),
    logger: createLogger(),
  });
  // The service address and the signed-in session are per-PC state; a
  // replacement machine sets both up again before it can download anything.
  service.setWorkerUrl('https://backup.example.workers.dev');
  service.setSession({ role: 'admin', accessToken: 'test-access-token' });
  return service;
}

/** A safeStorage stand-in that keeps the wrapped bytes in memory only. */
function createWorkingSafeStorage(): SafeStorageLike {
  const secret = Buffer.from('test-wrap-secret');
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`${secret.toString('hex')}:${Buffer.from(value, 'utf8').toString('hex')}`),
    decryptString: (wrapped: Buffer) => {
      const text = wrapped.toString('utf8');
      const index = text.indexOf(':');
      return Buffer.from(text.slice(index + 1), 'hex').toString('utf8');
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dks-key-import-'));
  userDataPath = join(dir, 'DKS');
  dbFile = join(userDataPath, 'dks-cache.sqlite');
  store = createSqliteStore(dbFile);
  store.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0 });
  for (let index = 0; index < 40; index += 1) {
    store.createEntry({ id: `entry-${String(index).padStart(3, '0')}`, category: 'Employee', data: { Name: `Synthetic ${String(index)}` } });
  }
  for (const item of store.listOutbox('all')) store.markOutboxSynced(item.id);

  // A snapshot made on "PC A", encrypted with PC A's key.
  const snapshot = await createSnapshot({ store, destinationDir: join(dir, 'tmp'), now: () => new Date('2026-10-31T08:00:00.000Z') });
  const plaintext = readFileSync(snapshot.filePath);
  const encrypted = encryptBackup(plaintext, KEY_A, {
    plaintextSha256: '',
    fingerprint: snapshot.fingerprint,
    appVersion: '0.1.11',
    schemaVersion: 4,
    recordCounts: snapshot.recordCounts as unknown as Record<string, number>,
    createdAt: snapshot.createdAt,
    keyId: keyIdFromKey(KEY_A),
    source: 'local-cache',
  });
  payload = encrypted.payload;
  metadata = encrypted.metadata;
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('recovery key import', () => {
  it('lets a replacement PC open a backup made elsewhere', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    expect(service.getState().keyConfigured).toBe(false);
    expect(service.getState().keyId).toBeNull();

    const imported = service.setupKeyImport(RECOVERY_A);
    expect(imported.ok).toBe(true);
    expect(imported.keyId).toBe(keyIdFromKey(KEY_A));
    expect(service.getState().keyConfigured).toBe(true);
    expect(service.getState().keyId).toBe(keyIdFromKey(KEY_A));

    const drill = await service.testDrill();
    expect(drill.ok).toBe(true);
    expect(drill.integrityCheck).toBe('ok');
    expect(drill.message).toMatch(/integrity check/i);
  });

  it('refuses an invalid recovery key without writing anything', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    for (const bad of ['', '   ', 'not base64 at all!', Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(31, 1).toString('base64')]) {
      const result = service.setupKeyImport(bad);
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    }
    expect(service.getState().keyConfigured).toBe(false);
    expect(existsSync(join(userDataPath, 'backup-key.bin'))).toBe(false);
  });

  it('refuses a key that does not match the backup being opened', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    const result = service.setupKeyImport(formatRecoveryKey(KEY_B), keyIdFromKey(KEY_A));
    expect(result.ok).toBe(false);
    expect(result.message).toContain(keyIdFromKey(KEY_A));
    expect(service.getState().keyConfigured).toBe(false);
  });

  it('accepts the key that does match the requested key id', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    expect(service.setupKeyImport(RECOVERY_A, keyIdFromKey(KEY_A)).ok).toBe(true);
    expect(service.setupKeyImport('nope', 'not-a-key-id').ok).toBe(false);
  });

  it('will not silently replace a different key already on this PC', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    expect(service.setupKeyImport(RECOVERY_A).ok).toBe(true);
    const conflict = service.setupKeyImport(formatRecoveryKey(KEY_B));
    expect(conflict.ok).toBe(false);
    expect(conflict.message).toMatch(/already holds a different backup key/);
    expect(service.getState().keyId).toBe(keyIdFromKey(KEY_A));
  });

  it('fails closed when the operating system key store is unavailable', async () => {
    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from('should never be used'),
      decryptString: () => 'should never be used',
    };
    const service = createService({ safeStorage: broken });
    const result = service.setupKeyImport(RECOVERY_A);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/operating system key store/i);
    expect(service.getState().keyConfigured).toBe(false);
    expect(existsSync(join(userDataPath, 'backup-key.bin'))).toBe(false);
    // No plaintext fallback anywhere on disk.
    expect(everyFileUnder(userDataPath).some((file) => file.text.includes(RECOVERY_A))).toBe(false);
  });

  it('names the key mismatch instead of a generic decryption failure', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    // Import a valid but WRONG key: it is stored, so the drill can run.
    expect(service.setupKeyImport(formatRecoveryKey(KEY_B)).ok).toBe(true);

    const drill = await service.testDrill();
    expect(drill.ok).toBe(false);
    expect(drill.stage).toBe('decrypt');
    expect(drill.message).toContain(keyIdFromKey(KEY_A));
    expect(drill.message).toContain(keyIdFromKey(KEY_B));

    // The live database was never opened for writing by the drill.
    expect(store.listEntries(true)).toHaveLength(40);
    expect(store.listEntries()).toHaveLength(40);
  });

  it('never leaves the plaintext key in SQLite, in a file, or in a log line', async () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    expect(service.setupKeyImport(RECOVERY_A).ok).toBe(true);
    await service.testDrill();

    const rawKeyHex = KEY_A.toString('hex');
    const keyHash = keyVerificationHash(KEY_A);
    const database = dumpDatabase();
    expect(database).not.toContain(RECOVERY_A);
    expect(database).not.toContain(rawKeyHex);
    // Only the one-way hash is stored, and it is not the key.
    expect(database).toContain(keyHash);
    expect(keyHash).not.toBe(rawKeyHex);

    for (const file of everyFileUnder(userDataPath)) {
      expect(file.text, file.path).not.toContain(RECOVERY_A);
      if (!file.path.endsWith('dks-cache.sqlite')) {
        expect(file.text, file.path).not.toContain(rawKeyHex);
      }
    }
    for (const line of logs) {
      expect(line).not.toContain(RECOVERY_A);
      expect(line).not.toContain(rawKeyHex);
    }
  });

  it('parses and formats a recovery key without loss', () => {
    expect(parseRecoveryKey(RECOVERY_A).equals(KEY_A)).toBe(true);
    expect(parseRecoveryKey(`  ${RECOVERY_A}  `).equals(KEY_A)).toBe(true);
    expect(formatRecoveryKey(parseRecoveryKey(RECOVERY_A))).toBe(RECOVERY_A);
    expect(keyIdFromKey(parseRecoveryKey(RECOVERY_A))).toBe(keyIdFromKey(KEY_A));
    expect(keyIdFromKey(KEY_A)).not.toBe(keyIdFromKey(KEY_B));
  });

  it('stores the imported key wrapped, never in the clear', () => {
    const service = createService({ safeStorage: createWorkingSafeStorage() });
    expect(service.setupKeyImport(RECOVERY_A).ok).toBe(true);

    const wrapped = readFileSync(join(userDataPath, 'backup-key.bin'));
    expect(wrapped.toString('utf8')).not.toContain(RECOVERY_A);
    expect(wrapped.toString('base64')).not.toContain(RECOVERY_A);
    expect(wrapped.byteLength).toBeGreaterThan(0);
    expect(vi.isMockFunction(service.getState)).toBe(false);
  });
});
