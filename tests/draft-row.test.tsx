import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

/**
 * SHEET-11 — one blank draft row pinned at the bottom.
 * In the jsdom test environment the sheet renders its accessible table, which
 * offers the same draft row (the AG Grid surface is covered by its own tests).
 */
describe('sheet draft row (SHEET-11)', () => {
  it('creates exactly one record from the first meaningful value', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    await screen.findByLabelText('New record Passport No');
    expect(await repository.getRows()).toHaveLength(0);

    const input = screen.getByLabelText('New record Passport No');
    fireEvent.focus(input);
    // Focusing / clicking alone creates nothing.
    expect(await repository.getRows()).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'A1234567' } });
    // Typing alone (before the commit) still creates nothing.
    expect(await repository.getRows()).toHaveLength(0);

    fireEvent.blur(input);
    await waitFor(async () => expect(await repository.getRows()).toHaveLength(1));
    const [row] = await repository.getRows();
    expect(row.data.passport_no).toBe('A1234567');
    // A fresh, empty draft row is available again.
    expect(screen.getByLabelText('New record Passport No')).toHaveValue('');
  }, 20_000);

  it('ignores blank values when the draft row loses focus', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    const input = await screen.findByLabelText('New record Passport No');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repository.getRows()).toHaveLength(0);
  }, 20_000);
});
