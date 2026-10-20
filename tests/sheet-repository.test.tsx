import { describe, expect, it } from 'vitest';

import {
  createInMemorySheetRepository,
  type SheetRepository,
} from '../src/features/sheet/repository';
import { getPrimaryExpiryColumn } from '../src/lib/columns';

describe('sheet repository', () => {
  it('starts empty and loads a Visa template with one primary expiry column', async () => {
    const repository: SheetRepository = createInMemorySheetRepository();

    expect(await repository.getColumns()).toEqual([]);
    expect(await repository.getRows()).toEqual([]);

    await repository.loadTemplate('visa');
    const columns = await repository.getColumns();
    const primaryExpiry = getPrimaryExpiryColumn(columns);

    expect(columns.map((column) => column.name)).toEqual([
      'Name',
      'Category',
      'Passport No',
      'Visa Type',
      'Country',
      'Visa Expiry',
      'Phone',
      'Notes',
    ]);
    expect(columns.find((column) => column.name === 'Category')?.options).toEqual([
      'Employee',
      'Family',
      'Client',
    ]);
    expect(columns.find((column) => column.name === 'Visa Type')?.options).toEqual([
      'Visit',
      'Work',
      'Family',
      'Resident',
    ]);
    expect(columns.find((column) => column.name === 'Passport No')?.isPassport).toBe(true);
    expect(primaryExpiry?.type).toBe('date_expiry');
    expect(primaryExpiry?.name).toBe('Visa Expiry');
    expect(primaryExpiry?.isPrimaryExpiry).toBe(true);
  });

  it('supports local row CRUD, duplication, and soft delete', async () => {
    const repository = createInMemorySheetRepository();
    await repository.loadTemplate('visa');

    const created = await repository.createRow({
      category: 'Employee',
      passport_no: 'A1234567',
      visa_expiry: '2099-01-01',
    });
    const duplicate = await repository.duplicateRow(created.id);

    expect(duplicate.id).not.toBe(created.id);
    expect(duplicate.data).toEqual(created.data);

    await repository.updateRow(created.id, { category: 'Work' });
    expect((await repository.getRows()).find((row) => row.id === created.id)?.data.category).toBe('Work');

    await repository.softDeleteRow(created.id);
    expect((await repository.getRows()).find((row) => row.id === created.id)?.deleted).toBe(true);
  });

  it('records a renewal with a future expiry and preserves the previous value', async () => {
    const repository = createInMemorySheetRepository();
    await repository.loadTemplate('visa');
    const row = await repository.createRow({ visa_expiry: '2026-01-01' });

    const result = await repository.markRenewed(row.id, 'visa_expiry', '2027-01-01', '2026-01-01');

    expect(result.data.visa_expiry).toBe('2027-01-01');
    expect((await repository.getRenewalHistory(row.id))).toEqual([
      expect.objectContaining({
        previousExpiry: '2026-01-01',
        nextExpiry: '2027-01-01',
      }),
    ]);
  });

  it('rejects a renewal date that is not in the future', async () => {
    const repository = createInMemorySheetRepository();
    await repository.loadTemplate('visa');
    const row = await repository.createRow({ visa_expiry: '2099-01-01' });

    await expect(repository.markRenewed(row.id, 'visa_expiry', '2000-01-01')).rejects.toThrow(/future/i);
  });
});
