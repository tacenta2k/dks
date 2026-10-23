import {
  calculateDaysLeft,
  isValidIsoDate,
  type StatusThresholds,
} from '../../lib/date';
import {
  getPrimaryExpiryColumn,
  type ColumnDefinition,
} from '../../lib/columns';

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
 * record that best represents the alert's newest state:
 *   1. an undismissed record beats a dismissed one;
 *   2. an actively snoozed record beats a fresh duplicate (the user's snooze
 *      must hold against a re-generated twin);
 *   3. otherwise the newest `createdAt` wins; ties keep the later position.
 * The surviving record occupies the group's FIRST position so list order
 * (newest first from the local store) stays stable.
 */
export function dedupeNotifications(
  records: readonly NotificationRecord[],
  now = Date.now(),
): NotificationRecord[] {
  const groups = new Map<string, { position: number; winner: NotificationRecord }>();
  records.forEach((record, index) => {
    const key = notificationStableKey(record);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { position: groups.size, winner: record });
      return;
    }
    const score = (candidate: NotificationRecord): number => {
      // Read above (rules 1-3).
      const stateScore = candidate.dismissed === true
        ? -1e15
        : isNotificationSnoozed(candidate, now)
          ? -1e9
          : 0;
      return stateScore + new Date(candidate.createdAt).getTime() / 1e3;
    };
    const incumbent = score(group.winner);
    const challenger = score(record);
    // Strictly better, or an exact tie: the LATER record wins (rule 3).
    if (challenger >= incumbent) {
      group.winner = record;
    }
  });
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

function localDateKey(value: string | Date | undefined): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const date = asDate(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
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

function rowName(row: AlertRow, label: AlertEvaluationOptions['rowLabel']): string {
  const supplied = typeof label === 'function' ? label(row) : label;
  if (typeof supplied === 'string' && supplied.trim()) {
    return supplied.trim();
  }
  // S1: human label from the row's own values — never a raw row UUID and
  // never a date value (dates are not names).
  const data = row.data ?? {};
  const isDateShaped = (value: string) => (
    /^\d{4}-\d{2}-\d{2}/.test(value.trim()) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value.trim())
  );
  const preferredKeys = Object.keys(data).filter((key) => /name/i.test(key));
  const otherKeys = Object.keys(data).filter((key) => !preferredKeys.includes(key));
  for (const key of [...preferredKeys, ...otherKeys]) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() && !isDateShaped(value)) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  if (typeof row.category === 'string' && row.category.trim()) {
    return row.category.trim();
  }
  return 'Unnamed record';
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

/**
 * Evaluate the current local calendar day without touching Electron, storage,
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

      const label = rowName(row, options.rowLabel);
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
        body: `${label} expires ${dayText(daysLeft)}.`,
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

/** Return the summaries due in the local 09:00 window. */
export function getSummaryKinds(
  value: string | Date | undefined,
  summaryHour = DEFAULT_SUMMARY_HOUR,
  summaryWindowMinutes = DEFAULT_SUMMARY_WINDOW_MINUTES,
): SummaryKind[] {
  const date = asDate(value);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  const start = summaryHour * 60;
  const window = Number.isFinite(summaryWindowMinutes) && summaryWindowMinutes > 0
    ? summaryWindowMinutes
    : DEFAULT_SUMMARY_WINDOW_MINUTES;

  if (minuteOfDay < start || minuteOfDay >= start + window) {
    return [];
  }

  const kinds: SummaryKind[] = ['daily'];
  if (date.getDay() === 1) {
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
  result.setDate(result.getDate() + days);
  return result.toISOString();
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
