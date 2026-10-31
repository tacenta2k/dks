import type { Role } from '../features/auth/auth-types';

export type Capability =
  | 'dashboard'
  | 'sheet'
  | 'viewDashboard'
  | 'viewSheet'
  | 'create'
  | 'editRecords'
  | 'edit'
  | 'duplicate'
  | 'delete'
  | 'softDelete'
  | 'renew'
  | 'search'
  | 'filter'
  | 'refresh'
  | 'notifications'
  | 'adminNavigation'
  | 'export'
  | 'import'
  | 'print'
  | 'settings'
  | 'recycleBin'
  | 'auditLog'
  | 'restore'
  | 'permanentDelete'
  | 'protectedSettings'
  | 'manageUsers'
  | 'adminStatus';

const OFFICE_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'dashboard',
  'sheet',
  'viewDashboard',
  'viewSheet',
  'create',
  'editRecords',
  'edit',
  'duplicate',
  'delete',
  'softDelete',
  'renew',
  'search',
  'filter',
  // Bug 3: Refresh (manual sync + local reload) is an explicit shared
  // capability. It grants no wider data access — the reload still reads
  // through the role-scoped snapshot (Office = 3-day window) and the sync
  // run is the same RLS-bounded one that already runs in the background.
  'refresh',
  'notifications',
]);

const ADMIN_CAPABILITIES: ReadonlySet<Capability> = new Set([
  ...OFFICE_CAPABILITIES,
  'adminNavigation',
  'export',
  'import',
  'print',
  'settings',
  'recycleBin',
  'auditLog',
  'restore',
  'permanentDelete',
  'protectedSettings',
  'manageUsers',
  'adminStatus',
]);

/**
 * Renderer permission checks are intentionally deny-by-default. Supabase RLS
 * remains the backend boundary; this predicate only controls the UI surface.
 */
export function can(
  role: Role | string | null | undefined,
  capability: Capability | string,
): boolean {
  if (role === 'admin') {
    return ADMIN_CAPABILITIES.has(capability as Capability);
  }

  if (role === 'office') {
    return OFFICE_CAPABILITIES.has(capability as Capability);
  }

  return false;
}

export const adminCapabilities = ADMIN_CAPABILITIES;
export const officeCapabilities = OFFICE_CAPABILITIES;
