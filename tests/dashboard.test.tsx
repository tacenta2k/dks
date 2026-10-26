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
    // every upcoming card, and only the past date counts as Expired.
    expect(screen.getByTestId('dashboard-card-1-day')).toHaveTextContent('1');
    expect(screen.getByTestId('dashboard-card-week')).toHaveTextContent('2');
    expect(screen.getByTestId('dashboard-card-month')).toHaveTextContent('3');
    expect(screen.getByTestId('dashboard-card-3-months')).toHaveTextContent('5');
    expect(screen.getByTestId('dashboard-card-6-months')).toHaveTextContent('6');
    expect(screen.getByTestId('dashboard-card-1-year')).toHaveTextContent('7');
    expect(screen.getByTestId('dashboard-card-expired')).toHaveTextContent('1');
    // The removed cards must not come back.
    expect(screen.queryByTestId('dashboard-card-today')).toBeNull();
    expect(screen.queryByTestId('dashboard-card-2-months')).toBeNull();
    expect(screen.queryByText('Expiring today')).toBeNull();
    expect(screen.queryByText('Within 2 months')).toBeNull();
    // Exact card set and order.
    const cardIds = Array.from(document.querySelectorAll('[data-testid^="dashboard-card-"]'))
      .map((node) => node.getAttribute('data-testid'));
    expect(cardIds).toEqual([
      'dashboard-card-total',
      'dashboard-card-1-day',
      'dashboard-card-week',
      'dashboard-card-month',
      'dashboard-card-3-months',
      'dashboard-card-6-months',
      'dashboard-card-1-year',
      'dashboard-card-expired',
    ]);
    for (const label of ['Total entries', 'Expires in 1 day', 'This week', 'This month', '3 months', '6 months', '1 year']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('img', { name: 'Status breakdown' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Expiries over the next 12 months' })).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.getAllByText('Expired').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Expires today')).toBeInTheDocument();
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

  it('keeps forecast month labels aligned when the twelve-month window crosses December', () => {
    const summary = getDashboardSummary(
      [{ id: 'row-1', data: { visa_expiry: '2027-01-02' } }],
      [{ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true }],
      { today: '2026-12-15' },
    );

    expect(summary.nextTwelveMonths[1]).toMatchObject({ key: '2027-01', month: 'Jan 2027', count: 1 });
  });
});
