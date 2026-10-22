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
  | 'notes';

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

export type OutboxStatus = 'pending' | 'processing' | 'synced' | 'failed';

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
];

export const SQLITE_SCHEMA_VERSION = MIGRATIONS.length;

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

function isDaysLeftColumn(column: Pick<LocalColumnDefinition, 'id' | 'name'>): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[ _-]/g, '');
  return normalize(column.id) === 'daysleft' || normalize(column.name) === 'daysleft';
}

function hasColumnValue(value: unknown): boolean {
  return value !== null && value !== undefined
    && (typeof value !== 'string' || value.trim().length > 0);
}

function canDeleteColumnForOffice(
  column: Pick<LocalColumnDefinition, 'id' | 'name' | 'isPrimaryExpiry'>,
  rows: readonly GridRowLike[],
): boolean {
  if (isDaysLeftColumn(column) || column.isPrimaryExpiry === true) {
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
    if (
      (input.isPrimaryExpiry === true || input.is_primary_expiry === true)
      && input.type !== 'date_expiry'
    ) {
      throw new Error('The primary expiry column must use date_expiry type');
    }
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
      if (primary) {
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

  private repairPrimaryExpiry(timestamp: string): void {
    const activeExpiry = this.database.prepare(
      'SELECT id FROM columns WHERE deleted = 0 AND type = \'date_expiry\' ORDER BY position, id',
    ).all() as { id: string }[];

    if (activeExpiry.length === 0) {
      return;
    }

    const currentPrimary = this.database.prepare(
      'SELECT id FROM columns WHERE deleted = 0 AND type = \'date_expiry\' AND is_primary_expiry = 1 ORDER BY position, id',
    ).all() as { id: string }[];
    if (currentPrimary.length === 1) {
      return;
    }

    this.database.prepare('UPDATE columns SET is_primary_expiry = 0 WHERE deleted = 0 AND type = \'date_expiry\'').run();
    this.database.prepare('UPDATE columns SET is_primary_expiry = 1, updated_at = ? WHERE id = ?')
      .run(timestamp, activeExpiry[0].id);
  }

  public createColumn(input: ColumnInput): LocalColumn {
    return this.upsertColumn(input);
  }

  public updateColumn(input: ColumnInput): LocalColumn {
    return this.upsertColumn(input);
  }

  public canDeleteColumn(
    id: string,
    role: 'admin' | 'office' | string,
  ): boolean {
    const column = this.getColumn(id);
    if (!column || isDaysLeftColumn(column) || column.isPrimaryExpiry === true) {
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
    this.database.prepare('UPDATE outbox SET status = \'synced\', last_error = NULL WHERE id = ?').run(id);
  }

  public markOutboxFailed(id: number | string, message: string): void {
    this.ensureOpen();
    this.database.prepare('UPDATE outbox SET status = \'failed\', last_error = ? WHERE id = ?').run(message, id);
  }

  /** Mark the local mutation queue complete after a full remote reconciliation. */
  public acknowledgeOutbox(): SyncState {
    this.ensureOpen();
    this.database.prepare("UPDATE outbox SET status = 'synced', last_error = NULL WHERE status <> 'synced' AND entity_type IN ('entry', 'column')").run();
    return this.setSyncStatus({ status: 'healthy', lastSyncAt: this.now(), lastError: null });
  }

  public acknowledgeSettings(): SyncState {
    this.ensureOpen();
    this.database.prepare("UPDATE outbox SET status = 'synced', last_error = NULL WHERE status <> 'synced' AND entity_type = 'settings'").run();
    return this.setSyncStatus({ status: 'healthy', lastSyncAt: this.now(), lastError: null });
  }

  public retryFailedOutbox(): number {
    this.ensureOpen();
    const result = this.database.prepare('UPDATE outbox SET status = \'pending\', last_error = NULL WHERE status = \'failed\'').run();
    return result.changes;
  }

  public getPendingOutboxCount(): number {
    this.ensureOpen();
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status IN ('pending', 'processing', 'failed')").get() as { count?: number } | undefined;
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
    const current = this.listNotifications().find((notification) => (
      String(notification.id) === requested
      || notification.payload.id === id
      || notification.payload.id === requested
      || notification.payload.dedupeKey === requested
    ));
    if (!current) {
      return null;
    }

    const nextPayload = patch.payload ? { ...current.payload, ...patch.payload } : current.payload;
    const nextRead = patch.read ?? current.read;
    const nextDismissed = patch.dismissed ?? current.dismissed;
    const updatedAt = this.now();
    this.database.prepare(`
      UPDATE notifications
         SET payload = ?, read = ?, dismissed = ?, updated_at = ?
       WHERE id = ?
    `).run(
      encode(nextPayload),
      nextRead ? 1 : 0,
      nextDismissed ? 1 : 0,
      updatedAt,
      current.id,
    );

    return {
      ...current,
      payload: nextPayload,
      read: nextRead,
      dismissed: nextDismissed,
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
