import type {
  DksLocalColumn,
  DksLocalRow,
  DksLocalSnapshot,
  DksLocalSyncState,
} from '../../lib/types';

export interface SupabaseQueryError {
  message: string;
}

export interface SupabaseTableQuery {
  select: (columns: string) => Promise<{
    data: readonly unknown[] | null;
    error: SupabaseQueryError | null;
  }>;
  upsert: (
    values: readonly Record<string, unknown>[],
    options?: { onConflict?: string },
  ) => Promise<{
    data: readonly unknown[] | null;
    error: SupabaseQueryError | null;
  }>;
}

export interface SupabaseDataClient {
  from: (table: string) => SupabaseTableQuery;
}

export interface SupabaseSyncLocal {
  getSnapshot: () => Promise<DksLocalSnapshot>;
  setSyncStatus: (state: Partial<DksLocalSyncState> & Pick<DksLocalSyncState, 'status'>) => Promise<DksLocalSyncState>;
  applyRemoteSnapshot?: (input: {
    rows: readonly Record<string, unknown>[];
    columns: readonly Record<string, unknown>[];
  }) => Promise<DksLocalSnapshot>;
  acknowledgeOutbox?: () => Promise<DksLocalSyncState>;
}

export interface SupabaseSyncOptions {
  client: SupabaseDataClient;
  local: SupabaseSyncLocal;
  now?: () => string;
}

export interface SupabaseSyncResult {
  status: 'healthy' | 'error';
  pushedEntries: number;
  pushedColumns: number;
  appliedEntries: number;
  appliedColumns: number;
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

function localRows(snapshot: DksLocalSnapshot): DksLocalRow[] {
  return [
    ...(snapshot.rows ?? snapshot.activeRows ?? []),
    ...(snapshot.deletedRows ?? []),
  ];
}

function toRemoteEntry(row: DksLocalRow, now: string): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const updated = stringValue(source.updated_at ?? source.updatedAt, now);
  const created = stringValue(source.created_at ?? source.createdAt, updated);
  return {
    id: row.id,
    data: row.data,
    category: row.category ?? 'Employee',
    deleted: row.deleted === true,
    deleted_at: source.deleted_at ?? source.deletedAt ?? null,
    version: numberValue(source.version, 1),
    created_at: created,
    updated_at: updated,
    updated_by: source.updated_by ?? source.updatedBy ?? null,
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

async function upsertTable(
  client: SupabaseDataClient,
  table: string,
  values: readonly Record<string, unknown>[],
): Promise<void> {
  if (values.length === 0) {
    return;
  }
  const result = await client.from(table).upsert(values, { onConflict: 'id' });
  if (result.error) {
    throw new Error(result.error.message || `Unable to write ${table}`);
  }
}

export async function runSupabaseSync(options: SupabaseSyncOptions): Promise<SupabaseSyncResult> {
  const now = options.now ?? (() => new Date().toISOString());
  let pushedEntries = 0;
  let pushedColumns = 0;
  let appliedEntries = 0;
  let appliedColumns = 0;

  try {
    const snapshot = await options.local.getSnapshot();
    await options.local.setSyncStatus({
      status: 'syncing',
      pendingCount: snapshot.syncStatus.pendingCount,
      lastError: null,
    });
    const [remoteEntries, remoteColumns] = await Promise.all([
      selectTable(options.client, 'entries'),
      selectTable(options.client, 'app_columns'),
    ]);

    const localEntryMap = new Map(localRows(snapshot).map((row) => [row.id, row]));
    const remoteEntryMap = new Map(remoteEntries
      .filter((row) => stringValue(row.id))
      .map((row) => [stringValue(row.id), row]));
    const remoteEntryPushes: Record<string, unknown>[] = [];
    const remoteRowsToApply: Record<string, unknown>[] = [];

    for (const id of new Set([...localEntryMap.keys(), ...remoteEntryMap.keys()])) {
      const local = localEntryMap.get(id);
      const remote = remoteEntryMap.get(id);
      if (local && (!remote || localWins(local as unknown as Record<string, unknown>, remote))) {
        remoteEntryPushes.push(toRemoteEntry(local, now()));
      } else if (remote && (!local || remoteWins(local as unknown as Record<string, unknown>, remote))) {
        remoteRowsToApply.push(toLocalEntry(remote));
      }
    }

    const localColumns = snapshot.columns ?? [];
    const localColumnById = new Map(localColumns.map((column) => [column.id, column]));
    const remoteColumnById = new Map(remoteColumns
      .filter((column) => stringValue(column.id))
      .map((column) => [stringValue(column.id), column]));
    const remoteColumnByName = new Map(remoteColumns
      .filter((column) => stringValue(column.name))
      .map((column) => [stringValue(column.name).toLowerCase(), column]));
    const consumedRemoteColumnIds = new Set<string>();
    const remoteColumnPushes: Record<string, unknown>[] = [];
    const remoteColumnsToApply: Record<string, unknown>[] = [];

    for (const local of localColumns) {
      const remote = remoteColumnById.get(local.id)
        ?? remoteColumnByName.get(local.name.toLowerCase());
      if (!remote) {
        remoteColumnPushes.push(toRemoteColumn(local, now()));
        continue;
      }
      const remoteId = stringValue(remote.id);
      if (remoteId) {
        consumedRemoteColumnIds.add(remoteId);
      }
      const localRecord = local as unknown as Record<string, unknown>;
      if (localWins(localRecord, remote)) {
        remoteColumnPushes.push(toRemoteColumn(local, now(), remoteId));
      } else {
        remoteColumnsToApply.push(toLocalColumn(remote, local.id));
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

    await upsertTable(options.client, 'entries', remoteEntryPushes);
    await upsertTable(options.client, 'app_columns', remoteColumnPushes);
    pushedEntries = remoteEntryPushes.length;
    pushedColumns = remoteColumnPushes.length;

    if ((remoteRowsToApply.length > 0 || remoteColumnsToApply.length > 0)
      && !options.local.applyRemoteSnapshot) {
      throw new Error('The local cache cannot apply remote records');
    }
    if (options.local.applyRemoteSnapshot) {
      if (remoteRowsToApply.length > 0 || remoteColumnsToApply.length > 0) {
        await options.local.applyRemoteSnapshot({
          rows: remoteRowsToApply,
          columns: remoteColumnsToApply,
        });
      }
      appliedEntries = remoteRowsToApply.length;
      appliedColumns = remoteColumnsToApply.length;
    }

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
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    await options.local.setSyncStatus({ status: 'error', lastError: error });
    return {
      status: 'error',
      pushedEntries,
      pushedColumns,
      appliedEntries,
      appliedColumns,
      error,
    };
  }
}

export const syncWithSupabase = runSupabaseSync;
