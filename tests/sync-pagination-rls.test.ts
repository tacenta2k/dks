// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MAX_PULL_ROWS,
  PULL_PAGE_SIZE,
  pullTable,
  runSupabaseSync,
  selectTable,
  type SupabaseDataClient,
  type SupabaseQueryResult,
  type SupabaseSelectQuery,
  type SupabaseSyncLocal,
} from '../src/features/sync/supabase-sync';
import type { DksLocalSnapshot } from '../src/lib/types';

/**
 * The `selectTable()` pagination change affects **every** DKS sync, not only
 * backups — so it has to be proven safe under RLS for both roles before it can
 * stay in the cloud-backup PR.
 *
 * The double below models PostgREST exactly on the two properties that matter:
 *   1. a single response is truncated at `db-max-rows` (1000 by default), and
 *   2. `range()` narrows the response but never widens what RLS allows — the
 *      policy is applied BEFORE paging, so no page can reveal a row the caller
 *      may not see.
 */

const SERVER_MAX_ROWS = 1000;

type Role = 'admin' | 'office';

interface PagedTable {
  /** Every row that exists server-side. */
  rows: Record<string, unknown>[];
  /** Rows this role's RLS policy allows, in `id` order. */
  visible: (role: Role) => Record<string, unknown>[];
  /** `range()` windows requested, in order. */
  ranges: Array<[number, number]>;
  /** `order()` columns requested. */
  orders: string[];
  /** Fail the Nth request (1-based) to model a dropped connection mid-pull. */
  failOnRequest?: number;
  requests: number;
}

function createPagedClient(
  tables: Record<string, { rows: Record<string, unknown>[]; visible: (role: Role) => Record<string, unknown>[] }>,
  role: Role,
  options: { failOnRequest?: number } = {},
): { client: SupabaseDataClient; tables: Record<string, PagedTable> } {
  const state: Record<string, PagedTable> = {};
  for (const [name, table] of Object.entries(tables)) {
    state[name] = {
      rows: table.rows,
      visible: table.visible,
      ranges: [],
      orders: [],
      requests: 0,
      ...(options.failOnRequest === undefined ? {} : { failOnRequest: options.failOnRequest }),
    };
  }

  const client: SupabaseDataClient = {
    from: (table: string) => ({
      select: (): SupabaseSelectQuery => {
        const fake = state[table] ?? {
          rows: [], visible: () => [], ranges: [], orders: [], requests: 0,
        };
        let from = 0;
        let to = SERVER_MAX_ROWS - 1;
        const finish = (): SupabaseQueryResult => {
          fake.requests += 1;
          if (fake.failOnRequest !== undefined && fake.requests === fake.failOnRequest) {
            return { data: null, error: { message: 'connection lost mid-pull' } };
          }
          // RLS first, then paging: a range can only ever narrow what the policy
          // already allows.
          const allowed = fake.visible(role);
          const limit = Math.min(to - from + 1, SERVER_MAX_ROWS);
          fake.ranges.push([from, to]);
          return { data: allowed.slice(from, from + limit), error: null };
        };
        const query: SupabaseSelectQuery = {
          then: (onFulfilled, onRejected) => Promise.resolve(finish()).then(onFulfilled, onRejected),
          order: (column: string) => {
            fake.orders.push(column);
            return query;
          },
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

function entryRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    data: { name: `Entry ${String(index)}` },
    created_at: '2026-10-30T06:00:00.000Z',
    updated_at: '2026-10-30T06:00:00.000Z',
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Re-stamp `created_at`, keeping the row shape wide enough for the policy. */
function withCreatedAt(rows: Record<string, unknown>[], createdAt: string): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, created_at: createdAt }));
}

/** The Office 3-day Muscat creation window, as a SELECT policy. */
const OFFICE_WINDOW_START = '2026-10-29T00:00:00.000Z';
function officeWindow(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((row) => String(row.created_at ?? '') >= OFFICE_WINDOW_START);
}

describe('Admin pull: paginated, ordered, complete', () => {
  it('walks every page of a table larger than one page', async () => {
    const rows = entryRows(1_200);
    const { client, tables } = createPagedClient(
      { entries: { rows, visible: () => rows } },
      'admin',
    );

    const pull = await pullTable(client, 'entries');

    expect(pull.rows).toHaveLength(1_200);
    expect(pull.complete).toBe(true);
    expect(pull.pages).toBe(3);
    expect(new Set(pull.rows.map((row) => row.id)).size).toBe(1_200);
    expect(tables.entries.ranges).toEqual([
      [0, PULL_PAGE_SIZE - 1],
      [PULL_PAGE_SIZE, PULL_PAGE_SIZE * 2 - 1],
      [PULL_PAGE_SIZE * 2, PULL_PAGE_SIZE * 3 - 1],
    ]);
    // A stable order is what makes offset paging safe: without it, pages could
    // reshuffle and drop or repeat rows.
    expect(tables.entries.orders).toEqual(['id', 'id', 'id']);
    const ids = pull.rows.map((row) => String(row.id));
    expect(ids).toEqual([...ids].sort());
  });

  it('reports an exact multiple of the page size as complete', async () => {
    const rows = entryRows(PULL_PAGE_SIZE * 2);
    const { client } = createPagedClient({ entries: { rows, visible: () => rows } }, 'admin');
    const pull = await pullTable(client, 'entries');
    // Two full pages plus a third, empty one that proves the end was reached.
    expect(pull.rows).toHaveLength(PULL_PAGE_SIZE * 2);
    expect(pull.pages).toBe(3);
    expect(pull.complete).toBe(true);
  });

  it('keeps selectTable returning just the rows', async () => {
    const rows = entryRows(PULL_PAGE_SIZE + 25);
    const { client } = createPagedClient({ entries: { rows, visible: () => rows } }, 'admin');
    expect(await selectTable(client, 'entries')).toHaveLength(PULL_PAGE_SIZE + 25);
  });
});

describe('Office pull: RLS-scoped on every page', () => {
  it('never reveals a row outside the Office visibility window, page by page', async () => {
    // 400 rows inside the window, 900 outside it — more than a page in total,
    // so paging is required and every page must stay inside the policy.
    const inside = withCreatedAt(entryRows(400), '2026-10-30T06:00:00.000Z');
    const outside = Array.from({ length: 900 }, (_, index) => ({
      id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
      data: { name: `Old ${String(index)}` },
      created_at: '2026-10-01T06:00:00.000Z',
      updated_at: '2026-10-01T06:00:00.000Z',
    }));
    const all = [...inside, ...outside].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const { client, tables } = createPagedClient(
      { entries: { rows: all, visible: () => officeWindow(all) } },
      'office',
    );

    const pull = await pullTable(client, 'entries');

    expect(pull.rows).toHaveLength(400);
    expect(pull.complete).toBe(true);
    // Every returned row is inside the window — no page leaked anything.
    for (const row of pull.rows) {
      expect(String(row.created_at) >= OFFICE_WINDOW_START).toBe(true);
      expect(String(row.id).startsWith('22222222')).toBe(false);
    }
    // The Office walk is short: one page of visible rows, not the whole table.
    expect(tables.entries.ranges.length).toBe(1);
  });

  it('gives Admin the rows Office cannot see, from the same table', async () => {
    const inside = withCreatedAt(entryRows(300), '2026-10-30T06:00:00.000Z');
    const outside = Array.from({ length: 300 }, (_, index) => ({
      id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      data: { name: `Old ${String(index)}` },
      created_at: '2026-10-01T06:00:00.000Z',
      updated_at: '2026-10-01T06:00:00.000Z',
    }));
    const all = [...inside, ...outside].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const source = { rows: all, visible: () => all };
    const scoped = { rows: all, visible: () => officeWindow(all) };

    const admin = await pullTable(createPagedClient({ entries: source }, 'admin').client, 'entries');
    const office = await pullTable(createPagedClient({ entries: scoped }, 'office').client, 'entries');

    expect(admin.rows).toHaveLength(600);
    expect(office.rows).toHaveLength(300);
    expect(office.rows.every((row) => String(row.id).startsWith('33333333') === false)).toBe(true);
  });

  it('reports completeness for the rows the role may see, not the whole table', async () => {
    // An Office cache is legitimately partial by policy. `complete` means "the
    // walk reached the end of what this role may read" — which is what the
    // backup completeness gate is allowed to claim.
    const rows = withCreatedAt(entryRows(100), '2026-10-01T06:00:00.000Z');
    const { client } = createPagedClient({ entries: { rows, visible: () => officeWindow(rows) } }, 'office');
    const pull = await pullTable(client, 'entries');
    expect(pull.rows).toEqual([]);
    expect(pull.complete).toBe(true);
  });
});

describe('a failed page never yields a partial cache', () => {
  it('throws when a later page fails', async () => {
    const rows = entryRows(1_200);
    const { client, tables } = createPagedClient(
      { entries: { rows, visible: () => rows } },
      'admin',
      { failOnRequest: 2 },
    );

    await expect(pullTable(client, 'entries')).rejects.toThrow(/connection lost mid-pull/);
    // The first page succeeded, so the failure is provably mid-walk.
    expect(tables.entries.ranges).toHaveLength(1);
  });

  it('throws when the first page fails', async () => {
    const rows = entryRows(50);
    const { client } = createPagedClient(
      { entries: { rows, visible: () => rows } },
      'admin',
      { failOnRequest: 1 },
    );
    await expect(pullTable(client, 'entries')).rejects.toThrow(/connection lost mid-pull/);
  });

  it('refuses to walk forever when a cursor never advances', async () => {
    const rows = entryRows(PULL_PAGE_SIZE);
    const client: SupabaseDataClient = {
      from: () => ({
        select: (): SupabaseSelectQuery => {
          const query: SupabaseSelectQuery = {
            then: (onFulfilled, onRejected) => Promise
              .resolve({ data: rows, error: null } as SupabaseQueryResult)
              .then(onFulfilled, onRejected),
            order: () => query,
            range: () => query,
          };
          return query;
        },
      }),
    };
    await expect(pullTable(client, 'entries')).rejects.toThrow(
      new RegExp(`after ${String(MAX_PULL_ROWS)} rows`),
    );
  });
});

describe('both synced tables are paginated', () => {
  it('walks entries and app_columns through the same code path', async () => {
    const entries = entryRows(PULL_PAGE_SIZE + 10);
    const columns = Array.from({ length: PULL_PAGE_SIZE + 3 }, (_, index) => ({
      id: `col-${String(index).padStart(5, '0')}`,
      name: `Column ${String(index)}`,
      type: 'text',
      position: index,
      visible: true,
      updated_at: '2026-10-30T06:00:00.000Z',
    }));
    const { client, tables } = createPagedClient(
      {
        entries: { rows: entries, visible: () => entries },
        app_columns: { rows: columns, visible: () => columns },
      },
      'admin',
    );

    const [entriesPull, columnsPull] = await Promise.all([
      pullTable(client, 'entries'),
      pullTable(client, 'app_columns'),
    ]);

    expect(entriesPull.rows).toHaveLength(PULL_PAGE_SIZE + 10);
    expect(columnsPull.rows).toHaveLength(PULL_PAGE_SIZE + 3);
    expect(entriesPull.complete).toBe(true);
    expect(columnsPull.complete).toBe(true);
    expect(tables.entries.ranges.length).toBeGreaterThan(1);
    expect(tables.app_columns.ranges.length).toBeGreaterThan(1);
  });
});

describe('the sync run reports cache completeness to the main process', () => {
  /**
   * The backup gate in the main process never talks to Supabase. It reads what
   * the sync engine reports over the existing `dks:local:set-sync-status`
   * channel, so this is the other half of that contract: a fully paginated
   * pull must say so, and a partial one must not.
   */
  function createLocalDouble(): { local: SupabaseSyncLocal; statuses: Record<string, unknown>[] } {
    const statuses: Record<string, unknown>[] = [];
    let snapshot: DksLocalSnapshot = {
      rows: [],
      columns: [],
      deletedRows: [],
      syncStatus: { status: 'offline', lastSyncAt: null, lastError: null, pendingCount: 0 },
    };
    const local: SupabaseSyncLocal = {
      getSnapshot: async () => snapshot,
      setSyncStatus: async (state) => {
        statuses.push({ ...state });
        snapshot = { ...snapshot, syncStatus: { ...snapshot.syncStatus, ...state } };
        return snapshot.syncStatus;
      },
      applyRemoteSnapshot: async () => snapshot,
      listOutbox: async () => [],
      markOutboxSynced: async () => undefined,
    };
    return { local, statuses };
  }

  it('records a complete pull after every page arrives', async () => {
    const entries = entryRows(PULL_PAGE_SIZE + 5);
    const columns = [{
      id: 'name', name: 'Name', type: 'text', position: 0, visible: true,
      updated_at: '2026-10-30T06:00:00.000Z',
    }];
    const { client, tables } = createPagedClient({
      entries: { rows: entries, visible: () => entries },
      app_columns: { rows: columns, visible: () => columns },
    }, 'admin');
    const { local, statuses } = createLocalDouble();

    const result = await runSupabaseSync({ client, local, now: () => '2026-10-31T08:00:00.000Z' });

    expect(result.status).toBe('healthy');
    const reported = statuses.find((status) => status.lastPullAt !== undefined);
    expect(reported).toBeDefined();
    expect(reported?.lastPullComplete).toBe(true);
    expect(reported?.lastPullRows).toBe(entries.length + columns.length);
    expect(reported?.lastPullAt).toBe('2026-10-31T08:00:00.000Z');
    // Both tables were walked, not just entries.
    expect(tables.entries.ranges.length).toBe(2);
    expect(tables.app_columns.ranges.length).toBe(1);
  });

  it('does not claim completeness for a client that cannot paginate', async () => {
    const rows = entryRows(10);
    const client: SupabaseDataClient = {
      from: (table: string) => ({
        select: async () => ({
          data: table === 'entries' ? rows : [],
          error: null,
        }),
      }),
    };
    const { local, statuses } = createLocalDouble();

    const result = await runSupabaseSync({ client, local, now: () => '2026-10-31T08:00:00.000Z' });

    expect(result.status).toBe('healthy');
    const reported = statuses.find((status) => status.lastPullAt !== undefined);
    expect(reported?.lastPullComplete).toBe(false);
  });

  it('records nothing when the run fails', async () => {
    const client: SupabaseDataClient = {
      from: () => ({ select: async () => ({ data: null, error: { message: 'offline' } }) }),
    };
    const { local, statuses } = createLocalDouble();

    const result = await runSupabaseSync({ client, local, now: () => '2026-10-31T08:00:00.000Z' });

    expect(result.status).toBe('error');
    expect(statuses.some((status) => status.lastPullAt !== undefined)).toBe(false);
  });
});
