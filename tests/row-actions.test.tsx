import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { SheetPage } from '../src/features/sheet/SheetPage';
import { buildGridColumns } from '../src/features/sheet/grid-columns';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { ColumnDefinition } from '../src/lib/columns';

async function seededRepository() {
  const repository = createInMemorySheetRepository();
  await repository.loadTemplate('visa');
  await repository.createRow({
    category: 'Employee',
    passport_no: 'A1234567',
    visa_expiry: '2026-12-31',
  });
  return repository;
}

describe('sheet row actions', () => {
  it('locks the primary expiry editor for office users but not administrators', () => {
    const columns: ColumnDefinition[] = [
      { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true },
    ];
    const callbacks = {
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onRenew: vi.fn(),
    };

    const officeExpiry = buildGridColumns(columns, callbacks, 'office').find((column) => column.colId === 'visa_expiry');
    const adminExpiry = buildGridColumns(columns, callbacks, 'admin').find((column) => column.colId === 'visa_expiry');

    expect(officeExpiry?.editable).toBe(false);
    expect(adminExpiry?.editable).toBe(true);
  });

  it('duplicates and soft-deletes a row locally', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const repository = await seededRepository();
    render(<SheetPage repository={repository} role="admin" today="2026-01-01" />);

    await screen.findByText('A1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate row A1234567' }));
    expect((await repository.getRows()).filter((row) => row.deleted !== true)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Delete row A1234567' }));
    await waitFor(async () => {
      expect((await repository.getRows()).filter((row) => row.deleted !== true)).toHaveLength(1);
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/move .*recycle bin/i));
  }, 10_000);

  it('requires a future expiry before marking a row renewed', async () => {
    const repository = await seededRepository();
    render(<SheetPage repository={repository} role="office" today="2026-01-01" />);

    await screen.findByText('A1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Mark renewed for A1234567' }));
    expect(screen.getByRole('dialog', { name: 'Mark row renewed' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New expiry date'), { target: { value: '2025-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save renewal' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/future expiry/i);

    fireEvent.change(screen.getByLabelText('New expiry date'), { target: { value: '2027-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save renewal' }));
    await waitFor(async () => {
      expect((await repository.getRows()).find((row) => row.deleted !== true)?.data.visa_expiry).toBe('2027-01-01');
    });
  }, 10_000);
});
