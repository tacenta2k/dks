import { describe, expect, it } from 'vitest';

import {
  COLUMN_TYPES,
  DAYS_LEFT_COLUMN_ID,
  canDeleteColumn,
  canDeleteColumnForOffice,
  columnDeleteBlockReason,
  getPrimaryExpiryColumn,
  isDaysLeftColumn,
  isLivePrimaryExpiryColumn,
  isReservedSystemColumnName,
  normalizeColumns,
  type ColumnDefinition,
} from '../src/lib/columns';

function column(overrides: Partial<ColumnDefinition>): ColumnDefinition {
  return {
    id: overrides.id ?? overrides.name ?? 'column',
    name: overrides.name ?? 'Column',
    type: overrides.type ?? 'text',
    ...overrides,
  };
}

describe('protected column rules', () => {
  it('exposes exactly the supported user column types', () => {
    expect(COLUMN_TYPES).toEqual([
      'text',
      'number',
      'phone',
      'email',
      'price',
      'date_start',
      'date_expiry',
      'dropdown',
      'checkbox',
      'notes',
      'civil_id',
    ]);
  });

  it('keeps an administrator-selected primary expiry instead of resetting to the first column', () => {
    // Mirrors the SqliteStore contract (sqlite-outbox.test.ts): a single
    // live flagged primary is an explicit selection and survives — this is
    // also what makes column drag-reorder safe, since moving date_expiry
    // columns past each other must never redesignate the primary expiry.
    const columns = normalizeColumns([
      column({ id: 'name', name: 'Name' }),
      column({ id: 'expiry-one', name: 'Expiry one', type: 'date_expiry', position: 1 }),
      column({ id: 'expiry-two', name: 'Expiry two', type: 'date_expiry', position: 2, isPrimaryExpiry: true }),
    ]);

    expect(columns.filter((item) => item.isPrimaryExpiry)).toHaveLength(1);
    expect(getPrimaryExpiryColumn(columns)?.id).toBe('expiry-two');
  });

  it('heals to the first expiry by position when no primary (or several) are marked', () => {
    const unmarked = normalizeColumns([
      column({ id: 'expiry-two', name: 'Expiry two', type: 'date_expiry', position: 2 }),
      column({ id: 'expiry-one', name: 'Expiry one', type: 'date_expiry', position: 1 }),
    ]);
    expect(unmarked.filter((item) => item.isPrimaryExpiry)).toHaveLength(1);
    expect(getPrimaryExpiryColumn(unmarked)?.id).toBe('expiry-one');

    const ambiguous = normalizeColumns([
      column({ id: 'expiry-one', name: 'Expiry one', type: 'date_expiry', position: 1, isPrimaryExpiry: true }),
      column({ id: 'expiry-two', name: 'Expiry two', type: 'date_expiry', position: 2, isPrimaryExpiry: true }),
    ]);
    expect(ambiguous.filter((item) => item.isPrimaryExpiry)).toHaveLength(1);
    expect(getPrimaryExpiryColumn(ambiguous)?.id).toBe('expiry-one');
  });

  it('allows an office to delete only an unprotected empty column', () => {
    const empty = column({ id: 'empty', name: 'Empty' });
    const populated = column({ id: 'populated', name: 'Populated' });
    const primary = column({ id: 'expiry', name: 'Expiry', type: 'date_expiry', isPrimaryExpiry: true });

    expect(canDeleteColumnForOffice(empty, [{ id: 'one', data: {} }])).toBe(true);
    expect(canDeleteColumnForOffice(populated, [{ id: 'one', data: { Populated: 'value' } }])).toBe(false);
    expect(canDeleteColumnForOffice(primary, [{ id: 'one', data: {} }])).toBe(false);
  });

  it('protects the generated Days Left column', () => {
    expect(isDaysLeftColumn({ id: DAYS_LEFT_COLUMN_ID, name: 'Days Left' })).toBe(true);
    expect(canDeleteColumnForOffice({ id: DAYS_LEFT_COLUMN_ID, name: 'Days Left', type: 'number' }, [])).toBe(false);
  });

  it('protects the system column by ID only — a user column NAMED "Days Left" is deletable', () => {
    // The recorded bug: a persisted column named "Days Left" (id `days_left`,
    // e.g. from an older import) was protected FOREVER because protection
    // matched the NAME, and its stale primary-expiry mark echoed the
    // misleading "primary expiry column" error. Protection is id-exact now.
    const legacy = column({
      id: 'days_left',
      name: 'Days Left',
      type: 'text',
      isPrimaryExpiry: true, // stale mark — must be meaningless (not date_expiry)
      is_primary_expiry: true,
    });
    expect(isDaysLeftColumn(legacy)).toBe(false);
    expect(isLivePrimaryExpiryColumn(legacy)).toBe(false);
    // Admin deletes it even when populated; Office when empty.
    const rows = [{ id: 'one', data: { days_left: '7', 'Days Left': '7' } }];
    expect(canDeleteColumn(legacy, 'admin', rows)).toBe(true);
    expect(canDeleteColumnForOffice(legacy, [])).toBe(true);
    expect(canDeleteColumnForOffice(legacy, rows)).toBe(false); // populated office block only
    expect(columnDeleteBlockReason(legacy, 'admin', rows)).toBeNull();
    expect(columnDeleteBlockReason(legacy, 'office', rows)).toBe('office-data');
  });

  it('treats only a live date_expiry primary as protected, healing stale flags in memory', () => {
    const livePrimary = column({ id: 'expiry', name: 'Expiry', type: 'date_expiry', isPrimaryExpiry: true });
    expect(isLivePrimaryExpiryColumn(livePrimary)).toBe(true);
    expect(columnDeleteBlockReason(livePrimary, 'admin', [])).toBe('primary');

    // A deleted primary expiry no longer blocks (it is not live).
    const deletedPrimary = column({ ...livePrimary, deleted: true });
    expect(isLivePrimaryExpiryColumn(deletedPrimary)).toBe(false);

    // normalizeColumns heals stale state: primary flag moves to the first
    // live date_expiry column and is stripped from everything else.
    const healed = normalizeColumns([
      column({ id: 'days_left', name: 'Days Left', type: 'text', isPrimaryExpiry: true }),
      column({ id: 'expiry', name: 'Expiry', type: 'date_expiry' }),
    ]);
    expect(healed.find((item) => item.id === 'days_left')?.isPrimaryExpiry).toBe(false);
    expect(healed.find((item) => item.id === 'expiry')?.isPrimaryExpiry).toBe(true);

    // No expiry column at all: nothing stays primary.
    const nonePrimary = normalizeColumns([
      column({ id: 'days_left', name: 'Days Left', type: 'text', isPrimaryExpiry: true }),
    ]);
    expect(nonePrimary[0].isPrimaryExpiry).toBe(false);
  });

  it('reserves the Days Left NAME for creation guards while deletion stays id-based', () => {
    expect(isReservedSystemColumnName('Days Left')).toBe(true);
    expect(isReservedSystemColumnName(' days_left ')).toBe(true);
    expect(isReservedSystemColumnName('days-left')).toBe(true);
    expect(isReservedSystemColumnName('Days')).toBe(false);
    expect(isReservedSystemColumnName('Total days left')).toBe(false);
    expect(isReservedSystemColumnName(null)).toBe(false);

    const generated = column({ id: DAYS_LEFT_COLUMN_ID, name: 'Days Left', type: 'number' });
    expect(columnDeleteBlockReason(generated, 'admin', [])).toBe('system');
    expect(columnDeleteBlockReason(generated, 'office', [])).toBe('system');
  });
});
