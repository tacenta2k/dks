import {
  calculateDaysLeft,
  DKS_BUSINESS_TIME_ZONE,
  isValidIsoDate,
  type StatusThresholds,
} from '../../lib/date';
import {
  getPrimaryExpiryColumn,
  type ColumnDefinition,
} from '../../lib/columns';
import { rowDisplayLabel } from '../../lib/labels';

/** The default milestones are deliberately explicit and stable for sync/idempotency. */
export const DEFAULT_ALERT_DAYS = Object.freeze([90, 60, 30, 15, 7, 1, 0] as const);

export type AlertColumn = Pick<
  ColumnDefinition,
  'id' | 'name' | 'type' | 'isPrimaryExpiry' | 'is_primary_expiry'
>;

export interface AlertRow {
  id: string;
  data?: Record<string, unknown>;
  deleted?: boolean;
  category?: string | null;
  [key: string]: unknown;
}

export type SnoozeDuration = '1d' | '3d' | '1w' | 'custom';

export interface AlertSnooze {
  rowId?: string;
  entryId?: string;
  entry_id?: string;
  until?: string;
  snoozedUntil?: string;
  snoozed_until?: string;
  expiryValue?: string | null;
  expiry_value?: string | null;
  dismissedUntilExpiryChange?: boolean;
  dismissed_until_expiry_change?: boolean;
}

export interface ExpiryNotificationRecord {
  id: string;
  kind: 'expiry';
  rowId: string;
  expiryColumnId: string;
  expiryValue: string;
  daysLeft: number;
  alertDay: number;
  dedupeKey: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  dismissed: boolean;
  snoozedUntil?: string;
}

export type SummaryKind = 'daily' | 'weekly';
export type SummaryNotificationKind = `${SummaryKind}-summary`;

export interface SummaryNotificationRecord {
  id: string;
  kind: SummaryNotificationKind;
  summaryDate: string;
  title: string;
  body: string;
  alertCount: number;
  alertIds: string[];
  createdAt: string;
  read: boolean;
  dismissed: boolean;
}

export interface OfficeDeleteNotificationRecord {
  id: string;
  kind: 'office-delete';
  entryId: string;
  rowLabel: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  dismissed: boolean;
}

export type NotificationRecord =
  | ExpiryNotificationRecord
  | SummaryNotificationRecord
  | OfficeDeleteNotificationRecord;

/**
 * Stable UI identity for a notification: (kind, rowId/entryId, milestone).
 * Two records describing the SAME logical alert (e.g. an old evaluation kept
 * the pre-renewal expiry value, a re-run created the current one) get DIFFER
 * ids (`expiry:rowId:VALUE:day`), so merging by id alone lets both surface as
 * duplicate cards. The expiry value is intentionally NOT part of the key —
 * after a renewal the old value's record collapses into the current one.
 */
export function notificationStableKey(record: NotificationRecord): string {
  if (record.kind === 'expiry') {
    return `expiry:${record.rowId}:${record.alertDay}`;
  }
  if (record.kind === 'office-delete') {
    return `office-delete:${record.entryId}`;
  }
  return `${record.kind}:${record.summaryDate}`;
}

/** A snooze in the future suppresses the alert (R2-02). */
export function isNotificationSnoozed(record: NotificationRecord, now = Date.now()): boolean {
  return (
    record.kind === 'expiry'
    && typeof record.snoozedUntil === 'string'
    && new Date(record.snoozedUntil).getTime() > now
  );
}

/**
 * Collapse a notification list to one card per stable key, keeping the
 * record that best represents the alert's newest state.
 *
 * Two passes:
 *   1. EXACT-DUPLICATE collapse (same id): a store row can appear twice in a
 *      merged feed (persisted row + live evaluation of the same row). It is
 *      literally the same record — keep the most *actionable* view of it:
 *      undismissed > dismissed, unsnoozed > actively-snoozed, then the
 *      newest createdAt, then the later position.
 *   2. KEY-KEY collapse (same logical alert, DIFFERENT ids — e.g. an old
 *      evaluation kept the pre-renewal expiry value while a re-run created
 *      the current one):
 *      a. an undismissed record beats a dismissed one;
 *      b. an actively snoozed record beats a fresh regenerated twin (the
 *         user's snooze must hold against a re-generated alert);
 *      c. otherwise the newest `createdAt` wins; ties keep the later
 *         position.
 * The surviving record occupies the group's FIRST position so list order
 * (newest first from the local store) stays stable.
 */
export function dedupeNotifications(
  records: readonly NotificationRecord[],
  now = Date.now(),
): NotificationRecord[] {
  // Pass 1 — exact duplicates (same id) collapse to the most ACTIONABLE view
  // of that single store row: undismissed beats dismissed, unsnoozed beats
  // actively-snoozed, newest createdAt breaks remaining ties (later position
  // holds on a full tie). A persisted row and a live evaluation of the same
  // alert share an id and are literally the same record — they merge here.
  const byId = new Map<string, NotificationRecord>();
  records.forEach((record) => {
    const seen = byId.get(record.id);
    if (!seen) {
      byId.set(record.id, record);
      return;
    }
    const actionable = (candidate: NotificationRecord): number => (
      (candidate.dismissed === true ? 0 : 1e12)
      + (isNotificationSnoozed(candidate, now) ? 0 : 1e6)
      + new Date(candidate.createdAt).getTime() / 1e3
    );
    if (actionable(record) >= actionable(seen)) {
      byId.set(record.id, record);
    }
  });

  // Pass 2 — key collapse (same logical alert, different ids: a re-generated
  // twin vs the stored, possibly snoozed, original).
  const groups = new Map<string, { position: number; winner: NotificationRecord }>();
  for (const record of byId.values()) {
    const key = notificationStableKey(record);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { position: groups.size, winner: record });
      continue;
    }
    const score = (candidate: NotificationRecord): number => {
      // Read above (rules a-c): a dismissed record always loses; an ACTIVELY
      // snoozed record beats a fresh regenerated twin (the user's snooze must
      // hold against a re-run), otherwise the newest createdAt decides.
      const stateScore = candidate.dismissed === true
        ? -1e18
        : isNotificationSnoozed(candidate, now)
          ? 1e12
          : 0;
      return stateScore + new Date(candidate.createdAt).getTime() / 1e3;
    };
    const incumbent = score(group.winner);
    const challenger = score(record);
    // Strictly better, or an exact tie: the LATER record wins (rule c).
    if (challenger >= incumbent) {
      group.winner = record;
    }
  }
  return Array.from(groups.values())
    .sort((left, right) => left.position - right.position)
    .map((group) => group.winner);
}

export interface AlertThresholds extends StatusThresholds {
  alertDays?: readonly number[];
}

export type DismissedExpiryInput =
  | readonly {
    rowId?: string;
    entryId?: string;
    expiryValue?: string | null;
    expiry_value?: string | null;
  }[]
  | Readonly<Record<
    string,
    string | null | { expiryValue?: string | null; expiry_value?: string | null } | undefined
  >>;

export interface AlertEvaluationOptions {
  rows: readonly AlertRow[];
  columns?: readonly AlertColumn[];
  primaryExpiryColumn?: AlertColumn | null;
  primaryExpiryColumnId?: string;
  now?: string | Date;
  today?: string | Date;
  thresholds?: AlertThresholds;
  alertDays?: readonly number[];
  snoozes?: readonly AlertSnooze[] | Record<string, unknown>;
  dismissedExpiryValues?: Readonly<Record<string, string | null | undefined>>;
  dismissed?: DismissedExpiryInput;
  existingNotifications?: readonly NotificationRecord[];
  existingRecords?: readonly NotificationRecord[];
  previousNotifications?: readonly NotificationRecord[];
  rowLabel?: string | ((row: AlertRow) => string);
}

export interface SummaryEvaluationOptions {
  alerts?: readonly ExpiryNotificationRecord[];
  rows?: readonly AlertRow[];
  columns?: readonly AlertColumn[];
  now?: string | Date;
  thresholds?: AlertThresholds;
  alertDays?: readonly number[];
  existingNotifications?: readonly NotificationRecord[];
  summaryWindowMinutes?: number;
}

export interface NotificationStore {
  add: (record: NotificationRecord) => NotificationRecord;
  list: () => NotificationRecord[];
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const DEFAULT_SUMMARY_HOUR = 9;
const DEFAULT_SUMMARY_WINDOW_MINUTES = 15;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asDate(value: string | Date | undefined): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (typeof value === 'string' && value.trim()) {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (dateOnly) {
      return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

const businessClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: DKS_BUSINESS_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function businessParts(date: Date): { year: string; month: string; day: string; hour: number; minute: number } {
  const parts = businessClock.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  return { year: get('year'), month: get('month'), day: get('day'), hour: Number(get('hour')), minute: Number(get('minute')) };
}

function localDateKey(value: string | Date | undefined): string {
  // Date-only inputs are already calendar dates, not UTC instants.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const { year, month, day } = businessParts(asDate(value));
  return `${year}-${month}-${day}`;
}

function serialiseDate(value: string | Date | undefined): string {
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? `${localDateKey(value)}T00:00:00.000Z` : date.toISOString();
}

function valueForColumn(row: AlertRow, column: Pick<AlertColumn, 'id' | 'name'>): unknown {
  const data = row.data;
  if (data && data[column.id] !== undefined) {
    return data[column.id];
  }
  if (data && data[column.name] !== undefined) {
    return data[column.name];
  }
  if (row[column.id] !== undefined) {
    return row[column.id];
  }
  return row[column.name];
}

/** Return the value used by the alert evaluator, always from the primary expiry. */
export function primaryExpiryValue(
  row: AlertRow,
  columns: readonly AlertColumn[] = [],
  primaryExpiryColumn?: AlertColumn | null,
  primaryExpiryColumnId?: string,
): string | null {
  const column = primaryExpiryColumn
    ?? (primaryExpiryColumnId
      ? columns.find((candidate) => candidate.id === primaryExpiryColumnId) ?? null
      : null)
    ?? getPrimaryExpiryColumn(columns as readonly ColumnDefinition[]);

  const value = column
    ? valueForColumn(row, column)
    : row.primaryExpiry ?? row.primary_expiry ?? row.expiry ?? row.expiryDate ?? row.expiry_date;

  return typeof value === 'string' && isValidIsoDate(value.trim()) ? value.trim() : null;
}

export const getPrimaryExpiryValue = primaryExpiryValue;

function normaliseAlertDays(
  alertDays: readonly number[] | undefined,
  thresholds: AlertThresholds | undefined,
): number[] {
  const configured = alertDays ?? thresholds?.alertDays ?? DEFAULT_ALERT_DAYS;
  return Array.from(new Set(configured.filter((day) => Number.isInteger(day) && day >= 0)))
    .sort((left, right) => right - left);
}

function normaliseSnoozes(value: AlertEvaluationOptions['snoozes']): AlertSnooze[] {
  if (Array.isArray(value)) {
    return value.flatMap((snooze) => {
      if (!isRecord(snooze)) {
        return [];
      }
      const rowId = typeof snooze.rowId === 'string'
        ? snooze.rowId
        : typeof snooze.entryId === 'string'
          ? snooze.entryId
          : typeof snooze.entry_id === 'string' ? snooze.entry_id : null;
      const until = typeof snooze.until === 'string'
        ? snooze.until
        : typeof snooze.snoozedUntil === 'string'
          ? snooze.snoozedUntil
          : typeof snooze.snoozed_until === 'string' ? snooze.snoozed_until : null;
      if (!rowId || !until) {
        return [];
      }
      return [{
        rowId,
        until,
        expiryValue: typeof snooze.expiryValue === 'string'
          ? snooze.expiryValue
          : typeof snooze.expiry_value === 'string' ? snooze.expiry_value : null,
        dismissedUntilExpiryChange: snooze.dismissedUntilExpiryChange === true
          || snooze.dismissed_until_expiry_change === true,
      }];
    });
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([rowId, entry]) => {
    if (typeof entry === 'string') {
      return [{ rowId, until: entry }];
    }
    if (isRecord(entry) && (
      typeof entry.until === 'string'
      || typeof entry.snoozedUntil === 'string'
      || typeof entry.snoozed_until === 'string'
    )) {
      return [{
        rowId,
        until: typeof entry.until === 'string'
          ? entry.until
          : typeof entry.snoozedUntil === 'string'
            ? entry.snoozedUntil
            : entry.snoozed_until as string,
        expiryValue: typeof entry.expiryValue === 'string'
          ? entry.expiryValue
          : typeof entry.expiry_value === 'string' ? entry.expiry_value : null,
        dismissedUntilExpiryChange: entry.dismissedUntilExpiryChange === true
          || entry.dismissed_until_expiry_change === true,
      }];
    }
    return [];
  });
}

function snoozeApplies(
  snoozes: readonly AlertSnooze[],
  rowId: string,
  expiryValue: string,
  now: Date,
): boolean {
  return snoozes.some((snooze) => {
    const snoozeRowId = snooze.rowId ?? snooze.entryId ?? snooze.entry_id;
    const snoozeExpiry = snooze.expiryValue ?? snooze.expiry_value;
    if (snoozeRowId !== rowId || (snoozeExpiry && snoozeExpiry !== expiryValue)) {
      return false;
    }
    const until = new Date(snooze.until ?? snooze.snoozedUntil ?? snooze.snoozed_until ?? '');
    return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
  });
}

function dismissedExpiryApplies(
  options: AlertEvaluationOptions,
  snoozes: readonly AlertSnooze[],
  rowId: string,
  expiryValue: string,
): boolean {
  const mapped = options.dismissedExpiryValues?.[rowId];
  if (mapped !== undefined && mapped === expiryValue) {
    return true;
  }

  if (snoozes.some((snooze) => (
    (snooze.dismissedUntilExpiryChange === true || snooze.dismissed_until_expiry_change === true)
    && (snooze.rowId ?? snooze.entryId ?? snooze.entry_id) === rowId
    && (!(snooze.expiryValue ?? snooze.expiry_value)
      || (snooze.expiryValue ?? snooze.expiry_value) === expiryValue)
  ))) {
    return true;
  }

  if (Array.isArray(options.dismissed)) {
    return options.dismissed.some((dismissed) => (
      (dismissed.rowId ?? dismissed.entryId) === rowId
      && (dismissed.expiryValue ?? dismissed.expiry_value) === expiryValue
    ));
  }

  const dismissedMap = options.dismissed as Exclude<DismissedExpiryInput, readonly unknown[]> | undefined;
  const dismissedValue = dismissedMap?.[rowId];
  if (typeof dismissedValue === 'string') {
    return dismissedValue === expiryValue;
  }
  return isRecord(dismissedValue)
    && (dismissedValue.expiryValue ?? dismissedValue.expiry_value) === expiryValue;
}

function existingNotificationList(options: AlertEvaluationOptions): readonly NotificationRecord[] {
  return [
    ...(options.existingNotifications ?? []),
    ...(options.existingRecords ?? []),
    ...(options.previousNotifications ?? []),
  ];
}

const UNNAMED_RECORD = 'Unnamed record';

function isDateShapedLabel(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value.trim())
    || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value.trim());
}

/**
 * A notification label is usable only when it is real human text: never the
 * raw entry id (a UUID) and never a date value (dates are not names).
 */
function usableNotificationLabel(value: unknown, rowId: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === rowId || isDateShapedLabel(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Human label for an expiry notification, resolved from the shared
 * `rowDisplayLabel` (the workspace's customer-visible columns, looked up by
 * column id AND column name). Falls back to a non-date scan of the row's own
 * values, then its category, then exactly "Unnamed record" — never a UUID.
 * Note this is intentionally NOT the email-digest label: email payloads use
 * their own redacted server-side label and are untouched by this path.
 */
export function expiryRowLabel(
  row: AlertRow,
  columns: readonly AlertColumn[] = [],
): string {
  const shared = rowDisplayLabel(
    { id: row.id, data: row.data ?? {} },
    columns,
  );
  if (shared !== UNNAMED_RECORD) {
    const usable = usableNotificationLabel(shared, row.id);
    if (usable) {
      return usable;
    }
  }
  const data = row.data ?? {};
  const preferredKeys = Object.keys(data).filter((key) => /name/i.test(key));
  const otherKeys = Object.keys(data).filter((key) => !preferredKeys.includes(key));
  for (const key of [...preferredKeys, ...otherKeys]) {
    const value = data[key];
    const usable = usableNotificationLabel(value, row.id);
    if (usable) {
      return usable;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return usableNotificationLabel(row.category, row.id) ?? UNNAMED_RECORD;
}

function rowName(
  row: AlertRow,
  label: AlertEvaluationOptions['rowLabel'],
  columns: readonly AlertColumn[] = [],
): string {
  const supplied = typeof label === 'function' ? label(row) : label;
  // A caller-supplied label wins only when it is usable human text — a label
  // callback that hands back the row id (or a date) must never reach a
  // notification body.
  return usableNotificationLabel(supplied, row.id) ?? expiryRowLabel(row, columns);
}

function dayText(daysLeft: number): string {
  if (daysLeft === 0) {
    return 'today';
  }
  return `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}

function expiryDedupeKey(rowId: string, expiryValue: string, alertDay: number): string {
  return `expiry:${rowId}:${expiryValue}:${alertDay}`;
}

/** The single source for an expiry notification's sentence. */
export function expiryNotificationBody(label: string, daysLeft: number): string {
  return `${label} expires ${dayText(daysLeft)}.`;
}

const GENERATED_EXPIRY_BODY = /^[\s\S]+ expires (?:today|in \d+ days?)\.$/;

/**
 * Rebuild the DISPLAY text of an already-persisted expiry notification from
 * the row's current human label. Older records may carry a body baked in
 * with the raw entry UUID (the label lookup used to fall back to `row.id`);
 * those must render safely after reload without deleting history.
 *
 * Only bodies that match the machine-generated expiry sentence are rebuilt —
 * anything else is returned verbatim so unexpected text is never rewritten.
 * Record id, dedupe key, milestone, expiry value, read/dismissed/snooze
 * state and timestamps are all preserved exactly.
 */
export function refreshExpiryNotificationLabel(
  record: ExpiryNotificationRecord,
  row: AlertRow | null | undefined,
  columns: readonly AlertColumn[] = [],
): ExpiryNotificationRecord {
  const expected = expiryNotificationBody(
    row ? expiryRowLabel(row, columns) : UNNAMED_RECORD,
    record.daysLeft,
  );
  if (record.body === expected || !GENERATED_EXPIRY_BODY.test(record.body)) {
    return record;
  }
  return { ...record, body: expected };
}

/** Refresh every expiry record in a merged notification feed (other kinds pass through). */
export function refreshExpiryNotificationLabels(
  records: readonly NotificationRecord[],
  rows: readonly AlertRow[],
  columns: readonly AlertColumn[] = [],
): NotificationRecord[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return records.map((record) => (
    record.kind === 'expiry'
      ? refreshExpiryNotificationLabel(record, rowsById.get(record.rowId), columns)
      : record
  ));
}

/**
 * Evaluate the current Muscat calendar day without touching Electron, storage,
 * or the network.  A record's stable dedupe key makes hourly evaluations safe.
 */
export function evaluateAlerts(options: AlertEvaluationOptions): ExpiryNotificationRecord[] {
  const nowValue = options.now ?? options.today;
  const now = asDate(nowValue);
  const today = localDateKey(nowValue);
  const alertDays = normaliseAlertDays(options.alertDays, options.thresholds);
  const snoozes = normaliseSnoozes(options.snoozes);
  const existingExpiryRecords = existingNotificationList(options)
    .filter((record): record is ExpiryNotificationRecord => record.kind === 'expiry');
  const existingKeys = new Set(existingExpiryRecords
    .map((record) => record.dedupeKey ?? expiryDedupeKey(record.rowId, record.expiryValue, record.alertDay)));
  const dismissedExpiryKeys = new Set(existingExpiryRecords
    .filter((record) => record.dismissed === true)
    .map((record) => `${record.rowId}:${record.expiryValue}`));

  const primaryColumn = options.primaryExpiryColumn
    ?? (options.primaryExpiryColumnId
      ? options.columns?.find((column) => column.id === options.primaryExpiryColumnId) ?? null
      : null)
    ?? getPrimaryExpiryColumn((options.columns ?? []) as readonly ColumnDefinition[]);
  const expiryColumnId = primaryColumn?.id ?? 'primary-expiry';

  const records = options.rows
    .filter((row) => row.deleted !== true && typeof row.id === 'string' && row.id.length > 0)
    .flatMap((row) => {
      const expiryValue = primaryExpiryValue(row, options.columns, primaryColumn, options.primaryExpiryColumnId);
      if (!expiryValue) {
        return [];
      }

      const daysLeft = calculateDaysLeft(expiryValue, today);
      if (daysLeft === null || !alertDays.includes(daysLeft)) {
        return [];
      }
      if (snoozeApplies(snoozes, row.id, expiryValue, now)) {
        return [];
      }
      if (dismissedExpiryApplies(options, snoozes, row.id, expiryValue)) {
        return [];
      }
      if (dismissedExpiryKeys.has(`${row.id}:${expiryValue}`)) {
        return [];
      }

      const dedupeKey = expiryDedupeKey(row.id, expiryValue, daysLeft);
      if (existingKeys.has(dedupeKey)) {
        return [];
      }

      const label = rowName(row, options.rowLabel, options.columns ?? []);
      const record: ExpiryNotificationRecord = {
        id: dedupeKey,
        kind: 'expiry',
        rowId: row.id,
        expiryColumnId,
        expiryValue,
        daysLeft,
        alertDay: daysLeft,
        dedupeKey,
        title: daysLeft === 0 ? 'Expiry due today' : 'Expiry reminder',
        body: expiryNotificationBody(label, daysLeft),
        createdAt: serialiseDate(now),
        read: false,
        dismissed: false,
      };
      existingKeys.add(dedupeKey);
      return [record];
    });

  return records.sort((left, right) => (
    right.daysLeft - left.daysLeft || left.rowId.localeCompare(right.rowId)
  ));
}

export const evaluateExpiryAlerts = evaluateAlerts;

function summaryDateFor(value: string | Date | undefined): string {
  return localDateKey(value);
}

function summaryRecordId(kind: SummaryKind, date: string): string {
  return `${kind}-summary:${date}`;
}

/** Return summaries due in the Asia/Muscat 09:00 business window. */
export function getSummaryKinds(
  value: string | Date | undefined,
  summaryHour = DEFAULT_SUMMARY_HOUR,
  summaryWindowMinutes = DEFAULT_SUMMARY_WINDOW_MINUTES,
): SummaryKind[] {
  const date = businessParts(asDate(value));
  const minuteOfDay = date.hour * 60 + date.minute;
  const start = summaryHour * 60;
  const window = Number.isFinite(summaryWindowMinutes) && summaryWindowMinutes > 0
    ? summaryWindowMinutes
    : DEFAULT_SUMMARY_WINDOW_MINUTES;

  if (minuteOfDay < start || minuteOfDay >= start + window) {
    return [];
  }

  const kinds: SummaryKind[] = ['daily'];
  const weekday = new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day))).getUTCDay();
  if (weekday === 1) {
    kinds.push('weekly');
  }
  return kinds;
}

export const summaryKindsFor = getSummaryKinds;

export function getSummaryKind(value: string | Date | undefined): SummaryKind | null {
  const kinds = getSummaryKinds(value);
  return kinds.includes('weekly') ? 'weekly' : kinds[0] ?? null;
}

export function evaluateSummaryNotifications(
  options: SummaryEvaluationOptions,
): SummaryNotificationRecord[] {
  const nowValue = options.now;
  const date = summaryDateFor(nowValue);
  const kinds = getSummaryKinds(nowValue, DEFAULT_SUMMARY_HOUR, options.summaryWindowMinutes);
  if (kinds.length === 0) {
    return [];
  }

  const alerts = options.alerts
    ? [...options.alerts]
    : options.rows
      ? evaluateAlerts({
        rows: options.rows,
        columns: options.columns,
        now: nowValue,
        thresholds: options.thresholds,
        alertDays: options.alertDays,
      })
      : [];
  const existing = new Set((options.existingNotifications ?? [])
    .filter((record): record is SummaryNotificationRecord => (
      record.kind === 'daily-summary' || record.kind === 'weekly-summary'
    ))
    .map((record) => record.id));
  const createdAt = serialiseDate(nowValue);

  return kinds.flatMap((kind) => {
    const id = summaryRecordId(kind, date);
    if (existing.has(id)) {
      return [];
    }
    const label = kind === 'weekly' ? 'Weekly' : 'Daily';
    const count = alerts.length;
    return [{
      id,
      kind: `${kind}-summary` as SummaryNotificationKind,
      summaryDate: date,
      title: `${label} expiry summary`,
      body: count === 0
        ? 'No expiry alerts are due.'
        : `${count} expiry alert${count === 1 ? '' : 's'} due.`,
      alertCount: count,
      alertIds: alerts.map((alert) => alert.id),
      createdAt,
      read: false,
      dismissed: false,
    } satisfies SummaryNotificationRecord];
  });
}

export function snoozeUntil(
  duration: SnoozeDuration,
  now: string | Date = new Date(),
  customUntil?: string | Date | number,
): string {
  if (duration === 'custom') {
    const custom = customUntil === undefined
      ? asDate(now)
      : customUntil instanceof Date
        ? customUntil
        : new Date(customUntil);
    if (!Number.isNaN(custom.getTime())) {
      return custom.toISOString();
    }
  }

  const result = asDate(now);
  const days = duration === '1d' ? 1 : duration === '3d' ? 3 : 7;
  // Oman has no DST; fixed day durations avoid the host PC's DST rules.
  return new Date(result.getTime() + days * 86_400_000).toISOString();
}

export function createSnooze(
  rowId: string,
  duration: SnoozeDuration,
  now: string | Date = new Date(),
  expiryValue?: string | null,
  customUntil?: string | Date | number,
): AlertSnooze {
  return {
    rowId,
    until: snoozeUntil(duration, now, customUntil),
    ...(expiryValue === undefined ? {} : { expiryValue }),
  };
}

export const makeSnooze = createSnooze;

function cloneRecord(record: NotificationRecord): NotificationRecord {
  const summary = record.kind === 'daily-summary' || record.kind === 'weekly-summary';
  return {
    ...record,
    ...(summary ? { alertIds: [...record.alertIds] } : {}),
  } as NotificationRecord;
}

/** Small renderer-safe record store; a repository can persist the same shape later. */
export function createInAppNotificationStore(
  initial: readonly NotificationRecord[] = [],
): NotificationStore {
  const records = new Map<string, NotificationRecord>();
  initial.forEach((record) => records.set(record.id, cloneRecord(record)));

  const update = (id: string, changes: Partial<NotificationRecord>): void => {
    const current = records.get(id);
    if (!current) {
      return;
    }
    records.set(id, cloneRecord({ ...current, ...changes } as NotificationRecord));
  };

  return {
    add: (record) => {
      const current = records.get(record.id);
      if (current) {
        return cloneRecord(current);
      }
      const copy = cloneRecord(record);
      records.set(copy.id, copy);
      return cloneRecord(copy);
    },
    list: () => Array.from(records.values(), cloneRecord),
    markRead: (id) => update(id, { read: true }),
    markAllRead: () => records.forEach((record) => update(record.id, { read: true })),
    dismiss: (id) => update(id, { dismissed: true }),
    remove: (id) => {
      records.delete(id);
    },
    clear: () => {
      records.clear();
    },
  };
}

export const createNotificationStore = createInAppNotificationStore;
