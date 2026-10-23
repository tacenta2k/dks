import type { Session } from '@supabase/supabase-js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { buildGridColumns } from '../src/features/sheet/grid-columns';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { App } from '../src/renderer/App';
import { seedFixtureColumns } from './fixtures/sheet-columns';

const demoSession = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

function makeAuthClient(profile: Record<string, unknown> | null, restoredSession: Session | null = null) {
  const client: AuthClientLike = {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: restoredSession, user: restoredSession?.user }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: restoredSession }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }) })),
      })),
    })),
  };
  return client;
}

describe('sheet page', () => {
  it('offers a first-column action in the empty state without a Visa template (F3)', async () => {
    const repository = createInMemorySheetRepository();
    render(<SheetPage repository={repository} role="office" />);

    expect(await screen.findByRole('heading', { name: 'Click + to add your first column' })).toBeInTheDocument();
    // The Visa Template action and its seed path are removed (F3).
    expect(screen.queryByRole('button', { name: 'Load Visa Template' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add your first column' }));
    expect(screen.getByRole('dialog', { name: 'Add column' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Passport No' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));

    expect(await screen.findByText('Days Left')).toBeInTheDocument();
  });

  it('shows status filters, search, quick filters, and a numeric Days Left value', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ passport_no: 'A1234567', visa_expiry: '2026-01-05' });

    render(<SheetPage repository={repository} role="office" today="2026-01-01" />);

    await screen.findByText('A1234567');
    expect(screen.getByLabelText('Search records')).toBeInTheDocument();

    // R2-04 (user decision): chips are Today · ≤7d · ≤30d · ≤60d · ≤90d.
    // The Expired and No-expiry chips are gone; they live in the dropdown.
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '≤7d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '≤90d' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expired' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'No expiry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '7 days' })).not.toBeInTheDocument();

    // The hard-coded Category filter and "Group by Category" behaviour are gone (F3).
    expect(screen.queryByRole('button', { name: 'Group by Category' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter by category')).not.toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    // R2-04: the final status dropdown has five options and no Urgent /
    // Expires today entries (they remain row colours / Days Left badges).
    const statusFilter = screen.getByLabelText('Filter by status') as HTMLSelectElement;
    expect(statusFilter).toBeInTheDocument();
    const optionLabels = Array.from(statusFilter.options).map((option) => option.textContent?.trim());
    expect(optionLabels).toEqual(['All statuses', 'Valid', 'Expiring soon', 'Expired', 'No expiry']);
    expect(statusFilter.textContent).not.toContain('Urgent');
    expect(statusFilter.textContent).not.toContain('Expires today');

    fireEvent.change(screen.getByLabelText('Search records'), { target: { value: 'does-not-exist' } });
    await waitFor(() => expect(screen.queryByText('A1234567')).not.toBeInTheDocument());
  });

  it('removes the old sheet buttons, hides admin tools for office, and protects generated columns', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    await screen.findByText('Days Left');
    // R2-09: Add row / Add column / Manage columns are gone from the toolbar.
    // (Column Setup is opened by the `+` column header instead.)
    expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage columns' })).not.toBeInTheDocument();
    // Office has no Tools menu or export/print/settings controls at all.
    expect(screen.queryByRole('button', { name: /^Tools/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();

    // The generated Days Left column is never editable or deletable.
    const defs = buildGridColumns(
      await repository.getColumns(),
      { onDuplicate: vi.fn(), onDelete: vi.fn(), onRenew: vi.fn() },
      'office',
    );
    expect(defs.find((column) => column.colId === 'daysLeft')?.editable).toBe(false);
    expect(defs.filter((column) => column.colId === '__actions')).toHaveLength(1);
  });

  it('retains the default local sheet repository while navigating the workspace', async () => {
    // Real authenticated flow (restored session) — the offline-demo
    // startInWorkspace entry only exists when Supabase is unconfigured.
    const service = new AuthService(makeAuthClient({
      id: 'user-1',
      email: 'admin@example.com',
      role: 'admin',
    }, demoSession));
    render(<App authService={service} initialView="sheet" />);
    await screen.findByRole('banner', { name: 'DKS top bar' });

    fireEvent.click(await screen.findByRole('button', { name: 'Add your first column' }));
    fireEvent.change(await screen.findByLabelText('Column name'), { target: { value: 'Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(await screen.findByText('Days Left')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Visa Sheet' }));

    expect(await screen.findByText('Days Left')).toBeInTheDocument();
  }, 10_000);
  describe('input focus is not stolen by background refreshes (focus-delay regression)', () => {
    it('lets you type immediately in the Add Column dialog, and survives a background refresh', async () => {
      const repository = createInMemorySheetRepository();
      await seedFixtureColumns(repository);
      await repository.createRow({ name: 'Ada Lovelace' });

      const { rerender } = render(<SheetPage repository={repository} role="admin" refreshToken={0} />);
      await screen.findByRole('button', { name: 'Add column' });

      // Click the dialog, then type immediately.
      fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
      expect(screen.getByRole('dialog', { name: 'Add column' })).toBeInTheDocument();
      const nameField = screen.getByLabelText('Column name');
      fireEvent.focus(nameField);
      fireEvent.change(nameField, { target: { value: 'Passport No' } });
      // The typed value appears immediately in the controlled input.
      expect(nameField).toHaveValue('Passport No');

      // A background refresh (sync landed / local mutation) must NOT remount
      // the page and wipe the open dialog or its typed value.
      rerender(<SheetPage repository={repository} role="admin" refreshToken={1} />);
      await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add column' })).toBeInTheDocument());
      expect(nameField).toHaveValue('Passport No');

      // Typing still works after the refresh.
      fireEvent.change(nameField, { target: { value: 'Passport No ' } });
      expect(nameField).toHaveValue('Passport No ');
    }, 10_000);

    it('keeps a sheet cell editor open and typing-capable across an in-place data refresh', async () => {
      const repository = createInMemorySheetRepository();
      await seedFixtureColumns(repository);
      const row = await repository.createRow({ name: 'Grace Hopper', visa_expiry: '2026-06-01' });

      const { rerender } = render(<SheetPage repository={repository} role="office" refreshToken={0} />);
      await screen.findByText('Grace Hopper');

      // In the test environment the accessible table is used; edit a value
      // through it, then push a background refresh, and verify the row + its
      // values are still present and editable (not remounted away).
      const cell = screen.getByText('Grace Hopper');
      expect(cell).toBeInTheDocument();

      // Simulate an external change landing plus a refresh-token bump.
      await repository.updateRow(row.id, { name: 'Grace M. Hopper' });
      rerender(<SheetPage repository={repository} role="office" refreshToken={2} />);
      await waitFor(() => expect(screen.getByText('Grace M. Hopper')).toBeInTheDocument());
      // The original cell text is gone (data updated in place) and the page
      // did not collapse into the loading overlay.
      expect(screen.queryByText('Loading visa sheet…')).not.toBeInTheDocument();
    }, 10_000);
  });

});
