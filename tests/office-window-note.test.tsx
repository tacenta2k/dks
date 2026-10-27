import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

const NOTE = 'Showing records from the last 3 days.';

// OW-04: the Office Sheet shows a short note that records come from the last
// 3 days (the data itself is already scoped by the local store). Admin UI is
// unchanged — no note.
describe('office 3-day window — sheet note', () => {
  it('shows the note in the Office sheet toolbar', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    await screen.findByLabelText('Search records');
    expect(screen.getByRole('note')).toHaveTextContent(NOTE);
  });

  it('is absent for the Admin sheet', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="admin" />);

    await screen.findByLabelText('Search records');
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
