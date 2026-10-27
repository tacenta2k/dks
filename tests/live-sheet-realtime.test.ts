/**
 * Live Visa Sheet Realtime (change-notification only) — unit contract.
 *
 * These tests inject a fake Realtime client and fake timers, so they assert
 * exactly what the renderer does: one channel per client, two table filters,
 * burst → one sync, reconnect → one catch-up sync, and unsubscribe on dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLiveSheetWatcher,
  LIVE_SHEET_CHANNEL,
  LIVE_SHEET_DEBOUNCE_MS,
  LIVE_SHEET_RECONNECT_BASE_MS,
  LIVE_SHEET_RECONNECT_MAX_MS,
  type LiveSheetChannelFilter,
  type LiveSheetChannelLike,
  type LiveSheetClientLike,
} from '../src/features/sync/live-sheet-realtime';

interface FakeChannel {
  name: string;
  handle: LiveSheetChannelLike;
  filters: LiveSheetChannelFilter[];
  callbacks: Array<(payload?: unknown) => void>;
  statusCallback?: (status: string, error?: unknown) => void;
  subscribed: number;
}

function createFakeClient(): {
  client: LiveSheetClientLike;
  channels: FakeChannel[];
  removed: FakeChannel[];
} {
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  const client: LiveSheetClientLike = {
    channel: vi.fn((name: string) => {
      const fake: FakeChannel = {
        name,
        filters: [],
        callbacks: [],
        subscribed: 0,
        handle: undefined as unknown as LiveSheetChannelLike,
      };
      const handle: LiveSheetChannelLike = {
        on: (_event, filter, callback) => {
          fake.filters.push(filter);
          fake.callbacks.push(callback);
          return handle;
        },
        subscribe: (callback) => {
          fake.subscribed += 1;
          fake.statusCallback = callback;
          return handle;
        },
      };
      fake.handle = handle;
      channels.push(fake);
      return handle;
    }),
    removeChannel: vi.fn((handle: LiveSheetChannelLike) => {
      const found = channels.find((channel) => channel.handle === handle);
      if (found) {
        removed.push(found);
      }
      return Promise.resolve('ok');
    }),
  };
  return { client, channels, removed };
}

/** Deliver one server change event on the active channel. */
function emitChange(channel: FakeChannel, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    channel.callbacks.forEach((callback) => callback({ eventType: 'UPDATE', new: { id: 'row-1' } }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live sheet Realtime subscription (one channel per client)', () => {
  it('opens ONE channel subscribed to entries and app_columns with every event type', () => {
    const { client, channels } = createFakeClient();
    const onWakeup = vi.fn();
    const watcher = createLiveSheetWatcher({ client, onWakeup });

    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe(LIVE_SHEET_CHANNEL);
    expect(channels[0]?.filters).toEqual([
      { event: '*', schema: 'public', table: 'entries' },
      { event: '*', schema: 'public', table: 'app_columns' },
    ]);
    expect(channels[0]?.subscribed).toBe(1);
    // Registering + subscribing is not a data change: no sync is started.
    expect(onWakeup).not.toHaveBeenCalled();

    watcher.dispose();
  });

  it('coalesces a burst of 10 events into exactly one sync', () => {
    const { client, channels } = createFakeClient();
    const onWakeup = vi.fn();
    const watcher = createLiveSheetWatcher({ client, onWakeup });
    const channel = channels[0]!;

    emitChange(channel, 10);
    expect(watcher.isPending()).toBe(true);

    // Nothing runs before the coalescing window closes…
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS - 1);
    expect(onWakeup).not.toHaveBeenCalled();

    // …and the whole burst produces one reconcile.
    vi.advanceTimersByTime(1);
    expect(onWakeup).toHaveBeenCalledTimes(1);

    // No trailing duplicate wake-up.
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS * 5);
    expect(onWakeup).toHaveBeenCalledTimes(1);
    expect(watcher.isPending()).toBe(false);

    watcher.dispose();
  });

  it('treats the payload as opaque: a second, later burst is one more sync', () => {
    const { client, channels } = createFakeClient();
    const onWakeup = vi.fn();
    const watcher = createLiveSheetWatcher({ client, onWakeup });

    emitChange(channels[0]!, 3);
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS);
    expect(onWakeup).toHaveBeenCalledTimes(1);

    // A payload with hostile/garbage content changes nothing: it is a nudge.
    channels[0]!.callbacks.forEach((callback) => callback({ new: { data: { hacked: true } } }));
    channels[0]!.callbacks.forEach((callback) => callback(undefined));
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS);
    expect(onWakeup).toHaveBeenCalledTimes(2);

    watcher.dispose();
  });

  it('skips wake-ups while this device is already syncing (echo hint only)', () => {
    const { client, channels } = createFakeClient();
    let busy = true;
    const onWakeup = vi.fn();
    const watcher = createLiveSheetWatcher({ client, onWakeup, isBusy: () => busy });

    emitChange(channels[0]!, 5);
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS * 3);
    expect(onWakeup).not.toHaveBeenCalled();

    // Once idle again a real remote change still triggers a sync.
    busy = false;
    emitChange(channels[0]!, 1);
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS);
    expect(onWakeup).toHaveBeenCalledTimes(1);

    watcher.dispose();
  });
});

describe('live sheet Realtime reconnect', () => {
  it('recovers from CLOSED/ERROR with backoff and runs exactly ONE catch-up sync', () => {
    const { client, channels, removed } = createFakeClient();
    const onWakeup = vi.fn();
    const statuses: string[] = [];
    const watcher = createLiveSheetWatcher({
      client,
      onWakeup,
      random: () => 0,
      onStatus: (status) => statuses.push(status),
    });

    channels[0]!.statusCallback?.('CHANNEL_ERROR');
    expect(watcher.status).toBe('reconnecting');
    expect(removed).toHaveLength(0);

    // First retry waits the base delay (jitter is 0 for this fake).
    vi.advanceTimersByTime(LIVE_SHEET_RECONNECT_BASE_MS - 1);
    expect(channels).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(channels).toHaveLength(2);
    expect(removed).toHaveLength(1);
    expect(onWakeup).not.toHaveBeenCalled();

    // Successful re-subscribe: one sync to catch up, not one per event.
    channels[1]!.statusCallback?.('SUBSCRIBED');
    expect(onWakeup).toHaveBeenCalledTimes(1);
    expect(watcher.status).toBe('subscribed');

    emitChange(channels[1]!, 4);
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS);
    expect(onWakeup).toHaveBeenCalledTimes(2);

    expect(statuses).toContain('reconnecting');
    expect(statuses).toContain('subscribed');
    watcher.dispose();
  });

  it('grows the backoff exponentially with bounded jitter', () => {
    const { client, channels } = createFakeClient();
    const watcher = createLiveSheetWatcher({
      client,
      onWakeup: vi.fn(),
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 8_000,
      random: () => 0.5,
    });

    // 1000 + 30%*0.5 = 1150
    channels[0]!.statusCallback?.('CHANNEL_ERROR');
    vi.advanceTimersByTime(1_000);
    expect(channels).toHaveLength(1);
    vi.advanceTimersByTime(150);
    expect(channels).toHaveLength(2);

    // 2000 + 300 = 2300
    channels[1]!.statusCallback?.('TIMED_OUT');
    vi.advanceTimersByTime(2_299);
    expect(channels).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(channels).toHaveLength(3);

    // 4000 + 600 = 4600
    channels[2]!.statusCallback?.('CLOSED');
    vi.advanceTimersByTime(4_600);
    expect(channels).toHaveLength(4);

    watcher.dispose();
  });

  it('caps the retry delay at the maximum', () => {
    const { client, channels } = createFakeClient();
    const watcher = createLiveSheetWatcher({
      client,
      onWakeup: vi.fn(),
      reconnectBaseMs: 1_000,
      reconnectMaxMs: LIVE_SHEET_RECONNECT_MAX_MS,
      random: () => 0,
    });

    // Six consecutive failures: 1s, 2s, 4s, 8s, 16s, then the 30s cap.
    let expectedChannels = 1;
    for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      channels[channels.length - 1]!.statusCallback?.('CHANNEL_ERROR');
      vi.advanceTimersByTime(expected - 1);
      expect(channels).toHaveLength(expectedChannels);
      vi.advanceTimersByTime(1);
      expectedChannels += 1;
      expect(channels).toHaveLength(expectedChannels);
    }
    expect(channels).toHaveLength(7);

    watcher.dispose();
  });

  it('ignores late status callbacks from a channel it already replaced', () => {
    const { client, channels } = createFakeClient();
    const watcher = createLiveSheetWatcher({ client, onWakeup: vi.fn(), random: () => 0 });

    const stale = channels[0]!;
    stale.statusCallback?.('CHANNEL_ERROR');
    vi.advanceTimersByTime(LIVE_SHEET_RECONNECT_BASE_MS);
    expect(channels).toHaveLength(2);

    // A late CLOSED from the replaced channel must not schedule a second retry.
    stale.statusCallback?.('CLOSED');
    vi.advanceTimersByTime(LIVE_SHEET_RECONNECT_BASE_MS * 4);
    expect(channels).toHaveLength(2);

    watcher.dispose();
  });
});

describe('live sheet Realtime teardown (sign-out / revoke / gate)', () => {
  it('unsubscribes on dispose and never syncs or reconnects afterwards', () => {
    const { client, channels, removed } = createFakeClient();
    const onWakeup = vi.fn();
    const watcher = createLiveSheetWatcher({ client, onWakeup });

    emitChange(channels[0]!, 2);
    watcher.dispose();

    expect(removed).toHaveLength(1);
    expect(watcher.status).toBe('stopped');
    // A queued coalesced wake-up is cancelled with the subscription.
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS * 5);
    expect(onWakeup).not.toHaveBeenCalled();

    // Events and status changes arriving after teardown do nothing.
    emitChange(channels[0]!, 5);
    channels[0]!.statusCallback?.('CHANNEL_ERROR');
    watcher.notify();
    vi.advanceTimersByTime(LIVE_SHEET_RECONNECT_MAX_MS * 2);
    expect(onWakeup).not.toHaveBeenCalled();
    expect(channels).toHaveLength(1);

    // Disposing twice is safe.
    watcher.dispose();
    expect((client.removeChannel as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('stays inert when the client cannot open channels (browser/demo doubles)', () => {
    const onWakeup = vi.fn();
    const watcher = createLiveSheetWatcher({ client: {}, onWakeup });
    expect(watcher.status).toBe('stopped');
    watcher.notify();
    vi.advanceTimersByTime(LIVE_SHEET_DEBOUNCE_MS);
    // notify() still coalesces, but the caller only calls it from a channel.
    expect(onWakeup).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('survives a throwing registration/subscribe by retrying instead of crashing', () => {
    let attempts = 0;
    const throwing: LiveSheetClientLike = {
      channel: () => {
        attempts += 1;
        return {
          on: () => {
            throw new Error('socket exploded');
          },
          subscribe: () => undefined,
        };
      },
      removeChannel: () => undefined,
    };
    let watcher: ReturnType<typeof createLiveSheetWatcher> | undefined;
    expect(() => {
      watcher = createLiveSheetWatcher({ client: throwing, onWakeup: vi.fn(), random: () => 0 });
    }).not.toThrow();
    expect(attempts).toBe(1);
    expect(watcher?.status).toBe('reconnecting');

    // The retry re-opens the channel instead of leaving the app without one.
    vi.advanceTimersByTime(LIVE_SHEET_RECONNECT_BASE_MS);
    expect(attempts).toBe(2);
    watcher?.dispose();
  });
});
