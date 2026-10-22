import { sanitizeSyncError } from '../../lib/sync-error';
import type {
  DksLocalColumn,
  DksLocalRow,
  DksLocalSnapshot,
  DksLocalSyncState,
} from '../../lib/types';

export interface SupabaseQueryError {
  message: string;
}

export interface SupabaseQueryResult {
  data: readonly unknown[] | null;
  error: SupabaseQueryError | null;
}

export interface SupabaseTableQuery {
  select: (columns: string) => Promise<SupabaseQueryResult>;
  upsert: (
    values: readonly Record<string, unknown>[],
    options?: { onConflict?: string },
  ) => Promise<SupabaseQueryResult>;
  delete?: () => {
    eq: (column: string, value: string) => Promise<SupabaseQueryResult>;
  };
}

export interface SupabaseDataClient {
  from: (table: string) => SupabaseTableQuery;
  rpc?: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: SupabaseQueryError | null }>;
}

export interface SupabaseOutboxItem {
  id: number | string;
  idempotencyKey?: string;
  idempotency_key?: string;
  operation: string;
  entityType?: string;
  entity_type?: string;
  entityId?: string;
  entity_id?: string;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  last_error?: string | null;
  createdAt?: string;
  created_at?: string;
}

export interface SupabaseSyncLocal {
  getSnapshot: () => Promise<DksLocalSnapshot>;
  setSyncStatus: (state: Partial<DksLocalSyncState> & Pick<DksLocalSyncState, 'status'>) => Promise<DksLocalSyncState>;
  applyRemoteSnapshot?: (input: {
    rows: readonly Record<string, unknown>[];
    columns: readonly Record<string, unknown>[];
  }) => Promise<DksLocalSnapshot>;
  acknowledgeOutbox?: () => Promise<DksLocalSyncState>;
  recordConflict?: (conflict: SupabaseConflict) => Promise<void>;
  /** Optional fine-grained outbox bookkeeping (pending change list). */
  listOutbox?: (input?: { status?: string }) => Promise<SupabaseOutboxItem[]>;
  markOutboxSynced?: (id: number | string) => Promise<void> | void;
  markOutboxFailed?: (id: number | string, message: string) => Promise<void> | void;
  retryFailedOutbox?: () => Promise<number> | number;
}

export interface SupabaseConflict {
  entityType: 'entry' | 'column';
  entityId: string;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  winner: 'local' | 'remote';
  createdAt: string;
}

export interface SupabaseSyncOptions {
  client: SupabaseDataClient;
  local: SupabaseSyncLocal;
  now?: () => string;
  /**
   * Authenticated profile id. Sent as `deleted_by` for soft deletes so the
   * remote row-level policy (`deleted_by = auth.uid()`) accepts the write.
   */
  userId?: string | null;
}

export interface SupabaseSyncResult {
  status: 'healthy' | 'error';
  pushedEntries: number;
  pushedColumns: number;
  appliedEntries: number;
  appliedColumns: number;
  deletedRemotely: number;
  conflicts: SupabaseConflict[];
  errors: string[];
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Remote uuid foreign keys must be a uuid or null; never a display string. */
function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && isUuid(value) ? value : null;
}

function updatedAt(value: Record<string, unknown>): string | null {
  const candidate = value.updated_at ?? value.updatedAt;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

function timestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function localWins(local: Record<string, unknown>, remote: Record<string, unknown>): boolean {
  const localTime = timestamp(updatedAt(local));
  const remoteTime = timestamp(updatedAt(remote));
  if (localTime !== null && remoteTime !== null) {
    return localTime > remoteTime;
  }
  return (updatedAt(local) ?? '') > (updatedAt(remote) ?? '');
}

function remoteWins(local: Record<string, unknown>, remote: Record<string, unknown>): boolean {
  return !localWins(local, remote);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonical((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  } catch {
    return false;
  }
}

/**
 * Compare only business content.  The local and remote shapes differ in book-
 * keeping columns (created_by, camelCase mirrors, …); treating those as a
 * difference would fabricate a conflict for every row on every sync.
 */
function entryContentEqual(local: Record<string, unknown>, remote: Record<string, unknown>): boolean {
  const localDeletedAt = local.deleted_at ?? local.deletedAt ?? null;
  const remoteDeletedAt = remote.deleted_at ?? remote.deletedAt ?? null;
  return JSON.stringify(canonical({
    data: asRecord(local.data) ?? {},
    category: stringValue(local.category, 'Employee'),
    deleted: local.deleted === true,
  })) === JSON.stringify(canonical({
    data: asRecord(remote.data) ?? {},
    category: stringValue(remote.category, 'Employee'),
    deleted: remote.deleted === true,
  }))
    && (localDeletedAt === null || remoteDeletedAt === null
      ? localDeletedAt === remoteDeletedAt
      : timestamp(typeof localDeletedAt === 'string' ? localDeletedAt : null)
        === timestamp(typeof remoteDeletedAt === 'string' ? remoteDeletedAt : null));
}

function columnContentEqual(local: Record<string, unknown>, remote: Record<string, unknown>): boolean {
  return JSON.stringify(canonical({
    name: stringValue(local.name),
    type: stringValue(local.type, 'text'),
    options: asRecord(local.options) ?? {},
    position: numberValue(local.position, 0),
    visible: local.visible !== false,
    is_primary_expiry: local.is_primary_expiry === true || local.isPrimaryExpiry === true,
    is_passport: local.is_passport === true || local.isPassport === true,
    deleted: local.deleted === true,
  })) === JSON.stringify(canonical({
    name: stringValue(remote.name),
    type: stringValue(remote.type, 'text'),
    options: asRecord(remote.options) ?? {},
    position: numberValue(remote.position, 0),
    visible: remote.visible !== false,
    is_primary_expiry: remote.is_primary_expiry === true,
    is_passport: remote.is_passport === true,
    deleted: remote.deleted === true,
  }));
}

function localRows(snapshot: DksLocalSnapshot): DksLocalRow[] {
  return [
    ...(snapshot.rows ?? snapshot.activeRows ?? []),
    ...(snapshot.deletedRows ?? []),
  ];
}

function outboxItemParts(item: SupabaseOutboxItem): {
  id: number | string;
  idempotencyKey: string;
  operation: string;
  entityType: string;
  entityId: string;
  status: string;
} {
  return {
    id: item.id,
    idempotencyKey: stringValue(item.idempotencyKey ?? item.idempotency_key, String(item.id)),
    operation: stringValue(item.operation),
    entityType: stringValue(item.entityType ?? item.entity_type),
    entityId: stringValue(item.entityId ?? item.entity_id),
    status: stringValue(item.status, 'pending'),
  };
}

function toRemoteEntry(
  row: DksLocalRow,
  now: string,
  options: { forceActive?: boolean; userId?: string | null } = {},
): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const updated = stringValue(source.updated_at ?? source.updatedAt, now);
  const created = stringValue(source.created_at ?? source.createdAt, updated);
  const deleted = options.forceActive ? false : row.deleted === true;
  const deletedAtRaw = source.deleted_at ?? source.deletedAt ?? null;
  return {
    id: row.id,
    data: row.data,
    // The remote schema still constrains category to its seeded values until
    // the reviewed migration is applied; map anything else to the default so
    // a sync can never be rejected by that check.
    category: ['Employee', 'Family', 'Client'].includes(stringValue(row.category))
      ? stringValue(row.category)
      : 'Employee',
    deleted,
    deleted_at: deleted ? (typeof deletedAtRaw === 'string' ? deletedAtRaw : updated) : null,
    deleted_by: deleted ? uuidOrNull(source.deleted_by ?? source.deletedBy ?? options.userId) : null,
    version: numberValue(source.version, 1),
    created_at: created,
    updated_at: updated,
    updated_by: uuidOrNull(source.updated_by ?? source.updatedBy ?? options.userId),
  };
}

function toLocalEntry(remote: Record<string, unknown>): Record<string, unknown> {
  return {
    ...remote,
    id: stringValue(remote.id),
    data: asRecord(remote.data) ?? {},
    category: stringValue(remote.category, 'Employee'),
    deleted: booleanValue(remote.deleted),
    deleted_at: remote.deleted_at ?? null,
    updated_at: stringValue(remote.updated_at ?? remote.updatedAt),
    created_at: stringValue(remote.created_at ?? remote.createdAt),
  };
}

function toRemoteColumn(
  column: DksLocalColumn,
  now: string,
  remoteId?: string,
): Record<string, unknown> {
  const source = column as unknown as Record<string, unknown>;
  const updated = stringValue(source.updated_at ?? source.updatedAt, now);
  return {
    ...(remoteId || isUuid(column.id) ? { id: remoteId ?? column.id } : {}),
    name: column.name,
    type: column.type,
    options: column.options ?? {},
    position: column.position ?? 0,
    visible: column.visible !== false,
    is_primary_expiry: column.is_primary_expiry === true || column.isPrimaryExpiry === true,
    is_passport: column.is_passport === true || column.isPassport === true,
    deleted: column.deleted === true,
    deleted_at: source.deleted_at ?? null,
    updated_at: updated,
  };
}

function toLocalColumn(remote: Record<string, unknown>, localId?: string): Record<string, unknown> {
  return {
    ...remote,
    id: localId ?? stringValue(remote.id),
    name: stringValue(remote.name),
    type: stringValue(remote.type, 'text'),
    options: asRecord(remote.options) ?? {},
    position: numberValue(remote.position, 0),
    visible: booleanValue(remote.visible, true),
    is_primary_expiry: booleanValue(remote.is_primary_expiry ?? remote.isPrimaryExpiry),
    is_passport: booleanValue(remote.is_passport ?? remote.isPassport),
    deleted: booleanValue(remote.deleted),
    updated_at: stringValue(remote.updated_at ?? remote.updatedAt),
  };
}

async function selectTable(client: SupabaseDataClient, table: string): Promise<Record<string, unknown>[]> {
  const result = await client.from(table).select('*');
  if (result.error) {
    throw new Error(result.error.message || `Unable to read ${table}`);
  }
  return (result.data ?? [])
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => value !== null);
}

async function upsertRow(
  client: SupabaseDataClient,
  table: string,
  value: Record<string, unknown>,
): Promise<void> {
  const result = await client.from(table).upsert([value], { onConflict: 'id' });
  if (result.error) {
    throw new Error(result.error.message || `Unable to write ${table}`);
  }
}

/**
 * Permanently delete one entry in Supabase.  The guarded RPC enforces the
 * administrator rule server-side; the direct DELETE remains only as a
 * compatibility path for clients predating the RPC.
 */
async function permanentlyDeleteRemote(client: SupabaseDataClient, entryId: string): Promise<void> {
  if (client.rpc) {
    const result = await client.rpc('permanently_delete_entry', { p_entry_id: entryId });
    if (result.error) {
      throw new Error(result.error.message || 'Unable to permanently delete the entry remotely');
    }
    return;
  }

  const query = client.from('entries').delete?.();
  if (!query) {
    throw new Error('Permanent deletion is not supported by this sync client');
  }
  const result = await query.eq('id', entryId);
  if (result.error) {
    throw new Error(result.error.message || 'Unable to permanently delete the entry remotely');
  }
}

interface Bookkeeping {
  markSynced: (entityType: string, entityId: string) => Promise<void>;
  markFailed: (entityType: string, entityId: string, message: string) => Promise<void>;
  unconsumed: () => SupabaseOutboxItem[];
}

function createBookkeeping(
  options: SupabaseSyncOptions,
  items: SupabaseOutboxItem[],
): Bookkeeping {
  const pendingByKey = new Map<string, SupabaseOutboxItem[]>();
  const consumedIds = new Set<number | string>();

  for (const item of items) {
    const parts = outboxItemParts(item);
    if (parts.status === 'synced') {
      continue;
    }
    const key = `${parts.entityType}:${parts.entityId}`;
    const bucket = pendingByKey.get(key) ?? [];
    bucket.push(item);
    pendingByKey.set(key, bucket);
  }

  const markSynced = async (entityType: string, entityId: string): Promise<void> => {
    const bucket = pendingByKey.get(`${entityType}:${entityId}`) ?? [];
    for (const item of bucket) {
      consumedIds.add(item.id);
      await options.local.markOutboxSynced?.(item.id);
    }
  };

  const markFailed = async (entityType: string, entityId: string, message: string): Promise<void> => {
    // Defence in depth: the outbox is the long-lived store of per-item
    // failure reasons; never persist a raw (possibly credential-bearing)
    // message even if a future caller forgets to sanitise.
    const safe = sanitizeSyncError(message) || message;
    const bucket = pendingByKey.get(`${entityType}:${entityId}`) ?? [];
    for (const item of bucket) {
      consumedIds.add(item.id);
      await options.local.markOutboxFailed?.(item.id, safe);
    }
  };

  return {
    markSynced,
    markFailed,
    unconsumed: () => items.filter((item) => !consumedIds.has(item.id) && outboxItemParts(item).status !== 'synced'),
  };
}

export async function runSupabaseSync(options: SupabaseSyncOptions): Promise<SupabaseSyncResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const errors: string[] = [];
  const conflicts: SupabaseConflict[] = [];
  let pushedEntries = 0;
  let pushedColumns = 0;
  let appliedEntries = 0;
  let appliedColumns = 0;
  let deletedRemotely = 0;

  try {
    const snapshot = await options.local.getSnapshot();
    const outboxItems = options.local.listOutbox
      ? await options.local.listOutbox({ status: 'all' })
      : [];
    await options.local.setSyncStatus({
      status: 'syncing',
      pendingCount: snapshot.syncStatus.pendingCount,
      lastError: null,
    });
    // Re-queue previously failed operations so a retry is automatic and
    // idempotent (outbox keys prevent duplicates).
    await options.local.retryFailedOutbox?.();

    const bookkeeping = createBookkeeping(options, outboxItems);
    const permanentDeleteIds = new Set(
      outboxItems
        .map(outboxItemParts)
        .filter((parts) => (
          parts.operation === 'permanent_delete'
          && parts.entityType === 'entry'
          && parts.status !== 'synced'
        ))
        .map((parts) => parts.entityId),
    );

    // Phase 0: propagate queued permanent deletions before any reconciliation
    // so a locally deleted record cannot be resurrected from the remote copy.
    for (const entryId of permanentDeleteIds) {
      try {
        await permanentlyDeleteRemote(options.client, entryId);
        await bookkeeping.markSynced('entry', entryId);
        deletedRemotely += 1;
      } catch (caught) {
        const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
        await bookkeeping.markFailed('entry', entryId, message);
        errors.push(`Permanently delete ${entryId}: ${message}`);
      }
    }

    const [remoteEntries, remoteColumns] = await Promise.all([
      selectTable(options.client, 'entries'),
      selectTable(options.client, 'app_columns'),
    ]);

    const localEntryMap = new Map(localRows(snapshot).map((row) => [row.id, row]));
    const remoteEntryMap = new Map(remoteEntries
      .filter((row) => stringValue(row.id) && !permanentDeleteIds.has(stringValue(row.id)))
      .map((row) => [stringValue(row.id), row]));

    interface EntryPush {
      id: string;
      payload: Record<string, unknown>;
      softDeleted: boolean;
      requiresActiveInsert: boolean;
    }
    const entryPushes: EntryPush[] = [];
    const remoteRowsToApply: Record<string, unknown>[] = [];

    for (const id of new Set([...localEntryMap.keys(), ...remoteEntryMap.keys()])) {
      const local = localEntryMap.get(id);
      const remote = remoteEntryMap.get(id);
      const localRecord = local as unknown as Record<string, unknown> | undefined;

      if (!isUuid(id)) {
        if (local) {
          const message = `entry ${id} has a local id that is not a UUID and cannot be stored in Supabase`;
          await bookkeeping.markFailed('entry', id, message);
          errors.push(message);
        }
        continue;
      }

      if (localRecord && remote && !entryContentEqual(localRecord, remote)) {
        const conflict: SupabaseConflict = {
          entityType: 'entry',
          entityId: id,
          local: localRecord,
          remote,
          winner: localWins(localRecord, remote) ? 'local' : 'remote',
          createdAt: now(),
        };
        conflicts.push(conflict);
        await options.local.recordConflict?.(conflict);
      }

      if (local && (!remote || localWins(localRecord!, remote))) {
        const softDeleted = local.deleted === true;
        const requiresActiveInsert = softDeleted && !remote;
        entryPushes.push({
          id,
          payload: toRemoteEntry(local, now(), {
            userId: options.userId ?? null,
            forceActive: requiresActiveInsert,
          }),
          softDeleted,
          requiresActiveInsert,
        });
        if (requiresActiveInsert) {
          // Follow-up pass: apply the deletion on the now-existing remote row.
          entryPushes.push({
            id,
            payload: toRemoteEntry(local, now(), { userId: options.userId ?? null }),
            softDeleted: true,
            requiresActiveInsert: false,
          });
        }
      } else if (remote && (!local || remoteWins(localRecord!, remote))) {
        remoteRowsToApply.push(toLocalEntry(remote));
        // The server version is authoritative and is applied to the local
        // cache; the queued mutation for this entity is resolved by that
        // outcome (the conflict above is recorded). Columns already consume
        // their queue in the equivalent branch — without this, superseded
        // outbox items stayed pending forever and the pending count only
        // ever grew.
        await bookkeeping.markSynced('entry', id);
      } else if (local && remote) {
        // Identical business content: any queued mutation for this entity has
        // already reached the server.
        await bookkeeping.markSynced('entry', id);
      }
    }

    // Phase 1: upsert entries one at a time so a single rejected row cannot
    // block unrelated changes (the previous batch upsert failed wholesale).
    // Group pushes per entry: a locally soft-deleted row that the server has
    // never seen must be inserted as an active row first (the remote insert
    // policy rejects rows that are already deleted), then marked deleted.
    const pushesByEntry = new Map<string, EntryPush[]>();
    for (const push of entryPushes) {
      const bucket = pushesByEntry.get(push.id) ?? [];
      bucket.push(push);
      pushesByEntry.set(push.id, bucket);
    }

    for (const [id, pushes] of pushesByEntry) {
      let succeeded = true;
      for (const push of pushes) {
        try {
          await upsertRow(options.client, 'entries', push.payload);
        } catch (caught) {
          const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
          succeeded = false;
          await bookkeeping.markFailed('entry', id, message);
          errors.push(`Row ${id}: ${message}`);
          break;
        }
      }
      if (succeeded) {
        pushedEntries += 1;
        await bookkeeping.markSynced('entry', id);
      }
    }

    // Columns ---------------------------------------------------------------
    const localColumns = [...(snapshot.columns ?? []), ...(snapshot.deletedColumns ?? [])];
    const localColumnById = new Map(localColumns.map((column) => [column.id, column]));
    const remoteColumnById = new Map(remoteColumns
      .filter((column) => stringValue(column.id))
      .map((column) => [stringValue(column.id), column]));
    const remoteColumnByName = new Map(remoteColumns
      .filter((column) => stringValue(column.name))
      .map((column) => [stringValue(column.name).toLowerCase(), column]));
    const consumedRemoteColumnIds = new Set<string>();
    const columnPushes: { column: DksLocalColumn; remoteId?: string }[] = [];
    const remoteColumnsToApply: Record<string, unknown>[] = [];

    for (const local of localColumns) {
      const remote = remoteColumnById.get(local.id)
        ?? remoteColumnByName.get(local.name.toLowerCase());
      if (!remote) {
        columnPushes.push({ column: local });
        continue;
      }
      const remoteId = stringValue(remote.id);
      if (remoteId) {
        consumedRemoteColumnIds.add(remoteId);
      }
      const localRecord = local as unknown as Record<string, unknown>;
      if (!columnContentEqual(localRecord, remote)) {
        const conflict: SupabaseConflict = {
          entityType: 'column',
          entityId: local.id,
          local: localRecord,
          remote,
          winner: localWins(localRecord, remote) ? 'local' : 'remote',
          createdAt: now(),
        };
        conflicts.push(conflict);
        await options.local.recordConflict?.(conflict);
      }
      if (localWins(localRecord, remote)) {
        columnPushes.push({ column: local, remoteId });
      } else {
        remoteColumnsToApply.push(toLocalColumn(remote, local.id));
        await bookkeeping.markSynced('column', local.id);
      }
    }

    for (const remote of remoteColumns) {
      const remoteId = stringValue(remote.id);
      if (remoteId && consumedRemoteColumnIds.has(remoteId)) {
        continue;
      }
      const name = stringValue(remote.name).toLowerCase();
      if (name && localColumnById.has(name)) {
        continue;
      }
      if (!localColumns.some((column) => column.name.toLowerCase() === name)) {
        remoteColumnsToApply.push(toLocalColumn(remote));
      }
    }

    for (const { column, remoteId } of columnPushes) {
      try {
        await upsertRow(options.client, 'app_columns', toRemoteColumn(column, now(), remoteId));
        pushedColumns += 1;
        await bookkeeping.markSynced('column', column.id);
      } catch (caught) {
        const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
        await bookkeeping.markFailed('column', column.id, message);
        errors.push(`Column ${column.name}: ${message}`);
      }
    }

    // Apply authoritative remote changes to the local cache -----------------
    if ((remoteRowsToApply.length > 0 || remoteColumnsToApply.length > 0)
      && !options.local.applyRemoteSnapshot) {
      throw new Error('The local cache cannot apply remote records');
    }
    if (options.local.applyRemoteSnapshot && (remoteRowsToApply.length > 0 || remoteColumnsToApply.length > 0)) {
      await options.local.applyRemoteSnapshot({
        rows: remoteRowsToApply,
        columns: remoteColumnsToApply,
      });
      appliedEntries = remoteRowsToApply.length;
      appliedColumns = remoteColumnsToApply.length;
    }

    // Settings --------------------------------------------------------------
    // Settings changes queue outbox rows just like entries and columns, but
    // previously only a one-shot save in the renderer could clear them — if
    // that attempt failed (offline, auth hiccup) the items stayed pending
    // forever and the pending count only grew. The sync loop now retries them
    // idempotently: it pushes the CURRENT local settings record for every key
    // with queued changes, so a retry always uploads the latest local state
    // and never loses an edit.
    const settingsItems = outboxItems
      .map(outboxItemParts)
      .filter((parts) => parts.entityType === 'settings' && parts.status !== 'synced');
    if (settingsItems.length > 0) {
      const localSettings = (snapshot.settings ?? {}) as Record<string, unknown>;
      const keys = new Set(settingsItems.map((parts) => parts.entityId));
      try {
        for (const key of keys) {
          // Push the CURRENT local value; when the key is no longer stored
          // locally the queued change is still represented as an explicit null.
          const value = key in localSettings ? localSettings[key] : null;
          await upsertRow(options.client, 'settings', { key, value });
        }
        for (const parts of settingsItems) {
          await bookkeeping.markSynced('settings', parts.entityId);
        }
      } catch (caught) {
        const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
        for (const parts of settingsItems) {
          await bookkeeping.markFailed('settings', parts.entityId, message);
        }
        errors.push(`Settings: ${message}`);
      }
    }

    // Final status ----------------------------------------------------------
    const remaining = bookkeeping.unconsumed();
    const unsyncedCount = remaining.length;

    if (errors.length === 0 && unsyncedCount === 0) {
      const acknowledged = options.local.acknowledgeOutbox
        ? await options.local.acknowledgeOutbox()
        : await options.local.setSyncStatus({
          status: 'healthy',
          lastSyncAt: now(),
          lastError: null,
          pendingCount: 0,
        });
      if (acknowledged.status !== 'healthy') {
        await options.local.setSyncStatus({
          status: 'healthy',
          lastSyncAt: now(),
          lastError: null,
          pendingCount: acknowledged.pendingCount,
        });
      }
      return {
        status: 'healthy',
        pushedEntries,
        pushedColumns,
        appliedEntries,
        appliedColumns,
        deletedRemotely,
        conflicts,
        errors,
      };
    }

    // Never clear pending operations just to make the indicator look healthy.
    const firstError = errors[0] ?? 'Some pending changes have not synchronised yet';
    await options.local.setSyncStatus({
      status: 'error',
      lastError: firstError,
    });
    return {
      status: 'error',
      pushedEntries,
      pushedColumns,
      appliedEntries,
      appliedColumns,
      deletedRemotely,
      conflicts,
      errors,
      error: firstError,
    };
  } catch (caught) {
    const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
    errors.push(message);
    await options.local.setSyncStatus({ status: 'error', lastError: message }).catch(() => undefined);
    return {
      status: 'error',
      pushedEntries,
      pushedColumns,
      appliedEntries,
      appliedColumns,
      deletedRemotely,
      conflicts,
      errors,
      error: message,
    };
  }
}

export const syncWithSupabase = runSupabaseSync;
