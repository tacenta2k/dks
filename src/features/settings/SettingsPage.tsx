import { useEffect, useRef, useState } from 'react';
import { Github } from 'lucide-react';

import {
  DEFAULT_STATUS_COLORS,
  type StatusColors,
} from '../../lib/domain';
import {
  DEFAULT_THRESHOLDS,
  type StatusThresholds,
} from '../../lib/date';
import { getPrimaryExpiryColumn, type ColumnDefinition } from '../../lib/columns';
import { can } from '../../lib/permissions';
import {
  TACENTA_GITHUB_URL,
  openExternalUrl,
  resolveAppVersion,
} from '../../lib/app-info';
import { EmailNotificationsSection } from './EmailNotificationsSection';
import type { EmailPrefsClient } from './email-preferences';
import type { ThemePreference } from '../../lib/types';
import dksLogo from '../../assets/dks-logo.png';
import dksLogoDark from '../../assets/dks-logo-dark.png';
import type { Role } from '../auth/auth-types';
import type { SheetRepository } from '../sheet/repository';
import './settings.css';

export interface SettingsThresholds extends StatusThresholds {
  colors: StatusColors;
}

export interface CurrencySettings {
  code: string;
  symbol: string;
  decimals: number;
}

export interface DksSettings {
  thresholds: SettingsThresholds;
  notificationDays: number[];
  dailySummaryEnabled: boolean;
  dailySummaryTime: string;
  weeklySummaryEnabled: boolean;
  weeklySummaryDay: number;
  weeklySummaryTime: string;
  currency: CurrencySettings;
  primaryExpiryColumnId: string;
  theme: ThemePreference;
}

export type SettingsState = DksSettings;
export type SettingsValues = DksSettings;

export interface PartialSettings {
  thresholds?: Partial<StatusThresholds> & {
    colors?: Partial<StatusColors> | Record<string, string>;
  };
  colors?: Partial<StatusColors> | Record<string, string>;
  notificationDays?: number[];
  dailySummaryEnabled?: boolean;
  dailySummaryTime?: string;
  weeklySummaryEnabled?: boolean;
  weeklySummaryDay?: number;
  weeklySummaryTime?: string;
  currency?: Partial<CurrencySettings>;
  primaryExpiryColumnId?: string;
  theme?: ThemePreference;
}

export interface SettingsPageProps {
  role?: Role | string | null;
  settings?: PartialSettings;
  initialSettings?: PartialSettings;
  columns?: readonly ColumnDefinition[];
  repository?: SheetRepository;
  onSettingsChange?: (settings: DksSettings) => void | Promise<void>;
  onChange?: (settings: DksSettings) => void | Promise<void>;
  /**
   * Admin-only: the Supabase settings client used by the "Email
   * notifications" section (recipients/toggles for the server-side email
   * worker). The Resend key is never available here.
   */
  emailPrefsClient?: EmailPrefsClient | null;
  appVersion?: string;
  version?: string;
  onCheckForUpdates?: () => void | Promise<void>;
  onUpdate?: () => void | Promise<void>;
  resendNote?: string;
  settingsError?: string | null;
  onClose?: () => void;
}

export const DEFAULT_NOTIFICATION_DAYS = Object.freeze([90, 60, 30, 15, 7, 1, 0]);

export const DEFAULT_SETTINGS: DksSettings = {
  thresholds: {
    ...DEFAULT_THRESHOLDS,
    colors: { ...DEFAULT_STATUS_COLORS },
  },
  notificationDays: [...DEFAULT_NOTIFICATION_DAYS],
  dailySummaryEnabled: true,
  dailySummaryTime: '09:00',
  weeklySummaryEnabled: false,
  weeklySummaryDay: 1,
  weeklySummaryTime: '09:00',
  currency: {
    code: 'OMR',
    symbol: 'ر.ع.',
    decimals: 3,
  },
  primaryExpiryColumnId: '',
  theme: 'light',
};

const STATUS_COLOR_FIELDS: ReadonlyArray<{
  key: keyof StatusColors;
  label: string;
}> = [
  { key: 'Valid', label: 'Green status color' },
  { key: 'Expiring Soon', label: 'Yellow status color' },
  { key: 'Urgent', label: 'Urgent status color' },
  { key: 'Expires today', label: 'Today status color' },
  { key: 'Expired', label: 'Expired status color' },
];

/** FIXES_UI §9.1: approved inner navigation (one section at a time). */
export type SettingsSectionId = 'expiry' | 'notifications' | 'workspace' | 'about';

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: 'expiry', label: 'Expiry rules' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'about', label: 'About & updates' },
];

interface ResolvedSettingsInput extends PartialSettings {
  primaryExpiryColumnId?: string;
}

function mergeColorSettings(
  input: Partial<StatusColors> | Record<string, string> | undefined,
): StatusColors {
  const supplied = (input ?? {}) as Partial<StatusColors> & Record<string, string | undefined>;
  return {
    ...DEFAULT_STATUS_COLORS,
    ...(supplied.Valid !== undefined ? { Valid: supplied.Valid } : {}),
    ...(supplied['Expiring Soon'] !== undefined ? { 'Expiring Soon': supplied['Expiring Soon'] } : {}),
    ...(supplied.Urgent !== undefined ? { Urgent: supplied.Urgent } : {}),
    ...(supplied['Expires today'] !== undefined ? { 'Expires today': supplied['Expires today'] } : {}),
    ...(supplied.Expired !== undefined ? { Expired: supplied.Expired } : {}),
    ...(supplied.green !== undefined ? { Valid: supplied.green } : {}),
    ...(supplied.yellow !== undefined ? { 'Expiring Soon': supplied.yellow } : {}),
    ...(supplied.orange !== undefined ? { Urgent: supplied.orange } : {}),
    ...(supplied.red !== undefined ? { 'Expires today': supplied.red } : {}),
    ...(supplied.darkRed !== undefined ? { Expired: supplied.darkRed } : {}),
  };
}

const WEEKDAY_LABELS: readonly [string, number][] = [
  ['Monday', 1],
  ['Tuesday', 2],
  ['Wednesday', 3],
  ['Thursday', 4],
  ['Friday', 5],
  ['Saturday', 6],
  ['Sunday', 7],
];

function normalizeTimeOfDay(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : fallback;
}

function normalizeWeekday(value: unknown, fallback: number): number {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 7 ? day : fallback;
}

function resolveSettings(
  input: ResolvedSettingsInput | undefined,
  columns: readonly ColumnDefinition[] = [],
): DksSettings {
  const suppliedThresholds = input?.thresholds ?? {};
  const expiryColumn = getPrimaryExpiryColumn(columns);
  // A blank (or stale) stored id must not win over the actual primary expiry
  // column: only accept an id that exists among the active expiry columns.
  const suppliedExpiryId = typeof input?.primaryExpiryColumnId === 'string'
    ? input.primaryExpiryColumnId.trim()
    : '';
  const activeExpiryColumns = columns.filter((column) => (
    column.deleted !== true && column.type === 'date_expiry'
  ));
  const resolvedExpiryId = activeExpiryColumns.some((column) => column.id === suppliedExpiryId)
    ? suppliedExpiryId
    : expiryColumn?.id ?? '';
  return {
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...suppliedThresholds,
      colors: mergeColorSettings(input?.colors ?? suppliedThresholds.colors),
    },
    notificationDays: input?.notificationDays?.map((day) => Number(day)).filter(Number.isFinite)
      ?? [...DEFAULT_NOTIFICATION_DAYS],
    dailySummaryEnabled: input?.dailySummaryEnabled ?? DEFAULT_SETTINGS.dailySummaryEnabled,
    dailySummaryTime: normalizeTimeOfDay(input?.dailySummaryTime, DEFAULT_SETTINGS.dailySummaryTime),
    weeklySummaryEnabled: input?.weeklySummaryEnabled ?? DEFAULT_SETTINGS.weeklySummaryEnabled,
    weeklySummaryDay: normalizeWeekday(input?.weeklySummaryDay, DEFAULT_SETTINGS.weeklySummaryDay),
    weeklySummaryTime: normalizeTimeOfDay(input?.weeklySummaryTime, DEFAULT_SETTINGS.weeklySummaryTime),
    currency: {
      ...DEFAULT_SETTINGS.currency,
      ...(input?.currency ?? {}),
      decimals: Number.isFinite(input?.currency?.decimals)
        ? Number(input?.currency?.decimals)
        : DEFAULT_SETTINGS.currency.decimals,
    },
    primaryExpiryColumnId: resolvedExpiryId,
    theme: input?.theme ?? DEFAULT_SETTINGS.theme,
  };
}

function defaultVersion(): string {
  return resolveAppVersion();
}

export function SettingsPage({
  role,
  settings: providedSettings,
  initialSettings,
  columns: providedColumns,
  repository,
  onSettingsChange,
  onChange,
  emailPrefsClient = null,
  appVersion,
  version,
  onCheckForUpdates,
  onUpdate,
  resendNote = 'Resend is optional for hosted email notifications; local alerts continue to work without a Resend API key.',
  settingsError = null,
  onClose,
}: SettingsPageProps) {
  const [columns, setColumns] = useState<ColumnDefinition[]>(() => [...(providedColumns ?? [])]);
  const [settings, setSettings] = useState<DksSettings>(() => (
    resolveSettings(providedSettings ?? initialSettings, providedColumns ?? [])
  ));
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('expiry');
  const mountedRef = useRef(false);

  useEffect(() => {
    if (providedColumns) {
      setColumns([...providedColumns]);
      return undefined;
    }
    if (!repository) {
      return undefined;
    }

    let cancelled = false;
    void repository.getColumns().then((nextColumns) => {
      if (cancelled) {
        return;
      }
      setColumns(nextColumns);
      setSettings((current) => current.primaryExpiryColumnId
        ? current
        : { ...current, primaryExpiryColumnId: getPrimaryExpiryColumn(nextColumns)?.id ?? '' });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [providedColumns, repository]);

  useEffect(() => {
    if (!providedSettings) {
      return;
    }
    setSettings(resolveSettings(providedSettings, columns));
  }, [columns, providedSettings]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    try {
      const results = [onSettingsChange?.(settings), onChange?.(settings)]
        .filter((result): result is Promise<void> => Boolean(result && typeof result.then === 'function'));
      if (results.length > 0) {
        void Promise.all(results)
          .then(() => setStatusMessage('Settings saved to the workspace.'))
          .catch(() => setStatusMessage('Saved locally; cloud sync failed. Changes will retry when online.'));
      }
    } catch {
      setStatusMessage('Saved locally; cloud sync failed. Changes will retry when online.');
    }
  }, [onChange, onSettingsChange, settings]);

  if (!can(role, 'settings')) {
    return (
      <section className="settings-page settings-page--denied" aria-label="Settings access" role="alert">
        <h2>Settings unavailable</h2>
        <p>Settings are available to administrators only.</p>
        {onClose ? <button className="button" type="button" onClick={onClose}>Back</button> : null}
      </section>
    );
  }

  const activeExpiryColumns = columns.filter((column) => column.deleted !== true && column.type === 'date_expiry');
  const updateHandler = onCheckForUpdates ?? onUpdate;
  const resolvedVersion = appVersion ?? version ?? defaultVersion();
  const updateSettings = (patch: (current: DksSettings) => DksSettings) => {
    setSettings((current) => patch(current));
    setStatusMessage('Settings saved locally.');
  };

  const updateColor = (key: keyof StatusColors, value: string) => {
    updateSettings((current) => ({
      ...current,
      thresholds: {
        ...current.thresholds,
        colors: { ...current.thresholds.colors, [key]: value },
      },
    }));
  };

  const updateThreshold = (key: keyof StatusThresholds, value: string) => {
    const parsed = Number(value);
    updateSettings((current) => ({
      ...current,
      thresholds: { ...current.thresholds, [key]: Number.isFinite(parsed) ? parsed : 0 },
    }));
  };

  const updateNotificationDay = (index: number, value: string) => {
    const parsed = Number(value);
    updateSettings((current) => ({
      ...current,
      notificationDays: current.notificationDays.map((day, currentIndex) => (
        currentIndex === index && Number.isFinite(parsed) ? parsed : day
      )),
    }));
  };

  const invokeAction = (action: (() => void | Promise<void>) | undefined, success: string, failure: string) => {
    if (!action) {
      setStatusMessage(success);
      return;
    }
    try {
      const result = action();
      if (result && typeof (result as Promise<void>).then === 'function') {
        void Promise.resolve(result).then(() => setStatusMessage(success)).catch(() => setStatusMessage(failure));
      } else {
        setStatusMessage(success);
      }
    } catch {
      setStatusMessage(failure);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav__item${activeSection === item.id ? ' settings-nav__item--active' : ''}`}
              aria-current={activeSection === item.id ? 'page' : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {statusMessage ? <div className="settings-alert" role="status">{statusMessage}</div> : null}
          {settingsError ? <div className="settings-alert settings-alert--error" role="alert">{settingsError}</div> : null}

          {activeSection === 'expiry' ? (
            <section className="settings-section" aria-labelledby="expiry-settings-title">
              <div className="settings-section__heading">
                <div>
                  <p className="settings-eyebrow">Expiry rules</p>
                  <h2 id="expiry-settings-title">Thresholds and alerts</h2>
                </div>
                <span className="settings-section__hint">Applied locally first</span>
              </div>
              <div className="settings-field-grid settings-field-grid--four">
                {STATUS_COLOR_FIELDS.map(({ key, label }) => (
                  <label className="settings-field" key={key}>
                    <span>{label}</span>
                    <input
                      aria-label={label}
                      type="color"
                      value={settings.thresholds.colors[key]}
                      onChange={(event) => updateColor(key, event.target.value)}
                    />
                  </label>
                ))}
              </div>
              <div className="settings-field-grid settings-field-grid--four settings-field-grid--spaced">
                <label className="settings-field">
                  <span>Green above days</span>
                  <input aria-label="Green above days" type="number" value={settings.thresholds.validAbove ?? ''} onChange={(event) => updateThreshold('validAbove', event.target.value)} />
                </label>
                <label className="settings-field">
                  <span>Yellow from days</span>
                  <input aria-label="Yellow from days" type="number" value={settings.thresholds.expiringSoonFrom ?? ''} onChange={(event) => updateThreshold('expiringSoonFrom', event.target.value)} />
                </label>
                <label className="settings-field">
                  <span>Urgent from days</span>
                  <input aria-label="Urgent from days" type="number" value={settings.thresholds.urgentFrom ?? ''} onChange={(event) => updateThreshold('urgentFrom', event.target.value)} />
                </label>
                <label className="settings-field">
                  <span>Expired at days</span>
                  <input aria-label="Expired at days" type="number" value={settings.thresholds.expiredAt ?? ''} onChange={(event) => updateThreshold('expiredAt', event.target.value)} />
                </label>
              </div>
            </section>
          ) : null}

          {activeSection === 'notifications' ? (
            <section className="settings-section" aria-labelledby="notifications-settings-title">
              <div className="settings-section__heading">
                <div>
                  <p className="settings-eyebrow">Notifications</p>
                  <h2 id="notifications-settings-title">Reminders and summaries</h2>
                </div>
              </div>
              <div className="settings-alert-options">
                <fieldset className="settings-fieldset">
                  <legend>Notification days before expiry</legend>
                  <div className="settings-notification-list">
                    {settings.notificationDays.map((day, index) => (
                      <div className="settings-notification-row" key={`${index}-${day}`}>
                        <label className="settings-field settings-field--inline">
                          <span className="visually-hidden">Notification day {index + 1}</span>
                          <input
                            aria-label={`Notification day ${index + 1}`}
                            type="number"
                            min="0"
                            value={day}
                            onChange={(event) => updateNotificationDay(index, event.target.value)}
                          />
                        </label>
                        <span>days before</span>
                        <button
                          className="settings-remove-button"
                          type="button"
                          aria-label={`Remove notification day ${index + 1}`}
                          onClick={() => updateSettings((current) => ({
                            ...current,
                            notificationDays: current.notificationDays.filter((_, currentIndex) => currentIndex !== index),
                          }))}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => updateSettings((current) => ({
                      ...current,
                      notificationDays: [...current.notificationDays, 0],
                    }))}
                  >
                    Add notification day
                  </button>
                </fieldset>
                <div className="settings-summary-options" role="group" aria-label="Summary schedules">
                  <label className="settings-toggle">
                    <input
                      aria-label="Daily summary"
                      type="checkbox"
                      checked={settings.dailySummaryEnabled}
                      onChange={(event) => updateSettings((current) => ({ ...current, dailySummaryEnabled: event.target.checked }))}
                    />
                    <span>
                      <strong>Daily summary</strong>
                      <small>Send a daily digest when summary delivery is configured.</small>
                    </span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      aria-label="Weekly summary"
                      type="checkbox"
                      checked={settings.weeklySummaryEnabled}
                      onChange={(event) => updateSettings((current) => ({ ...current, weeklySummaryEnabled: event.target.checked }))}
                    />
                    <span>
                      <strong>Weekly summary</strong>
                      <small>Send one digest a week on the chosen day.</small>
                    </span>
                  </label>
                  <div className="settings-field-grid settings-field-grid--three settings-field-grid--spaced">
                    <label className="settings-field">
                      <span>Weekly summary day</span>
                      <select
                        aria-label="Weekly summary day"
                        value={settings.weeklySummaryDay}
                        onChange={(event) => updateSettings((current) => ({ ...current, weeklySummaryDay: Number(event.target.value) }))}
                      >
                        {WEEKDAY_LABELS.map(([label, value]) => (
                          <option key={label} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="settings-field">
                      <span>Weekly summary time</span>
                      <input
                        aria-label="Weekly summary time"
                        type="time"
                        value={settings.weeklySummaryTime}
                        onChange={(event) => updateSettings((current) => ({ ...current, weeklySummaryTime: event.target.value || DEFAULT_SETTINGS.weeklySummaryTime }))}
                      />
                    </label>
                    <label className="settings-field">
                      <span>Daily summary time</span>
                      <input
                        aria-label="Daily summary time"
                        type="time"
                        value={settings.dailySummaryTime}
                        onChange={(event) => updateSettings((current) => ({ ...current, dailySummaryTime: event.target.value || DEFAULT_SETTINGS.dailySummaryTime }))}
                      />
                    </label>
                  </div>
                  <p className="settings-muted">Day and time use this device&apos;s local time zone.</p>
                </div>
              </div>

              {/* Admin-only server email config (recipients/toggles); the
                  Resend key never appears — it is a Supabase Function secret. */}
              {role === 'admin' ? (
                <EmailNotificationsSection client={emailPrefsClient ?? null} />
              ) : null}
            </section>
          ) : null}

          {activeSection === 'workspace' ? (
            <section className="settings-section" aria-labelledby="workspace-settings-title">
              <div className="settings-section__heading">
                <div>
                  <p className="settings-eyebrow">Workspace</p>
                  <h2 id="workspace-settings-title">Display and currency</h2>
                </div>
              </div>
              <div className="settings-field-grid settings-field-grid--four">
                <label className="settings-field">
                  <span>Currency code</span>
                  <input aria-label="Currency code" type="text" value={settings.currency.code} onChange={(event) => updateSettings((current) => ({ ...current, currency: { ...current.currency, code: event.target.value.toUpperCase() } }))} />
                </label>
                <label className="settings-field">
                  <span>Currency symbol</span>
                  <input aria-label="Currency symbol" type="text" value={settings.currency.symbol} onChange={(event) => updateSettings((current) => ({ ...current, currency: { ...current.currency, symbol: event.target.value } }))} />
                </label>
                <label className="settings-field">
                  <span>Currency decimals</span>
                  <input aria-label="Currency decimals" type="number" min="0" max="6" value={settings.currency.decimals} onChange={(event) => updateSettings((current) => ({ ...current, currency: { ...current.currency, decimals: Math.max(0, Math.min(6, Number(event.target.value) || 0)) } }))} />
                </label>
                <label className="settings-field">
                  <span>Theme default</span>
                  <select aria-label="Theme default" value={settings.theme} onChange={(event) => updateSettings((current) => ({ ...current, theme: event.target.value as ThemePreference }))}>
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
              </div>
              <label className="settings-field settings-field--primary-expiry">
                <span>Primary expiry column</span>
                <select aria-label="Primary expiry column" value={settings.primaryExpiryColumnId} onChange={(event) => updateSettings((current) => ({ ...current, primaryExpiryColumnId: event.target.value }))}>
                  <option value="">No primary expiry column</option>
                  {activeExpiryColumns.map((column) => <option value={column.id} key={column.id}>{column.name}</option>)}
                </select>
              </label>
            </section>
          ) : null}

          {activeSection === 'about' ? (
            <section className="settings-section settings-maintenance" aria-labelledby="about-settings-title">
              <div className="settings-section__heading">
                <div>
                  <p className="settings-eyebrow">About &amp; updates</p>
                  <h2 id="about-settings-title">Application updates</h2>
                </div>
              </div>
              <div className="settings-maintenance__grid">
                <div className="settings-maintenance__card settings-about">
                  <div className="settings-about__identity">
                    {/* The official logo (same source as the app icon). The
                        dark-mode variant is the same artwork lightened, so the
                        card needs no white plate behind it. */}
                    <img
                      className="settings-about__logo settings-about__logo--on-light"
                      src={dksLogo}
                      alt="DKS — Software for businesses"
                      width={168}
                      height={74}
                    />
                    <img
                      className="settings-about__logo settings-about__logo--on-dark"
                      src={dksLogoDark}
                      alt=""
                      aria-hidden="true"
                      width={168}
                      height={74}
                    />
                    <strong className="settings-about__name">DKS</strong>
                    <p className="settings-about__version" aria-label={`Version ${resolvedVersion}`}>
                      Version {resolvedVersion}
                    </p>
                    <p className="settings-muted settings-about__author">
                      Made by Tacenta
                      <a
                        className="settings-about__link"
                        href={TACENTA_GITHUB_URL}
                        aria-label="Tacenta on GitHub"
                        title="Tacenta on GitHub"
                        onClick={(event) => {
                          event.preventDefault();
                          void openExternalUrl(TACENTA_GITHUB_URL);
                        }}
                      >
                        <Github aria-hidden="true" size={16} />
                      </a>
                    </p>
                    <p className="settings-muted">Updates are checked without changing local records.</p>
                  </div>
                  <button className="button" type="button" onClick={() => invokeAction(updateHandler, 'Update check requested.', 'Update check could not be started.')}>Check for updates</button>
                </div>
              </div>
              <p className="settings-resend-note"><strong>Resend:</strong> {resendNote}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const AdminSettingsPage = SettingsPage;
export default SettingsPage;
