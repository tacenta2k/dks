// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import {
  SNAPSHOT_EXCLUDED_TABLES,
  SQLITE_SCHEMA_VERSION,
  createSqliteStore,
  type SqliteStore,
} from '../electron/main/sqlite';
import {
  createSnapshot,
  fingerprintDigest,
  fingerprintsEqual,
  verifySnapshotFile,
} from '../electron/main/backup-snapshot';

const ROW_COUNT = 1_200;

let dir: string;
let livePath: string;
let store: SqliteStore;

function seed(target: SqliteStore): void {
  target.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0 });
  target.upsertColumn({ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', position: 1 });

  for (let index = 0; index < ROW_COUNT; index += 1) {
    target.createEntry({
      id: `entry-${String(index).padStart(5, '0')}`,
      category: 'Employee',
      data: { Name: `Synthetic ${String(index)}`, 'Visa Expiry': '2027-01-01' },
    });
  }
  // A soft-deleted row must survive into the snapshot.
  target.softDeleteEntry('entry-00007');
  // A deleted column must survive too.
  target.deleteColumn('name', 'admin');

  target.setSettings({ currency: { code: 'OMR', symbol: 'ر.ع.', decimals: 3 } });
  target.setInstallNonce('test-install-nonce');
  target.enqueueOutbox({
    idempotencyKey: 'outbox-1',
    operation: 'entry:create',
    entityType: 'entry',
    entityId: 'entry-00001',
    payload: { name: 'unpushed' },
  });
  target.enqueueErrorReport({
    fingerprint: 'f'.repeat(32),
    category: 'sync',
    severity: 'error',
    code: 'SYNC_FAILED',
    component: 'test',
    process: 'main',
    appVersion: '0.1.11',
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.22631',
    packaged: false,
    occurredAt: '2026-10-31T06:00:00.000Z',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dks-backup-snapshot-'));
  livePath = join(dir, 'dks-cache.sqlite');
  store = createSqliteStore(livePath);
  seed(store);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(databasePath: string): string[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

describe('snapshot copy', () => {
  it('keeps every included table with all rows, including soft-deleted ones', async () => {
    const destination = join(dir, 'snapshot.sqlite');
    const counts = await store.createSnapshotCopy(destination);

    const database = new Database(destination, { readonly: true });
    try {
      const scalar = (sql: string): number =>
        Number((database.prepare(sql).get() as { value: number }).value);
      expect(scalar('SELECT COUNT(*) AS value FROM entries')).toBe(ROW_COUNT);
      expect(scalar('SELECT COUNT(*) AS value FROM entries WHERE deleted <> 0')).toBe(1);
      expect(scalar('SELECT COUNT(*) AS value FROM columns')).toBe(2);
      expect(scalar('SELECT COUNT(*) AS value FROM columns WHERE deleted <> 0')).toBe(1);
      expect(scalar('SELECT COUNT(*) AS value FROM local_settings')).toBeGreaterThan(0);
      expect(scalar('SELECT COUNT(*) AS value FROM audit_log')).toBeGreaterThan(0);
      expect(scalar('SELECT COUNT(*) AS value FROM schema_migrations')).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      database.close();
    }

    expect(counts.entries).toBe(ROW_COUNT);
    expect(counts.entriesDeleted).toBe(1);
    expect(counts.columns).toBe(2);
    expect(counts.columnsDeleted).toBe(1);
  });

  it('drops the excluded tables in the copy and never in the live database', async () => {
    // Seeding enqueues one outbox row per created entry, so compare against the
    // real live count rather than a hard-coded number.
    const liveOutboxBefore = store.getOutboxSummary().pendingCount;
    expect(liveOutboxBefore).toBeGreaterThan(ROW_COUNT);
    const destination = join(dir, 'snapshot.sqlite');
    await store.createSnapshotCopy(destination);

    const snapshotTables = tableNames(destination);
    for (const table of SNAPSHOT_EXCLUDED_TABLES) {
      expect(snapshotTables, table).not.toContain(table);
    }

    // The live database is untouched: its outbox, install nonce and error
    // queue are all still exactly as they were before the snapshot.
    expect(store.getOutboxSummary().pendingCount).toBe(liveOutboxBefore);
    expect(store.getInstallNonce()).toBe('test-install-nonce');
    expect(store.getErrorReportQueueSummary().pendingCount).toBe(1);
  });

  it('produces a copy that opens cleanly and passes PRAGMA integrity_check', async () => {
    const destination = join(dir, 'snapshot.sqlite');
    await store.createSnapshotCopy(destination);

    const verification = verifySnapshotFile(destination);
    expect(verification.integrityCheck).toBe('ok');
    expect(verification.leakedTables).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.tables).toContain('entries');
    expect(verification.tables).toContain('columns');
    expect(verification.tables).toContain('local_settings');
    expect(verification.tables).toContain('audit_log');
  });

  it('recreates the dropped tables when the copy is opened as a live database', async () => {
    const destination = join(dir, 'restored.sqlite');
    await store.createSnapshotCopy(destination);
    expect(tableNames(destination)).not.toContain('outbox');

    // This is the restore path PR3 will use: open the copy with the real store.
    const restored = createSqliteStore(destination);
    try {
      expect(restored.getMigrationVersion()).toBe(SQLITE_SCHEMA_VERSION);
      // listEntries() defaults to active rows only; the soft-deleted row is
      // still there and comes back with includeDeleted.
      expect(restored.listEntries()).toHaveLength(ROW_COUNT - 1);
      expect(restored.listEntries(true)).toHaveLength(ROW_COUNT);
      // The missing operational tables are back and usable.
      expect(restored.getOutboxSummary().pendingCount).toBe(0);
      expect(restored.getInstallNonce()).toBeNull();
      restored.enqueueOutbox({
        idempotencyKey: 'after-restore',
        operation: 'entry:update',
        entityType: 'entry',
        entityId: 'entry-00002',
        payload: {},
      });
      expect(restored.getOutboxSummary().pendingCount).toBe(1);
      restored.setSyncStatus('healthy');
      expect(restored.getSyncStatus().status).toBe('healthy');
      expect(restored.getErrorReportQueueSummary().pendingCount).toBe(0);
      expect(restored.getSettings()).toMatchObject({ currency: { code: 'OMR' } });
    } finally {
      restored.close();
    }
  });

  it('createSnapshot verifies the copy before returning it', async () => {
    const snapshot = await createSnapshot({ store, destinationDir: join(dir, 'staging') });
    try {
      expect(existsSync(snapshot.filePath)).toBe(true);
      expect(snapshot.sizeBytes).toBeGreaterThan(0);
      expect(snapshot.recordCounts.entries).toBe(ROW_COUNT);
      expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(snapshot.createdAt).toISOString()).toBe(snapshot.createdAt);
    } finally {
      rmSync(snapshot.filePath, { force: true });
    }
  });
});

describe('change fingerprint', () => {
  it('is deterministic for an unchanged database', () => {
    const first = store.computeBackupFingerprint();
    const second = store.computeBackupFingerprint();
    expect(first).toEqual(second);
    expect(fingerprintDigest(first)).toBe(fingerprintDigest(second));
    expect(fingerprintsEqual(first, second)).toBe(true);
  });

  it('moves when a record is added, edited, soft-deleted or permanently deleted', () => {
    const baseline = fingerprintDigest(store.computeBackupFingerprint());

    store.createEntry({ id: 'new-row', category: 'Employee', data: { Name: 'New' } });
    const afterInsert = fingerprintDigest(store.computeBackupFingerprint());
    expect(afterInsert).not.toBe(baseline);

    store.updateEntry('new-row', { data: { Name: 'Renamed' } });
    const afterUpdate = fingerprintDigest(store.computeBackupFingerprint());
    expect(afterUpdate).not.toBe(afterInsert);

    store.softDeleteEntry('new-row');
    const afterSoftDelete = fingerprintDigest(store.computeBackupFingerprint());
    expect(afterSoftDelete).not.toBe(afterUpdate);

    store.permanentDeleteEntry('new-row', 'admin');
    const afterPurge = fingerprintDigest(store.computeBackupFingerprint());
    expect(afterPurge).not.toBe(afterSoftDelete);
  });

  it('moves when a record is restored from the recycle bin', () => {
    store.softDeleteEntry('entry-00009');
    const afterSoftDelete = fingerprintDigest(store.computeBackupFingerprint());
    store.restoreEntry('entry-00009');
    expect(fingerprintDigest(store.computeBackupFingerprint())).not.toBe(afterSoftDelete);
  });

  it('moves when a column or a setting changes', () => {
    const baseline = fingerprintDigest(store.computeBackupFingerprint());

    store.upsertColumn({ id: 'passport', name: 'Passport', type: 'text', position: 2 });
    const afterColumn = fingerprintDigest(store.computeBackupFingerprint());
    expect(afterColumn).not.toBe(baseline);

    store.setSettings({ currency: { code: 'OMR', symbol: 'ر.ع.', decimals: 2 } });
    const afterSettings = fingerprintDigest(store.computeBackupFingerprint());
    expect(afterSettings).not.toBe(afterColumn);
  });

  it('ignores outbox, sync and error-report activity', () => {
    const baseline = fingerprintDigest(store.computeBackupFingerprint());
    store.enqueueOutbox({
      idempotencyKey: 'outbox-2',
      operation: 'entry:update',
      entityType: 'entry',
      entityId: 'entry-00002',
      payload: {},
    });
    store.setSyncStatus('syncing');
    expect(fingerprintDigest(store.computeBackupFingerprint())).toBe(baseline);
  });

  it('contains no row data, only aggregates', () => {
    const parts = store.computeBackupFingerprint();
    expect(Object.keys(parts).sort()).toEqual([
      'columnsCount',
      'columnsDeletedSum',
      'columnsMaxUpdatedAt',
      'entriesCount',
      'entriesDeletedSum',
      'entriesMaxId',
      'entriesMaxUpdatedAt',
      'entriesVersionSum',
      'settingsCount',
      'settingsMaxUpdatedAt',
    ]);
    expect(parts.entriesCount).toBe(ROW_COUNT);
    expect(parts.entriesMaxId).toBe('entry-01199');
    // No customer value from `data` can appear in the digest input.
    expect(JSON.stringify(parts)).not.toContain('Synthetic');
  });
});
