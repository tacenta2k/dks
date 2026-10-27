// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createLocalIpcHandlers,
  LOCAL_IPC_CHANNELS,
  registerLocalSessionClearanceChannel,
  type LocalIpcDependencies,
  type LocalSessionClearanceApi,
  createLocalSessionClearance,
} from '../electron/main/local-ipc';
import {
  createSqliteStore,
  filterRowsForOfficeScope,
  isWithinOfficeWindow,
  muscatDateOf,
  officeWindowCutoffDate,
  SqliteStore,
} from '../electron/main/sqlite';

// Office 3-day visibility window (owner decision): local layer. The Muscat
// boundary is exercised with fixed instants: Asia/Muscat is UTC+4 with no DST,
// so 2026-03-04T19:59Z is 2026-03-04 23:59 Muscat and 2026-03-04T20:01Z is
// 2026-03-05 00:01 Muscat — two minutes apart, different window days.

const DAY = 86_400_000;

function storeWithClock(isoNow: string): SqliteStore {
  return createSqliteStore({ filename: ':memory:', now: () => isoNow });
}

function handlersFor(
  store: SqliteStore,
  options: { now?: () => string; sessionRole?: () => 'admin' | 'office' | null } = {},
): ReturnType<typeof createLocalIpcHandlers> {
  const dependencies: LocalIpcDependencies = {
    store,
    now: options.now,
    sessionRole: options.sessionRole,
  };
  return createLocalIpcHandlers(dependencies);
}

describe('office window — date helpers', () => {
  it('computes Muscat dates and the inclusive cutoff (today − 3)', () => {
    expect(muscatDateOf('2026-03-04T19:59:00Z')).toBe('2026-03-04'); // 23:59 Muscat
    expect(muscatDateOf('2026-03-04T20:01:00Z')).toBe('2026-03-05'); // 00:01 Muscat
    expect(officeWindowCutoffDate('2026-03-08')).toBe('2026-03-05');
  });

  it('splits the 23:59 / 00:01 boundary pair across the window cutoff', () => {
    const at = '2026-03-08T12:00:00Z'; // Muscat 2026-03-08 → cutoff 2026-03-05
    expect(isWithinOfficeWindow('2026-03-04T19:59:00Z', at)).toBe(false); // 03-04 23:59
    expect(isWithinOfficeWindow('2026-03-04T20:01:00Z', at)).toBe(true);  // 03-05 00:01
    expect(isWithinOfficeWindow('2026-03-05T20:01:00Z', at)).toBe(true);  // 03-06 00:01
    expect(isWithinOfficeWindow(null, at)).toBe(false);
    expect(isWithinOfficeWindow('not-a-date', at)).toBe(false);
  });

  it('filters rows by visibility with the unsynced-work exemption', () => {
    const at = '2026-03-08T12:00:00Z';
    const rows = [
      { id: 'in-window', deleted: false, created_at: '2026-03-06T00:00:00Z' },
      { id: 'out-of-window', deleted: false, created_at: '2026-03-01T00:00:00Z' },
      { id: 'out-of-window-pending', deleted: false, created_at: '2026-03-01T00:00:00Z' },
      { id: 'deleted-in-window', deleted: true, created_at: '2026-03-06T00:00:00Z' },
      { id: 'deleted-pending', deleted: true, created_at: '2026-03-01T00:00:00Z' },
    ];
    const visible = filterRowsForOfficeScope(rows, new Set(['out-of-window-pending', 'deleted-pending']), at);
    expect(visible.map((row) => row.id)).toEqual(['in-window', 'out-of-window-pending', 'deleted-pending']);
  });
});

describe('office window — local visibility purge', () => {
  it('removes out-of-window rows, keeps unsynced rows, and writes no outbox/audit', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    // Remote-cached rows (already synced): old ones must leave the cache.
    store.applyRemoteEntry({ id: 'old', data: { n: 1 }, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    store.applyRemoteEntry({ id: 'old-deleted', data: { n: 2 }, deleted: true, deleted_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    store.applyRemoteEntry({ id: 'recent', data: { n: 3 }, created_at: '2026-03-06T00:00:00Z', updated_at: '2026-03-06T00:00:00Z' });
    // Locally created, still unsynced (create outbox pending) — never purged.
    store.createEntry({ id: 'unsynced-create', data: { n: 4 }, updatedAt: '2026-03-01T00:00:00Z' });
    // Old row with a pending edit — kept until the edit is pushed/terminal.
    store.applyRemoteEntry({ id: 'unsynced-edit', data: { n: 5 }, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    store.updateEntry('unsynced-edit', { data: { n: 55 }, updatedAt: '2026-03-08T12:00:00Z' });
    // Old row whose change is terminal (never pushed) — the sync fix retains
    // the local row; the purge must not silently drop it either.
    store.applyRemoteEntry({ id: 'terminal', data: { n: 6 }, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    store.updateEntry('terminal', { data: { n: 66 }, updatedAt: '2026-03-08T12:00:00Z' });
    const terminalItem = store.listOutbox('all').find((item) => item.entityId === 'terminal');
    store.markOutboxTerminal(terminalItem!.id, 'This record can no longer be changed from the Office account');

    const outboxBefore = store.listOutbox('all').length;
    const auditBefore = store.listAudit().length;

    expect(store.purgeOutOfWindowOfficeEntries()).toBe(2); // old + old-deleted

    expect(store.listEntries(true).map((row) => row.id).sort()).toEqual(
      ['recent', 'terminal', 'unsynced-create', 'unsynced-edit'],
    );
    // VISIBILITY PURGE: no outbox item, no audit 'delete', no server effect.
    expect(store.listOutbox('all')).toHaveLength(outboxBefore);
    expect(store.listAudit()).toHaveLength(auditBefore);
    expect(store.listAudit().some((record) => record.action === 'permanent_delete')).toBe(false);
  });

  it('runs at launch and then once per Muscat date change', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    // Exactly on the cutoff date: visible today, gone tomorrow.
    store.applyRemoteEntry({ id: 'edge', data: {}, created_at: '2026-03-05T12:00:00Z', updated_at: '2026-03-05T12:00:00Z' });
    store.applyRemoteEntry({ id: 'fresh', data: {}, created_at: '2026-03-08T05:00:00Z', updated_at: '2026-03-08T05:00:00Z' });

    // First call of the process run ("at launch") always purges.
    expect(store.purgeOutOfWindowOfficeEntries({ onlyIfDateChanged: true })).toBe(0);
    // Same Muscat date: the date guard makes it a no-op.
    expect(store.purgeOutOfWindowOfficeEntries({ onlyIfDateChanged: true })).toBe(0);
    expect(store.listEntries(true)).toHaveLength(2);

    // Muscat midnight passes: 'edge' (2026-03-05) is now outside today-3 = 03-06.
    const tomorrow = new Date(Date.parse(now) + DAY).toISOString();
    expect(store.purgeOutOfWindowOfficeEntries({ onlyIfDateChanged: true, at: tomorrow })).toBe(1);
    expect(store.listEntries(true).map((row) => row.id)).toEqual(['fresh']);
  });

  it('never touches rows without being called (Admin caches are safe)', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    store.applyRemoteEntry({ id: 'old', data: {}, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    const handlers = handlersFor(store, { now: () => now, sessionRole: () => 'admin' });
    const snapshot = handlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'admin' }) as { rows: unknown[] };
    expect(snapshot.rows).toHaveLength(1);
    expect(store.listEntries(true)).toHaveLength(1);
  });
});

describe('office window — scoped local reads', () => {
  const seed = (store: SqliteStore): void => {
    store.applyRemoteEntry({ id: 'in-window', data: { n: 1 }, created_at: '2026-03-06T00:00:00Z', updated_at: '2026-03-06T00:00:00Z' });
    store.applyRemoteEntry({ id: 'out-of-window', data: { n: 2 }, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    store.applyRemoteEntry({ id: 'deleted-old', data: { n: 3 }, deleted: true, deleted_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    // Unsynced local edit on an old row: readable until pushed.
    store.createEntry({ id: 'pending-old', data: { n: 4 }, updatedAt: '2026-03-01T00:00:00Z' });
  };

  it('filters Office reads to the window except unsynced work', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    seed(store);
    const handlers = handlersFor(store, { now: () => now });

    const snapshot = handlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'office' }) as {
      rows: { id: string }[];
      deletedRows: { id: string }[];
    };
    expect(snapshot.rows.map((row) => row.id).sort()).toEqual(['in-window', 'pending-old']);
    expect(snapshot.deletedRows).toEqual([]);
  });

  it('keeps Admin reads unfiltered (payload role and session role)', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    seed(store);
    const handlers = handlersFor(store, { now: () => now, sessionRole: () => 'admin' });

    const viaPayload = handlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'admin' }) as {
      rows: { id: string }[];
      deletedRows: { id: string }[];
    };
    expect(viaPayload.rows.map((row) => row.id).sort())
      .toEqual(['in-window', 'out-of-window', 'pending-old']);
    expect(viaPayload.deletedRows.map((row) => row.id)).toEqual(['deleted-old']);
    // The session-clearance role applies when the call carries none.
    const viaSession = handlers[LOCAL_IPC_CHANNELS.getSnapshot](undefined) as { rows: { id: string }[] };
    expect(viaSession.rows).toHaveLength(3);
  });

  it('scopes reads through the existing session-clearance role mechanism', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    seed(store);
    const handlers = handlersFor(store, { now: () => now, sessionRole: () => 'office' });

    const snapshot = handlers[LOCAL_IPC_CHANNELS.getSnapshot](undefined) as { rows: { id: string }[] };
    expect(snapshot.rows.map((row) => row.id).sort()).toEqual(['in-window', 'pending-old']);
  });

  it('denies an invalid role and keeps legacy unfiltered reads when no role is reported', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    seed(store);
    const handlers = handlersFor(store, { now: () => now });

    expect(() => handlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'root' }))
      .toThrow('role must be admin or office');
    // No new trust: an unreported role keeps today's behaviour (unfiltered)
    // and never authorises the purge — the purge is Office-scope only.
    const legacy = handlers[LOCAL_IPC_CHANNELS.getSnapshot](undefined) as {
      rows: { id: string }[];
      deletedRows: { id: string }[];
    };
    expect(legacy.rows).toHaveLength(3);
    expect(legacy.deletedRows).toHaveLength(1);
  });

  it('purges when an Office snapshot is applied, keeping unsynced rows', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    seed(store);
    const handlers = handlersFor(store, { now: () => now });
    const outboxBefore = store.listOutbox('all').length;
    const auditBefore = store.listAudit().length;

    const after = handlers[LOCAL_IPC_CHANNELS.applyRemoteSnapshot]({
      role: 'office',
      rows: [{ id: 'remote-new', data: { n: 9 }, created_at: '2026-03-08T02:00:00Z', updated_at: '2026-03-08T02:00:00Z' }],
      columns: [],
    }) as { rows: { id: string }[] };

    // old cached rows left the cache; the applied remote row and the row with
    // unsynced work remain; nothing was queued or audited by the purge.
    expect(store.listEntries(true).map((row) => row.id).sort())
      .toEqual(['in-window', 'pending-old', 'remote-new']);
    expect(after.rows.map((row) => row.id).sort()).toEqual(['in-window', 'pending-old', 'remote-new']);
    expect(store.listOutbox('all')).toHaveLength(outboxBefore);
    expect(store.listAudit()).toHaveLength(auditBefore);
  });

  it('does not purge for Admin snapshot applications', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    seed(store);
    const handlers = handlersFor(store, { now: () => now });

    handlers[LOCAL_IPC_CHANNELS.applyRemoteSnapshot]({
      role: 'admin',
      rows: [],
      columns: [],
    });
    expect(store.listEntries(true)).toHaveLength(4);
  });

  it('purges at launch and across the Muscat date change through Office reads', () => {
    const now = '2026-03-08T12:00:00Z';
    const store = storeWithClock(now);
    store.applyRemoteEntry({ id: 'edge', data: {}, created_at: '2026-03-05T12:00:00Z', updated_at: '2026-03-05T12:00:00Z' });
    const handlers = handlersFor(store, { now: () => now });

    // First Office read ("launch") purges nothing — 'edge' is exactly on the
    // cutoff (visible) — but it did run the purge.
    handlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'office' });
    expect(store.listEntries(true)).toHaveLength(1);

    // After Muscat midnight the same read purges 'edge'.
    const tomorrow = new Date(Date.parse(now) + DAY).toISOString();
    const laterHandlers = handlersFor(store, { now: () => tomorrow });
    laterHandlers[LOCAL_IPC_CHANNELS.getSnapshot]({ role: 'office' });
    expect(store.listEntries(true)).toHaveLength(0);
  });
});

describe('office window — clearance channel carries the session role', () => {
  it('accepts the legacy string payload and the { state, role } form', () => {
    const clearance: LocalSessionClearanceApi = createLocalSessionClearance('allowed');
    const registered = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, payload?: unknown) => unknown) => {
        registered.set(channel, listener as (event: unknown, payload: unknown) => unknown);
      },
      removeHandler: (channel: string) => registered.delete(channel),
    };
    const unregister = registerLocalSessionClearanceChannel(ipcMain, clearance);
    const push = registered.get('dks:local:set-session-clearance')!;

    expect(push(undefined, 'office-pending')).toBe('office-pending');
    expect(clearance.getRole()).toBeNull();

    expect(push(undefined, { state: 'allowed', role: 'office' })).toBe('allowed');
    expect(clearance.get()).toBe('allowed');
    expect(clearance.getRole()).toBe('office');

    expect(push(undefined, { state: 'allowed', role: 'admin' })).toBe('allowed');
    expect(clearance.getRole()).toBe('admin');

    expect(push(undefined, { state: 'allowed', role: null })).toBe('allowed');
    expect(clearance.getRole()).toBeNull();

    expect(() => push(undefined, { state: 'allowed', role: 'root' })).toThrow('role must be admin or office');
    unregister();
  });
});
