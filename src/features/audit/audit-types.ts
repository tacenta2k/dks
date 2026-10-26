/**
 * The renderer shape used by admin-only audit views and by feature services
 * that need to return an audit payload.  The payload deliberately keeps
 * details JSON-compatible so it can be handed to a future repository without
 * coupling this UI layer to a storage implementation.
 */
export interface AuditEntry {
  id?: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  actorId?: string | null;
  actor?: string | { name?: string | null; email?: string | null } | null;
  actorName?: string | null;
  timestamp?: string;
  time?: string;
  createdAt?: string;
  details?: unknown;
}

export type AuditPayload = AuditEntry;
