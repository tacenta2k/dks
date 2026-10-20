import { describe, expect, it } from 'vitest';

import {
  COLUMN_TYPES,
  DAYS_LEFT_COLUMN_ID,
  canDeleteColumnForOffice,
  getPrimaryExpiryColumn,
  isDaysLeftColumn,
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
    ]);
  });

  it('makes the first expiry column primary and leaves exactly one primary', () => {
    const columns = normalizeColumns([
      column({ id: 'name', name: 'Name' }),
      column({ id: 'expiry-one', name: 'Expiry one', type: 'date_expiry' }),
      column({ id: 'expiry-two', name: 'Expiry two', type: 'date_expiry', isPrimaryExpiry: true }),
    ]);

    expect(columns.filter((item) => item.isPrimaryExpiry)).toHaveLength(1);
    expect(getPrimaryExpiryColumn(columns)?.id).toBe('expiry-one');
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
});
