import { useMemo, useState } from 'react';

import type { ColumnDefinition } from '../../lib/columns';
import { formatDisplayDate, formatLocalDateTime } from '../../lib/date';
import { rowDisplayLabel } from '../../lib/labels';
import { can } from '../../lib/permissions';
import type { Role } from '../auth/auth-types';
import type { SheetRow } from '../sheet/types';
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
  reorder_columns: 'Reordered columns',
  delete_column: 'Deleted column',
  record_conflict: 'Recorded conflict',
  merge_conflict: 'Merged conflict',
  clear_audit: 'Cleared the audit log',
  office_sessions_signed_out: 'Signed out all Office sessions',
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

/** Stable identity for a row/panel (falls back to a synthetic key). */
function rowKey(entry: AuditEntry): string {
  return entry.id ?? `${entry.action}-${entryTime(entry)}-${entry.actorId ?? ''}`;
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

export interface AuditDisplayContext {
  profiles?: readonly AuditProfile[];
  columns?: readonly ColumnDefinition[];
  rows?: readonly SheetRow[];
  entityType?: string | null;
  entityId?: string | null;
}

export interface AuditFieldLine {
  field: string;
  text: string;
}

const MISSING_AUDIT_VALUE = Symbol('missing audit value');
const MAX_AUDIT_VALUE_LENGTH = 120;
const SENSITIVE_AUDIT_KEY = /token|password|passwd|secret|api[-_]?key|authorization|credential|private[-_]?key/i;
const SNAPSHOT_OMITTED_KEYS = new Set([
  'id',
  'actor',
  'actorId',
  'actor_id',
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
  'createdBy',
  'updatedBy',
  'created_by',
  'updated_by',
  'deletedAt',
  'deleted_at',
  'version',
  'table',
]);
const FIELD_LABELS: Readonly<Record<string, string>> = {
  rowId: 'Record',
  row_id: 'Record',
  entryId: 'Record',
  entry_id: 'Record',
  recordId: 'Record',
  record_id: 'Record',
  columnId: 'Column',
  column_id: 'Column',
  userId: 'User',
  user_id: 'User',
  actorId: 'User',
  actor_id: 'User',
  fileName: 'File',
  file_name: 'File',
  importedRows: 'Imported records',
  imported_rows: 'Imported records',
  sourceRows: 'Source rows',
  source_rows: 'Source rows',
  deleted: 'Record state',
  order: 'Column order',
  civilId: 'Civil ID',
  civil_id: 'Civil ID',
  officeUsers: 'Office users',
  office_users: 'Office users',
  authSessionsDeleted: 'Sessions ended',
  auth_sessions_deleted: 'Sessions ended',
  refreshTokensDeleted: 'Refresh tokens removed',
  refresh_tokens_deleted: 'Refresh tokens removed',
  requestsRevoked: 'Approvals revoked',
  requests_revoked: 'Approvals revoked',
};

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncateAuditText(value: string, maxLength = MAX_AUDIT_VALUE_LENGTH): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizedAuditKey(key: string): string {
  return key.replace(/[\s_-]+/g, '').toLowerCase();
}

function auditFieldLabel(key: string, context: AuditDisplayContext): string {
  const column = context.columns?.find((candidate) => candidate.id === key || candidate.name === key);
  if (column) {
    return column.name;
  }
  if (FIELD_LABELS[key]) {
    return FIELD_LABELS[key];
  }
  if (isUuid(key)) {
    return 'Record field';
  }
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) {
    return 'Details';
  }
  return words
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/\bId\b/g, 'ID');
}

function resolveAuditRow(id: string, context: AuditDisplayContext): string | null {
  const row = context.rows?.find((candidate) => candidate.id === id);
  return row ? truncateAuditText(rowDisplayLabel(row, context.columns ?? [])) : null;
}

function resolveAuditColumn(id: string, context: AuditDisplayContext): string | null {
  const column = context.columns?.find((candidate) => candidate.id === id || candidate.name === id);
  return column ? truncateAuditText(column.name) : null;
}

function resolveAuditProfile(id: string, context: AuditDisplayContext): string | null {
  const profile = context.profiles?.find((candidate) => candidate.id === id);
  if (!profile) {
    return null;
  }
  if ((profile.role ?? '').toLowerCase() === 'office') {
    return 'Office (shared account)';
  }
  return truncateAuditText(profileName(profile));
}

function isRowIdKey(key: string): boolean {
  return ['rowid', 'entryid', 'recordid'].includes(normalizedAuditKey(key));
}

function isColumnIdKey(key: string): boolean {
  return normalizedAuditKey(key) === 'columnid';
}

function isUserIdKey(key: string): boolean {
  return [
    'userid',
    'actorid',
    'actor',
    'decidedby',
    'createdby',
    'updatedby',
    'deletedby',
    'renewedby',
  ].includes(normalizedAuditKey(key));
}

function formatAuditValue(key: string, value: unknown, context: AuditDisplayContext): string {
  if (value === MISSING_AUDIT_VALUE || value === null || value === undefined || value === '') {
    return '—';
  }
  if (SENSITIVE_AUDIT_KEY.test(key)) {
    return 'Hidden';
  }
  if (typeof value === 'boolean') {
    if (normalizedAuditKey(key) === 'deleted') {
      return value ? 'In Recycle Bin' : 'Active';
    }
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'None';
    }
    const itemKey = normalizedAuditKey(key) === 'order' ? 'columnId' : key;
    const shown = value.slice(0, 4).map((item) => formatAuditValue(itemKey, item, context));
    if (value.length > shown.length) {
      shown.push(`${value.length - shown.length} more`);
    }
    return truncateAuditText(shown.join(', '));
  }
  if (isAuditRecord(value)) {
    if ('old' in value || 'new' in value) {
      const oldValue = 'old' in value ? value.old : MISSING_AUDIT_VALUE;
      const newValue = 'new' in value ? value.new : MISSING_AUDIT_VALUE;
      return `${formatAuditValue(key, oldValue, context)} → ${formatAuditValue(key, newValue, context)}`;
    }
    const count = Object.entries(value).filter(([entryKey, entryValue]) => (
      entryValue !== undefined && !SNAPSHOT_OMITTED_KEYS.has(entryKey)
    )).length;
    return count === 0 ? '—' : count === 1 ? '1 detail recorded' : `${count} details recorded`;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return '—';
    }
    if (isRowIdKey(key)) {
      return resolveAuditRow(text, context) ?? 'Record no longer available';
    }
    if (isColumnIdKey(key)) {
      return resolveAuditColumn(text, context) ?? 'Column no longer available';
    }
    if (isUserIdKey(key) && isUuid(text)) {
      return resolveAuditProfile(text, context) ?? 'User no longer available';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return formatDisplayDate(text);
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
      return formatLocalDateTime(text);
    }
    if (isUuid(text)) {
      const resolved = resolveAuditRow(text, context)
        ?? resolveAuditColumn(text, context)
        ?? resolveAuditProfile(text, context);
      if (resolved) {
        return resolved;
      }
      return normalizedAuditKey(key).endsWith('id')
        ? 'Linked item no longer available'
        : 'Unavailable';
    }
    return truncateAuditText(text);
  }
  return truncateAuditText(String(value));
}

function stableAuditValue(value: unknown, seen = new WeakSet<object>()): string {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '"[circular]"';
    }
    seen.add(value);
    const result = `[${value.map((item) => stableAuditValue(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (isAuditRecord(value)) {
    if (seen.has(value)) {
      return '"[circular]"';
    }
    seen.add(value);
    const result = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableAuditValue(value[key], seen)}`
    )).join(',')}}`;
    seen.delete(value);
    return result;
  }
  return JSON.stringify(value) ?? String(value);
}

function sameAuditValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || stableAuditValue(left) === stableAuditValue(right);
}

function snapshotFields(snapshot: unknown): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (!isAuditRecord(snapshot)) {
    return fields;
  }
  const add = (key: string, value: unknown) => {
    if (value !== undefined && !SNAPSHOT_OMITTED_KEYS.has(key)) {
      fields.set(key, value);
    }
  };
  if (isAuditRecord(snapshot.data)) {
    Object.entries(snapshot.data).forEach(([key, value]) => add(key, value));
  }
  Object.entries(snapshot).forEach(([key, value]) => {
    if (key !== 'data') {
      add(key, value);
    }
  });
  return fields;
}

function diffAuditSnapshots(
  before: unknown,
  after: unknown,
  context: AuditDisplayContext,
): AuditFieldLine[] {
  const beforeFields = snapshotFields(before);
  const afterFields = snapshotFields(after);
  const keys: string[] = [];
  const addKey = (key: string) => {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  };

  context.columns?.forEach((column) => {
    if (beforeFields.has(column.id) || afterFields.has(column.id)) {
      addKey(column.id);
    } else if (beforeFields.has(column.name) || afterFields.has(column.name)) {
      addKey(column.name);
    }
  });
  beforeFields.forEach((_value, key) => addKey(key));
  afterFields.forEach((_value, key) => addKey(key));

  const lines: AuditFieldLine[] = [];
  keys.forEach((key) => {
    const hasBefore = beforeFields.has(key);
    const hasAfter = afterFields.has(key);
    const beforeValue = hasBefore ? beforeFields.get(key) : MISSING_AUDIT_VALUE;
    const afterValue = hasAfter ? afterFields.get(key) : MISSING_AUDIT_VALUE;
    if (hasBefore && hasAfter && sameAuditValue(beforeValue, afterValue)) {
      return;
    }
    lines.push({
      field: auditFieldLabel(key, context),
      text: `${formatAuditValue(key, beforeValue, context)} → ${formatAuditValue(key, afterValue, context)}`,
    });
  });
  return lines;
}

function genericAuditFieldLines(
  record: Record<string, unknown>,
  context: AuditDisplayContext,
  prefix = '',
  depth = 0,
): AuditFieldLine[] {
  const lines: AuditFieldLine[] = [];
  Object.entries(record).forEach(([key, value]) => {
    if (value === undefined || key === 'table') {
      return;
    }
    if (key === 'data' && isAuditRecord(value)) {
      lines.push(...genericAuditFieldLines(value, context, prefix, depth + 1));
      return;
    }

    const ownLabel = auditFieldLabel(key, context);
    const field = prefix ? `${prefix} · ${ownLabel}` : ownLabel;

    if (isAuditRecord(value) && ('old' in value || 'new' in value)) {
      lines.push({ field, text: formatAuditValue(key, value, context) });
      return;
    }
    if (isAuditRecord(value) && ('before' in value || 'after' in value)) {
      const diff = diffAuditSnapshots(value.before, value.after, context);
      if (diff.length > 0) {
        if (normalizedAuditKey(key) === 'snapshot') {
          lines.push(...diff);
        } else {
          lines.push(...diff.map((line) => ({ field: `${field} · ${line.field}`, text: line.text })));
        }
      } else {
        lines.push({ field, text: 'No field changes recorded.' });
      }
      return;
    }
    if (isAuditRecord(value)) {
      if (depth >= 2) {
        lines.push({ field, text: formatAuditValue(key, value, context) });
        return;
      }
      const nested = genericAuditFieldLines(value, context, field, depth + 1);
      if (nested.length > 0) {
        lines.push(...nested);
      } else {
        lines.push({ field, text: '—' });
      }
      return;
    }

    lines.push({ field, text: formatAuditValue(key, value, context) });
  });
  return lines;
}

function snapshotRecordData(snapshot: unknown): Record<string, unknown> | null {
  if (!isAuditRecord(snapshot)) {
    return null;
  }
  return isAuditRecord(snapshot.data) ? snapshot.data : snapshot;
}

function entityAuditFieldLine(
  details: unknown,
  context: AuditDisplayContext,
): AuditFieldLine | null {
  if (!context.entityId) {
    return null;
  }
  const entityId = context.entityId;
  const type = (context.entityType ?? '').toLowerCase();
  const detailsRecord = isAuditRecord(details) ? details : null;
  const before = detailsRecord?.before;
  const after = detailsRecord?.after;

  if (type.includes('column')) {
    const snapshotName = [after, before].find((snapshot) => (
      isAuditRecord(snapshot) && typeof snapshot.name === 'string' && snapshot.name.trim()
    ));
    const label = resolveAuditColumn(entityId, context)
      ?? (isAuditRecord(snapshotName) ? truncateAuditText(String(snapshotName.name)) : null);
    return { field: 'Column', text: label ?? 'Column no longer available' };
  }

  if (type.includes('entry') || type.includes('record') || type.includes('row')) {
    const resolved = resolveAuditRow(entityId, context);
    if (resolved) {
      return { field: 'Record', text: resolved };
    }
    const snapshotData = snapshotRecordData(after) ?? snapshotRecordData(before);
    if (snapshotData) {
      const label = rowDisplayLabel({ id: entityId, data: snapshotData }, context.columns ?? []);
      if (label !== 'Unnamed record') {
        return { field: 'Record', text: truncateAuditText(label) };
      }
    }
    return { field: 'Record', text: 'Record no longer available' };
  }

  const rowLabel = resolveAuditRow(entityId, context);
  if (rowLabel) {
    return { field: 'Record', text: rowLabel };
  }
  const columnLabel = resolveAuditColumn(entityId, context);
  return columnLabel ? { field: 'Column', text: columnLabel } : null;
}

/**
 * Render an audit payload as readable field lines. Real `{ before, after }`
 * snapshots are diffed field by field; other payloads are flattened without
 * ever falling back to JSON in the normal user view.
 */
export function formatAuditFieldLines(
  details: unknown,
  context: AuditDisplayContext = {},
): AuditFieldLine[] {
  if (details === null || details === undefined || details === '') {
    return [];
  }
  if (!isAuditRecord(details)) {
    return [{ field: 'Details', text: formatAuditValue('details', details, context) }];
  }

  let lines: AuditFieldLine[];
  if ('before' in details || 'after' in details) {
    const { before, after, ...rest } = details;
    lines = [
      ...genericAuditFieldLines(rest, context),
      ...diffAuditSnapshots(before, after, context),
    ];
    if (lines.length === 0) {
      lines = [{ field: 'Changes', text: 'No field changes recorded.' }];
    }
  } else if (isAuditRecord(details.snapshot) && ('before' in details.snapshot || 'after' in details.snapshot)) {
    const { snapshot, ...rest } = details;
    lines = [
      ...genericAuditFieldLines(rest, context),
      ...diffAuditSnapshots(snapshot.before, snapshot.after, context),
    ];
    if (lines.length === 0) {
      lines = [{ field: 'Changes', text: 'No field changes recorded.' }];
    }
  } else {
    lines = genericAuditFieldLines(details, context);
  }

  const entityLine = entityAuditFieldLine(details, context);
  if (entityLine && !lines.some((line) => line.field === entityLine.field)) {
    lines = [entityLine, ...lines];
  }
  return lines;
}

/** Short human summary of an audit details payload (S3). */
export function summarizeAuditDetails(
  details: unknown,
  context: AuditDisplayContext = {},
): string {
  if (details === null || details === undefined || details === '') {
    return 'No details recorded.';
  }
  const lines = formatAuditFieldLines(details, context);
  if (lines.length === 0) {
    return 'No details recorded.';
  }
  const parts = lines.slice(0, 3).map((line) => `${line.field}: ${line.text}`);
  if (lines.length > 3) {
    parts.push(`+${lines.length - 3} more`);
  }
  return truncateAuditText(parts.join(' · '), 320);
}

/**
 * FIXES_UI §8 (AUDIT-04): scrub credential-looking keys before showing raw
 * JSON so tokens/passwords/secrets are never exposed in the details panel.
 */
export function sanitizeAuditDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditDetails(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_AUDIT_KEY.test(key)
        ? '•••'
        : sanitizeAuditDetails(inner);
    }
    return out;
  }
  return value;
}

export interface AuditLogPageProps {
  entries: readonly AuditEntry[];
  role?: Role | string | null;
  /** Profile rows used to resolve audit actors (S3). */
  profiles?: readonly AuditProfile[];
  /** Current columns/rows used only to label fields and linked records. */
  columns?: readonly ColumnDefinition[];
  rows?: readonly SheetRow[];
}

interface LabelledEntry {
  entry: AuditEntry;
  actionLabel: string;
  actorLabel: string;
  timeLabel: string;
}

export function AuditLogPage({
  entries,
  role,
  profiles = [],
  columns = [],
  rows = [],
}: AuditLogPageProps) {
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const labelled = useMemo<LabelledEntry[]>(
    () => entries.map((entry) => ({
      entry,
      actionLabel: formatAuditAction(entry.action),
      actorLabel: entryActor(entry, profiles),
      timeLabel: formatAuditTime(entry),
    })),
    [entries, profiles],
  );

  const selected = useMemo(
    () => (selectedId ? (labelled.find((item) => rowKey(item.entry) === selectedId) ?? null) : null),
    [labelled, selectedId],
  );

  const displayContextFor = (entry: AuditEntry): AuditDisplayContext => ({
    profiles,
    columns,
    rows,
    entityType: entry.entityType,
    entityId: entry.entityId,
  });

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

  const selectedFieldLines = selected
    ? formatAuditFieldLines(selected.entry.details, displayContextFor(selected.entry))
    : [];

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
              <tr key={rowKey(entry)}>
                <td>{actionLabel}</td>
                <td>{actorLabel}</td>
                <td><time dateTime={entryTime(entry)}>{timeLabel}</time></td>
                <td>
                  <button
                    type="button"
                    className="audit-log-view"
                    onClick={() => setSelectedId(rowKey(entry))}
                  >
                    View
                  </button>
                  <span className="audit-log-summary">
                    {summarizeAuditDetails(entry.details, displayContextFor(entry))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* Details side panel: readable field transitions first, with one
          collapsed, sanitized technical view for administrators. */}
      {selected ? (
        <aside className="audit-log-details" aria-label="Event details">
          <div className="audit-log-details__header">
            <div>
              <p className="audit-log-details__action">{selected.actionLabel}</p>
              <p className="audit-log-details__meta">{selected.actorLabel} · {selected.timeLabel}</p>
            </div>
            <button
              type="button"
              className="audit-log-details__close"
              aria-label="Close event details"
              onClick={() => setSelectedId(null)}
            >
              Close
            </button>
          </div>
          <ul className="audit-log-details__fields">
            {(selectedFieldLines.length > 0
              ? selectedFieldLines
              : [{ field: 'Details', text: selected.entry.details === null || selected.entry.details === undefined || selected.entry.details === '' ? 'No details recorded.' : String(selected.entry.details) }]
            ).map((line, index) => (
              <li key={`${line.field}-${index}`}>
                <span className="audit-log-details__field">{line.field}</span>
                <span className="audit-log-details__value">{line.text}</span>
              </li>
            ))}
          </ul>
          {selected.entry.details && typeof selected.entry.details === 'object' ? (
            <details className="audit-log-details__raw">
              <summary>Technical details</summary>
              <pre>{JSON.stringify(sanitizeAuditDetails(selected.entry.details), null, 2)}</pre>
            </details>
          ) : null}
        </aside>
      ) : null}
    </section>
  );
}

export default AuditLogPage;
