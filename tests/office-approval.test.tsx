import type { Session } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import {
  claimsFromAccessToken,
  createOfficeApprovalService,
  hasSignedSessionClaim,
  type ApprovalClientLike,
  type OfficeApprovalService,
  type OfficeSigninRequest,
} from '../src/features/auth/office-approval-service';
import { OfficeApprovalGate } from '../src/features/auth/OfficeApprovalGate';
import { OfficeApprovalsPanel } from '../src/features/admin/OfficeApprovalsPanel';
import { createAppStore, type AppStore } from '../src/lib/store';
import { App } from '../src/renderer/App';
import {
  createLocalIpcHandlers,
  LOCAL_IPC_CHANNELS,
  createLocalSessionClearance,
  registerLocalIpcHandlers,
  type LocalIpcMain,
  type LocalIpcStore,
} from '../electron/main/local-ipc';
import type { StoreApi } from 'zustand/vanilla';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const officeSession = {
  access_token: 'fake.fake.fake',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'user-office',
    email: 'office@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

const adminSession: Session = {
  ...officeSession,
  user: { ...officeSession.user, id: 'user-admin', email: 'admin@example.com' },
};

function makeAuthClient(profile: Record<string, unknown> | null, restored: Session | null = officeSession): AuthClientLike {
  return {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: officeSession, user: officeSession.user }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: restored }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }) })),
      })),
    })),
  };
}

function makeRequest(overrides: Partial<OfficeSigninRequest>): OfficeSigninRequest {
  return {
    id: 'req-1',
    userId: 'user-office',
    status: 'pending',
    requestedAt: '2026-10-24T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

function makeFakeApprovalService(seed: {
  rows?: OfficeSigninRequest[];
  request?: OfficeSigninRequest | null;
  my?: OfficeSigninRequest | null;
  requestError?: { message: string };
  myError?: { message: string };
  listError?: { message: string };
  signOutSummary?: { officeUsers: number; authSessionsDeleted: number; requestsRevoked: number };
  signOutError?: { message: string };
}) {
  const calls = {
    requestApproval: 0,
    fetchMyRequest: 0,
    decideRequest: [] as Array<{ id: string; decision: string }>,
    revokeRequest: [] as string[],
    signOutAllOfficeSessions: 0,
  };
  const service: OfficeApprovalService = {
    requestApproval: vi.fn(async () => {
      calls.requestApproval += 1;
      if (seed.requestError) {
        return { data: null, error: { message: seed.requestError.message } };
      }
      return { data: seed.request ?? seed.my ?? null, error: null };
    }),
    fetchMyRequest: vi.fn(async () => {
      calls.fetchMyRequest += 1;
      if (seed.myError) {
        return { data: null, error: { message: seed.myError.message } };
      }
      return { data: seed.my ?? null, error: null };
    }),
    listRequests: vi.fn(async (statuses?: Array<OfficeSigninRequest['status']>) => {
      if (seed.listError) {
        return { data: null, error: { message: seed.listError.message } };
      }
      const rows = seed.rows ?? [];
      return { data: statuses ? rows.filter((row) => statuses.includes(row.status)) : rows, error: null };
    }),
    decideRequest: vi.fn(async (requestId: string, decision: 'approved' | 'denied') => {
      calls.decideRequest.push({ id: requestId, decision });
      const row = (seed.rows ?? []).find((candidate) => candidate.id === requestId);
      return {
        data: {
          ...(row ?? makeRequest({ id: requestId })),
          status: decision as OfficeSigninRequest['status'],
          decidedAt: row?.decidedAt ?? '2026-10-24T09:05:00.000Z',
        },
        error: null,
      };
    }),
    revokeRequest: vi.fn(async (requestId: string) => {
      calls.revokeRequest.push(requestId);
      const row = (seed.rows ?? []).find((candidate) => candidate.id === requestId);
      return {
        data: {
          ...(row ?? makeRequest({ id: requestId })),
          status: 'revoked' as OfficeSigninRequest['status'],
        },
        error: null,
      };
    }),
    signOutAllOfficeSessions: vi.fn(async () => {
      calls.signOutAllOfficeSessions += 1;
      if (seed.signOutError) {
        return { data: null, error: { message: seed.signOutError.message } };
      }
      return {
        data: seed.signOutSummary ?? { officeUsers: 1, authSessionsDeleted: 2, requestsRevoked: 2 },
        error: null,
      };
    }),
  };
  return { service, calls };
}

// Minimal fake store for the local IPC clearing tests (rows only).
function makeLocalStore(): LocalIpcStore {
  const rows = [{ id: 'row-1', data: { name: 'Ada' }, deleted: false }];
  return {
    listRows: () => rows,
    listColumns: () => [],
    getSyncStatus: () => ({ status: 'offline', lastSyncAt: null, lastError: null, pendingCount: 0 }),
    createRow: (input: { data: Record<string, unknown> }) => {
      const row = { id: 'row-created', ...input, deleted: false };
      rows.push(row as unknown as (typeof rows)[number]);
      return row;
    },
    close: () => ({ checkpoint: true }),
  } as unknown as LocalIpcStore;
}

// ---------------------------------------------------------------------------
// JWT parsing (display-only; the server derives the binding itself)
// ---------------------------------------------------------------------------

describe('access-token claim parsing', () => {
  function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
  }

  it('extracts the session_id claim for diagnostics', () => {
    const token = fakeJwt({ sub: 'user-1', session_id: 'sess-123', aud: 'authenticated' });
    expect(claimsFromAccessToken(token)?.session_id).toBe('sess-123');
    expect(hasSignedSessionClaim(token)).toBe(true);
  });

  it('reports missing claim honestly (claim-less JWT, offline token, malformed)', () => {
    expect(hasSignedSessionClaim(fakeJwt({ sub: 'user-1' }))).toBe(false);
    expect(hasSignedSessionClaim('offline-demo')).toBe(false);
    expect(hasSignedSessionClaim('not-a-jwt')).toBe(false);
    expect(claimsFromAccessToken(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service round-trips (fake RPC client)
// ---------------------------------------------------------------------------

describe('office approval service round-trips', () => {
  function makeRpcClient(
    rows: Record<string, unknown>[] = [],
    rpcResponder?: (name: string, params?: Record<string, unknown>) => { data: unknown; error: null },
  ): ApprovalClientLike & { rpcCalls: Array<{ name: string; params?: Record<string, unknown> }> } {
    const rpcCalls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    return {
      rpcCalls,
      rpc: vi.fn(async (name: string, params?: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        if (rpcResponder) {
          return rpcResponder(name, params);
        }
        return { data: null, error: null };
      }),
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            order: vi.fn(async () => ({ data: rows, error: null })),
          })),
        })),
      })),
    };
  }

  it('submits a pending request and maps the returned row', async () => {
    const client = makeRpcClient([], (name) => {
      if (name === 'request_office_signin') {
        return {
          data: {
            id: 'req-1',
            user_id: 'user-office',
            status: 'pending',
            requested_at: '2026-10-24T10:00:00Z',
            decided_at: null,
            decided_by: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const service = createOfficeApprovalService(client);
    expect(service).not.toBeNull();

    const result = await service!.requestApproval();
    expect(result.error).toBeNull();
    expect(result.data?.status).toBe('pending');
    expect(client.rpcCalls).toEqual([{ name: 'request_office_signin', params: undefined }]);
  });

  it('surfaces server errors without hiding them (no silent success)', async () => {
    const client = makeRpcClient([], () => ({ data: null, error: { message: 'server blew up' } as never }));
    const service = createOfficeApprovalService(client);
    const result = await service!.requestApproval();
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('server blew up');
  });

  it('Admin decides and revokes end-to-end', async () => {
    const client = makeRpcClient([], (name, params) => {
      if (name === 'decide_office_signin') {
        return {
          data: {
            id: params?.p_request_id,
            user_id: 'user-office',
            status: params?.p_decision,
            requested_at: '2026-10-24T10:00:00Z',
            decided_at: '2026-10-24T11:00:00Z',
            decided_by: 'user-admin',
          },
          error: null,
        };
      }
      if (name === 'revoke_office_signin') {
        return {
          data: {
            id: params?.p_request_id,
            user_id: 'user-office',
            status: 'revoked',
            requested_at: '2026-10-24T10:00:00Z',
            decided_at: '2026-10-24T12:00:00Z',
            decided_by: 'user-admin',
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const service = createOfficeApprovalService(client)!;

    const decided = await service.decideRequest('req-1', 'approved');
    expect(decided.data?.status).toBe('approved');
    expect(client.rpcCalls[0]).toEqual({ name: 'decide_office_signin', params: { p_request_id: 'req-1', p_decision: 'approved' } });

    const revoked = await service.revokeRequest('req-1');
    expect(revoked.data?.status).toBe('revoked');
    expect(client.rpcCalls[1]).toEqual({ name: 'revoke_office_signin', params: { p_request_id: 'req-1' } });
  });

  it('calls the bulk Office sign-out RPC and maps its summary', async () => {
    const client = makeRpcClient([], (name) => {
      if (name === 'sign_out_all_office_sessions') {
        return {
          data: [{
            office_users: 1,
            auth_sessions_deleted: 3,
            requests_revoked: 2,
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const service = createOfficeApprovalService(client)!;

    const result = await service.signOutAllOfficeSessions();

    expect(result).toEqual({
      data: { officeUsers: 1, authSessionsDeleted: 3, requestsRevoked: 2 },
      error: null,
    });
    expect(client.rpcCalls).toEqual([
      { name: 'sign_out_all_office_sessions', params: undefined },
    ]);
  });

  it('does not fake bulk sign-out success when the RPC returns an error', async () => {
    const client = makeRpcClient([], () => ({
      data: null,
      error: { message: 'Only administrators may sign out Office sessions', code: '42501' } as never,
    }));
    const service = createOfficeApprovalService(client)!;

    const result = await service.signOutAllOfficeSessions();

    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('Only administrators');
    expect(result.error?.code).toBe('42501');
  });
});

// ---------------------------------------------------------------------------
// Store flow — one signed session at a time, server-driven
// ---------------------------------------------------------------------------

describe('store-level approval flow', () => {
  it('Admin signs in and the gate never activates (no approval RPCs)', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-admin', role: 'admin' }));
    const { service: approvalService, calls } = makeFakeApprovalService({});
    const store = createAppStore(authService, approvalService);

    await store.getState().signIn('admin@example.com', 'password');

    expect(store.getState().profile?.role).toBe('admin');
    expect(store.getState().sessionApproval).toBe('not-required');
    expect(calls.requestApproval).toBe(0);
    expect(calls.fetchMyRequest).toBe(0);
  });

  it('allows only an administrator store session to call bulk Office sign-out', async () => {
    const adminAuthService = new AuthService(makeAuthClient({ id: 'user-admin', role: 'admin' }));
    const adminFake = makeFakeApprovalService({
      signOutSummary: { officeUsers: 1, authSessionsDeleted: 4, requestsRevoked: 3 },
    });
    const adminStore = createAppStore(adminAuthService, adminFake.service);
    await adminStore.getState().signIn('admin@example.com', 'password');

    const adminResult = await adminStore.getState().signOutAllOfficeSessions();
    expect(adminResult).toEqual({
      data: { officeUsers: 1, authSessionsDeleted: 4, requestsRevoked: 3 },
      error: null,
    });
    expect(adminFake.calls.signOutAllOfficeSessions).toBe(1);
    // The bulk action does not sign out or otherwise disturb the admin.
    expect(adminStore.getState().authStatus).toBe('authenticated');
    expect(adminStore.getState().profile?.role).toBe('admin');

    const officeAuthService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const officeFake = makeFakeApprovalService({ my: makeRequest({ status: 'approved' }) });
    const officeStore = createAppStore(officeAuthService, officeFake.service);
    await officeStore.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(officeStore.getState().sessionApproval).toBe('approved'));

    const officeResult = await officeStore.getState().signOutAllOfficeSessions();
    expect(officeResult.data).toBeNull();
    expect(officeResult.error?.code).toBe('NOT_AUTHORIZED');
    expect(officeFake.calls.signOutAllOfficeSessions).toBe(0);
  });

  it('Office password sign-in submits an approval request and lands pending', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({ my: makeRequest({ status: 'pending' }) });
    const store = createAppStore(authService, approvalService);

    await store.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(store.getState().sessionApproval).toBe('pending'));

    expect(approvalService.requestApproval).toHaveBeenCalledOnce();
    expect(store.getState().sessionApprovalRequest?.status).toBe('pending');
  });

  it('restores a persisted APPROVED session without requesting again', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService, calls } = makeFakeApprovalService({ my: makeRequest({ status: 'approved' }) });
    const store = createAppStore(authService, approvalService);

    await store.getState().restoreSession();
    await waitFor(() => expect(store.getState().sessionApproval).toBe('approved'));

    // No request submitted — the row exists server-side already.
    expect(calls.requestApproval).toBe(0);
    expect(calls.fetchMyRequest).toBeGreaterThanOrEqual(1);
  });

  it('restore → denied shows the blocked state', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({ my: makeRequest({ status: 'denied' }) });
    const store = createAppStore(authService, approvalService);

    await store.getState().restoreSession();
    await waitFor(() => expect(store.getState().sessionApproval).toBe('denied'));
  });

  it('revocation takes hold on the next refresh (approved → revoked)', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const mutableState = { my: makeRequest({ status: 'approved' }) };
    const { service: approvalService, calls } = makeFakeApprovalService({});
    vi.mocked(approvalService.fetchMyRequest).mockImplementation(
      async () => ({ data: mutableState.my, error: null }),
    );
    vi.mocked(approvalService.requestApproval).mockImplementation(
      async () => ({ data: mutableState.my, error: null }),
    );
    const store = createAppStore(authService, approvalService);

    await store.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(store.getState().sessionApproval).toBe('approved'));

    // The server flips the row to revoked; the next poll must reflect it.
    mutableState.my = { ...(mutableState.my as OfficeSigninRequest), status: 'revoked' };
    await store.getState().refreshSessionApproval();
    expect(store.getState().sessionApproval).toBe('revoked');
    void calls;
  });

  it('logout resets approval state; the next office sign-in asks again', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService, calls } = makeFakeApprovalService({ my: makeRequest({ status: 'approved' }) });
    const store = createAppStore(authService, approvalService);

    await store.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(store.getState().sessionApproval).toBe('approved'));

    await store.getState().signOut();
    expect(store.getState().sessionApproval).toBe('not-required');
    expect(store.getState().sessionApprovalRequest).toBeNull();

    await store.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(store.getState().sessionApproval).toBe('approved'));
    // Second sign-in triggered a NEW approval request.
    expect(calls.requestApproval).toBeGreaterThanOrEqual(2);
  });

  it('an approval service failure fails CLOSED (never opens the workspace)', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({ myError: { message: 'offline' }, requestError: { message: 'offline' } });
    const store = createAppStore(authService, approvalService);

    await store.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(store.getState().sessionApproval).toBe('error'));
    expect(store.getState().authStatus).toBe('authenticated'); // credentials fine
    expect(store.getState().sessionApproval).not.toBe('approved'); // but never opened
  });
});

// ---------------------------------------------------------------------------
// One email, TWO different signed sessions — the approval binds per session
// ---------------------------------------------------------------------------

describe('session-specific approval (shared Office email)', () => {
  it('session A approved while session B stays pending — rows are independent', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const requestsBySession = new Map<string, OfficeSigninRequest>();
    // Two distinct auth sessions for the same email.
    requestsBySession.set('session-A', makeRequest({ id: 'req-A', status: 'approved' }));
    requestsBySession.set('session-B', makeRequest({ id: 'req-B', status: 'pending' }));

    let currentSession = 'session-B';
    const approvalService: OfficeApprovalService = {
      requestApproval: vi.fn(async () => ({ data: requestsBySession.get(currentSession) ?? null, error: null })),
      fetchMyRequest: vi.fn(async () => ({ data: requestsBySession.get(currentSession) ?? null, error: null })),
      listRequests: vi.fn(async () => ({ data: Array.from(requestsBySession.values()), error: null })),
      decideRequest: vi.fn(async (id: string, decision: 'approved' | 'denied') => ({
        data: {
          ...(requestsBySession.get('session-' + id.slice(-1)) ?? makeRequest({ id })),
          status: decision as OfficeSigninRequest['status'],
        },
        error: null,
      })),
      revokeRequest: vi.fn(async (id: string) => ({
        data: { ...makeRequest({ id }), status: 'revoked' as OfficeSigninRequest['status'] },
        error: null,
      })),
      signOutAllOfficeSessions: vi.fn(async () => ({
        data: { officeUsers: 1, authSessionsDeleted: 0, requestsRevoked: 0 },
        error: null,
      })),
    };

    // Session B signs in: still pending.
    const storeB = createAppStore(authService, approvalService);
    await storeB.getState().signIn('office@example.com', 'password');
    await waitFor(() => expect(storeB.getState().sessionApproval).toBe('pending'));

    // Approving session A must NOT open session B.
    const rowA = requestsBySession.get('session-A')!;
    requestsBySession.set('session-A', { ...rowA, status: 'approved' });
    await storeB.getState().refreshSessionApproval();
    expect(storeB.getState().sessionApproval).toBe('pending');

    // Now session A signs in elsewhere: approved for A only.
    currentSession = 'session-A';
    const storeA = createAppStore(authService, approvalService);
    await storeA.getState().restoreSession();
    await waitFor(() => expect(storeA.getState().sessionApproval).toBe('approved'));
    expect(storeB.getState().sessionApproval).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// The WAITING gate — only surface a pending Office session may see
// ---------------------------------------------------------------------------

describe('OfficeApprovalGate render', () => {
  let store: StoreApi<AppStore>;

  beforeEach(() => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({});
    store = createAppStore(authService, approvalService);
  });

  it('renders the waiting screen with the sign-out escape hatch only', async () => {
    store.setState({ sessionApproval: 'pending', sessionApprovalRequest: makeRequest({ requestedAt: '2026-10-24T09:00:00.000Z' }) });
    const onSignOut = vi.fn();
    render(<OfficeApprovalGate appStore={store} onSignOut={onSignOut} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/waiting for admin approval/i)).toBeInTheDocument();
    // NO workspace surface, no row data, no navigation.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('denied render blocks with a clear message', async () => {
    store.setState({ sessionApproval: 'denied' });
    render(<OfficeApprovalGate appStore={store} onSignOut={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/denied/i);
  });

  it('revoked render requires sign out / new approval', async () => {
    store.setState({ sessionApproval: 'revoked' });
    render(<OfficeApprovalGate appStore={store} onSignOut={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/revoked/i);
  });

  it('error render fails closed with a retry that re-polls the server', async () => {
    store.setState({
      sessionApproval: 'error',
      sessionApprovalError: { message: 'offline', code: 'APPROVAL_STATUS_FAILED' },
    });
    render(<OfficeApprovalGate appStore={store} onSignOut={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/offline/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const refresh = vi.spyOn(store.getState(), 'refreshSessionApproval');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refresh).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// App-level gating — the workspace never mounts while the Office session is pending
// ---------------------------------------------------------------------------

describe('App-level gate', () => {
  it('Office with a PENDING approval sees the gate, never the workspace', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({ my: makeRequest({ status: 'pending' }) });

    render(<App authService={authService} approvalService={approvalService} sheetRepository={undefined} />);

    // The gate owns the screen. No top bar, no sheet, no dashboard.
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.queryByRole('banner', { name: 'DKS top bar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('Office with an APPROVED session reaches the workspace', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({ my: makeRequest({ status: 'approved' }) });

    render(<App authService={authService} approvalService={approvalService} />);

    await waitFor(() => expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('Admin is never gated regardless of approval service outcome', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-admin', role: 'admin' }));
    const { service: approvalService } = makeFakeApprovalService({
      rows: [makeRequest({ id: 'req-pending', status: 'pending' })],
    });

    render(<App authService={authService} approvalService={approvalService} />);

    await waitFor(() => expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument());
    // No blocked screen / no approval gate for admin.
    expect(screen.queryByRole('status', { name: /waiting for admin approval/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for admin approval/i)).not.toBeInTheDocument();
  });

  it('shared-PC account switch clears the previous Admin context (pending office cannot mount the workspace)', async () => {
    // Admin signed in, then logs out; Office logs in pending. Assert the
    // workspace never renders row data for the pending session.
    const authService = new AuthService(makeAuthClient({ id: 'user-admin', role: 'admin' }));
    const { service: approvalService } = makeFakeApprovalService({ my: makeRequest({ status: 'pending' }) });

    const { unmount } = render(<App authService={authService} approvalService={approvalService} />);
    await waitFor(() => expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument());
    unmount();

    // New App instance — office pending: workspace forbidden.
    const officeAuth = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    render(<App authService={officeAuth} approvalService={approvalService} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.queryByRole('banner', { name: 'DKS top bar' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Admin approvals panel — approve/deny/revoke in-app
// ---------------------------------------------------------------------------

describe('Admin approvals panel', () => {
  it('lists pending requests with Approve/Deny actions', async () => {
    const { service, calls } = makeFakeApprovalService({
      rows: [
        makeRequest({ id: 'req-1', status: 'pending', requestedAt: '2026-10-24T08:00:00.00Z' }),
        makeRequest({ id: 'req-2', status: 'approved', requestedAt: '2026-10-23T08:00:00.00Z' }),
      ],
    });
    render(<OfficeApprovalsPanel service={service} />);

    // Badge shows the pending count.
    fireEvent.click(screen.getByRole('button', { name: /office sign-in approvals/i }));
    await screen.findByRole('dialog');

    expect(screen.getByText(/requested/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.decideRequest).toEqual([{ id: 'req-1', decision: 'approved' }]));

    // After the decision the panel refetches — the fake returns the same list,
    // but the flow is the server refetch each time.
    expect(service.listRequests).toHaveBeenCalled();
  });

  it('revokes an approved session via Admin action', async () => {
    const { service, calls } = makeFakeApprovalService({
      rows: [makeRequest({ id: 'req-2', status: 'approved', decidedAt: '2026-10-23T10:00:00.00Z' })],
    });
    render(<OfficeApprovalsPanel service={service} />);

    fireEvent.click(screen.getByRole('button', { name: /office sign-in approvals/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.revokeRequest).toEqual(['req-2']));
  });

  it('in-app Admin notification banner (pending office sign-in) renders without staff identity', async () => {
    // The SQL trigger writes an admin_notifications row with the shared
    // "Office account" label; the panel itself never renders a staff name.
    const { service } = makeFakeApprovalService({
      rows: [makeRequest({ id: 'req-1', status: 'pending' })],
    });
    render(<OfficeApprovalsPanel service={service} />);
    fireEvent.click(screen.getByRole('button', { name: /office sign-in approvals/i }));
    await screen.findByRole('dialog');
    expect(screen.getByText(/office account/i)).toBeInTheDocument();
    // No arbitrary names beyond the shared-account label.
    expect(screen.queryByText(/user-office|office@example\.com/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Local-IPC clearance — pending Office cannot touch local cached records
// ---------------------------------------------------------------------------

describe('local IPC session clearance', () => {
  it('refuses customer-data channels while an Office session is pending, and allows them again afterwards', () => {
    const clearance = createLocalSessionClearance('office-pending');
    const store = makeLocalStore();

    const fakeIpc: LocalIpcMain = {
      handle: vi.fn((channel: string, handler: (payload?: unknown) => unknown) => {
        (fakeIpc as unknown as Record<string, unknown>)[channel] = handler;
      }),
      removeHandler: vi.fn(),
    } as unknown as LocalIpcMain;

    const unregister = registerLocalIpcHandlers({ ipcMain: fakeIpc, store, sessionClearance: clearance.get });

    const getSnapshot = (fakeIpc as unknown as Record<string, (payload?: unknown) => unknown>)[LOCAL_IPC_CHANNELS.getSnapshot];
    const createRow = (fakeIpc as unknown as Record<string, (payload?: unknown) => unknown>)[LOCAL_IPC_CHANNELS.createRow];

    expect(() => getSnapshot()).toThrow(/waiting for admin approval/i);
    expect(() => createRow({ data: { name: 'Zara' } })).toThrow(/waiting for admin approval/i);

    // And once approved (clearance allowed) the same handlers work again.
    clearance.set('allowed');
    expect(() => getSnapshot()).not.toThrow();

    unregister();
  });

  it('the close channel stays exempt (no customer data)', () => {
    const clearance = createLocalSessionClearance('office-pending');
    const store = makeLocalStore();
    const fakeIpc: LocalIpcMain = {
      handle: vi.fn((channel: string, handler: (payload?: unknown) => unknown) => {
        (fakeIpc as unknown as Record<string, unknown>)[channel] = handler;
      }),
      removeHandler: vi.fn(),
    } as unknown as LocalIpcMain;

    const unregister = registerLocalIpcHandlers({ ipcMain: fakeIpc, store, sessionClearance: clearance.get });
    const closeChannel = (fakeIpc as unknown as Record<string, (payload?: unknown) => unknown>)[LOCAL_IPC_CHANNELS.close];
    // Exempt: the channel must NOT raise the clearance error at all.
    expect(() => closeChannel()).not.toThrow();
    unregister();
  });

  it('without a clearance hook every handler works (offline/demo/default)', () => {
    const store = makeLocalStore();
    const handlers = createLocalIpcHandlers({ store });
    expect(() => handlers[LOCAL_IPC_CHANNELS.getSnapshot]()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gate styling contract — readable in light AND dark themes (no white-on-white)
// ---------------------------------------------------------------------------

describe('approval gate — readability contract', () => {
  it('uses theme-token classes on the pending card (title/body/meta/actions)', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({});
    const store = createAppStore(authService, approvalService);
    store.setState({
      sessionApproval: 'pending',
      sessionApprovalRequest: makeRequest({ requestedAt: '2026-10-24T09:00:00.000Z' }),
    });
    const { container } = render(<OfficeApprovalGate appStore={store} onSignOut={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveClass('office-approval-gate');
    expect(container.querySelector('.office-approval-card')).toBeInTheDocument();
    expect(container.querySelector('.office-approval-card__title')).toHaveTextContent(/waiting for admin approval/i);
    expect(container.querySelector('.office-approval-card__body')).not.toBeEmptyDOMElement();
    expect(container.querySelector('.office-approval-card__meta')).toHaveTextContent(/request submitted/i);
    expect(container.querySelector('.office-approval-card__actions')).toBeInTheDocument();
    // Exactly ONE card — no duplicate/empty panels.
    expect(container.querySelectorAll('.office-approval-card')).toHaveLength(1);
  });

  it('error state renders the technical detail as a styled secondary line plus both actions', async () => {
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }));
    const { service: approvalService } = makeFakeApprovalService({});
    const store = createAppStore(authService, approvalService);
    store.setState({
      sessionApproval: 'error',
      sessionApprovalError: { message: 'record "old" has no field "deleted"', code: 'APPROVAL_STATUS_FAILED' },
    });
    const { container } = render(<OfficeApprovalGate appStore={store} onSignOut={vi.fn()} />);

    expect(container.querySelector('.office-approval-card__title')).toHaveTextContent(/cannot verify sign-in approval/i);
    const detail = container.querySelector('.office-approval-card__detail');
    expect(detail).toHaveTextContent('record "old" has no field "deleted"');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('stylesheet paints the gate from theme tokens and keeps the error line readable', () => {
    const styles = readFileSync('src/renderer/styles.css', 'utf8');

    // The old broken fallbacks are gone: undefined --surface/--muted/--border
    // vars produced white-on-white cards in dark mode.
    expect(styles).not.toContain('var(--surface,');
    expect(styles).not.toContain('var(--muted,');
    expect(styles).not.toContain('var(--border, rgba');
    expect(styles).not.toContain('var(--shadow-lg,');

    expect(styles).toMatch(/\.office-approval-gate\s*\{[^}]*var\(--color-background\)/s);
    expect(styles).toMatch(/\.office-approval-card\s*\{[^}]*var\(--color-surface\)[^}]*color:\s*var\(--color-text\)/s);
    expect(styles).toMatch(/\.office-approval-card__meta\s*\{[^}]*var\(--color-text-subtle\)/s);
    expect(styles).toMatch(
      /\.office-approval-card__detail\s*\{[^}]*background:\s*var\(--color-surface-muted\)[^}]*color:\s*var\(--color-text-muted\)/s,
    );
  });
});
