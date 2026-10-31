import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SyncOutboxItem, SyncState, SyncStatus } from './sync';

type LocalColumnType =
  | 'text'
  | 'number'
  | 'phone'
  | 'email'
  | 'price'
  | 'date_start'
  | 'date_expiry'
  | 'dropdown'
  | 'checkbox'
  | 'notes'
  | 'civil_id';

const LOCAL_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'phone',
  'email',
  'price',
  'date_start',
  'date_expiry',
  'dropdown',
  'checkbox',
  'notes',
  'civil_id',
]);

interface LocalColumnDefinition {
  id: string;
  name: string;
  type: LocalColumnType;
  options?: unknown;
  position?: number;
  visible?: boolean;
  isPrimaryExpiry?: boolean;
  is_primary_expiry?: boolean;
  isPassport?: boolean;
  is_passport?: boolean;
  deleted?: boolean;
  updatedAt?: string;
  updated_at?: string;
}

interface GridRowLike {
  id?: string;
  data?: Record<string, unknown> | null;
  deleted?: boolean;
}

export interface SqliteStoreOptions {
  /** Main-process-only override; tests may use `:memory:`. */
  filename?: string;
  databasePath?: string;
  path?: string;
  /** Electron app.getPath('userData') value, injectable for the main process/tests. */
  userDataPath?: string;
  now?: () => string;
  clock?: () => string;
  idFactory?: () => string;
  idGenerator?: () => string;
  busyTimeoutMs?: number;
}

export interface LocalEntry {
  id: string;
  data: Record<string, unknown>;
  category: string;
  deleted: boolean;
  deleted_at: string | null;
  deletedAt: string | null;
  version: number;
  created_at: string;
  createdAt: string;
  updated_at: string;
  updatedAt: string;
  updated_by: string | null;
  updatedBy: string | null;
}

export interface LocalColumn extends LocalColumnDefinition {
  options?: unknown;
  is_primary_expiry?: boolean;
  is_passport?: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface EntryInput {
  id?: string;
  data: Record<string, unknown>;
  category?: string;
  idempotencyKey?: string;
  idempotency_key?: string;
  updatedAt?: string;
  updated_at?: string;
  updatedBy?: string | null;
}

export interface EntryPatch {
  data?: Record<string, unknown>;
  category?: string;
  deleted?: boolean;
  deletedAt?: string | null;
  updatedBy?: string | null;
  idempotencyKey?: string;
  idempotency_key?: string;
  updatedAt?: string;
  updated_at?: string;
}

export interface RemoteEntryInput {
  id: string;
  data?: Record<string, unknown>;
  category?: string | null;
  deleted?: boolean;
  deleted_at?: string | null;
  deletedAt?: string | null;
  version?: number;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  updated_by?: string | null;
  updatedBy?: string | null;
}

export interface RemoteColumnInput extends LocalColumnDefinition {
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface ColumnInput extends LocalColumnDefinition {
  idempotencyKey?: string;
  idempotency_key?: string;
}

export type OutboxStatus = 'pending' | 'processing' | 'synced' | 'failed' | 'terminal';

export interface OutboxItem extends SyncOutboxItem {
  id: number;
  idempotencyKey: string;
  idempotency_key: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  last_error: string | null;
}

export interface OutboxInput {
  idempotencyKey?: string;
  idempotency_key?: string;
  operation: string;
  entityType?: string;
  entity_type?: string;
  entityId?: string;
  entity_id?: string;
  payload: unknown;
}

function columnActor(input: unknown): string | null {
  const role = typeof (input as { role?: unknown } | undefined | null)?.role === 'string'
    ? String((input as { role?: unknown }).role).toLowerCase()
    : '';
  if (role === 'office') {
    return 'Office (shared account)';
  }
  if (role === 'admin') {
    return 'Admin';
  }
  return null;
}

export interface AuditRecord {
  id: number;
  actor: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface NotificationRecord {
  id: number;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  read: boolean;
  dismissed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPatch {
  read?: boolean;
  dismissed?: boolean;
  payload?: Record<string, unknown>;
}

export interface NotificationInput {
  type: string;
  message: string;
  payload: Record<string, unknown>;
  read: boolean;
  dismissed?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConflictRecord {
  id: number;
  entityType: string;
  entityId: string;
  local: unknown;
  remote: unknown;
  winner: 'local' | 'remote' | 'equal';
  createdAt: string;
  resolved: boolean;
}

export interface CloseSyncResult {
  closed: boolean;
  flushed: boolean;
}

export interface OutboxSummary {
  pendingCount: number;
  failedCount: number;
  terminalCount: number;
}

/**
 * Aggregate digest of the tables a backup covers. Two fingerprints compare
 * equal exactly when none of these six aggregates moved. Contains no row data.
 */
export interface BackupFingerprint {
  entriesCount: number;
  entriesMaxUpdatedAt: string | null;
  entriesMaxId: string | null;
  /** Every update increments `version`, so this moves even within one millisecond. */
  entriesVersionSum: number;
  /** Soft delete and restore both move this. */
  entriesDeletedSum: number;
  columnsCount: number;
  columnsMaxUpdatedAt: string | null;
  columnsDeletedSum: number;
  settingsCount: number;
  settingsMaxUpdatedAt: string | null;
}

/** Row counts stored as backup metadata (and shown in the Settings history). */
export interface BackupRecordCounts {
  entries: number;
  entriesActive: number;
  entriesDeleted: number;
  columns: number;
  columnsDeleted: number;
  settings: number;
  auditLog: number;
}

export interface QueuedErrorReportRecord {
  id: number;
  fingerprint: string;
  category: string;
  severity: 'error' | 'warning';
  code: string;
  component: string;
  process: 'main' | 'renderer';
  appVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  electronVersion: string | null;
  packaged: boolean;
  sqliteSchemaVersion: number | null;
  httpStatus: number | null;
  postgresCode: string | null;
  occurrences: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
}

export interface EnqueueErrorReportInput {
  fingerprint: string;
  category: string;
  severity: 'error' | 'warning';
  code: string;
  component: string;
  process: 'main' | 'renderer';
  appVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  electronVersion?: string | null;
  packaged: boolean;
  sqliteSchemaVersion?: number | null;
  httpStatus?: number | null;
  postgresCode?: string | null;
  occurredAt: string;
  recordedAt?: string;
}

export interface EnqueueErrorReportOutcome {
  accepted: boolean;
  reason?: 'deduped_cooldown' | 'merged_pending';
  occurrences: number;
}

export interface CompleteErrorReportInput {
  fingerprint: string;
  outcome: 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal';
  errorCode?: string | null;
  retryAfterSeconds?: number | null;
  now?: string;
}

export interface ErrorReportQueueSummary {
  pendingCount: number;
  failedCount: number;
  suppressedCount: number;
  sqliteSchemaVersion: number;
}

export const MAX_ERROR_REPORT_QUEUE = 50;
export const MAX_ERROR_REPORT_DEDUPE = 200;
export const MAX_ERROR_REPORT_ATTEMPTS = 6;
export const ERROR_REPORT_DEDUPE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ERROR_REPORT_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ERROR_REPORT_OCCURRENCES = 10_000;

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT 1,
      is_primary_expiry INTEGER NOT NULL DEFAULT 0,
      is_passport INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      category TEXT NOT NULL DEFAULT 'Employee',
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      local_json TEXT NOT NULL,
      remote_json TEXT NOT NULL,
      winner TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS entries_updated_at_idx ON entries(updated_at DESC);
    CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, created_at, id);
    CREATE INDEX IF NOT EXISTS conflicts_unresolved_idx ON conflicts(resolved, created_at DESC);
  `,
  `
    ALTER TABLE notifications ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
  `,
  `
    CREATE TABLE IF NOT EXISTS local_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS local_settings_updated_at_idx ON local_settings(updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS error_report_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      code TEXT NOT NULL,
      component TEXT NOT NULL,
      process TEXT NOT NULL,
      app_version TEXT NOT NULL,
      platform TEXT NOT NULL,
      arch TEXT NOT NULL,
      os_release TEXT NOT NULL,
      electron_version TEXT,
      packaged INTEGER NOT NULL DEFAULT 0,
      sqlite_schema_version INTEGER,
      http_status INTEGER,
      postgres_code TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_occurred_at TEXT NOT NULL,
      last_occurred_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_report_dedupe (
      fingerprint TEXT PRIMARY KEY NOT NULL,
      last_reported_at TEXT NOT NULL,
      suppressed_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS error_report_queue_ready_idx
      ON error_report_queue(status, next_attempt_at, id);
    CREATE INDEX IF NOT EXISTS error_report_dedupe_reported_idx
      ON error_report_dedupe(last_reported_at DESC);
  `,
];

export const SQLITE_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * The CREATE-only subset of the migrations.
 *
 * Migration 2 (`ALTER TABLE notifications ADD COLUMN dismissed`) is NOT in this
 * list — an ALTER is not idempotent, so it must stay version-gated.
 *
 * Cloud backup (PR1) ships point-in-time snapshot copies with the operational
 * tables removed (`outbox`, `sync_meta`, `error_report_*`). A restored copy
 * therefore has tables missing while `schema_migrations` still reads the latest
 * version, so the version-gated loop alone would NOT recreate them and the copy
 * would open broken. `applyMigrations()` re-runs these statements on every open
 * to guarantee a missing base table is always recreated.
 */
const BASE_SCHEMA_STATEMENTS: readonly string[] = [MIGRATIONS[0], MIGRATIONS[2], MIGRATIONS[3]];

/**
 * Tables a backup snapshot copy must never carry.
 *
 *  - `outbox`              unpushed local changes (sync queue)
 *  - `sync_meta`           install/session nonce, sync status, backup bookkeeping
 *  - `error_report_queue`  diagnostics queue
 *  - `error_report_dedupe` diagnostics cooldown
 *
 * These are dropped in the SNAPSHOT COPY ONLY. The live database is never
 * modified, and `BASE_SCHEMA_STATEMENTS` recreates them on the next open of any
 * copy. Supabase auth sessions are not stored in SQLite at all — they live in
 * the Chromium session storages — so there is no auth table to drop here.
 */
export const SNAPSHOT_EXCLUDED_TABLES: readonly string[] = [
  'outbox',
  'sync_meta',
  'error_report_queue',
  'error_report_dedupe',
];

function tryElectronUserDataPath(): string | null {
  try {
    // Electron is intentionally loaded only when the default main-process path
    // is needed.  Vitest can therefore inject `:memory:` without importing the
    // native Electron runtime.
    const electron = require('electron') as {
      app?: { getPath?: (name: string) => string };
    };
    const path = electron.app?.getPath?.('userData');
    return typeof path === 'string' && path.trim() ? path : null;
  } catch {
    return null;
  }
}

function resolveFilename(options: SqliteStoreOptions): string {
  const filename = options.filename ?? options.databasePath ?? options.path;
  if (filename?.trim()) {
    return filename;
  }

  const userDataPath = options.userDataPath
    ?? tryElectronUserDataPath()
    ?? join(homedir(), '.dks');
  mkdirSync(userDataPath, { recursive: true });
  return join(userDataPath, 'dks-cache.sqlite');
}

function encode(value: unknown, fallback: unknown = {}): string {
  try {
    const result = JSON.stringify(value ?? fallback);
    return result === undefined ? JSON.stringify(fallback) : result;
  } catch {
    return JSON.stringify(fallback);
  }
}

function decode<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function bool(value: unknown): boolean {
  return value === true || value === 1;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Office 3-day visibility window (owner decision, 2026-10-27): Office may see
 * and work with only records CREATED in the last 3 calendar days (Asia/Muscat,
 * today included). Admin sees everything. Creation date only — an Admin edit
 * to an older record does NOT bring it back for Office.
 *
 * `created_at` values are stored as ISO timestamps (UTC instants); the window
 * boundary is the Muscat calendar date, so 23:59 and 00:01 Asia/Muscat fall on
 * different sides of a midnight even though they are minutes apart.
 */
export const DKS_BUSINESS_TIME_ZONE = 'Asia/Muscat';
export const OFFICE_WINDOW_DAYS = 3;

const muscatDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DKS_BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Muscat calendar date (YYYY-MM-DD) of a stored timestamp. */
export function muscatDateOf(value: string | number | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // An unusable timestamp must never qualify for the Office window.
    return '';
  }
  return muscatDateFormatter.format(parsed);
}

/** The first Muscat date still visible to Office (today minus 3, inclusive). */
export function officeWindowCutoffDate(muscatToday: string): string {
  const parsed = Date.parse(`${muscatToday}T12:00:00Z`);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed - OFFICE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** True when `createdAt`'s Muscat date is on/after the Muscat cutoff for `at`. */
export function isWithinOfficeWindow(
  createdAt: string | number | Date | null | undefined,
  at: string | number | Date = new Date(),
): boolean {
  if (createdAt === null || createdAt === undefined || createdAt === '') return false;
  const created = muscatDateOf(createdAt);
  const cutoff = officeWindowCutoffDate(muscatDateOf(at));
  return created !== '' && cutoff !== '' && created >= cutoff;
}

export interface OfficeScopeRow {
  id: string;
  deleted?: boolean;
  created_at?: string;
  createdAt?: string;
}

/**
 * Defense-in-depth read scope for the Office role: a row is readable iff it is
 * Office-visible (`deleted = false` AND inside the 3-day creation window) OR it
 * still has unsynced outbox work (a locally created/edited row is never hidden
 * or purged until pushed — after that it "falls out of view naturally"). The
 * sync engine needs those pending rows in the snapshot to push them.
 */
export function filterRowsForOfficeScope<T extends OfficeScopeRow>(
  rows: readonly T[],
  unsyncedEntryIds: ReadonlySet<string>,
  at: string | number | Date = new Date(),
): T[] {
  return rows.filter((row) => (
    unsyncedEntryIds.has(row.id)
    || (row.deleted !== true && isWithinOfficeWindow(row.created_at ?? row.createdAt, at))
  ));
}

/**
 * The generated "Days Left" system column is protected by ID only
 * (`col.id === 'daysLeft'`), never by name: a legacy persisted user column
 * NAMED "Days Left" (e.g. id `days_left`) must remain deletable.
 */
const SYSTEM_DAYS_LEFT_COLUMN_ID = 'daysLeft';

function isDaysLeftColumn(column: Pick<LocalColumnDefinition, 'id' | 'name'>): boolean {
  return column.id === SYSTEM_DAYS_LEFT_COLUMN_ID;
}

/**
 * Only a LIVE primary expiry (active date_expiry column flagged primary) may
 * block deletion; stale marks on deleted or non-expiry columns are healed,
 * never honoured.
 */
function isLivePrimaryExpiryColumn(
  column: Pick<LocalColumnDefinition, 'type' | 'deleted' | 'isPrimaryExpiry'>,
): boolean {
  return column.type === 'date_expiry'
    && column.deleted !== true
    && column.isPrimaryExpiry === true;
}

function hasColumnValue(value: unknown): boolean {
  return value !== null && value !== undefined
    && (typeof value !== 'string' || value.trim().length > 0);
}

function canDeleteColumnForOffice(
  column: Pick<LocalColumnDefinition, 'id' | 'name' | 'type' | 'deleted' | 'isPrimaryExpiry'>,
  rows: readonly GridRowLike[],
): boolean {
  if (isDaysLeftColumn(column) || isLivePrimaryExpiryColumn(column)) {
    return false;
  }

  return !rows.some((row) => {
    if (row.deleted === true) {
      return false;
    }
    const data = row.data ?? {};
    return hasColumnValue(data[column.name]) || (
      column.id !== column.name && hasColumnValue(data[column.id])
    );
  });
}

export class SqliteStore {
  private readonly database: BetterSqlite3.Database;
  private readonly filename: string;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private closed = false;
  private lastOfficePurgeMuscatDate: string | null = null;

  public constructor(options: SqliteStoreOptions | string = {}) {
    const normalizedOptions: SqliteStoreOptions = typeof options === 'string'
      ? { filename: options }
      : options;
    this.filename = resolveFilename(normalizedOptions);
    if (this.filename !== ':memory:') {
      mkdirSync(dirname(this.filename), { recursive: true });
    }

    this.database = new BetterSqlite3(this.filename);
    this.database.pragma('foreign_keys = ON');
    this.database.pragma(`busy_timeout = ${Math.max(0, normalizedOptions.busyTimeoutMs ?? 5_000)}`);
    try {
      this.database.pragma('journal_mode = WAL');
    } catch {
      // In-memory databases do not support WAL; normal file databases still use it.
    }
    this.now = normalizedOptions.now ?? normalizedOptions.clock ?? (() => new Date().toISOString());
    this.idFactory = normalizedOptions.idFactory ?? normalizedOptions.idGenerator ?? randomUUID;
    this.bindInstanceMethods();
    this.applyMigrations();
    // Startup self-heal: stale primary-expiry marks (deleted/non-expiry
    // columns, "no expiry column but something still flagged") are repaired
    // before any read or delete guard can trip over them.
    try {
      this.repairPrimaryExpiry(this.now());
    } catch {
      // Healing is best effort; the per-operation repair still runs.
    }
  }

  /**
   * Permanently bind every prototype method to this instance.
   *
   * The recycle-bin permanent-delete crash
   * (`TypeError: Cannot read properties of undefined (reading 'ensureOpen')`)
   * happened because IPC helpers extracted a method reference
   * (`const remove = store.permanentDeleteEntry`) and invoked it detached, so
   * `this` was `undefined` inside `ensureOpen()`. Call sites now bind
   * explicitly, and this binding makes detachment safe for every method of
   * this store — the fix lives at the store layer, not just at the one call
   * site that was observed crashing.
   */
  private bindInstanceMethods(): void {
    let prototype = Object.getPrototypeOf(this) as object | null;
    while (prototype && prototype !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(prototype)) {
        if (key === 'constructor') {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (descriptor && typeof descriptor.value === 'function') {
          (this as unknown as Record<string, unknown>)[key] = descriptor.value.bind(this);
        }
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('The DKS local database is closed');
    }
  }

  private applyMigrations(): void {
    this.database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
    const row = this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version?: number } | undefined;
    const currentVersion = Number(row?.version ?? 0);

    for (let index = currentVersion; index < MIGRATIONS.length; index += 1) {
      const version = index + 1;
      const apply = this.database.transaction(() => {
        this.database.exec(MIGRATIONS[index]);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, this.now());
      });
      apply();
    }

    // Runs on EVERY open, including a database already at the latest version.
    // Cloud-backup snapshot copies legitimately lack the operational tables
    // listed in SNAPSHOT_EXCLUDED_TABLES; this is what makes such a copy open
    // cleanly again instead of failing on the first outbox/sync_meta read.
    // Every statement here is `CREATE ... IF NOT EXISTS`, so this is a no-op
    // for an intact database.
    this.ensureBaseSchema();
  }

  /** Recreate any missing base table. Never runs the non-idempotent ALTER. */
  private ensureBaseSchema(): void {
    for (const statement of BASE_SCHEMA_STATEMENTS) {
      this.database.exec(statement);
    }
  }

  public getMigrationVersion(): number {
    this.ensureOpen();
    const row = this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version?: number } | undefined;
    return Number(row?.version ?? 0);
  }

  private entryFromRow(row: Record<string, unknown>): LocalEntry {
    const deletedAt = typeof row.deleted_at === 'string' ? row.deleted_at : null;
    const updatedBy = typeof row.updated_by === 'string' ? row.updated_by : null;
    const data = asRecord(decode(row.data, {}));
    return {
      id: String(row.id),
      data,
      category: String(row.category ?? 'Employee'),
      deleted: bool(row.deleted),
      deleted_at: deletedAt,
      deletedAt,
      version: Number(row.version ?? 1),
      created_at: String(row.created_at),
      createdAt: String(row.created_at),
      updated_at: String(row.updated_at),
      updatedAt: String(row.updated_at),
      updated_by: updatedBy,
      updatedBy,
    };
  }

  public getEntry(id: string): LocalEntry | null {
    this.ensureOpen();
    const row = this.database.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.entryFromRow(row) : null;
  }

  /** Apply an already-authoritative remote entry without creating a sync echo. */
  public applyRemoteEntry(input: RemoteEntryInput): LocalEntry {
    this.ensureOpen();
    if (!input.id?.trim()) {
      throw new Error('Remote entry id is required');
    }
    const current = this.getEntry(input.id);
    const createdAt = input.created_at ?? input.createdAt ?? current?.created_at ?? this.now();
    const updatedAt = input.updated_at ?? input.updatedAt ?? current?.updated_at ?? createdAt;
    const deleted = input.deleted === true;
    const deletedAt = input.deleted_at ?? input.deletedAt ?? (deleted ? current?.deleted_at ?? updatedAt : null);
    const category = typeof input.category === 'string' && input.category.trim()
      ? input.category
      : current?.category ?? 'Employee';
    const data = input.data ? { ...input.data } : current?.data ?? {};
    const version = Number.isSafeInteger(input.version) && Number(input.version) > 0
      ? Number(input.version)
      : current?.version ?? 1;
    const updatedBy = input.updated_by ?? input.updatedBy ?? current?.updated_by ?? null;

    this.database.prepare(`
      INSERT INTO entries (
        id, data, category, deleted, deleted_at, version,
        created_at, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        category = excluded.category,
        deleted = excluded.deleted,
        deleted_at = excluded.deleted_at,
        version = excluded.version,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(
      input.id,
      encode(data),
      category,
      deleted ? 1 : 0,
      deletedAt,
      version,
      createdAt,
      updatedAt,
      updatedBy,
    );

    const result = this.getEntry(input.id);
    if (!result) {
      throw new Error('Remote entry was not saved');
    }
    return result;
  }

  public listEntries(includeDeleted = false): LocalEntry[] {
    this.ensureOpen();
    const rows = this.database.prepare(
      includeDeleted
        ? 'SELECT * FROM entries ORDER BY updated_at DESC, id'
        : 'SELECT * FROM entries WHERE deleted = 0 ORDER BY updated_at DESC, id',
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.entryFromRow(row));
  }

  private entryOutboxKey(operation: string, id: string, requested: string | undefined, timestamp: string): string {
    return requested ?? `entry:${operation}:${id}:${timestamp}:${this.idFactory()}`;
  }

  public createEntry(input: EntryInput): LocalEntry {
    this.ensureOpen();
    const id = input.id ?? this.idFactory();
    const timestamp = input.updatedAt ?? input.updated_at ?? this.now();
    const record: LocalEntry = {
      id,
      data: { ...input.data },
      category: input.category ?? 'Employee',
      deleted: false,
      deleted_at: null,
      deletedAt: null,
      version: 1,
      created_at: timestamp,
      createdAt: timestamp,
      updated_at: timestamp,
      updatedAt: timestamp,
      updated_by: input.updatedBy ?? null,
      updatedBy: input.updatedBy ?? null,
    };

    const execute = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO entries (
          id, data, category, deleted, deleted_at, version,
          created_at, updated_at, updated_by
        ) VALUES (?, ?, ?, 0, NULL, 1, ?, ?, ?)
      `).run(
        record.id,
        encode(record.data),
        record.category,
        record.created_at,
        record.updated_at,
        record.updated_by,
      );
      this.enqueueOutbox({
        idempotencyKey: this.entryOutboxKey(
          'create',
          id,
          input.idempotencyKey ?? input.idempotency_key,
          timestamp,
        ),
        operation: 'create',
        entityType: 'entry',
        entityId: id,
        payload: record,
      });
    });
    execute();
    return record;
  }

  public updateEntry(id: string, patch: EntryPatch): LocalEntry | null {
    this.ensureOpen();
    const current = this.getEntry(id);
    if (!current) {
      return null;
    }

    const timestamp = patch.updatedAt ?? patch.updated_at ?? this.now();
    const data = patch.data ? { ...current.data, ...patch.data } : current.data;
    const deleted = patch.deleted ?? current.deleted;
    const deletedAt = patch.deletedAt !== undefined
      ? patch.deletedAt
      : (deleted ? current.deleted_at ?? timestamp : null);
    const next: LocalEntry = {
      ...current,
      data,
      category: patch.category ?? current.category,
      deleted,
      deleted_at: deletedAt,
      deletedAt,
      version: current.version + 1,
      updated_at: timestamp,
      updatedAt: timestamp,
      updated_by: patch.updatedBy !== undefined ? patch.updatedBy : current.updated_by,
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : current.updated_by,
    };

    const execute = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE entries
           SET data = ?, category = ?, deleted = ?, deleted_at = ?, version = ?,
               updated_at = ?, updated_by = ?
         WHERE id = ?
      `).run(
        encode(next.data),
        next.category,
        next.deleted ? 1 : 0,
        next.deleted_at,
        next.version,
        next.updated_at,
        next.updated_by,
        id,
      );
      this.enqueueOutbox({
        idempotencyKey: this.entryOutboxKey(
          'update',
          id,
          patch.idempotencyKey ?? patch.idempotency_key,
          timestamp,
        ),
        operation: next.deleted ? 'delete' : 'update',
        entityType: 'entry',
        entityId: id,
        payload: next,
      });
    });
    execute();
    // S3: every mutation records who did it (when known) so the Audit Log
    // can show a real actor instead of "Unknown".
    this.recordAudit({
      actor: next.updatedBy,
      entityType: 'entry',
      entityId: id,
      action: !current.deleted && next.deleted
        ? 'soft_delete'
        : current.deleted && !next.deleted
          ? 'restore'
          : 'update',
      before: { data: current.data, category: current.category, deleted: current.deleted },
      after: { data: next.data, category: next.category, deleted: next.deleted },
      createdAt: timestamp,
    });
    return next;
  }

  public upsertEntry(input: EntryInput): LocalEntry {
    const existing = input.id ? this.getEntry(input.id) : null;
    if (!existing) {
      return this.createEntry(input);
    }

    return this.updateEntry(existing.id, {
      data: input.data,
      category: input.category,
      updatedAt: input.updatedAt ?? input.updated_at,
      updatedBy: input.updatedBy,
      idempotencyKey: input.idempotencyKey ?? input.idempotency_key,
    }) ?? existing;
  }

  public createRow(input: EntryInput): LocalEntry {
    return this.createEntry(input);
  }

  public updateRow(id: string, patch: EntryPatch): LocalEntry | null {
    return this.updateEntry(id, patch);
  }

  public getRow(id: string): LocalEntry | null {
    return this.getEntry(id);
  }

  public listRows(includeDeleted = false): LocalEntry[] {
    return this.listEntries(includeDeleted);
  }

  public deleteRow(id: string, idempotencyKey?: string, updatedBy?: string | null): LocalEntry | null {
    return this.softDeleteEntry(id, idempotencyKey, updatedBy);
  }

  public softDeleteEntry(
    id: string,
    idempotencyKey?: string,
    updatedBy?: string | null,
  ): LocalEntry | null {
    const timestamp = this.now();
    return this.updateEntry(id, {
      deleted: true,
      deletedAt: timestamp,
      updatedAt: timestamp,
      idempotencyKey,
      updatedBy,
    });
  }

  public restoreEntry(id: string, idempotencyKey?: string, updatedBy?: string | null): LocalEntry | null {
    const timestamp = this.now();
    return this.updateEntry(id, {
      deleted: false,
      deletedAt: null,
      updatedAt: timestamp,
      idempotencyKey,
      updatedBy,
    });
  }

  /** Permanently remove an entry after the caller has enforced admin access. */
  public permanentDeleteEntry(
    id: string,
    idempotencyKey?: string,
    updatedBy?: string | null,
  ): LocalEntry | null {
    this.ensureOpen();
    const current = this.getEntry(id);
    if (!current) {
      return null;
    }

    const timestamp = this.now();
    const outboxKey = idempotencyKey
      ?? `entry:permanent-delete:${id}:${timestamp}:${this.idFactory()}`;
    const execute = this.database.transaction(() => {
      this.database.prepare('DELETE FROM entries WHERE id = ?').run(id);
      this.enqueueOutbox({
        idempotencyKey: outboxKey,
        operation: 'permanent_delete',
        entityType: 'entry',
        entityId: id,
        payload: { id, deleted: true, deleted_at: timestamp },
      });
      this.recordAudit({
        actor: updatedBy ?? null,
        entityType: 'entry',
        entityId: id,
        action: 'permanent_delete',
        before: current,
        after: null,
        createdAt: timestamp,
      });
    });
    execute();
    return current;
  }

  private columnFromRow(row: Record<string, unknown>): LocalColumn {
    const options = decode<LocalColumnDefinition['options']>(row.options, {});
    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type) as LocalColumnDefinition['type'],
      options,
      position: Number(row.position ?? 0),
      visible: bool(row.visible),
      isPrimaryExpiry: bool(row.is_primary_expiry),
      is_primary_expiry: bool(row.is_primary_expiry),
      isPassport: bool(row.is_passport),
      is_passport: bool(row.is_passport),
      deleted: bool(row.deleted),
      deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  public getColumn(id: string): LocalColumn | null {
    this.ensureOpen();
    const row = this.database.prepare('SELECT * FROM columns WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.columnFromRow(row) : null;
  }

  /** Apply an already-authoritative remote column without creating a sync echo. */
  /**
   * R3 batch B — adopt the server's id for a column that already existed under
   * another id (two machines created the same column name independently, or a
   * soft-deleted remote column still owns the unique name).
   *
   * This is deliberately narrow and transactional:
   *   - the local column keeps every value (name/type/options/position/…);
   *   - entry JSON is rewritten so `data[oldId]` becomes `data[newId]` — no
   *     value is dropped, and the name-keyed fallback keeps working;
   *   - queued outbox rows for the old column id are re-pointed so the pending
   *     change is not orphaned;
   *   - nothing is deleted unless the old row was replaced by the new id.
   * If a column with `newId` already exists locally the call is a no-op.
   */
  public rekeyColumn(oldId: string, newId: string): boolean {
    this.ensureOpen();
    const sourceId = oldId.trim();
    const targetId = newId.trim();
    if (!sourceId || !targetId || sourceId === targetId) {
      return false;
    }
    const source = this.getColumn(sourceId);
    if (!source || this.getColumn(targetId)) {
      return false;
    }

    const rewrite = this.database.transaction(() => {
      this.database.prepare('DELETE FROM columns WHERE id = ?').run(sourceId);
      this.database.prepare(`
        INSERT INTO columns (
          id, name, type, options, position, visible, is_primary_expiry,
          is_passport, deleted, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        targetId,
        source.name,
        source.type,
        encode(source.options, {}),
        Number(source.position ?? 0),
        source.visible === false ? 0 : 1,
        bool(source.isPrimaryExpiry ?? source.is_primary_expiry) ? 1 : 0,
        bool(source.isPassport ?? source.is_passport) ? 1 : 0,
        bool(source.deleted) ? 1 : 0,
        source.deleted_at ?? null,
        String(source.created_at ?? this.now()),
        String(source.updated_at ?? this.now()),
      );

      // Entry JSON: move the value to the adopted id and drop the stale key.
      const rows = this.database.prepare('SELECT id, data FROM entries').all() as {
        id: string;
        data: string;
      }[];
      const update = this.database.prepare('UPDATE entries SET data = ? WHERE id = ?');
      for (const row of rows) {
        const data = decode(row.data, {}) as Record<string, unknown>;
        if (!data || typeof data !== 'object' || !(sourceId in data)) {
          continue;
        }
        const next: Record<string, unknown> = { ...data };
        if (!(targetId in next)) {
          next[targetId] = data[sourceId];
        }
        delete next[sourceId];
        update.run(encode(next), row.id);
      }

      this.database.prepare(
        "UPDATE outbox SET entity_id = ? WHERE entity_type = 'column' AND entity_id = ?",
      ).run(targetId, sourceId);
    });
    rewrite();
    return true;
  }

  public applyRemoteColumn(input: RemoteColumnInput): LocalColumn {
    this.ensureOpen();
    if (!input.id?.trim() || !input.name?.trim()) {
      throw new Error('Remote column id and name are required');
    }
    if (!LOCAL_COLUMN_TYPES.has(input.type)) {
      throw new Error(`Unsupported remote column type: ${String(input.type)}`);
    }
    const current = this.getColumn(input.id);
    const timestamp = input.updated_at ?? current?.updated_at ?? this.now();
    const createdAt = input.created_at ?? current?.created_at ?? timestamp;
    const primary = input.isPrimaryExpiry === true || input.is_primary_expiry === true;
    const deleted = input.deleted === true;
    const deletedAt = input.deleted_at ?? (deleted ? current?.deleted_at ?? timestamp : null);

    const apply = this.database.transaction(() => {
      if (primary) {
        this.database.prepare('UPDATE columns SET is_primary_expiry = 0 WHERE id <> ?').run(input.id);
      }
      this.database.prepare(`
        INSERT INTO columns (
          id, name, type, options, position, visible, is_primary_expiry,
          is_passport, deleted, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          options = excluded.options,
          position = excluded.position,
          visible = excluded.visible,
          is_primary_expiry = excluded.is_primary_expiry,
          is_passport = excluded.is_passport,
          deleted = excluded.deleted,
          deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.name,
        input.type,
        encode(input.options, {}),
        input.position ?? current?.position ?? this.listColumns(true).length,
        input.visible === false ? 0 : 1,
        primary ? 1 : 0,
        input.isPassport === true || input.is_passport === true ? 1 : 0,
        deleted ? 1 : 0,
        deletedAt,
        createdAt,
        timestamp,
      );
    });
    apply();

    const result = this.getColumn(input.id);
    if (!result) {
      throw new Error('Remote column was not saved');
    }
    return result;
  }

  public listColumns(includeDeleted = false): LocalColumn[] {
    this.ensureOpen();
    const rows = this.database.prepare(
      includeDeleted
        ? 'SELECT * FROM columns ORDER BY position, id'
        : 'SELECT * FROM columns WHERE deleted = 0 ORDER BY position, id',
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.columnFromRow(row));
  }

  public upsertColumn(input: ColumnInput): LocalColumn {
    this.ensureOpen();
    if (!LOCAL_COLUMN_TYPES.has(input.type)) {
      throw new Error(`Unsupported column type: ${String(input.type)}`);
    }
    // A stale is_primary_expiry on a NON-date_expiry column is HEALED, never
    // rejected: rejecting it made the bogus legacy "Days Left" row impossible
    // to repair or delete. The flag simply has no meaning outside date_expiry
    // and `primary` below already gates on the type.
    const existing = this.getColumn(input.id);
    const timestamp = input.updatedAt ?? input.updated_at ?? this.now();
    const isFirstExpiry = input.type === 'date_expiry'
      && !this.listColumns().some((column) => column.type === 'date_expiry');
    const primary = input.type === 'date_expiry' && (
      input.isPrimaryExpiry === true
      || input.is_primary_expiry === true
      || isFirstExpiry
      || existing?.isPrimaryExpiry === true
      || existing?.is_primary_expiry === true
    );

    const execute = this.database.transaction(() => {
      // Honour an EXPLICIT primary re-selection made on an already-persisted
      // row (the administrator's "this is now the primary" action): clear the
      // other marks so the selection wins. For BULK/creation upserts (row not
      // yet persisted — sync or import brings both flags at once) other marks
      // stay in place and repairPrimaryExpiry resolves any ambiguity
      // deterministically to the FIRST live expiry column by position, so the
      // outcome never depends on iteration order.
      if (primary && existing) {
        this.database.prepare('UPDATE columns SET is_primary_expiry = 0, updated_at = ? WHERE is_primary_expiry = 1 AND id <> ?')
          .run(timestamp, input.id);
      }
      this.database.prepare(`
        INSERT INTO columns (
          id, name, type, options, position, visible, is_primary_expiry,
          is_passport, deleted, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          options = excluded.options,
          position = excluded.position,
          visible = excluded.visible,
          is_primary_expiry = excluded.is_primary_expiry,
          is_passport = excluded.is_passport,
          deleted = excluded.deleted,
          deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.name,
        input.type,
        encode(input.options, {}),
        input.position ?? (existing?.position ?? this.listColumns(true).length),
        input.visible === false ? 0 : 1,
        primary ? 1 : 0,
        input.isPassport === true || input.is_passport === true ? 1 : 0,
        input.deleted === true ? 1 : 0,
        input.deleted === true ? timestamp : null,
        existing?.created_at ?? timestamp,
        timestamp,
      );
      this.repairPrimaryExpiry(timestamp);
      this.enqueueOutbox({
        idempotencyKey: input.idempotencyKey
          ?? input.idempotency_key
          ?? `column:upsert:${input.id}:${timestamp}:${this.idFactory()}`,
        operation: existing ? 'update' : 'create',
        entityType: 'column',
        entityId: input.id,
        payload: input,
      });
    });
    execute();
    this.recordAudit({
      actor: columnActor(input),
      entityType: 'column',
      entityId: input.id,
      action: existing ? 'update_column' : 'create_column',
      before: existing ? { name: existing.name, type: existing.type } : null,
      after: { name: input.name, type: input.type },
      createdAt: timestamp,
    });

    const result = this.getColumn(input.id);
    if (!result) {
      throw new Error('Column was not saved');
    }

    return result;
  }

  /**
   * Self-heal the primary-expiry invariant in the LOCAL data:
   *   1. clear every stale mark (deleted columns and non-date_expiry columns
   *      may never carry is_primary_expiry — those marks used to block the
   *      column's own deletion with the misleading "primary expiry" error);
   *   2. when no live date_expiry column exists, NO column may stay marked
   *      primary (returns "none" instead of leaving the junk flag);
   *   3. otherwise exactly one live date_expiry column is primary — the first
   *      by position when the current marks are zero or ambiguous.
   * Runs on startup and after every column change, including before delete
   * checks, so a guard can never be fooled by the state it is healing.
   */
  private repairPrimaryExpiry(timestamp: string): void {
    this.database.prepare(
      `UPDATE columns
          SET is_primary_expiry = 0, updated_at = ?
        WHERE is_primary_expiry = 1
          AND (deleted = 1 OR type <> 'date_expiry')`,
    ).run(timestamp);

    const activeExpiry = this.database.prepare(
      'SELECT id FROM columns WHERE deleted = 0 AND type = \'date_expiry\' ORDER BY position, id',
    ).all() as { id: string }[];

    if (activeExpiry.length === 0) {
      this.database.prepare(
        'UPDATE columns SET is_primary_expiry = 0, updated_at = ? WHERE is_primary_expiry = 1',
      ).run(timestamp);
      return;
    }

    const currentPrimary = this.database.prepare(
      'SELECT id FROM columns WHERE deleted = 0 AND type = \'date_expiry\' AND is_primary_expiry = 1 ORDER BY position, id',
    ).all() as { id: string }[];
    if (currentPrimary.length === 1) {
      return;
    }

    this.database.prepare('UPDATE columns SET is_primary_expiry = 0, updated_at = ? WHERE deleted = 0 AND type = \'date_expiry\'')
      .run(timestamp);
    this.database.prepare('UPDATE columns SET is_primary_expiry = 1, updated_at = ? WHERE id = ?')
      .run(timestamp, activeExpiry[0].id);
  }

  public createColumn(input: ColumnInput): LocalColumn {
    return this.upsertColumn(input);
  }

  public updateColumn(input: ColumnInput): LocalColumn {
    return this.upsertColumn(input);
  }

  /**
   * Persist a user-chosen column order (sheet header drag-reorder).
   *
   * `columnIds` are active user columns in their new display order. The
   * full active set is rewritten to normalized positions (0..n-1) in ONE
   * transaction: listed columns first, any unlisted active column (e.g. a
   * hidden one the grid never displayed) keeps its relative order after
   * them. Only `position` and `updated_at` change, and only on rows whose
   * position actually moved — each such row also gets a durable
   * `column`/`update` outbox item so the new order syncs upstream through
   * the normal updated_at last-write-wins path. Name/type/options/
   * visibility/passport/primary-expiry flags and every entry value are
   * untouched (no upsert, no primary repair: a move must never redesignate
   * the primary expiry). Re-saving the current order is a no-op with no
   * writes, so refresh echoes cannot feed an outbox write loop.
   */
  public reorderColumns(
    columnIds: readonly string[],
    role: 'admin' | 'office' | string = 'admin',
  ): LocalColumn[] {
    this.ensureOpen();
    if (role !== 'admin' && role !== 'office') {
      throw new Error('Only an admin or office user can reorder columns');
    }
    if (!Array.isArray(columnIds)) {
      throw new Error('columnIds must be an array');
    }

    const seen = new Set<string>();
    const listed: LocalColumn[] = [];
    for (const rawId of columnIds) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id) {
        throw new Error('columnIds must contain non-empty column ids');
      }
      if (seen.has(id)) {
        throw new Error(`Duplicate column id in reorder: ${id}`);
      }
      seen.add(id);
      const column = this.getColumn(id);
      if (!column || column.deleted === true) {
        throw new Error(`Unknown sheet column: ${id}`);
      }
      if (isDaysLeftColumn(column)) {
        throw new Error('The generated Days Left column cannot be reordered');
      }
      listed.push(column);
    }

    const current = this.listColumns(false);
    const next = [...listed, ...current.filter((column) => !seen.has(column.id))];
    const changes = next
      .map((column, position) => ({ column, position }))
      .filter(({ column, position }) => Number(column.position ?? 0) !== position);
    if (changes.length === 0) {
      return current;
    }

    const timestamp = this.now();
    const execute = this.database.transaction(() => {
      const update = this.database.prepare(
        'UPDATE columns SET position = ?, updated_at = ? WHERE id = ?',
      );
      for (const { column, position } of changes) {
        update.run(position, timestamp, column.id);
        this.enqueueOutbox({
          idempotencyKey: `column:reorder:${column.id}:${timestamp}:${this.idFactory()}`,
          operation: 'update',
          entityType: 'column',
          entityId: column.id,
          payload: { ...column, position, updated_at: timestamp, updatedAt: timestamp },
        });
      }
    });
    execute();
    this.recordAudit({
      actor: columnActor({ role }),
      entityType: 'column',
      entityId: null,
      action: 'reorder_columns',
      before: { order: current.map((column) => column.id) },
      after: { order: next.map((column) => column.id) },
      createdAt: timestamp,
    });
    return this.listColumns(false);
  }

  public canDeleteColumn(
    id: string,
    role: 'admin' | 'office' | string,
  ): boolean {
    this.ensureOpen();
    // Self-heal before judging: stale primary marks (deleted/non-expiry
    // columns, no live expiry) must never block this deletion.
    this.repairPrimaryExpiry(this.now());
    const column = this.getColumn(id);
    if (!column || isDaysLeftColumn(column) || isLivePrimaryExpiryColumn(column)) {
      return false;
    }
    if (role === 'admin') {
      return true;
    }
    if (role !== 'office') {
      return false;
    }
    const rows: GridRowLike[] = this.listEntries().map((entry) => ({
      id: entry.id,
      data: entry.data,
      deleted: entry.deleted,
    }));
    return canDeleteColumnForOffice(column, rows);
  }

  public deleteColumn(id: string, role: 'admin' | 'office' | string, idempotencyKey?: string): LocalColumn | null {
    this.ensureOpen();
    if (!this.canDeleteColumn(id, role)) {
      return null;
    }

    const column = this.getColumn(id);
    if (!column) {
      return null;
    }
    const timestamp = this.now();
    const execute = this.database.transaction(() => {
      this.database.prepare('UPDATE columns SET deleted = 1, visible = 0, deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, id);
      this.enqueueOutbox({
        idempotencyKey: idempotencyKey ?? `column:delete:${id}:${timestamp}:${this.idFactory()}`,
        operation: 'delete',
        entityType: 'column',
        entityId: id,
        payload: { ...column, deleted: true, visible: false, deleted_at: timestamp },
      });
    });
    execute();
    this.recordAudit({
      actor: columnActor({ role }),
      entityType: 'column',
      entityId: id,
      action: 'delete_column',
      before: { name: column.name, type: column.type },
      after: null,
      createdAt: timestamp,
    });
    return this.getColumn(id);
  }

  public enqueueOutbox(input: OutboxInput): OutboxItem {
    this.ensureOpen();
    const idempotencyKey = input.idempotencyKey ?? input.idempotency_key;
    const entityType = input.entityType ?? input.entity_type;
    const entityId = input.entityId ?? input.entity_id;
    if (!idempotencyKey || !entityType || !entityId) {
      throw new Error('Outbox idempotencyKey, entityType, and entityId are required');
    }
    this.database.prepare(`
      INSERT INTO outbox (
        idempotency_key, operation, entity_type, entity_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      idempotencyKey,
      input.operation,
      entityType,
      entityId,
      encode(input.payload),
      this.now(),
    );

    const row = this.database.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('Outbox item was not saved');
    }
    return this.outboxFromRow(row);
  }

  private outboxFromRow(row: Record<string, unknown>): OutboxItem {
    const idempotencyKey = String(row.idempotency_key);
    const entityType = String(row.entity_type);
    const entityId = String(row.entity_id);
    const createdAt = String(row.created_at);
    const lastError = typeof row.last_error === 'string' ? row.last_error : null;
    return {
      id: Number(row.id),
      idempotencyKey,
      idempotency_key: idempotencyKey,
      operation: String(row.operation),
      entityType,
      entity_type: entityType,
      entityId,
      entity_id: entityId,
      payload: decode(row.payload, null),
      createdAt,
      created_at: createdAt,
      status: String(row.status) as OutboxStatus,
      attempts: Number(row.attempts ?? 0),
      lastError,
      last_error: lastError,
    };
  }

  public listOutbox(status: OutboxStatus | string = 'pending'): OutboxItem[] {
    this.ensureOpen();
    const rows = this.database.prepare(
      status === 'all'
        ? 'SELECT * FROM outbox ORDER BY created_at, id'
        : 'SELECT * FROM outbox WHERE status = ? ORDER BY created_at, id',
    ).all(...(status === 'all' ? [] : [status])) as Record<string, unknown>[];
    return rows.map((row) => this.outboxFromRow(row));
  }

  public getOutbox(status: OutboxStatus | string = 'pending'): OutboxItem[] {
    return this.listOutbox(status);
  }

  public markOutboxProcessing(id: number | string): void {
    this.ensureOpen();
    this.database.prepare('UPDATE outbox SET status = \'processing\', attempts = attempts + 1 WHERE id = ?').run(id);
  }

  public markOutboxSynced(id: number | string): void {
    this.ensureOpen();
    this.database.prepare("UPDATE outbox SET status = 'synced', last_error = NULL WHERE id = ? AND status <> 'terminal'").run(id);
  }

  public markOutboxFailed(id: number | string, message: string): void {
    this.ensureOpen();
    // A failed attempt is still an attempt: the sync detail panel shows
    // "attempted N×" from this counter, which previously stayed at 0 because
    // only the (barely used) processing transition incremented it.
    this.database.prepare(
      'UPDATE outbox SET status = \'failed\', last_error = ?, attempts = attempts + 1 WHERE id = ?',
    ).run(message, id);
  }

  /** A server-confirmed inaccessible entry is retained but never auto-retried. */
  public markOutboxTerminal(id: number | string, message: string): void {
    this.ensureOpen();
    this.database.prepare(
      "UPDATE outbox SET status = 'terminal', last_error = ?, attempts = attempts + 1 WHERE id = ? AND status <> 'synced'",
    ).run(message, id);
  }

  /**
   * Complete a reconciliation without blanket-acknowledging the queue. The
   * sync engine has already acknowledged each captured item individually;
   * a concurrent edit or terminal item must never be silently cleared here.
   */
  public acknowledgeOutbox(): SyncState {
    this.ensureOpen();
    const remaining = this.getPendingOutboxCount();
    return this.setSyncStatus(remaining > 0
      ? { status: 'error', lastError: 'Some changes have not synchronised yet.' }
      : { status: 'healthy', lastSyncAt: this.now(), lastError: null });
  }

  public acknowledgeSettings(): SyncState {
    this.ensureOpen();
    this.database.prepare("UPDATE outbox SET status = 'synced', last_error = NULL WHERE status <> 'synced' AND entity_type = 'settings'").run();
    return this.setSyncStatus({ status: 'healthy', lastSyncAt: this.now(), lastError: null });
  }

  /**
   * Requeue every failed item for another attempt.
   *
   * `last_error` is deliberately KEPT: the reason used to be wiped here, so
   * while the retry was in flight (and if the process died mid-attempt) the
   * user saw a pending item with no explanation even though the failure had
   * already been recorded. The reason survives until a successful write
   * (`markOutboxSynced`) clears it or the next attempt replaces it.
   */
  public retryFailedOutbox(): number {
    this.ensureOpen();
    const result = this.database.prepare('UPDATE outbox SET status = \'pending\' WHERE status = \'failed\'').run();
    return result.changes;
  }

  public getPendingOutboxCount(): number {
    this.ensureOpen();
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status IN ('pending', 'processing', 'failed', 'terminal')").get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  public getSyncStatus(): SyncState {
    this.ensureOpen();
    const rows = this.database.prepare('SELECT key, value FROM sync_meta').all() as { key: string; value: string | null }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const status = values.get('status');
    const validStatuses: SyncStatus[] = ['offline', 'syncing', 'healthy', 'error'];
    return {
      status: validStatuses.includes(status as SyncStatus) ? status as SyncStatus : 'offline',
      lastSyncAt: values.get('lastSyncAt') ?? null,
      lastError: values.get('lastError') ?? null,
      pendingCount: this.getPendingOutboxCount(),
      last_sync_at: values.get('lastSyncAt') ?? null,
      last_error: values.get('lastError') ?? null,
      pending_count: this.getPendingOutboxCount(),
    };
  }

  public getSyncState(): SyncState {
    return this.getSyncStatus();
  }

  /** Fresh-install nonce: set by the installer on real install, preserved on update. */
  public getInstallNonce(): string | null {
    this.ensureOpen();
    const row = this.database.prepare('SELECT value FROM sync_meta WHERE key = ?').get('installNonce') as
      | { value?: string | null }
      | undefined;
    const value = row?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  public setInstallNonce(nonce: string): void {
    this.ensureOpen();
    const trimmed = typeof nonce === 'string' ? nonce.trim() : '';
    if (!trimmed) return;
    this.database
      .prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('installNonce', trimmed);
  }

  public setSyncStatus(
    state: SyncStatus | (Partial<SyncState> & Pick<SyncState, 'status'>),
  ): SyncState {
    this.ensureOpen();
    const current = this.getSyncStatus();
    const requested = typeof state === 'string' ? { status: state } : state;
    const next: SyncState = {
      status: requested.status,
      lastSyncAt: requested.lastSyncAt !== undefined
        ? requested.lastSyncAt
        : requested.last_sync_at !== undefined
          ? requested.last_sync_at
          : current.lastSyncAt,
      lastError: requested.lastError !== undefined
        ? requested.lastError
        : requested.last_error !== undefined
          ? requested.last_error
          : current.lastError,
      pendingCount: requested.pendingCount
        ?? requested.pending_count
        ?? this.getPendingOutboxCount(),
    };
    const set = this.database.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    set.run('status', next.status);
    set.run('lastSyncAt', next.lastSyncAt);
    set.run('lastError', next.lastError);
    next.last_sync_at = next.lastSyncAt;
    next.last_error = next.lastError;
    next.pending_count = next.pendingCount;
    return next;
  }

  public recordConflict(
    input: Omit<ConflictRecord, 'id' | 'resolved' | 'createdAt'>
      & { createdAt?: string; resolved?: boolean },
  ): ConflictRecord {
    this.ensureOpen();
    const createdAt = input.createdAt ?? this.now();
    const result = this.database.prepare(`
      INSERT INTO conflicts (
        entity_type, entity_id, local_json, remote_json, winner, created_at, resolved
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.entityType,
      input.entityId,
      encode(input.local),
      encode(input.remote),
      input.winner,
      createdAt,
      input.resolved ? 1 : 0,
    );
    return {
      id: Number(result.lastInsertRowid),
      ...input,
      createdAt,
      resolved: input.resolved ?? false,
    };
  }

  public listConflicts(includeResolved = false): ConflictRecord[] {
    this.ensureOpen();
    const rows = this.database.prepare(
      includeResolved
        ? 'SELECT * FROM conflicts ORDER BY created_at DESC, id DESC'
        : 'SELECT * FROM conflicts WHERE resolved = 0 ORDER BY created_at DESC, id DESC',
    ).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      local: decode(row.local_json, null),
      remote: decode(row.remote_json, null),
      winner: String(row.winner) as ConflictRecord['winner'],
      createdAt: String(row.created_at),
      resolved: bool(row.resolved),
    }));
  }

  public recordAudit(input: Omit<AuditRecord, 'id'>): AuditRecord {
    this.ensureOpen();
    const result = this.database.prepare(`
      INSERT INTO audit_log (
        actor, entity_type, entity_id, action, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.actor,
      input.entityType,
      input.entityId,
      input.action,
      encode(input.before, null),
      encode(input.after, null),
      input.createdAt,
    );
    return { id: Number(result.lastInsertRowid), ...input };
  }

  public listAudit(limit = 500): AuditRecord[] {
    this.ensureOpen();
    const rows = this.database.prepare('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      actor: typeof row.actor === 'string' ? row.actor : null,
      entityType: String(row.entity_type),
      entityId: typeof row.entity_id === 'string' ? row.entity_id : null,
      action: String(row.action),
      before: decode(row.before_json, null),
      after: decode(row.after_json, null),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * R2-10 / R3 batch C: administrator-only clear of the local audit mirror.
   *
   * This is the ONLY place in DKS that removes audit rows, and it is
   * deliberately narrow:
   *   - one transaction, one statement, an explicit predicate (an unfiltered
   *     `DELETE` is what servers with a "DELETE requires a WHERE clause" guard
   *     reject, and it also reads as an accident in a code review);
   *   - a single `clear_audit` entry is written afterwards, in the same call,
   *     so the clear itself is always traceable;
   *   - the caller's role is checked by the IPC layer and the RPC, so Office
   *     cannot reach this method.
   */
  public clearAuditLog(input: { message: string; actor?: string | null }): AuditRecord {
    this.ensureOpen();
    const timestamp = this.now();
    const clear = this.database.transaction(() => {
      this.database.prepare('DELETE FROM audit_log WHERE id IS NOT NULL').run();
    });
    clear();
    return this.recordAudit({
      actor: input.actor ?? null,
      entityType: 'audit_log',
      entityId: null,
      action: 'clear_audit',
      before: null,
      after: { message: input.message },
      createdAt: timestamp,
    });
  }

  public addNotification(input: NotificationInput): NotificationRecord {
    this.ensureOpen();
    const timestamp = input.createdAt ?? this.now();
    const result = this.database.prepare(`
        INSERT INTO notifications (type, message, payload, read, dismissed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.type,
      input.message,
      encode(input.payload),
      input.read ? 1 : 0,
      input.dismissed ? 1 : 0,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return {
      id: Number(result.lastInsertRowid),
      type: input.type,
      message: input.message,
      payload: input.payload,
      read: input.read,
      dismissed: input.dismissed ?? false,
      createdAt: timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    };
  }

  public updateNotification(id: number | string, patch: NotificationPatch): NotificationRecord | null {
    this.ensureOpen();
    const requested = String(id);
    // A logical alert can be persisted by several physical rows (historical
    // duplicate inserts). State patches (read / dismissed / payload) must
    // land on EVERY matching row, or an untouched duplicate resurrects the
    // alert on the next load.
    const matches = this.listNotifications().filter((notification) => (
      String(notification.id) === requested
      || notification.payload.id === id
      || notification.payload.id === requested
      || notification.payload.dedupeKey === requested
    ));
    const current = matches[0];
    if (!current) {
      return null;
    }

    const updatedAt = this.now();
    const update = this.database.prepare(`
      UPDATE notifications
         SET payload = ?, read = ?, dismissed = ?, updated_at = ?
       WHERE id = ?
    `);
    const apply = this.database.transaction(() => {
      for (const match of matches) {
        const nextPayload = patch.payload
          ? { ...match.payload, ...patch.payload }
          : match.payload;
        update.run(
          encode(nextPayload),
          (patch.read ?? match.read) ? 1 : 0,
          (patch.dismissed ?? match.dismissed) ? 1 : 0,
          updatedAt,
          match.id,
        );
      }
    });
    apply();

    const nextPayload = patch.payload ? { ...current.payload, ...patch.payload } : current.payload;
    return {
      ...current,
      payload: nextPayload,
      read: patch.read ?? current.read,
      dismissed: patch.dismissed ?? current.dismissed,
      updatedAt,
    };
  }

  public getSettings(): Record<string, unknown> {
    this.ensureOpen();
    const rows = this.database.prepare('SELECT key, value FROM local_settings ORDER BY key').all() as Record<string, unknown>[];
    return rows.reduce<Record<string, unknown>>((result, row) => {
      const key = typeof row.key === 'string' ? row.key : '';
      if (key) {
        result[key] = decode(row.value, null);
      }
      return result;
    }, {});
  }

  public setSettings(settings: Record<string, unknown>): Record<string, unknown> {
    this.ensureOpen();
    const timestamp = this.now();
    const entries = Object.entries(settings);
    const execute = this.database.transaction(() => {
      for (const [key, value] of entries) {
        this.database.prepare(`
          INSERT INTO local_settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, encode(value), timestamp);
        this.enqueueOutbox({
          idempotencyKey: `settings:${key}:${timestamp}:${this.idFactory()}`,
          operation: 'upsert',
          entityType: 'settings',
          entityId: key,
          payload: { key, value, updated_at: timestamp },
        });
      }
    });
    execute();
    return this.getSettings();
  }

  public listNotifications(unreadOnly = false): NotificationRecord[] {
    this.ensureOpen();
    const rows = this.database.prepare(
      unreadOnly
        ? 'SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC, id DESC'
        : 'SELECT * FROM notifications ORDER BY created_at DESC, id DESC',
    ).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      type: String(row.type),
      message: String(row.message),
      payload: asRecord(decode(row.payload, {})),
      read: bool(row.read),
      dismissed: bool(row.dismissed),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * Entry ids whose outbox work has not reached 'synced': queued creates and
   * edits still to push, plus retained terminal items ("the local change stays
   * present"). Those rows are never hidden by the Office read scope and never
   * removed by the visibility purge until they have been pushed.
   */
  public unsyncedEntryIds(): Set<string> {
    this.ensureOpen();
    const rows = this.database.prepare(
      "SELECT DISTINCT entity_id AS id FROM outbox WHERE entity_type = 'entry' AND status <> 'synced'",
    ).all() as { id?: unknown }[];
    return new Set(rows.map((row) => String(row.id)));
  }

  /**
   * VISIBILITY PURGE (Office devices): remove cached rows outside the 3-day
   * creation window. This is not a deletion — no outbox item, no audit
   * 'delete', no server effect — the cache simply stops mirroring rows Office
   * cannot see (RLS hides them remotely). Rows with unsynced outbox work are
   * kept until pushed. Callers gate this on the Office role/scope; Admin must
   * never purge.
   *
   * `onlyIfDateChanged` runs the purge at launch and then at most once per
   * Muscat date (a row can only leave the window at Muscat midnight).
   */
  public purgeOutOfWindowOfficeEntries(options?: { onlyIfDateChanged?: boolean; at?: string }): number {
    this.ensureOpen();
    const nowValue = options?.at ?? this.now();
    const today = muscatDateOf(nowValue);
    if (options?.onlyIfDateChanged && this.lastOfficePurgeMuscatDate === today) {
      return 0;
    }
    this.lastOfficePurgeMuscatDate = today;
    const cutoff = officeWindowCutoffDate(today);
    if (!cutoff) return 0;
    const unsynced = this.unsyncedEntryIds();
    const rows = this.database.prepare('SELECT id, created_at FROM entries').all() as {
      id?: unknown;
      created_at?: unknown;
    }[];
    const doomed = rows.filter((row) => {
      const id = String(row.id);
      if (unsynced.has(id)) return false;
      const created = muscatDateOf(String(row.created_at ?? ''));
      return created !== '' && created < cutoff;
    });
    if (doomed.length > 0) {
      const remove = this.database.prepare('DELETE FROM entries WHERE id = ?');
      const execute = this.database.transaction(() => {
        for (const row of doomed) remove.run(String(row.id));
      });
      execute();
    }
    return doomed.length;
  }

  public getOutboxSummary(): OutboxSummary {
    this.ensureOpen();
    const rows = this.database.prepare(
      "SELECT status, COUNT(*) AS count FROM outbox WHERE status <> 'synced' GROUP BY status",
    ).all() as Array<{ status?: unknown; count?: unknown }>;
    let pendingCount = 0;
    let failedCount = 0;
    let terminalCount = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) continue;
      pendingCount += count;
      if (row.status === 'failed') failedCount += count;
      if (row.status === 'terminal') terminalCount += count;
    }
    return { pendingCount, failedCount, terminalCount };
  }

  public getErrorReportingEnabledMeta(): boolean | null {
    this.ensureOpen();
    const row = this.database.prepare('SELECT value FROM sync_meta WHERE key = ?')
      .get('errorReportingEnabled') as { value?: string | null } | undefined;
    if (row?.value === 'true') return true;
    if (row?.value === 'false') return false;
    const settingsRow = this.database.prepare('SELECT value FROM local_settings WHERE key = ?')
      .get('error_reporting_enabled') as { value?: string | null } | undefined;
    if (typeof settingsRow?.value === 'string') {
      const parsed = decode<unknown>(settingsRow.value, null);
      if (typeof parsed === 'boolean') return parsed;
    }
    return null;
  }

  public setErrorReportingEnabledMeta(enabled: boolean): void {
    this.ensureOpen();
    this.database.prepare(
      'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('errorReportingEnabled', enabled ? 'true' : 'false');
    if (!enabled) {
      this.clearErrorReportQueue();
    }
  }

  private errorReportFromRow(row: Record<string, unknown>): QueuedErrorReportRecord {
    return {
      id: Number(row.id),
      fingerprint: String(row.fingerprint),
      category: String(row.category),
      severity: row.severity === 'warning' ? 'warning' : 'error',
      code: String(row.code),
      component: String(row.component),
      process: row.process === 'renderer' ? 'renderer' : 'main',
      appVersion: String(row.app_version),
      platform: String(row.platform),
      arch: String(row.arch),
      osRelease: String(row.os_release),
      electronVersion: typeof row.electron_version === 'string' ? row.electron_version : null,
      packaged: bool(row.packaged),
      sqliteSchemaVersion: typeof row.sqlite_schema_version === 'number' ? row.sqlite_schema_version : null,
      httpStatus: typeof row.http_status === 'number' ? row.http_status : null,
      postgresCode: typeof row.postgres_code === 'string' ? row.postgres_code : null,
      occurrences: Number(row.occurrences ?? 1),
      firstOccurredAt: String(row.first_occurred_at),
      lastOccurredAt: String(row.last_occurred_at),
      status: row.status === 'failed' ? 'failed' : 'pending',
      attempts: Number(row.attempts ?? 0),
      nextAttemptAt: String(row.next_attempt_at),
      lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
    };
  }

  public enqueueErrorReport(input: EnqueueErrorReportInput): EnqueueErrorReportOutcome {
    this.ensureOpen();
    const recordedAt = input.recordedAt ?? this.now();
    const recordedMs = Date.parse(recordedAt);
    const baseMs = Number.isFinite(recordedMs) ? recordedMs : Date.now();
    const retentionCutoff = new Date(baseMs - ERROR_REPORT_DEDUPE_RETENTION_MS).toISOString();

    const execute = this.database.transaction((): EnqueueErrorReportOutcome => {
      // Bound dedupe table age and row count.
      this.database.prepare('DELETE FROM error_report_dedupe WHERE last_reported_at < ?').run(retentionCutoff);
      const dedupeCountRow = this.database.prepare('SELECT COUNT(*) AS count FROM error_report_dedupe')
        .get() as { count?: number } | undefined;
      if (Number(dedupeCountRow?.count ?? 0) > MAX_ERROR_REPORT_DEDUPE) {
        const overflow = Number(dedupeCountRow?.count ?? 0) - MAX_ERROR_REPORT_DEDUPE;
        this.database.prepare(`
          DELETE FROM error_report_dedupe
          WHERE fingerprint IN (
            SELECT fingerprint FROM error_report_dedupe
            ORDER BY last_reported_at ASC
            LIMIT ?
          )
        `).run(overflow);
      }

      // Suppress if already delivered within the cooldown window.
      const deduped = this.database.prepare(
        'SELECT last_reported_at, suppressed_count FROM error_report_dedupe WHERE fingerprint = ?',
      ).get(input.fingerprint) as { last_reported_at?: string; suppressed_count?: number } | undefined;
      if (deduped?.last_reported_at) {
        const lastReportedMs = Date.parse(deduped.last_reported_at);
        if (Number.isFinite(lastReportedMs) && baseMs - lastReportedMs < ERROR_REPORT_DEDUPE_COOLDOWN_MS) {
          const nextSuppressed = Math.min(MAX_ERROR_REPORT_OCCURRENCES, Number(deduped.suppressed_count ?? 0) + 1);
          this.database.prepare(
            'UPDATE error_report_dedupe SET suppressed_count = ? WHERE fingerprint = ?',
          ).run(nextSuppressed, input.fingerprint);
          return { accepted: false, reason: 'deduped_cooldown', occurrences: nextSuppressed };
        }
      }

      // Merge into an existing queued row with the same fingerprint.
      const existing = this.database.prepare(
        'SELECT id, occurrences, status FROM error_report_queue WHERE fingerprint = ?',
      ).get(input.fingerprint) as { id?: number; occurrences?: number; status?: string } | undefined;
      if (existing?.id !== undefined) {
        const nextOccurrences = Math.min(MAX_ERROR_REPORT_OCCURRENCES, Number(existing.occurrences ?? 1) + 1);
        this.database.prepare(`
          UPDATE error_report_queue
             SET occurrences = ?,
                 last_occurred_at = ?,
                 app_version = ?,
                 updated_at = ?
           WHERE id = ?
        `).run(nextOccurrences, input.occurredAt, input.appVersion, recordedAt, existing.id);
        return { accepted: true, reason: 'merged_pending', occurrences: nextOccurrences };
      }

      // Enforce hard queue cap before inserting a new row: evict terminal/failed
      // first, then warnings, then oldest pending.
      const countRow = this.database.prepare('SELECT COUNT(*) AS count FROM error_report_queue')
        .get() as { count?: number } | undefined;
      const currentCount = Number(countRow?.count ?? 0);
      if (currentCount >= MAX_ERROR_REPORT_QUEUE) {
        const excess = currentCount - MAX_ERROR_REPORT_QUEUE + 1;
        this.database.prepare(`
          DELETE FROM error_report_queue
          WHERE id IN (
            SELECT id FROM error_report_queue
            ORDER BY
              CASE WHEN status = 'failed' THEN 0 ELSE 1 END ASC,
              CASE WHEN severity = 'warning' THEN 0 ELSE 1 END ASC,
              created_at ASC,
              id ASC
            LIMIT ?
          )
        `).run(excess);
      }

      this.database.prepare(`
        INSERT INTO error_report_queue (
          fingerprint, category, severity, code, component, process,
          app_version, platform, arch, os_release, electron_version,
          packaged, sqlite_schema_version, http_status, postgres_code,
          occurrences, first_occurred_at, last_occurred_at,
          status, attempts, next_attempt_at, last_error_code,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending', 0, ?, NULL, ?, ?)
      `).run(
        input.fingerprint,
        input.category,
        input.severity,
        input.code,
        input.component,
        input.process,
        input.appVersion,
        input.platform,
        input.arch,
        input.osRelease,
        input.electronVersion ?? null,
        input.packaged ? 1 : 0,
        input.sqliteSchemaVersion ?? null,
        input.httpStatus ?? null,
        input.postgresCode ?? null,
        input.occurredAt,
        input.occurredAt,
        recordedAt,
        recordedAt,
        recordedAt,
      );

      return { accepted: true, occurrences: 1 };
    });

    return execute();
  }

  public claimErrorReports(input?: { limit?: number; now?: string }): QueuedErrorReportRecord[] {
    this.ensureOpen();
    const limit = Math.max(1, Math.min(5, Math.trunc(input?.limit ?? 3)));
    const nowIso = input?.now ?? this.now();
    const rows = this.database.prepare(`
      SELECT * FROM error_report_queue
       WHERE status = 'pending'
         AND next_attempt_at <= ?
       ORDER BY
         CASE WHEN severity = 'error' THEN 0 ELSE 1 END ASC,
         created_at ASC,
         id ASC
       LIMIT ?
    `).all(nowIso, limit) as Record<string, unknown>[];
    return rows.map((row) => this.errorReportFromRow(row));
  }

  public completeErrorReport(input: CompleteErrorReportInput): void {
    this.ensureOpen();
    const nowIso = input.now ?? this.now();
    const nowMs = Date.parse(nowIso);
    const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    const execute = this.database.transaction(() => {
      if (input.outcome === 'disabled') {
        this.database.prepare('DELETE FROM error_report_queue').run();
        return;
      }

      if (input.outcome === 'delivered' || input.outcome === 'suppressed_remote') {
        this.database.prepare('DELETE FROM error_report_queue WHERE fingerprint = ?').run(input.fingerprint);
        this.database.prepare(`
          INSERT INTO error_report_dedupe (fingerprint, last_reported_at, suppressed_count)
          VALUES (?, ?, 0)
          ON CONFLICT(fingerprint) DO UPDATE SET
            last_reported_at = excluded.last_reported_at,
            suppressed_count = 0
        `).run(input.fingerprint, nowIso);
        return;
      }

      const row = this.database.prepare(
        'SELECT id, attempts FROM error_report_queue WHERE fingerprint = ?',
      ).get(input.fingerprint) as { id?: number; attempts?: number } | undefined;
      if (row?.id === undefined) return;

      const nextAttempts = Number(row.attempts ?? 0) + 1;
      const safeCode = typeof input.errorCode === 'string' && /^[A-Z0-9_.:-]{2,64}$/.test(input.errorCode)
        ? input.errorCode
        : 'DELIVERY_FAILED';

      if (input.outcome === 'terminal' || nextAttempts >= MAX_ERROR_REPORT_ATTEMPTS) {
        this.database.prepare(`
          UPDATE error_report_queue
             SET status = 'failed',
                 attempts = ?,
                 last_error_code = ?,
                 updated_at = ?
           WHERE id = ?
        `).run(nextAttempts, safeCode, nowIso, row.id);
        return;
      }

      const computedBackoffSec = Math.min(3600, 30 * (2 ** Math.min(nextAttempts, 7)));
      const requestedSec = typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds)
        ? Math.max(30, Math.min(86_400, Math.trunc(input.retryAfterSeconds)))
        : 0;
      const delaySec = Math.max(computedBackoffSec, requestedSec);
      const nextAttemptAt = new Date(baseMs + delaySec * 1000).toISOString();

      this.database.prepare(`
        UPDATE error_report_queue
           SET status = 'pending',
               attempts = ?,
               next_attempt_at = ?,
               last_error_code = ?,
               updated_at = ?
         WHERE id = ?
      `).run(nextAttempts, nextAttemptAt, safeCode, nowIso, row.id);
    });

    execute();
  }

  public getErrorReportQueueSummary(): ErrorReportQueueSummary {
    this.ensureOpen();
    const rows = this.database.prepare(
      'SELECT status, COUNT(*) AS count FROM error_report_queue GROUP BY status',
    ).all() as Array<{ status?: unknown; count?: unknown }>;
    let pendingCount = 0;
    let failedCount = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      if (row.status === 'pending') pendingCount += count;
      if (row.status === 'failed') failedCount += count;
    }
    const dedupeRow = this.database.prepare(
      'SELECT COALESCE(SUM(suppressed_count), 0) AS total FROM error_report_dedupe',
    ).get() as { total?: number } | undefined;
    return {
      pendingCount,
      failedCount,
      suppressedCount: Number(dedupeRow?.total ?? 0),
      sqliteSchemaVersion: this.getMigrationVersion(),
    };
  }

  public clearErrorReportQueue(): void {
    this.ensureOpen();
    this.database.prepare('DELETE FROM error_report_queue').run();
  }

  // ---------------------------------------------------------------------------
  // Cloud backup (PR1): snapshot, change fingerprint and backup bookkeeping.
  //
  // Everything here operates on the LIVE database read-only, except
  // `createSnapshotCopy`, which writes only to the caller-supplied destination
  // path. The live file is never copied with `fs.copyFile` — a plain copy of a
  // WAL database can be torn mid-write.
  // ---------------------------------------------------------------------------

  /** Absolute path of the live database file (`:memory:` in tests). */
  public getDatabasePath(): string {
    return this.filename;
  }

  /**
   * Cheap SQL digest used to decide whether a backup is worth uploading.
   *
   * Deliberately aggregate-only: counts, maxima and sums, never row contents,
   * so the value is deterministic and contains no customer data.
   *
   * The brief specified `count + max(updated_at) + max(id)`. Three cheap sums
   * were added because the maxima alone are not enough at the resolution DKS
   * actually stores: two edits inside the same millisecond leave the count, the
   * maximum timestamp and the maximum id untouched, so a real change would
   * never be backed up. `sum(version)` (every update increments it),
   * `sum(deleted)` (soft delete and restore) and the column/settings counts
   * close that hole without ever reading a row.
   */
  public computeBackupFingerprint(): BackupFingerprint {
    this.ensureOpen();
    const entries = this.database.prepare(`
      SELECT COUNT(*) AS count,
             MAX(updated_at) AS maxUpdatedAt,
             MAX(id) AS maxId,
             COALESCE(SUM(version), 0) AS versionSum,
             COALESCE(SUM(deleted), 0) AS deletedSum
        FROM entries
    `).get() as {
      count?: number; maxUpdatedAt?: string | null; maxId?: string | null;
      versionSum?: number; deletedSum?: number;
    } | undefined;
    const columns = this.database.prepare(`
      SELECT COUNT(*) AS count,
             MAX(updated_at) AS maxUpdatedAt,
             COALESCE(SUM(deleted), 0) AS deletedSum
        FROM columns
    `).get() as { count?: number; maxUpdatedAt?: string | null; deletedSum?: number } | undefined;
    const settings = this.database.prepare(`
      SELECT COUNT(*) AS count, MAX(updated_at) AS maxUpdatedAt FROM local_settings
    `).get() as { count?: number; maxUpdatedAt?: string | null } | undefined;

    return {
      entriesCount: Number(entries?.count ?? 0),
      entriesMaxUpdatedAt: entries?.maxUpdatedAt ?? null,
      entriesMaxId: entries?.maxId ?? null,
      entriesVersionSum: Number(entries?.versionSum ?? 0),
      entriesDeletedSum: Number(entries?.deletedSum ?? 0),
      columnsCount: Number(columns?.count ?? 0),
      columnsMaxUpdatedAt: columns?.maxUpdatedAt ?? null,
      columnsDeletedSum: Number(columns?.deletedSum ?? 0),
      settingsCount: Number(settings?.count ?? 0),
      settingsMaxUpdatedAt: settings?.maxUpdatedAt ?? null,
    };
  }

  /** Row counts recorded as backup metadata (aggregate only, no row data). */
  public getBackupRecordCounts(): BackupRecordCounts {
    this.ensureOpen();
    const scalar = (sql: string): number => {
      const row = this.database.prepare(sql).get() as { value?: number } | undefined;
      return Number(row?.value ?? 0);
    };
    return {
      entries: scalar('SELECT COUNT(*) AS value FROM entries'),
      entriesActive: scalar('SELECT COUNT(*) AS value FROM entries WHERE deleted = 0'),
      entriesDeleted: scalar('SELECT COUNT(*) AS value FROM entries WHERE deleted <> 0'),
      columns: scalar('SELECT COUNT(*) AS value FROM columns'),
      columnsDeleted: scalar('SELECT COUNT(*) AS value FROM columns WHERE deleted <> 0'),
      settings: scalar('SELECT COUNT(*) AS value FROM local_settings'),
      auditLog: scalar('SELECT COUNT(*) AS value FROM audit_log'),
    };
  }

  /**
   * Write a consistent point-in-time copy of this database to `destination`,
   * then strip SNAPSHOT_EXCLUDED_TABLES from the COPY.
   *
   * Uses better-sqlite3's online `backup()` (which walks the pager and is safe
   * against concurrent WAL writers) and falls back to `VACUUM INTO` when the
   * runtime does not provide it. The live database is never modified.
   */
  public async createSnapshotCopy(destination: string): Promise<BackupRecordCounts> {
    this.ensureOpen();
    const counts = this.getBackupRecordCounts();

    // Flush the WAL so the copy cannot lag behind committed writes.
    try {
      this.database.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // In-memory databases reject checkpoints; their state is still durable
      // for the connection doing the backup.
    }

    if (typeof this.database.backup === 'function') {
      await this.database.backup(destination);
    } else {
      this.database.pragma(`vacuum_into('${destination.replace(/'/g, "''")}')`);
    }

    const copy = new BetterSqlite3(destination);
    try {
      for (const table of SNAPSHOT_EXCLUDED_TABLES) {
        // Names come from a module constant, never from input.
        copy.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      // Compact the holes left by the dropped tables so the upload is small.
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }

    return counts;
  }

  /** Machine-local backup bookkeeping. Lives in sync_meta, never in a snapshot. */
  public getBackupMeta(key: string): string | null {
    this.ensureOpen();
    const row = this.database.prepare('SELECT value FROM sync_meta WHERE key = ?')
      .get(key) as { value?: string | null } | undefined;
    return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null;
  }

  public setBackupMeta(key: string, value: string): void {
    this.ensureOpen();
    this.database.prepare(
      'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  public async flush(): Promise<void> {
    this.ensureOpen();
    try {
      this.database.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // SQLite memory databases and read-only environments can reject a
      // checkpoint; all completed statements remain durable in the connection.
    }
  }

  public async sync(): Promise<void> {
    await this.flush();
  }

  public close(): CloseSyncResult {
    if (this.closed) {
      return { closed: true, flushed: true };
    }

    let flushed = true;
    try {
      try {
        this.database.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        flushed = false;
      }
      this.database.close();
    } finally {
      this.closed = true;
    }
    return { closed: true, flushed };
  }

  public closeAndFlush(): CloseSyncResult {
    return this.close();
  }

  public flushAndClose(): CloseSyncResult {
    return this.close();
  }
}

export function createSqliteStore(options: SqliteStoreOptions | string = {}): SqliteStore {
  return new SqliteStore(options);
}

export const openSqliteStore = createSqliteStore;
export const createProtectedSqliteStore = createSqliteStore;
export const openDatabase = createSqliteStore;
export const createDatabase = createSqliteStore;
export const createSqliteDatabase = createSqliteStore;
export const SqliteRepository = SqliteStore;
export type ProtectedSqliteStore = SqliteStore;
