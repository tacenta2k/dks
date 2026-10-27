/**
 * App wiring for the live Visa Sheet Realtime channel.
 *
 * The workspace may only subscribe while the session is authenticated and — for
 * Office — approved for THIS signed session. Sign-out and revocation must
 * unsubscribe, and the Office gate state must never open a channel.
 */
import type { Session } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import type {
  OfficeApprovalService,
  OfficeSigninRequest,
} from '../src/features/auth/office-approval-service';
import { App } from '../src/renderer/App';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { LIVE_SHEET_CHANNEL } from '../src/features/sync/live-sheet-realtime';

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

interface FakeRealtime {
  channels: Array<{ name: string; filters: Record<string, string>[]; subscribed: number }>;
  handles: unknown[];
  removeChannel: ReturnType<typeof vi.fn>;
  channel: ReturnType<typeof vi.fn>;
}

function makeRealtime(): FakeRealtime {
  const channels: FakeRealtime['channels'] = [];
  const handles: unknown[] = [];
  const channel = vi.fn((name: string) => {
    const record = { name, filters: [] as Record<string, string>[], subscribed: 0 };
    const handle = {
      on: (_event: string, filter: Record<string, string>) => {
        record.filters.push(filter);
        return handle;
      },
      subscribe: () => {
        record.subscribed += 1;
        return handle;
      },
    };
    channels.push(record);
    handles.push(handle);
    return handle;
  });
  const removeChannel = vi.fn(() => Promise.resolve('ok'));
  return { channels, handles, removeChannel, channel };
}

function makeAuthClient(
  profile: Record<string, unknown> | null,
  restored: Session | null,
  realtime: FakeRealtime,
): AuthClientLike {
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
    channel: realtime.channel,
    removeChannel: realtime.removeChannel,
  } as unknown as AuthClientLike;
}

function makeRequest(status: OfficeSigninRequest['status']): OfficeSigninRequest {
  return {
    id: 'req-1',
    userId: 'user-office',
    status,
    requestedAt: '2026-10-24T09:00:00.000Z',
    decidedAt: status === 'pending' ? null : '2026-10-24T09:30:00.000Z',
    decidedBy: status === 'pending' ? null : 'user-admin',
  };
}

function makeApprovalService(initial: OfficeSigninRequest | null) {
  const state = { current: initial, wake: undefined as undefined | (() => void) };
  const service: OfficeApprovalService = {
    requestApproval: vi.fn(async () => ({ data: state.current, error: null })),
    fetchMyRequest: vi.fn(async () => ({ data: state.current, error: null })),
    listRequests: vi.fn(async () => ({ data: state.current ? [state.current] : [], error: null })),
    decideRequest: vi.fn(async () => ({ data: state.current, error: null })),
    revokeRequest: vi.fn(async () => ({ data: state.current, error: null })),
    signOutAllOfficeSessions: vi.fn(async () => ({
      data: { officeUsers: 1, authSessionsDeleted: 0, requestsRevoked: 0 },
      error: null,
    })),
    subscribeChanges: vi.fn((callback: () => void) => {
      state.wake = callback;
      return () => { state.wake = undefined; };
    }),
  };
  return { service, state };
}

function installLocalBridge() {
  const syncState = { status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0 };
  const snapshot = { rows: [], deletedRows: [], columns: [], syncStatus: syncState };
  const local = {
    setSessionClearance: vi.fn(async (next: string) => next),
    getSnapshot: vi.fn(async () => snapshot),
    applyRemoteSnapshot: vi.fn(async () => snapshot),
    setSyncStatus: vi.fn(async (state: object) => ({ ...syncState, ...state })),
    acknowledgeOutbox: vi.fn(async () => ({ ...syncState, status: 'healthy' as const })),
    listOutbox: vi.fn(async () => []),
    retryFailedOutbox: vi.fn(async () => ({ requeued: 0 })),
    listNotifications: vi.fn(async () => []),
  };
  Object.defineProperty(window, 'dks', { configurable: true, value: { local } });
  return local;
}

const liveSheetChannels = (realtime: FakeRealtime) => realtime.channels.filter(
  (channel) => channel.name === LIVE_SHEET_CHANNEL,
);

beforeEach(() => {
  installLocalBridge();
});

describe('live sheet Realtime App wiring', () => {
  it('never opens a channel while the Office session awaits approval', async () => {
    const realtime = makeRealtime();
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }, officeSession, realtime));
    const { service } = makeApprovalService(makeRequest('pending'));

    render(
      <App
        authService={authService}
        approvalService={service}
        sheetRepository={createInMemorySheetRepository()}
      />,
    );

    expect(await screen.findByRole('status', { name: /waiting for admin approval/i })).toBeInTheDocument();
    expect(realtime.channel).not.toHaveBeenCalled();
    expect(realtime.channels).toHaveLength(0);
  });

  it('never opens a channel for a signed-out client', async () => {
    const realtime = makeRealtime();
    const authService = new AuthService(makeAuthClient(null, null, realtime));
    const { service } = makeApprovalService(null);

    render(
      <App
        authService={authService}
        approvalService={service}
        sheetRepository={createInMemorySheetRepository()}
      />,
    );

    // AuthScreen (no workspace) and no Realtime subscription.
    await waitFor(() => expect(screen.queryByRole('banner', { name: 'DKS top bar' })).not.toBeInTheDocument());
    expect(realtime.channel).not.toHaveBeenCalled();
  });

  it('subscribes ONE channel to entries + app_columns for an approved session', async () => {
    const realtime = makeRealtime();
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }, officeSession, realtime));
    const { service } = makeApprovalService(makeRequest('approved'));

    render(
      <App
        authService={authService}
        approvalService={service}
        sheetRepository={createInMemorySheetRepository()}
      />,
    );

    await waitFor(() => expect(liveSheetChannels(realtime)).toHaveLength(1));
    const [channel] = liveSheetChannels(realtime);
    expect(realtime.channels.filter((candidate) => candidate.name === LIVE_SHEET_CHANNEL)).toHaveLength(1);
    expect(channel?.filters).toEqual([
      { event: '*', schema: 'public', table: 'entries' },
      { event: '*', schema: 'public', table: 'app_columns' },
    ]);
    expect(channel?.subscribed).toBe(1);

    // The workspace really mounted (this is the approved, allowed state).
    await waitFor(() => expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument());
  });

  it('unsubscribes when the Office session is revoked', async () => {
    const realtime = makeRealtime();
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }, officeSession, realtime));
    const { service, state } = makeApprovalService(makeRequest('approved'));

    render(
      <App
        authService={authService}
        approvalService={service}
        sheetRepository={createInMemorySheetRepository()}
      />,
    );

    await waitFor(() => expect(liveSheetChannels(realtime)).toHaveLength(1));
    await waitFor(() => expect(state.wake).toBeTypeOf('function'));

    state.current = makeRequest('revoked');
    act(() => state.wake?.());

    await waitFor(() => expect(realtime.removeChannel).toHaveBeenCalledTimes(1));
    expect(realtime.removeChannel).toHaveBeenCalledWith(realtime.handles[0]);
    await waitFor(() => expect(screen.queryByRole('banner', { name: 'DKS top bar' })).not.toBeInTheDocument());
  });

  it('unsubscribes on sign-out', async () => {
    const realtime = makeRealtime();
    const authService = new AuthService(makeAuthClient({ id: 'user-office', role: 'office' }, officeSession, realtime));
    const { service } = makeApprovalService(makeRequest('approved'));

    render(
      <App
        authService={authService}
        approvalService={service}
        sheetRepository={createInMemorySheetRepository()}
      />,
    );

    await waitFor(() => expect(liveSheetChannels(realtime)).toHaveLength(1));
    await screen.findByRole('banner', { name: 'DKS top bar' });

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: /log out/i }));

    await waitFor(() => expect(realtime.removeChannel).toHaveBeenCalled());
  });
});
