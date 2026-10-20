import type { DksLocalNotificationRecord } from '../../lib/types';
import type {
  ExpiryNotificationRecord,
  NotificationRecord,
  SummaryNotificationRecord,
} from './alert-service';

export interface LocalNotificationInput {
  type: NotificationRecord['kind'];
  message: string;
  payload: Record<string, unknown>;
  read: boolean;
  dismissed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expiryFromPayload(
  payload: Record<string, unknown>,
  local: DksLocalNotificationRecord,
): ExpiryNotificationRecord | null {
  if (
    payload.kind !== 'expiry'
    || typeof payload.id !== 'string'
    || typeof payload.rowId !== 'string'
    || typeof payload.expiryColumnId !== 'string'
    || typeof payload.expiryValue !== 'string'
    || typeof payload.daysLeft !== 'number'
    || typeof payload.alertDay !== 'number'
    || typeof payload.dedupeKey !== 'string'
    || typeof payload.title !== 'string'
    || typeof payload.body !== 'string'
  ) {
    return null;
  }

  return {
    id: payload.id,
    kind: 'expiry',
    rowId: payload.rowId,
    expiryColumnId: payload.expiryColumnId,
    expiryValue: payload.expiryValue,
    daysLeft: payload.daysLeft,
    alertDay: payload.alertDay,
    dedupeKey: payload.dedupeKey,
    title: payload.title,
    body: payload.body,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : local.createdAt,
    read: local.read,
    dismissed: local.dismissed ?? payload.dismissed === true,
    ...(typeof payload.snoozedUntil === 'string' ? { snoozedUntil: payload.snoozedUntil } : {}),
  };
}

function summaryFromPayload(
  payload: Record<string, unknown>,
  local: DksLocalNotificationRecord,
): SummaryNotificationRecord | null {
  if (
    (payload.kind !== 'daily-summary' && payload.kind !== 'weekly-summary')
    || typeof payload.id !== 'string'
    || typeof payload.summaryDate !== 'string'
    || typeof payload.title !== 'string'
    || typeof payload.body !== 'string'
    || typeof payload.alertCount !== 'number'
    || !Array.isArray(payload.alertIds)
    || !payload.alertIds.every((id) => typeof id === 'string')
  ) {
    return null;
  }

  return {
    id: payload.id,
    kind: payload.kind,
    summaryDate: payload.summaryDate,
    title: payload.title,
    body: payload.body,
    alertCount: payload.alertCount,
    alertIds: [...payload.alertIds],
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : local.createdAt,
    read: local.read,
    dismissed: local.dismissed ?? payload.dismissed === true,
  };
}

export function fromLocalNotification(
  local: DksLocalNotificationRecord,
): NotificationRecord | null {
  const payload = isRecord(local.payload) ? local.payload : {};
  return expiryFromPayload(payload, local) ?? summaryFromPayload(payload, local);
}

export function toLocalNotificationInput(record: NotificationRecord): LocalNotificationInput {
  return {
    type: record.kind,
    message: record.body,
    payload: { ...record },
    read: record.read,
    dismissed: record.dismissed,
  };
}
