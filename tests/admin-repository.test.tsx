import { describe, expect, it } from 'vitest';

import { createInMemorySheetRepository, type SheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

describe('admin repository extensions', () => {
  it('keeps the existing SheetRepository contract assignable for legacy adapters', () => {
    const legacy: SheetRepository = {
      getColumns: async () => [],
      getRows: async () => [],
      addColumn: async (input) => ({ ...input, id: input.id ?? 'column', position: 0 }),
      updateColumn: async (id, patch) => ({ id, name: 'Column', type: 'text', position: 0, ...patch }),
      softDeleteColumn: async () => null,
      createRow: async (data = {}) => ({ id: 'row', data }),
      updateRow: async (id, data) => ({ id, data }),
      duplicateRow: async (id) => ({ id: `${id}-copy`, data: {} }),
      softDeleteRow: async (id) => ({ id, data: {}, deleted: true }),
      markRenewed: async (id) => ({ id, data: {} }),
      getRenewalHistory: async () => [],
    };

    expect(legacy).toBeDefined();
  });

  it('restores and permanently deletes rows while retaining an audit history', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    const row = await repository.createRow({ name: 'Ada' });

    await repository.softDeleteRow(row.id);
    expect((await repository.restoreRow(row.id)).deleted).toBe(false);
    await repository.softDeleteRow(row.id);
    expect(await repository.permanentDeleteRow(row.id)).toEqual(expect.objectContaining({ id: row.id }));
    expect((await repository.getRows()).some((candidate) => candidate.id === row.id)).toBe(false);

    const history = await repository.getAuditHistory();
    expect(history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['create', 'soft_delete', 'restore', 'permanent_delete']),
    );
  });

  it('creates all imported records through one repository helper and audits the import', async () => {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);

    const created = await repository.importRows([
      { data: { name: 'Grace Hopper' } },
      { data: { name: 'Katherine Johnson' }, category: 'Employee' },
    ], { actorId: 'admin-1', actor: 'Admin User', fileName: 'people.csv' });

    expect(created).toHaveLength(2);
    expect((await repository.getRows()).map((row) => row.data.name)).toEqual([
      'Grace Hopper',
      'Katherine Johnson',
    ]);
    expect(await repository.getAuditHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'import',
        details: expect.objectContaining({ fileName: 'people.csv', importedRows: 2 }),
      }),
    ]));
  });
});
