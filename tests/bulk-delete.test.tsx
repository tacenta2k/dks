import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { createLocalIpcHandlers, LOCAL_IPC_CHANNELS } from '../electron/main/local-ipc';
import { createSqliteStore, MAX_BULK_SOFT_DELETE_ROWS } from '../electron/main/sqlite';
import { ElectronSheetRepository } from '../src/features/sheet/electron-repository';
import { SheetPage } from '../src/features/sheet/SheetPage';
import {
  isSelectableSheetRowData,
  sheetRowSelectionOptions,
} from '../src/features/sheet/grid-behaviour';
import {
  createInMemorySheetRepository,
  MAX_BULK_SOFT_DELETE_ROWS as REPOSITORY_MAX_BULK_ROWS,
} from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';

/**
 * Bug 4 regression — batch (multi-row) soft delete on the Visa Sheet.
 *
 * Covered end to end with synthetic rows only: AG Grid selection contract,
 * the sheet UI (checkboxes, count, confirm, recycle-bin restore, select-all
 * vs filters), the renderer repository, the validated IPC channel (role
 * check + batch cap), and the single SQLite transaction in the main
 * process (3 soft-deleted rows = 3 outbox items = 3 audit entries;
 * a forced mid-batch failure deletes NOTHING).
 */
describe('bulk delete — AG Grid selection contract', () => {
  it('is multi-row checkbox selection whose select-all covers filtered rows only', () => {
    const options = sheetRowSelectionOptions(true);
    expect(options).toMatchObject({
      mode: 'multiRow',
      selectAll: 'filtered',
      headerCheckbox: true,
      enableClickSelection: false,
    });
    expect(sheetRowSelectionOptions(false)).toBeUndefined();

    // Only real records can be selected — never synthetic rows.
    expect(isSelectableSheetRowData({ __sheetRow: { id: 'r1', data: {} } })).toBe(true);
    expect(isSelectableSheetRowData({})).toBe(false); // draft row
    expect(isSelectableSheetRowData(null)).toBe(false); // group header / empty
    expect(isSelectableSheetRowData(undefined)).toBe(false);
    const isRowSelectable = (options as { isRowSelectable?: (node: never) => boolean })
      ?.isRowSelectable;
    expect(isRowSelectable?.({ data: { __sheetRow: { id: 'r1' } } } as never)).toBe(true);
    expect(isRowSelectable?.({ data: {} } as never)).toBe(false);
  });

  it('keeps one batch cap across the store and repository layers', () => {
    expect(MAX_BULK_SOFT_DELETE_ROWS).toBe(1_000);
    expect(REPOSITORY_MAX_BULK_ROWS).toBe(MAX_BULK_SOFT_DELETE_ROWS);
  });
});

describe('bulk delete — SQLite store transaction', () => {
  const NOW = '2026-03-08T12:00:00.000Z';

  it('soft-deletes 3 rows with 3 outbox entries, 3 audit entries, all restorable', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => NOW });
    try {
      for (const id of ['bulk-keep', 'bulk-a', 'bulk-b', 'bulk-c']) {
        store.createEntry({ id, data: { name: `Person ${id}` } });
      }
      const outboxBefore = store.listOutbox('all').length;

      const deleted = store.softDeleteEntries(['bulk-a', 'bulk-b', 'bulk-c'], undefined, 'Office');
      expect(deleted.map((row) => row.id)).toEqual(['bulk-a', 'bulk-b', 'bulk-c']);
      expect(deleted.every((row) => row.deleted === true)).toBe(true);

      // Active view keeps only the untouched row; the batch is in the
      // Recycle Bin (soft-deleted), not gone.
      expect(store.listEntries(false).map((row) => row.id)).toEqual(['bulk-keep']);
      const inBin = store.listEntries(true).filter((row) => row.deleted);
      expect(inBin.map((row) => row.id).sort()).toEqual(['bulk-a', 'bulk-b', 'bulk-c']);

      // Exactly one outbox 'delete' per row (unique keys), like single delete.
      const deleteOutbox = store.listOutbox('all')
        .filter((item) => item.operation === 'delete');
      expect(deleteOutbox).toHaveLength(3);
      expect(deleteOutbox.map((item) => item.entityId).sort())
        .toEqual(['bulk-a', 'bulk-b', 'bulk-c']);
      expect(new Set(deleteOutbox.map((item) => item.idempotencyKey)).size).toBe(3);
      expect(store.listOutbox('all')).toHaveLength(outboxBefore + 3);

      // Exactly one soft_delete audit entry per row, attributed like single.
      const audit = store.listAudit().filter((entry) => entry.action === 'soft_delete');
      expect(audit).toHaveLength(3);
      expect(audit.map((entry) => entry.entityId).sort())
        .toEqual(['bulk-a', 'bulk-b', 'bulk-c']);
      expect(audit.every((entry) => entry.actor === 'Office')).toBe(true);

      // Each row is individually restorable, as single deletes are today.
      store.restoreEntry('bulk-b', undefined, 'Admin');
      expect(store.listEntries(false).map((row) => row.id).sort())
        .toEqual(['bulk-b', 'bulk-keep']);
    } finally {
      store.close();
    }
  });

  it('deletes nothing when a failure is forced mid-batch', () => {
    let generated = 0;
    const store = createSqliteStore({
      filename: ':memory:',
      now: () => NOW,
      // The per-row outbox key is the only idFactory call inside the batch
      // (creates below carry explicit ids + keys), so the SECOND row blows
      // up after the first row was already updated inside the transaction.
      idFactory: () => {
        generated += 1;
        if (generated === 2) {
          throw new Error('forced mid-batch failure');
        }
        return `generated-${generated}`;
      },
    });
    try {
      for (const id of ['rb-a', 'rb-b', 'rb-c']) {
        store.createEntry({
          id,
          data: { name: `Person ${id}` },
          idempotencyKey: `entry:create:${id}`,
        });
      }
      expect(generated).toBe(0);

      expect(() => store.softDeleteEntries(['rb-a', 'rb-b', 'rb-c']))
        .toThrow('forced mid-batch failure');

      // All-or-nothing: no row deleted, no delete outbox, no audit residue.
      expect(store.listEntries(false).map((row) => row.id).sort())
        .toEqual(['rb-a', 'rb-b', 'rb-c']);
      expect(store.listEntries(true).every((row) => row.deleted === false)).toBe(true);
      expect(store.listOutbox('all').filter((item) => item.operation === 'delete'))
        .toHaveLength(0);
      expect(store.listOutbox('all')).toHaveLength(3); // the creates only
      expect(store.listAudit().filter((entry) => entry.action === 'soft_delete'))
        .toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('rejects unknown, duplicate, empty and over-cap batches without touching rows', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => NOW });
    try {
      store.createEntry({ id: 'cap-1', data: { name: 'One' } });
      expect(() => store.softDeleteEntries([])).toThrow(/must not be empty/);
      expect(() => store.softDeleteEntries(['cap-1', 'cap-1'])).toThrow(/duplicates/);
      expect(() => store.softDeleteEntries(['cap-1', 'missing-row']))
        .toThrow('Unknown sheet row: missing-row');
      expect(() => store.softDeleteEntries(
        Array.from({ length: MAX_BULK_SOFT_DELETE_ROWS + 1 }, (_, i) => `row-${i}`),
      )).toThrow(/at most 1000/);
      // The valid row named in those rejected batches is untouched.
      expect(store.getEntry('cap-1')?.deleted).toBe(false);
      expect(store.listOutbox('all').filter((item) => item.operation === 'delete'))
        .toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe('bulk delete — IPC validation and role check', () => {
  const NOW = '2026-03-08T12:00:00.000Z';

  function seededHandlers() {
    const store = createSqliteStore({ filename: ':memory:', now: () => NOW });
    for (const id of ['ipc-a', 'ipc-b', 'ipc-c']) {
      store.createEntry({ id, data: { name: `Person ${id}` } });
    }
    return { store, handlers: createLocalIpcHandlers({ store }) };
  }

  it('Office (same rights as single delete) and Admin can bulk-delete via IPC', async () => {
    const { store, handlers } = seededHandlers();
    try {
      const deleted = await handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: ['ipc-a', 'ipc-b'],
        role: 'office',
      }) as { id: string; deleted: boolean }[];
      expect(deleted.map((row) => row.id)).toEqual(['ipc-a', 'ipc-b']);
      expect(store.listEntries(false).map((row) => row.id)).toEqual(['ipc-c']);

      const adminDeleted = await handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: ['ipc-c'],
        role: 'admin',
      }) as { id: string }[];
      expect(adminDeleted.map((row) => row.id)).toEqual(['ipc-c']);
      expect(store.listEntries(false)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('rejects a role without delete rights (and a missing role) at IPC, touching nothing', async () => {
    const { store, handlers } = seededHandlers();
    try {
      expect(() => handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: ['ipc-a'],
        role: 'viewer',
      })).toThrow(/role must be admin or office/);
      expect(() => handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: ['ipc-a'],
      })).toThrow(/role is required/);
      expect(() => handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: [],
        role: 'office',
      })).toThrow(/must not be empty/);
      expect(() => handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: ['ipc-a', 'ipc-a'],
        role: 'office',
      })).toThrow(/duplicates/);
      expect(() => handlers[LOCAL_IPC_CHANNELS.softDeleteRows]({
        ids: Array.from({ length: 1_001 }, (_, i) => `row-${i}`),
        role: 'admin',
      })).toThrow(/at most 1000/);

      expect(store.listEntries(false)).toHaveLength(3);
      expect(store.listOutbox('all').filter((item) => item.operation === 'delete'))
        .toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe('bulk delete — renderer repository', () => {
  it('soft-deletes the batch atomically with one audit entry per row', async () => {
    const repository = createInMemorySheetRepository();
    const keep = await repository.createRow({ name: 'Keep' });
    const a = await repository.createRow({ name: 'A' });
    const b = await repository.createRow({ name: 'B' });
    const c = await repository.createRow({ name: 'C' });

    const deleted = await repository.softDeleteRows?.([a.id, b.id, c.id]);
    expect(deleted?.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
    const rows = await repository.getRows();
    expect(rows.filter((row) => row.deleted !== true).map((row) => row.id)).toEqual([keep.id]);
    expect(rows.filter((row) => row.deleted === true)).toHaveLength(3);
    const audit = await repository.getAuditHistory?.();
    expect(audit?.filter((entry) => entry.action === 'soft_delete')).toHaveLength(3);

    // Individually restorable from the Recycle Bin, like single deletes.
    await repository.restoreRow?.(b.id);
    expect((await repository.getRows())
      .filter((row) => row.deleted !== true)
      .map((row) => row.id)
      .sort()).toEqual([keep.id, b.id].sort());
  });

  it('rejects the whole batch (deleting nothing) when one id is unknown', async () => {
    const repository = createInMemorySheetRepository();
    const a = await repository.createRow({ name: 'A' });
    await expect(repository.softDeleteRows?.([a.id, 'missing-row']))
      .rejects.toThrow('Unknown sheet row: missing-row');
    expect((await repository.getRows())[0].deleted).toBe(false);
  });

  it('Electron repository forwards one bulk call with the role to the bridge', async () => {
    const deletedRow = (id: string) => ({
      id,
      data: {},
      deleted: true,
      version: 2,
      created_at: '2026-03-08T00:00:00.000Z',
      updated_at: '2026-03-08T00:00:00.000Z',
      updated_by: null,
    });
    const softDeleteRows = vi.fn(
      async (input: { ids: string[] }) => input.ids.map(deletedRow),
    );
    const repository = new ElectronSheetRepository({
      windowApi: { local: { softDeleteRows } } as never,
      role: 'office',
    });

    const deleted = await repository.softDeleteRows?.(['e-1', 'e-2']);
    expect(deleted?.map((row) => row.id)).toEqual(['e-1', 'e-2']);
    expect(softDeleteRows).toHaveBeenCalledTimes(1);
    expect(softDeleteRows.mock.calls[0][0]).toMatchObject({
      ids: ['e-1', 'e-2'],
      role: 'office',
    });
  });

  it('Electron repository falls back to validated single deletes on an older bridge', async () => {
    const row = (id: string, deleted = false) => ({
      id,
      data: {},
      deleted,
      version: 1,
      created_at: '2026-03-08T00:00:00.000Z',
      updated_at: '2026-03-08T00:00:00.000Z',
      updated_by: null,
    });
    const softDeleteRow = vi.fn(async (input: { id: string }) => row(input.id, true));
    const repository = new ElectronSheetRepository({
      windowApi: {
        local: {
          // No bulk channel on this (older) bridge.
          softDeleteRow,
          getSnapshot: async () => ({ rows: [row('old-1'), row('old-2')], columns: [] }),
        },
      } as never,
      role: 'admin',
    });

    const deleted = await repository.softDeleteRows?.(['old-1', 'old-2']);
    expect(deleted?.map((candidate) => candidate.id)).toEqual(['old-1', 'old-2']);
    expect(softDeleteRow).toHaveBeenCalledTimes(2);
    // An unknown id is rejected up front — no single delete is attempted.
    await expect(repository.softDeleteRows?.(['old-1', 'missing-row']))
      .rejects.toThrow('Unknown sheet row: missing-row');
    expect(softDeleteRow).toHaveBeenCalledTimes(2);
  });
});

describe('bulk delete — Visa Sheet UI', () => {
  async function seededSheet(role: string) {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({ name: 'Alpha Person', passport_no: 'A1000001' });
    await repository.createRow({ name: 'Bravo Person', passport_no: 'B2000002' });
    await repository.createRow({ name: 'Charlie Person', passport_no: 'C3000003' });
    render(<SheetPage repository={repository} role={role} />);
    await screen.findByLabelText('New record Name');
    return repository;
  }

  it('deletes the checked rows after a count confirmation and clears the selection', async () => {
    const repository = await seededSheet('office');

    // Nothing to delete until something is checked.
    expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select row A1000001'));
    fireEvent.click(screen.getByLabelText('Select row C3000003'));
    const deleteSelected = await screen.findByRole('button', { name: 'Delete selected (2)' });

    fireEvent.click(deleteSelected);
    const dialog = await screen.findByRole('dialog', { name: 'Move 2 rows to the Recycle Bin?' });
    expect(within(dialog).getByText(/restored individually/i)).toBeInTheDocument();

    // Cancel deletes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await repository.getRows()).filter((row) => row.deleted === true)).toHaveLength(0);

    // Confirm: both rows land in the Recycle Bin, selection clears.
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Move 2 rows to the Recycle Bin?' });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Move to Recycle Bin' }));

    await waitFor(async () => {
      expect((await repository.getRows()).filter((row) => row.deleted === true)).toHaveLength(2);
    });
    expect(await screen.findByText(/Moved 2 rows to the recycle bin\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha Person')).not.toBeInTheDocument();
    expect(screen.getAllByText('Bravo Person').length).toBeGreaterThan(0);
    // The two rows are in the bin (soft-deleted), restorable afterwards.
    expect((await repository.getRows())
      .filter((row) => row.deleted === true)
      .map((row) => row.data.name)
      .sort()).toEqual(['Alpha Person', 'Charlie Person']);

    // Single-row delete still works afterwards.
    fireEvent.click(screen.getByRole('button', { name: 'Delete row B2000002' }));
    const singleDialog = await screen.findByRole('dialog', { name: 'Move this record to the Recycle Bin?' });
    fireEvent.click(within(singleDialog).getByRole('button', { name: 'Move to Recycle Bin' }));
    await waitFor(async () => {
      expect((await repository.getRows()).filter((row) => row.deleted === true)).toHaveLength(3);
    });
  }, 20_000);

  it('select-all selects only the rows visible under the current filter', async () => {
    const repository = await seededSheet('office');

    fireEvent.change(screen.getByLabelText('Search records'), {
      target: { value: 'Bravo' },
    });
    await waitFor(() => expect(screen.queryByText('Alpha Person')).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select all visible rows'));
    // Only the filtered-in row is counted — hidden rows are never selected.
    expect(await screen.findByRole('button', { name: 'Delete selected (1)' }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move 1 row to the Recycle Bin?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Recycle Bin' }));

    await waitFor(async () => {
      const deleted = (await repository.getRows()).filter((row) => row.deleted === true);
      expect(deleted.map((row) => row.data.name)).toEqual(['Bravo Person']);
    });

    // Clearing the filter shows the other two records untouched.
    fireEvent.change(screen.getByLabelText('Search records'), { target: { value: '' } });
    expect((await screen.findAllByText('Alpha Person')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Charlie Person').length).toBeGreaterThan(0);
  }, 20_000);

  it('keeps every row and shows an error when the batch fails', async () => {
    const repository = await seededSheet('office');
    repository.softDeleteRows = async () => {
      throw new Error('local store unavailable for test');
    };

    fireEvent.click(screen.getByLabelText('Select all visible rows'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete selected (3)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move 3 rows to the Recycle Bin?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Recycle Bin' }));

    expect((await screen.findAllByRole('alert')).some(
      (node) => node.textContent?.includes('local store unavailable for test'),
    )).toBe(true);
    expect((await repository.getRows()).filter((row) => row.deleted === true)).toHaveLength(0);
    expect(screen.getAllByText('Alpha Person').length).toBeGreaterThan(0);
  }, 20_000);

  it('offers no bulk selection to a role without soft-delete rights', async () => {
    await seededSheet('viewer');
    expect(screen.queryByLabelText('Select all visible rows')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Select row/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument();
  }, 20_000);
});
