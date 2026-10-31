import {
  BackupHttpError,
  type AuthDeps,
  type BackupEnv,
} from './auth';
import {
  handleGetObject,
  handleHealth,
  handleList,
  handleUpload,
  runRetention,
} from './routes';

/**
 * DKS cloud backup Worker (PR1).
 *
 * Snapshot in → encrypted envelope out to a PRIVATE R2 bucket. This Worker is
 * the only component that holds an R2 binding, and it holds no Supabase
 * service-role key: it verifies the caller's JWT and asks Postgres for the
 * role using that same caller's token.
 *
 * PR1 routes: upload, list, download, health. Delete (PR2) and restore (PR3)
 * are not registered.
 */

export interface Env extends BackupEnv {}

interface ScheduledEventLike {
  scheduledTime?: number;
  cron?: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerDeps extends AuthDeps {}

export const CORS_ALLOWED_METHODS = 'GET, HEAD, POST, OPTIONS';
/** The desktop app is not a browser, but a permissive-but-explicit CORS keeps
 *  `wrangler dev` and any future web tooling from breaking. No credentials. */
function corsHeaders(): Headers {
  return new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': CORS_ALLOWED_METHODS,
    'access-control-allow-headers': 'authorization, content-type, x-dks-plaintext-sha256, x-dks-ciphertext-sha256, x-dks-fingerprint, x-dks-schema-version, x-dks-record-counts, x-dks-created-at, x-dks-app-version, x-dks-key-id, x-dks-source, x-dks-device-id',
    'access-control-max-age': '600',
    vary: 'Origin',
  });
}

function jsonResponse(status: number, body: unknown): Response {
  const headers = corsHeaders();
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * One predictable error shape for every failure:
 *   { "error": { "code": "FORBIDDEN", "message": "..." } }
 *
 * Messages are fixed strings. Nothing from the request body, the authorization
 * header or a stored object is ever echoed back or logged.
 */
function errorResponse(error: unknown): Response {
  if (error instanceof BackupHttpError) {
    return jsonResponse(error.status, { error: { code: error.code, message: error.message } });
  }
  console.error('[dks-backup] unhandled worker error');
  return jsonResponse(500, {
    error: { code: 'INTERNAL', message: 'The backup service hit an unexpected problem' },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  corsHeaders().forEach((value, key) => {
    if (!headers.has(key)) headers.set(key, value);
  });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function depsFromNow(now: () => number = () => Date.now()): WorkerDeps {
  return { fetchImpl: fetch, now };
}

const UPLOAD_PATH = '/v1/backups';

export async function routeRequest(
  request: Request,
  env: Env,
  deps: WorkerDeps = depsFromNow(),
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    const headers = corsHeaders();
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/health' && method === 'GET') {
    const result = await handleHealth(env, deps);
    return jsonResponse(result.ok ? 200 : 503, result);
  }

  if (pathname === UPLOAD_PATH) {
    if (method === 'GET') {
      // Admin only, metadata only — see handleList.
      const result = await handleList(request, env, deps);
      return jsonResponse(200, result);
    }
    if (method !== 'POST') {
      throw new BackupHttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST to upload a backup');
    }
    const result = await handleUpload(request, env, deps);
    return jsonResponse(201, result);
  }

  if (pathname.startsWith(`${UPLOAD_PATH}/`)) {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new BackupHttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET to download a backup');
    }
    const id = pathname.slice(UPLOAD_PATH.length + 1);
    const response = await handleGetObject(request, env, deps, id);
    return withCors(response);
  }

  throw new BackupHttpError(404, 'NOT_FOUND', 'That backup endpoint does not exist');
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _context?: ExecutionContextLike,
  ): Promise<Response> {
    try {
      return await routeRequest(request, env, depsFromNow());
    } catch (error) {
      return errorResponse(error);
    }
  },

  /**
   * Daily retention cron.
   *
   * PR1 runs it in DRY-RUN: it scans, counts the objects older than the
   * retention window (protecting the newest object) and logs them. Nothing is
   * deleted until the owner explicitly sets `RETENTION_MODE=enforce`, which is
   * a PR2 decision.
   */
  async scheduled(
    _event: ScheduledEventLike,
    env: Env,
    context?: ExecutionContextLike,
  ): Promise<void> {
    const work = (async () => {
      try {
        const summary = await runRetention(env, depsFromNow(), (message) => console.log(message));
        console.log(`[dks-backup retention] ${JSON.stringify({
          mode: summary.mode,
          scanned: summary.scanned,
          candidates: summary.candidates,
          deleted: summary.deleted,
        })}`);
      } catch {
        console.error('[dks-backup retention] run failed');
      }
    })();
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(work);
    } else {
      await work;
    }
  },
};

export { handleHealth, handleList, handleUpload, runRetention };
