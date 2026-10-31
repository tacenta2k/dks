import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import {
  sha256Hex,
} from './backup-crypto';
import type { BackupSnapshotMeta } from './backup-types';
import {
  muscatDateOf,
  SNAPSHOT_EXCLUDED_TABLES,
  type BackupFingerprint,
  type BackupRecordCounts,
  type SqliteStore,
} from './sqlite';

/**
 * Snapshot creation and verification.
 *
 * Nothing here touches the live database file: the point-in-time copy comes
 * from `SqliteStore.createSnapshotCopy()` (better-sqlite3 `backup()` /
 * `VACUUM INTO`), and every destructive statement runs against the copy.
 */

/** Stable digest of the six fingerprint aggregates (no row data inside). */
export function fingerprintDigest(parts: BackupFingerprint): string {
  return sha256Hex(JSON.stringify({
    e: parts.entriesCount,
    eu: parts.entriesMaxUpdatedAt,
    ei: parts.entriesMaxId,
    ev: parts.entriesVersionSum,
    ed: parts.entriesDeletedSum,
    c: parts.columnsCount,
    cu: parts.columnsMaxUpdatedAt,
    cd: parts.columnsDeletedSum,
    sc: parts.settingsCount,
    s: parts.settingsMaxUpdatedAt,
  }));
}

export function fingerprintsEqual(left: BackupFingerprint, right: BackupFingerprint): boolean {
  return fingerprintDigest(left) === fingerprintDigest(right);
}

export interface CreateSnapshotOptions {
  store: Pick<SqliteStore, 'computeBackupFingerprint' | 'createSnapshotCopy'>;
  destinationDir: string;
  now?: () => Date;
}

export interface CreatedSnapshot extends BackupSnapshotMeta {
  filePath: string;
  sizeBytes: number;
}

/**
 * Build the snapshot copy and confirm it opens cleanly before anything is
 * encrypted or uploaded. A snapshot that cannot be re-opened is never shipped.
 */
export async function createSnapshot(options: CreateSnapshotOptions): Promise<CreatedSnapshot> {
  const now = options.now ?? (() => new Date());
  const stamp = now();
  const filePath = path.join(
    options.destinationDir,
    `dks-snapshot-${stamp.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.sqlite`,
  );

  fs.mkdirSync(options.destinationDir, { recursive: true });

  const parts = options.store.computeBackupFingerprint();
  const recordCounts: BackupRecordCounts = await options.store.createSnapshotCopy(filePath);

  const verification = verifySnapshotFile(filePath);
  if (!verification.ok) {
    safeUnlink(filePath);
    throw new Error(`The snapshot failed its integrity check: ${verification.integrityCheck}`);
  }

  return {
    filePath,
    sizeBytes: fs.statSync(filePath).size,
    fingerprint: fingerprintDigest(parts),
    fingerprintParts: parts,
    recordCounts,
    createdAt: stamp.toISOString(),
  };
}

export interface SnapshotVerification {
  ok: boolean;
  integrityCheck: string;
  tables: string[];
  /** Excluded tables that are still present — must be empty. */
  leakedTables: string[];
}

/**
 * Open a snapshot copy read-only and run `PRAGMA integrity_check`, plus an
 * assertion that none of SNAPSHOT_EXCLUDED_TABLES survived the strip.
 */
export function verifySnapshotFile(filePath: string): SnapshotVerification {
  const database = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check?: unknown }>;
    const integrityCheck = integrity
      .map((row) => String(row.integrity_check ?? ''))
      .join('; ')
      .trim() || 'unknown';
    const tables = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? ''))
      .filter((name) => !name.startsWith('sqlite_'));
    const leakedTables = SNAPSHOT_EXCLUDED_TABLES.filter((table) => tables.includes(table));
    return {
      ok: integrityCheck === 'ok' && leakedTables.length === 0,
      integrityCheck,
      tables,
      leakedTables,
    };
  } finally {
    database.close();
  }
}

export function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  } catch {
    // Temp-file cleanup is best effort; the caller already knows the outcome.
  }
}

export { muscatDateOf };
