import type {
  OfficeDeleteNotificationRecord,
} from './alert-service';

export interface AdminNotificationQueryError {
  message: string;
}

interface AdminNotificationRow {
  id: number | string;
  type?: unknown;
  message?: unknown;
  payload?: unknown;
  read?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
}

interface AdminNotificationQuery {
  select: (columns: string) => PromiseLike<{
    data: readonly AdminNotificationRow[] | null;
    error: AdminNotificationQueryError | null;
  }>;
  update: (values: Record<string, unknown>) => PromiseLike<{
    data: readonly unknown[] | null;
    error: AdminNotificationQueryError | null;
  }> | {
    eq: (column: string, value: string | number) => PromiseLike<{
      data: readonly unknown[] | null;
      error: AdminNotificationQueryError | null;
    }>;
  };
}

export interface AdminNotificationClient {
  from: (table: string) => AdminNotificationQuery;
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: AdminNotificationQueryError | null;
  }>;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapOfficeDelete(row: AdminNotificationRow): OfficeDeleteNotificationRecord | null {
  const payload = payloadRecord(row.payload);
  if (row.type !== 'delete') {
    return null;
  }
  const entryId = typeof payload.entry_id === 'string' ? payload.entry_id : '';
  // A missing/blank server label (or one that is just the entry id) is not a
  // usable human label — display "Unnamed record", never the raw UUID.
  const suppliedLabel = typeof payload.row_label === 'string' ? payload.row_label.trim() : '';
  const rowLabel = suppliedLabel && suppliedLabel !== entryId ? suppliedLabel : 'Unnamed record';
  const message = typeof row.message === 'string' && row.message.trim()
    ? row.message
    : `Office deleted ${rowLabel}`;
  const createdAt = typeof row.created_at === 'string'
    ? row.created_at
    : typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString();
  if (!entryId) {
    return null;
  }
  return {
    id: `admin-notification-${String(row.id)}`,
    kind: 'office-delete',
    entryId,
    rowLabel,
    title: 'Office deleted',
    body: message,
    createdAt,
    read: row.read === true,
    dismissed: false,
  };
}

export async function loadAdminNotifications(
  client: AdminNotificationClient,
): Promise<OfficeDeleteNotificationRecord[]> {
  const result = await client.from('admin_notifications').select('*');
  if (result.error) {
    throw new Error(result.error.message || 'Unable to load administrator notifications.');
  }
  return (result.data ?? [])
    .map(mapOfficeDelete)
    .filter((record): record is OfficeDeleteNotificationRecord => record !== null);
}

export async function dismissAdminNotification(
  client: AdminNotificationClient,
  id: string,
): Promise<void> {
  const numericId = id.replace(/^admin-notification-/, '');
  const query = client.from('admin_notifications').update({ read: true });
  const result = 'eq' in query
    ? await query.eq('id', Number.isNaN(Number(numericId)) ? numericId : Number(numericId))
    : await query;
  if (result.error) {
    throw new Error(result.error.message || 'Unable to dismiss administrator notification.');
  }
}

export async function restoreDeletedEntry(
  client: AdminNotificationClient,
  entryId: string,
): Promise<void> {
  const result = await client.rpc('restore_entry', { p_entry_id: entryId });
  if (result.error) {
    throw new Error(result.error.message || 'Unable to restore the deleted entry.');
  }
}
