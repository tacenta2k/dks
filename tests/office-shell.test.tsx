import type { Session } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { App } from '../src/renderer/App';
import type { ExpiryNotificationRecord } from '../src/features/notifications/alert-service';
import type { OfficeApprovalService } from '../src/features/auth/office-approval-service';
import { AppShell } from '../src/renderer/components/AppShell';

/** Office tested flows sit BEYOND the approval gate — this fake approves. */
function approvedApprovalService(): OfficeApprovalService {
  const row = {
    id: 'req-office-1',
    userId: 'user-office',
    status: 'approved' as const,
    requestedAt: '2026-10-24T09:00:00.000Z',
    decidedAt: '2026-10-24T09:30:00.000Z',
    decidedBy: 'user-admin',
  };
  return {
    requestApproval: vi.fn(async () => ({ data: row, error: null })),
    fetchMyRequest: vi.fn(async () => ({ data: row, error: null })),
    listRequests: vi.fn(async () => ({ data: [row], error: null })),
    decideRequest: vi.fn(async (id: string, decision: 'approved' | 'denied') => ({ data: { ...row, id, status: decision }, error: null })),
    revokeRequest: vi.fn(async (id: string) => ({ data: { ...row, id, status: 'revoked' as const }, error: null })),
  };
}

/**
 * R2-11 — Office and Admin share the same shell (sidebar, compact top bar,
 * sync pill with expandable details, bell popover). Office simply has fewer
 * menu items and no admin actions.
 */
const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'office-1',
    email: 'office@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

function officeClient(): AuthClientLike {
  return {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session, user: session.user }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'office-1', email: 'office@example.com', role: 'office' },
            error: null,
          }),
        })),
      })),
    })),
  } as AuthClientLike;
}

const alert: ExpiryNotificationRecord = {
  id: 'expiry:row-1:2026-01-07:7',
  kind: 'expiry',
  rowId: 'row-1',
  expiryColumnId: 'visa_expiry',
  expiryValue: '2026-01-07',
  daysLeft: 7,
  alertDay: 7,
  dedupeKey: 'expiry:row-1:2026-01-07:7',
  title: 'Expiry reminder',
  body: 'Amina expires in 7 days.',
  createdAt: '2026-01-01T09:00:00.000Z',
  read: false,
  dismissed: false,
};

describe('Office shell parity (R2-11)', () => {
  it('shows the same compact top bar, sync pill, and bell popover for Office', async () => {
    const service = new AuthService(officeClient());
    render(<App authService={service} initialView="sheet" approvalService={approvedApprovalService()} />);

    expect(await screen.findByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    // Same top-bar controls as Admin.
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
    // The old sidebar workspace-health box is gone for Office too.
    expect(screen.queryByText(/workspace health/i)).not.toBeInTheDocument();
    // Fewer nav items and no admin actions.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Visa Sheet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recycle Bin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Audit Log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Tools/ })).not.toBeInTheDocument();
  }, 20_000);

  it('shows the real sync state and per-item details in the shared popover', () => {
    render(
      <AppShell
        profile={{ id: 'office-1', email: 'office@example.com', role: 'office', fullName: 'Office' }}
        syncStatus={{ status: 'error', lastSyncAt: '2026-01-01T10:00:00.000Z', lastError: 'RLS denied', pendingCount: 2 }}
        pendingOutbox={[
          { id: 1, entityType: 'entry', operation: 'update', attempts: 3, lastError: 'RLS denied' },
          { id: 2, entityType: 'entry', operation: 'delete', attempts: 1, lastError: null },
        ]}
      />,
    );

    // R2-12: pending work is an error, never "Saved to cloud".
    expect(screen.getByTitle('Sync error · 2 pending')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Sync error · 2 pending'));
    expect(screen.getByText(/attempted 3×/)).toBeInTheDocument();
    expect(screen.getByText(/attempted 1×/)).toBeInTheDocument();
  });

  it('serves the same bell popover to Office (expiry alerts only)', () => {
    render(<AppShell profile={{ id: 'office-1', email: 'office@example.com', role: 'office', fullName: 'Office' }} notifications={[alert]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Notifications (1 unread)' }));
    expect(screen.getByText('Amina expires in 7 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('lets an approved Office user install a downloaded update without Settings access', async () => {
    let emitStatus: ((state: { status: string; version?: string }) => void) | undefined;
    const restartToUpdate = vi.fn(async () => true);
    const updater = {
      checkForUpdates: vi.fn(async () => ({ status: 'idle' })),
      restartToUpdate,
      onStatus: vi.fn((listener: typeof emitStatus) => {
        emitStatus = listener;
        return () => {
          emitStatus = undefined;
        };
      }),
    };
    const service = new AuthService(officeClient());

    render(
      <App
        authService={service}
        approvalService={approvedApprovalService()}
        updater={updater as never}
      />,
    );

    expect(await screen.findByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(updater.onStatus).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(screen.queryByText('Update 0.1.1 ready')).not.toBeInTheDocument();

    act(() => emitStatus?.({ status: 'downloaded', version: '0.1.1' }));

    expect(screen.getByText('Update 0.1.1 ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    const dialog = screen.getByRole('dialog', { name: 'Restart to install update?' });
    expect(dialog).toHaveTextContent('Restart DKS to install update 0.1.1?');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(restartToUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Restart to install update?' }))
        .getByRole('button', { name: 'Restart now' }),
    );
    await waitFor(() => expect(restartToUpdate).toHaveBeenCalledTimes(1));
  }, 20_000);
});
