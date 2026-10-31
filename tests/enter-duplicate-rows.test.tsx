// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { createLocalIpcHandlers, LOCAL_IPC_CHANNELS } from '../electron/main/local-ipc';
import { createSqliteStore } from '../electron/main/sqlite';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { ElectronSheetRepository } from '../src/features/sheet/electron-repository';
import {
  DraftCreateIdentityBox,
  isRepeatOrComposingKey,
} from '../src/features/sheet/grid-behaviour';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { DksLocalApi, DksWindowApi } from '../src/lib/types';
import { seedFixtureColumns } from './fixtures/sheet-columns';

/**
 * Bug 2 regression — pressing (or holding) Enter in the Name field created
 * several identical rows.
 *
 * The old stack had two holes: nothing ignored `event.repeat` / IME
 * composition on the Enter path, and the create carried no stable identity —
 * the renderer in-flight guard was the only dedupe, and any repeated commit
 * that arrived after it settled minted a fresh UUID + outbox create in the
 * main process. These tests pin every layer of the fix with synthetic data.
 *
 * SCOPE LIMIT (found the hard way): the "sheet draft flow" cases below use
 * the jsdom accessible-table surface, NOT the real AG Grid, so they cannot
 * see grid editor/handoff behaviour. The actual owner-visible failure was
 * a real-grid loop (focus handoff reopening an editor seeded with the
 * just-committed name); these tests stayed green while it was live. The
 * real-grid regression coverage is tests/enter-real-grid-duplicate.test.tsx.
 */
describe('Enter creates exactly one row (Bug 2) — key + identity helpers', () => {
  it('treats held-key repeats and IME composition as non-commits', () => {
    expect(isRepeatOrComposingKey({ repeat: true })).toBe(true);
    expect(isRepeatOrComposingKey({ isComposing: true })).toBe(true);
    expect(isRepeatOrComposingKey({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isRepeatOrComposingKey({ keyCode: 229 })).toBe(true);
    expect(isRepeatOrComposingKey({ nativeEvent: { keyCode: 229 } })).toBe(true);

    expect(isRepeatOrComposingKey({ repeat: false })).toBe(false);
    expect(isRepeatOrComposingKey({})).toBe(false);
    expect(isRepeatOrComposingKey(null)).toBe(false);
    expect(isRepeatOrComposingKey(undefined)).toBe(false);
  });

  it('reuses one draft identity for retries and rotates it only for a new draft edit', () => {
    let counter = 0;
    const box = new DraftCreateIdentityBox(() => `client-row-${++counter}`);

    const first = box.ensure();
    expect(first).toEqual({ id: 'client-row-1', idempotencyKey: 'entry:create:client-row-1' });
    // Retries of the same commit reuse the identity.
    expect(box.ensure()).toEqual(first);
    // A new edit session BEFORE a successful create does not rotate.
    box.prepareForNextDraftEdit();
    expect(box.ensure()).toEqual(first);

    box.markConsumed();
    // A replay after success (no new edit session) still dedupes.
    expect(box.ensure()).toEqual(first);
    // Starting to edit the fresh draft rotates to a fresh identity, so a
    // legitimate second record with the same name stays possible.
    box.prepareForNextDraftEdit();
    expect(box.ensure()).toEqual({
      id: 'client-row-2',
      idempotencyKey: 'entry:create:client-row-2',
    });
  });
});

describe('Enter creates exactly one row (Bug 2) — sheet draft flow', () => {
  function delayedCreateRepository() {
    const repository = createInMemorySheetRepository();
    const originalCreateRow = repository.createRow.bind(repository);
    let releaseFirstCreate: (() => void) | undefined;
    const createRow = vi.fn(async (
      data: Record<string, unknown> = {},
      category: string | null = null,
      options?: { id?: string; idempotencyKey?: string },
    ) => {
      if (createRow.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstCreate = resolve;
        });
      }
      return originalCreateRow(data, category, options);
    });
    repository.createRow = createRow;
    return {
      repository,
      createRow,
      release: () => releaseFirstCreate?.(),
    };
  }

  it('Enter once, Enter held (repeat events) and a focus-loss commit create one row', async () => {
    const { repository, createRow, release } = delayedCreateRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    const input = await screen.findByLabelText('New record Name');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Test Person' } });

    // One physical Enter…
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(createRow).toHaveBeenCalledTimes(1));

    // …then the key is HELD: auto-repeat Enters keep arriving, and a
    // focus-loss commit repeats the same draft value. None may create again.
    for (let held = 0; held < 5; held += 1) {
      fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    }
    fireEvent.change(input, { target: { value: 'Test Person' } });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    fireEvent.blur(input);
    expect(createRow).toHaveBeenCalledTimes(1);

    release();
    await waitFor(async () => expect(await repository.getRows()).toHaveLength(1));
    expect((await repository.getRows())[0].data.name).toBe('Test Person');

    // The one create carried the stable client identity used for dedupe
    // below the renderer.
    const [, , identity] = createRow.mock.calls[0];
    expect(identity?.id).toBeTruthy();
    expect(identity?.idempotencyKey).toBe(`entry:create:${identity?.id}`);
    expect((await repository.getRows())[0].id).toBe(identity?.id);
  }, 20_000);

  it('two rapid Enters create one row; a later intentional same-name entry creates a second', async () => {
    const { repository, createRow, release } = delayedCreateRepository();
    await seedFixtureColumns(repository);
    render(<SheetPage repository={repository} role="office" />);

    const input = await screen.findByLabelText('New record Name');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Rapid Entry' } });
    // Two distinct, rapid Enter presses (no repeat flag) + their blurs.
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Rapid Entry' } });
    fireEvent.blur(input);
    await waitFor(() => expect(createRow).toHaveBeenCalledTimes(1));

    release();
    await waitFor(async () => expect(await repository.getRows()).toHaveLength(1));

    // After the first record settles, deliberately typing the same name in
    // the fresh draft is a new record (fresh identity), not a retry.
    const nextInput = screen.getByLabelText('New record Name');
    fireEvent.focus(nextInput);
    fireEvent.change(nextInput, { target: { value: 'Rapid Entry' } });
    fireEvent.keyDown(nextInput, { key: 'Enter' });
    fireEvent.blur(nextInput);

    await waitFor(async () => expect(await repository.getRows()).toHaveLength(2));
    expect(createRow).toHaveBeenCalledTimes(2);
    const firstIdentity = createRow.mock.calls[0][2];
    const secondIdentity = createRow.mock.calls[1][2];
    expect(secondIdentity?.id).toBeTruthy();
    expect(secondIdentity?.id).not.toBe(firstIdentity?.id);
  }, 20_000);
});

describe('Enter creates exactly one row (Bug 2) — repository and store idempotency', () => {
  it('InMemory repository: a retried create with the same identity returns the same row', async () => {
    const repository = createInMemorySheetRepository();
    const identity = { id: 'client-row-1', idempotencyKey: 'entry:create:client-row-1' };

    const first = await repository.createRow({ name: 'Synthetic Row' }, null, identity);
    const retry = await repository.createRow({ name: 'Synthetic Row' }, null, identity);
    const lateRetry = await repository.createRow({ name: 'Synthetic Row' }, null, identity);

    expect(first.id).toBe('client-row-1');
    expect(retry.id).toBe(first.id);
    expect(lateRetry.id).toBe(first.id);
    expect(await repository.getRows()).toHaveLength(1);
    const audit = await repository.getAuditHistory?.();
    expect(audit?.filter((entry) => entry.action === 'create')).toHaveLength(1);

    // Without an identity, two identical creates stay two legitimate rows.
    await repository.createRow({ name: 'Synthetic Row' });
    await repository.createRow({ name: 'Synthetic Row' });
    expect(await repository.getRows()).toHaveLength(3);
  });

  it('Electron repository forwards the stable identity to the local bridge', async () => {
    const local: DksLocalApi = {
      getSnapshot: vi.fn(async () => ({
        rows: [],
        deletedRows: [],
        columns: [],
        syncStatus: { status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0 },
      })),
      createRow: vi.fn(async (input) => ({
        id: input.id ?? 'store-minted',
        data: input.data,
        category: 'Employee',
        deleted: false,
      })),
      updateRow: vi.fn(async () => null),
      duplicateRow: vi.fn(async () => null),
      softDeleteRow: vi.fn(async () => null),
      restoreRow: vi.fn(async () => null),
      permanentDeleteRow: vi.fn(async () => null),
      addColumn: vi.fn(async () => ({ id: 'c', name: 'C', type: 'text' })),
      updateColumn: vi.fn(async () => null),
      deleteColumn: vi.fn(async () => null),
      importRecords: vi.fn(async () => []),
      listAudit: vi.fn(async () => []),
      listNotifications: vi.fn(async () => []),
      setSyncStatus: vi.fn(async () => ({
        status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0,
      })),
      flushSync: vi.fn(async () => ({
        status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0,
      })),
      close: vi.fn(async () => ({ closed: true, flushed: true })),
    };
    const windowApi: DksWindowApi = {
      platform: 'test',
      appVersion: '0',
      local,
      minimizeToTray: () => undefined,
      quit: () => undefined,
    };
    const repository = new ElectronSheetRepository({ windowApi, role: 'office' });

    const created = await repository.createRow(
      { name: 'Bridge Row' },
      null,
      { id: 'client-row-9', idempotencyKey: 'entry:create:client-row-9' },
    );
    expect(created.id).toBe('client-row-9');
    expect(local.createRow).toHaveBeenCalledWith({
      data: { name: 'Bridge Row' },
      category: null,
      id: 'client-row-9',
      idempotencyKey: 'entry:create:client-row-9',
    });
  });

  it('SQLite store + IPC: three identical creates make one row, one outbox create, one audit', async () => {
    const store = createSqliteStore({
      filename: ':memory:',
      now: () => '2026-03-08T12:00:00.000Z',
    });
    try {
      const handlers = createLocalIpcHandlers({ store });
      const payload = {
        id: 'draft-row-0001',
        data: { name: 'Queued Person' },
        idempotencyKey: 'entry:create:draft-row-0001',
      };
      // Enter once, then the same create lands twice more (the exact retry
      // storms the old code turned into duplicate rows).
      await handlers[LOCAL_IPC_CHANNELS.createRow](payload);
      await handlers[LOCAL_IPC_CHANNELS.createRow](payload);
      await handlers[LOCAL_IPC_CHANNELS.createRow](payload);

      expect(store.listEntries(true)).toHaveLength(1);
      expect(store.getEntry('draft-row-0001')?.data).toEqual({ name: 'Queued Person' });
      const creates = store.listOutbox('all')
        .filter((item) => item.operation === 'create' && item.entityId === 'draft-row-0001');
      expect(creates).toHaveLength(1);
      expect(creates[0].idempotencyKey).toBe('entry:create:draft-row-0001');
      expect(store.listOutbox('all')).toHaveLength(1);
      expect(store.listAudit().filter((entry) => entry.action === 'create')).toHaveLength(1);

      // A retry carrying a corrected value updates the same row — still no
      // second row and no second outbox item for the entity.
      await handlers[LOCAL_IPC_CHANNELS.createRow]({
        ...payload,
        data: { name: 'Queued Person Corrected' },
      });
      expect(store.listEntries(true)).toHaveLength(1);
      expect(store.getEntry('draft-row-0001')?.data).toEqual({ name: 'Queued Person Corrected' });
      expect(store.listOutbox('all').filter((item) => item.entityId === 'draft-row-0001'))
        .toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('SQLite store: an idempotency-key-only retry also resolves to the original row', () => {
    const store = createSqliteStore({
      filename: ':memory:',
      now: () => '2026-03-08T12:00:00.000Z',
    });
    try {
      const first = store.createEntry({
        data: { name: 'Key Only' },
        idempotencyKey: 'entry:create:key-only-1',
      });
      const retry = store.createEntry({
        data: { name: 'Key Only' },
        idempotencyKey: 'entry:create:key-only-1',
      });
      expect(retry.id).toBe(first.id);
      expect(store.listEntries(true)).toHaveLength(1);
      expect(store.listOutbox('all')).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
