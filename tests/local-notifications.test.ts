import { describe, expect, it } from 'vitest';

import {
  fromLocalNotification,
  toLocalNotificationInput,
} from '../src/features/notifications/local-notifications';
import type { ExpiryNotificationRecord } from '../src/features/notifications/alert-service';

const record: ExpiryNotificationRecord = {
  id: 'expiry:row-1:2026-01-08:7',
  kind: 'expiry',
  rowId: 'row-1',
  expiryColumnId: 'visa_expiry',
  expiryValue: '2026-01-08',
  daysLeft: 7,
  alertDay: 7,
  dedupeKey: 'expiry:row-1:2026-01-08:7',
  title: 'Expiry reminder',
  body: 'Amina expires in 7 days.',
  createdAt: '2026-01-01T09:00:00.000Z',
  read: false,
  dismissed: false,
};

describe('local notification serialization', () => {
  it('round-trips an expiry record while keeping local read state authoritative', () => {
    const input = toLocalNotificationInput(record);
    const restored = fromLocalNotification({
      id: 5,
      ...input,
      payload: { ...input.payload, read: false },
      read: true,
      dismissed: false,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
    });

    expect(restored).toEqual({ ...record, read: true });
  });

  it('ignores an unrecognised local notification payload', () => {
    expect(fromLocalNotification({
      id: 1,
      type: 'other',
      message: 'Unsupported',
      payload: {},
      read: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toBeNull();
  });
});
