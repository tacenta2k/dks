import { sanitizeSyncError } from '../../lib/sync-error';
import type {
  DksLocalColumn,
  DksLocalRow,
  DksLocalSnapshot,
  DksLocalSyncState,
} from '../../lib/types';

export interface SupabaseQueryError {
  message: string;
  code?: string;
}

export interface SupabaseQueryResult {
  data: readonly unknown[] | null;
  error: SupabaseQueryError | null;
  /** PostgREST exact affected-row count; no returned row data is required. */
  count?: number | null;
}

/**
 * A `select()` builder that can be walked page by page.
 *
 * PostgREST truncates a single response at `db-max-rows` (1000 by default), so
 * an unpaginated `select('*')` silently caps the local cache. Everything that
 * reads a whole table goes through `selectTable`, which walks these pages.
 */
export interface SupabaseSelectQuery extends PromiseLike<SupabaseQueryResult> {
  order: (column: string, options?: { ascending?: boolean }) => SupabaseSelectQuery;
  range: (from: number, to: number) => SupabaseSelectQuery;
}

export interface SupabaseTableQuery {
  select: (columns: string) => Promise<SupabaseQueryResult> | SupabaseSelectQuery;
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
  update?: (values: Record<string, unknown>, options?: { count: 'exact' }) => {
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
  markOutboxTerminal?: (id: number | string, message: string) => Promise<void> | void;
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
  /** Rechecked after every await so revocation stops further writes/acks. */
  isSessionAllowed?: () => boolean;
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

/**
 * v0.1.8 — local purge of a column the server no longer returns.
 *
 * Reached only from the `app_columns_pkey` path, i.e. on POSITIVE proof: the
 * server just told us a row with this exact id exists, yet the SELECT a moment
 * ago did not return it. Under the SELECT policy
 *   using (is_admin() or (not deleted and is_office() and office_session_is_approved()))
 * and with sync running only for a cleared session, the one reason a row can
 * exist and be invisible is that it is soft-deleted — an administrator deleted
 * the column. The local copy is soft-deleted to match (nothing is hard-deleted;
 * entry values are untouched, exactly as on the server).
 *
 * Safeguards:
 *  - an EMPTY column list is never treated as proof (a transient/unauthorised
 *    SELECT returns nothing at all), so nothing is purged in that case;
 *  - the column's own `updated_at` is kept, so if this were ever wrong the
 *    server copy (equal or newer) wins last-write-wins on the next sync and the
 *    column is restored locally — a purge can never be pushed as a delete;
 *  - applied through the remote path, so it creates no outbox echo.
 */
async function purgeServerDeletedColumn(
  options: SupabaseSyncOptions,
  column: DksLocalColumn,
  remoteColumnCount: number,
  now: () => string,
): Promise<boolean> {
  if (column.deleted === true || remoteColumnCount === 0 || !options.local.applyRemoteSnapshot) {
    return false;
  }
  try {
    const source = column as unknown as Record<string, unknown>;
    const keptUpdatedAt = stringValue(source.updated_at ?? source.updatedAt) || undefined;
    const record = toLocalColumn({
      ...toRemoteColumn(column, now()),
      deleted: true,
      deleted_at: now(),
      ...(keptUpdatedAt ? { updated_at: keptUpdatedAt } : {}),
    }, column.id);
    await options.local.applyRemoteSnapshot({ rows: [], columns: [record] });
    console.info('[sync] A column deleted by an administrator was removed from this device.');
    return true;
  } catch {
    // Best effort: the column simply stays visible until the next sync.
    return false;
  }
}

/**
 * v0.1.7 — the column's OWN id already exists on the server:
 *   23505 duplicate key value violates unique constraint "app_columns_pkey".
 *
 * The SELECT policy hides soft-deleted columns from Office, so a column an
 * administrator deleted looks "missing" to the Office sync and is re-INSERTed
 * under the same id on every run. The row demonstrably already exists, so the
 * create is treated as done (an UPDATE by id is attempted instead) rather than
 * leaving a permanent error in the sync status pill.
 *
 * Name-key duplicates are deliberately excluded — they mean a DIFFERENT row
 * owns the name and are reconciled by `reconcileDuplicateColumnName`. Other
 * unique indexes (e.g. `one_primary_expiry_column`) are not matched either.
 */
export function isDuplicateColumnIdError(message: string, code?: string | null): boolean {
  const text = message.toLowerCase();
  if (isDuplicateColumnNameError(message)) return false;
  if (text.includes('app_columns_pkey')) return true;
  const duplicate = code === '23505' || text.includes('duplicate key') || text.includes('23505');
  return duplicate && (text.includes('_pkey') || text.includes('key (id)'));
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

/** Rows requested per page — deliberately below the PostgREST default cap. */
export const PULL_PAGE_SIZE = 500;
/** Hard stop, so a broken cursor can never walk forever. */
export const MAX_PULL_ROWS = 100_000;

function asRowList(data: unknown): Record<string, unknown>[] {
  return (data as unknown[] | null | undefined ?? [])
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => value !== null);
}

function isChainableSelect(value: unknown): value is SupabaseSelectQuery {
  const candidate = value as { order?: unknown; range?: unknown } | null;
  return typeof candidate?.order === 'function' && typeof candidate?.range === 'function';
}

async function readPage(
  client: SupabaseDataClient,
  table: string,
  from: number,
  size: number,
): Promise<{ rows: Record<string, unknown>[]; paginated: boolean }> {
  const query: unknown = client.from(table).select('*');
  if (!isChainableSelect(query)) {
    // A client with no range support cannot be walked. Take what it returns and
    // report that it was not paginated rather than implying completeness.
    const result = await (query as PromiseLike<SupabaseQueryResult>);
    if (result.error) throw new Error(result.error.message || `Unable to read ${table}`);
    return { rows: asRowList(result.data), paginated: false };
  }
  // `id` is unique and stable, so pages do not reshuffle under the cursor. A
  // row written while the walk is running can still shift a page boundary; the
  // reconcile step is an idempotent upsert, so a repeat row is harmless and the
  // next pull picks up anything missed.
  const result = await query.order('id', { ascending: true }).range(from, from + size - 1);
  if (result.error) throw new Error(result.error.message || `Unable to read ${table}`);
  return { rows: asRowList(result.data), paginated: true };
}

/**
 * Read a whole table, walking pages until a short page arrives.
 *
 * This is the line that decides whether the local cache — and therefore every
 * cloud backup snapshot taken from it — can claim to hold the table at all.
 */
export async function selectTable(client: SupabaseDataClient, table: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_PULL_ROWS; from += PULL_PAGE_SIZE) {
    const page = await readPage(client, table, from, PULL_PAGE_SIZE);
    rows.push(...page.rows);
    if (!page.paginated || page.rows.length < PULL_PAGE_SIZE) break;
  }
  if (rows.length >= MAX_PULL_ROWS) {
    throw new Error(`Stopped reading ${table} after ${String(MAX_PULL_ROWS)} rows`);
  }
  return rows;
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

class SyncClearanceError extends Error {
  constructor() { super('Waiting for admin approval — sync is paused.'); }
}

function requireClearance(options: SupabaseSyncOptions): void {
  if (options.isSessionAllowed && !options.isSessionAllowed()) throw new SyncClearanceError();
}

class RemoteWriteError extends Error {
  readonly code?: string;
  constructor(error: SupabaseQueryError, fallback: string) {
    super(error.message || fallback);
    this.code = error.code;
  }
}

/**
 * Plain INSERT/UPDATE only. Office UPDATE requests an exact affected-row
 * count with return=minimal; it must never chain .select() because a
 * soft-deleted row may no longer satisfy the Office SELECT policy (RLS-09).
 */
async function writeRow(
  client: SupabaseDataClient,
  table: string,
  value: Record<string, unknown>,
  mode: 'insert' | 'update',
): Promise<number | null> {
  const query = client.from(table);
  const id = value.id;

  if (mode === 'update') {
    if (typeof query.update !== 'function') {
      throw new Error(`Refusing to write ${table} without an explicit UPDATE: an upsert would re-run the INSERT policy`);
    }
    const result = await query.update(value, table === 'entries' ? { count: 'exact' } : undefined)
      .eq('id', String(id ?? ''));
    if (result.error) throw new RemoteWriteError(result.error, `Unable to write ${table}`);
    if (table === 'entries' && (typeof result.count !== 'number' || !Number.isSafeInteger(result.count) || result.count < 0)) {
      throw new Error('The server did not confirm the number of changed records; retrying.');
    }
    return result.count ?? null;
  }

  if (typeof query.insert !== 'function') {
    throw new Error(`Refusing to write ${table} without an explicit INSERT: an upsert would bypass the INSERT policy`);
  }
  const result = await query.insert([value]);
  if (result.error) throw new RemoteWriteError(result.error, `Unable to write ${table}`);
  return result.count ?? null;
}

const OFFICE_TERMINAL_MESSAGE = 'This record can no longer be changed from the Office account';

/** The RPC itself enforces approval; a failed/unknown response is retryable. */
async function entryVisibility(client: SupabaseDataClient, id: string): Promise<'visible' | 'hidden' | 'missing'> {
  if (!client.rpc) throw new Error('Entry visibility is unavailable; run ARENA/sql/entry-visibility.sql.');
  const result = await client.rpc('entry_visibility', { p_id: id });
  if (result.error) throw new RemoteWriteError(result.error, 'Unable to check record visibility.');
  const value = Array.isArray(result.data) ? result.data[0] : result.data;
  if (value !== 'visible' && value !== 'hidden' && value !== 'missing') {
    throw new Error('The server could not confirm record visibility; retrying.');
  }
  return value;
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
  pending: (entityType: string, entityId: string) => SupabaseOutboxItem[];
  markItemsSynced: (items: readonly SupabaseOutboxItem[]) => Promise<void>;
  markItemsFailed: (items: readonly SupabaseOutboxItem[], message: string) => Promise<void>;
  markItemsTerminal: (items: readonly SupabaseOutboxItem[], message: string) => Promise<void>;
  markSynced: (entityType: string, entityId: string) => Promise<void>;
  markFailed: (entityType: string, entityId: string, message: string) => Promise<void>;
  unconsumed: () => SupabaseOutboxItem[];
}

function createBookkeeping(options: SupabaseSyncOptions, items: SupabaseOutboxItem[]): Bookkeeping {
  const pendingByKey = new Map<string, SupabaseOutboxItem[]>();
  const consumedIds = new Set<number | string>();

  for (const item of items) {
    const parts = outboxItemParts(item);
    // Terminal items remain visible to the user but are never auto-retried.
    if (parts.status === 'synced' || parts.status === 'terminal') continue;
    const key = `${parts.entityType}:${parts.entityId}`;
    const bucket = pendingByKey.get(key) ?? [];
    bucket.push(item);
    pendingByKey.set(key, bucket);
  }

  const pending = (entityType: string, entityId: string): SupabaseOutboxItem[] => (
    (pendingByKey.get(`${entityType}:${entityId}`) ?? []).filter((item) => !consumedIds.has(item.id))
  );
  const markItemsSynced = async (bucket: readonly SupabaseOutboxItem[]): Promise<void> => {
    for (const item of bucket) {
      if (consumedIds.has(item.id)) continue;
      requireClearance(options);
      if (!options.local.markOutboxSynced) throw new Error('Outbox acknowledgement is unavailable.');
      await options.local.markOutboxSynced(item.id);
      consumedIds.add(item.id);
    }
  };
  const markItemsFailed = async (bucket: readonly SupabaseOutboxItem[], message: string): Promise<void> => {
    const safe = sanitizeSyncError(message) || 'The change could not be synchronised.';
    for (const item of bucket) {
      if (consumedIds.has(item.id)) continue;
      requireClearance(options);
      await options.local.markOutboxFailed?.(item.id, safe);
      consumedIds.add(item.id);
    }
  };
  const markItemsTerminal = async (bucket: readonly SupabaseOutboxItem[], message: string): Promise<void> => {
    const safe = sanitizeSyncError(message) || OFFICE_TERMINAL_MESSAGE;
    if (!options.local.markOutboxTerminal) throw new Error('Terminal outbox recording is unavailable; retrying.');
    for (const item of bucket) {
      if (consumedIds.has(item.id)) continue;
      requireClearance(options);
      await options.local.markOutboxTerminal(item.id, safe);
      consumedIds.add(item.id);
    }
  };

  return {
    pending,
    markItemsSynced,
    markItemsFailed,
    markItemsTerminal,
    markSynced: (entityType, entityId) => markItemsSynced(pending(entityType, entityId)),
    markFailed: (entityType, entityId, message) => markItemsFailed(pending(entityType, entityId), message),
    // Terminal rows are intentionally unconsumed so the status stays in error
    // with a useful, durable message rather than falsely claiming cloud sync.
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
  requireAllowed: () => void;
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
  requireAllowed,
}: ReconcileColumnOptions): Promise<'synced' | 'reported' | 'unhandled'> {
  let remote: RemoteColumnLookup | null = null;
  try {
    requireAllowed();
    remote = await resolveRemoteColumnByName(client, column.name);
    requireAllowed();
  } catch (caught) {
    if (caught instanceof SyncClearanceError) throw caught;
    requireAllowed();
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
  requireAllowed();

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
      requireAllowed();
      await local.rekeyColumn(column.id, remote.id);
      requireAllowed();
    } catch (caught) {
      if (caught instanceof SyncClearanceError) throw caught;
      requireAllowed();
      const message = caught instanceof Error ? caught.message : String(caught);
      await bookkeeping.markFailed('column', column.id, `Unable to reconcile the column id: ${message}`);
      errors.push(`Column ${column.name}: ${message}`);
      return 'reported';
    }
  }

  try {
    requireAllowed();
    await writeRow(client, 'app_columns', { ...payload, id: remote.id }, 'update');
    requireAllowed();
  } catch (caught) {
    if (caught instanceof SyncClearanceError) throw caught;
    requireAllowed();
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
    requireClearance(options);
    const snapshot = await options.local.getSnapshot();
    requireClearance(options);
    const outboxItems = options.local.listOutbox
      ? await options.local.listOutbox({ status: 'all' })
      : [];
    requireClearance(options);
    await options.local.setSyncStatus({
      status: 'syncing',
      pendingCount: snapshot.syncStatus.pendingCount,
      lastError: null,
    });
    requireClearance(options);
    // Re-queue previously failed operations so a retry is automatic and
    // idempotent (outbox keys prevent duplicates).
    await options.local.retryFailedOutbox?.();
    requireClearance(options);

    const bookkeeping = createBookkeeping(options, outboxItems);
    const permanentDeleteIds = new Set(
      outboxItems
        .map(outboxItemParts)
        .filter((parts) => (
          parts.operation === 'permanent_delete'
          && parts.entityType === 'entry'
          && parts.status !== 'synced' && parts.status !== 'terminal'
        ))
        .map((parts) => parts.entityId),
    );

    // Phase 0: propagate queued permanent deletions before any reconciliation
    // so a locally deleted record cannot be resurrected from the remote copy.
    for (const entryId of permanentDeleteIds) {
      try {
        requireClearance(options);
        await permanentlyDeleteRemote(options.client, entryId);
        requireClearance(options);
        await bookkeeping.markSynced('entry', entryId);
        deletedRemotely += 1;
      } catch (caught) {
        if (caught instanceof SyncClearanceError) throw caught;
        requireClearance(options);
        const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
        await bookkeeping.markFailed('entry', entryId, message);
        errors.push(`Permanently delete ${entryId}: ${message}`);
      }
    }

    const [remoteEntries, remoteColumns] = await Promise.all([
      selectTable(options.client, 'entries'),
      selectTable(options.client, 'app_columns'),
    ]);
    requireClearance(options);

    const localEntryMap = new Map(localRows(snapshot).map((row) => [row.id, row]));
    const remoteEntryMap = new Map(remoteEntries
      .filter((row) => stringValue(row.id) && !permanentDeleteIds.has(stringValue(row.id)))
      .map((row) => [stringValue(row.id), row]));

    const remoteRowsToApply: Record<string, unknown>[] = [];
    const terminalEntryIds = new Set(outboxItems
      .map(outboxItemParts)
      .filter((parts) => parts.entityType === 'entry' && parts.status === 'terminal')
      .map((parts) => parts.entityId));

    // The queue, not RLS-filtered SELECT visibility, decides the operation.
    // A local-only cached row with no queued create must never become INSERT.
    for (const id of new Set([...localEntryMap.keys(), ...remoteEntryMap.keys()])) {
      requireClearance(options);
      if (permanentDeleteIds.has(id)) continue;
      const local = localEntryMap.get(id);
      const remote = remoteEntryMap.get(id);
      const localRecord = local as unknown as Record<string, unknown> | undefined;
      const queued = bookkeeping.pending('entry', id);

      if (!isUuid(id)) {
        if (queued.length) {
          const message = `entry ${id} has a local id that is not a UUID and cannot be stored in Supabase`;
          await bookkeeping.markItemsFailed(queued, message);
          errors.push(message);
        }
        continue;
      }

      if (localRecord && remote && !entryContentEqual(localRecord, remote)) {
        const conflict: SupabaseConflict = {
          entityType: 'entry', entityId: id, local: localRecord, remote,
          winner: localWins(localRecord, remote) ? 'local' : 'remote', createdAt: now(),
        };
        conflicts.push(conflict);
        await options.local.recordConflict?.(conflict);
        requireClearance(options);
      }

      if (!queued.length) {
        // Never overwrite the local copy of a terminal change. Other remote
        // winners may be applied normally without producing an outbox echo.
        if (!terminalEntryIds.has(id) && remote && (!local || remoteWins(localRecord!, remote))) {
          remoteRowsToApply.push(toLocalEntry(remote));
        }
        continue;
      }
      if (!local) {
        const message = 'The queued record is missing from the local cache; it was not discarded.';
        await bookkeeping.markItemsFailed(queued, message);
        errors.push(`Row ${id}: ${message}`);
        continue;
      }

      const creates = queued.filter((item) => outboxItemParts(item).operation === 'create');
      const updates = queued.filter((item) => ['update', 'delete', 'soft_delete'].includes(outboxItemParts(item).operation));
      const unknown = queued.filter((item) => !creates.includes(item) && !updates.includes(item));
      if (unknown.length) {
        const message = 'This queued record has an unsupported operation; it was not discarded.';
        await bookkeeping.markItemsFailed(unknown, message);
        errors.push(`Row ${id}: ${message}`);
      }

      // Retain last-write-wins for conflicting updates, but never skip an
      // explicit create just because a visible remote row happens to exist.
      if (!creates.length && updates.length && !terminalEntryIds.has(id) && remote
        && !entryContentEqual(localRecord!, remote) && remoteWins(localRecord!, remote)) {
        remoteRowsToApply.push(toLocalEntry(remote));
        await bookkeeping.markItemsSynced(updates);
        continue;
      }

      let succeeded = true;
      for (const item of creates) {
        try {
          requireClearance(options);
          try {
            // A later queued deletion is represented by a separate UPDATE;
            // the INSERT policy only permits a live row.
            await writeRow(options.client, 'entries', toRemoteEntry(local, now(), {
              userId: options.userId ?? null, forInsert: true, forceActive: local.deleted === true,
            }), 'insert');
          } catch (caught) {
            if (!(caught instanceof RemoteWriteError) || caught.code !== '23505') throw caught;
            // Do not persist/log the server's raw error or any row data.
            console.info('[sync] Queued create already exists on the server; acknowledging the create.');
          }
          requireClearance(options);
          // A duplicate create acknowledges ONLY that create. Subsequent edits
          // or a soft-delete still need their own UPDATE and acknowledgement.
          await bookkeeping.markItemsSynced([item]);
        } catch (caught) {
          if (caught instanceof SyncClearanceError) throw caught;
          const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
          requireClearance(options);
          await bookkeeping.markItemsFailed(bookkeeping.pending('entry', id), message);
          errors.push(`Row ${id}: ${message}`);
          succeeded = false;
          break;
        }
      }

      if (succeeded && updates.length) {
        try {
          requireClearance(options);
          const count = await writeRow(options.client, 'entries', toRemoteEntry(local, now(), {
            userId: options.userId ?? null, forInsert: false,
          }), 'update');
          requireClearance(options);
          if (count === 0) {
            const visibility = await entryVisibility(options.client, id);
            requireClearance(options);
            if (visibility === 'hidden' || visibility === 'missing') {
              await bookkeeping.markItemsTerminal(updates, OFFICE_TERMINAL_MESSAGE);
              errors.push(OFFICE_TERMINAL_MESSAGE);
              succeeded = false;
            } else {
              throw new Error('The record is still visible but the update changed no rows; retrying.');
            }
          } else {
            await bookkeeping.markItemsSynced(updates);
          }
        } catch (caught) {
          if (caught instanceof SyncClearanceError) throw caught;
          const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
          requireClearance(options);
          await bookkeeping.markItemsFailed(bookkeeping.pending('entry', id), message);
          errors.push(`Row ${id}: ${message}`);
          succeeded = false;
        }
      }
      if (succeeded && (creates.length || updates.length)) pushedEntries += 1;
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
      requireClearance(options);
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
      if (!remote && local.deleted === true && bookkeeping.pending('column', local.id).length === 0) {
        // v0.1.8 — a locally deleted column that is not on the server and has
        // nothing queued (typically one purged below after an administrator
        // deleted it) has nothing to push. Re-INSERTing it every sync only
        // produced a 23505 round trip per column per run.
        continue;
      }
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
      requireClearance(options);
      const payload = toRemoteColumn(column, now(), remoteId);
      if (mode === 'update' && remoteId) {
        payload.id = remoteId;
      }
      try {
        await writeRow(options.client, 'app_columns', payload, mode);
        requireClearance(options);
        pushedColumns += 1;
        await bookkeeping.markSynced('column', column.id);
      } catch (caught) {
        if (caught instanceof SyncClearanceError) throw caught;
        requireClearance(options);
        const rawMessage = caught instanceof Error ? caught.message : String(caught);
        const message = sanitizeSyncError(rawMessage);
        const errorCode = caught instanceof RemoteWriteError ? caught.code : undefined;
        if (mode === 'insert' && isDuplicateColumnIdError(rawMessage, errorCode)) {
          // The create already landed on the server (typically a column that
          // an administrator soft-deleted and Office can no longer SELECT).
          // Never leave the create failing forever: push the local values as
          // a plain UPDATE by id and acknowledge the queued create. For a row
          // this account cannot see the UPDATE matches nothing, which is the
          // correct no-op — the server copy stays authoritative.
          try {
            requireClearance(options);
            await writeRow(options.client, 'app_columns', payload, 'update');
            requireClearance(options);
            console.info('[sync] Queued column create already exists on the server; acknowledging the create.');
            pushedColumns += 1;
            await bookkeeping.markSynced('column', column.id);
            if (await purgeServerDeletedColumn(options, column, remoteColumns.length, now)) {
              appliedColumns += 1;
            }
          } catch (updateCaught) {
            if (updateCaught instanceof SyncClearanceError) throw updateCaught;
            requireClearance(options);
            const updateMessage = sanitizeSyncError(
              updateCaught instanceof Error ? updateCaught.message : String(updateCaught),
            );
            await bookkeeping.markFailed('column', column.id, updateMessage);
            errors.push(`Column ${column.name}: ${updateMessage}`);
          }
          continue;
        }
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
            requireAllowed: () => requireClearance(options),
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
    requireClearance(options);
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
      .filter((parts) => parts.entityType === 'settings' && parts.status !== 'synced' && parts.status !== 'terminal');
    if (settingsItems.length > 0) {
      const localSettings = (snapshot.settings ?? {}) as Record<string, unknown>;
      const keys = new Set(settingsItems.map((parts) => parts.entityId));
      try {
        for (const key of keys) {
          requireClearance(options);
          // Push the CURRENT local value; when the key is no longer stored
          // locally the queued change is still represented as an explicit null.
          const value = key in localSettings ? localSettings[key] : null;
          await upsertRow(options.client, 'settings', { key, value });
        }
        requireClearance(options);
        for (const parts of settingsItems) {
          await bookkeeping.markSynced('settings', parts.entityId);
        }
      } catch (caught) {
        if (caught instanceof SyncClearanceError) throw caught;
        requireClearance(options);
        const message = sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
        for (const parts of settingsItems) {
          await bookkeeping.markFailed('settings', parts.entityId, message);
        }
        errors.push(`Settings: ${message}`);
      }
    }

    // Final status ----------------------------------------------------------
    requireClearance(options);
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
      requireClearance(options);
      if (acknowledged.status !== 'healthy' || acknowledged.pendingCount > 0) {
        const message = acknowledged.lastError || 'Some changes have not synchronised yet.';
        return { status: 'error', pushedEntries, pushedColumns, appliedEntries, appliedColumns,
          deletedRemotely, conflicts, errors: [message], error: message };
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
    const terminalReason = remaining.find((item) => outboxItemParts(item).status === 'terminal');
    const firstError = errors[0] ?? (sanitizeSyncError(terminalReason?.lastError ?? terminalReason?.last_error)
      || 'Some pending changes have not synchronised yet');
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
    const paused = caught instanceof SyncClearanceError || (options.isSessionAllowed && !options.isSessionAllowed());
    const message = paused
      ? 'Waiting for admin approval — sync is paused.'
      : sanitizeSyncError(caught instanceof Error ? caught.message : String(caught));
    errors.push(message);
    // A pending Office fence refuses even status writes; never attempt more
    // local operations or remote writes after clearance is withdrawn.
    if (!paused) await options.local.setSyncStatus({ status: 'error', lastError: message }).catch(() => undefined);
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
