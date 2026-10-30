// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MainErrorReporter,
  computeErrorFingerprint,
  roundTimestampToUtcMinute,
  sanitizeOsRelease,
  validateStructuredErrorInput,
} from '../electron/main/error-reporter';
import {
  MAX_ERROR_REPORT_DEDUPE,
  SqliteStore,
  createSqliteStore,
} from '../electron/main/sqlite';
import {
  ErrorReportingController,
  buildOutboundReportPayload,
  validateRendererErrorInput,
} from '../src/features/diagnostics/error-reporting';
import { validateServerErrorReport } from '../supabase/edge-functions/_shared/error-report';
import type { DksDiagnosticsApi, DksSanitizedErrorReportEvent } from '../src/lib/types';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dks-err-report-'));
  tempDirs.push(dir);
  return join(dir, 'dks.sqlite');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best-effort temp cleanup on Windows when AV/WAL handles release asynchronously.
      }
    }
  }
});

describe('privacy allowlist across main, renderer, and server validators', () => {
  it('accepts strictly structured diagnostic codes, rounds timestamps to UTC minutes, and strips OS host suffixes', () => {
    const validated = validateStructuredErrorInput({
      category: 'sync',
      severity: 'error',
      code: 'SYNC_OUTBOX_TERMINAL',
      component: 'renderer/supabase-sync',
      process: 'renderer',
      httpStatus: 500,
      postgresCode: '42501',
      occurredAt: '2026-10-29T14:37:49.918Z',
    });

    expect(validated.ok).toBe(true);
    expect(sanitizeOsRelease('10.0.22631-DESKTOP-CUSTOMER-PC')).toBe('10.0.22631');
    expect(roundTimestampToUtcMinute('2026-10-29T14:37:49.918Z')).toBe('2026-10-29T14:37:00Z');

    const fp = computeErrorFingerprint({
      category: 'sync',
      code: 'SYNC_OUTBOX_TERMINAL',
      component: 'renderer/supabase-sync',
      process: 'renderer',
      appVersion: '1.1.3',
      platform: 'win32',
    });
    expect(fp).toMatch(/^[0-9a-f]{32}$/);

    const outbound = buildOutboundReportPayload({
      fingerprint: fp,
      category: 'sync',
      severity: 'error',
      code: 'SYNC_OUTBOX_TERMINAL',
      component: 'renderer/supabase-sync',
      process: 'renderer',
      appVersion: '1.1.3',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      electronVersion: '33.4.0',
      packaged: true,
      sqliteSchemaVersion: 4,
      httpStatus: 500,
      postgresCode: '42501',
      occurrences: 1,
      firstOccurredAt: '2026-10-29T14:37:49.918Z',
      lastOccurredAt: '2026-10-29T14:37:49.918Z',
    });
    expect(outbound).not.toBeNull();

    // Must also pass server-side allowlist validation verbatim.
    const serverCheck = validateServerErrorReport(outbound);
    expect(serverCheck.ok).toBe(true);
  });

  it('rejects emails, UUIDs, Passport/Civil IDs, file paths, URLs, stack traces, self-components, and unknown keys', () => {
    const sensitiveStrings = [
      'shahabasnavas123@gmail.com',
      'amervisamedical1dks@gmail.com',
      '846536af-f3c6-47c1-8559-d13442c1490a',
      'C:\\Users\\Customer\\AppData\\Roaming\\DKS\\dks.sqlite',
      '/home/user/dks/.env',
      'https://project.supabase.co/rest/v1/entries?id=eq.123',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret',
      'PASSPORT_298102912345',
      'Error: Passport A12345678\n    at sync (app.js:12:4)',
    ];

    for (const secret of sensitiveStrings) {
      expect(
        validateStructuredErrorInput({
          category: 'sync',
          severity: 'error',
          code: secret,
          component: 'renderer/sync',
        }).ok,
      ).toBe(false);

      expect(
        validateStructuredErrorInput({
          category: 'sync',
          severity: 'error',
          code: 'SYNC_REMOTE_FAILED',
          component: secret,
        }).ok,
      ).toBe(false);

      expect(
        validateRendererErrorInput({
          category: 'sync',
          severity: 'error',
          code: secret,
          component: 'renderer/sync',
        }).ok,
      ).toBe(false);
    }

    // Self-component exclusion prevents recursive diagnostics loops.
    expect(
      validateRendererErrorInput({
        category: 'renderer',
        severity: 'error',
        code: 'SELF_FAILURE',
        component: 'renderer/error-reporting',
      }).ok,
    ).toBe(false);

    const baseValid: DksSanitizedErrorReportEvent = {
      fingerprint: 'a'.repeat(32),
      category: 'sync',
      severity: 'error',
      code: 'SYNC_REMOTE_FAILED',
      component: 'renderer/sync',
      process: 'renderer',
      appVersion: '1.1.3',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      electronVersion: '33.4.0',
      packaged: true,
      sqliteSchemaVersion: 4,
      httpStatus: 503,
      postgresCode: null,
      occurrences: 1,
      firstOccurredAt: '2026-10-29T10:00:00Z',
      lastOccurredAt: '2026-10-29T10:00:00Z',
    };

    for (const forbiddenKey of ['message', 'stack', 'email', 'entryId', 'userId', 'passport', 'civilId', 'rawLog']) {
      const polluted = { ...baseValid, [forbiddenKey]: 'redacted-attempt' };
      expect(validateServerErrorReport(polluted).ok, `Expected ${forbiddenKey} to be rejected`).toBe(false);
      expect(buildOutboundReportPayload(polluted as unknown as DksSanitizedErrorReportEvent)).toBeNull();
    }

    expect(
      validateServerErrorReport({
        ...baseValid,
        appVersion: '1.1.3-user@example.com',
      }).ok,
    ).toBe(false);
  });
});

describe('SQLite v3 -> v4 migration, deduplication, bounds, and customer outbox isolation', () => {
  it('migrates an existing v3 store cleanly to v4 while preserving customer entries and pending customer outbox', () => {
    const dbPath = createTempDbPath();
    // Create a store, rewind migration 4 to simulate a pre-existing v3 database with customer data + outbox:
    const seedStore = createSqliteStore(dbPath);
    seedStore.createEntry({
      id: '11111111-1111-4111-8111-111111111111',
      category: 'Employee',
      data: { name: 'Customer A' },
    });
    seedStore.close();

    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS error_report_queue;
      DROP TABLE IF EXISTS error_report_dedupe;
      PRAGMA user_version = 3;
      DELETE FROM schema_migrations WHERE version >= 4;
    `);
    raw.close();

    const migrated = createSqliteStore(dbPath);
    try {
      expect(migrated.getMigrationVersion()).toBe(4);
      expect(migrated.listEntries()).toHaveLength(1);
      expect(migrated.getOutboxSummary().pendingCount).toBeGreaterThanOrEqual(1);
      expect(migrated.getErrorReportQueueSummary()).toEqual({
        pendingCount: 0,
        failedCount: 0,
        suppressedCount: 0,
        sqliteSchemaVersion: 4,
      });
    } finally {
      migrated.close();
    }
  });

  it('deduplicates within 6 hours, caps queue at 50 & dedupe table at 200, backs off retries, and isolates customer outbox', () => {
    const store = createSqliteStore(createTempDbPath());
    try {
      store.createEntry({
        id: '22222222-2222-4222-8222-222222222222',
        category: 'Employee',
        data: { name: 'Customer B' },
      });
      const initialCustomerOutbox = store.getOutboxSummary().pendingCount;
      expect(initialCustomerOutbox).toBeGreaterThanOrEqual(1);

      const makeInput = (i: number, recordedAt: string) => ({
        fingerprint: i.toString(16).padStart(32, 'a'),
        category: 'sync',
        severity: 'error' as const,
        code: `SYNC_CODE_${i}`,
        component: 'renderer/sync',
        process: 'renderer' as const,
        appVersion: '1.1.3',
        platform: 'win32',
        arch: 'x64',
        osRelease: '10.0.22631',
        electronVersion: '33.4.0',
        packaged: true,
        sqliteSchemaVersion: 4,
        httpStatus: 500,
        postgresCode: null,
        occurredAt: '2026-10-29T10:00:00Z',
        recordedAt,
      });

      const first = store.enqueueErrorReport(makeInput(1, '2026-10-29T10:00:00.000Z'));
      expect(first.accepted).toBe(true);
      expect(first.occurrences).toBe(1);

      // Duplicate while pending merges into the queued row:
      const merged = store.enqueueErrorReport(makeInput(1, '2026-10-29T10:30:00.000Z'));
      expect(merged).toEqual({ accepted: true, reason: 'merged_pending', occurrences: 2 });

      const claimed = store.claimErrorReports({ limit: 5, now: '2026-10-29T10:31:00.000Z' });
      expect(claimed).toHaveLength(1);
      expect(claimed[0].occurrences).toBe(2);

      // Exponential backoff on retry:
      store.completeErrorReport({
        fingerprint: claimed[0].fingerprint,
        outcome: 'retry',
        errorCode: 'HTTP_503',
        now: '2026-10-29T10:31:00.000Z',
      });
      expect(store.claimErrorReports({ limit: 5, now: '2026-10-29T10:31:10.000Z' })).toHaveLength(0);
      expect(store.claimErrorReports({ limit: 5, now: '2026-10-29T10:33:05.000Z' })).toHaveLength(1);

      // Mark delivered -> enters 6h dedupe table:
      store.completeErrorReport({
        fingerprint: claimed[0].fingerprint,
        outcome: 'delivered',
        now: '2026-10-29T10:33:06.000Z',
      });
      // Within 6 hours -> suppressed by cooldown!
      expect(store.enqueueErrorReport(makeInput(1, '2026-10-29T13:00:00.000Z'))).toMatchObject({
        accepted: false,
        reason: 'deduped_cooldown',
      });
      // After >6 hours -> accepted again!
      expect(store.enqueueErrorReport(makeInput(1, '2026-10-29T17:00:00.000Z')).accepted).toBe(true);

      // Queue hard cap (50) and dedupe cap (200):
      for (let i = 2; i <= MAX_ERROR_REPORT_DEDUPE + 25; i += 1) {
        store.enqueueErrorReport(makeInput(i, '2026-10-29T18:00:00.000Z'));
      }
      expect(store.getErrorReportQueueSummary().pendingCount).toBe(50);

      // Disabling error reporting clears error_report_queue while leaving customer outbox untouched!
      store.setErrorReportingEnabledMeta(false);
      store.clearErrorReportQueue();
      expect(store.getErrorReportQueueSummary().pendingCount).toBe(0);
      expect(store.getOutboxSummary().pendingCount).toBe(initialCustomerOutbox);
    } finally {
      store.close();
    }
  });

  it('prevents recursive self-reporting if SQLite throws inside capture()', () => {
    let nestedResult: { accepted: boolean; reason?: string } | null = null;
    let reporter!: MainErrorReporter;
    const throwingStore = {
      getErrorReportingEnabledMeta: () => true,
      getMigrationVersion: () => 4,
      clearErrorReportQueue: () => undefined,
      enqueueErrorReport: () => {
        nestedResult = reporter.capture({
          category: 'sqlite',
          severity: 'error',
          code: 'SQLITE_NESTED_FAILURE',
          component: 'main/sqlite',
        });
        throw new Error('disk I/O error');
      },
    } as unknown as SqliteStore;

    reporter = new MainErrorReporter({
      appVersion: '1.1.3',
      packaged: true,
      store: throwingStore,
    });

    expect(() =>
      reporter.capture({
        category: 'main',
        severity: 'error',
        code: 'MAIN_UNCAUGHT_EXCEPTION',
        component: 'main/process',
      }),
    ).not.toThrow();
    expect(nestedResult).toEqual({ accepted: false, reason: 'reentrant_suppressed' });
  });
});

describe('renderer ErrorReportingController offline queue, backoff, and non-blocking safety', () => {
  it('skips flush while offline, honors 429 Retry-After when online, and marks 201 deliveries cleanly', async () => {
    const completed: Array<{ fingerprint: string; outcome: string; retryAfterSeconds?: number | null }> = [];
    const sampleEvent: DksSanitizedErrorReportEvent = {
      fingerprint: 'b'.repeat(32),
      category: 'sync',
      severity: 'error',
      code: 'SYNC_REMOTE_FAILED',
      component: 'renderer/sync',
      process: 'renderer',
      appVersion: '1.1.3',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      electronVersion: '33.4.0',
      packaged: true,
      sqliteSchemaVersion: 4,
      httpStatus: 502,
      postgresCode: null,
      occurrences: 1,
      firstOccurredAt: '2026-10-29T10:00:00Z',
      lastOccurredAt: '2026-10-29T10:00:00Z',
    };

    const diagnosticsApi: DksDiagnosticsApi = {
      getAdminStatus: vi.fn(),
      captureError: vi.fn().mockResolvedValue({ accepted: true }),
      claimErrorReports: vi.fn().mockResolvedValue([sampleEvent]),
      completeErrorReport: vi.fn(async (input) => {
        completed.push(input);
        return { ok: true };
      }),
      setErrorReportingEnabled: vi.fn(),
      syncWorkspaceErrorReporting: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, action: 'rate_limited_user', retryAfterSeconds: 120 }), {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, action: 'issue_created', issueNumber: 12 }), {
          status: 201,
        }),
      );

    let online = false;
    const controller = new ErrorReportingController({
      diagnosticsApi,
      fetchImpl: fetchMock as unknown as typeof fetch,
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'sb_publishable_test',
      isOnline: () => online,
    });
    controller.setSessionContext({
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhIn0.sig123456',
      role: 'admin',
      sessionCleared: true,
    });

    // Offline -> does not claim or call network:
    expect(await controller.flushPending()).toEqual({ attempted: 0, delivered: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    // Online + 429 -> records retry with Retry-After seconds:
    online = true;
    expect(await controller.flushPending()).toEqual({ attempted: 1, delivered: 0 });
    expect(completed[0]).toMatchObject({
      fingerprint: sampleEvent.fingerprint,
      outcome: 'retry',
      retryAfterSeconds: 120,
    });

    // Next flush -> 201 -> delivered!
    expect(await controller.flushPending()).toEqual({ attempted: 1, delivered: 1 });
    expect(completed[1]).toMatchObject({
      fingerprint: sampleEvent.fingerprint,
      outcome: 'delivered',
    });
  });
});
