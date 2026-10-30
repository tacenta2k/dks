import { getSupabaseConfig } from '../../lib/supabase';
import type { DksAdminLocalStatus } from '../../lib/types';
import { roundToUtcMinuteIso } from './error-reporting';

export type ConnectivityCheckStatus =
  | 'not_checked'
  | 'checking'
  | 'reachable'
  | 'unreachable'
  | 'unconfigured'
  | 'unknown';

export interface EndpointCheckResult {
  status: ConnectivityCheckStatus;
  latencyMs: number | null;
  httpStatus: number | null;
  checkedAt: string | null;
}

export interface SupabaseConnectivityReport {
  configured: boolean;
  authEndpoint: EndpointCheckResult;
  databaseRlsRead: EndpointCheckResult;
  backgroundWorkers: {
    status: 'unknown';
    reason: 'not_probed_from_desktop';
  };
}

export function createInitialConnectivityReport(configured?: boolean): SupabaseConnectivityReport {
  const cfg = getSupabaseConfig();
  const isConfigured = configured ?? Boolean(cfg?.url && cfg?.publishableKey);
  const initialStatus: ConnectivityCheckStatus = isConfigured ? 'not_checked' : 'unconfigured';
  return {
    configured: isConfigured,
    authEndpoint: {
      status: initialStatus,
      latencyMs: null,
      httpStatus: null,
      checkedAt: null,
    },
    databaseRlsRead: {
      status: initialStatus,
      latencyMs: null,
      httpStatus: null,
      checkedAt: null,
    },
    backgroundWorkers: {
      status: 'unknown',
      reason: 'not_probed_from_desktop',
    },
  };
}

export interface ConnectivityQueryClient {
  from: (table: string) => {
    select: (columns: string) => {
      limit?: (count: number) => PromiseLike<{ data: unknown; error: { message?: string; code?: string; status?: number } | null }>;
    } & PromiseLike<{ data: unknown; error: { message?: string; code?: string; status?: number } | null }>;
  };
}

export interface RunConnectivityChecksOptions {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  accessToken?: string | null;
  dataClient?: ConnectivityQueryClient | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 5_000;

async function probeAuthEndpoint(options: {
  url: string;
  anonKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  now: () => Date;
}): Promise<EndpointCheckResult> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();

  try {
    const endpoint = `${options.url.replace(/\/+$/, '')}/auth/v1/health`;
    const response = await options.fetchImpl(endpoint, {
      method: 'GET',
      headers: { apikey: options.anonKey },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Date.now() - started);
    const checkedAt = options.now().toISOString();
    return {
      status: response.ok ? 'reachable' : 'unreachable',
      latencyMs,
      httpStatus: response.status,
      checkedAt,
    };
  } catch {
    return {
      status: 'unreachable',
      latencyMs: Math.max(0, Date.now() - started),
      httpStatus: null,
      checkedAt: options.now().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    options.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

async function probeDatabaseRead(options: {
  url: string;
  anonKey: string;
  accessToken?: string | null;
  dataClient?: ConnectivityQueryClient | null;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  now: () => Date;
}): Promise<EndpointCheckResult> {
  const started = Date.now();

  if (options.dataClient) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const baseQuery = options.dataClient.from('settings').select('key');
      const queryPromise = typeof baseQuery.limit === 'function'
        ? Promise.resolve(baseQuery.limit(1))
        : Promise.resolve(baseQuery);
      const timeoutPromise = new Promise<{ data: null; error: { message: string; status?: number } }>((resolve) => {
        timer = setTimeout(() => resolve({ data: null, error: { message: 'timeout' } }), options.timeoutMs);
      });
      const result = await Promise.race([queryPromise, timeoutPromise]);
      const latencyMs = Math.max(0, Date.now() - started);
      const checkedAt = options.now().toISOString();
      const httpStatus = typeof result.error?.status === 'number' ? result.error.status : (result.error ? null : 200);
      return {
        status: result.error ? 'unreachable' : 'reachable',
        latencyMs,
        httpStatus,
        checkedAt,
      };
    } catch {
      return {
        status: 'unreachable',
        latencyMs: Math.max(0, Date.now() - started),
        httpStatus: null,
        checkedAt: options.now().toISOString(),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (!options.accessToken || !options.fetchImpl) {
    return {
      status: 'not_checked',
      latencyMs: null,
      httpStatus: null,
      checkedAt: null,
    };
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const endpoint = `${options.url.replace(/\/+$/, '')}/rest/v1/settings?select=key&limit=1`;
    const response = await options.fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        apikey: options.anonKey,
        authorization: `Bearer ${options.accessToken}`,
      },
      signal: controller.signal,
    });
    return {
      status: response.ok ? 'reachable' : 'unreachable',
      latencyMs: Math.max(0, Date.now() - started),
      httpStatus: response.status,
      checkedAt: options.now().toISOString(),
    };
  } catch {
    return {
      status: 'unreachable',
      latencyMs: Math.max(0, Date.now() - started),
      httpStatus: null,
      checkedAt: options.now().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    options.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export async function runSupabaseConnectivityChecks(
  options: RunConnectivityChecksOptions = {},
): Promise<SupabaseConnectivityReport> {
  const cfg = getSupabaseConfig();
  const url = options.supabaseUrl ?? cfg?.url;
  const anonKey = options.supabaseAnonKey ?? cfg?.publishableKey;
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  if (!url || !anonKey) {
    return createInitialConnectivityReport(false);
  }

  const [authEndpoint, databaseRlsRead] = await Promise.all([
    fetchImpl
      ? probeAuthEndpoint({
        url,
        anonKey,
        fetchImpl,
        timeoutMs,
        parentSignal: options.signal,
        now,
      })
      : Promise.resolve<EndpointCheckResult>({
        status: 'not_checked',
        latencyMs: null,
        httpStatus: null,
        checkedAt: null,
      }),
    probeDatabaseRead({
      url,
      anonKey,
      accessToken: options.accessToken,
      dataClient: options.dataClient,
      fetchImpl,
      timeoutMs,
      parentSignal: options.signal,
      now,
    }),
  ]);

  return {
    configured: true,
    authEndpoint,
    databaseRlsRead,
    backgroundWorkers: {
      status: 'unknown',
      reason: 'not_probed_from_desktop',
    },
  };
}

function safeToken(raw: unknown, pattern: RegExp, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return pattern.test(trimmed) ? trimmed : fallback;
}

function safeNonNegInt(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
}

/**
 * Produce a strictly allowlisted plain-text diagnostics block for clipboard
 * sharing. Contains zero customer data, emails, user IDs, row IDs, URLs,
 * tokens, filesystem paths, or raw error messages.
 */
export function formatSanitizedDiagnosticsText(input: {
  local: DksAdminLocalStatus;
  connectivity: SupabaseConnectivityReport;
  generatedAt?: string | Date;
}): string {
  const { local, connectivity } = input;
  const version = safeToken(
    local.appVersion.replace(/^v/i, ''),
    /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/,
    '0.0.0',
  );
  const platform = safeToken(local.platform, /^(?:win32|darwin|linux|unknown)$/, 'unknown');
  const arch = safeToken(local.arch, /^(?:x64|arm64|ia32|unknown)$/, 'unknown');
  const osRelease = safeToken(local.osRelease, /^[0-9]{1,4}(?:\.[0-9]{1,6}){0,3}$/, '0.0.0');
  const electronVer = local.electronVersion
    ? safeToken(local.electronVersion, /^[0-9]{1,4}(?:\.[0-9]{1,6}){1,3}$/, 'unknown')
    : 'none';
  const storeFailure = local.localStore.failureCode
    ? safeToken(local.localStore.failureCode, /^(?:ABI_MISMATCH|OPEN_FAILED)$/, 'OPEN_FAILED')
    : 'none';
  const syncStatus = safeToken(
    local.sync.status,
    /^(?:offline|syncing|healthy|error|unknown)$/,
    'unknown',
  );
  const lastSync = local.sync.lastSyncAt ? roundToUtcMinuteIso(local.sync.lastSyncAt) : 'never';
  const updaterStatus = safeToken(
    local.updater.status,
    /^(?:idle|checking|available|downloading|downloaded|not-available|error|disabled)$/,
    'unknown',
  );
  const updaterErrorCode = local.updater.errorCode
    ? safeToken(local.updater.errorCode, /^[A-Z0-9_.:-]{2,64}$/, 'UPDATER_ERROR')
    : 'none';

  const authStatus = safeToken(
    connectivity.authEndpoint.status,
    /^(?:not_checked|checking|reachable|unreachable|unconfigured|unknown)$/,
    'not_checked',
  );
  const dbStatus = safeToken(
    connectivity.databaseRlsRead.status,
    /^(?:not_checked|checking|reachable|unreachable|unconfigured|unknown)$/,
    'not_checked',
  );
  const deliveryOutcome = safeToken(
    local.errorReporting.lastDeliveryOutcome,
    /^(?:never|delivered|suppressed_remote|deferred_backoff|rate_limited|disabled|failed)$/,
    'never',
  );

  const lines = [
    'DKS Sanitized Diagnostics',
    `generated_at_utc: ${roundToUtcMinuteIso(input.generatedAt ?? new Date())}`,
    `app_version: ${version}`,
    `build_mode: ${local.packaged ? 'packaged' : 'development'}`,
    `os_platform: ${platform}`,
    `os_arch: ${arch}`,
    `os_release: ${osRelease}`,
    `electron_version: ${electronVer}`,
    `local_store_available: ${String(Boolean(local.localStore.available))}`,
    `local_store_schema_version: ${local.localStore.schemaVersion !== null ? safeNonNegInt(local.localStore.schemaVersion) : 'none'}`,
    `local_store_failure_code: ${storeFailure}`,
    `sync_status: ${syncStatus}`,
    `sync_last_success_utc: ${lastSync}`,
    `outbox_pending_count: ${safeNonNegInt(local.sync.pendingOutboxCount)}`,
    `outbox_failed_count: ${safeNonNegInt(local.sync.failedOutboxCount)}`,
    `outbox_terminal_count: ${safeNonNegInt(local.sync.terminalOutboxCount)}`,
    `updater_status: ${updaterStatus}`,
    `updater_error_code: ${updaterErrorCode}`,
    `supabase_configured: ${String(Boolean(connectivity.configured))}`,
    `supabase_auth_reachability: ${authStatus}`,
    `supabase_db_rls_reachability: ${dbStatus}`,
    'backend_workers_health: not_checked_from_pc (server-side — not probed from desktop)',
    `error_reporting_enabled: ${String(Boolean(local.errorReporting.enabled))}`,
    `error_queue_pending: ${safeNonNegInt(local.errorReporting.pendingCount)}`,
    `error_queue_failed: ${safeNonNegInt(local.errorReporting.failedCount)}`,
    `error_duplicates_suppressed: ${safeNonNegInt(local.errorReporting.suppressedCount)}`,
    `error_last_delivery_outcome: ${deliveryOutcome}`,
    'note: Endpoint reachability reflects point-in-time connectivity only and does not prove full backend health.',
  ];

  return lines.join('\n');
}
