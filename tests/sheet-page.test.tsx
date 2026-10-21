import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { App } from '../src/renderer/App';
import { seedFixtureColumns } from './fixtures/sheet-columns';

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
    expect(screen.getByRole('button', { name: 'Expired' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toBeInTheDocument();
    // The hard-coded Category filter and "Group by Category" behaviour are gone (F3).
    expect(screen.queryByRole('button', { name: 'Group by Category' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter by category')).not.toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    // The five-status model is available in the Status filter.
    const statusFilter = screen.getByLabelText('Filter by status');
    expect(statusFilter).toBeInTheDocument();
    expect(statusFilter.textContent).toContain('Expires today');

    fireEvent.change(screen.getByLabelText('Search records'), { target: { value: 'does-not-exist' } });
    await waitFor(() => expect(screen.queryByText('A1234567')).not.toBeInTheDocument());
  });

  it('hides admin-only sheet controls for office users and protects generated columns', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    await screen.findByText('Days Left');
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Manage columns' }));
    expect(screen.getByRole('button', { name: 'Delete Days Left column' })).toBeDisabled();
  });

  it('retains the default local sheet repository while navigating the workspace', async () => {
    render(<App initialView="sheet" startInWorkspace />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add your first column' }));
    fireEvent.change(await screen.findByLabelText('Column name'), { target: { value: 'Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(await screen.findByText('Days Left')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Sheet' }));

    expect(await screen.findByText('Days Left')).toBeInTheDocument();
  }, 10_000);
});
