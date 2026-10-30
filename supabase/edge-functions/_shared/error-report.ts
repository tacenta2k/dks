/**
 * Shared validation, formatting, rate-limit handling, and request orchestration
 * for the `report-error` Supabase Edge Function.
 *
 * Security invariants:
 *  - Assume the target GitHub repository is PUBLIC (`tacenta2k/dks`).
 *  - Accept ONLY a fixed allowlist of structured, non-identifying diagnostic
 *    fields; reject unknown keys and any token resembling emails, UUIDs, paths,
 *    URLs, JWTs, or identifier digit sequences.
 *  - Enforce hard byte limits before JSON parsing.
 *  - Require an authenticated, approved DKS user JWT verified by PostgreSQL
 *    (`verify_error_report_caller`).
 *  - Enforce server-side per-user and global GitHub mutation rate limits in
 *    PostgreSQL (`ingest_error_report`) plus GitHub `Retry-After` / secondary
 *    rate-limit backoff.
 */

export const MAX_ERROR_REPORT_BYTES = 4_096;

export const ALLOWED_CATEGORIES = [
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

export type ServerErrorCategory = (typeof ALLOWED_CATEGORIES)[number];

export interface ValidatedErrorReportPayload {
  fingerprint: string;
  category: ServerErrorCategory;
  severity: 'error' | 'warning';
  code: string;
  component: string;
  process: 'main' | 'renderer';
  appVersion: string;
  platform: 'win32' | 'darwin' | 'linux' | 'unknown';
  arch: 'x64' | 'arm64' | 'ia32' | 'unknown';
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

const ALLOWED_PAYLOAD_KEYS = new Set([
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

const FINGERPRINT_RE = /^[0-9a-f]{32,64}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9_.:-]{1,63}$/;
const COMPONENT_RE = /^[a-z0-9][a-z0-9_.:/-]{1,63}$/;
const APP_VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const OS_RELEASE_RE = /^[0-9]{1,4}(?:\.[0-9]{1,6}){0,3}$/;
const ELECTRON_VERSION_RE = /^[0-9]{1,4}(?:\.[0-9]{1,6}){1,3}$/;
const POSTGRES_CODE_RE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const JWT_COMPACT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const UUID_SUBSTRING = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIGIT_RUN = /[0-9]{7,}/;
const PATH_PREFIX = /^(?:[a-zA-Z]:|\/Users\/|\/home\/|\\\\|~\/|\.\.\/)/;
const JWT_LIKE = /^eyJ[A-Za-z0-9_-]{8,}/;

export const CORS_HEADERS: Record<string, string> = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
});

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function roundIsoToMinuteUtc(raw: string): string | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const rounded = new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    0,
    0,
  ));
  return rounded.toISOString().replace('.000Z', 'Z');
}

function isSafeServerToken(value: string, kind: 'code' | 'component'): boolean {
  if (!value || value.includes('@') || value.includes('://') || value.includes('\\') || value.includes(' ')) {
    return false;
  }
  if (UUID_SUBSTRING.test(value) || DIGIT_RUN.test(value) || PATH_PREFIX.test(value) || JWT_LIKE.test(value)) {
    return false;
  }
  if (kind === 'code') {
    return CODE_RE.test(value);
  }
  if (value.startsWith('/') || value.includes('//') || value.includes('..')) {
    return false;
  }
  return COMPONENT_RE.test(value);
}

export function validateServerErrorReport(
  raw: unknown,
): { ok: true; value: ValidatedErrorReportPayload } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Payload must be a JSON object' };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      return { ok: false, error: `Disallowed payload field: ${key}` };
    }
  }

  if (typeof record.fingerprint !== 'string' || !FINGERPRINT_RE.test(record.fingerprint)) {
    return { ok: false, error: 'Invalid fingerprint' };
  }
  if (
    typeof record.category !== 'string'
    || !(ALLOWED_CATEGORIES as readonly string[]).includes(record.category)
  ) {
    return { ok: false, error: 'Invalid category' };
  }
  if (record.severity !== 'error' && record.severity !== 'warning') {
    return { ok: false, error: 'Invalid severity' };
  }
  if (typeof record.code !== 'string' || !isSafeServerToken(record.code, 'code')) {
    return { ok: false, error: 'Invalid or unsafe code' };
  }
  if (typeof record.component !== 'string' || !isSafeServerToken(record.component, 'component')) {
    return { ok: false, error: 'Invalid or unsafe component' };
  }
  if (record.process !== 'main' && record.process !== 'renderer') {
    return { ok: false, error: 'Invalid process' };
  }
  if (typeof record.appVersion !== 'string' || !APP_VERSION_RE.test(record.appVersion)) {
    return { ok: false, error: 'Invalid appVersion' };
  }
  if (
    record.platform !== 'win32'
    && record.platform !== 'darwin'
    && record.platform !== 'linux'
    && record.platform !== 'unknown'
  ) {
    return { ok: false, error: 'Invalid platform' };
  }
  if (
    record.arch !== 'x64'
    && record.arch !== 'arm64'
    && record.arch !== 'ia32'
    && record.arch !== 'unknown'
  ) {
    return { ok: false, error: 'Invalid arch' };
  }
  if (typeof record.osRelease !== 'string' || !OS_RELEASE_RE.test(record.osRelease)) {
    return { ok: false, error: 'Invalid osRelease' };
  }

  let electronVersion: string | null = null;
  if (record.electronVersion !== undefined && record.electronVersion !== null) {
    if (typeof record.electronVersion !== 'string' || !ELECTRON_VERSION_RE.test(record.electronVersion)) {
      return { ok: false, error: 'Invalid electronVersion' };
    }
    electronVersion = record.electronVersion;
  }

  if (typeof record.packaged !== 'boolean') {
    return { ok: false, error: 'Invalid packaged flag' };
  }

  let sqliteSchemaVersion: number | null = null;
  if (record.sqliteSchemaVersion !== undefined && record.sqliteSchemaVersion !== null) {
    if (
      typeof record.sqliteSchemaVersion !== 'number'
      || !Number.isInteger(record.sqliteSchemaVersion)
      || record.sqliteSchemaVersion < 0
      || record.sqliteSchemaVersion > 100
    ) {
      return { ok: false, error: 'Invalid sqliteSchemaVersion' };
    }
    sqliteSchemaVersion = record.sqliteSchemaVersion;
  }

  let httpStatus: number | null = null;
  if (record.httpStatus !== undefined && record.httpStatus !== null) {
    if (
      typeof record.httpStatus !== 'number'
      || !Number.isInteger(record.httpStatus)
      || record.httpStatus < 100
      || record.httpStatus > 599
    ) {
      return { ok: false, error: 'Invalid httpStatus' };
    }
    httpStatus = record.httpStatus;
  }

  let postgresCode: string | null = null;
  if (record.postgresCode !== undefined && record.postgresCode !== null) {
    if (typeof record.postgresCode !== 'string' || !POSTGRES_CODE_RE.test(record.postgresCode)) {
      return { ok: false, error: 'Invalid postgresCode' };
    }
    postgresCode = record.postgresCode;
  }

  if (
    typeof record.occurrences !== 'number'
    || !Number.isInteger(record.occurrences)
    || record.occurrences < 1
    || record.occurrences > 10_000
  ) {
    return { ok: false, error: 'Invalid occurrences' };
  }

  if (typeof record.firstOccurredAt !== 'string' || typeof record.lastOccurredAt !== 'string') {
    return { ok: false, error: 'Invalid timestamps' };
  }
  const firstOccurredAt = roundIsoToMinuteUtc(record.firstOccurredAt);
  const lastOccurredAt = roundIsoToMinuteUtc(record.lastOccurredAt);
  if (!firstOccurredAt || !lastOccurredAt) {
    return { ok: false, error: 'Unparseable timestamps' };
  }

  return {
    ok: true,
    value: {
      fingerprint: record.fingerprint,
      category: record.category as ServerErrorCategory,
      severity: record.severity,
      code: record.code,
      component: record.component,
      process: record.process,
      appVersion: record.appVersion,
      platform: record.platform,
      arch: record.arch,
      osRelease: record.osRelease,
      electronVersion,
      packaged: record.packaged,
      sqliteSchemaVersion,
      httpStatus,
      postgresCode,
      occurrences: record.occurrences,
      firstOccurredAt,
      lastOccurredAt,
    },
  };
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MAX_ERROR_REPORT_BYTES,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const declaredLen = request.headers.get('content-length');
  if (declaredLen !== null) {
    const parsedLen = Number(declaredLen);
    if (!Number.isFinite(parsedLen) || parsedLen < 0) {
      return { ok: false, status: 400, error: 'Invalid Content-Length header' };
    }
    if (parsedLen > maxBytes) {
      return { ok: false, status: 413, error: `Payload exceeds ${maxBytes} bytes` };
    }
  }

  if (!request.body) {
    return { ok: false, status: 400, error: 'Request body is required' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: 413, error: `Payload exceeds ${maxBytes} bytes` };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, status: 400, error: 'Failed to read request body' };
  }

  if (total === 0) {
    return { ok: false, status: 400, error: 'Request body must not be empty' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(merged);
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'Request body must be valid UTF-8 JSON' };
  }
}

export function extractBearerJwt(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  if (token.length > 4_096 || !JWT_COMPACT_RE.test(token)) {
    return null;
  }
  return token;
}

export function buildGitHubIssueContent(
  report: ValidatedErrorReportPayload,
  aggregate?: {
    totalOccurrences?: number;
    firstSeenAt?: string;
    platforms?: string[];
  },
): { title: string; body: string } {
  const title = `[auto] ${report.category}/${report.code} in ${report.component}`;
  const totalOccurrences = aggregate?.totalOccurrences ?? report.occurrences;
  const platforms = aggregate?.platforms && aggregate.platforms.length > 0
    ? aggregate.platforms.join(', ')
    : `${report.platform}-${report.arch}`;

  const rows: Array<[string, string]> = [
    ['Fingerprint', `\`${report.fingerprint}\``],
    ['Category', `\`${report.category}\``],
    ['Severity', `\`${report.severity}\``],
    ['Code', `\`${report.code}\``],
    ['Component', `\`${report.component}\``],
    ['Process', `\`${report.process}\``],
    ['App version', `\`${report.appVersion}\``],
    ['Build mode', report.packaged ? '`packaged`' : '`development`'],
    ['OS / Arch', `\`${report.platform}\` / \`${report.arch}\` (\`${report.osRelease}\`)`],
    ['Platforms seen', `\`${platforms}\``],
    ['Electron version', report.electronVersion ? `\`${report.electronVersion}\`` : '`n/a`'],
    ['SQLite schema', report.sqliteSchemaVersion !== null ? `\`v${report.sqliteSchemaVersion}\`` : '`n/a`'],
    ['HTTP status', report.httpStatus !== null ? `\`${report.httpStatus}\`` : '`n/a`'],
    ['Database code', report.postgresCode ? `\`${report.postgresCode}\`` : '`n/a`'],
    ['Batch occurrences', `\`${report.occurrences}\``],
    ['Total occurrences', `\`${totalOccurrences}\``],
    ['First occurred (UTC)', `\`${report.firstOccurredAt}\``],
    ['Last occurred (UTC)', `\`${report.lastOccurredAt}\``],
  ];

  const markdownTable = [
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${value} |`),
  ].join('\n');

  const body = [
    `<!-- dks-fingerprint:${report.fingerprint} -->`,
    '### Automated DKS Diagnostic Report',
    '',
    markdownTable,
    '',
    '_Submitted automatically via the DKS server-side diagnostic worker using strict field allowlisting. No customer data, user identifiers, emails, paths, or raw stack traces are collected._',
  ].join('\n');

  return { title, body };
}

export function buildGitHubOccurrenceComment(
  report: ValidatedErrorReportPayload,
  totalOccurrences: number,
): string {
  return [
    `<!-- dks-fingerprint-update:${report.fingerprint} -->`,
    '### Recurring Diagnostic Summary (24h rollup)',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Latest app version | \`${report.appVersion}\` |`,
    `| OS / Arch | \`${report.platform}\` / \`${report.arch}\` (\`${report.osRelease}\`) |`,
    `| Recent batch count | \`${report.occurrences}\` |`,
    `| Cumulative occurrences | \`${totalOccurrences}\` |`,
    `| Last occurred (UTC) | \`${report.lastOccurredAt}\` |`,
  ].join('\n');
}

export interface ErrorReportWorkerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  serviceRoleKey: string;
  githubToken: string | null;
  githubRepo: string | null;
}

export interface ErrorReportWorkerDeps {
  env: ErrorReportWorkerEnv | null;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface GitHubRateState {
  cooldownUntilMs: number;
}

const workerRateState: GitHubRateState = {
  cooldownUntilMs: 0,
};

export function resetWorkerRateStateForTests(): void {
  workerRateState.cooldownUntilMs = 0;
}

function parseGitHubRetrySeconds(response: Response, nowMs: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && /^[0-9]{1,6}$/.test(retryAfter.trim())) {
    return Math.max(60, Math.min(86_400, Number(retryAfter.trim())));
  }
  const resetEpoch = response.headers.get('x-ratelimit-reset');
  if (resetEpoch && /^[0-9]{9,12}$/.test(resetEpoch.trim())) {
    const resetMs = Number(resetEpoch.trim()) * 1000;
    if (resetMs > nowMs) {
      return Math.max(60, Math.min(86_400, Math.ceil((resetMs - nowMs) / 1000)));
    }
  }
  return 900;
}

async function callPostgrestRpc(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  apiKey: string,
  bearerToken: string,
  rpcName: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${rpcName}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: apiKey,
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(params),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

async function deliverToGitHub(options: {
  fetchImpl: typeof fetch;
  githubToken: string;
  githubRepo: string;
  action: 'create_issue' | 'comment_issue';
  issueNumber: number | null;
  report: ValidatedErrorReportPayload;
  totalOccurrences: number;
  platforms: string[];
  nowMs: number;
}): Promise<
  | { ok: true; status: 'issue_created' | 'issue_commented'; issueNumber: number; issueUrl: string | null }
  | { ok: false; rateLimited: boolean; retryAfterSeconds?: number; detail: string }
> {
  if (options.nowMs < workerRateState.cooldownUntilMs) {
    const retryAfterSeconds = Math.max(60, Math.ceil((workerRateState.cooldownUntilMs - options.nowMs) / 1000));
    return {
      ok: false,
      rateLimited: true,
      retryAfterSeconds,
      detail: 'GITHUB_COOLDOWN_ACTIVE',
    };
  }

  const baseHeaders: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.githubToken}`,
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'dks-error-reporter/1.0',
    'x-github-api-version': '2022-11-28',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    if (options.action === 'comment_issue' && options.issueNumber !== null) {
      const commentBody = buildGitHubOccurrenceComment(options.report, options.totalOccurrences);
      const commentUrl = `https://api.github.com/repos/${options.githubRepo}/issues/${options.issueNumber}/comments`;
      const response = await options.fetchImpl(commentUrl, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ body: commentBody }),
        signal: controller.signal,
      });

      if (
        response.status === 429
        || (response.status === 403
          && (response.headers.get('x-ratelimit-remaining') === '0'
            || response.headers.get('retry-after') !== null))
      ) {
        const retryAfterSeconds = parseGitHubRetrySeconds(response, options.nowMs);
        workerRateState.cooldownUntilMs = options.nowMs + retryAfterSeconds * 1000;
        return {
          ok: false,
          rateLimited: true,
          retryAfterSeconds,
          detail: `GITHUB_RATE_LIMITED_${response.status}`,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          rateLimited: false,
          detail: `GITHUB_COMMENT_HTTP_${response.status}`,
        };
      }

      const json = (await response.json().catch(() => ({}))) as { html_url?: unknown };
      return {
        ok: true,
        status: 'issue_commented',
        issueNumber: options.issueNumber,
        issueUrl: typeof json.html_url === 'string' ? json.html_url : null,
      };
    }

    const { title, body } = buildGitHubIssueContent(options.report, {
      totalOccurrences: options.totalOccurrences,
      platforms: options.platforms,
    });
    const issuesUrl = `https://api.github.com/repos/${options.githubRepo}/issues`;

    let response = await options.fetchImpl(issuesUrl, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        title,
        body,
        labels: ['automated-report'],
      }),
      signal: controller.signal,
    });

    // If the repository has not created the label or rejects labels with 422,
    // retry once without labels so issue creation still succeeds cleanly.
    if (response.status === 422) {
      response = await options.fetchImpl(issuesUrl, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ title, body }),
        signal: controller.signal,
      });
    }

    if (
      response.status === 429
      || (response.status === 403
        && (response.headers.get('x-ratelimit-remaining') === '0'
          || response.headers.get('retry-after') !== null))
    ) {
      const retryAfterSeconds = parseGitHubRetrySeconds(response, options.nowMs);
      workerRateState.cooldownUntilMs = options.nowMs + retryAfterSeconds * 1000;
      return {
        ok: false,
        rateLimited: true,
        retryAfterSeconds,
        detail: `GITHUB_RATE_LIMITED_${response.status}`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        rateLimited: false,
        detail: `GITHUB_ISSUE_HTTP_${response.status}`,
      };
    }

    const created = (await response.json().catch(() => ({}))) as {
      number?: unknown;
      html_url?: unknown;
    };
    if (typeof created.number !== 'number' || !Number.isInteger(created.number)) {
      return {
        ok: false,
        rateLimited: false,
        detail: 'GITHUB_INVALID_RESPONSE',
      };
    }

    return {
      ok: true,
      status: 'issue_created',
      issueNumber: created.number,
      issueUrl: typeof created.html_url === 'string' ? created.html_url : null,
    };
  } catch {
    return {
      ok: false,
      rateLimited: false,
      detail: 'GITHUB_NETWORK_ERROR',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleErrorReportRequest(
  request: Request,
  deps: ErrorReportWorkerDeps,
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'POST required' }, 405);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ ok: false, error: 'Content-Type must be application/json' }, 415);
  }

  if (!deps.env) {
    return jsonResponse({ ok: false, error: 'Server environment is not configured' }, 503);
  }

  const callerJwt = extractBearerJwt(request);
  if (!callerJwt) {
    return jsonResponse({ ok: false, error: 'Bearer authentication token is required' }, 401);
  }

  const parsedBody = await readBoundedJsonBody(request, MAX_ERROR_REPORT_BYTES);
  if (!parsedBody.ok) {
    return jsonResponse({ ok: false, error: parsedBody.error }, parsedBody.status);
  }

  const validated = validateServerErrorReport(parsedBody.data);
  if (!validated.ok) {
    return jsonResponse({ ok: false, error: validated.error }, 400);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const { env } = deps;

  // 1. Verify caller authentication, role, Office session approval, and workspace setting.
  interface CallerVerifyRpcResponse {
    authorized?: boolean;
    user_id?: string;
    role?: string;
    reporting_enabled?: boolean;
  }
  let callerAuth: CallerVerifyRpcResponse | null = null;
  try {
    const verifyRes = await callPostgrestRpc(
      fetchImpl,
      env.supabaseUrl,
      env.supabaseAnonKey,
      callerJwt,
      'verify_error_report_caller',
      {},
    );
    if (!verifyRes.ok || !verifyRes.data || typeof verifyRes.data !== 'object') {
      return jsonResponse({ ok: false, error: 'Unauthorized session' }, 403);
    }
    callerAuth = verifyRes.data as CallerVerifyRpcResponse;
  } catch {
    return jsonResponse({ ok: false, error: 'Authorization check failed' }, 502);
  }

  if (
    !callerAuth?.authorized
    || typeof callerAuth.user_id !== 'string'
    || (callerAuth.role !== 'admin' && callerAuth.role !== 'office')
  ) {
    return jsonResponse({ ok: false, error: 'Unauthorized session' }, 403);
  }

  if (callerAuth.reporting_enabled === false) {
    return jsonResponse({ ok: true, action: 'disabled' }, 200);
  }

  // 2. Check GitHub configuration BEFORE burning rate-limit / fingerprint state
  //    with a queued delivery that cannot run.
  const githubToken = env.githubToken?.trim() ?? '';
  const githubRepo = env.githubRepo?.trim() ?? '';
  if (!githubToken || !REPO_SLUG_RE.test(githubRepo)) {
    return jsonResponse(
      { ok: false, error: 'GitHub error reporting secret is not configured' },
      503,
    );
  }

  // 3. Atomic server-side rate-limit + fingerprint dedupe via service_role RPC.
  interface IngestRpcResponse {
    ok?: boolean;
    action?: string;
    event_id?: string;
    issue_number?: number | null;
    total_occurrences?: number;
    platforms?: unknown[];
    retry_after_seconds?: number | null;
  }
  let ingestData: IngestRpcResponse | null = null;

  try {
    const ingestRes = await callPostgrestRpc(
      fetchImpl,
      env.supabaseUrl,
      env.serviceRoleKey,
      env.serviceRoleKey,
      'ingest_error_report',
      {
        p_user_id: callerAuth.user_id,
        p_role: callerAuth.role,
        p_payload: validated.value,
      },
    );
    if (!ingestRes.ok || !ingestRes.data || typeof ingestRes.data !== 'object') {
      return jsonResponse({ ok: false, error: 'Failed to record diagnostic report' }, 502);
    }
    ingestData = ingestRes.data as IngestRpcResponse;
  } catch {
    return jsonResponse({ ok: false, error: 'Database ingestion failed' }, 502);
  }

  const action = ingestData?.action ?? '';
  if (action === 'disabled') {
    return jsonResponse({ ok: true, action: 'disabled' }, 200);
  }
  if (action === 'deduped') {
    return jsonResponse({ ok: true, action: 'deduped' }, 200);
  }
  if (action === 'rate_limited_user' || action === 'rate_limited_github') {
    const retrySec = typeof ingestData?.retry_after_seconds === 'number'
      ? ingestData.retry_after_seconds
      : 600;
    return jsonResponse(
      { ok: false, action, retryAfterSeconds: retrySec },
      429,
      { 'retry-after': String(retrySec) },
    );
  }

  if (action !== 'create_issue' && action !== 'comment_issue') {
    return jsonResponse({ ok: false, error: 'Unexpected ingestion state' }, 502);
  }

  const eventId = typeof ingestData?.event_id === 'string' ? ingestData.event_id : null;
  const totalOccurrences = typeof ingestData?.total_occurrences === 'number'
    ? ingestData.total_occurrences
    : validated.value.occurrences;
  const platforms = Array.isArray(ingestData?.platforms)
    ? ingestData.platforms.filter((p): p is string => typeof p === 'string')
    : [validated.value.platform];

  // 4. Deliver to GitHub Issues API.
  const ghResult = await deliverToGitHub({
    fetchImpl,
    githubToken,
    githubRepo,
    action,
    issueNumber: typeof ingestData?.issue_number === 'number' ? ingestData.issue_number : null,
    report: validated.value,
    totalOccurrences,
    platforms,
    nowMs,
  });

  if (eventId) {
    await callPostgrestRpc(
      fetchImpl,
      env.supabaseUrl,
      env.serviceRoleKey,
      env.serviceRoleKey,
      'complete_error_report_delivery',
      {
        p_event_id: eventId,
        p_fingerprint: validated.value.fingerprint,
        p_status: ghResult.ok
          ? ghResult.status
          : ghResult.rateLimited
            ? 'rate_limited'
            : 'failed',
        p_issue_number: ghResult.ok ? ghResult.issueNumber : null,
        p_issue_url: ghResult.ok ? ghResult.issueUrl : null,
        p_detail: ghResult.ok ? ghResult.status : ghResult.detail,
      },
    ).catch(() => undefined);
  }

  if (!ghResult.ok) {
    if (ghResult.rateLimited) {
      const retrySec = ghResult.retryAfterSeconds ?? 900;
      return jsonResponse(
        { ok: false, action: 'rate_limited_github', retryAfterSeconds: retrySec },
        429,
        { 'retry-after': String(retrySec) },
      );
    }
    return jsonResponse({ ok: false, error: 'GitHub issue delivery failed' }, 502);
  }

  return jsonResponse(
    {
      ok: true,
      action: ghResult.status,
      issueNumber: ghResult.issueNumber,
    },
    ghResult.status === 'issue_created' ? 201 : 200,
  );
}
