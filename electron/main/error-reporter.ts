import { createHash } from 'node:crypto';
import * as os from 'node:os';

import type {
  CompleteErrorReportInput,
  EnqueueErrorReportInput,
  ErrorReportQueueSummary,
  QueuedErrorReportRecord,
  SqliteStore,
} from './sqlite';
import {
  ERROR_REPORT_DEDUPE_COOLDOWN_MS,
  MAX_ERROR_REPORT_ATTEMPTS,
} from './sqlite';

export const ERROR_REPORT_CATEGORIES = [
  'auth',
  'sync',
  'sqlite',
  'ipc',
  'updater',
  'renderer',
  'main',
  'settings',
  'network',
] as const;

export type ErrorReportCategory = (typeof ERROR_REPORT_CATEGORIES)[number];

export const ERROR_REPORT_SEVERITIES = ['error', 'warning'] as const;
export type ErrorReportSeverity = (typeof ERROR_REPORT_SEVERITIES)[number];

export const ERROR_REPORT_PROCESSES = ['main', 'renderer'] as const;
export type ErrorReportProcess = (typeof ERROR_REPORT_PROCESSES)[number];

export const ERROR_REPORT_PLATFORMS = ['win32', 'darwin', 'linux', 'unknown'] as const;
export type ErrorReportPlatform = (typeof ERROR_REPORT_PLATFORMS)[number];

export const ERROR_REPORT_ARCHES = ['x64', 'arm64', 'ia32', 'unknown'] as const;
export type ErrorReportArch = (typeof ERROR_REPORT_ARCHES)[number];

export interface StructuredErrorReportInput {
  category: ErrorReportCategory;
  severity: ErrorReportSeverity;
  code: string;
  component: string;
  process?: ErrorReportProcess;
  httpStatus?: number | null;
  postgresCode?: string | null;
  occurredAt?: string;
}

export interface SanitizedErrorReportEvent {
  fingerprint: string;
  category: ErrorReportCategory;
  severity: ErrorReportSeverity;
  code: string;
  component: string;
  process: ErrorReportProcess;
  appVersion: string;
  platform: ErrorReportPlatform;
  arch: ErrorReportArch;
  osRelease: string;
  electronVersion: string | null;
  packaged: boolean;
  sqliteSchemaVersion: number | null;
  httpStatus: number | null;
  postgresCode: string | null;
  occurrences: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
}

export type LastDeliveryOutcome =
  | 'never'
  | 'delivered'
  | 'suppressed_remote'
  | 'deferred_backoff'
  | 'rate_limited'
  | 'disabled'
  | 'failed';

export interface ErrorReportingStatusSummary {
  enabled: boolean;
  pendingCount: number;
  failedCount: number;
  suppressedCount: number;
  lastDeliveryOutcome: LastDeliveryOutcome;
  lastDeliveryAt: string | null;
}

const ALLOWED_INPUT_KEYS = new Set([
  'category',
  'severity',
  'code',
  'component',
  'process',
  'httpStatus',
  'postgresCode',
  'occurredAt',
]);

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{1,63}$/;
const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9_.:/-]{1,63}$/;
const APP_VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const OS_RELEASE_PATTERN = /^[0-9]{1,4}(?:\.[0-9]{1,6}){0,3}$/;
const ELECTRON_VERSION_PATTERN = /^[0-9]{1,4}(?:\.[0-9]{1,6}){1,3}$/;
const POSTGRES_CODE_PATTERN = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;

// Reject tokens that look like UUIDs, emails, URLs, Windows/Unix home paths,
// JWTs, or 8+ digit identifier runs (Passport / Civil ID / phone).
const UUID_SUBSTRING = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIGIT_RUN = /[0-9]{7,}/;
const PATH_PREFIX = /^(?:[a-zA-Z]:|\/Users\/|\/home\/|\\\\|~\/|\.\.\/)/;
const JWT_LIKE = /^eyJ[A-Za-z0-9_-]{8,}/;

const SAFE_NODE_CODES = new Set([
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_SCHEMA',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_NOTADB',
  'ERR_DLOPEN_FAILED',
  'MODULE_NOT_FOUND',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'EMFILE',
]);

const MAX_MEMORY_QUEUE = 25;
const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const MAX_CLAIMS_PER_WINDOW = 6;

export function sanitizeOsRelease(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '0.0.0';
  const match = /^([0-9]{1,4}(?:\.[0-9]{1,6}){0,3})/.exec(raw.trim());
  if (!match) return '0.0.0';
  const candidate = match[1];
  return OS_RELEASE_PATTERN.test(candidate) ? candidate : '0.0.0';
}

export function sanitizeAppVersion(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '0.0.0';
  const trimmed = raw.trim().replace(/^v/i, '');
  return APP_VERSION_PATTERN.test(trimmed) ? trimmed : '0.0.0';
}

export function sanitizeElectronVersion(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return ELECTRON_VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

export function sanitizePlatform(raw: string | undefined | null): ErrorReportPlatform {
  if (raw === 'win32' || raw === 'darwin' || raw === 'linux') return raw;
  return 'unknown';
}

export function sanitizeArch(raw: string | undefined | null): ErrorReportArch {
  if (raw === 'x64' || raw === 'arm64' || raw === 'ia32') return raw;
  return 'unknown';
}

export function roundTimestampToUtcMinute(raw?: string | Date | null, fallbackNow?: () => string): string {
  const candidate = raw instanceof Date
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? new Date(raw)
      : new Date(fallbackNow ? fallbackNow() : Date.now());
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  const rounded = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    0,
    0,
  ));
  return rounded.toISOString().replace('.000Z', 'Z');
}

export function isSafeDiagnosticToken(value: string, kind: 'code' | 'component'): boolean {
  if (!value || value.includes('@') || value.includes('://') || value.includes('\\') || value.includes(' ')) {
    return false;
  }
  if (UUID_SUBSTRING.test(value) || DIGIT_RUN.test(value) || PATH_PREFIX.test(value) || JWT_LIKE.test(value)) {
    return false;
  }
  if (kind === 'code') {
    return CODE_PATTERN.test(value);
  }
  if (value.startsWith('/') || value.includes('//') || value.includes('..')) {
    return false;
  }
  return COMPONENT_PATTERN.test(value);
}

export function computeErrorFingerprint(parts: {
  category: ErrorReportCategory;
  code: string;
  component: string;
  process: ErrorReportProcess;
  appVersion: string;
  platform: ErrorReportPlatform;
}): string {
  const canonical = [
    parts.category,
    parts.code,
    parts.component,
    parts.process,
    parts.appVersion,
    parts.platform,
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

export function validateStructuredErrorInput(
  raw: unknown,
  defaultProcess: ErrorReportProcess = 'renderer',
): { ok: true; value: Required<Pick<StructuredErrorReportInput, 'category' | 'severity' | 'code' | 'component' | 'process'>> & {
  httpStatus: number | null;
  postgresCode: string | null;
  occurredAt?: string;
} } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'Report input must be an object' };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return { ok: false, reason: `Disallowed field in error report: ${key}` };
    }
  }

  const category = record.category;
  if (typeof category !== 'string' || !(ERROR_REPORT_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, reason: 'Invalid error category' };
  }

  const severity = record.severity;
  if (typeof severity !== 'string' || !(ERROR_REPORT_SEVERITIES as readonly string[]).includes(severity)) {
    return { ok: false, reason: 'Invalid error severity' };
  }

  const code = record.code;
  if (typeof code !== 'string' || !isSafeDiagnosticToken(code, 'code')) {
    return { ok: false, reason: 'Invalid or unsafe error code' };
  }

  const component = record.component;
  if (typeof component !== 'string' || !isSafeDiagnosticToken(component, 'component')) {
    return { ok: false, reason: 'Invalid or unsafe component identifier' };
  }

  const proc = record.process === undefined ? defaultProcess : record.process;
  if (typeof proc !== 'string' || !(ERROR_REPORT_PROCESSES as readonly string[]).includes(proc)) {
    return { ok: false, reason: 'Invalid process identifier' };
  }

  let httpStatus: number | null = null;
  if (record.httpStatus !== undefined && record.httpStatus !== null) {
    if (
      typeof record.httpStatus !== 'number'
      || !Number.isInteger(record.httpStatus)
      || record.httpStatus < 100
      || record.httpStatus > 599
    ) {
      return { ok: false, reason: 'Invalid HTTP status' };
    }
    httpStatus = record.httpStatus;
  }

  let postgresCode: string | null = null;
  if (record.postgresCode !== undefined && record.postgresCode !== null) {
    if (typeof record.postgresCode !== 'string' || !POSTGRES_CODE_PATTERN.test(record.postgresCode)) {
      return { ok: false, reason: 'Invalid Postgres/PostgREST code' };
    }
    postgresCode = record.postgresCode;
  }

  let occurredAt: string | undefined;
  if (record.occurredAt !== undefined) {
    if (typeof record.occurredAt !== 'string' || Number.isNaN(Date.parse(record.occurredAt))) {
      return { ok: false, reason: 'Invalid occurredAt timestamp' };
    }
    occurredAt = record.occurredAt;
  }

  return {
    ok: true,
    value: {
      category: category as ErrorReportCategory,
      severity: severity as ErrorReportSeverity,
      code,
      component,
      process: proc as ErrorReportProcess,
      httpStatus,
      postgresCode,
      ...(occurredAt ? { occurredAt } : {}),
    },
  };
}

/**
 * Derive an allowlisted diagnostic code from an unknown main-process error
 * without ever reading or forwarding free-form message text or stack frames.
 */
export function classifyMainErrorCode(error: unknown, fallbackCode: string): string {
  if (error && typeof error === 'object') {
    const rawCode = (error as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      const normalized = rawCode.trim().toUpperCase();
      if (SAFE_NODE_CODES.has(normalized)) {
        return normalized;
      }
    }
  }
  return isSafeDiagnosticToken(fallbackCode, 'code') ? fallbackCode : 'MAIN_UNEXPECTED_ERROR';
}

export interface MainErrorReporterOptions {
  appVersion: string;
  packaged: boolean;
  platform?: string;
  arch?: string;
  osRelease?: string;
  electronVersion?: string | null;
  now?: () => string;
  store?: SqliteStore;
  initialEnabled?: boolean;
}

interface MemoryQueueEntry extends SanitizedErrorReportEvent {
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  createdAt: string;
}

export class MainErrorReporter {
  private readonly appVersion: string;
  private readonly packaged: boolean;
  private readonly platform: ErrorReportPlatform;
  private readonly arch: ErrorReportArch;
  private readonly osRelease: string;
  private readonly electronVersion: string | null;
  private readonly now: () => string;

  private store: SqliteStore | undefined;
  private enabled: boolean;
  private inInternalOp = false;
  private readonly memoryQueue = new Map<string, MemoryQueueEntry>();
  private readonly memoryDedupe = new Map<string, { lastReportedAt: string; suppressedCount: number }>();
  private readonly claimTimestampsMs: number[] = [];
  private lastDeliveryOutcome: LastDeliveryOutcome = 'never';
  private lastDeliveryAt: string | null = null;

  constructor(options: MainErrorReporterOptions) {
    this.appVersion = sanitizeAppVersion(options.appVersion);
    this.packaged = options.packaged === true;
    this.platform = sanitizePlatform(options.platform ?? process.platform);
    this.arch = sanitizeArch(options.arch ?? process.arch);
    this.osRelease = sanitizeOsRelease(options.osRelease ?? os.release());
    this.electronVersion = sanitizeElectronVersion(options.electronVersion ?? process.versions?.electron ?? null);
    this.now = options.now ?? (() => new Date().toISOString());
    this.enabled = options.initialEnabled ?? true;
    if (options.store) {
      this.attachStore(options.store);
    }
  }

  public attachStore(store: SqliteStore): void {
    if (this.inInternalOp) return;
    this.inInternalOp = true;
    try {
      this.store = store;
      const persistedEnabled = store.getErrorReportingEnabledMeta();
      if (persistedEnabled !== null) {
        this.enabled = persistedEnabled;
      }
      if (!this.enabled) {
        this.memoryQueue.clear();
        store.clearErrorReportQueue();
        return;
      }
      if (this.memoryQueue.size > 0) {
        const schemaVersion = store.getMigrationVersion();
        for (const entry of this.memoryQueue.values()) {
          store.enqueueErrorReport({
            fingerprint: entry.fingerprint,
            category: entry.category,
            severity: entry.severity,
            code: entry.code,
            component: entry.component,
            process: entry.process,
            appVersion: entry.appVersion,
            platform: entry.platform,
            arch: entry.arch,
            osRelease: entry.osRelease,
            electronVersion: entry.electronVersion,
            packaged: entry.packaged,
            sqliteSchemaVersion: entry.sqliteSchemaVersion ?? schemaVersion,
            httpStatus: entry.httpStatus,
            postgresCode: entry.postgresCode,
            occurredAt: entry.lastOccurredAt,
            recordedAt: entry.createdAt,
          });
        }
        this.memoryQueue.clear();
      }
    } catch {
      // Reporter persistence must never disrupt app boot.
    } finally {
      this.inInternalOp = false;
    }
  }

  public detachStore(): void {
    this.store = undefined;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    if (this.inInternalOp) return;
    this.inInternalOp = true;
    try {
      this.enabled = enabled;
      if (!enabled) {
        this.memoryQueue.clear();
      }
      if (this.store) {
        this.store.setErrorReportingEnabledMeta(enabled);
      }
    } catch {
      // Never propagate internal reporter errors.
    } finally {
      this.inInternalOp = false;
    }
  }

  public capture(raw: unknown, defaultProcess: ErrorReportProcess = 'main'): {
    accepted: boolean;
    reason?: string;
    fingerprint?: string;
  } {
    if (this.inInternalOp) {
      return { accepted: false, reason: 'reentrant_suppressed' };
    }
    if (!this.enabled) {
      return { accepted: false, reason: 'disabled' };
    }

    this.inInternalOp = true;
    try {
      const validated = validateStructuredErrorInput(raw, defaultProcess);
      if (!validated.ok) {
        return { accepted: false, reason: 'validation_rejected' };
      }
      const { value } = validated;
      // Never allow diagnostics/error-reporter self-failures to recurse.
      if (value.component.includes('error-report') || value.component.includes('diagnostics')) {
        return { accepted: false, reason: 'self_component_excluded' };
      }

      const occurredAt = roundTimestampToUtcMinute(value.occurredAt ?? null, this.now);
      const recordedAt = this.now();
      const fingerprint = computeErrorFingerprint({
        category: value.category,
        code: value.code,
        component: value.component,
        process: value.process,
        appVersion: this.appVersion,
        platform: this.platform,
      });

      if (this.store) {
        try {
          const sqliteSchemaVersion = this.store.getMigrationVersion();
          const enqueueInput: EnqueueErrorReportInput = {
            fingerprint,
            category: value.category,
            severity: value.severity,
            code: value.code,
            component: value.component,
            process: value.process,
            appVersion: this.appVersion,
            platform: this.platform,
            arch: this.arch,
            osRelease: this.osRelease,
            electronVersion: this.electronVersion,
            packaged: this.packaged,
            sqliteSchemaVersion,
            httpStatus: value.httpStatus,
            postgresCode: value.postgresCode,
            occurredAt,
            recordedAt,
          };
          const outcome = this.store.enqueueErrorReport(enqueueInput);
          return {
            accepted: outcome.accepted,
            reason: outcome.reason,
            fingerprint,
          };
        } catch {
          // Fall through to bounded in-memory queue if SQLite is closed or unavailable.
        }
      }

      return this.enqueueInMemory({
        fingerprint,
        category: value.category,
        severity: value.severity,
        code: value.code,
        component: value.component,
        process: value.process,
        appVersion: this.appVersion,
        platform: this.platform,
        arch: this.arch,
        osRelease: this.osRelease,
        electronVersion: this.electronVersion,
        packaged: this.packaged,
        sqliteSchemaVersion: null,
        httpStatus: value.httpStatus,
        postgresCode: value.postgresCode,
        occurrences: 1,
        firstOccurredAt: occurredAt,
        lastOccurredAt: occurredAt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: recordedAt,
        lastErrorCode: null,
        createdAt: recordedAt,
      });
    } catch {
      return { accepted: false, reason: 'internal_error' };
    } finally {
      this.inInternalOp = false;
    }
  }

  private enqueueInMemory(entry: MemoryQueueEntry): {
    accepted: boolean;
    reason?: string;
    fingerprint: string;
  } {
    const nowMs = Date.parse(entry.createdAt);
    const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const deduped = this.memoryDedupe.get(entry.fingerprint);
    if (deduped) {
      const lastMs = Date.parse(deduped.lastReportedAt);
      if (Number.isFinite(lastMs) && baseMs - lastMs < ERROR_REPORT_DEDUPE_COOLDOWN_MS) {
        deduped.suppressedCount = Math.min(10_000, deduped.suppressedCount + 1);
        return { accepted: false, reason: 'deduped_cooldown', fingerprint: entry.fingerprint };
      }
    }

    const existing = this.memoryQueue.get(entry.fingerprint);
    if (existing) {
      existing.occurrences = Math.min(10_000, existing.occurrences + 1);
      existing.lastOccurredAt = entry.lastOccurredAt;
      return { accepted: true, reason: 'merged_pending', fingerprint: entry.fingerprint };
    }

    if (this.memoryQueue.size >= MAX_MEMORY_QUEUE) {
      let victimKey: string | undefined;
      for (const [key, candidate] of this.memoryQueue) {
        if (candidate.status === 'failed') {
          victimKey = key;
          break;
        }
      }
      if (!victimKey) {
        victimKey = this.memoryQueue.keys().next().value;
      }
      if (victimKey) {
        this.memoryQueue.delete(victimKey);
      }
    }

    this.memoryQueue.set(entry.fingerprint, entry);
    return { accepted: true, fingerprint: entry.fingerprint };
  }

  public claimReady(limit = 3): SanitizedErrorReportEvent[] {
    if (!this.enabled || this.inInternalOp) return [];
    this.inInternalOp = true;
    try {
      const nowIso = this.now();
      const nowMs = Date.parse(nowIso);
      const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now();

      // Prune sliding rate-limit window.
      while (this.claimTimestampsMs.length > 0 && baseMs - this.claimTimestampsMs[0] >= CLAIM_WINDOW_MS) {
        this.claimTimestampsMs.shift();
      }
      const remainingBudget = MAX_CLAIMS_PER_WINDOW - this.claimTimestampsMs.length;
      if (remainingBudget <= 0) {
        return [];
      }
      const cappedLimit = Math.max(1, Math.min(3, Math.trunc(limit), remainingBudget));

      let claimed: SanitizedErrorReportEvent[] = [];
      if (this.store) {
        try {
          const rows: QueuedErrorReportRecord[] = this.store.claimErrorReports({
            limit: cappedLimit,
            now: nowIso,
          });
          claimed = rows.map((row) => this.stripInternalFields(row));
        } catch {
          claimed = [];
        }
      } else {
        for (const item of this.memoryQueue.values()) {
          if (item.status === 'pending' && item.nextAttemptAt <= nowIso) {
            claimed.push(this.stripInternalFields(item));
            if (claimed.length >= cappedLimit) break;
          }
        }
      }

      for (let i = 0; i < claimed.length; i += 1) {
        this.claimTimestampsMs.push(baseMs);
      }
      return claimed;
    } catch {
      return [];
    } finally {
      this.inInternalOp = false;
    }
  }

  private stripInternalFields(item: {
    fingerprint: string;
    category: string;
    severity: 'error' | 'warning';
    code: string;
    component: string;
    process: 'main' | 'renderer';
    appVersion: string;
    platform: string;
    arch: string;
    osRelease: string;
    electronVersion: string | null;
    packaged: boolean;
    sqliteSchemaVersion: number | null;
    httpStatus: number | null;
    postgresCode: string | null;
    occurrences: number;
    firstOccurredAt: string;
    lastOccurredAt: string;
  }): SanitizedErrorReportEvent {
    return {
      fingerprint: item.fingerprint,
      category: item.category as ErrorReportCategory,
      severity: item.severity,
      code: item.code,
      component: item.component,
      process: item.process,
      appVersion: item.appVersion,
      platform: item.platform as ErrorReportPlatform,
      arch: item.arch as ErrorReportArch,
      osRelease: item.osRelease,
      electronVersion: item.electronVersion,
      packaged: item.packaged,
      sqliteSchemaVersion: item.sqliteSchemaVersion,
      httpStatus: item.httpStatus,
      postgresCode: item.postgresCode,
      occurrences: item.occurrences,
      firstOccurredAt: item.firstOccurredAt,
      lastOccurredAt: item.lastOccurredAt,
    };
  }

  public completeDelivery(input: CompleteErrorReportInput): void {
    if (this.inInternalOp) return;
    this.inInternalOp = true;
    try {
      const nowIso = input.now ?? this.now();
      this.lastDeliveryAt = nowIso;

      if (input.outcome === 'delivered') {
        this.lastDeliveryOutcome = 'delivered';
      } else if (input.outcome === 'suppressed_remote') {
        this.lastDeliveryOutcome = 'suppressed_remote';
      } else if (input.outcome === 'disabled') {
        this.lastDeliveryOutcome = 'disabled';
        this.enabled = false;
      } else if (input.outcome === 'retry') {
        this.lastDeliveryOutcome = input.errorCode === 'RATE_LIMITED' ? 'rate_limited' : 'deferred_backoff';
      } else {
        this.lastDeliveryOutcome = 'failed';
      }

      if (this.store) {
        try {
          if (input.outcome === 'disabled') {
            this.store.setErrorReportingEnabledMeta(false);
          } else {
            this.store.completeErrorReport({ ...input, now: nowIso });
          }
          return;
        } catch {
          // Fall through to in-memory update if store is closed.
        }
      }

      if (input.outcome === 'disabled') {
        this.memoryQueue.clear();
        return;
      }
      if (input.outcome === 'delivered' || input.outcome === 'suppressed_remote') {
        this.memoryQueue.delete(input.fingerprint);
        this.memoryDedupe.set(input.fingerprint, { lastReportedAt: nowIso, suppressedCount: 0 });
        return;
      }
      const mem = this.memoryQueue.get(input.fingerprint);
      if (!mem) return;
      mem.attempts += 1;
      mem.lastErrorCode = typeof input.errorCode === 'string' ? input.errorCode : 'DELIVERY_FAILED';
      if (input.outcome === 'terminal' || mem.attempts >= MAX_ERROR_REPORT_ATTEMPTS) {
        mem.status = 'failed';
      } else {
        const delaySec = Math.max(
          Math.min(3600, 30 * (2 ** Math.min(mem.attempts, 7))),
          typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds)
            ? Math.max(30, Math.min(86_400, Math.trunc(input.retryAfterSeconds)))
            : 0,
        );
        const nowMs = Date.parse(nowIso);
        mem.nextAttemptAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + delaySec * 1000).toISOString();
      }
    } catch {
      // Never propagate internal reporter errors.
    } finally {
      this.inInternalOp = false;
    }
  }

  public getStatusSummary(): ErrorReportingStatusSummary {
    let queueSummary: ErrorReportQueueSummary = {
      pendingCount: 0,
      failedCount: 0,
      suppressedCount: 0,
      sqliteSchemaVersion: 0,
    };

    if (this.store) {
      try {
        queueSummary = this.store.getErrorReportQueueSummary();
      } catch {
        // Fallback to memory counts below.
      }
    } else {
      for (const item of this.memoryQueue.values()) {
        if (item.status === 'pending') queueSummary.pendingCount += 1;
        if (item.status === 'failed') queueSummary.failedCount += 1;
      }
      for (const deduped of this.memoryDedupe.values()) {
        queueSummary.suppressedCount += deduped.suppressedCount;
      }
    }

    return {
      enabled: this.enabled,
      pendingCount: queueSummary.pendingCount,
      failedCount: queueSummary.failedCount,
      suppressedCount: queueSummary.suppressedCount,
      lastDeliveryOutcome: this.lastDeliveryOutcome,
      lastDeliveryAt: this.lastDeliveryAt,
    };
  }
}
