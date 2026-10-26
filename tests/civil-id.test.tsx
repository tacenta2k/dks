import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLUMN_TYPES,
  isSupportedColumnType,
  normalizeColumns,
  type ColumnDefinition,
} from '../src/lib/columns';
import {
  findDuplicateCivilIdValues,
  normalizeCivilIdValue,
  validateCell,
} from '../src/lib/validation';
import { ColumnWizard } from '../src/features/sheet/column-wizard';
import { importRows } from '../src/features/import-export/import-service';
import { SheetPage } from '../src/features/sheet/SheetPage';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { SheetRepository } from '../src/features/sheet/repository';

function column(overrides: Partial<ColumnDefinition>): ColumnDefinition {
  return {
    id: overrides.id ?? overrides.name ?? 'column',
    name: overrides.name ?? 'Column',
    type: overrides.type ?? 'text',
    ...overrides,
  };
}

describe('Civil ID column type', () => {
  it('is a supported user column type alongside the existing types', () => {
    expect(COLUMN_TYPES).toContain('civil_id');
    expect(isSupportedColumnType('civil_id')).toBe(true);
    expect(COLUMN_TYPES).toContain('text');
    // No country-specific sibling types may sneak in.
    expect(COLUMN_TYPES.filter((type) => /oman|qatar|kuwait|qat/i.test(type))).toHaveLength(0);
  });

  it('offers Civil ID in the Add Column type chooser as plain strings', async () => {
    const submitted: ColumnDefinition[] = [];
    render(
      <ColumnWizard
        onSubmit={(c) => { submitted.push(c); }}
        onClose={() => undefined}
      />,
    );

    const select = screen.getByLabelText('Column type') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const options = Array.from(select.querySelectorAll('option'))
      .map((option) => option.textContent);
    expect(options).toContain('Civil ID');

    // Create one end-to-end: type the name, pick Civil ID, submit.
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Civil ID number' } });
    fireEvent.change(select as HTMLSelectElement, { target: { value: 'civil_id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0].type).toBe('civil_id');
  });

  it('normalizes only for comparison — the stored text keeps leading zeroes verbatim', () => {
    const stored = ' 0123 - abc ';
    // Normalization strips whitespace only for comparison purposes.
    expect(normalizeCivilIdValue(stored)).toBe('0123-ABC');
    // Leading zeroes are NEVER part of the normalization — they survive untouched.
    expect(normalizeCivilIdValue('00123')).toBe('00123');
    expect(normalizeCivilIdValue('00123')).not.toBe('123');
    expect(normalizeCivilIdValue(12345)).toBe('');
    expect(normalizeCivilIdValue('')).toBe('');
    // Equality is case-insensitive and whitespace-insensitive.
    expect(normalizeCivilIdValue('0123 abc')).toBe(normalizeCivilIdValue('0123ABC'));
  });

  it('stores the raw Civil ID string unchanged through column normalization', () => {
    const columns = normalizeColumns([column({ id: 'civil', name: 'Civil ID', type: 'civil_id' })]);
    expect(columns).toHaveLength(1);
    expect(columns[0].type).toBe('civil_id');
    // The full set of types still round-trips (primary expiry remains default).
    expect(columns[0].isPrimaryExpiry).toBe(false);
  });
});

describe('duplicate Civil ID detection', () => {
  const civilColumn = column({ id: 'civil', name: 'Civil ID', type: 'civil_id' });

  it('flags normalized duplicates across active rows only', () => {
    const rows = [
      { id: 'a', data: { civil: '0123 ABC' } },
      { id: 'b', data: { civil: '0123ABC' } },       // whitespace variant — duplicate
      { id: 'c', data: { civil: '09876' } },
      { id: 'd', data: { civil: '0987 6' } },        // whitespace variant of b-sibling? No — of 09876 → duplicate
      { id: 'gone', data: { civil: '0123ABC' }, deleted: true }, // deleted twins do NOT count
      { id: 'empty', data: { civil: '' } },
    ];
    const duplicates = findDuplicateCivilIdValues(rows, civilColumn);
    expect(duplicates.has('0123ABC')).toBe(true);
    expect(duplicates.has('09876')).toBe(true);
  });

  it('reports nothing for unique values', () => {
    const rows = [
      { id: 'a', data: { civil: '00123' } },
      { id: 'b', data: { civil: '00456' } },
      { id: 'empty', data: { civil: '' } },
    ];
    expect(findDuplicateCivilIdValues(rows, civilColumn).size).toBe(0);
  });

  it('warns in the cell diagnostics but never blocks saving', () => {
    const duplicates = findDuplicateCivilIdValues([
      { id: 'a', data: { civil: '00123' } },
      { id: 'b', data: { civil: '00123' } },
    ], civilColumn);
    const diagnostic = validateCell('00123', civilColumn, { duplicateCivilIdValues: duplicates });
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.message).toMatch(/duplicate civil id/i);
    // A fresh value carries no diagnostic at all.
    expect(validateCell('00999', civilColumn, { duplicateCivilIdValues: duplicates }).severity).toBe('none');
  });
});

describe('Civil ID survives CSV import (strings, leading zeroes)', () => {
  it('imports civil_id rows verbatim, including leading zeroes', async () => {
    const result = await importRows(
      'Name,Civil No\r\nAlice,00123\r\nBob,00456',
      {
        role: 'admin',
        fileName: 'civil-ids.csv',
        columns: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'civilNo', name: 'Civil No', type: 'civil_id' },
        ],
      },
    );
    expect(result.records).toHaveLength(2);
    expect(result.records.map((row) => row.data.civilNo)).toEqual(['00123', '00456']);
  });
});

describe('Civil ID end-to-end in the grid (rendered) and repository', () => {
  let repository: SheetRepository;

  beforeEach(async () => {
    repository = createInMemorySheetRepository();
    await repository.addColumn({ name: 'Full name', type: 'text' });
    await repository.addColumn({ name: 'Civil ID', type: 'civil_id' });
    await repository.addColumn({ name: 'Expiry', type: 'date_expiry' });
  });

  it('keeps leading zeroes through the repository + shows the duplicate banner without blocking saves', async () => {
    await repository.createRow({ full_name: 'Employee One', 'Civil ID': '00123' });
    await repository.createRow({ full_name: 'Employee Two', 'Civil ID': '00123' });

    render(<SheetPage repository={repository} role="office" refreshToken={0} renderGridInTests={false} />);

    // Both saves went through despite the duplicated id (non-blocking).
    const rows = await repository.getRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.data['Civil ID'])).toEqual(['00123', '00123']);

    // The sheet surfaces the advisory banner with role=alert.
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/duplicate civil id/i);
    expect(banner).toHaveTextContent('00123');
  });

  it('hides the banner once the duplicate is deleted', async () => {
    await repository.createRow({ full_name: 'Employee One', 'Civil ID': '00777' });
    await repository.createRow({ full_name: 'Employee Two', 'Civil ID': '00777' });

    const { rerender } = render(<SheetPage repository={repository} role="office" refreshToken={0} renderGridInTests={false} />);
    await screen.findByRole('alert');

    const rows = await repository.getRows();
    await repository.softDeleteRow(rows[1].id);

    // Bump the refresh token: SheetPage re-fetches in place and recomputes
    // the advisory duplicate set.
    rerender(<SheetPage repository={repository} role="office" refreshToken={1} renderGridInTests={false} />);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
