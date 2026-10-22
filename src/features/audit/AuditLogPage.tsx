import { useMemo, useState } from 'react';

import { formatLocalDateTime } from '../../lib/date';
import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import type { AuditEntry } from './audit-types';

/** Profile rows used to resolve audit actors (S3). */
export interface AuditProfile {
  id: string;
  full_name?: string | null;
  fullName?: string | null;
  email?: string | null;
  role?: string | null;
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: 'Created record',
  create_entry: 'Created record',
  create_many: 'Created records',
  create_row: 'Created record',
  update: 'Updated record',
  update_entry: 'Updated record',
  soft_delete: 'Moved to Recycle Bin',
  delete: 'Moved to Recycle Bin',
  restore: 'Restored record',
  permanent_delete: 'Permanently deleted',
  renew: 'Renewed record',
  duplicate: 'Duplicated record',
  import: 'Imported records',
  create_column: 'Added column',
  add_column: 'Added column',
  update_column: 'Updated column',
  delete_column: 'Deleted column',
  record_conflict: 'Recorded conflict',
  merge_conflict: 'Merged conflict',
};

/** Friendly action name (S3) — raw codes only for actions we have no name for. */
export function formatAuditAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function profileName(profile: AuditProfile): string {
  const name = (profile.full_name ?? profile.fullName ?? '').trim();
  if (name) {
    return name;
  }
  return (profile.email ?? '').trim() || 'Unnamed user';
}

function entryTime(entry: AuditEntry): string {
  return entry.timestamp ?? entry.time ?? entry.createdAt ?? '';
}

/** Local `DD/MM/YYYY HH:mm` for display; the ISO value stays in `dateTime`. */
export function formatAuditTime(entry: AuditEntry): string {
  const raw = entryTime(entry);
  return raw ? formatLocalDateTime(raw) : '—';
}

/**
 * Actor display (S3): recorded actor name, then the `profiles` join, then a
 * neutral label. Never "Unknown" and never a raw user id.
 */
export function entryActor(
  entry: AuditEntry,
  profiles: readonly AuditProfile[] = [],
): string {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const named = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const text = value.trim();
    if (isUuid(text)) {
      return null; // never display a raw id
    }
    return text;
  };

  const recorded = typeof entry.actor === 'string'
    ? named(entry.actor)
    : entry.actor && typeof entry.actor === 'object'
      ? named(entry.actor.name) ?? named(entry.actor.email)
      : null;
  if (recorded) {
    return recorded;
  }
  if (entry.actorName && entry.actorName.trim()) {
    return entry.actorName.trim();
  }

  const rawActorId = typeof entry.actor === 'string' && isUuid(entry.actor)
    ? entry.actor.trim()
    : (entry.actorId ?? '').trim();
  const profile = rawActorId ? byId.get(rawActorId) : undefined;
  if (profile) {
    // Office is a shared account — never imply it identifies a person.
    if ((profile.role ?? '').toLowerCase() === 'office') {
      return 'Office (shared account)';
    }
    return profileName(profile);
  }

  return 'System (local action)';
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

/** Short human summary of an audit details payload (S3). */
export function summarizeAuditDetails(details: unknown): string {
  if (details === null || details === undefined || details === '') {
    return '—';
  }
  if (typeof details === 'string') {
    return details;
  }
  if (typeof details === 'object' && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    const parts = Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const label = key.replace(/_/g, ' ');
        const shown = value === null || value === ''
          ? '—'
          : typeof value === 'object' && value !== null
            ? ((value as { data?: unknown }).data && typeof (value as { data?: unknown }).data === 'object'
              ? JSON.stringify(((value as { data?: unknown }).data as Record<string, unknown>))
              : JSON.stringify(value))
            : String(value);
        return `${label}: ${shown}`;
      });
    return parts.join(' · ');
  }
  return String(details);
}

export interface AuditLogPageProps {
  entries: readonly AuditEntry[];
  role?: Role | string | null;
  /** Profile rows used to resolve audit actors (S3). */
  profiles?: readonly AuditProfile[];
}

interface LabelledEntry {
  entry: AuditEntry;
  actionLabel: string;
  actorLabel: string;
  timeLabel: string;
}

export function AuditLogPage({ entries, role, profiles = [] }: AuditLogPageProps) {
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const labelled = useMemo<LabelledEntry[]>(
    () => entries.map((entry) => ({
      entry,
      actionLabel: formatAuditAction(entry.action),
      actorLabel: entryActor(entry, profiles),
      timeLabel: formatAuditTime(entry),
    })),
    [entries, profiles],
  );

  const actionOptions = useMemo(
    () => Array.from(new Set(labelled.map((item) => item.actionLabel))).sort(),
    [labelled],
  );
  const actorOptions = useMemo(
    () => Array.from(new Set(labelled.map((item) => item.actorLabel))).sort(),
    [labelled],
  );

  const orderedEntries = useMemo<LabelledEntry[]>(() => {
    const filtered = labelled.filter((item) => {
      if (actionFilter && item.actionLabel !== actionFilter) {
        return false;
      }
      if (actorFilter && item.actorLabel !== actorFilter) {
        return false;
      }
      const rawTime = entryTime(item.entry);
      const time = rawTime ? new Date(rawTime).getTime() : NaN;
      if (fromDate && (!Number.isFinite(time) || time < new Date(`${fromDate}T00:00:00`).getTime())) {
        return false;
      }
      if (toDate && (!Number.isFinite(time) || time > new Date(`${toDate}T23:59:59.999`).getTime())) {
        return false;
      }
      return true;
    });
    return filtered.sort((left, right) => entryTime(right.entry).localeCompare(entryTime(left.entry)));
  }, [actionFilter, actorFilter, fromDate, labelled, toDate]);

  if (!can(role, 'auditLog')) {
    return (
      <section className="audit-log-page" role="alert" aria-label="Audit log access denied">
        Only administrators can access the audit log.
      </section>
    );
  }

  return (
    <section className="audit-log-page" aria-label="Audit log">
      {/* FIXES_UI §8: the page title lives in the top bar; the "Admin tools"
          eyebrow and duplicate h1 are removed. A compact count is kept. */}
      {orderedEntries.length > 0 ? (
        <p className="audit-log-page__count">{orderedEntries.length} recorded {orderedEntries.length === 1 ? 'action' : 'actions'}</p>
      ) : null}
      <div className="audit-log-filters" role="group" aria-label="Filter audit log">
        <label>
          Action
          <select aria-label="Filter by action" value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}>
            <option value="">All actions</option>
            {actionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Actor
          <select aria-label="Filter by actor" value={actorFilter} onChange={(event) => setActorFilter(event.target.value)}>
            <option value="">All actors</option>
            {actorOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          From date
          <input aria-label="Filter from date" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label>
          To date
          <input aria-label="Filter to date" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
      </div>
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
            {orderedEntries.map(({ entry, actionLabel, actorLabel, timeLabel }: LabelledEntry) => (
              <tr key={entry.id ?? `${entry.action}-${entryTime(entry)}-${entry.actorId ?? ''}`}>
                <td>{actionLabel}</td>
                <td>{actorLabel}</td>
                <td><time dateTime={entryTime(entry)}>{timeLabel}</time></td>
                <td>
                  <span>{summarizeAuditDetails(entry.details)}</span>
                  {entry.details && typeof entry.details === 'object' ? (
                    <details>
                      <summary>Show raw JSON</summary>
                      <pre>{formatAuditDetails(entry.details)}</pre>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default AuditLogPage;
