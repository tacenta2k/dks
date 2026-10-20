import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { App } from '../src/renderer/App';

describe('sheet page', () => {
  it('offers first-column and Visa template actions in the empty state', async () => {
    const repository = createInMemorySheetRepository();
    render(<SheetPage repository={repository} role="office" />);

    expect(await screen.findByRole('heading', { name: 'Add your first column' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Visa Template' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add your first column' }));
    expect(screen.getByRole('dialog', { name: 'Add column' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load Visa Template' }));
    expect(await screen.findByText('Days Left')).toBeInTheDocument();
  });

  it('shows status filters, search, category grouping, and a numeric Days Left value', async () => {
    const repository = createInMemorySheetRepository();
    await repository.loadTemplate('visa');
    await repository.createRow({ category: 'Employee', passport_no: 'A1234567', visa_expiry: '2026-01-05' });

    render(<SheetPage repository={repository} role="office" today="2026-01-01" />);

    await screen.findByText('A1234567');
    expect(screen.getByLabelText('Search records')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expired' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group by Category' })).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Group by Category' }));
    expect(await screen.findByText('Employee')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search records'), { target: { value: 'does-not-exist' } });
    await waitFor(() => expect(screen.queryByText('A1234567')).not.toBeInTheDocument());
  });

  it('hides admin-only sheet controls for office users and protects generated columns', async () => {
    const repository = createInMemorySheetRepository();
    await repository.loadTemplate('visa');
    render(<SheetPage repository={repository} role="office" />);

    await screen.findByText('Days Left');
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Manage columns' }));
    expect(screen.getByRole('button', { name: 'Delete Days Left column' })).toBeDisabled();
  });

  it('retains the default local sheet repository while navigating the workspace', async () => {
    render(<App initialView="sheet" startInWorkspace />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load Visa Template' }));
    expect(await screen.findByText('Days Left')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Sheet' }));

    expect(await screen.findByText('Days Left')).toBeInTheDocument();
  }, 10_000);
});
