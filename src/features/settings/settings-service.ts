import type { PartialSettings, DksSettings } from './SettingsPage';

export interface SettingsQueryError {
  message: string;
}

export interface SettingsTable {
  select: (columns: string) => PromiseLike<{
    data: readonly unknown[] | null;
    error: SettingsQueryError | null;
  }>;
  upsert: (
    values: readonly Record<string, unknown>[],
    options?: { onConflict?: string },
  ) => PromiseLike<{
    data: readonly unknown[] | null;
    error: SettingsQueryError | null;
  }>;
}

export interface SettingsDataClient {
  from: (table: string) => SettingsTable;
}

export interface PersistedSetting {
  [key: string]: unknown;
  key: string;
  value: unknown;
}

const SETTINGS_KEYS = Object.freeze([
  'thresholds',
  'notification_days',
  'daily_summary_enabled',
  'currency',
  'theme',
  'primary_expiry_column_id',
] as const);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validSettingKey(value: unknown): value is (typeof SETTINGS_KEYS)[number] {
  return typeof value === 'string' && (SETTINGS_KEYS as readonly string[]).includes(value);
}

function rowsToSettings(rows: readonly unknown[]): PartialSettings {
  const values = new Map<string, unknown>();
  rows.forEach((value) => {
    const row = record(value);
    if (row && validSettingKey(row.key)) {
      values.set(row.key, row.value);
    }
  });

  const thresholds = record(values.get('thresholds'));
  const currency = record(values.get('currency'));
  const notificationDays = values.get('notification_days');
  const primaryExpiryColumnId = values.get('primary_expiry_column_id');
  const theme = values.get('theme');

  return {
    ...(thresholds ? { thresholds: thresholds as PartialSettings['thresholds'] } : {}),
    ...(Array.isArray(notificationDays)
      ? { notificationDays: notificationDays.filter((day): day is number => typeof day === 'number') }
      : {}),
    ...(typeof values.get('daily_summary_enabled') === 'boolean'
      ? { dailySummaryEnabled: values.get('daily_summary_enabled') as boolean }
      : {}),
    ...(currency ? { currency: currency as PartialSettings['currency'] } : {}),
    ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
    ...(typeof primaryExpiryColumnId === 'string' ? { primaryExpiryColumnId } : {}),
  };
}

export function settingsRecordToPartialSettings(
  values: Record<string, unknown>,
): PartialSettings {
  return rowsToSettings(Object.entries(values).map(([key, value]) => ({ key, value })));
}

export function partialSettingsToRecord(
  settings: PartialSettings,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (settings.thresholds) result.thresholds = settings.thresholds;
  if (settings.notificationDays) result.notification_days = settings.notificationDays;
  if (settings.dailySummaryEnabled !== undefined) result.daily_summary_enabled = settings.dailySummaryEnabled;
  if (settings.currency) result.currency = settings.currency;
  if (settings.theme) result.theme = settings.theme;
  if (settings.primaryExpiryColumnId !== undefined) result.primary_expiry_column_id = settings.primaryExpiryColumnId;
  return result;
}

export function settingsToRows(settings: DksSettings): PersistedSetting[] {
  return [
    { key: 'thresholds', value: settings.thresholds },
    { key: 'notification_days', value: settings.notificationDays },
    { key: 'daily_summary_enabled', value: settings.dailySummaryEnabled },
    { key: 'currency', value: settings.currency },
    { key: 'theme', value: settings.theme },
    { key: 'primary_expiry_column_id', value: settings.primaryExpiryColumnId },
  ];
}

export async function loadWorkspaceSettings(client: SettingsDataClient): Promise<PartialSettings> {
  const result = await client.from('settings').select('key,value');
  if (result.error) {
    throw new Error(result.error.message || 'Unable to load workspace settings.');
  }
  return rowsToSettings(result.data ?? []);
}

export async function saveWorkspaceSettings(
  client: SettingsDataClient,
  settings: DksSettings,
): Promise<void> {
  const result = await client.from('settings').upsert(settingsToRows(settings), { onConflict: 'key' });
  if (result.error) {
    throw new Error(result.error.message || 'Unable to save workspace settings.');
  }
}

export { SETTINGS_KEYS };
