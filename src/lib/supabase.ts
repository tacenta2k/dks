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
