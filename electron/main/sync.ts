export type SyncStatus = 'offline' | 'syncing' | 'healthy' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingCount: number;
  last_sync_at?: string | null;
  last_error?: string | null;
  pending_count?: number;
  /**
   * Cache-completeness evidence, reported by the renderer's sync engine over
   * the existing `dks:local:set-sync-status` channel. Nothing here is inferred
   * in the main process: the main process does not talk to Supabase.
   *
   * `lastPullAt` is when a full authorized pull/reconcile completed,
   * `lastPullComplete` is true only when every paginated page of `entries` and
   * `app_columns` arrived, and `lastLocalMutationAt` is when this PC last
   * enqueued a local change. Cloud backup refuses to snapshot a cache that
   * cannot show it was fully pulled after its newest local mutation.
   */
  lastPullAt?: string | null;
  lastPullComplete?: boolean;
  lastPullRows?: number | null;
  lastLocalMutationAt?: string | null;
}

export interface TimestampedRecord {
  updated_at?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export type MergeWinner = 'local' | 'remote' | 'equal';

export interface MergeResult<T extends TimestampedRecord> {
  record: T;
  winner: MergeWinner;
  conflict: boolean;
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
}

export interface ConflictRecord<T extends TimestampedRecord = TimestampedRecord> {
  id?: string;
  entityType?: string;
  entityId?: string;
  local: T;
  remote: T;
  winner: MergeWinner;
  createdAt: string;
}

function updatedAt(record: TimestampedRecord): string | null {
  const value = record.updated_at ?? record.updatedAt;
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestampValue(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function recordsEqual<T>(left: T, right: T): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = canonicalize((value as Record<string, unknown>)[key]);
          return result;
        }, {});
    }
    return value;
  };

  try {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
  } catch {
    return left === right;
  }
}

/**
 * Deterministically merge two records using updated_at metadata.
 *
 * A differing same-timestamp pair is treated as a visible conflict and the
 * remote record wins the tie.  The caller can persist the returned conflict
 * metadata while still showing the chosen record to the user.
 */
export function mergeLastWriteWins<T extends TimestampedRecord>(
  local: T | null,
  remote: T,
): MergeResult<T> {
  if (!local) {
    return {
      record: remote,
      winner: 'remote',
      conflict: false,
      localUpdatedAt: null,
      remoteUpdatedAt: updatedAt(remote),
    };
  }

  const localUpdatedAt = updatedAt(local);
  const remoteUpdatedAt = updatedAt(remote);
  const same = recordsEqual(local, remote);

  if (same) {
    return {
      record: local,
      winner: 'equal',
      conflict: false,
      localUpdatedAt,
      remoteUpdatedAt,
    };
  }

  const localTime = timestampValue(localUpdatedAt);
  const remoteTime = timestampValue(remoteUpdatedAt);

  if (localTime !== null && remoteTime !== null) {
    if (localTime > remoteTime) {
      return { record: local, winner: 'local', conflict: true, localUpdatedAt, remoteUpdatedAt };
    }
    if (remoteTime > localTime) {
      return { record: remote, winner: 'remote', conflict: true, localUpdatedAt, remoteUpdatedAt };
    }
  } else if (localUpdatedAt && remoteUpdatedAt) {
    if (localUpdatedAt > remoteUpdatedAt) {
      return { record: local, winner: 'local', conflict: true, localUpdatedAt, remoteUpdatedAt };
    }
    if (remoteUpdatedAt > localUpdatedAt) {
      return { record: remote, winner: 'remote', conflict: true, localUpdatedAt, remoteUpdatedAt };
    }
  } else if (localUpdatedAt && !remoteUpdatedAt) {
    return { record: local, winner: 'local', conflict: true, localUpdatedAt, remoteUpdatedAt };
  } else if (!localUpdatedAt && remoteUpdatedAt) {
    return { record: remote, winner: 'remote', conflict: true, localUpdatedAt, remoteUpdatedAt };
  }

  // Equal/missing metadata uses the remote copy as a deterministic tie-break.
  return { record: remote, winner: 'remote', conflict: true, localUpdatedAt, remoteUpdatedAt };
}

export const resolveLastWriteWins = mergeLastWriteWins;
export const mergeByUpdatedAt = mergeLastWriteWins;
export const lastWriteWins = mergeLastWriteWins;
export const mergeRemoteRecord = mergeLastWriteWins;
export const mergeRecords = mergeLastWriteWins;

export function compareUpdatedAt(
  local: TimestampedRecord,
  remote: TimestampedRecord,
): -1 | 0 | 1 {
  const localValue = timestampValue(updatedAt(local));
  const remoteValue = timestampValue(updatedAt(remote));
  if (localValue !== null && remoteValue !== null) {
    return localValue === remoteValue ? 0 : (localValue > remoteValue ? 1 : -1);
  }

  const localText = updatedAt(local) ?? '';
  const remoteText = updatedAt(remote) ?? '';
  return localText === remoteText ? 0 : (localText > remoteText ? 1 : -1);
}

export interface SyncOutboxItem {
  id: number | string;
  idempotencyKey: string;
  operation: string;
  entityType: string;
  entityId: string;
  payload: unknown;
}

export interface SyncPushResult {
  acknowledged?: boolean;
  record?: TimestampedRecord;
  error?: string;
}

export interface SyncTransport {
  push: (item: SyncOutboxItem) => Promise<SyncPushResult> | SyncPushResult;
}

export interface SyncOutboxStore {
  listOutbox: (status?: string) => SyncOutboxItem[];
  markOutboxProcessing?: (id: number | string) => void;
  markOutboxSynced?: (id: number | string) => void;
  markOutboxFailed?: (id: number | string, error: string) => void;
  setSyncStatus?: (state: Partial<SyncState> & Pick<SyncState, 'status'>) => void;
}

export interface SyncRunResult {
  status: SyncStatus;
  processed: number;
  failed: number;
  errors: string[];
}

/** Drain pending outbox records in insertion order with idempotency keys intact. */
export async function syncOutbox(
  store: SyncOutboxStore,
  transport: SyncTransport,
  now: () => string = () => new Date().toISOString(),
): Promise<SyncRunResult> {
  const items = store.listOutbox('pending');
  store.setSyncStatus?.({ status: 'syncing', pendingCount: items.length, lastError: null });

  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const item of items) {
    store.markOutboxProcessing?.(item.id);

    try {
      const result = await transport.push(item);
      if (result.acknowledged === false || result.error) {
        throw new Error(result.error ?? 'Sync operation was not acknowledged');
      }
      store.markOutboxSynced?.(item.id);
      processed += 1;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      store.markOutboxFailed?.(item.id, message);
      errors.push(message);
      failed += 1;
    }
  }

  const status: SyncStatus = failed > 0 ? 'error' : 'healthy';
  store.setSyncStatus?.({
    status,
    pendingCount: Math.max(0, items.length - processed),
    lastSyncAt: failed > 0 ? undefined : now(),
    lastError: errors[0] ?? null,
  });

  return { status, processed, failed, errors };
}

export const drainOutbox = syncOutbox;
