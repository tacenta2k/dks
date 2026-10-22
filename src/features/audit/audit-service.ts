import { formatLocalDateTime } from '../../lib/date';

/**
 * R2-10 — clearing the audit log is an administrator-only operation.
 *
 * The remote clear goes through the `clear_audit_log()` security-definer RPC
 * (see `supabase/schema.sql` / `ARENA/sql/fix-entries-rls.sql`); there is no
 * DELETE policy on `audit_log`, so an Office account can never clear it even
 * if it calls the API directly. The local mirror is cleared afterwards and one
 * new entry records who cleared it and when.
 */

export interface AuditClearRemoteClient {
  rpc?: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export const AUDIT_CLEAR_CONFIRMATION = 'DELETE';

export function auditClearMessage(actorLabel: string, when: Date = new Date()): string {
  return `Audit log cleared by ${actorLabel || 'Admin'} on ${formatLocalDateTime(when.toISOString())}`;
}

export function isAuditClearConfirmation(value: string): boolean {
  return value.trim() === AUDIT_CLEAR_CONFIRMATION;
}

export async function clearRemoteAuditLog(
  client: AuditClearRemoteClient | null | undefined,
  message: string,
): Promise<void> {
  if (!client?.rpc) {
    throw new Error('Clear the audit log again when the connection is available.');
  }
  const result = await client.rpc('clear_audit_log', { p_message: message });
  if (result.error) {
    throw new Error(result.error.message || 'Unable to clear the audit log on the server.');
  }
}
