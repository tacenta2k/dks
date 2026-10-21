import type {
  AuditRecord,
  CloseSyncResult,
  ColumnInput,
  EntryInput,
  EntryPatch,
  NotificationInput,
  NotificationPatch,
  NotificationRecord,
  ConflictRecord,
  RemoteColumnInput,
  RemoteEntryInput,
} from './sqlite';
import type { SyncState, SyncStatus } from './sync';

/** Stable channel names shared by the main-process registration and preload. */
export const LOCAL_IPC_CHANNELS = Object.freeze({
  getSnapshot: 'dks:local:get-snapshot',
  createRow: 'dks:local:create-row',
  updateRow: 'dks:local:update-row',
  duplicateRow: 'dks:local:duplicate-row',
  softDeleteRow: 'dks:local:soft-delete-row',
  restoreRow: 'dks:local:restore-row',
  permanentDeleteRow: 'dks:local:permanent-delete-row',
  addColumn: 'dks:local:add-column',
  updateColumn: 'dks:local:update-column',
  deleteColumn: 'dks:local:delete-column',
  importRecords: 'dks:local:import-records',
  listAudit: 'dks:local:list-audit',
  listNotifications: 'dks:local:list-notifications',
  addNotification: 'dks:local:add-notification',
  updateNotification: 'dks:local:update-notification',
  applyRemoteSnapshot: 'dks:local:apply-remote-snapshot',
  acknowledgeOutbox: 'dks:local:acknowledge-outbox',
  acknowledgeSettings: 'dks:local:acknowledge-settings',
  recordConflict: 'dks:local:record-conflict',
  getSettings: 'dks:local:get-settings',
  setSettings: 'dks:local:set-settings',
  setSyncStatus: 'dks:local:set-sync-status',
  listOutbox: 'dks:local:list-outbox',
  markOutboxSynced: 'dks:local:mark-outbox-synced',
  markOutboxFailed: 'dks:local:mark-outbox-failed',
  retryFailedOutbox: 'dks:local:retry-failed-outbox',
  flushSync: 'dks:local:flush-sync',
  close: 'dks:local:close',
} as const);

export type LocalIpcChannel = (typeof LOCAL_IPC_CHANNELS)[keyof typeof LOCAL_IPC_CHANNELS];

export interface LocalIpcStore {
  listRows: (includeDeleted?: boolean) => readonly unknown[];
  listEntries?: (includeDeleted?: boolean) => readonly unknown[];
  getRow?: (id: string) => unknown | null;
  getEntry?: (id: string) => unknown | null;
  createRow: (input: EntryInput) => unknown;
  createEntry?: (input: EntryInput) => unknown;
  updateRow: (id: string, patch: EntryPatch) => unknown | null;
  updateEntry?: (id: string, patch: EntryPatch) => unknown | null;
  softDeleteEntry?: (id: string, idempotencyKey?: string, updatedBy?: string | null) => unknown | null;
  deleteRow?: (id: string, idempotencyKey?: string, updatedBy?: string | null) => unknown | null;
  restoreEntry?: (id: string, idempotencyKey?: string, updatedBy?: string | null) => unknown | null;
  permanentDeleteEntry?: (id: string, idempotencyKey?: string, updatedBy?: string | null) => unknown | null;
  permanentDeleteRow?: (id: string, idempotencyKey?: string, updatedBy?: string | null) => unknown | null;
  listColumns: (includeDeleted?: boolean) => readonly unknown[];
  getColumn?: (id: string) => unknown | null;
  upsertColumn: (input: ColumnInput & { role?: string }) => unknown;
  createColumn?: (input: ColumnInput & { role?: string }) => unknown;
  updateColumn?: (input: ColumnInput & { role?: string }) => unknown;
  deleteColumn: (id: string, role: string, idempotencyKey?: string) => unknown | null;
  getSyncStatus: () => SyncState;
  setSyncStatus: (state: SyncStatus | (Partial<SyncState> & Pick<SyncState, 'status'>)) => SyncState;
  listAudit: (limit?: number) => readonly AuditRecord[];
  listNotifications: (unreadOnly?: boolean) => readonly NotificationRecord[];
  addNotification?: (input: NotificationInput) => NotificationRecord;
  updateNotification?: (id: number | string, patch: NotificationPatch) => NotificationRecord | null;
  applyRemoteEntry?: (input: RemoteEntryInput) => unknown;
  applyRemoteColumn?: (input: RemoteColumnInput) => unknown;
  acknowledgeOutbox?: () => SyncState;
  acknowledgeSettings?: () => SyncState;
  recordConflict?: (input: Omit<ConflictRecord, 'id' | 'createdAt' | 'resolved'> & { createdAt?: string }) => ConflictRecord;
  getSettings?: () => Record<string, unknown>;
  setSettings?: (settings: Record<string, unknown>) => Record<string, unknown>;
  recordAudit?: (input: Omit<AuditRecord, 'id'>) => AuditRecord;
  enqueueOutbox?: (input: {
    idempotencyKey: string;
    operation: string;
    entityType: string;
    entityId: string;
    payload: unknown;
  }) => unknown;
  listOutbox?: (status?: string) => readonly unknown[];
  markOutboxSynced?: (id: number | string) => void;
  markOutboxFailed?: (id: number | string, message: string) => void;
  retryFailedOutbox?: () => number;
  sync?: () => Promise<void> | void;
  flush: () => Promise<void> | void;
  close: () => CloseSyncResult;
}

export interface LocalIpcMain {
  handle: (channel: string, listener: (event: unknown, payload?: unknown) => unknown) => void;
  removeHandler?: (channel: string) => void;
}

export interface LocalIpcDependencies {
  store: LocalIpcStore;
  now?: () => string;
}

export type LocalIpcHandler = (payload?: unknown, event?: unknown) => unknown;
export type LocalIpcHandlers = Readonly<Record<LocalIpcChannel, LocalIpcHandler>>;

const SYNC_STATUSES: readonly SyncStatus[] = ['offline', 'syncing', 'healthy', 'error'];
const DEFAULT_AUDIT_LIMIT = 500;
const MAX_AUDIT_LIMIT = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, label);
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }
  return requiredString(value, label);
}

function dataObject(value: unknown, label = 'data'): Record<string, unknown> {
  return asRecord(value, label);
}

function cloneSerializable<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function rowFromUnknown(value: unknown, label = 'row'): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  const row = asRecord(value, label);
  requiredString(row.id, `${label}.id`);
  if (!isRecord(row.data)) {
    throw new Error(`${label}.data must be an object`);
  }
  return cloneSerializable(row);
}

function columnFromUnknown(value: unknown, label = 'column'): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  const column = asRecord(value, label);
  requiredString(column.id, `${label}.id`);
  requiredString(column.name, `${label}.name`);
  requiredString(column.type, `${label}.type`);
  return cloneSerializable(column);
}

function roleFrom(value: unknown): string {
  const role = requiredString(value, 'role');
  if (role !== 'admin' && role !== 'office') {
    throw new Error('role must be admin or office');
  }
  return role;
}

function generatedColumnId(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return id || 'column';
}

function idFrom(value: Record<string, unknown>, label = 'id'): string {
  return requiredString(value.id ?? value.rowId ?? value.columnId, label);
}

function notificationIdFrom(value: Record<string, unknown>): number | string {
  const candidate = value.id ?? value.notificationId;
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
    return candidate;
  }
  return requiredString(candidate, 'notification id');
}

function getRows(store: LocalIpcStore, includeDeleted: boolean): readonly unknown[] {
  if (typeof store.listRows === 'function') {
    return store.listRows(includeDeleted);
  }
  return store.listEntries?.(includeDeleted) ?? [];
}

function getRow(store: LocalIpcStore, id: string): unknown | null {
  return store.getRow?.(id) ?? store.getEntry?.(id) ?? getRows(store, true).find((row) => (
    isRecord(row) && row.id === id
  )) ?? null;
}

function updateRow(store: LocalIpcStore, id: string, patch: EntryPatch): unknown | null {
  if (typeof store.updateRow === 'function') {
    return store.updateRow(id, patch);
  }
  return store.updateEntry?.(id, patch) ?? null;
}

function softDeleteRow(
  store: LocalIpcStore,
  id: string,
  idempotencyKey: string | undefined,
  updatedBy: string | null | undefined,
): unknown | null {
  if (store.softDeleteEntry) {
    return store.softDeleteEntry(id, idempotencyKey, updatedBy);
  }
  if (store.deleteRow) {
    return store.deleteRow(id, idempotencyKey, updatedBy);
  }
  return updateRow(store, id, {
    deleted: true,
    deletedAt: new Date().toISOString(),
    idempotencyKey,
    updatedBy,
  });
}

function restoreRow(
  store: LocalIpcStore,
  id: string,
  idempotencyKey: string | undefined,
  updatedBy: string | null | undefined,
): unknown | null {
  if (store.restoreEntry) {
    return store.restoreEntry(id, idempotencyKey, updatedBy);
  }
  return updateRow(store, id, {
    deleted: false,
    deletedAt: null,
    idempotencyKey,
    updatedBy,
  });
}

function createRow(store: LocalIpcStore, input: EntryInput): unknown {
  if (typeof store.createRow === 'function') {
    return store.createRow(input);
  }
  if (store.createEntry) {
    return store.createEntry(input);
  }
  throw new Error('The local store cannot create rows');
}

function createColumn(store: LocalIpcStore, input: ColumnInput & { role?: string }): unknown {
  return store.createColumn?.(input) ?? store.upsertColumn(input);
}

function updateColumn(store: LocalIpcStore, input: ColumnInput & { role?: string }): unknown {
  return store.updateColumn?.(input) ?? store.upsertColumn(input);
}

function permanentDeleteRow(
  store: LocalIpcStore,
  id: string,
  idempotencyKey: string | undefined,
  updatedBy: string | null | undefined,
  now: () => string,
): unknown | null {
  // Bind the store explicitly: class methods such as SqliteStore's
  // permanentDeleteEntry dereference `this.ensureOpen()`, and invoking a
  // detached reference would crash with "Cannot read properties of undefined
  // (reading 'ensureOpen')".
  const remove = store.permanentDeleteEntry ?? store.permanentDeleteRow;
  if (remove) {
    return remove.call(store, id, idempotencyKey, updatedBy);
  }

  // SqliteStore predates this bridge operation and intentionally keeps its
  // native handle private. This main-process-only compatibility path uses the
  // handle without ever returning it across IPC; newer stores should expose
  // permanentDeleteEntry directly.
  const database = (store as unknown as {
    database?: {
      prepare: (query: string) => { run: (...args: unknown[]) => unknown };
      transaction: <T>(callback: () => T) => () => T;
    };
  }).database;
  if (!database) {
    throw new Error('Permanent row deletion is unavailable in this local store');
  }

  const current = getRow(store, id);
  if (!current) {
    return null;
  }
  const timestamp = now();
  const key = idempotencyKey ?? `entry:permanent-delete:${id}:${timestamp}`;
  const removeTransaction = database.transaction(() => {
    database.prepare('DELETE FROM entries WHERE id = ?').run(id);
  });
  removeTransaction();

  store.enqueueOutbox?.({
    idempotencyKey: key,
    operation: 'permanent_delete',
    entityType: 'entry',
    entityId: id,
    payload: { id, deleted: true, deleted_at: timestamp },
  });
  store.recordAudit?.(makeAuditRecord({
    actor: updatedBy ?? null,
    entityType: 'entry',
    entityId: id,
    action: 'permanent_delete',
    before: current,
    after: null,
    createdAt: timestamp,
  }));
  return current;
}

function storeSnapshot(store: LocalIpcStore): {
  rows: Record<string, unknown>[];
  activeRows: Record<string, unknown>[];
  deletedRows: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  deletedColumns: Record<string, unknown>[];
  settings: Record<string, unknown>;
  syncStatus: SyncState;
} {
  const rows = getRows(store, true)
    .map((row) => rowFromUnknown(row))
    .filter((row): row is Record<string, unknown> => row !== null);
  const activeRows = rows.filter((row) => row.deleted !== true);
  const deletedRows = rows.filter((row) => row.deleted === true);
  const columns = store.listColumns(false)
    .map((column) => columnFromUnknown(column))
    .filter((column): column is Record<string, unknown> => column !== null && column.deleted !== true);
  // Soft-deleted columns are kept separate from the active set so the grid
  // never shows them, while the sync engine can still push their deletion to
  // the cloud and consume their outbox entries (previously these outbox items
  // were orphaned and kept the pending count growing forever).
  const deletedColumns = store.listColumns(true)
    .map((column) => columnFromUnknown(column))
    .filter((column): column is Record<string, unknown> => column !== null && column.deleted === true);

  return {
    rows: activeRows,
    activeRows,
    deletedRows,
    columns,
    deletedColumns,
    settings: cloneSerializable(store.getSettings?.() ?? {}),
    syncStatus: cloneSerializable(store.getSyncStatus()),
  };
}

function makeAuditRecord(input: Record<string, unknown>): Omit<AuditRecord, 'id'> {
  return {
    actor: typeof input.actor === 'string' ? input.actor : null,
    entityType: typeof input.entityType === 'string' ? input.entityType : 'entry',
    entityId: typeof input.entityId === 'string' ? input.entityId : null,
    action: typeof input.action === 'string' ? input.action : 'import',
    before: input.before ?? null,
    after: input.after ?? null,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
  };
}

export function createLocalIpcHandlers(dependencies: LocalIpcDependencies): LocalIpcHandlers {
  const { store } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());

  const handlers: Record<LocalIpcChannel, LocalIpcHandler> = {
    [LOCAL_IPC_CHANNELS.getSnapshot]: () => cloneSerializable(storeSnapshot(store)),

    [LOCAL_IPC_CHANNELS.createRow]: (payload) => {
      const input = asRecord(payload, 'create row input');
      const data = dataObject(input.data);
      const category = input.category === undefined || input.category === null
        ? undefined
        : requiredString(input.category, 'category');
      const result = createRow(store, {
        id: optionalString(input.id, 'id'),
        data,
        category,
        idempotencyKey: optionalString(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey'),
        updatedBy: optionalNullableString(input.updatedBy ?? input.updated_by, 'updatedBy'),
      });
      return rowFromUnknown(result, 'created row');
    },

    [LOCAL_IPC_CHANNELS.updateRow]: (payload) => {
      const input = asRecord(payload, 'update row input');
      const id = idFrom(input, 'row id');
      const patchRecord = input.patch !== undefined
        ? dataObject(input.patch, 'patch')
        : input.data === undefined
          ? {}
          : dataObject(input.data);
      const category = input.category === undefined || input.category === null
        ? undefined
        : requiredString(input.category, 'category');
      const patch: EntryPatch = {
        data: patchRecord,
        ...(category === undefined ? {} : { category }),
        ...(typeof input.deleted === 'boolean' ? { deleted: input.deleted } : {}),
        ...(input.deletedAt !== undefined ? { deletedAt: optionalNullableString(input.deletedAt, 'deletedAt') ?? null } : {}),
        ...(input.updatedBy !== undefined ? { updatedBy: optionalNullableString(input.updatedBy, 'updatedBy') ?? null } : {}),
        idempotencyKey: optionalString(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey'),
        updatedAt: optionalString(input.updatedAt ?? input.updated_at, 'updatedAt'),
      };
      return rowFromUnknown(updateRow(store, id, patch), 'updated row');
    },

    [LOCAL_IPC_CHANNELS.duplicateRow]: (payload) => {
      const input = asRecord(payload, 'duplicate row input');
      const id = idFrom(input, 'row id');
      const source = rowFromUnknown(getRow(store, id), 'source row');
      if (!source) {
        throw new Error(`Unknown sheet row: ${id}`);
      }
      const sourceData = dataObject(source.data);
      const sourceCategory = typeof source.category === 'string' ? source.category : undefined;
      const result = createRow(store, {
        data: sourceData,
        category: sourceCategory,
        idempotencyKey: optionalString(input.idempotencyKey, 'idempotencyKey'),
        updatedBy: optionalNullableString(input.updatedBy, 'updatedBy'),
      });
      return rowFromUnknown(result, 'duplicated row');
    },

    [LOCAL_IPC_CHANNELS.softDeleteRow]: (payload) => {
      const input = asRecord(payload, 'soft-delete row input');
      const id = idFrom(input, 'row id');
      return rowFromUnknown(softDeleteRow(
        store,
        id,
        optionalString(input.idempotencyKey, 'idempotencyKey'),
        optionalNullableString(input.updatedBy ?? input.actorId ?? input.actor, 'updatedBy'),
      ), 'deleted row');
    },

    [LOCAL_IPC_CHANNELS.restoreRow]: (payload) => {
      const input = asRecord(payload, 'restore row input');
      const id = idFrom(input, 'row id');
      // Admin authorisation is mandatory at the IPC boundary as well as the
      // preload bridge. A missing role is denied, never assumed to be admin.
      const role = roleFrom(input.role);
      if (role !== 'admin') {
        throw new Error('administrator role is required');
      }
      return rowFromUnknown(restoreRow(
        store,
        id,
        optionalString(input.idempotencyKey, 'idempotencyKey'),
        optionalNullableString(input.updatedBy ?? input.actorId ?? input.actor, 'updatedBy'),
      ), 'restored row');
    },

    [LOCAL_IPC_CHANNELS.permanentDeleteRow]: (payload) => {
      const input = asRecord(payload, 'permanent-delete row input');
      const id = idFrom(input, 'row id');
      // Admin authorisation is mandatory at the IPC boundary as well as the
      // preload bridge. A missing role is denied, never assumed to be admin.
      const role = roleFrom(input.role);
      if (role !== 'admin') {
        throw new Error('administrator role is required');
      }
      return rowFromUnknown(permanentDeleteRow(
        store,
        id,
        optionalString(input.idempotencyKey, 'idempotencyKey'),
        optionalNullableString(input.updatedBy ?? input.actorId ?? input.actor, 'updatedBy'),
        now,
      ), 'permanently deleted row');
    },

    [LOCAL_IPC_CHANNELS.addColumn]: (payload) => {
      const input = asRecord(payload, 'add column input');
      const role = roleFrom(input.role);
      const name = requiredString(input.name, 'column name');
      const type = requiredString(input.type, 'column type');
      if (
        role === 'office'
        && (input.isPrimaryExpiry === true || input.is_primary_expiry === true)
      ) {
        throw new Error('Office users cannot change the primary expiry setting');
      }
      const result = createColumn(store, {
        id: optionalString(input.id, 'column id') ?? generatedColumnId(name),
        name,
        type: type as ColumnInput['type'],
        options: input.options,
        position: typeof input.position === 'number' ? input.position : undefined,
        visible: input.visible !== false,
        isPrimaryExpiry: input.isPrimaryExpiry === true || input.is_primary_expiry === true,
        isPassport: input.isPassport === true || input.is_passport === true,
        idempotencyKey: optionalString(input.idempotencyKey, 'idempotencyKey'),
        role,
      });
      return columnFromUnknown(result, 'created column');
    },

    [LOCAL_IPC_CHANNELS.updateColumn]: (payload) => {
      const input = asRecord(payload, 'update column input');
      const id = idFrom(input, 'column id');
      const role = roleFrom(input.role);
      const patch = dataObject(input.patch, 'column patch');
      if (
        role === 'office'
        && (patch.isPrimaryExpiry !== undefined || patch.is_primary_expiry !== undefined)
      ) {
        throw new Error('Office users cannot change the primary expiry setting');
      }
      const current = store.getColumn?.(id);
      if (!current) {
        throw new Error(`Unknown sheet column: ${id}`);
      }
      const currentRecord = asRecord(current, 'column');
      const merged = {
        ...currentRecord,
        ...patch,
        id,
        name: requiredString(patch.name ?? currentRecord.name, 'column name'),
        type: requiredString(patch.type ?? currentRecord.type, 'column type') as ColumnInput['type'],
        role,
        idempotencyKey: optionalString(input.idempotencyKey, 'idempotencyKey'),
      } as ColumnInput & { role: string };
      return columnFromUnknown(updateColumn(store, merged), 'updated column');
    },

    [LOCAL_IPC_CHANNELS.deleteColumn]: (payload) => {
      const input = asRecord(payload, 'delete column input');
      const id = idFrom(input, 'column id');
      const role = roleFrom(input.role);
      return columnFromUnknown(
        store.deleteColumn(id, role, optionalString(input.idempotencyKey, 'idempotencyKey')),
        'deleted column',
      );
    },

    [LOCAL_IPC_CHANNELS.importRecords]: (payload) => {
      const input = asRecord(payload, 'import records input');
      if (!Array.isArray(input.records)) {
        throw new Error('records must be an array');
      }
      const options = input.options === undefined ? {} : asRecord(input.options, 'import options');
      const records = input.records.map((value, index) => {
        const record = asRecord(value, `records[${index}]`);
        const category = record.category === undefined || record.category === null
          ? undefined
          : requiredString(record.category, `records[${index}].category`);
        const sourceRowNumber = record.sourceRowNumber;
        if (sourceRowNumber !== undefined && (!Number.isInteger(sourceRowNumber) || Number(sourceRowNumber) < 1)) {
          throw new Error(`records[${index}].sourceRowNumber must be a positive integer`);
        }
        return {
          data: dataObject(record.data, `records[${index}].data`),
          category,
          sourceRowNumber: sourceRowNumber as number | undefined,
        };
      });

      const created = records.map((record) => createRow(store, {
        data: record.data,
        category: record.category,
      }));
      if (created.length > 0 && store.recordAudit) {
        store.recordAudit(makeAuditRecord({
          actor: options.actor ?? options.actorId ?? null,
          entityType: 'entry',
          entityId: null,
          action: 'import',
          after: {
            importedRows: created.length,
            fileName: options.fileName ?? null,
            sourceRows: records
              .map((record) => record.sourceRowNumber)
              .filter((rowNumber): rowNumber is number => rowNumber !== undefined),
          },
          createdAt: now(),
        }));
      }
      return created
        .map((row) => rowFromUnknown(row, 'imported row'))
        .filter((row): row is Record<string, unknown> => row !== null);
    },

    [LOCAL_IPC_CHANNELS.listAudit]: (payload) => {
      const input = payload === undefined ? {} : asRecord(payload, 'audit list input');
      const limit = input.limit === undefined ? DEFAULT_AUDIT_LIMIT : Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
        throw new Error(`audit limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}`);
      }
      return cloneSerializable(store.listAudit(limit));
    },

    [LOCAL_IPC_CHANNELS.listNotifications]: (payload) => {
      const input = payload === undefined ? {} : asRecord(payload, 'notification list input');
      if (input.unreadOnly !== undefined && typeof input.unreadOnly !== 'boolean') {
        throw new Error('unreadOnly must be a boolean');
      }
      return cloneSerializable(store.listNotifications(input.unreadOnly === true));
    },

    [LOCAL_IPC_CHANNELS.addNotification]: (payload) => {
      const input = asRecord(payload, 'notification input');
      const add = store.addNotification;
      if (!add) {
        throw new Error('Notification persistence is unavailable in this local store');
      }
      const type = requiredString(input.type, 'notification type');
      const message = requiredString(input.message, 'notification message');
      const notification: NotificationInput = {
        type,
        message,
        payload: dataObject(input.payload, 'notification payload'),
        read: input.read === true,
        dismissed: input.dismissed === true,
        ...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
        ...(typeof input.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
      };
      return cloneSerializable(add.call(store, notification));
    },

    [LOCAL_IPC_CHANNELS.updateNotification]: (payload) => {
      const input = asRecord(payload, 'notification update input');
      const update = store.updateNotification;
      if (!update) {
        throw new Error('Notification updates are unavailable in this local store');
      }
      const patch: NotificationPatch = {};
      if (input.read !== undefined) {
        if (typeof input.read !== 'boolean') {
          throw new Error('notification read must be a boolean');
        }
        patch.read = input.read;
      }
      if (input.dismissed !== undefined) {
        if (typeof input.dismissed !== 'boolean') {
          throw new Error('notification dismissed must be a boolean');
        }
        patch.dismissed = input.dismissed;
      }
      if (input.payload !== undefined) {
        patch.payload = dataObject(input.payload, 'notification payload');
      }
      return cloneSerializable(update.call(store, notificationIdFrom(input), patch));
    },

    [LOCAL_IPC_CHANNELS.applyRemoteSnapshot]: (payload) => {
      const input = asRecord(payload, 'remote snapshot input');
      if (!Array.isArray(input.rows) || !Array.isArray(input.columns)) {
        throw new Error('Remote snapshot rows and columns must be arrays');
      }
      if (!store.applyRemoteEntry || !store.applyRemoteColumn) {
        throw new Error('Remote snapshot application is unavailable in this local store');
      }
      input.rows.forEach((value, index) => {
        const row = asRecord(value, `remote rows[${index}]`);
        requiredString(row.id, `remote rows[${index}].id`);
        dataObject(row.data, `remote rows[${index}].data`);
        store.applyRemoteEntry?.(row as unknown as RemoteEntryInput);
      });
      input.columns.forEach((value, index) => {
        const column = asRecord(value, `remote columns[${index}]`);
        requiredString(column.id, `remote columns[${index}].id`);
        requiredString(column.name, `remote columns[${index}].name`);
        requiredString(column.type, `remote columns[${index}].type`);
        store.applyRemoteColumn?.(column as unknown as RemoteColumnInput);
      });
      return cloneSerializable(storeSnapshot(store));
    },

    [LOCAL_IPC_CHANNELS.acknowledgeOutbox]: () => {
      if (!store.acknowledgeOutbox) {
        throw new Error('Outbox acknowledgement is unavailable in this local store');
      }
      return cloneSerializable(store.acknowledgeOutbox());
    },

    [LOCAL_IPC_CHANNELS.acknowledgeSettings]: () => {
      if (!store.acknowledgeSettings) {
        throw new Error('Settings acknowledgement is unavailable in this local store');
      }
      return cloneSerializable(store.acknowledgeSettings());
    },

    [LOCAL_IPC_CHANNELS.recordConflict]: (payload) => {
      const input = asRecord(payload, 'conflict input');
      if (!store.recordConflict) {
        throw new Error('Conflict recording is unavailable in this local store');
      }
      const entityType = requiredString(input.entityType, 'conflict entity type');
      const entityId = requiredString(input.entityId, 'conflict entity id');
      const winner = requiredString(input.winner, 'conflict winner');
      if (winner !== 'local' && winner !== 'remote') {
        throw new Error('conflict winner must be local or remote');
      }
      return cloneSerializable(store.recordConflict({
        entityType,
        entityId,
        local: input.local,
        remote: input.remote,
        winner,
        ...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
      }));
    },

    [LOCAL_IPC_CHANNELS.getSettings]: () => cloneSerializable(store.getSettings?.() ?? {}),

    [LOCAL_IPC_CHANNELS.setSettings]: (payload) => {
      const input = asRecord(payload, 'settings input');
      if (!store.setSettings) {
        throw new Error('Settings persistence is unavailable in this local store');
      }
      return cloneSerializable(store.setSettings(dataObject(input.settings, 'settings')));
    },

    [LOCAL_IPC_CHANNELS.setSyncStatus]: (payload) => {
      if (typeof payload === 'string') {
        if (!SYNC_STATUSES.includes(payload as SyncStatus)) {
          throw new Error('Invalid sync status');
        }
        return cloneSerializable(store.setSyncStatus(payload as SyncStatus));
      }
      const input = asRecord(payload, 'sync status input');
      if (typeof input.status !== 'string' || !SYNC_STATUSES.includes(input.status as SyncStatus)) {
        throw new Error('Invalid sync status');
      }
      const lastSyncAt = input.lastSyncAt !== undefined ? input.lastSyncAt : input.last_sync_at;
      const lastError = input.lastError !== undefined ? input.lastError : input.last_error;
      const pendingCount = input.pendingCount !== undefined ? input.pendingCount : input.pending_count;
      const state: Partial<SyncState> & Pick<SyncState, 'status'> = {
        status: input.status as SyncStatus,
        ...(lastSyncAt !== undefined
          ? { lastSyncAt: optionalNullableString(lastSyncAt, 'lastSyncAt') ?? null }
          : {}),
        ...(lastError !== undefined
          ? { lastError: optionalNullableString(lastError, 'lastError') ?? null }
          : {}),
        ...(pendingCount !== undefined
          ? { pendingCount: pendingCount as number }
          : {}),
      };
      if (
        pendingCount !== undefined
        && (typeof pendingCount !== 'number' || !Number.isInteger(pendingCount) || pendingCount < 0)
      ) {
        throw new Error('pendingCount must be a non-negative integer');
      }
      return cloneSerializable(store.setSyncStatus(state));
    },

    [LOCAL_IPC_CHANNELS.listOutbox]: (payload) => {
      const input = payload === undefined ? {} : asRecord(payload, 'outbox list input');
      const status = input.status === undefined ? 'pending' : requiredString(input.status, 'outbox status');
      if (!store.listOutbox) {
        throw new Error('Outbox inspection is unavailable in this local store');
      }
      // Metadata only: payloads repeat row data the renderer already has, and
      // this boundary must not widen the data exposed over IPC.
      return cloneSerializable(store.listOutbox(status).map((item) => {
        const record = asRecord(item, 'outbox item');
        return {
          id: record.id,
          idempotencyKey: record.idempotencyKey ?? record.idempotency_key,
          operation: record.operation,
          entityType: record.entityType ?? record.entity_type,
          entityId: record.entityId ?? record.entity_id,
          status: record.status,
          attempts: record.attempts,
          lastError: record.lastError ?? record.last_error ?? null,
          createdAt: record.createdAt ?? record.created_at,
        };
      }));
    },

    [LOCAL_IPC_CHANNELS.markOutboxSynced]: (payload) => {
      const input = asRecord(payload, 'outbox acknowledge input');
      const id = input.id;
      if (!((typeof id === 'number' && Number.isInteger(id)) || (typeof id === 'string' && id.trim()))) {
        throw new Error('outbox id is required');
      }
      if (!store.markOutboxSynced) {
        throw new Error('Outbox acknowledgement is unavailable in this local store');
      }
      store.markOutboxSynced(id as number | string);
      return { ok: true };
    },

    [LOCAL_IPC_CHANNELS.markOutboxFailed]: (payload) => {
      const input = asRecord(payload, 'outbox failure input');
      const id = input.id;
      if (!((typeof id === 'number' && Number.isInteger(id)) || (typeof id === 'string' && id.trim()))) {
        throw new Error('outbox id is required');
      }
      const message = requiredString(input.message, 'outbox failure message');
      if (!store.markOutboxFailed) {
        throw new Error('Outbox failure recording is unavailable in this local store');
      }
      store.markOutboxFailed(id as number | string, message.slice(0, 500));
      return { ok: true };
    },

    [LOCAL_IPC_CHANNELS.retryFailedOutbox]: () => {
      if (!store.retryFailedOutbox) {
        throw new Error('Outbox retry is unavailable in this local store');
      }
      return { requeued: store.retryFailedOutbox() };
    },

    [LOCAL_IPC_CHANNELS.flushSync]: async () => {
      if (store.sync) {
        await store.sync();
      } else {
        await store.flush();
      }
      return cloneSerializable(store.getSyncStatus());
    },

    [LOCAL_IPC_CHANNELS.close]: async () => {
      try {
        await store.flush();
      } catch {
        // close() reports whether its own final checkpoint completed. A
        // repeated close after renderer shutdown should remain idempotent.
      }
      return cloneSerializable(store.close());
    },
  };

  return handlers;
}

export function registerLocalIpcHandlers(
  dependencies: LocalIpcDependencies & { ipcMain: LocalIpcMain },
): () => void {
  const handlers = createLocalIpcHandlers(dependencies);
  const channels = Object.keys(handlers) as LocalIpcChannel[];

  for (const channel of channels) {
    dependencies.ipcMain.handle(channel, (_event, payload) => handlers[channel](payload, _event));
  }

  return () => {
    for (const channel of channels) {
      dependencies.ipcMain.removeHandler?.(channel);
    }
  };
}

export const installLocalIpcHandlers = registerLocalIpcHandlers;
