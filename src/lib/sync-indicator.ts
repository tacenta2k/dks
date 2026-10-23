import type { DksLocalSyncStatus } from './types';

/**
 * R2-12 — the top-bar sync pill must be truthful.
 *
 * Rules:
 *   - anything still queued in the outbox means the data has NOT reached the
 *     cloud yet, so the pill can never read "Saved to cloud" while
 *     pendingCount > 0;
 *   - an in-flight sync reads "Syncing… · N pending";
 *   - a failed sync, or queued work that is not currently being flushed,
 *     reads "Sync error · N pending";
 *   - "Offline — saved locally" is only used when nothing is queued (the
 *     local cache is authoritative and no cloud write is outstanding);
 *   - "Saved to cloud" is only used for a healthy state with zero pending.
 */
export type SyncIndicatorKey = 'cloud' | 'syncing' | 'offline' | 'error';

export interface SyncIndicator {
  key: SyncIndicatorKey;
  label: string;
  pendingSuffix: string;
}

export function resolveSyncIndicator(
  status: DksLocalSyncStatus | string,
  pendingCount: number,
): SyncIndicator {
  const pending = Number.isFinite(pendingCount) && pendingCount > 0 ? Math.trunc(pendingCount) : 0;
  const pendingSuffix = pending > 0 ? ` · ${pending} pending` : '';

  if (status === 'syncing') {
    return { key: 'syncing', label: `Syncing…${pendingSuffix}`, pendingSuffix };
  }

  if (status === 'error' || pending > 0) {
    return { key: 'error', label: `Sync error${pendingSuffix}`, pendingSuffix };
  }

  if (status === 'healthy') {
    return { key: 'cloud', label: 'Saved to cloud', pendingSuffix };
  }

  return { key: 'offline', label: 'Offline — saved locally', pendingSuffix };
}
