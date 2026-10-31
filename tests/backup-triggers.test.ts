// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackupSingleFlight,
  HOURLY_CHECK_INTERVAL_MS,
  QUIT_BACKUP_BUDGET_MS,
  RETRY_AFTER_FAILURE_MS,
  hasUnpushedLocalChanges,
  muscatDateFor,
  nextCheckAt,
  shouldRunTrigger,
  waitForOutboxDrain,
  type BackupTriggerState,
} from '../electron/main/backup-scheduler';

/** 2026-10-31T08:00:00Z is 12:00 the same day in Asia/Muscat (UTC+4). */
const BASE = new Date('2026-10-31T08:00:00.000Z');

function state(overrides: Partial<BackupTriggerState> = {}): BackupTriggerState {
  return {
    enabled: true,
    keyConfigured: true,
    workerConfigured: true,
    lastCheckedDate: muscatDateFor(BASE),
    lastSuccessDate: muscatDateFor(BASE),
    lastFingerprint: 'a'.repeat(64),
    lastAttemptAt: BASE.toISOString(),
    ...overrides,
  };
}

const FINGERPRINT = 'a'.repeat(64);
const CHANGED = 'b'.repeat(64);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('trigger conditions', () => {
  it('T1 launch: does nothing when today was already checked and nothing changed', () => {
    const decision = shouldRunTrigger('launch', state(), { now: () => BASE, fingerprint: FINGERPRINT });
    expect(decision.run).toBe(false);
    expect(decision.reason).toBe('already_checked_today');
  });

  it('T1 launch: runs on the first launch of a new Muscat date', () => {
    const tomorrow = new Date('2026-11-01T08:00:00.000Z');
    const decision = shouldRunTrigger('launch', state(), { now: () => tomorrow, fingerprint: FINGERPRINT });
    expect(decision.run).toBe(true);
    expect(decision.reason).toBe('date_rollover');
  });

  it('runs as soon as the fingerprint moves, whatever the trigger', () => {
    for (const trigger of ['launch', 'hourly', 'quit', 'manual'] as const) {
      const decision = shouldRunTrigger(trigger, state(), { now: () => BASE, fingerprint: CHANGED });
      expect(decision.run, trigger).toBe(true);
      expect(decision.reason, trigger).toBe('data_changed');
    }
  });

  it('runs on the very first backup, when no fingerprint has been recorded', () => {
    const decision = shouldRunTrigger('launch', state({ lastFingerprint: null }), {
      now: () => BASE,
      fingerprint: FINGERPRINT,
    });
    expect(decision.run).toBe(true);
    expect(decision.reason).toBe('never_checked');
  });

  it('refuses while disabled, without a key, or without a configured service', () => {
    expect(shouldRunTrigger('launch', state({ enabled: false }), { now: () => BASE, fingerprint: CHANGED }))
      .toMatchObject({ run: false, reason: 'disabled' });
    expect(shouldRunTrigger('launch', state({ keyConfigured: false }), { now: () => BASE, fingerprint: CHANGED }))
      .toMatchObject({ run: false, reason: 'no_key' });
    expect(shouldRunTrigger('launch', state({ workerConfigured: false }), { now: () => BASE, fingerprint: CHANGED }))
      .toMatchObject({ run: false, reason: 'not_configured' });
  });

  it('T3 hourly: fires an hour later only because the data changed, not because time passed', () => {
    const hourLater = new Date(BASE.getTime() + HOURLY_CHECK_INTERVAL_MS);
    const unchanged = shouldRunTrigger('hourly', state(), { now: () => hourLater, fingerprint: FINGERPRINT });
    expect(unchanged.run).toBe(false);

    const changed = shouldRunTrigger('hourly', state(), { now: () => hourLater, fingerprint: CHANGED });
    expect(changed.run).toBe(true);
  });

  it('backs off after a failure, then retries', () => {
    const failing = state({ lastFingerprint: CHANGED });
    const tooSoon = new Date(BASE.getTime() + 60_000);
    expect(shouldRunTrigger('hourly', failing, {
      now: () => tooSoon, fingerprint: CHANGED, lastOutcomeFailed: true,
    })).toMatchObject({ run: false, reason: 'too_soon_after_failure' });

    const later = new Date(BASE.getTime() + RETRY_AFTER_FAILURE_MS + 1);
    expect(shouldRunTrigger('hourly', failing, {
      now: () => later, fingerprint: CHANGED, lastOutcomeFailed: true,
    })).toMatchObject({ run: true, reason: 'retry_after_failure' });
  });

  it('catches up after several missed days with a single launch', () => {
    // The app was closed for five Muscat days; one launch must be enough.
    const fiveDaysLater = new Date('2026-11-05T08:00:00.000Z');
    const decision = shouldRunTrigger('launch', state(), { now: () => fiveDaysLater, fingerprint: FINGERPRINT });
    expect(decision.run).toBe(true);
    expect(decision.reason).toBe('date_rollover');
    expect(decision.detail).toContain('2026-11-05');
  });

  it('uses the Muscat calendar, not UTC, for the date boundary', () => {
    // 22:00 UTC on 31 October is already 02:00 on 1 November in Muscat.
    const lateUtc = new Date('2026-10-31T22:00:00.000Z');
    expect(muscatDateFor(lateUtc)).toBe('2026-11-01');
    expect(shouldRunTrigger('hourly', state(), { now: () => lateUtc, fingerprint: FINGERPRINT }).run).toBe(true);
  });

  it('refuses when the database cannot be read', () => {
    expect(shouldRunTrigger('launch', state(), { now: () => BASE, fingerprint: '' }))
      .toMatchObject({ run: false, reason: 'unknown_fingerprint' });
  });

  it('publishes a next-check instant an hour ahead', () => {
    expect(nextCheckAt(BASE)).toBe(new Date(BASE.getTime() + HOURLY_CHECK_INTERVAL_MS).toISOString());
    expect(QUIT_BACKUP_BUDGET_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('single-flight lock', () => {
  it('lets one run through and joins a concurrent caller to it instead of queueing it', async () => {
    const flight = new BackupSingleFlight();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: number[] = [];

    const first = flight.run(async () => {
      started.push(1);
      await gate;
      return 'first';
    });
    expect(flight.running).toBe(true);

    const second = flight.run(async () => {
      started.push(2);
      return 'second';
    });
    expect(flight.running).toBe(true);

    release();

    // The skipped caller joins the in-flight run and reports its outcome,
    // rather than claiming a result of its own.
    expect(await first).toEqual({ started: true, result: 'first' });
    expect(await second).toEqual({ started: false, result: 'first' });
    expect(started).toEqual([1]);
    expect(flight.running).toBe(false);
  });

  it('releases the lock when a run throws, so the next trigger can run', async () => {
    const flight = new BackupSingleFlight();
    await expect(flight.run(async () => {
      throw new Error('snapshot failed');
    })).rejects.toThrow('snapshot failed');
    expect(flight.running).toBe(false);
    expect(await flight.run(async () => 'ok')).toEqual({ started: true, result: 'ok' });
  });
});

describe('outbox drain before a snapshot', () => {
  it('waits for a bounded drain and reports success', async () => {
    let clock = 0;
    const counts = [
      { pending: 3, processing: 0, failed: 0 },
      { pending: 1, processing: 1, failed: 0 },
      { pending: 0, processing: 0, failed: 0 },
    ];
    let call = 0;
    const result = await waitForOutboxDrain(
      () => counts[Math.min(call++, counts.length - 1)],
      { now: () => clock, timeoutMs: 5_000, pollMs: 100, sleep: async (ms) => { clock += ms; } },
    );
    expect(result).toEqual({ drained: true, pending: 0, processing: 0, failed: 0 });
  });

  it('gives up at the bound and reports what is still pending', async () => {
    let clock = 0;
    const result = await waitForOutboxDrain(
      () => ({ pending: 4, processing: 0, failed: 0 }),
      { now: () => clock, timeoutMs: 1_000, pollMs: 250, sleep: async (ms) => { clock += ms; } },
    );
    expect(result.drained).toBe(false);
    expect(result.pending).toBe(4);
    expect(clock).toBeGreaterThanOrEqual(1_000);
  });

  it('treats failed items as unpushed local changes, terminal ones as settled', () => {
    expect(hasUnpushedLocalChanges({ pending: 0, processing: 0, failed: 1 })).toBe(true);
    expect(hasUnpushedLocalChanges({ pending: 1, processing: 0, failed: 0 })).toBe(true);
    expect(hasUnpushedLocalChanges({ pending: 0, processing: 0, failed: 0 })).toBe(false);
  });
});
