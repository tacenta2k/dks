import { describe, expect, it, vi } from 'vitest';

import { ElectronSheetRepository } from '../src/features/sheet/electron-repository';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { DksLocalApi, DksLocalImportRecord, DksWindowApi } from '../src/lib/types';

function createLocalApi(): DksLocalApi {
  const row = {
    id: 'row-1',
    data: { name: 'Ada' },
    category: 'Employee',
    deleted: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    getSnapshot: vi.fn(async () => ({
      rows: [row],
      deletedRows: [],
      columns: [{ id: 'name', name: 'Name', type: 'text', position: 0 }],
      syncStatus: { status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0 },
    })),
    createRow: vi.fn(async (input) => ({ ...row, id: 'row-created', data: input.data })),
    updateRow: vi.fn(async (input) => ({ ...row, data: { ...row.data, ...input.data } })),
    duplicateRow: vi.fn(async () => ({ ...row, id: 'row-copy' })),
    softDeleteRow: vi.fn(async () => ({ ...row, deleted: true })),
    restoreRow: vi.fn(async () => ({ ...row, deleted: false })),
    permanentDeleteRow: vi.fn(async () => row),
    addColumn: vi.fn(async (input) => ({ id: input.id ?? 'email', name: input.name, type: input.type })),
    updateColumn: vi.fn(async (input) => ({ id: input.id, name: String(input.patch.name ?? 'Name'), type: 'text' })),
    deleteColumn: vi.fn(async () => ({ id: 'name', name: 'Name', type: 'text', deleted: true })),
    importRecords: vi.fn(async ({ records }: { records: readonly DksLocalImportRecord[] }) => records.map((record, index) => ({ ...row, id: `import-${index}`, data: record.data }))),
    listAudit: vi.fn(async () => []),
    listNotifications: vi.fn(async () => []),
    setSyncStatus: vi.fn(async (status) => ({ status: typeof status === 'string' ? status : status.status, lastSyncAt: null, lastError: null, pendingCount: 0 } as const)),
    flushSync: vi.fn(async () => ({ status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0 })),
    close: vi.fn(async () => ({ closed: true, flushed: true })),
  };
}

function windowWithLocal(local: DksLocalApi): DksWindowApi {
  return {
    platform: 'linux',
    appVersion: '0.1.0',
    local,
    minimizeToTray: () => undefined,
    quit: () => undefined,
  };
}

describe('ElectronSheetRepository', () => {
  it('uses the serializable local bridge for snapshots and sheet mutations', async () => {
    const local = createLocalApi();
    const repository = new ElectronSheetRepository({ windowApi: windowWithLocal(local), role: 'office' });

    expect(await repository.getRows()).toEqual([expect.objectContaining({ id: 'row-1', data: { name: 'Ada' } })]);
    expect(await repository.getColumns()).toEqual([expect.objectContaining({ id: 'name', name: 'Name' })]);
    await repository.createRow({ name: 'Grace' }, 'Client');
    await repository.updateRow('row-1', { name: 'Ada Lovelace' });
    await repository.duplicateRow('row-1');
    await repository.softDeleteRow('row-1');
    await repository.restoreRow?.('row-1');
    await repository.permanentDeleteRow?.('row-1');
    await repository.addColumn({ name: 'Email', type: 'email' });
    await repository.updateColumn('name', { name: 'Full name' });
    await repository.softDeleteColumn('name', 'office');
    await repository.importRows?.([{ data: { name: 'Imported' } }], { fileName: 'rows.csv' });

    expect(local.createRow).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Grace' }, category: 'Client' }));
    expect(local.updateRow).toHaveBeenCalledWith(expect.objectContaining({ id: 'row-1', data: { name: 'Ada Lovelace' } }));
    expect(local.deleteColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'name', role: 'office' }));
    expect(local.importRecords).toHaveBeenCalledTimes(1);
  });

  it('falls back only when the bridge is unavailable and propagates bridge failures', async () => {
    const fallback = createInMemorySheetRepository({ rows: [{ id: 'fallback', data: { name: 'Fallback' } }] });
    const unavailable = new ElectronSheetRepository({ windowApi: { platform: 'test', appVersion: '0' }, fallback });
    expect((await unavailable.getRows()).map((row) => row.id)).toEqual(['fallback']);

    const local = createLocalApi();
    local.getSnapshot = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const available = new ElectronSheetRepository({ windowApi: windowWithLocal(local), fallback });
    await expect(available.getRows()).rejects.toThrow('database unavailable');
    expect(await fallback.getRows()).toHaveLength(1);
  });
});
