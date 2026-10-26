import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

/**
 * Dashboard card → Visa Sheet navigation at the SheetPage seam: the sheet
 * must open filtered to exactly the rows the clicked card counted.
 */
describe('dashboard card sheet filters', () => {
  async function seededRepository() {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ name: 'Day Zero', visa_expiry: '2026-01-01' });
    await repository.createRow({ name: 'Day One', visa_expiry: '2026-01-02' });
    await repository.createRow({ name: 'Day Five', visa_expiry: '2026-01-06' });
    await repository.createRow({ name: 'Day Forty', visa_expiry: '2026-02-10' });
    await repository.createRow({ name: 'Long Gone', visa_expiry: '2025-12-29' });
    await repository.createRow({ name: 'Far Future', visa_expiry: '2027-06-01' });
    await repository.createRow({ name: 'No Expiry' });
    return repository;
  }

  it('opens the 1-day card with day 0 and day 1 only', async () => {
    const repository = await seededRepository();
    render(
      <SheetPage
        repository={repository}
        role="office"
        today="2026-01-01"
        dashboardFilter="expiresIn1Day"
        dashboardFilterToken={1}
      />,
    );

    expect(await screen.findByText('Day Zero')).toBeInTheDocument();
    expect(screen.getByText('Day One')).toBeInTheDocument();
    for (const hidden of ['Day Five', 'Day Forty', 'Long Gone', 'Far Future', 'No Expiry']) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    }
  });

  it('applies week, 1-year, expired and total cards as their tokens arrive', async () => {
    const repository = await seededRepository();
    const { rerender } = render(
      <SheetPage
        repository={repository}
        role="office"
        today="2026-01-01"
        dashboardFilter="expiringThisWeek"
        dashboardFilterToken={1}
      />,
    );

    expect(await screen.findByText('Day Five')).toBeInTheDocument();
    expect(screen.queryByText('Day Forty')).not.toBeInTheDocument();

    rerender(
      <SheetPage
        repository={repository}
        role="office"
        today="2026-01-01"
        dashboardFilter="within1Year"
        dashboardFilterToken={2}
      />,
    );
    await waitFor(() => expect(screen.getByText('Day Forty')).toBeInTheDocument());
    expect(screen.queryByText('Far Future')).not.toBeInTheDocument();
    expect(screen.queryByText('Long Gone')).not.toBeInTheDocument();
    expect(screen.queryByText('No Expiry')).not.toBeInTheDocument();

    rerender(
      <SheetPage
        repository={repository}
        role="office"
        today="2026-01-01"
        dashboardFilter="expired"
        dashboardFilterToken={3}
      />,
    );
    await waitFor(() => expect(screen.getByText('Long Gone')).toBeInTheDocument());
    expect(screen.queryByText('Day Zero')).not.toBeInTheDocument();

    rerender(
      <SheetPage
        repository={repository}
        role="office"
        today="2026-01-01"
        dashboardFilter="all"
        dashboardFilterToken={4}
      />,
    );
    await waitFor(() => expect(screen.getByText('No Expiry')).toBeInTheDocument());
    for (const visible of ['Day Zero', 'Day One', 'Day Five', 'Day Forty', 'Long Gone', 'Far Future']) {
      expect(screen.getByText(visible)).toBeInTheDocument();
    }
  });
});
