import { createClient } from '@supabase/supabase-js';

import type { AuthClientLike } from '../features/auth/auth-service';
import type { SupabaseHealth } from '../features/auth/auth-types';

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

function readEnvValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getSupabaseConfig(
  env: Record<string, unknown> = import.meta.env as Record<string, unknown>,
): SupabaseConfig | null {
  const url = readEnvValue(env.VITE_SUPABASE_URL);
  const publishableKey = readEnvValue(env.VITE_SUPABASE_PUBLISHABLE_KEY);

  if (!url || !publishableKey) {
    return null;
  }

  return { url, publishableKey };
}

export function isSupabaseConfigured(
  env: Record<string, unknown> = import.meta.env as Record<string, unknown>,
): boolean {
  return getSupabaseConfig(env) !== null;
}

/**
 * Supabase persists the refresh/session pair through its configured storage.
 * The renderer only receives the public URL and publishable key from Vite.
 */
export function createSupabaseClient(
  config: SupabaseConfig | null = getSupabaseConfig(),
): AuthClientLike | null {
  if (!config) {
    return null;
  }

  try {
    return createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    }) as unknown as AuthClientLike;
  } catch {
    return null;
  }
}

/**
 * v0.1.8 (Issue B) — take connection setup off the "Signing in…" path.
 *
 * The password grant is the first request the renderer makes to the Supabase
 * host, so on the click path it also paid DNS + TCP + TLS (and the CORS
 * preflight) before the password check even started. While the sign-in form is
 * visible we open that connection with a tiny unauthenticated
 * `GET /auth/v1/health` (public publishable key only — the same value that is
 * already in the bundle; no credentials, no user data). Chromium keeps the
 * HTTP/2 connection alive and the password request reuses it.
 *
 * Pure optimisation: failures are ignored, nothing waits for it, and it changes
 * nothing about authentication or approval.
 */
export const PREWARM_TTL_MS = 60_000;
const PREWARM_TIMEOUT_MS = 5_000;
let prewarmInFlight: Promise<boolean> | null = null;
let lastPrewarmOkAt = 0;

export function prewarmSupabaseConnection(
  config: SupabaseConfig | null = getSupabaseConfig(),
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!config || !fetchImpl) return Promise.resolve(false);
  if (prewarmInFlight) return prewarmInFlight;
  if (lastPrewarmOkAt && now() - lastPrewarmOkAt < PREWARM_TTL_MS) return Promise.resolve(true);

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS) : undefined;
  prewarmInFlight = (async () => {
    try {
      const response = await fetchImpl(`${config.url.replace(/\/+$/, '')}/auth/v1/health`, {
        method: 'GET',
        headers: { apikey: config.publishableKey },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller?.signal,
      });
      // Any HTTP answer means the connection is up; the body is irrelevant.
      lastPrewarmOkAt = now();
      return Boolean(response);
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      prewarmInFlight = null;
    }
  })();
  return prewarmInFlight;
}

/** True when a pre-warm completed within PREWARM_TTL_MS (reported as warm=yes|no). */
export function isSupabaseConnectionWarm(now: () => number = Date.now): boolean {
  return lastPrewarmOkAt > 0 && now() - lastPrewarmOkAt < PREWARM_TTL_MS;
}

/** Test hook. */
export function resetSupabasePrewarm(): void {
  prewarmInFlight = null;
  lastPrewarmOkAt = 0;
}

export const supabase: AuthClientLike | null = createSupabaseClient();
export const supabaseClient = supabase;

export async function probeSupabaseHealth(
  client?: AuthClientLike | null,
): Promise<SupabaseHealth> {
  const resolvedClient = client === undefined ? supabase ?? createSupabaseClient() : client;
  if (!resolvedClient) {
    return {
      configured: false,
      reachable: 'unknown',
      authenticated: false,
      error: null,
    };
  }

  try {
    const result = await resolvedClient.auth.getSession();
    if (result.error) {
      return {
        configured: true,
        reachable: 'unreachable',
        authenticated: false,
        error: result.error.message,
      };
    }

    return {
      configured: true,
      reachable: 'reachable',
      authenticated: Boolean(result.data.session),
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: 'unreachable',
      authenticated: false,
      error: error instanceof Error ? error.message : 'Supabase health check failed.',
    };
  }
}
