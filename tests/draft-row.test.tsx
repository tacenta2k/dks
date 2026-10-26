import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

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

  it('does not submit repeated draft commits while the first create is pending', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);

    const originalCreateRow = repository.createRow.bind(repository);
    let finishFirstCreate: (() => void) | undefined;
    const createRow = vi.fn(async (
      data: Record<string, unknown> = {},
      category: string | null = null,
    ) => {
      if (createRow.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          finishFirstCreate = resolve;
        });
      }
      return originalCreateRow(data, category);
    });
    repository.createRow = createRow;

    render(<SheetPage repository={repository} role="office" />);
    const input = await screen.findByLabelText('New record Name');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Same Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The accessible draft Enter handler commits by blurring the input;
    // jsdom does not synthesize that blur from HTMLElement.blur() here.
    fireEvent.blur(input);
    await waitFor(() => expect(createRow).toHaveBeenCalledTimes(1));

    // A second Enter/blur commit from the same draft while the first create
    // is still in flight must not create a duplicate record.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Same Name' } });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    fireEvent.blur(input);
    expect(createRow).toHaveBeenCalledTimes(1);

    finishFirstCreate?.();
    await waitFor(async () => expect(await repository.getRows()).toHaveLength(1));

    // This is only an in-flight guard: after the first save settles, another
    // legitimate record may use exactly the same name.
    const nextInput = screen.getByLabelText('New record Name');
    fireEvent.focus(nextInput);
    fireEvent.change(nextInput, { target: { value: 'Same Name' } });
    fireEvent.keyDown(nextInput, { key: 'Enter' });
    fireEvent.blur(nextInput);

    await waitFor(async () => expect(await repository.getRows()).toHaveLength(2));
    expect(createRow).toHaveBeenCalledTimes(2);
    expect((await repository.getRows()).map((row) => row.data.name)).toEqual([
      'Same Name',
      'Same Name',
    ]);
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
