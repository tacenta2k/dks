import { muscatDateOf } from './sqlite';
import type { BackupTrigger } from './backup-types';

/**
 * Backup trigger decisions — pure, so T1/T2/T3, the single-flight lock and the
 * catch-up behaviour can be tested with fake timers and no I/O.
 *
 *   T1  launch   first launch of each Asia/Muscat date, or data changed
 *   T2  quit     same condition, only if it can finish inside the quit budget
 *   T3  hourly   same condition as T1 while the app keeps running
 *
 * DKS has no service and no scheduler of its own: **backups only happen while
 * DKS is running**. A day with no launch produces no backup for that day;
 * catching up needs at least one launch, which then uploads the current state.
 */

export const HOURLY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Re-check shortly after a failed attempt so a brief outage self-heals. */
export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
/** Upper bound for the before-quit attempt; past this the work is queued. */
export const QUIT_BACKUP_BUDGET_MS = 8_000;
/** How long to wait for the renderer's sync engine to drain the outbox. */
export const OUTBOX_DRAIN_TIMEOUT_MS = 10_000;
export const OUTBOX_DRAIN_POLL_MS = 400;

export interface BackupTriggerState {
  enabled: boolean;
  keyConfigured: boolean;
  workerConfigured: boolean;
  /** Asia/Muscat date of the last completed CHECK (upload or no-changes). */
  lastCheckedDate: string | null;
  /** Asia/Muscat date of the last CONFIRMED upload. */
  lastSuccessDate: string | null;
  /** Digest of the fingerprint at the last confirmed upload. */
  lastFingerprint: string | null;
  lastAttemptAt: string | null;
}

export interface TriggerDecision {
  run: boolean;
  /** Machine-readable reason, safe to show in the admin UI. */
  reason:
    | 'date_rollover'
    | 'data_changed'
    | 'never_checked'
    | 'already_checked_today'
    | 'retry_after_failure'
    | 'disabled'
    | 'no_key'
    | 'not_configured'
    | 'too_soon_after_failure'
    | 'unknown_fingerprint';
  detail: string;
}

export interface DecideOptions {
  now: () => Date;
  /** Fingerprint digest of the database right now. */
  fingerprint: string;
  /** Set when the previous attempt failed, to apply the retry backoff. */
  lastOutcomeFailed?: boolean;
}

/** The Asia/Muscat calendar date (YYYY-MM-DD) for a Date. */
export function muscatDateFor(date: Date): string {
  return muscatDateOf(date.toISOString());
}

export function shouldRunTrigger(
  trigger: BackupTrigger,
  state: BackupTriggerState,
  options: DecideOptions,
): TriggerDecision {
  const now = options.now();
  const today = muscatDateFor(now);

  if (!state.enabled) {
    return { run: false, reason: 'disabled', detail: 'Cloud backup is turned off' };
  }
  if (!state.keyConfigured) {
    return { run: false, reason: 'no_key', detail: 'Set up the backup key first' };
  }
  if (!state.workerConfigured) {
    return { run: false, reason: 'not_configured', detail: 'The backup service address is not set' };
  }
  if (typeof options.fingerprint !== 'string' || options.fingerprint.length === 0) {
    return { run: false, reason: 'unknown_fingerprint', detail: 'The local database could not be read' };
  }

  const changed = state.lastFingerprint === null || state.lastFingerprint !== options.fingerprint;

  if (!changed && state.lastCheckedDate !== today) {
    // Nothing to upload, but today has not been checked yet: run so the
    // "checked, no changes" event is recorded once per Muscat date.
    return { run: true, reason: 'date_rollover', detail: `New day in Muscat (${today}) — nothing to upload` };
  }

  if (changed) {
    return {
      run: true,
      reason: state.lastFingerprint === null ? 'never_checked' : 'data_changed',
      detail: state.lastFingerprint === null
        ? 'No successful backup has been recorded on this PC yet'
        : 'Records changed since the last successful backup',
    };
  }

  // Nothing changed and today was already checked. If that check FAILED, though,
  // it never produced a backup, so today is not really done: back off briefly
  // and then try again rather than waiting for the next Muscat midnight.
  if (options.lastOutcomeFailed === true && state.lastAttemptAt) {
    const elapsed = now.getTime() - Date.parse(state.lastAttemptAt);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < RETRY_AFTER_FAILURE_MS) {
      return { run: false, reason: 'too_soon_after_failure', detail: 'Retrying the last failed backup shortly' };
    }
    return { run: true, reason: 'retry_after_failure', detail: 'Retrying the last failed backup' };
  }

  return {
    run: false,
    reason: 'already_checked_today',
    detail: `Already checked today (${today}) and nothing changed`,
  };
}

/**
 * Single-flight lock. One backup at a time per process: a launch check, the
 * hourly timer and a manual "Back up now" click can all land together.
 */
export class BackupSingleFlight {
  private inflight: Promise<unknown> | null = null;

  public get running(): boolean {
    return this.inflight !== null;
  }

  /**
   * Run `task` unless another run is in flight. A skipped caller does NOT get
   * a second run — it joins the in-flight one and receives its result, because
   * that run already reflects the newest database state. Reporting a separate
   * "pending" for the skipped caller would claim work that never happened.
   */
  public async run<T>(task: () => Promise<T>): Promise<{ started: boolean; result: T | null }> {
    if (this.inflight) {
      const result = (await this.inflight) as T;
      return { started: false, result };
    }
    const promise = (async () => task())();
    this.inflight = promise;
    try {
      return { started: true, result: await promise };
    } finally {
      this.inflight = null;
    }
  }
}

/**
 * Wait for the renderer's sync engine to drain unpushed local changes.
 *
 * The main process does not own the sync transport, so it can only observe the
 * outbox: poll until nothing is pending/processing, or until the bound expires.
 * Returns the unpushed counts so the caller can refuse to snapshot a partial
 * state instead of uploading one.
 */
export async function waitForOutboxDrain(
  counts: () => { pending: number; processing: number; failed: number },
  options: { now: () => number; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ drained: boolean; pending: number; processing: number; failed: number }> {
  const timeoutMs = options.timeoutMs ?? OUTBOX_DRAIN_TIMEOUT_MS;
  const pollMs = Math.max(1, options.pollMs ?? OUTBOX_DRAIN_POLL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = options.now() + timeoutMs;

  let snapshot = counts();
  while (snapshot.pending > 0 || snapshot.processing > 0) {
    if (options.now() >= deadline) {
      return { drained: false, ...snapshot };
    }
    await sleep(pollMs);
    snapshot = counts();
  }
  return { drained: true, ...snapshot };
}

/**
 * True when the outbox still holds local changes that must not be left out of
 * a snapshot. Terminal items are deliberately excluded: they are already
 * surfaced to the administrator and are never silently dropped.
 */
export function hasUnpushedLocalChanges(counts: { pending: number; processing: number; failed: number }): boolean {
  return counts.pending > 0 || counts.processing > 0 || counts.failed > 0;
}

/** Next hourly check instant, exposed so the UI can show a truthful "next check". */
export function nextCheckAt(from: Date, intervalMs: number = HOURLY_CHECK_INTERVAL_MS): string {
  return new Date(from.getTime() + intervalMs).toISOString();
}
