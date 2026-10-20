import { describe, expect, it } from 'vitest';

import {
  loadWorkspaceSettings,
  saveWorkspaceSettings,
  type SettingsDataClient,
} from '../src/features/settings/settings-service';
import { DEFAULT_SETTINGS, type DksSettings } from '../src/features/settings/SettingsPage';

function settings(): DksSettings {
  return {
    ...DEFAULT_SETTINGS,
    thresholds: {
      ...DEFAULT_SETTINGS.thresholds,
      validAbove: 120,
      colors: { ...DEFAULT_SETTINGS.thresholds.colors, Valid: '#123456' },
    },
    notificationDays: [45, 7, 0],
    dailySummaryEnabled: false,
    currency: { code: 'OMR', symbol: 'ر.ع.', decimals: 3 },
    primaryExpiryColumnId: 'visa_expiry',
    theme: 'dark',
  };
}

describe('Supabase settings persistence', () => {
  it('loads typed settings rows into the settings model', async () => {
    const client: SettingsDataClient = {
      from: () => ({
        select: async () => ({
          data: [
            { key: 'thresholds', value: { validAbove: 120, colors: { Valid: '#123456' } } },
            { key: 'notification_days', value: [45, 7, 0] },
            { key: 'daily_summary_enabled', value: false },
            { key: 'currency', value: { code: 'OMR', symbol: 'ر.ع.', decimals: 3 } },
            { key: 'theme', value: 'dark' },
            { key: 'primary_expiry_column_id', value: 'visa_expiry' },
          ],
          error: null,
        }),
        upsert: async () => ({ data: [], error: null }),
      }),
    };

    await expect(loadWorkspaceSettings(client)).resolves.toEqual(expect.objectContaining({
      thresholds: expect.objectContaining({ validAbove: 120 }),
      notificationDays: [45, 7, 0],
      dailySummaryEnabled: false,
      theme: 'dark',
      primaryExpiryColumnId: 'visa_expiry',
    }));
  });

  it('upserts every shared settings key and reports remote failures', async () => {
    const calls: Array<{ values: readonly Record<string, unknown>[]; options?: { onConflict?: string } }> = [];
    const client: SettingsDataClient = {
      from: () => ({
        select: async () => ({ data: [], error: null }),
        upsert: async (values, options) => {
          calls.push({ values, options });
          return { data: values, error: null };
        },
      }),
    };

    await saveWorkspaceSettings(client, settings());

    expect(calls[0]?.options).toEqual({ onConflict: 'key' });
    expect(calls[0]?.values).toEqual(expect.arrayContaining([
      { key: 'notification_days', value: [45, 7, 0] },
      { key: 'daily_summary_enabled', value: false },
      { key: 'theme', value: 'dark' },
      { key: 'primary_expiry_column_id', value: 'visa_expiry' },
    ]));

    const failingClient: SettingsDataClient = {
      from: () => ({
        select: async () => ({ data: [], error: null }),
        upsert: async () => ({ data: null, error: { message: 'settings offline' } }),
      }),
    };
    await expect(saveWorkspaceSettings(failingClient, settings())).rejects.toThrow('settings offline');
  });
});
