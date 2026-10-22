import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { AppShell, type SyncPendingItem } from '../src/renderer/components/AppShell';
import type { DksLocalSyncState } from '../src/lib/types';

function officeProfile() {
  return {
    id: 'office-1',
    email: 'office@dks.test',
    role: 'office' as const,
    fullName: 'Office User',
  };
}

function syncState(overrides: Partial<DksLocalSyncState> = {}): DksLocalSyncState {
  return {
    status: 'healthy',
    lastSyncAt: '2026-01-05T00:00:00.000Z',
    lastError: null,
    pendingCount: 0,
    ...overrides,
  };
}

describe('sync status panel (Blocker 3, UI)', () => {
  it('shows the sanitised failure reason and per-item details on error', () => {
    const pendingOutbox: readonly SyncPendingItem[] = [
      {
        id: 11,
        entityType: 'entry',
        operation: 'upsert',
        attempts: 2,
        lastError: 'row-level security violation: [redacted] rejected',
      },
      {
        id: 12,
        entityType: 'column',
        operation: 'upsert',
        attempts: 1,
        lastError: null,
      },
    ];
    const { container } = render(
      <AppShell
        profile={officeProfile()}
        syncStatus={syncState({
          status: 'error',
          lastError: 'Row 11111111: row-level security violation: [redacted] rejected',
          pendingCount: 2,
        })}
        pendingOutbox={pendingOutbox}
      />,
    );

    // The count is never hidden.
    expect(screen.getByText(/Sync error · 2 pending/)).toBeInTheDocument();
    // Per-item breakdown, expandable without hiding anything.
    const details = container.querySelector('details.sync-status__issues');
    expect(details).not.toBeNull();
    // The exact (sanitised) failure reason is visible in the status details.
    expect(details?.querySelector('summary')?.textContent)
      .toContain('row-level security violation');
    expect(
      screen.getByText(/entry · upsert · attempted 2× · row-level security violation: \[redacted\] rejected/),
    ).toBeInTheDocument();
    // An item without a stored reason waits visibly instead of vanishing.
    expect(screen.getByText(/column · upsert · attempted 1× · waiting for sync/))
      .toBeInTheDocument();
  });

  it('lists pending changes as waiting when no failure reason is stored yet', () => {
    const pendingOutbox: readonly SyncPendingItem[] = [
      { id: 21, entityType: 'entry', operation: 'create', attempts: 0, lastError: null },
      { id: 22, entityType: 'settings', operation: 'save', attempts: 0, lastError: null },
    ];
    const { container } = render(
      <AppShell
        profile={officeProfile()}
        syncStatus={syncState({ pendingCount: 2 })}
        pendingOutbox={pendingOutbox}
      />,
    );

    expect(screen.getByText(/· 2 pending/)).toBeInTheDocument();
    const details = container.querySelector('details.sync-status__issues');
    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')?.textContent)
      .toBe('2 pending changes');
    expect(screen.getByText(/entry · create · attempted 0× · waiting for sync/))
      .toBeInTheDocument();
    expect(screen.getByText(/settings · save · attempted 0× · waiting for sync/))
      .toBeInTheDocument();
  });

  it('hides the issue block entirely when there is nothing pending and no error', () => {
    const { container } = render(
      <AppShell
        profile={officeProfile()}
        syncStatus={syncState()}
      />,
    );

    expect(container.querySelector('details.sync-status__issues')).toBeNull();
    expect(screen.queryByText(/row-level security/)).not.toBeInTheDocument();
  });
});
