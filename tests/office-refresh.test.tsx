import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { createLocalIpcHandlers, LOCAL_IPC_CHANNELS } from '../electron/main/local-ipc';
import { createSqliteStore } from '../electron/main/sqlite';
import { DashboardPage } from '../src/features/dashboard/DashboardPage';
import { ElectronSheetRepository } from '../src/features/sheet/electron-repository';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { can } from '../src/lib/permissions';
import type { DksWindowApi } from '../src/lib/types';
import { seedFixtureColumns } from './fixtures/sheet-columns';

/**
 * Bug 3 regression — Office users had no Refresh on the Visa Sheet.
 *
 * Refresh is now an explicit `refresh` capability (Admin + Office). The
 * sheet button runs the host sync (when supplied) and then reloads the
 * role-scoped local snapshot, so Office keeps its 3-day (Asia/Muscat)
 * window. Synthetic rows only.
 */
describe('refresh capability (Bug 3)', () => {
  it('grants refresh to Office and Admin, and denies everyone else', () => {
    expect(can('office', 'refresh')).toBe(true);
    expect(can('admin', 'refresh')).toBe(true);
    expect(can('viewer', 'refresh')).toBe(false);
    expect(can(undefined, 'refresh')).toBe(false);
    expect(can(null, 'refresh')).toBe(false);
    // The new capability widens nothing else for Office.
    expect(can('office', 'export')).toBe(false);
    expect(can('office', 'permanentDelete')).toBe(false);
    expect(can('office', 'recycleBin')).toBe(false);
  });
});

describe('Visa Sheet Refresh button (Bug 3)', () => {
  it('is shown to Office, runs one sync at a time, and reloads the rows', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ name: 'Before Refresh' });

    let finishSync: (() => void) | undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => {
      finishSync = resolve;
    }));

    render(<SheetPage repository={repository} role="office" onRefresh={onRefresh} />);
    const button = await screen.findByRole('button', { name: 'Refresh' });
    expect(button).toBeEnabled();

    // A row lands in the repository (e.g. via sync) after first load.
    await repository.createRow({ name: 'After Refresh' });

    fireEvent.click(button);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    // While the sync runs, the existing loading state shows and the button
    // is disabled; extra clicks cannot overlap a second refresh.
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Refreshing…');
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    finishSync?.();
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Sync complete\. Visa Sheet refreshed\./,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    // The reload after the sync shows the newly landed row.
    expect(screen.getAllByText('After Refresh').length).toBeGreaterThan(0);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('still reloads local data when the sync fails, and works without a host sync', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    const onRefresh = vi.fn().mockRejectedValue(new Error('offline'));

    render(<SheetPage repository={repository} role="office" onRefresh={onRefresh} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(
      /Sync did not complete \(offline\)\. Showing the latest local data\./,
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  }, 20_000);

  it('is shown to Admin as before and hidden from roles without the capability', async () => {
    const adminRepository = createInMemorySheetRepository();
    await seedFixtureColumns(adminRepository);
    const adminView = render(<SheetPage repository={adminRepository} role="admin" />);
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    adminView.unmount();

    const otherRepository = createInMemorySheetRepository();
    await seedFixtureColumns(otherRepository);
    render(<SheetPage repository={otherRepository} role="viewer" />);
    // The sheet still loads (draft row present), but no Refresh is offered.
    await screen.findByLabelText('New record Name');
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  }, 20_000);

  it('Office refresh never exposes records older than the 3-day window', async () => {
    const now = '2026-03-08T12:00:00.000Z'; // Muscat 2026-03-08 → cutoff 03-05
    const store = createSqliteStore({ filename: ':memory:', now: () => now });
    try {
      store.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0 });
      store.applyRemoteEntry({
        id: 'recent-row',
        data: { name: 'Recent Person' },
        created_at: '2026-03-07T10:00:00.000Z',
        updated_at: '2026-03-07T10:00:00.000Z',
      });
      store.applyRemoteEntry({
        id: 'old-row',
        data: { name: 'Old Person' },
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      });
      const handlers = createLocalIpcHandlers({ store, now: () => now });
      // The exact read the Electron repository performs for Refresh: the
      // snapshot IPC scoped by the validated session role.
      const windowApi = {
        platform: 'test',
        appVersion: '0',
        local: {
          getSnapshot: async (input?: { role?: string }) => (
            handlers[LOCAL_IPC_CHANNELS.getSnapshot](input)
          ),
        },
      } as unknown as DksWindowApi;
      const repository = new ElectronSheetRepository({ windowApi, role: 'office' });
      const onRefresh = vi.fn(async () => undefined);

      render(<SheetPage repository={repository} role="office" onRefresh={onRefresh} />);
      expect((await screen.findAllByText('Recent Person')).length).toBeGreaterThan(0);
      expect(screen.queryByText('Old Person')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(await screen.findByRole('status')).toHaveTextContent(/Visa Sheet refreshed/);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      // After a manual Office refresh the old record is STILL not exposed.
      expect((await screen.findAllByText('Recent Person')).length).toBeGreaterThan(0);
      expect(screen.queryByText('Old Person')).not.toBeInTheDocument();

      // Admin behavior is unchanged: the same store read unfiltered sees the
      // in-window row (the old one left the Office cache via the visibility
      // purge, exactly as before this change).
      const adminSnapshot = handlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'admin' }) as {
        rows: { id: string }[];
      };
      expect(adminSnapshot.rows.map((row) => row.id)).toContain('recent-row');
    } finally {
      store.close();
    }
  }, 20_000);
});

describe('Dashboard Refresh capability gating (Bug 3)', () => {
  it('Office and Admin can use it; an unknown role cannot see it', async () => {
    const officeRefresh = vi.fn(async () => undefined);
    const officeView = render(<DashboardPage role="office" onRefresh={officeRefresh} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(officeRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/Dashboard refreshed/);
    officeView.unmount();

    const adminView = render(<DashboardPage role="admin" onRefresh={vi.fn(async () => undefined)} />);
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeEnabled();
    adminView.unmount();

    render(<DashboardPage role="viewer" onRefresh={vi.fn(async () => undefined)} />);
    await screen.findByText('Expiry summary');
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  }, 20_000);
});
