import { DKS_BUSINESS_TIME_ZONE, formatBusinessDateTime } from '../../lib/date';

/**
 * R2-10 / R3 batch C — clearing the audit log is an administrator-only
 * operation.
 *
 * Where the "DELETE requires a WHERE clause" error came from
 * -----------------------------------------------------------
 * That message is a *server-side REST* safety error: it is what PostgREST
 * answers when a DELETE request arrives with no filter, i.e.
 * `client.from('audit_log').delete()` with no `.eq()`. It is not produced by
 * SQLite (SQLite allows `DELETE FROM audit_log`), by better-sqlite3, or by the
 * `clear_audit_log()` RPC. DKS therefore never issues an unfiltered REST
 * DELETE:
 *
 *   - the remote clear is the `clear_audit_log()` security-definer RPC, which
 *     re-checks the role server-side and runs in one transaction;
 *   - there is no DELETE policy at all on `public.audit_log`, so even a hand
 *     written REST DELETE is refused for every account;
 *   - the local mirror is cleared by one narrowly scoped store method
 *     (`SqliteStore.clearAuditLog`), never by a generic client-side bulk
 *     delete.
 *
 * Because the RPC is transactional, a failed clear cannot leave the remote
 * half-empty, and a retry cannot erase history that was already removed.
 */

export interface AuditClearRemoteClient {
  rpc?: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export const AUDIT_CLEAR_CONFIRMATION = 'DELETE';

/** The one migration that installs the RPC. */
export const AUDIT_CLEAR_SQL_FILE = 'ARENA/sql/fix-entries-rls.sql';

/**
 * The message stored on both sides of a clear. R3 batch G: the timestamp is
 * Oman local time (Asia/Muscat), matching the SQL default in
 * `clear_audit_log()` exactly, so a clear made from this PC and one made
 * through the RPC alone read the same:
 *   Audit log cleared by Admin on DD/MM/YYYY HH:mm
 */
export function auditClearMessage(actorLabel: string, when: Date = new Date()): string {
  return `Audit log cleared by ${actorLabel || 'Admin'} on ${formatBusinessDateTime(when, DKS_BUSINESS_TIME_ZONE)}`;
}

export function isAuditClearConfirmation(value: string): boolean {
  return value.trim() === AUDIT_CLEAR_CONFIRMATION;
}

/** The RPC is missing because the migration has not been run on the project. */
export function isMissingAuditClearFunction(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('could not find the function')
    || (text.includes('clear_audit_log') && text.includes('does not exist'))
    || (text.includes('schema cache') && text.includes('clear_audit_log'))
    || text.includes('permission denied for function clear_audit_log')
  );
}

export async function clearRemoteAuditLog(
  client: AuditClearRemoteClient | null | undefined,
  message: string,
): Promise<void> {
  if (!client || typeof client.rpc !== 'function') {
    // Deliberately refused: falling back to an unfiltered REST delete is
    // exactly the request shape the server rejects (and it would bypass the
    // admin check the RPC performs).
    throw new Error(
      'The audit log can only be cleared while connected to the server. Nothing was removed.',
    );
  }

  let result: { data: unknown; error: { message?: string } | null };
  try {
    result = await client.rpc('clear_audit_log', { p_message: message });
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`The server refused the audit-log clear: ${reason}. Nothing was removed.`);
  }

  if (result?.error) {
    const reason = result.error.message ?? '';
    if (isMissingAuditClearFunction(reason)) {
      throw new Error(
        `Clear the audit log again after running ${AUDIT_CLEAR_SQL_FILE} in the Supabase SQL Editor. `
          + 'Nothing was removed.',
      );
    }
    throw new Error(`The server refused the audit-log clear: ${reason || 'unknown error'}. Nothing was removed.`);
  }
}
