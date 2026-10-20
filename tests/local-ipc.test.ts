import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_IPC_CHANNELS,
  createLocalIpcHandlers,
  registerLocalIpcHandlers,
  type LocalIpcStore,
} from '../electron/main/local-ipc';
import type { SyncState } from '../electron/main/sync';

function createFakeStore(): LocalIpcStore & {
  rows: Array<Record<string, unknown>>;
  columns: Array<Record<string, unknown>>;
  syncStatus: SyncState;
} {
  const rows: Array<Record<string, unknown>> = [
    {
      id: 'row-1',
      data: { name: 'Ada' },
      category: 'Employee',
      deleted: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'row-deleted',
      data: { name: 'Grace' },
      category: 'Employee',
      deleted: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const columns: Array<Record<string, unknown>> = [
    {
      id: 'name',
      name: 'Name',
      type: 'text',
      deleted: false,
      position: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const syncStatus: SyncState = {
    status: 'offline',
    lastSyncAt: null,
    lastError: null,
    pendingCount: 0,
  };

  return {
    rows,
    columns,
    syncStatus,
    listRows: (includeDeleted = false) => includeDeleted
      ? rows
      : rows.filter((row) => row.deleted !== true),
    listColumns: () => columns,
    getSyncStatus: () => syncStatus,
    createRow: (input) => {
      const row = {
        id: 'row-created',
        data: { ...input.data },
        category: input.category ?? 'Employee',
        deleted: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      rows.push(row);
      return row;
    },
    updateRow: (id, patch) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      Object.assign(row, patch, patch.data ? { data: { ...row.data as object, ...patch.data } } : {});
      return row;
    },
    getRow: (id) => rows.find((row) => row.id === id) ?? null,
    softDeleteEntry: (id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      row.deleted = true;
      return row;
    },
    restoreEntry: (id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      row.deleted = false;
      return row;
    },
    permanentDeleteEntry: (id) => {
      const index = rows.findIndex((candidate) => candidate.id === id);
      if (index < 0) return null;
      return rows.splice(index, 1)[0] ?? null;
    },
    upsertColumn: (input) => {
      const column = { ...input, deleted: false };
      columns.push(column);
      return column;
    },
    deleteColumn: vi.fn((id: string, role: string) => {
      if (role !== 'admin') return null;
      const column = columns.find((candidate) => candidate.id === id);
      if (!column) return null;
      column.deleted = true;
      return column;
    }),
    listAudit: () => [{
      id: 1,
      actor: 'Admin',
      entityType: 'entry',
      entityId: 'row-1',
      action: 'update',
      before: null,
      after: { name: 'Ada' },
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    listNotifications: () => [{
      id: 1,
      type: 'expiry',
      message: 'Soon',
      payload: {},
      read: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    setSyncStatus: (next) => Object.assign(syncStatus, typeof next === 'string' ? { status: next } : next),
    flush: vi.fn(async () => undefined),
    close: vi.fn(() => ({ closed: true, flushed: true })),
  };
}

describe('offline local IPC bridge', () => {
  it('registers serializable CRUD handlers against an injected store', async () => {
    const store = createFakeStore();
    const backup = vi.fn(async () => ({
      fileName: 'dks-backup-20260101000000.sqlite',
      bytes: 12,
      createdAt: '2026-01-01T00:00:00.000Z',
      sha256: 'abc123',
      path: 'C:\\private\\dks-backup.sqlite',
    }));
    const handlers = createLocalIpcHandlers({ store, backup });

    const snapshot = await handlers[LOCAL_IPC_CHANNELS.getSnapshot](undefined);
    expect(snapshot).toEqual(expect.objectContaining({
      rows: [expect.objectContaining({ id: 'row-1' })],
      deletedRows: [expect.objectContaining({ id: 'row-deleted' })],
      columns: [expect.objectContaining({ id: 'name' })],
      syncStatus: expect.objectContaining({ status: 'offline' }),
    }));

    await handlers[LOCAL_IPC_CHANNELS.createRow]({ data: { name: 'Katherine' }, category: 'Client' });
    await handlers[LOCAL_IPC_CHANNELS.updateRow]({ id: 'row-1', data: { passport_no: 'A1' } });
    await handlers[LOCAL_IPC_CHANNELS.duplicateRow]({ id: 'row-1' });
    await handlers[LOCAL_IPC_CHANNELS.softDeleteRow]({ id: 'row-1' });
    await handlers[LOCAL_IPC_CHANNELS.restoreRow]({ id: 'row-1', role: 'admin' });
    await handlers[LOCAL_IPC_CHANNELS.permanentDeleteRow]({ id: 'row-deleted', role: 'admin' });
    await handlers[LOCAL_IPC_CHANNELS.deleteColumn]({ id: 'name', role: 'admin' });

    expect(store.deleteColumn).toHaveBeenCalledWith('name', 'admin', undefined);
    expect(await handlers[LOCAL_IPC_CHANNELS.listAudit]({ limit: 10 })).toHaveLength(1);
    expect(await handlers[LOCAL_IPC_CHANNELS.listNotifications]({ unreadOnly: true })).toHaveLength(1);
    const backupResult = await handlers[LOCAL_IPC_CHANNELS.backupNow](undefined);
    expect(backupResult).toEqual(expect.objectContaining({ fileName: expect.stringContaining('backup') }));
    expect(backupResult).not.toHaveProperty('path');
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('passes role to column deletion and rejects malformed requests before touching the store', async () => {
    const store = createFakeStore();
    const handlers = createLocalIpcHandlers({ store });

    expect(() => handlers[LOCAL_IPC_CHANNELS.deleteColumn]({ id: 'name', role: '' })).toThrow(/role/i);
    expect(() => handlers[LOCAL_IPC_CHANNELS.updateRow]({ id: '', data: {} })).toThrow(/row/i);
    expect(store.deleteColumn).not.toHaveBeenCalled();
  });

  it('updates a persisted notification by its stable renderer id', async () => {
    const store = createFakeStore();
    const updateNotification = vi.fn(() => ({
      id: 1,
      type: 'expiry',
      message: 'Soon',
      payload: { id: 'expiry:row-1:2026-01-08:7' },
      read: true,
      dismissed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    }));
    store.updateNotification = updateNotification;
    const handlers = createLocalIpcHandlers({ store });

    const result = await handlers[LOCAL_IPC_CHANNELS.updateNotification]({
      id: 'expiry:row-1:2026-01-08:7',
      read: true,
    });

    expect(updateNotification).toHaveBeenCalledWith('expiry:row-1:2026-01-08:7', {
      read: true,
      dismissed: undefined,
      payload: undefined,
    });
    expect(result).toEqual(expect.objectContaining({ read: true }));
  });

  it('persists a newly evaluated notification without exposing the database handle', async () => {
    const store = createFakeStore();
    const addNotification = vi.fn((input) => ({
      id: 2,
      ...input,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    store.addNotification = addNotification;
    const handlers = createLocalIpcHandlers({ store });

    const result = await handlers[LOCAL_IPC_CHANNELS.addNotification]({
      type: 'expiry',
      message: 'Soon',
      payload: { id: 'expiry:row-1:2026-01-08:7' },
      read: false,
      dismissed: false,
    });

    expect(addNotification).toHaveBeenCalledWith({
      type: 'expiry',
      message: 'Soon',
      payload: { id: 'expiry:row-1:2026-01-08:7' },
      read: false,
      dismissed: false,
    });
    expect(result).toEqual(expect.objectContaining({ id: 2 }));
  });

  it('applies remote rows and acknowledges the local mutation queue', async () => {
    const store = createFakeStore();
    const applyRemoteEntry = vi.fn((input) => ({ id: input.id, data: input.data }));
    const applyRemoteColumn = vi.fn((input) => ({ id: input.id, name: input.name, type: input.type }));
    const acknowledgeOutbox = vi.fn(() => ({
      status: 'healthy' as const,
      lastSyncAt: '2026-01-02T00:00:00.000Z',
      lastError: null,
      pendingCount: 0,
    }));
    store.applyRemoteEntry = applyRemoteEntry;
    store.applyRemoteColumn = applyRemoteColumn;
    store.acknowledgeOutbox = acknowledgeOutbox;
    const handlers = createLocalIpcHandlers({ store });

    await handlers[LOCAL_IPC_CHANNELS.applyRemoteSnapshot]({
      rows: [{ id: 'remote-entry', data: { name: 'Remote' } }],
      columns: [{ id: 'remote-column', name: 'Country', type: 'text' }],
    });
    const status = await handlers[LOCAL_IPC_CHANNELS.acknowledgeOutbox](undefined);

    expect(applyRemoteEntry).toHaveBeenCalledWith({ id: 'remote-entry', data: { name: 'Remote' } });
    expect(applyRemoteColumn).toHaveBeenCalledWith({ id: 'remote-column', name: 'Country', type: 'text' });
    expect(acknowledgeOutbox).toHaveBeenCalledTimes(1);
    expect(status).toEqual(expect.objectContaining({ status: 'healthy', pendingCount: 0 }));
  });

  it('registers handlers through an injected ipcMain and closes/flushed local state', async () => {
    const store = createFakeStore();
    const registered = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => registered.set(channel, handler),
      removeHandler: (channel: string) => registered.delete(channel),
    };

    const unregister = registerLocalIpcHandlers({ ipcMain, store });
    expect(registered.has(LOCAL_IPC_CHANNELS.getSnapshot)).toBe(true);
    await registered.get(LOCAL_IPC_CHANNELS.flushSync)?.(undefined);
    await registered.get(LOCAL_IPC_CHANNELS.close)?.(undefined);
    expect(store.flush).toHaveBeenCalledTimes(2);
    expect(store.close).toHaveBeenCalledTimes(1);
    unregister();
    expect(registered.size).toBe(0);
  });
});
