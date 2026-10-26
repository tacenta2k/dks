import * as validationModule from '../src/lib/validation';
import { describe, expect, it } from 'vitest';

import { type ColumnDefinition } from '../src/lib/columns';
import {
  findDuplicateCivilIdValues,
  findDuplicatePassportValues,
  isNilPlaceholder,
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

  it('keeps the removed country-specific passport format API absent (F1)', () => {
    // These helpers enforced an Oman-specific format and drove the old
    // "invalid format" styling. They must never come back.
    const validation = validationModule as Record<string, unknown>;
    expect(validation.isValidOmanPassport).toBeUndefined();
    expect(validation.validateOmanPassport).toBeUndefined();
    expect(validation.validatePassport).toBeUndefined();
    expect(validation.isValidPassport).toBeUndefined();
    expect(Object.keys(validation).some((key) => /oman|format/i.test(key))).toBe(false);
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

describe('NIL placeholder duplicate exemption', () => {
  const nilSpellings = ['NIL', 'nil', 'Nil', 'nIl', '  NIL  ', '\tnil\n'];

  it('recognises only the whole trimmed value as the placeholder', () => {
    for (const value of nilSpellings) {
      expect(isNilPlaceholder(value)).toBe(true);
    }
    for (const value of ['NIL123', 'ANIL', 'NIL-1', 'NIL NIL', '', '   ', null, undefined, 0]) {
      expect(isNilPlaceholder(value)).toBe(false);
    }
  });

  it('never flags shared NIL passports, in any casing or padding', () => {
    const rows = nilSpellings.map((value, index) => ({
      id: `row-${index}`,
      data: { Passport: value },
    }));
    expect(findDuplicatePassportValues(rows, 'Passport').size).toBe(0);
  });

  it('never flags shared NIL Civil IDs, in any casing or padding', () => {
    const civilColumn = column({ id: 'civil', name: 'Civil ID', type: 'civil_id' });
    const rows = nilSpellings.map((value, index) => ({
      id: `row-${index}`,
      data: { civil: value },
    }));
    expect(findDuplicateCivilIdValues(rows, civilColumn).size).toBe(0);
  });

  it('still flags partial NIL values and real duplicates alongside NIL rows', () => {
    const passportRows = [
      { id: 'n1', data: { Passport: 'NIL' } },
      { id: 'n2', data: { Passport: 'nil' } },
      { id: 'p1', data: { Passport: 'NIL123' } },
      { id: 'p2', data: { Passport: 'nil123' } },
      { id: 'a1', data: { Passport: 'ANIL' } },
      { id: 'a2', data: { Passport: 'anil' } },
      { id: 'r1', data: { Passport: 'X98765' } },
      { id: 'r2', data: { Passport: 'x98765' } },
    ];
    const duplicates = findDuplicatePassportValues(passportRows, 'Passport');
    expect(duplicates.has('NIL')).toBe(false);
    expect(duplicates.has('NIL123')).toBe(true);
    expect(duplicates.has('ANIL')).toBe(true);
    expect(duplicates.has('X98765')).toBe(true);

    const civilColumn = column({ id: 'civil', name: 'Civil ID', type: 'civil_id' });
    const civilRows = [
      { id: 'n1', data: { civil: '  NIL  ' } },
      { id: 'n2', data: { civil: 'Nil' } },
      { id: 'p1', data: { civil: 'NIL123' } },
      { id: 'p2', data: { civil: 'NIL123' } },
      { id: 'r1', data: { civil: '00123' } },
      { id: 'r2', data: { civil: '00123' } },
    ];
    const civilDuplicates = findDuplicateCivilIdValues(civilRows, civilColumn);
    expect(civilDuplicates.has('NIL')).toBe(false);
    expect(civilDuplicates.has('NIL123')).toBe(true);
    // Leading zeroes stay significant: 00123 is its own value, never 123.
    expect(civilDuplicates.has('00123')).toBe(true);
    expect(civilDuplicates.has('123')).toBe(false);
  });

  it('raises no cell warning for NIL, even with a stale duplicate set or flag', () => {
    const passportColumn = column({ name: 'Passport', isPassport: true });
    for (const value of nilSpellings) {
      expect(validateCell(value, passportColumn, {
        duplicatePassportValues: new Set(['NIL']),
      }).severity).toBe('none');
      expect(validateCell(value, passportColumn, {
        duplicatePassport: true,
      }).severity).toBe('none');
    }

    const civilColumn = column({ id: 'civil', name: 'Civil ID', type: 'civil_id' });
    for (const value of nilSpellings) {
      expect(validateCell(value, civilColumn, {
        duplicateCivilIdValues: new Set(['NIL']),
      }).severity).toBe('none');
    }
  });

  it('keeps real duplicate cell warnings non-blocking next to NIL values', () => {
    const passportColumn = column({ name: 'Passport', isPassport: true });
    const rows = [
      { id: 'n1', data: { Passport: 'NIL' } },
      { id: 'r1', data: { Passport: 'P-77' } },
      { id: 'r2', data: { Passport: 'P-77' } },
    ];
    const duplicates = findDuplicatePassportValues(rows, 'Passport');
    const diagnostic = validateCell('P-77', passportColumn, { duplicatePassportValues: duplicates });
    expect(diagnostic.valid).toBe(true);
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.message).toMatch(/duplicate/i);
    expect(validateCell('nil', passportColumn, { duplicatePassportValues: duplicates }).severity).toBe('none');
  });
});
