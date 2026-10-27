import { describe, expect, it, vi } from 'vitest';

import { createSqliteStore } from '../electron/main/sqlite';
import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseOutboxItem,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalColumn, DksLocalRow, DksLocalSnapshot } from '../src/lib/types';

const ID = 'ff82b000-1111-4111-8111-000000000a94';
const UID = '11111111-2222-4222-8222-111111111111';
const MESSAGE = 'This record can no longer be changed from the Office account';

function localStore() {
  const store = createSqliteStore({ filename: ':memory:', now: () => '2026-10-27T09:00:00.000Z' });
  const snapshot = (): DksLocalSnapshot => ({
    rows: store.listRows(false) as unknown as DksLocalRow[],
    deletedRows: store.listRows(true).filter((row) => row.deleted) as unknown as DksLocalRow[],
    columns: store.listColumns(false) as unknown as DksLocalColumn[],
    syncStatus: store.getSyncStatus() as DksLocalSnapshot['syncStatus'],
  });
  const synced = vi.fn((id: number | string) => store.markOutboxSynced(id));
  const terminal = vi.fn((id: number | string, message: string) => store.markOutboxTerminal(id, message));
  const local: SupabaseSyncLocal = {
    getSnapshot: vi.fn(async () => snapshot()),
    setSyncStatus: async (state) => store.setSyncStatus(state) as DksLocalSnapshot['syncStatus'],
    listOutbox: async () => store.listOutbox('all') as unknown as SupabaseOutboxItem[],
    markOutboxSynced: synced,
    markOutboxFailed: (id, message) => store.markOutboxFailed(id, message),
    markOutboxTerminal: terminal,
    retryFailedOutbox: () => store.retryFailedOutbox(),
    acknowledgeOutbox: async () => store.acknowledgeOutbox() as DksLocalSnapshot['syncStatus'],
    applyRemoteSnapshot: async ({ rows, columns }) => {
      rows.forEach((row) => store.applyRemoteEntry(row as never));
      columns.forEach((column) => store.applyRemoteColumn(column as never));
      return snapshot();
    },
  };
  return { store, local, synced, terminal };
}

function remote(options: {
  duplicate?: boolean;
  count?: number | null;
  visibility?: 'visible' | 'hidden' | 'missing';
  rpcError?: { message: string; code?: string };
  onUpdate?: () => void;
  onRpc?: () => void;
} = {}) {
  const insert = vi.fn(async () => options.duplicate
    ? { data: null, error: { code: '23505', message: 'duplicate key apikey=secret-value' } }
    : { data: null, error: null });
  const eq = vi.fn(async () => {
    options.onUpdate?.();
    return { data: null, error: null, count: options.count === undefined ? 1 : options.count };
  });
  // There is deliberately no select() on the update builder.
  const update = vi.fn(() => ({ eq }));
  const rpc = vi.fn(async () => {
    options.onRpc?.();
    return { data: options.visibility ?? 'hidden', error: options.rpcError ?? null };
  });
  const client: SupabaseDataClient = {
    from: (table) => ({
      select: async () => ({ data: [], error: null }), // RLS hides this id
      insert: table === 'entries' ? insert : async () => ({ data: null, error: null }),
      update: table === 'entries' ? update : () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
    rpc,
  };
  return { client, insert, update, eq, rpc };
}

function addExistingEdit(store: ReturnType<typeof localStore>['store']) {
  store.applyRemoteEntry({ id: ID, data: { name: 'Original' }, category: 'Employee', deleted: false,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
  store.updateEntry(ID, { data: { name: 'Kept local edit' } });
}

describe('operation-driven, idempotent entry sync', () => {
  it('acknowledges a 23505 create once, without exposing the raw server reason or retrying', async () => {
    const { store, local, synced } = localStore();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      store.createEntry({ id: ID, data: { name: 'Offline create' } });
      const server = remote({ duplicate: true });
      expect((await runSupabaseSync({ client: server.client, local, userId: UID })).status).toBe('healthy');
      expect((await runSupabaseSync({ client: server.client, local, userId: UID })).status).toBe('healthy');
      expect(server.insert).toHaveBeenCalledOnce();
      expect(server.update).not.toHaveBeenCalled();
      expect(synced).toHaveBeenCalledOnce();
      expect(store.listOutbox('all')[0].status).toBe('synced');
      expect(info).toHaveBeenCalledOnce();
      expect(JSON.stringify(info.mock.calls)).not.toContain('secret-value');
    } finally { store.close(); }
  });

  it('recovers when the create reached the server but its local acknowledgement was fenced', async () => {
    const { store, local } = localStore();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      store.createEntry({ id: ID, data: { name: 'Offline create' } });
      let approved = true;
      let onServer = false;
      const insert = vi.fn(async () => {
        if (onServer) return { data: null, error: { code: '23505', message: 'duplicate entries_pkey' } };
        onServer = true;
        return { data: null, error: null };
      });
      const client: SupabaseDataClient = {
        from: () => ({ select: async () => ({ data: [], error: null }), insert }),
      };
      const acknowledge = vi.fn((id: number | string) => {
        if (approved && onServer && acknowledge.mock.calls.length === 1) {
          approved = false;
          throw new Error('Waiting for admin approval');
        }
        store.markOutboxSynced(id);
      });
      local.markOutboxSynced = acknowledge;
      const first = await runSupabaseSync({ client, local, isSessionAllowed: () => approved });
      expect(first.error).toContain('sync is paused');
      expect(store.listOutbox('all')[0].status).toBe('pending');
      approved = true;
      expect((await runSupabaseSync({ client, local, isSessionAllowed: () => approved })).status).toBe('healthy');
      await runSupabaseSync({ client, local, isSessionAllowed: () => approved });
      expect(insert).toHaveBeenCalledTimes(2);
      expect(store.listOutbox('all')[0].status).toBe('synced');
      expect(acknowledge).toHaveBeenCalledTimes(2);
    } finally { store.close(); }
  });

  it('inserts an offline create as active before applying its separately queued deletion', async () => {
    const { store, local } = localStore();
    try {
      store.createEntry({ id: ID, data: { name: 'Created offline' } });
      store.softDeleteEntry(ID, undefined, UID);
      const server = remote({ count: 1 });
      const result = await runSupabaseSync({ client: server.client, local, userId: UID });
      expect(result.status).toBe('healthy');
      expect(server.insert).toHaveBeenCalledOnce();
      expect(server.update).toHaveBeenCalledWith(expect.objectContaining({ deleted: true, deleted_by: UID }), { count: 'exact' });
      expect(store.listOutbox('all').every((item) => item.status === 'synced')).toBe(true);
    } finally { store.close(); }
  });

  it('acknowledges only the duplicate create before pushing a later update', async () => {
    const { store, local, synced } = localStore();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      store.createEntry({ id: ID, data: { name: 'Created' } });
      store.updateEntry(ID, { data: { name: 'Edited later' } });
      const server = remote({ duplicate: true, count: 1 });
      const result = await runSupabaseSync({ client: server.client, local, userId: UID });
      expect(result.status).toBe('healthy');
      expect(server.insert).toHaveBeenCalledOnce();
      expect(server.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Edited later' } }), { count: 'exact' });
      expect(server.eq).toHaveBeenCalledWith('id', ID);
      expect(synced).toHaveBeenCalledTimes(2);
      expect(store.listOutbox('all').every((item) => item.status === 'synced')).toBe(true);
    } finally { store.close(); }
  });

  it.each(['hidden', 'missing'] as const)('makes a zero-row update terminal when the approved RPC says %s', async (visibility) => {
    const { store, local, terminal } = localStore();
    try {
      addExistingEdit(store);
      const server = remote({ count: 0, visibility });
      const first = await runSupabaseSync({ client: server.client, local, userId: UID, isSessionAllowed: () => true });
      expect(first.status).toBe('error');
      expect(first.error).toContain(MESSAGE);
      expect(server.insert).not.toHaveBeenCalled();
      expect(server.update).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), { count: 'exact' });
      expect(server.rpc).toHaveBeenCalledWith('entry_visibility', { p_id: ID });
      expect(terminal).toHaveBeenCalledOnce();
      expect(store.listOutbox('all')[0]).toMatchObject({ status: 'terminal', lastError: MESSAGE, attempts: 1 });
      expect(store.getEntry(ID)?.data).toEqual({ name: 'Kept local edit' });
      const second = await runSupabaseSync({ client: server.client, local, userId: UID });
      expect(second.status).toBe('error');
      expect(second.error).toContain(MESSAGE);
      expect(server.update).toHaveBeenCalledOnce();
      expect(terminal).toHaveBeenCalledOnce();
      expect(store.getPendingOutboxCount()).toBe(1);
    } finally { store.close(); }
  });

  it('retries a zero-row update if the approved RPC says visible', async () => {
    const { store, local, terminal } = localStore();
    try {
      addExistingEdit(store);
      const server = remote({ count: 0, visibility: 'visible' });
      expect((await runSupabaseSync({ client: server.client, local })).status).toBe('error');
      expect(store.listOutbox('all')[0].status).toBe('failed');
      expect(terminal).not.toHaveBeenCalled();
      await runSupabaseSync({ client: server.client, local });
      expect(server.update).toHaveBeenCalledTimes(2);
      expect(store.getEntry(ID)?.data.name).toBe('Kept local edit');
    } finally { store.close(); }
  });

  it('does not mark anything terminal if clearance is pending before or during classification', async () => {
    const { store, local, terminal } = localStore();
    try {
      addExistingEdit(store);
      const server = remote({ count: 0, visibility: 'hidden' });
      const blocked = await runSupabaseSync({ client: server.client, local, isSessionAllowed: () => false });
      expect(blocked.status).toBe('error');
      expect(local.getSnapshot).not.toHaveBeenCalled();
      expect(server.update).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      let approved = true;
      const revokingServer = remote({ count: 0, visibility: 'hidden', onRpc: () => { approved = false; } });
      await runSupabaseSync({ client: revokingServer.client, local, isSessionAllowed: () => approved });
      expect(terminal).not.toHaveBeenCalled();
      expect(store.listOutbox('all')[0].status).not.toBe('terminal');
      expect(store.getEntry(ID)?.data.name).toBe('Kept local edit');
    } finally { store.close(); }
  });

  it('keeps approval/RPC failures retryable and refuses unconfirmed affected counts', async () => {
    const { store, local, terminal } = localStore();
    try {
      addExistingEdit(store);
      const denied = remote({ count: 0, rpcError: { message: 'An approved session is required', code: '42501' } });
      await runSupabaseSync({ client: denied.client, local });
      expect(store.listOutbox('all')[0].status).toBe('failed');
      expect(terminal).not.toHaveBeenCalled();
      const unconfirmed = remote({ count: null });
      const result = await runSupabaseSync({ client: unconfirmed.client, local });
      expect(result.error).toContain('did not confirm');
      expect(unconfirmed.rpc).not.toHaveBeenCalled();
      expect(store.listOutbox('all')[0].status).toBe('failed');
    } finally { store.close(); }
  });
});
