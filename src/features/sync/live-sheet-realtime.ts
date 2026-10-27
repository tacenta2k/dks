/**
 * Live Visa Sheet wake-ups — CHANGE NOTIFICATION ONLY.
 *
 * The owner's design decision for "two PCs editing the same sheet": we never
 * stream keystrokes or cells, and we never apply a Realtime payload. An event
 * only means "something changed on the server". Events are coalesced for about
 * a second and then the EXISTING pull/reconcile path runs once, so
 * last-write-wins, the outbox and the push debounce keep their current
 * semantics — Realtime is only a faster trigger for the same reconcile that
 * the 60 s timer already performs.
 *
 * This module owns:
 *   - ONE channel per signed-in client, subscribed to entries + app_columns
 *     (INSERT / UPDATE / DELETE) — RLS decides which rows the server sends;
 *   - burst coalescing (any number of events inside the window → 1 wake-up);
 *   - CLOSED / CHANNEL_ERROR / TIMED_OUT recovery with exponential backoff and
 *     jitter, and exactly ONE catch-up sync after a successful reconnect;
 *   - a best-effort echo hint: wake-ups that arrive while this device's own
 *     reconcile/push is running are dropped, because that same run already
 *     refreshes the page. Correctness never depends on it — the timer sync
 *     remains the fallback, and the next real event is unaffected.
 *
 * The caller (App.tsx) owns the session gate: the watcher exists only while the
 * session is authenticated and (for Office) approved, and `dispose()` is called
 * on sign-out, revocation or the clearance-pending gate, which unsubscribes.
 */

/** One channel name per client; the server never sees a per-device name. */
export const LIVE_SHEET_CHANNEL = 'dks-live-sheet';

/** The two tables the Visa Sheet reconciles from. */
export const LIVE_SHEET_TABLES = ['entries', 'app_columns'] as const;

/** ~1 s coalescing window: a burst of saves becomes one sync. */
export const LIVE_SHEET_DEBOUNCE_MS = 1_000;

/** Reconnect backoff bounds (base 1 s, cap 30 s, + up to 30 % jitter). */
export const LIVE_SHEET_RECONNECT_BASE_MS = 1_000;
export const LIVE_SHEET_RECONNECT_MAX_MS = 30_000;

export type LiveSheetStatus = 'connecting' | 'subscribed' | 'reconnecting' | 'stopped';

export interface LiveSheetChannelFilter {
  event: string;
  schema: string;
  table: string;
}

export interface LiveSheetChannelLike {
  on: (
    event: 'postgres_changes',
    filter: LiveSheetChannelFilter,
    callback: (payload?: unknown) => void,
  ) => LiveSheetChannelLike;
  subscribe?: (callback?: (status: string, error?: unknown) => void) => unknown;
}

export interface LiveSheetClientLike {
  channel?: (name: string) => LiveSheetChannelLike | undefined;
  removeChannel?: (channel: LiveSheetChannelLike) => unknown;
}

export interface LiveSheetTimer {
  set: (callback: () => void, ms: number) => number;
  clear: (handle: number) => void;
}

export interface LiveSheetWatcherOptions {
  client: LiveSheetClientLike;
  /** The existing debounced pull/reconcile entry point. */
  onWakeup: () => void;
  /** True while this device's own sync run is in flight (echo hint only). */
  isBusy?: () => boolean;
  debounceMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectables keep the tests deterministic. */
  random?: () => number;
  timer?: LiveSheetTimer;
  onStatus?: (status: LiveSheetStatus) => void;
}

export interface LiveSheetWatcher {
  readonly status: LiveSheetStatus;
  /** A server change event (or a manual nudge) arrived. */
  notify: () => void;
  /** A coalesced wake-up is currently scheduled. */
  isPending: () => boolean;
  /** Unsubscribe + stop reconnecting. Safe to call more than once. */
  dispose: () => void;
}

function defaultTimer(): LiveSheetTimer {
  return {
    set: (callback, ms) => {
      if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
        return -1;
      }
      return window.setTimeout(callback, ms);
    },
    clear: (handle) => {
      if (handle < 0 || typeof window === 'undefined' || typeof window.clearTimeout !== 'function') {
        return;
      }
      window.clearTimeout(handle);
    },
  };
}

function normalizeStatus(status: unknown): string {
  return typeof status === 'string' ? status.trim().toUpperCase() : '';
}

/**
 * Create the live-sheet watcher and subscribe immediately.
 *
 * Returns a handle even when the client cannot open channels (browser/demo
 * doubles): it then simply never subscribes, and `notify()` still coalesces.
 */
export function createLiveSheetWatcher(options: LiveSheetWatcherOptions): LiveSheetWatcher {
  const debounceMs = Math.max(0, options.debounceMs ?? LIVE_SHEET_DEBOUNCE_MS);
  const reconnectBaseMs = Math.max(1, options.reconnectBaseMs ?? LIVE_SHEET_RECONNECT_BASE_MS);
  const reconnectMaxMs = Math.max(reconnectBaseMs, options.reconnectMaxMs ?? LIVE_SHEET_RECONNECT_MAX_MS);
  const random = options.random ?? Math.random;
  const timer = options.timer ?? defaultTimer();

  let currentStatus: LiveSheetStatus = 'connecting';
  let disposed = false;
  let channel: LiveSheetChannelLike | null = null;
  let flushHandle: number | null = null;
  let reconnectHandle: number | null = null;
  let failedAttempts = 0;

  const setStatus = (next: LiveSheetStatus) => {
    if (currentStatus === next) {
      return;
    }
    currentStatus = next;
    options.onStatus?.(next);
  };

  const clearFlush = () => {
    if (flushHandle !== null) {
      timer.clear(flushHandle);
      flushHandle = null;
    }
  };

  /** Run the reconcile exactly once and cancel any queued coalesced wake-up. */
  const runWakeup = () => {
    clearFlush();
    if (disposed) {
      return;
    }
    try {
      options.onWakeup();
    } catch {
      // A failed sync is reported by the existing sync status; a broken
      // wake-up must never take the Realtime channel down with it.
    }
  };

  const closeChannel = () => {
    const previous = channel;
    channel = null;
    if (!previous) {
      return;
    }
    try {
      const removed = options.client.removeChannel?.(previous);
      if (removed && typeof (removed as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(removed).catch(() => undefined);
      }
    } catch {
      // Removing an already-closed channel is not an error worth surfacing.
    }
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectHandle !== null) {
      return;
    }
    setStatus('reconnecting');
    const exponential = Math.min(
      reconnectMaxMs,
      reconnectBaseMs * 2 ** Math.min(failedAttempts, 16),
    );
    // Jitter only ever lengthens the wait (0–30 %), so two PCs that lose the
    // network together do not reconnect in lockstep.
    const delay = Math.round(exponential + exponential * 0.3 * random());
    failedAttempts += 1;
    reconnectHandle = timer.set(() => {
      reconnectHandle = null;
      if (disposed) {
        return;
      }
      closeChannel();
      openChannel();
    }, delay);
  };

  const handleStatus = (source: LiveSheetChannelLike, rawStatus: unknown) => {
    // Ignore late callbacks from a channel we already replaced or removed.
    if (disposed || source !== channel) {
      return;
    }
    const status = normalizeStatus(rawStatus);
    if (status === 'SUBSCRIBED') {
      const recovering = failedAttempts > 0;
      failedAttempts = 0;
      setStatus('subscribed');
      if (recovering) {
        // One catch-up sync for everything missed while disconnected.
        runWakeup();
      }
      return;
    }
    if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      scheduleReconnect();
    }
  };

  const notify = () => {
    if (disposed) {
      return;
    }
    // Best-effort echo hint: our own push/reconcile is already running and will
    // refresh the page itself. Never required for correctness.
    if (options.isBusy?.()) {
      return;
    }
    if (flushHandle !== null) {
      return; // coalesce: the burst is already queued
    }
    flushHandle = timer.set(() => {
      flushHandle = null;
      runWakeup();
    }, debounceMs);
  };

  function openChannel(): void {
    if (disposed) {
      return;
    }
    let next: LiveSheetChannelLike | undefined;
    try {
      next = options.client.channel?.(LIVE_SHEET_CHANNEL);
    } catch {
      next = undefined;
    }
    if (!next) {
      // No Realtime on this client: the timer sync remains the fallback.
      setStatus('stopped');
      return;
    }
    channel = next;
    try {
      for (const table of LIVE_SHEET_TABLES) {
        // Every event is a wake-up only. The payload is deliberately ignored,
        // so a Realtime message can never write a value the server did not
        // confirm (LWW and the outbox keep their current semantics).
        next.on('postgres_changes', { event: '*', schema: 'public', table }, () => notify());
      }
      const subscribed = next.subscribe?.((status, _error) => handleStatus(next as LiveSheetChannelLike, status));
      if (subscribed && typeof (subscribed as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(subscribed).catch(() => undefined);
      }
    } catch {
      // A throwing registration/subscribe is treated like a dropped
      // connection: retry with backoff instead of taking the app down.
      scheduleReconnect();
    }
  }

  openChannel();

  return {
    get status() {
      return currentStatus;
    },
    notify,
    isPending: () => flushHandle !== null,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearFlush();
      if (reconnectHandle !== null) {
        timer.clear(reconnectHandle);
        reconnectHandle = null;
      }
      closeChannel();
      setStatus('stopped');
    },
  };
}
