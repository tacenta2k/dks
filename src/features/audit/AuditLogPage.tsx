import { useMemo } from 'react';

import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import type { AuditEntry } from './audit-types';

export interface AuditLogPageProps {
  entries: readonly AuditEntry[];
  role?: Role | string | null;
}

function entryTime(entry: AuditEntry): string {
  return entry.timestamp ?? entry.time ?? entry.createdAt ?? '—';
}

function entryActor(entry: AuditEntry): string {
  if (typeof entry.actor === 'string') {
    return entry.actor;
  }
  if (entry.actor && typeof entry.actor === 'object') {
    return entry.actor.name ?? entry.actor.email ?? entry.actorId ?? 'Unknown';
  }
  return entry.actorName ?? entry.actorId ?? 'Unknown';
}

export function formatAuditDetails(details: unknown): string {
  if (details === null || details === undefined || details === '') {
    return '—';
  }
  if (typeof details === 'string') {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

export function AuditLogPage({ entries, role }: AuditLogPageProps) {
  const orderedEntries = useMemo(
    () => [...entries].sort((left, right) => entryTime(right).localeCompare(entryTime(left))),
    [entries],
  );

  if (!can(role, 'auditLog')) {
    return (
      <section className="audit-log-page" role="alert" aria-label="Audit log access denied">
        Only administrators can access the audit log.
      </section>
    );
  }

  return (
    <section className="audit-log-page" aria-label="Audit log">
      <header>
        <p>Admin tools</p>
        <h1>Audit log</h1>
        <p>{orderedEntries.length} recorded {orderedEntries.length === 1 ? 'action' : 'actions'}</p>
      </header>
      {orderedEntries.length === 0 ? (
        <p>No audit events recorded.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Time</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {orderedEntries.map((entry) => (
              <tr key={entry.id ?? `${entry.action}-${entry.timestamp}-${entry.actorId ?? ''}`}>
                <td>{entry.action}</td>
                <td>{entryActor(entry)}</td>
                <td><time dateTime={entryTime(entry)}>{entryTime(entry)}</time></td>
                <td>{formatAuditDetails(entry.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default AuditLogPage;
