import { describe, expect, it } from 'vitest';

import { type ColumnDefinition } from '../src/lib/columns';
import {
  findDuplicatePassportValues,
  isValidOmanPassport,
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
  it('accepts the two Oman passport formats and ignores spaces/case', () => {
    expect(isValidOmanPassport('a 1234567')).toBe(true);
    expect(isValidOmanPassport('1234 5678')).toBe(true);
    expect(isValidOmanPassport('A1234567')).toBe(true);
    expect(isValidOmanPassport('AB123456')).toBe(false);
    expect(isValidOmanPassport('1234567')).toBe(false);
    expect(isValidOmanPassport('A123456')).toBe(false);
  });

  it('reports passport failures as visual diagnostics without throwing', () => {
    const result = validateCell('A123', column({ name: 'Passport', isPassport: true }));

    expect(result.valid).toBe(false);
    expect(result.severity).toBe('error');
    expect(result.message).toMatch(/passport/i);
  });

  it('validates the basic visual field types', () => {
    expect(validateCell('hello@example.com', column({ type: 'email' })).valid).toBe(true);
    expect(validateCell('not-an-email', column({ type: 'email' })).valid).toBe(false);
    expect(validateCell('+968 9123 4567', column({ type: 'phone' })).valid).toBe(true);
    expect(validateCell('12x', column({ type: 'number' })).valid).toBe(false);
    expect(validateCell('1.234', column({ type: 'price' })).valid).toBe(true);
    expect(validateCell('1.2345', column({ type: 'price' })).valid).toBe(false);
    expect(validateCell('2026-02-30', column({ type: 'date_expiry' })).valid).toBe(false);
    expect(validateCell('2026-02-28', column({ type: 'date_start' })).valid).toBe(true);
    expect(validateCell('Open', column({ type: 'dropdown', options: ['Open', 'Closed'] })).valid).toBe(true);
    expect(validateCell('Other', column({ type: 'dropdown', options: ['Open', 'Closed'] })).valid).toBe(false);
    expect(validateCell(true, column({ type: 'checkbox' })).valid).toBe(true);
    expect(validateCell('yes', column({ type: 'checkbox' })).valid).toBe(false);
  });

  it('keeps duplicate passport detection non-blocking', () => {
    const rows = [
      { id: 'one', data: { Passport: 'a 1234567' } },
      { id: 'two', data: { Passport: 'A1234567' } },
      { id: 'three', data: { Passport: '12345678' } },
    ];
    const duplicates = findDuplicatePassportValues(rows, 'Passport');
    const diagnostic = validateCell('A1234567', column({ name: 'Passport', isPassport: true }), {
      duplicatePassportValues: duplicates,
    });

    expect(duplicates.has('A1234567')).toBe(true);
    expect(diagnostic.valid).toBe(true);
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.message).toMatch(/duplicate/i);
  });
});
