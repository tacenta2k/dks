import { describe, expect, it, vi } from 'vitest';

import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { SheetRepository } from '../src/features/sheet/repository';
import { createSyncingRepositoryProxy } from '../src/lib/sync-trigger';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal plain-object double; only the exercised method needs a body. */
function plainRepository(overrides: Partial<SheetRepository> = {}): SheetRepository {
  const unusable = async (): Promise<never> => {
    throw new Error('unused in this test');
  };
  return {
    setRole: () => undefined,
    getColumns: async () => [],
    getRows: async () => [],
    addColumn: unusable,
    updateColumn: unusable,
    softDeleteColumn: async () => null,
    createRow: unusable,
    updateRow: unusable,
    duplicateRow: unusable,
    softDeleteRow: unusable,
    markRenewed: unusable,
    getRenewalHistory: async () => [],
    ...overrides,
  };
}

describe('createSyncingRepositoryProxy (Blocker 3)', () => {
  it('does not trigger for read-only methods', async () => {
    const repository = createInMemorySheetRepository();
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(repository, onMutate);

    await proxy.getColumns();
    await proxy.getRows();
    await proxy.getAuditHistory?.();
    await proxy.getRenewalHistory();
    await flushMicrotasks();

    expect(onMutate).not.toHaveBeenCalled();
  });

  it('does not trigger for setRole (session state, not data)', async () => {
    const repository: SheetRepository = createInMemorySheetRepository();
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(repository, onMutate);

    proxy.setRole?.('admin');
    await flushMicrotasks();

    expect(onMutate).not.toHaveBeenCalled();
  });

  it('triggers exactly once when a mutation resolves', async () => {
    const repository = createInMemorySheetRepository();
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(repository, onMutate);

    const row = await proxy.createRow({ name: 'Local write' });
    expect(row.data.name).toBe('Local write');
    await flushMicrotasks();

    expect(onMutate).toHaveBeenCalledTimes(1);
  });

  it('triggers for column mutations as well', async () => {
    const repository = createInMemorySheetRepository();
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(repository, onMutate);

    const column = await proxy.addColumn({ name: 'Note', type: 'text' });
    await proxy.updateColumn(column.id, { name: 'Note (renamed)' });
    await flushMicrotasks();

    expect(onMutate).toHaveBeenCalledTimes(2);
  });

  it('does NOT trigger when a mutation rejects, and rethrows unchanged', async () => {
    const failing = plainRepository({
      createRow: vi.fn(async (): Promise<never> => {
        throw new Error('local write failed');
      }),
    });
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(failing, onMutate);

    await expect(proxy.createRow({ name: 'X' })).rejects.toThrow('local write failed');
    await flushMicrotasks();

    expect(onMutate).not.toHaveBeenCalled();
    expect(failing.createRow).toHaveBeenCalledTimes(1);
  });

  it('passes plain property access and missing props through untouched', async () => {
    // A plain object double (own-property methods) so property access is
    // observable; a class instance would hide its methods on the prototype.
    const double: SheetRepository & { marker?: string } = {
      setRole: () => undefined,
      getColumns: async () => [],
      getRows: async () => [],
      addColumn: async () => { throw new Error('unused'); },
      updateColumn: async () => { throw new Error('unused'); },
      softDeleteColumn: async () => null,
      createRow: async () => { throw new Error('unused'); },
      updateRow: async () => { throw new Error('unused'); },
      duplicateRow: async () => { throw new Error('unused'); },
      softDeleteRow: async () => { throw new Error('unused'); },
      markRenewed: async () => { throw new Error('unused'); },
      getRenewalHistory: async () => [],
    };
    double.marker = 'plain';
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(double, onMutate);

    expect(proxy.marker).toBe('plain');
    const rows = await proxy.getRows();
    expect(Array.isArray(rows)).toBe(true);
    expect((proxy as { missing?: unknown }).missing).toBeUndefined();
    await flushMicrotasks();

    expect(onMutate).not.toHaveBeenCalled();
  });

  it('does not mask rejection values for non-Error throws', async () => {
    const failing = plainRepository({
      updateRow: vi.fn(async (): Promise<never> => {
        throw 'string-rejection';
      }),
    });
    const onMutate = vi.fn();
    const proxy = createSyncingRepositoryProxy(failing, onMutate);

    await expect(proxy.updateRow('missing', { a: 1 })).rejects.toBe('string-rejection');
    await flushMicrotasks();

    expect(onMutate).not.toHaveBeenCalled();
  });
});
