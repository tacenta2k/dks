import { supabase } from '../../lib/supabase';
import type { AuthError, AuthResult } from './auth-types';

/**
 * Office sign-in approval — the client side of the session-binding approval
 * gate. The signed session identifier NEVER travels through this service:
 * every binding decision is derived server-side from auth.jwt() inside the
 * RPC functions (see ARENA/sql/office-approval.sql). The renderer only asks
 * the server about the current session's status and (for Admin) decides
 * requests — it can never assert its own approval.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export interface OfficeSigninRequest {
  id: string;
  userId: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Present on Admin listings (uuid); never required from the renderer. */
  authSessionId?: string;
}

export type ApprovalServiceError = AuthError;

export interface RpcErrorLike {
  message: string;
  code?: string;
  status?: number;
}

export interface ApprovalClientLike {
  rpc: (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: RpcErrorLike | null }>;
  from: (table: string) => {
    select: (columns?: string) => {
      in: (column: string, values: string[]) => {
        order: (column: string, options: { ascending: boolean }) => Promise<{
          data: unknown[] | null;
          error: RpcErrorLike | null;
        }>;
      };
    };
  };
}

function toError(error: unknown, fallback: string, code?: string): AuthError {
  if (error && typeof error === 'object' && 'message' in error) {
    const source = error as { message?: unknown; code?: unknown };
    return {
      message: typeof source.message === 'string' ? source.message : fallback,
      code: typeof source.code === 'string' ? source.code : code,
      cause: error,
    };
  }
  return { message: fallback, code, cause: error };
}

function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return value === 'pending' || value === 'approved' || value === 'denied' || value === 'revoked';
}

function requestFromRow(row: Record<string, unknown>): OfficeSigninRequest | null {
  if (!row || typeof row.id !== 'string' || !isApprovalStatus(row.status)) {
    return null;
  }
  return {
    id: row.id,
    userId: typeof row.user_id === 'string' ? row.user_id : '',
    status: row.status,
    requestedAt: typeof row.requested_at === 'string' ? row.requested_at : new Date().toISOString(),
    decidedAt: typeof row.decided_at === 'string' ? row.decided_at : null,
    decidedBy: typeof row.decided_by === 'string' ? row.decided_by : null,
    ...(typeof row.auth_session_id === 'string' ? { authSessionId: row.auth_session_id } : {}),
  };
}

/**
 * Base64url-decode the JWT payload and expose the claims for LOCAL DISPLAY /
 * DEBUG only (e.g. "session id unavailable" diagnostics). The value returned
 * here is NEVER honoured by any trust decision — desktop code could read the
 * same text; the server reads the signed claim itself.
 */
export function claimsFromAccessToken(accessToken: string | null | undefined): Record<string, unknown> | null {
  if (!accessToken) {
    return null;
  }
  const parts = accessToken.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the signed JWT exposes the session_id claim the gate binds to. */
export function hasSignedSessionClaim(accessToken: string | null | undefined): boolean {
  const claims = claimsFromAccessToken(accessToken);
  return typeof claims?.session_id === 'string' && claims.session_id.length > 0;
}

export interface OfficeApprovalService {
  /** Office: open (or refresh) the pending request for THIS signed session. */
  requestApproval(): Promise<AuthResult<OfficeSigninRequest>>;
  /** Office: read the current session's request (restart recovery / polling). */
  fetchMyRequest(): Promise<AuthResult<OfficeSigninRequest | null>>;
  /** Admin: pending + approved requests, newest first. */
  listRequests(statuses?: ApprovalStatus[]): Promise<AuthResult<OfficeSigninRequest[]>>;
  /** Admin: approve or deny a pending request. */
  decideRequest(requestId: string, decision: 'approved' | 'denied'): Promise<AuthResult<OfficeSigninRequest>>;
  /** Admin: revoke a granted approval (immediate online effect via RLS). */
  revokeRequest(requestId: string): Promise<AuthResult<OfficeSigninRequest>>;
}

export function createOfficeApprovalService(
  client?: ApprovalClientLike | null,
): OfficeApprovalService | null {
  const resolved = client === undefined
    ? (supabase as unknown as ApprovalClientLike | null)
    : client;
  if (!resolved) {
    return null;
  }

  return {
    async requestApproval(): Promise<AuthResult<OfficeSigninRequest>> {
      try {
        const result = await resolved.rpc('request_office_signin');
        if (result.error) {
          return {
            data: null,
            error: toError(result.error, 'Unable to submit the sign-in approval request.', 'APPROVAL_REQUEST_FAILED'),
          };
        }
        const request = requestFromRow((result.data ?? null) as Record<string, unknown> | null as Record<string, unknown>);
        if (!request) {
          return { data: null, error: { message: 'The approval request returned no usable row.', code: 'APPROVAL_RESPONSE' } };
        }
        return { data: request, error: null };
      } catch (caught) {
        return { data: null, error: toError(caught, 'Unable to submit the sign-in approval request.', 'APPROVAL_REQUEST_FAILED') };
      }
    },

    async fetchMyRequest(): Promise<AuthResult<OfficeSigninRequest | null>> {
      try {
        const result = await resolved.rpc('my_office_signin');
        if (result.error) {
          return {
            data: null,
            error: toError(result.error, 'Unable to read the sign-in approval status.', 'APPROVAL_STATUS_FAILED'),
          };
        }
        if (result.data === null || result.data === undefined) {
          return { data: null, error: null };
        }
        const request = requestFromRow(result.data as Record<string, unknown>);
        if (!request) {
          return { data: null, error: null };
        }
        return { data: request, error: null };
      } catch (caught) {
        return { data: null, error: toError(caught, 'Unable to read the sign-in approval status.', 'APPROVAL_STATUS_FAILED') };
      }
    },

    async listRequests(statuses: ApprovalStatus[] = ['pending', 'approved']): Promise<AuthResult<OfficeSigninRequest[]>> {
      try {
        const result = await resolved
          .from('office_signin_requests')
          .select('id, user_id, status, requested_at, decided_at, decided_by, auth_session_id')
          .in('status', statuses)
          .order('requested_at', { ascending: false });
        if (result.error) {
          return {
            data: null,
            error: toError(result.error, 'Unable to list Office sign-in requests.', 'APPROVAL_LIST_FAILED'),
          };
        }
        const rows = Array.isArray(result.data) ? result.data : [];
        return {
          data: rows
            .map((row) => requestFromRow(row as Record<string, unknown>))
            .filter((row): row is OfficeSigninRequest => row !== null),
          error: null,
        };
      } catch (caught) {
        return { data: null, error: toError(caught, 'Unable to list Office sign-in requests.', 'APPROVAL_LIST_FAILED') };
      }
    },

    async decideRequest(requestId, decision): Promise<AuthResult<OfficeSigninRequest>> {
      try {
        const result = await resolved.rpc('decide_office_signin', {
          p_request_id: requestId,
          p_decision: decision,
        });
        if (result.error) {
          return {
            data: null,
            error: toError(result.error, 'The decision could not be recorded.', 'APPROVAL_DECIDE_FAILED'),
          };
        }
        const request = requestFromRow(result.data as Record<string, unknown>);
        if (!request) {
          return { data: null, error: { message: 'The decision returned no usable row.', code: 'APPROVAL_RESPONSE' } };
        }
        return { data: request, error: null };
      } catch (caught) {
        return { data: null, error: toError(caught, 'The decision could not be recorded.', 'APPROVAL_DECIDE_FAILED') };
      }
    },

    async revokeRequest(requestId: string): Promise<AuthResult<OfficeSigninRequest>> {
      try {
        const result = await resolved.rpc('revoke_office_signin', { p_request_id: requestId });
        if (result.error) {
          return {
            data: null,
            error: toError(result.error, 'The session could not be revoked.', 'APPROVAL_REVOKE_FAILED'),
          };
        }
        const request = requestFromRow(result.data as Record<string, unknown>);
        if (!request) {
          return { data: null, error: { message: 'The revocation returned no usable row.', code: 'APPROVAL_RESPONSE' } };
        }
        return { data: request, error: null };
      } catch (caught) {
        return { data: null, error: toError(caught, 'The session could not be revoked.', 'APPROVAL_REVOKE_FAILED') };
      }
    },
  };
}
