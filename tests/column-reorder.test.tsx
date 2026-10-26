/**
 * Column drag-reorder persistence.
 *
 * Bug: dragging e.g. the Civil ID header next to Passport moved it visually,
 * then it snapped back — AG Grid kept only transient UI order while
 * SheetPage rebuilt `columnDefs` from the persisted `position` values on the
 * next refresh. The fix persists a finished user drag as normalized
 * `app_columns.position` values (SQLite first → durable outbox → Supabase),
 * so the order survives rerenders, quiet background refreshes, restarts and
 * sync, for every ordinary user column type. System columns (# / Actions /
 * + / Days Left) stay locked and are never persisted.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_IPC_CHANNELS,
  createLocalIpcHandlers,
  createLocalSessionClearance,
  registerLocalIpcHandlers,
  type LocalIpcStore,
} from '../electron/main/local-ipc';
import { createSqliteStore } from '../electron/main/sqlite';
import {
  COLUMN_TYPES,
  applyColumnOrder,
  extractUserColumnOrder,
  getPrimaryExpiryColumn,
  normalizeColumns,
  orderedActiveColumns,
  sortColumnsByPosition,
  type ColumnDefinition,
} from '../src/lib/columns';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { ElectronSheetRepository } from '../src/features/sheet/electron-repository';
import {
  columnOrderFromMovedEvent,
  displayedColumnIds,
} from '../src/features/sheet/grid-behaviour';
import { buildGridColumns } from '../src/features/sheet/grid-columns';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseOutboxItem,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalApi, DksLocalColumn, DksLocalRow, DksLocalSnapshot, DksWindowApi } from '../src/lib/types';

const gridCapture = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

// jsdom has no AG Grid layout/drag geometry, so the SheetPage wiring test
// captures the REAL props SheetPage hands AgGridReact and drives its
// onColumnMoved with the same event shape AG Grid emits for a finished
// header drag. The accessible table (the deterministic test surface) stays
// real and must show the same order as the captured columnDefs.
vi.mock('ag-grid-react', () => ({
  AgGridReact: (props: Record<string, unknown>) => {
    gridCapture.props = props;
    return <div data-testid="mock-ag-grid" />;
  },
}));

function column(overrides: Partial<ColumnDefinition>): ColumnDefinition {
  return {
    id: overrides.id ?? overrides.name ?? 'column',
    name: overrides.name ?? 'Column',
    type: overrides.type ?? 'text',
    ...overrides,
  };
}

function fakeDisplayedColumn(id: string): { getColId: () => string } {
  return { getColId: () => id };
}

function fakeGridApi(left: string[], center: string[], right: string[]) {
  return {
    getDisplayedLeftColumns: () => left.map(fakeDisplayedColumn),
    getDisplayedCenterColumns: () => center.map(fakeDisplayedColumn),
    getDisplayedRightColumns: () => right.map(fakeDisplayedColumn),
  };
}

const SHEET_COLUMNS: ColumnDefinition[] = [
  column({ id: 'name', name: 'Name', type: 'text', position: 0 }),
  column({ id: 'passport_no', name: 'Passport No', type: 'text', position: 1, isPassport: true, is_passport: true }),
  column({ id: 'country', name: 'Country', type: 'text', position: 2 }),
  column({ id: 'civil_id', name: 'Civil ID', type: 'civil_id', position: 3 }),
  column({ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', position: 4, isPrimaryExpiry: true, is_primary_expiry: true }),
];

describe('column order helpers (pure)', () => {
  it('sorts by persisted position, stably for ties and missing positions', () => {
    const shuffled = [
      column({ id: 'c', position: 2 }),
      column({ id: 'a', position: 0 }),
      column({ id: 'b', position: 2 }),
      column({ id: 'd' }),
    ];
    expect(sortColumnsByPosition(shuffled).map((item) => item.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(sortColumnsByPosition(SHEET_COLUMNS).map((item) => item.id))
      .toEqual(['name', 'passport_no', 'country', 'civil_id', 'visa_expiry']);
  });

  it('moves Civil ID next to Passport with deterministic normalized positions', () => {
    const reordered = applyColumnOrder(SHEET_COLUMNS, ['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(reordered.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(reordered.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);
    // Deterministic: applying the same order again changes nothing.
    expect(applyColumnOrder(reordered, ['name', 'passport_no', 'civil_id', 'country', 'visa_expiry'])).toEqual(reordered);
  });

  it('reorders every ordinary user column type without touching its metadata', () => {
    const onePerType: ColumnDefinition[] = COLUMN_TYPES.map((type, index) => column({
      id: `col_${type}`,
      name: `Column ${type}`,
      type,
      position: index * 10,
      ...(type === 'dropdown' ? { options: ['Alpha', 'Beta'] } : {}),
      ...(type === 'text' ? { isPassport: true, is_passport: true } : {}),
      ...(type === 'date_expiry' ? { isPrimaryExpiry: true, is_primary_expiry: true } : {}),
    }));
    const reversedIds = onePerType.map((item) => item.id).reverse();
    const beforeById = new Map(onePerType.map((item) => [item.id, item]));

    const reordered = applyColumnOrder(onePerType, reversedIds);
    expect(reordered.map((item) => item.id)).toEqual(reversedIds);
    expect(reordered.map((item) => item.position)).toEqual(onePerType.map((_, index) => index));
    for (const item of reordered) {
      // Everything except position is byte-identical for each column.
      expect(item).toEqual({ ...beforeById.get(item.id), position: item.position });
    }
    // The primary expiry designation follows the COLUMN, not the slot.
    expect(getPrimaryExpiryColumn(normalizeColumns(reordered))?.id).toBe('col_date_expiry');
  });

  it('keeps unlisted active columns in relative order and never persists system columns', () => {
    const withHiddenAndDeleted: ColumnDefinition[] = [
      ...SHEET_COLUMNS,
      column({ id: 'secret', name: 'Secret', type: 'notes', position: 5, visible: false }),
      column({ id: 'gone', name: 'Gone', type: 'text', position: 6, deleted: true, visible: false }),
    ];
    const reordered = applyColumnOrder(withHiddenAndDeleted, [
      '__rowNumber', '__actions', 'civil_id', 'name', 'passport_no', 'country', 'visa_expiry', '__addColumn', 'daysLeft', 'not-a-column',
    ]);
    expect(reordered.map((item) => item.id))
      .toEqual(['civil_id', 'name', 'passport_no', 'country', 'visa_expiry', 'secret', 'gone']);
    expect(reordered.slice(0, 6).map((item) => item.position)).toEqual([0, 1, 2, 3, 4, 5]);
    // Deleted columns are untouched, including their stale position.
    expect(reordered.find((item) => item.id === 'gone')).toMatchObject({ deleted: true, position: 6 });
    expect(reordered.map((item) => item.id)).not.toContain('daysLeft');
  });

  it('extracts a persistable order only for a genuinely new permutation', () => {
    const displayed = ['__rowNumber', '__actions', 'name', 'passport_no', 'civil_id', 'country', 'visa_expiry', '__addColumn', 'daysLeft'];
    expect(extractUserColumnOrder(displayed, SHEET_COLUMNS))
      .toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    // Unchanged order (e.g. defs rebuilt from a refresh) → nothing to save.
    expect(extractUserColumnOrder(
      ['__rowNumber', '__actions', 'name', 'passport_no', 'country', 'civil_id', 'visa_expiry', '__addColumn', 'daysLeft'],
      SHEET_COLUMNS,
    )).toBeNull();
    // Missing/duplicated user columns are not a valid permutation.
    expect(extractUserColumnOrder(['__actions', 'name', 'passport_no'], SHEET_COLUMNS)).toBeNull();
    expect(extractUserColumnOrder(
      ['name', 'name', 'passport_no', 'country', 'civil_id', 'visa_expiry'],
      SHEET_COLUMNS,
    )).toBeNull();
  });

  it('accepts only finished user drags from a grid move event', () => {
    const api = fakeGridApi(
      ['__rowNumber', '__actions', 'name'],
      ['passport_no', 'civil_id', 'country', 'visa_expiry'],
      ['__addColumn', 'daysLeft'],
    );
    expect(displayedColumnIds(api)).toEqual([
      '__rowNumber', '__actions', 'name', 'passport_no', 'civil_id', 'country', 'visa_expiry', '__addColumn', 'daysLeft',
    ]);
    const moved = { finished: true, source: 'uiColumnDragged', api } as never;
    expect(columnOrderFromMovedEvent(moved, orderedActiveColumns(SHEET_COLUMNS)))
      .toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    // Intermediate drag steps and programmatic/refresh moves never persist.
    expect(columnOrderFromMovedEvent({ finished: false, source: 'uiColumnDragged', api } as never, SHEET_COLUMNS)).toBeNull();
    expect(columnOrderFromMovedEvent({ finished: true, source: 'api', api } as never, SHEET_COLUMNS)).toBeNull();
    expect(columnOrderFromMovedEvent({ finished: true, source: 'uiColumnMoved', api } as never, SHEET_COLUMNS))
      .toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
  });
});

describe('grid column definitions for reorder', () => {
  const callbacks = { onDuplicate: vi.fn(), onDelete: vi.fn(), onRenew: vi.fn() };

  it('keeps system columns locked at both ends and user columns movable', () => {
    const defs = buildGridColumns(SHEET_COLUMNS, callbacks, 'office');
    expect(defs.map((def) => def.colId)).toEqual([
      '__rowNumber', '__actions', 'name', 'passport_no', 'country', 'civil_id', 'visa_expiry', '__addColumn', 'daysLeft',
    ]);
    for (const systemId of ['__rowNumber', '__actions', '__addColumn', 'daysLeft']) {
      const def = defs.find((candidate) => candidate.colId === systemId);
      expect(def?.suppressMovable, systemId).toBe(true);
      expect(def?.lockPinned, systemId).toBe(true);
      expect(def?.lockPosition, systemId).toBeTruthy();
    }
    expect(defs.find((def) => def.colId === '__rowNumber')?.pinned).toBe('left');
    expect(defs.find((def) => def.colId === '__actions')?.pinned).toBe('left');
    expect(defs.find((def) => def.colId === '__addColumn')?.pinned).toBe('right');
    expect(defs.find((def) => def.colId === 'daysLeft')?.pinned).toBe('right');

    const userDefs = defs.filter((def) => SHEET_COLUMNS.some((item) => item.id === def.colId));
    for (const def of userDefs) {
      expect(def.suppressMovable, def.colId).toBe(false);
      expect(def.lockPinned, def.colId).toBe(false);
      expect(def.lockPosition, def.colId).toBeUndefined();
    }
    // The CURRENT first user column is the frozen one; the rest are
    // explicitly unpinned (null, not undefined) so AG Grid re-syncs a
    // demoted first column when defs are re-applied after a reorder.
    expect(userDefs[0]).toMatchObject({ colId: 'name', pinned: 'left' });
    expect(userDefs.slice(1).every((def) => def.pinned === null)).toBe(true);
  });

  it('freezes whichever user column a reorder makes first', () => {
    const reordered = orderedActiveColumns(
      applyColumnOrder(SHEET_COLUMNS, ['civil_id', 'name', 'passport_no', 'country', 'visa_expiry']),
    );
    const defs = buildGridColumns(reordered, callbacks, 'admin');
    const userDefs = defs.filter((def) => reordered.some((item) => item.id === def.colId));
    expect(userDefs.map((def) => def.colId)).toEqual(['civil_id', 'name', 'passport_no', 'country', 'visa_expiry']);
    expect(userDefs[0]).toMatchObject({ colId: 'civil_id', pinned: 'left' });
    expect(userDefs.slice(1).every((def) => def.pinned === null)).toBe(true);
  });
});

describe('in-memory repository reorder', () => {
  it('persists the new order across reloads without changing rows or metadata', async () => {
    const repository = createInMemorySheetRepository();
    for (const input of SHEET_COLUMNS) {
      await repository.addColumn({ id: input.id, name: input.name, type: input.type, isPassport: input.isPassport });
    }
    const row = await repository.createRow({ passport_no: 'A1234567', civil_id: '123456789012', visa_expiry: '2027-01-01' });
    const rowsBefore = await repository.getRows();

    const result = await repository.reorderColumns?.(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(result?.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(result?.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);

    // A fresh read (page reload / restart) returns the saved order.
    const reloaded = await repository.getColumns();
    expect(reloaded.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(reloaded.find((item) => item.id === 'passport_no')).toMatchObject({ isPassport: true, type: 'text' });
    expect(reloaded.find((item) => item.id === 'civil_id')?.type).toBe('civil_id');
    expect(getPrimaryExpiryColumn(reloaded)?.id).toBe('visa_expiry');
    expect(await repository.getRows()).toEqual(rowsBefore);
    expect((await repository.getRows()).find((item) => item.id === row.id)?.data)
      .toEqual({ passport_no: 'A1234567', civil_id: '123456789012', visa_expiry: '2027-01-01' });
  });

  it('treats position as the order truth and rejects unknown/system columns', async () => {
    const repository = createInMemorySheetRepository({ columns: SHEET_COLUMNS });
    await repository.updateColumn('civil_id', { position: 2 });
    await repository.updateColumn('country', { position: 3 });
    expect((await repository.getColumns()).map((item) => item.id))
      .toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);

    await expect(repository.reorderColumns?.(['name', 'missing'])).rejects.toThrow(/unknown sheet column/i);
    await expect(repository.reorderColumns?.(['daysLeft', 'name'])).rejects.toThrow(/unknown sheet column/i);
    await expect(repository.reorderColumns?.(['name', 'name'])).rejects.toThrow(/duplicate/i);
  });
});

describe('SQLite store reorder (atomic, outbox-backed)', () => {
  const T1 = '2026-01-01T00:00:00.000Z';
  const T2 = '2026-02-01T00:00:00.000Z';

  function seedStore() {
    const store = createSqliteStore({ filename: ':memory:', now: () => T2 });
    store.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0, updatedAt: T1 });
    store.upsertColumn({ id: 'passport_no', name: 'Passport No', type: 'text', position: 1, isPassport: true, updatedAt: T1 });
    store.upsertColumn({ id: 'country', name: 'Country', type: 'dropdown', options: ['Kuwait', 'India'], position: 2, updatedAt: T1 });
    store.upsertColumn({ id: 'civil_id', name: 'Civil ID', type: 'civil_id', position: 3, updatedAt: T1 });
    store.upsertColumn({ id: 'expiry_a', name: 'Expiry A', type: 'date_expiry', position: 4, updatedAt: T1 });
    store.upsertColumn({ id: 'expiry_b', name: 'Expiry B', type: 'date_expiry', position: 5, updatedAt: T1 });
    // Administrator-selected primary is the SECOND expiry column.
    store.upsertColumn({ id: 'expiry_b', name: 'Expiry B', type: 'date_expiry', position: 5, isPrimaryExpiry: true, updatedAt: T1 });
    store.createEntry({
      id: 'row-1',
      data: { passport_no: 'A1234567', civil_id: '123456789012', expiry_b: '2027-01-01' },
      category: 'Employee',
    });
    return store;
  }

  it('persists normalized positions atomically and queues one update per moved column', () => {
    const store = seedStore();
    try {
      expect(store.listColumns().find((item) => item.isPrimaryExpiry)?.id).toBe('expiry_b');
      const outboxBefore = store.listOutbox('all').length;

      const result = store.reorderColumns(['name', 'passport_no', 'civil_id', 'country', 'expiry_a', 'expiry_b'], 'office');

      expect(result.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id', 'country', 'expiry_a', 'expiry_b']);
      expect(result.map((item) => item.position)).toEqual([0, 1, 2, 3, 4, 5]);
      // Reloading from SQLite (restart) keeps the saved order.
      expect(store.listColumns().map((item) => item.id))
        .toEqual(['name', 'passport_no', 'civil_id', 'country', 'expiry_a', 'expiry_b']);

      // Only the two columns whose position changed were written/queued.
      const queued = store.listOutbox('all').slice(outboxBefore);
      expect(queued.map((item) => item.entityId).sort()).toEqual(['civil_id', 'country']);
      expect(queued.every((item) => item.entityType === 'column' && item.operation === 'update' && item.status === 'pending')).toBe(true);
      expect(queued.find((item) => item.entityId === 'civil_id')?.payload).toMatchObject({ position: 2 });
      expect(store.getColumn('civil_id')?.updated_at).toBe(T2);
      expect(store.getColumn('country')?.updated_at).toBe(T2);
      expect(store.getColumn('name')?.updated_at).toBe(T1);
      expect(store.getColumn('passport_no')?.updated_at).toBe(T1);

      // Metadata and entry data are untouched by the move.
      expect(store.getColumn('passport_no')).toMatchObject({ type: 'text', isPassport: true });
      expect(store.getColumn('country')?.options).toEqual(['Kuwait', 'India']);
      expect(store.getColumn('civil_id')?.type).toBe('civil_id');
      expect(store.listColumns().find((item) => item.isPrimaryExpiry)?.id).toBe('expiry_b');
      expect(store.getEntry('row-1')?.data)
        .toEqual({ passport_no: 'A1234567', civil_id: '123456789012', expiry_b: '2027-01-01' });
      expect(store.listAudit().some((entry) => entry.action === 'reorder_columns')).toBe(true);

      // Swapping the two expiry columns must not redesignate the primary.
      store.reorderColumns(['name', 'passport_no', 'civil_id', 'country', 'expiry_b', 'expiry_a'], 'admin');
      expect(store.listColumns().map((item) => item.id).slice(-2)).toEqual(['expiry_b', 'expiry_a']);
      expect(store.listColumns().find((item) => item.isPrimaryExpiry)?.id).toBe('expiry_b');
    } finally {
      store.close();
    }
  });

  it('is a write-free no-op for the current order (no refresh/outbox loop)', () => {
    const store = seedStore();
    try {
      const outboxBefore = store.listOutbox('all').length;
      const result = store.reorderColumns(['name', 'passport_no', 'country', 'civil_id', 'expiry_a', 'expiry_b'], 'admin');
      expect(result.map((item) => item.id)).toEqual(['name', 'passport_no', 'country', 'civil_id', 'expiry_a', 'expiry_b']);
      expect(store.listOutbox('all')).toHaveLength(outboxBefore);
      expect(store.listColumns().every((item) => item.updated_at === T1)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('rejects system, unknown, deleted and duplicate columns and unknown roles', () => {
    const store = seedStore();
    try {
      store.upsertColumn({ id: 'temp', name: 'Temp', type: 'text', position: 6, updatedAt: T1 });
      store.deleteColumn('temp', 'admin');
      expect(() => store.reorderColumns(['name', 'daysLeft'], 'admin')).toThrow(/unknown sheet column/i);
      expect(() => store.reorderColumns(['name', '__actions'], 'admin')).toThrow(/unknown sheet column/i);
      expect(() => store.reorderColumns(['name', 'temp'], 'admin')).toThrow(/unknown sheet column/i);
      expect(() => store.reorderColumns(['name', 'name'], 'admin')).toThrow(/duplicate/i);
      expect(() => store.reorderColumns(['name'], 'viewer')).toThrow(/admin or office/i);
      // Nothing was partially applied by the rejected attempts.
      expect(store.listColumns().map((item) => item.id))
        .toEqual(['name', 'passport_no', 'country', 'civil_id', 'expiry_a', 'expiry_b']);
    } finally {
      store.close();
    }
  });

  it('keeps an unlisted hidden column after the listed ones in relative order', () => {
    const store = createSqliteStore({ filename: ':memory:', now: () => T2 });
    try {
      store.upsertColumn({ id: 'a', name: 'A', type: 'text', position: 0, updatedAt: T1 });
      store.upsertColumn({ id: 'hidden', name: 'Hidden', type: 'notes', position: 1, visible: false, updatedAt: T1 });
      store.upsertColumn({ id: 'b', name: 'B', type: 'text', position: 2, updatedAt: T1 });
      const result = store.reorderColumns(['b', 'a'], 'office');
      expect(result.map((item) => item.id)).toEqual(['b', 'a', 'hidden']);
      expect(result.map((item) => item.position)).toEqual([0, 1, 2]);
      expect(result.find((item) => item.id === 'hidden')?.visible).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('local IPC reorder channel', () => {
  function seededStore() {
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-02-01T00:00:00.000Z' });
    store.upsertColumn({ id: 'name', name: 'Name', type: 'text', position: 0 });
    store.upsertColumn({ id: 'passport_no', name: 'Passport No', type: 'text', position: 1, isPassport: true });
    store.upsertColumn({ id: 'civil_id', name: 'Civil ID', type: 'civil_id', position: 2 });
    return store;
  }

  it('reorders through the validated IPC handler for office and admin', async () => {
    const store = seededStore();
    try {
      const handlers = createLocalIpcHandlers({ store });
      const result = await handlers[LOCAL_IPC_CHANNELS.reorderColumns]({
        columnIds: ['name', 'civil_id', 'passport_no'],
        role: 'office',
      }) as Array<Record<string, unknown>>;
      expect(result.map((item) => item.id)).toEqual(['name', 'civil_id', 'passport_no']);
      expect(store.listColumns().map((item) => item.id)).toEqual(['name', 'civil_id', 'passport_no']);

      // IPC handlers validate synchronously before touching the store.
      expect(() => handlers[LOCAL_IPC_CHANNELS.reorderColumns]({ columnIds: 'name', role: 'admin' }))
        .toThrow(/must be an array/i);
      expect(() => handlers[LOCAL_IPC_CHANNELS.reorderColumns]({ columnIds: [], role: 'admin' }))
        .toThrow(/must not be empty/i);
      expect(() => handlers[LOCAL_IPC_CHANNELS.reorderColumns]({ columnIds: ['name', 'name'], role: 'admin' }))
        .toThrow(/duplicates/i);
      expect(() => handlers[LOCAL_IPC_CHANNELS.reorderColumns]({ columnIds: ['name'], role: 'viewer' }))
        .toThrow(/admin or office/i);
      expect(() => handlers[LOCAL_IPC_CHANNELS.reorderColumns]({ columnIds: ['daysLeft'], role: 'admin' }))
        .toThrow(/unknown sheet column/i);
    } finally {
      store.close();
    }
  });

  it('fails closed when the local store cannot reorder', () => {
    const handlers = createLocalIpcHandlers({ store: {} as unknown as LocalIpcStore });
    expect(() => handlers[LOCAL_IPC_CHANNELS.reorderColumns]({ columnIds: ['name'], role: 'admin' }))
      .toThrow(/unavailable/i);
  });

  it('stays behind the office-pending session-clearance fence', async () => {
    const store = seededStore();
    try {
      const clearance = createLocalSessionClearance('office-pending');
      const registered = new Map<string, (event: unknown, payload: unknown) => unknown>();
      const ipcMain = {
        handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
          registered.set(channel, listener);
        },
        removeHandler: (channel: string) => {
          registered.delete(channel);
        },
      };
      const unregister = registerLocalIpcHandlers({
        ipcMain: ipcMain as never,
        store,
        sessionClearance: clearance.get,
      });
      try {
        const reorder = registered.get(LOCAL_IPC_CHANNELS.reorderColumns);
        expect(reorder).toBeTypeOf('function');
        // An unapproved Office session cannot reorder (or touch local data).
        expect(() => reorder!({}, { columnIds: ['civil_id', 'name', 'passport_no'], role: 'office' }))
          .toThrow(/waiting for admin approval/i);
        expect(store.listColumns().map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id']);
        // Once approved, the same channel works.
        clearance.set('allowed');
        await reorder!({}, { columnIds: ['civil_id', 'name', 'passport_no'], role: 'office' });
        expect(store.listColumns().map((item) => item.id)).toEqual(['civil_id', 'name', 'passport_no']);
      } finally {
        unregister();
      }
    } finally {
      store.close();
    }
  });
});

describe('electron repository reorder bridge', () => {
  function windowWithLocal(local: DksLocalApi): DksWindowApi {
    return {
      platform: 'linux',
      appVersion: '0.1.0',
      local,
      minimizeToTray: () => undefined,
      quit: () => undefined,
    };
  }

  it('uses the atomic bridge reorder with the session role and returns position order', async () => {
    const reorderColumns = vi.fn(async () => [
      { id: 'civil_id', name: 'Civil ID', type: 'civil_id', position: 2 },
      { id: 'name', name: 'Name', type: 'text', position: 0 },
      { id: 'passport_no', name: 'Passport No', type: 'text', position: 1 },
    ]);
    const local = { reorderColumns } as unknown as DksLocalApi;
    const repository = new ElectronSheetRepository({ windowApi: windowWithLocal(local), role: 'office' });

    const result = await repository.reorderColumns(['name', 'passport_no', 'civil_id']);
    expect(reorderColumns).toHaveBeenCalledWith({ columnIds: ['name', 'passport_no', 'civil_id'], role: 'office' });
    expect(result.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id']);
  });

  it('persists through sequential position updates when the bridge predates reorder', async () => {
    let columns: DksLocalColumn[] = SHEET_COLUMNS.map((item) => ({ ...item }));
    const updateColumn = vi.fn(async (input: { id: string; patch: Partial<DksLocalColumn> }) => {
      columns = columns.map((item) => (item.id === input.id ? { ...item, ...input.patch } : item));
      return columns.find((item) => item.id === input.id) ?? null;
    });
    const local = {
      getSnapshot: vi.fn(async (): Promise<DksLocalSnapshot> => ({
        rows: [],
        deletedRows: [],
        columns,
        syncStatus: { status: 'offline', lastSyncAt: null, lastError: null, pendingCount: 0 },
      })),
      updateColumn,
    } as unknown as DksLocalApi;
    const repository = new ElectronSheetRepository({ windowApi: windowWithLocal(local), role: 'admin' });

    const result = await repository.reorderColumns(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(result.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    // Only the two moved columns were updated.
    expect(updateColumn.mock.calls.map(([input]) => input.id).sort()).toEqual(['civil_id', 'country']);
  });

  it('renders snapshot columns in position order even when the bridge scrambles them', async () => {
    const local = {
      getSnapshot: vi.fn(async (): Promise<DksLocalSnapshot> => ({
        rows: [],
        deletedRows: [],
        columns: [
          { id: 'civil_id', name: 'Civil ID', type: 'civil_id', position: 2 },
          { id: 'name', name: 'Name', type: 'text', position: 0 },
          { id: 'passport_no', name: 'Passport No', type: 'text', position: 1 },
        ],
        syncStatus: { status: 'offline', lastSyncAt: null, lastError: null, pendingCount: 0 },
      })),
    } as unknown as DksLocalApi;
    const repository = new ElectronSheetRepository({ windowApi: windowWithLocal(local) });
    expect((await repository.getColumns()).map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id']);
  });
});

describe('SheetPage drag-reorder wiring', () => {
  async function seededRepository() {
    const repository = createInMemorySheetRepository();
    for (const input of SHEET_COLUMNS) {
      await repository.addColumn({ id: input.id, name: input.name, type: input.type, isPassport: input.isPassport });
    }
    await repository.createRow({ passport_no: 'A1234567', civil_id: '123456789012' });
    return repository;
  }

  function headerLabels(): string[] {
    return screen.getAllByRole('columnheader').map((header) => (header.textContent ?? '').trim());
  }

  function gridUserColumnIds(): string[] {
    const defs = (gridCapture.props?.columnDefs ?? []) as Array<{ colId?: string }>;
    const system = new Set(['__rowNumber', '__actions', '__addColumn', 'daysLeft']);
    return defs.map((def) => def.colId).filter((id): id is string => !!id && !system.has(id));
  }

  function capturedOnColumnMoved(): ((event: unknown) => void) | undefined {
    return gridCapture.props?.onColumnMoved as ((event: unknown) => void) | undefined;
  }

  it('Civil ID dragged next to Passport stays there across rerenders, refresh and remount', async () => {
    const repository = await seededRepository();
    const reorderSpy = vi.spyOn(repository, 'reorderColumns');
    gridCapture.props = null;

    const { rerender, unmount } = render(
      <SheetPage repository={repository} role="office" refreshToken={0} renderGridInTests />,
    );
    await screen.findByText('A1234567');
    expect(headerLabels()).toEqual(['Actions', 'Name', 'Passport No', 'Country', 'Civil ID', 'Visa Expiry', '+', 'Days Left']);
    expect(gridUserColumnIds()).toEqual(['name', 'passport_no', 'country', 'civil_id', 'visa_expiry']);

    const onColumnMoved = capturedOnColumnMoved() as (event: unknown) => void;
    expect(onColumnMoved).toBeTypeOf('function');
    const dragEvent = {
      finished: true,
      source: 'uiColumnDragged',
      api: fakeGridApi(
        ['__rowNumber', '__actions', 'name'],
        ['passport_no', 'civil_id', 'country', 'visa_expiry'],
        ['__addColumn', 'daysLeft'],
      ),
    };

    // Unfinished drag steps and programmatic moves never write.
    await act(async () => {
      onColumnMoved({ ...dragEvent, finished: false });
      onColumnMoved({ ...dragEvent, source: 'api' });
    });
    expect(reorderSpy).not.toHaveBeenCalled();

    // The finished drop persists exactly once…
    await act(async () => {
      onColumnMoved(dragEvent);
    });
    await waitFor(() => {
      expect(headerLabels()).toEqual(['Actions', 'Name', 'Passport No', 'Civil ID', 'Country', 'Visa Expiry', '+', 'Days Left']);
    });
    expect(reorderSpy).toHaveBeenCalledTimes(1);
    expect(reorderSpy).toHaveBeenCalledWith(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    // …the accessible table and the real grid defs agree…
    expect(gridUserColumnIds()).toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    // …and the repository (the reload source) holds normalized positions.
    const stored = await repository.getColumns();
    expect(stored.map((item) => item.id)).toEqual(['name', 'passport_no', 'civil_id', 'country', 'visa_expiry']);
    expect(stored.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);

    // A quiet background refresh neither undoes the order nor writes again.
    rerender(<SheetPage repository={repository} role="office" refreshToken={1} renderGridInTests />);
    await waitFor(() => {
      expect(headerLabels()).toEqual(['Actions', 'Name', 'Passport No', 'Civil ID', 'Country', 'Visa Expiry', '+', 'Days Left']);
    });
    expect(reorderSpy).toHaveBeenCalledTimes(1);

    // Navigation away and back (remount from the repository) keeps it too.
    unmount();
    render(<SheetPage repository={repository} role="office" renderGridInTests />);
    await screen.findByText('A1234567');
    expect(headerLabels()).toEqual(['Actions', 'Name', 'Passport No', 'Civil ID', 'Country', 'Visa Expiry', '+', 'Days Left']);
  });
});

describe('reorder survives a cloud sync round-trip', () => {
  function createSqliteLocal(store: ReturnType<typeof createSqliteStore>) {
    const snapshot = (): DksLocalSnapshot => ({
      rows: store.listRows(true).map((row) => ({ ...row })) as unknown as DksLocalRow[],
      deletedRows: store.listRows(true).filter((row) => row.deleted === true)
        .map((row) => ({ ...row })) as unknown as DksLocalRow[],
      columns: store.listColumns(false).map((item) => ({ ...item })) as unknown as DksLocalColumn[],
      deletedColumns: store.listColumns(true).filter((item) => item.deleted === true)
        .map((item) => ({ ...item })) as unknown as DksLocalColumn[],
      settings: store.getSettings(),
      syncStatus: store.getSyncStatus() as unknown as DksLocalSnapshot['syncStatus'],
    });
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot(),
      setSyncStatus: async (state) => store.setSyncStatus(state as never) as unknown as DksLocalSnapshot['syncStatus'],
      applyRemoteSnapshot: async (input) => {
        for (const row of input.rows) {
          store.applyRemoteEntry(row as never);
        }
        for (const item of input.columns) {
          store.applyRemoteColumn(item as never);
        }
        return snapshot();
      },
      acknowledgeOutbox: async () => store.acknowledgeOutbox() as unknown as DksLocalSnapshot['syncStatus'],
      recordConflict: async (conflict) => {
        store.recordConflict({ ...conflict, resolved: false } as never);
      },
      listOutbox: async (input) => store.listOutbox(input?.status ?? 'all') as unknown as SupabaseOutboxItem[],
      markOutboxSynced: (id) => {
        store.markOutboxSynced(id);
      },
      markOutboxFailed: (id, message) => {
        store.markOutboxFailed(id, message);
      },
      retryFailedOutbox: async () => store.retryFailedOutbox(),
    };
    return local;
  }

  function createFakeRemote() {
    const tables: Record<string, Record<string, unknown>[]> = {};
    const writes: Array<{ table: string; mode: 'insert' | 'update'; value: Record<string, unknown> }> = [];
    const apply = (table: string, mode: 'insert' | 'update', values: readonly Record<string, unknown>[]) => {
      const rows = tables[table] ?? (tables[table] = []);
      for (const value of values) {
        writes.push({ table, mode, value: { ...value } });
        const index = rows.findIndex((row) => row.id === value.id);
        if (index >= 0) {
          rows[index] = { ...rows[index], ...value };
        } else {
          rows.push({ ...value });
        }
      }
    };
    const client: SupabaseDataClient = {
      from: (table) => ({
        select: async () => ({ data: (tables[table] ?? []).map((row) => ({ ...row })), error: null }),
        insert: async (values) => {
          apply(table, 'insert', values);
          return { data: [...values], error: null };
        },
        update: (values) => ({
          eq: async (_column: string, id: string) => {
            apply(table, 'update', [{ ...values, id }]);
            return { data: null, error: null };
          },
        }),
        // Entries/columns must never be written through upsert.
        upsert: async (values) => (table === 'settings'
          ? { data: [...values], error: null }
          : { data: null, error: { message: `unexpected upsert for ${table}` } }),
      }),
    };
    return { client, tables, writes };
  }

  it('pushes new positions as explicit updates, drains the outbox, and a fresh device reads the same order', async () => {
    let nowValue = '2026-01-01T00:00:00.000Z';
    const store = createSqliteStore({ filename: ':memory:', now: () => nowValue });
    const ids = {
      name: '11111111-aaaa-4bbb-8ccc-000000000001',
      passport: '11111111-aaaa-4bbb-8ccc-000000000002',
      country: '11111111-aaaa-4bbb-8ccc-000000000003',
      civil: '11111111-aaaa-4bbb-8ccc-000000000004',
    };
    try {
      store.upsertColumn({ id: ids.name, name: 'Name', type: 'text', position: 0 });
      store.upsertColumn({ id: ids.passport, name: 'Passport No', type: 'text', position: 1, isPassport: true });
      store.upsertColumn({ id: ids.country, name: 'Country', type: 'text', position: 2 });
      store.upsertColumn({ id: ids.civil, name: 'Civil ID', type: 'civil_id', position: 3 });

      const { client, tables, writes } = createFakeRemote();
      const firstSync = await runSupabaseSync({ client, local: createSqliteLocal(store) });
      expect(firstSync.status).toBe('healthy');
      expect(store.getPendingOutboxCount()).toBe(0);
      const writesAfterFirstSync = writes.length;

      // Offline reorder at a later time, then the next successful sync.
      nowValue = '2026-01-10T00:00:00.000Z';
      store.reorderColumns([ids.name, ids.passport, ids.civil, ids.country], 'office');
      expect(store.getPendingOutboxCount()).toBeGreaterThan(0);

      const secondSync = await runSupabaseSync({ client, local: createSqliteLocal(store) });
      expect(secondSync.status).toBe('healthy');
      expect(store.getPendingOutboxCount()).toBe(0);

      const remoteOrder = [...(tables.app_columns ?? [])]
        .sort((left, right) => Number(left.position) - Number(right.position))
        .map((row) => row.name);
      expect(remoteOrder).toEqual(['Name', 'Passport No', 'Civil ID', 'Country']);
      const secondSyncColumnWrites = writes.slice(writesAfterFirstSync).filter((write) => write.table === 'app_columns');
      expect(secondSyncColumnWrites.length).toBeGreaterThan(0);
      expect(secondSyncColumnWrites.every((write) => write.mode === 'update')).toBe(true);
      expect(secondSyncColumnWrites.some((write) => write.value.name === 'Civil ID' && write.value.position === 2)).toBe(true);

      // A fresh local database (restart on another device) adopts the order.
      const freshStore = createSqliteStore({ filename: ':memory:', now: () => '2026-01-11T00:00:00.000Z' });
      try {
        const freshSync = await runSupabaseSync({ client, local: createSqliteLocal(freshStore) });
        expect(freshSync.status).toBe('healthy');
        expect(freshStore.listColumns().map((item) => item.name))
          .toEqual(['Name', 'Passport No', 'Civil ID', 'Country']);
        expect(freshStore.listColumns().map((item) => item.position)).toEqual([0, 1, 2, 3]);
      } finally {
        freshStore.close();
      }
    } finally {
      store.close();
    }
  });
});
