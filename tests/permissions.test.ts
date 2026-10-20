import { describe, expect, it } from 'vitest';

import { can } from '../src/lib/permissions';

describe('role permissions', () => {
  it('allows administrators to use administrative capabilities', () => {
    expect(can('admin', 'adminNavigation')).toBe(true);
    expect(can('admin', 'export')).toBe(true);
    expect(can('admin', 'restore')).toBe(true);
  });

  it('keeps office users on the shared workspace capabilities', () => {
    expect(can('office', 'dashboard')).toBe(true);
    expect(can('office', 'sheet')).toBe(true);
    expect(can('office', 'edit')).toBe(true);
    expect(can('office', 'softDelete')).toBe(true);
    expect(can('office', 'adminNavigation')).toBe(false);
    expect(can('office', 'export')).toBe(false);
    expect(can('office', 'print')).toBe(false);
    expect(can('office', 'restore')).toBe(false);
  });

  it('denies unknown or missing roles by default', () => {
    expect(can(undefined, 'dashboard')).toBe(false);
    expect(can('owner', 'dashboard')).toBe(false);
    expect(can('office', 'unknown-capability')).toBe(false);
  });
});
