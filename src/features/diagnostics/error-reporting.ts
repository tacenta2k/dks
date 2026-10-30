import { resolveAppVersion } from '../../lib/app-info';
import { getSupabaseConfig } from '../../lib/supabase';
import type {
  DksDiagnosticsApi,
  DksErrorReportCategory,
  DksErrorReportingStatusSummary,
  DksErrorReportSeverity,
  DksSanitizedErrorReportEvent,
  DksStructuredErrorReportInput,
} from '../../lib/types';

export const ALLOWED_REPORT_CATEGORIES: readonly DksErrorReportCategory[] = [
  'auth',
  'sync',
  'sqlite',
  'ipc',
  'updater',
  'renderer',
  'main',
  'settings',
  'network',
];

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

const ALLOWED_OUTBOUND_KEYS = new Set([
  'fingerprint',
  'category',
  'severity',
  'code',
  'component',
  'process',
  'appVersion',
  'platform',
  'arch',
  'osRelease',
  'electronVersion',
  'packaged',
  'sqliteSchemaVersion',
  'httpStatus',
  'postgresCode',
  'occurrences',
  'firstOccurredAt',
  'lastOccurredAt',
]);

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{1,63}$/;
const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9_.:/-]{1,63}$/;
const POSTGRES_CODE_PATTERN = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;
const UUID_SUBSTRING = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIGIT_RUN = /[0-9]{7,}/;
const PATH_PREFIX = /^(?:[a-zA-Z]:|\/Users\/|\/home\/|\\\\|~\/|\.\.\/)/;
const JWT_LIKE = /^eyJ[A-Za-z0-9_-]{8,}/;

const OFFLINE_MESSAGE_RE =
  /failed to fetch|fetch failed|networkerror|network request failed|network error|load failed|timed? ?out|timeout|econn(reset|refused|aborted)|enotfound|eai_again|etimedout|err_internet_disconnected|err_network|err_name_not_resolved|err_connection|socket hang up|offline/i;

const DEDUPE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 6;
const MAX_FALLBACK_QUEUE = 25;
const MAX_ATTEMPTS = 6;
const DEFAULT_FLUSH_TIMEOUT_MS = 8_000;

export function isRoutineOfflineError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'string') {
    return OFFLINE_MESSAGE_RE.test(error);
  }
  if (typeof error === 'object') {
    const record = error as { message?: unknown; name?: unknown; status?: unknown; code?: unknown };
    if (record.status === 0 || record.code === 'RESTORE_UNREACHABLE') return true;
    if (typeof record.name === 'string' && (record.name === 'AbortError' || record.name === 'AuthRetryableFetchError')) {
      return true;
    }
    if (typeof record.message === 'string' && OFFLINE_MESSAGE_RE.test(record.message)) {
      return true;
    }
  }
  return false;
}

export function extractSafePostgresCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const raw = (error as { code?: unknown }).code;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  return POSTGRES_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

export function extractSafeHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const raw = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) {
    return raw;
  }
  return null;
}

export function isSafeReportToken(value: string, kind: 'code' | 'component'): boolean {
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

export function roundToUtcMinuteIso(raw?: string | Date | null): string {
  const parsed = raw instanceof Date
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? new Date(raw)
      : new Date();
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const rounded = new Date(Date.UTC(
    safe.getUTCFullYear(),
    safe.getUTCMonth(),
    safe.getUTCDate(),
    safe.getUTCHours(),
    safe.getUTCMinutes(),
    0,
    0,
  ));
  return rounded.toISOString().replace('.000Z', 'Z');
}

/**
 * Lightweight deterministic 32-hex hash used only when Electron preload is not
 * available (browser/unit-test fallback). In Electron, main computes SHA-256.
 */
function fallbackFingerprintHex(canonical: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < canonical.length; i += 1) {
    const code = canonical.charCodeAt(i);
    for (let s = 0; s < seeds.length; s += 1) {
      let h = seeds[s] ^ (code + s * 31);
      h = Math.imul(h, 0x01000193);
      seeds[s] = h >>> 0;
    }
  }
  return seeds.map((v) => v.toString(16).padStart(8, '0')).join('');
}

export function validateRendererErrorInput(
  raw: unknown,
): { ok: true; value: DksStructuredErrorReportInput } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'Report input must be an object' };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return { ok: false, reason: `Disallowed key: ${key}` };
    }
  }
  const category = record.category;
  if (typeof category !== 'string' || !(ALLOWED_REPORT_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, reason: 'Invalid category' };
  }
  const severity = record.severity;
  if (severity !== 'error' && severity !== 'warning') {
    return { ok: false, reason: 'Invalid severity' };
  }
  const code = record.code;
  if (typeof code !== 'string' || !isSafeReportToken(code, 'code')) {
    return { ok: false, reason: 'Invalid or unsafe code' };
  }
  const component = record.component;
  if (typeof component !== 'string' || !isSafeReportToken(component, 'component')) {
    return { ok: false, reason: 'Invalid or unsafe component' };
  }
  if (component.includes('error-report') || component.includes('diagnostics')) {
    return { ok: false, reason: 'Self-component excluded' };
  }
  const proc = record.process === undefined ? 'renderer' : record.process;
  if (proc !== 'main' && proc !== 'renderer') {
    return { ok: false, reason: 'Invalid process' };
  }
  let httpStatus: number | null = null;
  if (record.httpStatus !== undefined && record.httpStatus !== null) {
    if (
      typeof record.httpStatus !== 'number'
      || !Number.isInteger(record.httpStatus)
      || record.httpStatus < 100
      || record.httpStatus > 599
    ) {
      return { ok: false, reason: 'Invalid httpStatus' };
    }
    httpStatus = record.httpStatus;
  }
  let postgresCode: string | null = null;
  if (record.postgresCode !== undefined && record.postgresCode !== null) {
    if (typeof record.postgresCode !== 'string' || !POSTGRES_CODE_PATTERN.test(record.postgresCode)) {
      return { ok: false, reason: 'Invalid postgresCode' };
    }
    postgresCode = record.postgresCode;
  }
  let occurredAt: string | undefined;
  if (record.occurredAt !== undefined) {
    if (typeof record.occurredAt !== 'string' || Number.isNaN(Date.parse(record.occurredAt))) {
      return { ok: false, reason: 'Invalid occurredAt' };
    }
    occurredAt = record.occurredAt;
  }
  return {
    ok: true,
    value: {
      category: category as DksErrorReportCategory,
      severity: severity as DksErrorReportSeverity,
      code,
      component,
      process: proc,
      httpStatus,
      postgresCode,
      ...(occurredAt ? { occurredAt } : {}),
    },
  };
}

export function buildOutboundReportPayload(
  event: DksSanitizedErrorReportEvent,
): Record<string, unknown> | null {
  const record = event as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_OUTBOUND_KEYS.has(key)) {
      return null;
    }
  }
  if (
    typeof event.fingerprint !== 'string'
    || !/^[0-9a-f]{32,64}$/.test(event.fingerprint)
    || !isSafeReportToken(event.code, 'code')
    || !isSafeReportToken(event.component, 'component')
  ) {
    return null;
  }
  return {
    fingerprint: event.fingerprint,
    category: event.category,
    severity: event.severity,
    code: event.code,
    component: event.component,
    process: event.process,
    appVersion: event.appVersion,
    platform: event.platform,
    arch: event.arch,
    osRelease: event.osRelease,
    electronVersion: event.electronVersion,
    packaged: event.packaged,
    sqliteSchemaVersion: event.sqliteSchemaVersion,
    httpStatus: event.httpStatus,
    postgresCode: event.postgresCode,
    occurrences: event.occurrences,
    firstOccurredAt: roundToUtcMinuteIso(event.firstOccurredAt),
    lastOccurredAt: roundToUtcMinuteIso(event.lastOccurredAt),
  };
}

export interface ErrorReportingSessionContext {
  accessToken: string | null;
  role: 'admin' | 'office' | null;
  sessionCleared: boolean;
}

export interface ErrorReportingControllerOptions {
  diagnosticsApi?: DksDiagnosticsApi | null;
  fetchImpl?: typeof fetch;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  appVersion?: string;
  platform?: 'win32' | 'darwin' | 'linux' | 'unknown';
  now?: () => number;
  flushTimeoutMs?: number;
  isOnline?: () => boolean;
}

interface FallbackQueueItem {
  event: DksSanitizedErrorReportEvent;
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptMs: number;
}

export class ErrorReportingController {
  private readonly getDiagnosticsApi: () => DksDiagnosticsApi | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly supabaseUrl: string | undefined;
  private readonly supabaseAnonKey: string | undefined;
  private readonly appVersion: string;
  private readonly platform: 'win32' | 'darwin' | 'linux' | 'unknown';
  private readonly now: () => number;
  private readonly flushTimeoutMs: number;
  private readonly isOnline: () => boolean;

  private enabled = true;
  private inReport = false;
  private flushing = false;
  private session: ErrorReportingSessionContext = {
    accessToken: null,
    role: null,
    sessionCleared: false,
  };

  private readonly fallbackQueue = new Map<string, FallbackQueueItem>();
  private readonly fallbackDedupe = new Map<string, { lastReportedMs: number; suppressedCount: number }>();
  private readonly fallbackSendTimestamps: number[] = [];
  private fallbackLastOutcome: DksErrorReportingStatusSummary['lastDeliveryOutcome'] = 'never';
  private fallbackLastAt: string | null = null;

  constructor(options: ErrorReportingControllerOptions = {}) {
    this.getDiagnosticsApi = () => {
      if (options.diagnosticsApi !== undefined) {
        return options.diagnosticsApi ?? undefined;
      }
      return typeof window !== 'undefined' ? window.dks?.diagnostics : undefined;
    };
    this.fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    const cfg = getSupabaseConfig();
    this.supabaseUrl = options.supabaseUrl ?? cfg?.url;
    this.supabaseAnonKey = options.supabaseAnonKey ?? cfg?.publishableKey;
    this.appVersion = options.appVersion ?? resolveAppVersion();
    const rawPlat = options.platform ?? (typeof window !== 'undefined' ? window.dks?.platform : undefined);
    this.platform = rawPlat === 'win32' || rawPlat === 'darwin' || rawPlat === 'linux' ? rawPlat : 'unknown';
    this.now = options.now ?? (() => Date.now());
    this.flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setSessionContext(context: ErrorReportingSessionContext): void {
    this.session = { ...context };
  }

  public async setEnabledByAdmin(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.fallbackQueue.clear();
    }
    const api = this.getDiagnosticsApi();
    if (api && this.session.role === 'admin') {
      try {
        await api.setErrorReportingEnabled({ role: 'admin', enabled });
      } catch {
        // Never block settings UI on local IPC diagnostics sync.
      }
    }
  }

  public async syncWorkspacePreference(enabled: boolean, role: 'admin' | 'office' | null): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.fallbackQueue.clear();
    }
    const api = this.getDiagnosticsApi();
    if (api && (role === 'admin' || role === 'office')) {
      try {
        await api.syncWorkspaceErrorReporting({ role, enabled });
      } catch {
        // Non-fatal.
      }
    }
  }

  /**
   * Capture a structured, allowlisted error or warning in the background.
   * Never throws, never blocks UI/sync/saves, and prevents recursive reporting.
   */
  public report(raw: DksStructuredErrorReportInput): Promise<{ accepted: boolean; reason?: string }> {
    if (this.inReport) {
      return Promise.resolve({ accepted: false, reason: 'reentrant_suppressed' });
    }
    if (!this.enabled) {
      return Promise.resolve({ accepted: false, reason: 'disabled' });
    }

    this.inReport = true;
    try {
      const validated = validateRendererErrorInput(raw);
      if (!validated.ok) {
        return Promise.resolve({ accepted: false, reason: 'validation_rejected' });
      }

      const api = this.getDiagnosticsApi();
      if (api) {
        return api.captureError(validated.value)
          .then((res) => {
            if (res.accepted) {
              this.scheduleBackgroundFlush();
            }
            return res;
          })
          .catch(() => ({ accepted: false, reason: 'ipc_error' }));
      }

      const outcome = this.enqueueFallback(validated.value);
      if (outcome.accepted) {
        this.scheduleBackgroundFlush();
      }
      return Promise.resolve(outcome);
    } catch {
      return Promise.resolve({ accepted: false, reason: 'internal_error' });
    } finally {
      this.inReport = false;
    }
  }

  private enqueueFallback(value: DksStructuredErrorReportInput): { accepted: boolean; reason?: string } {
    const nowMs = this.now();
    const occurredAt = roundToUtcMinuteIso(value.occurredAt ?? new Date(nowMs));
    const canonical = [
      value.category,
      value.code,
      value.component,
      value.process ?? 'renderer',
      this.appVersion,
      this.platform,
    ].join('|');
    const fingerprint = fallbackFingerprintHex(canonical);

    const dedupe = this.fallbackDedupe.get(fingerprint);
    if (dedupe && nowMs - dedupe.lastReportedMs < DEDUPE_COOLDOWN_MS) {
      dedupe.suppressedCount = Math.min(10_000, dedupe.suppressedCount + 1);
      return { accepted: false, reason: 'deduped_cooldown' };
    }

    const existing = this.fallbackQueue.get(fingerprint);
    if (existing) {
      existing.event.occurrences = Math.min(10_000, existing.event.occurrences + 1);
      existing.event.lastOccurredAt = occurredAt;
      return { accepted: true, reason: 'merged_pending' };
    }

    if (this.fallbackQueue.size >= MAX_FALLBACK_QUEUE) {
      let victimKey: string | undefined;
      for (const [key, item] of this.fallbackQueue) {
        if (item.status === 'failed') {
          victimKey = key;
          break;
        }
      }
      if (!victimKey) {
        victimKey = this.fallbackQueue.keys().next().value;
      }
      if (victimKey) this.fallbackQueue.delete(victimKey);
    }

    this.fallbackQueue.set(fingerprint, {
      event: {
        fingerprint,
        category: value.category,
        severity: value.severity,
        code: value.code,
        component: value.component,
        process: value.process ?? 'renderer',
        appVersion: this.appVersion,
        platform: this.platform,
        arch: 'unknown',
        osRelease: '0.0.0',
        electronVersion: null,
        packaged: false,
        sqliteSchemaVersion: null,
        httpStatus: value.httpStatus ?? null,
        postgresCode: value.postgresCode ?? null,
        occurrences: 1,
        firstOccurredAt: occurredAt,
        lastOccurredAt: occurredAt,
      },
      status: 'pending',
      attempts: 0,
      nextAttemptMs: nowMs,
    });
    return { accepted: true };
  }

  private scheduleBackgroundFlush(): void {
    if (!this.enabled || !this.session.sessionCleared || !this.session.accessToken) {
      return;
    }
    const timer = setTimeout(() => {
      void this.flushPending();
    }, 50);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  public async flushPending(): Promise<{ attempted: number; delivered: number }> {
    if (this.flushing || !this.enabled) {
      return { attempted: 0, delivered: 0 };
    }
    if (
      !this.session.sessionCleared
      || !this.session.accessToken
      || (this.session.role !== 'admin' && this.session.role !== 'office')
    ) {
      return { attempted: 0, delivered: 0 };
    }
    if (!this.supabaseUrl || !this.supabaseAnonKey || !this.fetchImpl) {
      return { attempted: 0, delivered: 0 };
    }
    if (!this.isOnline()) {
      return { attempted: 0, delivered: 0 };
    }

    this.flushing = true;
    let attempted = 0;
    let delivered = 0;

    try {
      const api = this.getDiagnosticsApi();
      const role = this.session.role;
      const batch = api
        ? await api.claimErrorReports({ role, limit: 3 }).catch(() => [] as DksSanitizedErrorReportEvent[])
        : this.claimFallbackBatch(3);

      for (const item of batch) {
        if (!this.enabled) break;
        const payload = buildOutboundReportPayload(item);
        if (!payload) {
          await this.recordOutcome(api, role, item.fingerprint, 'terminal', 'INVALID_PAYLOAD', null);
          continue;
        }

        attempted += 1;
        const delivery = await this.deliverSingleReport(payload, this.session.accessToken);
        if (delivery.outcome === 'delivered' || delivery.outcome === 'suppressed_remote') {
          delivered += 1;
        }
        await this.recordOutcome(
          api,
          role,
          item.fingerprint,
          delivery.outcome,
          delivery.errorCode ?? null,
          delivery.retryAfterSeconds ?? null,
        );
        if (delivery.outcome === 'disabled' || delivery.errorCode === 'RATE_LIMITED') {
          break;
        }
      }
    } catch {
      // Never propagate background reporter flush failures.
    } finally {
      this.flushing = false;
    }

    return { attempted, delivered };
  }

  private claimFallbackBatch(limit: number): DksSanitizedErrorReportEvent[] {
    const nowMs = this.now();
    while (this.fallbackSendTimestamps.length > 0 && nowMs - this.fallbackSendTimestamps[0] >= RATE_WINDOW_MS) {
      this.fallbackSendTimestamps.shift();
    }
    const remainingBudget = MAX_REPORTS_PER_WINDOW - this.fallbackSendTimestamps.length;
    if (remainingBudget <= 0) return [];
    const cap = Math.min(limit, remainingBudget);
    const out: DksSanitizedErrorReportEvent[] = [];
    for (const item of this.fallbackQueue.values()) {
      if (item.status === 'pending' && item.nextAttemptMs <= nowMs) {
        out.push({ ...item.event });
        this.fallbackSendTimestamps.push(nowMs);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  private async recordOutcome(
    api: DksDiagnosticsApi | undefined,
    role: 'admin' | 'office',
    fingerprint: string,
    outcome: 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal',
    errorCode: string | null,
    retryAfterSeconds: number | null,
  ): Promise<void> {
    if (outcome === 'disabled') {
      this.enabled = false;
      this.fallbackQueue.clear();
    }

    if (api) {
      try {
        await api.completeErrorReport({
          role,
          fingerprint,
          outcome,
          errorCode,
          retryAfterSeconds,
        });
      } catch {
        // Ignore IPC errors on shutdown.
      }
      return;
    }

    const nowMs = this.now();
    this.fallbackLastAt = new Date(nowMs).toISOString();
    if (outcome === 'delivered') {
      this.fallbackLastOutcome = 'delivered';
      this.fallbackQueue.delete(fingerprint);
      this.fallbackDedupe.set(fingerprint, { lastReportedMs: nowMs, suppressedCount: 0 });
    } else if (outcome === 'suppressed_remote') {
      this.fallbackLastOutcome = 'suppressed_remote';
      this.fallbackQueue.delete(fingerprint);
      this.fallbackDedupe.set(fingerprint, { lastReportedMs: nowMs, suppressedCount: 0 });
    } else if (outcome === 'disabled') {
      this.fallbackLastOutcome = 'disabled';
      this.fallbackQueue.clear();
    } else {
      const entry = this.fallbackQueue.get(fingerprint);
      if (!entry) return;
      entry.attempts += 1;
      if (outcome === 'terminal' || entry.attempts >= MAX_ATTEMPTS) {
        entry.status = 'failed';
        this.fallbackLastOutcome = 'failed';
      } else {
        const computedSec = Math.min(3600, 30 * (2 ** Math.min(entry.attempts, 7)));
        const delaySec = Math.max(computedSec, retryAfterSeconds ?? 0);
        entry.nextAttemptMs = nowMs + delaySec * 1000;
        this.fallbackLastOutcome = errorCode === 'RATE_LIMITED' ? 'rate_limited' : 'deferred_backoff';
      }
    }
  }

  private async deliverSingleReport(
    payload: Record<string, unknown>,
    accessToken: string,
  ): Promise<{
    outcome: 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal';
    errorCode?: string;
    retryAfterSeconds?: number;
  }> {
    if (!this.fetchImpl || !this.supabaseUrl || !this.supabaseAnonKey) {
      return { outcome: 'retry', errorCode: 'UNCONFIGURED' };
    }
    const endpoint = `${this.supabaseUrl.replace(/\/+$/, '')}/functions/v1/report-error`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.flushTimeoutMs);

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.supabaseAnonKey,
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const retryHeader = response.headers.get('retry-after');
      const parsedRetryHeader = retryHeader && /^[0-9]{1,6}$/.test(retryHeader.trim())
        ? Number(retryHeader.trim())
        : undefined;

      let body: Record<string, unknown> | null = null;
      try {
        const json = await response.json();
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          body = json as Record<string, unknown>;
        }
      } catch {
        body = null;
      }

      const retryAfterSeconds = typeof body?.retryAfterSeconds === 'number'
        ? body.retryAfterSeconds
        : parsedRetryHeader;

      if (response.ok) {
        const action = typeof body?.action === 'string' ? body.action : 'issue_created';
        if (action === 'disabled') {
          return { outcome: 'disabled' };
        }
        if (action === 'deduped') {
          return { outcome: 'suppressed_remote' };
        }
        if (action === 'rate_limited_user' || action === 'rate_limited_github') {
          return {
            outcome: 'retry',
            errorCode: 'RATE_LIMITED',
            retryAfterSeconds: retryAfterSeconds ?? 600,
          };
        }
        return { outcome: 'delivered' };
      }

      if (response.status === 429) {
        return {
          outcome: 'retry',
          errorCode: 'RATE_LIMITED',
          retryAfterSeconds: retryAfterSeconds ?? 600,
        };
      }
      if (response.status === 400 || response.status === 413 || response.status === 422) {
        return { outcome: 'terminal', errorCode: 'SERVER_VALIDATION_REJECTED' };
      }
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'retry', errorCode: 'AUTH_REJECTED', retryAfterSeconds: 300 };
      }
      return { outcome: 'retry', errorCode: 'SERVER_ERROR' };
    } catch {
      return { outcome: 'retry', errorCode: 'NETWORK_ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }

  public getFallbackSummary(): DksErrorReportingStatusSummary {
    let pendingCount = 0;
    let failedCount = 0;
    let suppressedCount = 0;
    for (const item of this.fallbackQueue.values()) {
      if (item.status === 'pending') pendingCount += 1;
      if (item.status === 'failed') failedCount += 1;
    }
    for (const dedupe of this.fallbackDedupe.values()) {
      suppressedCount += dedupe.suppressedCount;
    }
    return {
      enabled: this.enabled,
      pendingCount,
      failedCount,
      suppressedCount,
      lastDeliveryOutcome: this.fallbackLastOutcome,
      lastDeliveryAt: this.fallbackLastAt,
    };
  }
}

export const defaultErrorReporter = new ErrorReportingController();

export interface GlobalErrorTarget {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
}

/**
 * Attach window-level error and unhandled-rejection observers without calling
 * preventDefault(), preserving standard console/devtools error visibility.
 */
export function installGlobalRendererErrorHandlers(
  controller: Pick<ErrorReportingController, 'report'> = defaultErrorReporter,
  target?: GlobalErrorTarget | null,
): () => void {
  const win = target === undefined
    ? (typeof window !== 'undefined' ? (window as unknown as GlobalErrorTarget) : null)
    : target;
  if (!win) {
    return () => undefined;
  }

  const onError = (): void => {
    void controller.report({
      category: 'renderer',
      severity: 'error',
      code: 'RENDERER_UNCAUGHT_ERROR',
      component: 'renderer/window',
      process: 'renderer',
    });
  };

  const onUnhandledRejection = (event: unknown): void => {
    const reason = event && typeof event === 'object' && 'reason' in event
      ? (event as { reason?: unknown }).reason
      : undefined;
    if (isRoutineOfflineError(reason)) {
      return;
    }
    void controller.report({
      category: 'renderer',
      severity: 'error',
      code: 'RENDERER_UNHANDLED_REJECTION',
      component: 'renderer/promise',
      process: 'renderer',
      httpStatus: extractSafeHttpStatus(reason),
      postgresCode: extractSafePostgresCode(reason),
    });
  };

  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
