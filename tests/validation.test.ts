import { describe, expect, it } from 'vitest';

import { type ColumnDefinition } from '../src/lib/columns';
import {
  findDuplicatePassportValues,
  normalizePassportValue,
  validateCell,
} from '../src/lib/validation';

function column(overrides: Partial<ColumnDefinition>): ColumnDefinition {
  return {
    id: overrides.id ?? overrides.name ?? 'column',
    name: overrides.name ?? 'Column',
    type: overrides.type ?? 'text',
    ...overrides,
  };
}

describe('cell diagnostics', () => {
  it('treats passport values as plain text without country-specific format checks (F1)', () => {
    // Customers come from India, Pakistan, Bangladesh, Oman and elsewhere, so
    // none of these values may be rejected or flagged as "invalid format".
    for (const value of ['A123', 'AB123456', '1234567', 'X99-441', 'a 1234567', '1234 5678']) {
      const result = validateCell(value, column({ name: 'Passport No', isPassport: true }));
      expect(result.valid).toBe(true);
      expect(result.severity).toBe('none');
    }
  });

  it('compares passport text case- and spacing-insensitively for duplicate warnings', () => {
    expect(normalizePassportValue('a 1234567')).toBe('A1234567');
    expect(normalizePassportValue('AB-12')).toBe('AB-12');
  });

  it('validates the basic visual field types', () => {
    expect(validateCell('hello@example.com', column({ type: 'email' })).valid).toBe(true);
    // Phone and email format issues are visual-only warnings and must not
    // block saving (HANDOFF data rules).
    const emailWarning = validateCell('not-an-email', column({ type: 'email' }));
    expect(emailWarning.valid).toBe(true);
    expect(emailWarning.severity).toBe('warning');
    const phoneWarning = validateCell('abc', column({ type: 'phone' }));
    expect(phoneWarning.valid).toBe(true);
    expect(phoneWarning.severity).toBe('warning');
    expect(validateCell('+968 9123 4567', column({ type: 'phone' })).severity).toBe('none');
    expect(validateCell('12x', column({ type: 'number' })).valid).toBe(false);
    expect(validateCell('1.234', column({ type: 'price' })).valid).toBe(true);
    expect(validateCell('1.2345', column({ type: 'price' })).valid).toBe(false);
    expect(validateCell('2026-02-28', column({ type: 'date_start' })).valid).toBe(true);
    expect(validateCell('28/02/2026', column({ type: 'date_expiry' })).valid).toBe(true);
    // Impossible calendar dates keep their text and warn — they are never
    // silently converted to a different date (F2).
    const impossible = validateCell('31/02/2026', column({ type: 'date_expiry' }));
    expect(impossible.valid).toBe(true);
    expect(impossible.severity).toBe('warning');
    const impossibleIso = validateCell('2026-02-30', column({ type: 'date_expiry' }));
    expect(impossibleIso.valid).toBe(true);
    expect(impossibleIso.severity).toBe('warning');
    // Malformed text is still a real error.
    expect(validateCell('not-a-date', column({ type: 'date_expiry' })).valid).toBe(false);
    expect(validateCell('Open', column({ type: 'dropdown', options: ['Open', 'Closed'] })).valid).toBe(true);
    expect(validateCell('Other', column({ type: 'dropdown', options: ['Open', 'Closed'] })).valid).toBe(false);
    expect(validateCell(true, column({ type: 'checkbox' })).valid).toBe(true);
    expect(validateCell('yes', column({ type: 'checkbox' })).valid).toBe(false);
  });

  it('keeps duplicate passport detection non-blocking for any plain-text value', () => {
    const rows = [
      { id: 'one', data: { Passport: 'a 1234567' } },
      { id: 'two', data: { Passport: 'A1234567' } },
      { id: 'three', data: { Passport: 'AB123456' } },
      { id: 'four', data: { Passport: 'ab12 3456' } },
      { id: 'five', data: { Passport: '9999' } },
    ];
    const duplicates = findDuplicatePassportValues(rows, 'Passport');

    // Values that differ only in case/spacing count as duplicates, and values
    // that do not match any country format still participate.
    expect(duplicates.has('A1234567')).toBe(true);
    expect(duplicates.has('AB123456')).toBe(true);
    expect(duplicates.has('9999')).toBe(false);

    const diagnostic = validateCell('A1234567', column({ name: 'Passport', isPassport: true }), {
      duplicatePassportValues: duplicates,
    });

    expect(diagnostic.valid).toBe(true);
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.message).toMatch(/duplicate/i);
  });

  it('ignores deleted rows when collecting duplicate passport values', () => {
    const rows = [
      { id: 'one', data: { Passport: 'A-1' }, deleted: true },
      { id: 'two', data: { Passport: 'A-1' } },
    ];
    expect(findDuplicatePassportValues(rows, 'Passport').size).toBe(0);
  });
});
