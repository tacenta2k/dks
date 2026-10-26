import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '../src/features/dashboard/DashboardPage';
import { getDashboardSummary } from '../src/features/dashboard/selectors';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

describe('dashboard page', () => {
  it('renders expiry cards, status pie, and the next twelve month chart from repository rows', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ visa_expiry: '2026-01-01' });
    await repository.createRow({ visa_expiry: '2026-01-07' });
    await repository.createRow({ visa_expiry: '2026-01-20' });
    await repository.createRow({ visa_expiry: '2026-02-15' });
    await repository.createRow({ visa_expiry: '2026-03-15' });
    await repository.createRow({ visa_expiry: '2026-05-15' });
    await repository.createRow({ visa_expiry: '2026-12-15' });
    await repository.createRow({ visa_expiry: '2025-12-31' });
    await repository.createRow({ name: 'No expiry yet' });

    render(<DashboardPage repository={repository} today="2026-01-01" />);

    expect(await screen.findByTestId('dashboard-card-total')).toHaveTextContent('9');
    // Cumulative 0-based windows: the entry expiring today (day 0) is inside
    // every upcoming card (and has its own Expires today card), and only the
    // past date counts as Expired.
    expect(screen.getByTestId('dashboard-card-today')).toHaveTextContent('1');
    expect(screen.getByTestId('dashboard-card-1-day')).toHaveTextContent('1');
    expect(screen.getByTestId('dashboard-card-week')).toHaveTextContent('2');
    expect(screen.getByTestId('dashboard-card-month')).toHaveTextContent('3');
    expect(screen.getByTestId('dashboard-card-3-months')).toHaveTextContent('5');
    expect(screen.getByTestId('dashboard-card-6-months')).toHaveTextContent('6');
    expect(screen.getByTestId('dashboard-card-1-year')).toHaveTextContent('7');
    expect(screen.getByTestId('dashboard-card-expired')).toHaveTextContent('1');
    // The removed "Within 2 months" card must not come back.
    expect(screen.queryByTestId('dashboard-card-2-months')).toBeNull();
    expect(screen.queryByText('Within 2 months')).toBeNull();
    // Exact nine-card set and requested order: Total, Expired, Expires
    // today, then Expires in 1 day, with the remaining windows unchanged.
    const cardIds = Array.from(document.querySelectorAll('[data-testid^="dashboard-card-"]'))
      .map((node) => node.getAttribute('data-testid'));
    expect(cardIds).toEqual([
      'dashboard-card-total',
      'dashboard-card-expired',
      'dashboard-card-today',
      'dashboard-card-1-day',
      'dashboard-card-week',
      'dashboard-card-month',
      'dashboard-card-3-months',
      'dashboard-card-6-months',
      'dashboard-card-1-year',
    ]);
    for (const label of ['Total entries', 'Expires in 1 day', 'This week', 'This month', '3 months', '6 months', '1 year']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // "Expires today" appears as the card label and in the status legend.
    expect(screen.getAllByText('Expires today').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('dashboard-card-today')).toHaveTextContent('Expires today');
    expect(screen.getByRole('img', { name: 'Status breakdown' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Expiries over the next 12 months' })).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.getAllByText('Expired').length).toBeGreaterThanOrEqual(1);
    // Legend keeps its own "Expires today" status entry alongside the card.
    expect(screen.getAllByText('Expires today').length).toBeGreaterThanOrEqual(2);
  });

  it('calls the injected filter callback when an expiry card is selected', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ visa_expiry: '2026-01-03' });
    const onFilter = vi.fn();

    render(
      <DashboardPage
        repository={repository}
        today="2026-01-01"
        onFilter={onFilter}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /This week/i }));

    expect(onFilter).toHaveBeenCalledWith('expiringThisWeek');
  });

  it('runs the host refresh once at a time, then reloads repository data', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ visa_expiry: '2026-01-01' });

    let finishRefresh: (() => void) | undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));

    render(
      <DashboardPage
        repository={repository}
        today="2026-01-01"
        onRefresh={onRefresh}
      />,
    );

    const button = await screen.findByRole('button', { name: 'Refresh' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Refreshing…');
    expect(button).toHaveAttribute('aria-busy', 'true');

    // Simulate data arriving during the host sync; the manual action must
    // reload the repository after the sync promise settles.
    await repository.createRow({ visa_expiry: '2026-01-02' });
    finishRefresh?.();

    expect(await screen.findByText('Sync complete. Dashboard refreshed.')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-total')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('reports a failed host sync but still reloads the latest local data', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ visa_expiry: '2026-01-01' });
    const onRefresh = vi.fn().mockRejectedValue(new Error('offline'));

    render(
      <DashboardPage
        repository={repository}
        today="2026-01-01"
        onRefresh={onRefresh}
      />,
    );

    expect(await screen.findByTestId('dashboard-card-total')).toHaveTextContent('1');
    await repository.createRow({ visa_expiry: '2026-01-03' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sync did not complete (offline). Showing the latest local data.',
    );
    expect(screen.getByTestId('dashboard-card-total')).toHaveTextContent('2');
  });

  it('refreshes only local data when no host sync is supplied', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ visa_expiry: '2026-01-01' });

    render(<DashboardPage repository={repository} today="2026-01-01" />);

    expect(await screen.findByTestId('dashboard-card-total')).toHaveTextContent('1');
    await repository.createRow({ visa_expiry: '2026-01-04' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Dashboard refreshed.')).toBeInTheDocument();
    expect(screen.queryByText(/sync complete/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-total')).toHaveTextContent('2');
  });

  it('keeps forecast month labels aligned when the twelve-month window crosses December', () => {
    const summary = getDashboardSummary(
      [{ id: 'row-1', data: { visa_expiry: '2027-01-02' } }],
      [{ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true }],
      { today: '2026-12-15' },
    );

    expect(summary.nextTwelveMonths[1]).toMatchObject({ key: '2027-01', month: 'Jan 2027', count: 1 });
  });
});
