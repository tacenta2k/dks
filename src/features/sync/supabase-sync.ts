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
  /**
   * Idempotent write used ONLY for key/value tables (settings) where no
   * INSERT/UPDATE policy distinguishes the two operations. Entries and columns
   * are never written through it — see `writeRow`.
   */
  upsert?: (
    values: readonly Record<string, unknown>[],
    options?: { onConflict?: string },
  ) => Promise<SupabaseQueryResult>;
  /**
   * A real INSERT. Required for new entries/columns: the INSERT policy must be
   * evaluated for an actual insert and nothing else.
   */
  insert?: (values: readonly Record<string, unknown>[]) => Promise<SupabaseQueryResult>;
  /**
   * A real UPDATE. Required for rows that already exist: an upsert would make
   * PostgreSQL re-run the INSERT policy's WITH CHECK on the UPDATE branch,
   * which is what produced the Office "new row violates row-level security
   * policy for table entries" error for edits and soft deletes of rows created
   * by another account.
   */
  update?: (values: Record<string, unknown>) => {
    eq: (column: string, value: string) => Promise<SupabaseQueryResult>;
  };
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
  /**
   * Adopt the server's column id for a local duplicate and rewrite the entry
   * JSON keys that referenced the old id (R3 batch B). Optional so older
   * adapters and test doubles stay source-compatible.
   */
  rekeyColumn?: (oldId: string, newId: string) => Promise<void> | void;
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

/**
 * R3 batch B — two accounts can end up with the same column name under
 * different ids (a fresh local database, a re-created column, or a column that
 * an administrator deleted remotely and that Office therefore cannot see).
 * `app_columns.name` is unique in Postgres, so the insert fails with
 *   23505 duplicate key value violates unique constraint "app_columns_name_key".
 */
export function isDuplicateColumnNameError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('app_columns_name_key')
    || (text.includes('duplicate key') && text.includes('name'))
    || (text.includes('23505') && text.includes('name'))
  );
}

export interface RemoteColumnLookup {
  id: string;
  name: string;
  type: string;
  options: Record<string, unknown>;
  deleted: boolean;
  isPrimaryExpiry: boolean;
  isPassport: boolean;
  position: number;
}

function notFoundColumnError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('could not find the function')
    || text.includes('does not exist')
    || text.includes('schema cache');
}

/**
 * Ask the server for the column that already owns a name, including rows this
 * account cannot SELECT (a soft-deleted column is invisible to Office, but it
 * still occupies the unique name). The lookup is a narrowly scoped
 * security-definer RPC — see `ARENA/sql/fix-column-sync.sql`.
 */
export async function resolveRemoteColumnByName(
  client: SupabaseDataClient,
  name: string,
): Promise<RemoteColumnLookup | null> {
  if (!client.rpc) {
    return null;
  }
  const result = await client.rpc('resolve_duplicate_column', { p_name: name });
  if (result.error) {
    const message = String(result.error.message ?? '');
    if (notFoundColumnError(message)) {
      return null;
    }
    throw new Error(message || 'Unable to look up the existing column');
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const id = stringValue(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: stringValue(record.name, name),
    type: stringValue(record.type, 'text'),
    options: asRecord(record.options) ?? {},
    deleted: record.deleted === true,
    isPrimaryExpiry: record.is_primary_expiry === true || record.isPrimaryExpiry === true,
    isPassport: record.is_passport === true || record.isPassport === true,
    position: numberValue(record.position, 0),
  };
}

/** Same type and same options → the two rows describe the same column. */
export function columnsAreSemanticallyIdentical(
  local: Record<string, unknown>,
  remote: RemoteColumnLookup,
): boolean {
  return stringValue(local.type, 'text') === remote.type
    && recordsEqual(asRecord(local.options) ?? {}, remote.options);
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
  options: { forceActive?: boolean; forInsert?: boolean; userId?: string | null } = {},
): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const updated = stringValue(source.updated_at ?? source.updatedAt, now);
  const created = stringValue(source.created_at ?? source.createdAt, updated);
  const deleted = options.forceActive ? false : row.deleted === true;
  const deletedAtRaw = source.deleted_at ?? source.deletedAt ?? null;
  const payload: Record<string, unknown> = {
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
  // The entries INSERT policy requires `created_by = auth.uid()`. Local rows
  // never persist created_by, so on a FRESH insert we stamp the authenticated
  // session explicitly instead of relying on the column default — relying on
  // the default is what left the insert failing RLS with "new row violates
  // row-level security policy". On updates we omit created_by entirely so the
  // upsert never reassigns an existing row's original creator.
  if (options.forInsert) {
    payload.created_by = uuidOrNull(options.userId);
  }
  return payload;
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
  const query = client.from(table);
  if (typeof query.upsert !== 'function') {
    throw new Error(`Unable to write ${table}: this client has no upsert path`);
  }
  const result = await query.upsert([value], { onConflict: 'id' });
  if (result.error) {
    throw new Error(result.error.message || `Unable to write ${table}`);
  }
}

/**
 * Write one row with the operation that matches its state:
 *   'insert' — the remote has never seen this row (INSERT policy applies);
 *   'update' — the remote already has it (UPDATE policies apply).
 *
 * There is deliberately NO `INSERT … ON CONFLICT DO UPDATE` fallback. An
 * upsert makes PostgreSQL evaluate the INSERT policy for rows that already
 * exist, so authorisation would depend on which half of the statement the
 * planner chose — the exact loophole that produced Office's "new row violates
 * row-level security policy for table entries". A client that cannot express a
 * plain INSERT or UPDATE is refused instead of silently widening the path.
 */
async function writeRow(
  client: SupabaseDataClient,
  table: string,
  value: Record<string, unknown>,
  mode: 'insert' | 'update',
): Promise<void> {
  const query = client.from(table);
  const id = value.id;

  if (mode === 'update') {
    if (typeof query.update !== 'function') {
      throw new Error(
        `Refusing to write ${table} without an explicit UPDATE: an upsert would re-run the INSERT policy`,
      );
    }
    const result = await query.update(value).eq('id', String(id ?? ''));
    if (result.error) {
      throw new Error(result.error.message || `Unable to write ${table}`);
    }
    return;
  }

  if (typeof query.insert !== 'function') {
    throw new Error(
      `Refusing to write ${table} without an explicit INSERT: an upsert would bypass the INSERT policy`,
    );
  }
  const result = await query.insert([value]);
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

interface ReconcileColumnOptions {
  client: SupabaseDataClient;
  local: SupabaseSyncLocal;
  column: DksLocalColumn;
  payload: Record<string, unknown>;
  now: () => string;
  bookkeeping: Bookkeeping;
  conflicts: SupabaseConflict[];
  errors: string[];
}

/**
 * R3 batch B — recover from `duplicate key … app_columns_name_key`.
 *
 * The name is already taken by a column this account cannot see (a soft-deleted
 * column is invisible to Office) or by a column created independently on two
 * machines. Instead of retrying forever:
 *
 *  - identical type + options → the rows describe the same column. Adopt the
 *    server id locally (rewriting the entry JSON keys), push the local values
 *    onto that row and acknowledge the queued operation.
 *  - different type/options → both versions are kept. The conflict is recorded
 *    for an administrator, and the item keeps a readable reason instead of a
 *    raw constraint error. Nothing is renamed or deleted automatically.
 *
 * Returns 'synced' when the item was fully reconciled, 'reported' when a
 * precise, actionable reason has already been stored for the item (so the
 * caller must not overwrite it with the raw constraint error), and
 * 'unhandled' when the failure should keep its original message.
 */
async function reconcileDuplicateColumnName({
  client,
  local,
  column,
  payload,
  now,
  bookkeeping,
  conflicts,
  errors,
}: ReconcileColumnOptions): Promise<'synced' | 'reported' | 'unhandled'> {
  let remote: RemoteColumnLookup | null = null;
  try {
    remote = await resolveRemoteColumnByName(client, column.name);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await bookkeeping.markFailed(
      'column',
      column.id,
      `A column named "${column.name}" already exists on the server but could not be inspected: ${message}`,
    );
    errors.push(`Column ${column.name}: ${message}`);
    return 'reported';
  }

  if (!remote) {
    // No lookup RPC on this project yet (the migration has not been run) —
    // keep the item and the local column, and say exactly what to do.
    await bookkeeping.markFailed(
      'column',
      column.id,
      `A column named "${column.name}" already exists in the workspace but is not visible to this account. `
        + 'Run ARENA/sql/fix-column-sync.sql in Supabase, then sync again.',
    );
    errors.push(`Column ${column.name}: duplicate name on the server`);
    return 'reported';
  }

  const localRecord = column as unknown as Record<string, unknown>;
  const identical = columnsAreSemanticallyIdentical(localRecord, remote);
  const conflict: SupabaseConflict = {
    entityType: 'column',
    entityId: column.id,
    local: localRecord,
    remote: {
      id: remote.id,
      name: remote.name,
      type: remote.type,
      options: remote.options,
      deleted: remote.deleted,
      updated_at: now(),
    },
    winner: identical ? 'remote' : 'local',
    createdAt: now(),
  };
  conflicts.push(conflict);
  await local.recordConflict?.(conflict);

  if (!identical) {
    await bookkeeping.markFailed(
      'column',
      column.id,
      `"${column.name}" already exists on the server with a different type or options `
        + `(local ${stringValue(localRecord.type, 'text')} vs server ${remote.type}). `
        + 'Both versions are kept; an administrator must rename or delete one of them.',
    );
    errors.push(`Column ${column.name}: conflicting definition on the server`);
    return 'reported';
  }

  // Same column under two ids: adopt the server id so the database's unique
  // name and every entry that referenced the old id agree.
  if (local.rekeyColumn && column.id !== remote.id) {
    try {
      await local.rekeyColumn(column.id, remote.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await bookkeeping.markFailed('column', column.id, `Unable to reconcile the column id: ${message}`);
      errors.push(`Column ${column.name}: ${message}`);
      return 'reported';
    }
  }

  try {
    await writeRow(client, 'app_columns', { ...payload, id: remote.id }, 'update');
  } catch (caught) {
    const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
    await bookkeeping.markFailed('column', column.id, message);
    errors.push(`Column ${column.name}: ${message}`);
    return 'reported';
  }

  await bookkeeping.markSynced('column', column.id);
  return 'synced';
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
      mode: 'insert' | 'update';
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
            // A row the remote has never seen is an INSERT (created_by must be
            // stamped); a row that already exists is an UPDATE (preserve it).
            forInsert: !remote,
          }),
          softDeleted,
          requiresActiveInsert,
          mode: remote ? 'update' : 'insert',
        });
        if (requiresActiveInsert) {
          // Follow-up pass: apply the deletion on the now-existing remote row.
          // This is an UPDATE (the active insert above just created it), so do
          // not re-stamp created_by.
          entryPushes.push({
            id,
            payload: toRemoteEntry(local, now(), {
              userId: options.userId ?? null,
              forInsert: false,
            }),
            softDeleted: true,
            requiresActiveInsert: false,
            mode: 'update',
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
          await writeRow(options.client, 'entries', push.payload, push.mode);
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
    const columnPushes: {
      column: DksLocalColumn;
      remoteId?: string;
      mode: 'insert' | 'update';
    }[] = [];
    const remoteColumnsToApply: Record<string, unknown>[] = [];

    // R3 batch B: two local columns may share a name (a re-created column, a
    // case-only rename, …). Postgres does not allow that, so only the first is
    // pushed; the others are surfaced as a conflict instead of failing with a
    // raw unique-constraint message on every sync.
    const pushedColumnNames = new Map<string, string>();
    const duplicateLocalColumns = new Set<string>();

    for (const local of localColumns) {
      const nameKey = stringValue(local.name).trim().toLowerCase();
      const owner = nameKey ? pushedColumnNames.get(nameKey) : undefined;
      if (owner && owner !== local.id) {
        duplicateLocalColumns.add(local.id);
        const message = `Two local columns are both named "${local.name}". Only the existing column is synced; rename or delete the duplicate to resolve it.`;
        conflicts.push({
          entityType: 'column',
          entityId: local.id,
          local: local as unknown as Record<string, unknown>,
          remote: {},
          winner: 'local',
          createdAt: now(),
        });
        await options.local.recordConflict?.(conflicts[conflicts.length - 1]);
        await bookkeeping.markFailed('column', local.id, message);
        errors.push(`Column ${local.name}: ${message}`);
        continue;
      }
      if (nameKey) {
        pushedColumnNames.set(nameKey, local.id);
      }
      const remote = remoteColumnById.get(local.id)
        ?? remoteColumnByName.get(nameKey);
      if (!remote) {
        columnPushes.push({ column: local, mode: 'insert' });
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
        // app_columns has no created_by clause on UPDATE, but the same
        // insert-vs-update split keeps a row created by another account
        // editable by both roles.
        columnPushes.push({ column: local, remoteId, mode: 'update' });
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
      const name = stringValue(remote.name).trim().toLowerCase();
      if (!localColumns.some((column) => stringValue(column.name).trim().toLowerCase() === name)) {
        remoteColumnsToApply.push(toLocalColumn(remote));
      }
    }

    /**
     * R3 batch B — pull the shared column definitions BEFORE pushing any new
     * local column. Office used to push first, so a column that already
     * existed on the server (created by Admin, or deleted by Admin) collided
     * with the unique name and the item failed forever. Pulling first means a
     * shared column is adopted locally instead of being inserted again.
     */
    if (remoteColumnsToApply.length > 0) {
      if (!options.local.applyRemoteSnapshot) {
        throw new Error('The local cache cannot apply remote records');
      }
      await options.local.applyRemoteSnapshot({ rows: [], columns: remoteColumnsToApply });
      appliedColumns = remoteColumnsToApply.length;
      remoteColumnsToApply.length = 0;
    }

    for (const { column, remoteId, mode } of columnPushes) {
      const payload = toRemoteColumn(column, now(), remoteId);
      if (mode === 'update' && remoteId) {
        payload.id = remoteId;
      }
      try {
        await writeRow(options.client, 'app_columns', payload, mode);
        pushedColumns += 1;
        await bookkeeping.markSynced('column', column.id);
      } catch (caught) {
        const rawMessage = caught instanceof Error ? caught.message : String(caught);
        const message = sanitizeSyncError(rawMessage);
        if (mode === 'insert' && isDuplicateColumnNameError(rawMessage)) {
          const reconciled = await reconcileDuplicateColumnName({
            client: options.client,
            local: options.local,
            column,
            payload,
            now,
            bookkeeping,
            conflicts,
            errors,
          });
          if (reconciled === 'synced') {
            pushedColumns += 1;
            continue;
          }
          if (reconciled === 'reported') {
            // A precise, actionable reason is already stored for this item;
            // keep it instead of replacing it with the raw constraint text.
            continue;
          }
        }
        await bookkeeping.markFailed('column', column.id, message);
        errors.push(`Column ${column.name}: ${message}`);
      }
    }

    // Apply authoritative remote changes to the local cache -----------------
    if (remoteRowsToApply.length > 0 && !options.local.applyRemoteSnapshot) {
      throw new Error('The local cache cannot apply remote records');
    }
    if (options.local.applyRemoteSnapshot && remoteRowsToApply.length > 0) {
      await options.local.applyRemoteSnapshot({ rows: remoteRowsToApply, columns: [] });
      appliedEntries = remoteRowsToApply.length;
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
