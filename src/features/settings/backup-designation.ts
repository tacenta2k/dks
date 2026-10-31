import type { DksBackupDesignation } from '../../lib/types';
import type { SettingsDataClient } from './settings-service';

/**
 * The designated Admin backup PC.
 *
 * Stored in `public.settings` — a shared, authoritative, key/value row. RLS on
 * that table allows INSERT/UPDATE/DELETE for **Admins only**
 * (`supabase/schema.sql`, `settings_insert_admin` / `settings_update_admin`),
 * so the row is the authority both the desktop app and the Cloudflare Worker
 * read. A local "I am designated" flag on some other PC cannot substitute for
 * it: the Worker re-reads this row with the uploader's own JWT on every upload
 * and refuses anything else with `DEVICE_NOT_DESIGNATED`.
 */
export const BACKUP_DESIGNATION_KEY = 'dks.backup.designated_device';

/** Opaque random device id: 16 random bytes, hex. Never a hostname or PII. */
export const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/i;

const LABEL_MAX = 60;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read the designation. Returns `null` when no PC has been designated yet,
 * which is a normal state on a fresh install — not an error.
 */
export async function readDesignation(client: SettingsDataClient): Promise<DksBackupDesignation | null> {
  const result = await client.from('settings').select('key,value');
  if (result.error) {
    throw new Error(result.error.message || 'Unable to read the designated backup PC.');
  }
  for (const row of result.data ?? []) {
    const record = asRecord(row);
    if (!record || record.key !== BACKUP_DESIGNATION_KEY) continue;
    const value = asRecord(record.value);
    if (!value) return null;
    const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim().toLowerCase() : '';
    if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
    return {
      deviceId,
      label: typeof value.label === 'string' ? value.label.slice(0, LABEL_MAX) : '',
      designatedAt: typeof value.designatedAt === 'string' ? value.designatedAt : null,
    };
  }
  return null;
}

/**
 * Make `deviceId` the designated backup PC.
 *
 * This **transfers** automatic backup duty: the PC that was designated stops
 * scheduling, and this one starts. Nothing is implicit — an administrator has
 * to confirm the transfer in the UI before this is called.
 */
export async function claimDesignation(
  client: SettingsDataClient,
  input: { deviceId: string; label: string; designatedAt?: string | null },
): Promise<DksBackupDesignation> {
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim().toLowerCase() : '';
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('That device identifier is not valid.');
  }
  const label = (typeof input.label === 'string' ? input.label : '').trim().slice(0, LABEL_MAX);
  if (label.length === 0) {
    throw new Error('A device label is required.');
  }
  const designatedAt = typeof input.designatedAt === 'string' && input.designatedAt.length > 0
    ? input.designatedAt
    : new Date().toISOString();
  const designation: DksBackupDesignation = { deviceId, label, designatedAt };
  const result = await client.from('settings').upsert(
    [{ key: BACKUP_DESIGNATION_KEY, value: designation }],
    { onConflict: 'key' },
  );
  if (result.error) {
    throw new Error(result.error.message || 'Unable to designate this PC as the backup PC.');
  }
  return designation;
}
