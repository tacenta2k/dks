import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FINAL POLISH — system "Days Left" column guards (main-process store).
 *
 * The user reported a duplicate "Days Left" column that could never be
 * deleted: protection matched the column NAME and a stale `is_primary_expiry`
 * mark echoed the misleading "primary expiry column cannot be deleted"
 * error. The contract locked here:
 *
 *   1. protection is strictly `col.id === 'daysLeft'` — never the name;
 *   2. only a LIVE date_expiry primary blocks deletion;
 *   3. stale primary marks (non-expiry or deleted columns, or a mark with no
 *      live expiry column at all) are auto-healed at startup and before any
 *      delete check, so an admin can always clean up bogus rows with zero
 *      false blocks.
 */

interface ColumnInputLike {
  id: string;
  name: string;
  type: string;
  isPrimaryExpiry?: boolean;
  is_primary_expiry?: boolean;
  position?: number;
  deleted?: boolean;
}

async function openStore(filename = ':memory:') {
  const { createSqliteStore } = await import('../electron/main/sqlite');
  return createSqliteStore({ filename });
}

function legacyDaysLeft(): ColumnInputLike {
  return {
    id: 'days_left',
    name: 'Days Left',
    type: 'text',
    // exactly the broken persisted state the user reported
    isPrimaryExpiry: true,
    is_primary_expiry: true,
  };
}

describe('SqliteStore system column guards', () => {
  it('refuses deletes only for the id-exact generated column', async () => {
    const store = await openStore();
    try {
      // The generated system column itself stays locked for every role.
      store.upsertColumn({ id: 'daysLeft', name: 'Days Left', type: 'number' } as never);
      expect(store.canDeleteColumn('daysLeft', 'admin')).toBe(false);
      expect(store.canDeleteColumn('daysLeft', 'office')).toBe(false);
      expect(store.deleteColumn('daysLeft', 'admin')).toBeNull();
    } finally {
      store.close();
    }
    // A look-alike user column (same name, different id) is NOT the system
    // column — the driver of the user's duplicate-delete bug.
    const lookAlike = await openStore();
    try {
      lookAlike.upsertColumn(legacyDaysLeft() as never);
      expect(lookAlike.canDeleteColumn('days_left', 'admin')).toBe(true);
    } finally {
      lookAlike.close();
    }
  });

  it('heals the stale primary mark on upsert and lets admin delete the bogus row', async () => {
    const store = await openStore();
    try {
      store.upsertColumn(legacyDaysLeft() as never);
      // Healing stripped the junk primary mark immediately: this TEXT column
      // can never present as "the primary expiry column".
      const healed = store.getColumn('days_left');
      expect(healed?.isPrimaryExpiry).toBe(false);

      // Admin deletes it even with values stored under both keys.
      const entry = store.upsertEntry({ id: 'row-1', data: { days_left: '7', 'Days Left': '7' } } as never);
      expect(entry).toBeTruthy();
      expect(store.canDeleteColumn('days_left', 'admin')).toBe(true);
      const deleted = store.deleteColumn('days_left', 'admin');
      expect(deleted?.deleted).toBe(true);
    } finally {
      store.close();
    }
  });

  it('lets office delete the legacy-named column only while it is empty', async () => {
    const store = await openStore();
    try {
      store.upsertColumn(legacyDaysLeft() as never);
      expect(store.canDeleteColumn('days_left', 'office')).toBe(true);
      store.upsertEntry({ id: 'row-1', data: { days_left: '7' } } as never);
      expect(store.canDeleteColumn('days_left', 'office')).toBe(false);
      // …and office is still pointed at an admin, never at a fake "primary".
      expect(store.deleteColumn('days_left', 'office')).toBeNull();
      expect(store.canDeleteColumn('days_left', 'admin')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('startup self-heal clears stale marks left by older builds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dks-guard-'));
    const file = join(dir, 'store.sqlite');
    try {
      // Seed the broken pre-image directly (bypassing the store's guard):
      // a TEXT "Days Left" column with the primary mark and NO expiry column
      // at all — the exact state that echoed the wrong error for the user.
      const seeded = await openStore(file);
      try {
        const db = (seeded as unknown as { database: import('better-sqlite3').Database }).database;
        db.exec(`
          INSERT INTO columns (id, name, type, options, position, visible, is_primary_expiry, is_passport, deleted, deleted_at, created_at, updated_at)
          VALUES ('days_left', 'Days Left', 'text', '{}', 0, 1, 1, 0, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        `);
      } finally {
        seeded.close();
      }

      // Re-opening the store heals the mark at startup…
      const store = await openStore(file);
      try {
        expect(store.getColumn('days_left')?.isPrimaryExpiry).toBe(false);
        // …and the admin can delete the bogus row without ever seeing the
        // misleading "primary expiry" block.
        expect(store.canDeleteColumn('days_left', 'admin')).toBe(true);
        expect(store.deleteColumn('days_left', 'admin')?.deleted).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps exactly one live date_expiry primary — heals to the first when ambiguous', async () => {
    const store = await openStore();
    try {
      store.upsertColumn({ id: 'expiry-a', name: 'Expiry A', type: 'date_expiry', position: 0, isPrimaryExpiry: true } as never);
      store.upsertColumn({ id: 'expiry-b', name: 'Expiry B', type: 'date_expiry', position: 1, isPrimaryExpiry: true } as never);
      const primaries = store.listColumns().filter((column) => column.isPrimaryExpiry);
      expect(primaries).toHaveLength(1);
      expect(primaries[0].id).toBe('expiry-a');

      // The live primary STILL cannot be deleted until another expiry takes over.
      expect(store.canDeleteColumn('expiry-a', 'admin')).toBe(false);
      expect(store.canDeleteColumn('expiry-b', 'admin')).toBe(true);
    } finally {
      store.close();
    }
  });
});
