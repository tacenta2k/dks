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
    const handlers = createLocalIpcHandlers({ store });

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
  });

  it('does not expose a database backup IPC channel or handler', () => {
    const handlers = createLocalIpcHandlers({ store: createFakeStore() });

    expect('backupNow' in LOCAL_IPC_CHANNELS).toBe(false);
    expect('dks:local:backup-now' in handlers).toBe(false);
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

  it('reads and writes cached workspace settings through the local bridge', async () => {
    const store = createFakeStore();
    let settings: Record<string, unknown> = { theme: 'light' };
    store.getSettings = vi.fn(() => settings);
    store.setSettings = vi.fn((next: Record<string, unknown>) => {
      settings = { ...settings, ...next };
      return settings;
    });
    const handlers = createLocalIpcHandlers({ store });

    expect(await handlers[LOCAL_IPC_CHANNELS.getSettings](undefined)).toEqual({ theme: 'light' });
    expect(await handlers[LOCAL_IPC_CHANNELS.setSettings]({ settings: { theme: 'dark' } })).toEqual({ theme: 'dark' });
    expect(store.setSettings).toHaveBeenCalledWith({ theme: 'dark' });
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

/**
 * Regression coverage for the Recycle Bin permanent-delete crash:
 * `Error invoking remote method 'dks:local:permanent-delete-row':
 * TypeError: Cannot read properties of undefined (reading 'ensureOpen')`.
 *
 * SqliteStore keeps its native handle private and every public method starts
 * with `this.ensureOpen()`.  When the IPC bridge detached those methods from
 * the store instance, `this` was undefined and the call crashed before any
 * deletion happened.  The store below mirrors that exact class shape.
 */
class ClassStyleLocalStore {
  public rows: Array<Record<string, unknown>>;

  public notifications: Array<Record<string, unknown>> = [];

  public outbox: Array<{ idempotencyKey: string; operation: string; entityId: string }> = [];

  public audit: Array<Record<string, unknown>> = [];

  private open = true;

  constructor() {
    this.rows = [
      {
        id: 'row-1',
        data: { name: 'Ada' },
        deleted: true,
        deletedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ];
  }

  private ensureOpen(): void {
    if (!this.open) {
      throw new Error('The DKS local database is closed');
    }
  }

  public listRows(includeDeleted = false): Array<Record<string, unknown>> {
    this.ensureOpen();
    return includeDeleted ? this.rows : this.rows.filter((row) => row.deleted !== true);
  }

  public getRow(id: string): Record<string, unknown> | null {
    this.ensureOpen();
    return this.rows.find((row) => row.id === id) ?? null;
  }

  public permanentDeleteEntry(
    id: string,
    idempotencyKey?: string,
    updatedBy?: string | null,
  ): Record<string, unknown> | null {
    this.ensureOpen();
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) {
      return null;
    }
    const [removed] = this.rows.splice(index, 1);
    this.outbox.push({
      idempotencyKey: idempotencyKey ?? `entry:permanent-delete:${id}`,
      operation: 'permanent_delete',
      entityId: id,
    });
    this.audit.push({ action: 'permanent_delete', entityId: id, actor: updatedBy ?? null });
    return removed ?? null;
  }

  public addNotification(input: Record<string, unknown>): Record<string, unknown> {
    this.ensureOpen();
    const record = { id: this.notifications.length + 1, ...input };
    this.notifications.push(record);
    return record;
  }

  public updateNotification(id: number | string, patch: Record<string, unknown>): Record<string, unknown> | null {
    this.ensureOpen();
    const record = this.notifications.find((candidate) => candidate.id === id);
    if (!record) {
      return null;
    }
    Object.assign(record, patch);
    return record;
  }

  public listColumns(): Array<Record<string, unknown>> {
    this.ensureOpen();
    return [];
  }

  public getSettings(): Record<string, unknown> {
    this.ensureOpen();
    return {};
  }

  public getSyncStatus(): SyncState {
    this.ensureOpen();
    return { status: 'offline', lastSyncAt: null, lastError: null, pendingCount: 0 };
  }

  public setSyncStatus(next: SyncState | string): SyncState {
    this.ensureOpen();
    return typeof next === 'string'
      ? { ...this.getSyncStatus(), status: next as SyncState['status'] }
      : next;
  }

  public listAudit(): Array<Record<string, unknown>> {
    this.ensureOpen();
    return this.audit;
  }

  public listNotifications(): Array<Record<string, unknown>> {
    this.ensureOpen();
    return this.notifications;
  }

  public flush(): void {
    this.ensureOpen();
  }

  public close(): { closed: boolean; flushed: boolean } {
    this.open = false;
    return { closed: true, flushed: true };
  }
}

describe('recycle bin permanent delete regression (B2)', () => {
  it('deletes through class-style store methods without losing the store binding', async () => {
    const store = new ClassStyleLocalStore();
    const handlers = createLocalIpcHandlers({
      store: store as unknown as LocalIpcStore,
      now: () => '2026-01-03T00:00:00.000Z',
    });

    const removed = await handlers[LOCAL_IPC_CHANNELS.permanentDeleteRow]({
      id: 'row-1',
      role: 'admin',
      idempotencyKey: 'entry:permanent-delete:row-1:retry-1',
      updatedBy: 'admin-1',
    });

    expect(removed).toEqual(expect.objectContaining({ id: 'row-1' }));
    expect(store.rows).toHaveLength(0);
    expect(store.outbox).toContainEqual({
      idempotencyKey: 'entry:permanent-delete:row-1:retry-1',
      operation: 'permanent_delete',
      entityId: 'row-1',
    });
    expect(store.audit).toContainEqual({
      action: 'permanent_delete',
      entityId: 'row-1',
      actor: 'admin-1',
    });
  });

  it('rejects permanent delete without an explicit admin role and keeps the row', async () => {
    const store = new ClassStyleLocalStore();
    const handlers = createLocalIpcHandlers({ store: store as unknown as LocalIpcStore });

    expect(() => handlers[LOCAL_IPC_CHANNELS.permanentDeleteRow]({ id: 'row-1' })).toThrow(/role/i);
    expect(() => handlers[LOCAL_IPC_CHANNELS.permanentDeleteRow]({ id: 'row-1', role: 'office' }))
      .toThrow(/administrator/i);
    expect(() => handlers[LOCAL_IPC_CHANNELS.restoreRow]({ id: 'row-1' })).toThrow(/role/i);
    expect(() => handlers[LOCAL_IPC_CHANNELS.restoreRow]({ id: 'row-1', role: 'office' }))
      .toThrow(/administrator/i);
    expect(store.rows).toHaveLength(1);
  });

  it('returns null without side effects when the row is already gone', async () => {
    const store = new ClassStyleLocalStore();
    const handlers = createLocalIpcHandlers({ store: store as unknown as LocalIpcStore });

    const removed = await handlers[LOCAL_IPC_CHANNELS.permanentDeleteRow]({
      id: 'row-missing',
      role: 'admin',
    });

    expect(removed).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(store.outbox).toHaveLength(0);
    expect(store.audit).toHaveLength(0);
  });

  it('keeps the store binding for notification persistence methods', async () => {
    const store = new ClassStyleLocalStore();
    const handlers = createLocalIpcHandlers({ store: store as unknown as LocalIpcStore });

    const created = await handlers[LOCAL_IPC_CHANNELS.addNotification]({
      type: 'expiry',
      message: 'Visa expires in 7 days',
      payload: { id: 'expiry:row-1' },
    });
    expect(created).toEqual(expect.objectContaining({ id: 1 }));

    const updated = await handlers[LOCAL_IPC_CHANNELS.updateNotification]({
      id: 1,
      read: true,
    });
    expect(updated).toEqual(expect.objectContaining({ id: 1, read: true }));
  });

  it('permanently deletes through the real SqliteStore without the ensureOpen crash', async () => {
    const { createSqliteStore } = await import('../electron/main/sqlite');
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-03T00:00:00.000Z' });
    try {
      store.createEntry({
        id: '11111111-2222-4333-8444-555555555555',
        data: { name: 'Test record' },
        category: 'Employee',
      });
      const handlers = createLocalIpcHandlers({ store, now: () => '2026-01-03T00:00:00.000Z' });

      const removed = await handlers[LOCAL_IPC_CHANNELS.permanentDeleteRow]({
        id: '11111111-2222-4333-8444-555555555555',
        role: 'admin',
        idempotencyKey: 'entry:permanent-delete:regression-1',
        updatedBy: 'admin-1',
      });

      expect(removed).toEqual(expect.objectContaining({
        id: '11111111-2222-4333-8444-555555555555',
      }));
      expect(store.getEntry('11111111-2222-4333-8444-555555555555')).toBeNull();
      // The permanent delete must be queued for cloud sync and audited.
      expect(store.listOutbox('all').some((item) => (
        item.operation === 'permanent_delete'
        && item.idempotencyKey === 'entry:permanent-delete:regression-1'
      ))).toBe(true);
      expect(store.listAudit().some((entry) => entry.action === 'permanent_delete')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('exposes outbox metadata and per-item sync bookkeeping without payloads', async () => {
    const { createSqliteStore } = await import('../electron/main/sqlite');
    const store = createSqliteStore({ filename: ':memory:', now: () => '2026-01-03T00:00:00.000Z' });
    try {
      store.createEntry({
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        data: { name: 'Queued row' },
        category: 'Employee',
      });
      const handlers = createLocalIpcHandlers({ store, now: () => '2026-01-03T00:00:00.000Z' });

      const pending = await handlers[LOCAL_IPC_CHANNELS.listOutbox]({ status: 'pending' }) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual(expect.objectContaining({
        operation: 'create',
        entityType: 'entry',
        entityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        status: 'pending',
      }));
      // Row payloads must not widen the data exposed over the bridge.
      expect(pending[0]).not.toHaveProperty('payload');

      const itemId = pending[0].id as number;
      await handlers[LOCAL_IPC_CHANNELS.markOutboxFailed]({ id: itemId, message: 'network down' });
      const failed = await handlers[LOCAL_IPC_CHANNELS.listOutbox]({ status: 'failed' }) as Array<Record<string, unknown>>;
      expect(failed).toEqual([expect.objectContaining({ id: itemId, lastError: 'network down' })]);

      const retry = await handlers[LOCAL_IPC_CHANNELS.retryFailedOutbox](undefined) as { requeued: number };
      expect(retry.requeued).toBe(1);

      await handlers[LOCAL_IPC_CHANNELS.markOutboxSynced]({ id: itemId });
      const synced = await handlers[LOCAL_IPC_CHANNELS.listOutbox]({ status: 'synced' }) as Array<Record<string, unknown>>;
      expect(synced).toEqual([expect.objectContaining({ id: itemId })]);
    } finally {
      store.close();
    }
  });
});
