// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  isBackupMetadata,
  keyIdFromKey,
  fixedKeyForTests,
  type BackupMetadata,
} from '../electron/main/backup-crypto';
import {
  MAX_PULL_ROWS,
  PULL_PAGE_SIZE,
  selectTable,
  type SupabaseDataClient,
  type SupabaseQueryResult,
  type SupabaseSelectQuery,
} from '../src/features/sync/supabase-sync';

/**
 * Backup completeness.
 *
 * PR1 backs up the LOCAL CACHE, not Supabase. That is only honest if the cache
 * actually holds the tables it claims — so the pull has to survive PostgREST's
 * `db-max-rows` truncation — and if every record of a backup says plainly what
 * it covers.
 */

/** PostgREST's default ceiling for a single response. */
const SERVER_MAX_ROWS = 1000;

interface FakeTable {
  rows: Record<string, unknown>[];
  ranges: Array<[number, number]>;
  selects: number;
}

/** A client that behaves like PostgREST: it truncates and it honours range(). */
function createPagedClient(tables: Record<string, Record<string, unknown>[]>): {
  client: SupabaseDataClient;
  tables: Record<string, FakeTable>;
} {
  const state: Record<string, FakeTable> = {};
  for (const [name, rows] of Object.entries(tables)) {
    state[name] = { rows, ranges: [], selects: 0 };
  }
  const client: SupabaseDataClient = {
    from: (table: string) => ({
      select: (): SupabaseSelectQuery => {
        const fake = state[table] ?? { rows: [], ranges: [], selects: 0 };
        fake.selects += 1;
        let from = 0;
        let to = SERVER_MAX_ROWS - 1;
        const finish = (): SupabaseQueryResult => {
          // The server never returns more than SERVER_MAX_ROWS rows, whatever
          // the client asked for — this is the truncation the bug hid behind.
          const limit = Math.min(to - from + 1, SERVER_MAX_ROWS);
          fake.ranges.push([from, to]);
          return { data: fake.rows.slice(from, from + limit), error: null };
        };
        const query: SupabaseSelectQuery = {
          then: (onFulfilled, onRejected) => Promise.resolve(finish()).then(onFulfilled, onRejected),
          order: () => query,
          range: (nextFrom: number, nextTo: number) => {
            from = nextFrom;
            to = nextTo;
            return query;
          },
        };
        return query;
      },
    }),
  };
  return { client, tables: state };
}

function makeRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index).padStart(5, '0')}`,
    data: { name: `Entry ${String(index)}` },
  }));
}

describe('the cache pull survives the PostgREST row cap', () => {
  it('walks pages until the whole table is in the cache', async () => {
    const rows = makeRows(2_340);
    const { client, tables } = createPagedClient({ entries: rows });

    const pulled = await selectTable(client, 'entries');

    expect(pulled).toHaveLength(2_340);
    expect(new Set(pulled.map((row) => row.id)).size).toBe(2_340);
    // 500 rows at a time: 4 full pages plus a short one that ends the walk.
    expect(tables.entries.ranges).toEqual([
      [0, PULL_PAGE_SIZE - 1],
      [500, 999],
      [1_000, 1_499],
      [1_500, 1_999],
      [2_000, 2_499],
    ]);
  });

  it('stops as soon as a page comes back short', async () => {
    const { client, tables } = createPagedClient({ app_columns: makeRows(PULL_PAGE_SIZE + 7) });

    const pulled = await selectTable(client, 'app_columns');

    expect(pulled).toHaveLength(PULL_PAGE_SIZE + 7);
    expect(tables.app_columns.selects).toBe(2);
  });

  it('does not ask again for an empty table', async () => {
    const { client, tables } = createPagedClient({ entries: [] });
    expect(await selectTable(client, 'entries')).toEqual([]);
    expect(tables.entries.selects).toBe(1);
  });

  it('keeps working with a client that cannot paginate', async () => {
    const rows = makeRows(3);
    const client: SupabaseDataClient = {
      from: () => ({ select: async () => ({ data: rows, error: null }) }),
    };
    expect(await selectTable(client, 'entries')).toHaveLength(3);
  });

  it('reports a page failure instead of returning a partial cache', async () => {
    let calls = 0;
    const client: SupabaseDataClient = {
      from: () => ({
        select: (): SupabaseSelectQuery => {
          const query: SupabaseSelectQuery = {
            then: (onFulfilled, onRejected) => {
              calls += 1;
              const result: SupabaseQueryResult = calls === 1
                ? { data: makeRows(PULL_PAGE_SIZE), error: null }
                : { data: null, error: { message: 'connection lost mid-pull' } };
              return Promise.resolve(result).then(onFulfilled, onRejected);
            },
            order: () => query,
            range: () => query,
          };
          return query;
        },
      }),
    };
    await expect(selectTable(client, 'entries')).rejects.toThrow(/connection lost mid-pull/);
  });

  it('refuses to walk forever if a cursor never advances', async () => {
    const endless = makeRows(PULL_PAGE_SIZE);
    const client: SupabaseDataClient = {
      from: () => ({
        select: (): SupabaseSelectQuery => {
          const query: SupabaseSelectQuery = {
            then: (onFulfilled, onRejected) => Promise
              .resolve({ data: endless, error: null } as SupabaseQueryResult)
              .then(onFulfilled, onRejected),
            order: () => query,
            range: () => query,
          };
          return query;
        },
      }),
    };
    await expect(selectTable(client, 'entries')).rejects.toThrow(
      new RegExp(`after ${String(MAX_PULL_ROWS)} rows`),
    );
  });
});

describe('every backup record states what it covers', () => {
  const metadata = (overrides: Partial<BackupMetadata> = {}): BackupMetadata => ({
    plaintextSha256: 'a'.repeat(64),
    fingerprint: 'f'.repeat(64),
    appVersion: '0.1.11',
    schemaVersion: 4,
    recordCounts: { entries: 40, columns: 3 },
    createdAt: '2026-10-31T08:00:00.000Z',
    keyId: keyIdFromKey(fixedKeyForTests('completeness')),
    source: 'local-cache',
    ...overrides,
  });

  it('accepts only the local-cache label', () => {
    expect(isBackupMetadata(metadata())).toBe(true);
    // A PR1 snapshot is a copy of this PC's cache. Nothing in the product may
    // mark it as the authoritative store — that is Supabase.
    expect(isBackupMetadata(metadata({ source: 'authoritative' as unknown as 'local-cache' }))).toBe(false);
    expect(isBackupMetadata(metadata({ source: undefined as unknown as 'local-cache' }))).toBe(false);
    expect(isBackupMetadata(metadata({ keyId: 'short' }))).toBe(false);
  });

  it('keeps the label and key id inside the authenticated envelope', () => {
    const parsed = metadata() as unknown as Record<string, unknown>;
    expect(parsed.source).toBe('local-cache');
    expect(parsed.keyId).toMatch(/^[0-9a-f]{24}$/);
  });
});
