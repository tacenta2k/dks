import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Role } from '../auth/auth-types';
import type {
  DksBackupDesignation,
  DksBackupDrillResult as BackupDrillResult,
  DksBackupHealthResult as BackupHealthResult,
  DksBackupHistoryEntry as BackupHistoryEntry,
  DksBackupKeySetupResult as BackupKeySetupResult,
  DksBackupListResult as BackupListResult,
  DksBackupRunResult as BackupRunResult,
  DksBackupState as BackupState,
} from '../../lib/types';

/**
 * Settings → Backup & Recovery (Admin only).
 *
 * The renderer never touches Node, `node:crypto`, the filesystem or the backup
 * Worker. Every action is one call through the validated preload bridge, and
 * the main process re-checks the admin role on each one.
 */

/**
 * Reads and writes the designated backup PC in Supabase `public.settings`.
 * Injectable so the panel is testable without a Supabase client.
 */
export interface BackupDesignationBridge {
  read: () => Promise<DksBackupDesignation | null>;
  claim: (input: { deviceId: string; label: string }) => Promise<DksBackupDesignation>;
}

/**
 * The production bridge. Both imports are dynamic: the renderer startup graph
 * must not pull in the Supabase client for a Settings panel.
 */
async function defaultDesignationBridge(): Promise<BackupDesignationBridge | null> {
  const [{ supabase }, { readDesignation, claimDesignation }] = await Promise.all([
    import('../../lib/supabase'),
    import('./backup-designation'),
  ]);
  if (!supabase) return null;
  // The runtime client is a real Supabase client; the auth-service type only
  // declares the auth paths DKS already uses.
  const client = supabase as unknown as import('./settings-service').SettingsDataClient;
  return {
    read: () => readDesignation(client),
    claim: (input) => claimDesignation(client, input),
  };
}

export interface BackupBridge {
  getState: (input: { role: string }) => Promise<BackupState>;
  runNow: (input: { role: string; trigger?: string }) => Promise<BackupRunResult>;
  list: (input: { role: string; year: number; month: number; cursor?: string | null }) => Promise<BackupListResult>;
  testDrill: (input: { role: string; recoveryKey?: string }) => Promise<BackupDrillResult>;
  setupKey: (input: {
    role: string;
    action: 'generate' | 'confirm' | 'configure' | 'import';
    recoveryKey?: string;
    workerUrl?: string;
    enabled?: boolean;
    keyId?: string;
  }) => Promise<BackupKeySetupResult>;
  healthCheck: (input: { role: string }) => Promise<BackupHealthResult>;
  /**
   * Pushes the designated backup PC (read from Supabase) into main so the
   * scheduler knows whether this PC should run automatic backups.
   */
  setDesignation: (input: {
    role: string;
    designation: DksBackupDesignation | null;
  }) => Promise<BackupState>;
  /** Renames this PC. A safe label only — never a hostname or user name. */
  setDeviceLabel: (input: { role: string; label: string }) => Promise<BackupState>;
}

export interface BackupRecoverySectionProps {
  role?: Role | string | null;
  /** The preload bridge. `null` forces the "desktop bridge unavailable" state. */
  backup?: BackupBridge | null;
  /**
   * Reads/writes the designated backup PC in Supabase. Injected in tests;
   * defaults to the real `public.settings` client.
   */
  designation?: BackupDesignationBridge | null;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

type WizardStep = 'start' | 'showing' | 'confirmed' | 'error';

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  timeZone: 'Asia/Muscat',
});

/** How many past years the history offers, newest first. */
const HISTORY_YEAR_DEPTH = 3;

export function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

/** Muscat calendar weekday for a YYYY-MM-DD date. Muscat has no DST. */
export function weekdayOfBackupDay(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }
  const parsed = new Date(`${day}T12:00:00+04:00`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return WEEKDAY_FORMATTER.format(parsed);
}

/** DD/MM/YYYY, the only user-facing date format in DKS. */
export function formatBackupDay(day: string): string {
  if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(day)) {
    return day;
  }
  const [, year, month, date] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) as string[];
  return `${date}/${month}/${year}`;
}

export function formatBackupInstant(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const date = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Muscat',
  }).format(parsed);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Muscat',
    hour12: false,
  }).format(parsed);
  return `${date} ${time}`;
}

export function formatBytes(bytes: number | null): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export const OUTCOME_LABELS: Readonly<Record<BackupHistoryEntry['outcome'], string>> = {
  verified: 'Verified',
  pending: 'Waiting to upload',
  failed: 'Failed',
  no_changes: 'No changes',
  incomplete: 'Skipped — local changes pending',
};

function connectionLabel(state: BackupState): string {
  switch (state.connection) {
    case 'not_configured':
      return 'Not set up';
    case 'signed_out':
      return 'Signed out';
    case 'offline':
      return 'Offline';
    case 'ok':
      return 'Connected';
    case 'error':
      return 'Not reachable';
    case 'unknown':
      return 'Not checked yet';
    default:
      return 'Unknown';
  }
}

export function BackupRecoverySection({
  role,
  backup,
  designation: designationBridge,
}: BackupRecoverySectionProps): JSX.Element {
  const bridge = backup === undefined ? resolveBridge() : backup;

  const [status, setStatus] = useState<LoadStatus>('idle');
  const [state, setState] = useState<BackupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workerUrl, setWorkerUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);

  const [wizardStep, setWizardStep] = useState<WizardStep>('start');
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const [typedKey, setTypedKey] = useState('');
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [wizardBusy, setWizardBusy] = useState(false);
  // The designated backup PC, as read from Supabase.
  const [designation, setDesignation] = useState<DksBackupDesignation | null>(null);
  const [designationError, setDesignationError] = useState<string | null>(null);
  const [claimConfirmOpen, setClaimConfirmOpen] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  // Importing the key from another PC: the replacement-machine path.
  const [importOpen, setImportOpen] = useState(false);
  const [importKey, setImportKey] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importDone, setImportDone] = useState(false);

  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const [drillBusy, setDrillBusy] = useState(false);
  const [drillResult, setDrillResult] = useState<BackupDrillResult | null>(null);

  const [openYears, setOpenYears] = useState<number[]>([]);
  const [openMonths, setOpenMonths] = useState<string[]>([]);
  const [entries, setEntries] = useState<Record<string, BackupHistoryEntry[]>>({});
  const [monthState, setMonthState] = useState<Record<string, LoadStatus>>({});

  const adminRole = role === 'admin' ? 'admin' : null;
  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const years = useMemo(
    () => Array.from({ length: HISTORY_YEAR_DEPTH }, (_unused, index) => currentYear - index),
    [currentYear],
  );

  const load = useCallback(async (): Promise<void> => {
    if (!bridge || !adminRole) {
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const next = await bridge.getState({ role: adminRole });
      setState(next);
      setWorkerUrl(next.workerUrl ?? '');
      setStatus('ready');
    } catch (caught) {
      setError(messageFromError(caught, 'DKS could not read the backup status'));
      setStatus('error');
    }
  }, [adminRole, bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A key id is a hash prefix: safe to show, and enough to match a key. */
  const shortKeyId = (keyId: string): string => `${keyId.slice(0, 8)}…${keyId.slice(-4)}`;

  /** A device id is random, not PII — but only a short form is ever displayed. */
  const shortDeviceId = (deviceId: string): string => `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;

  /**
   * What a backup holds. Never "authoritative": Supabase is the live authority
   * and this is a disaster-recovery copy of one PC's synchronised workspace.
   */
  const sourceLabel = (source: string | null): string => (
    source === 'local-cache' ? 'Synchronised local workspace' : 'Unknown'
  );

  const monthKey = (year: number, month: number): string => `${String(year)}-${String(month).padStart(2, '0')}`;

  const loadMonth = useCallback(async (year: number, month: number): Promise<void> => {
    if (!bridge || !adminRole) {
      return;
    }
    const key = monthKey(year, month);
    setMonthState((current) => ({ ...current, [key]: 'loading' }));
    try {
      const collected: BackupHistoryEntry[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result = await bridge.list({ role: adminRole, year, month, cursor });
        collected.push(...result.entries);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      setEntries((current) => ({ ...current, [key]: collected }));
      setMonthState((current) => ({ ...current, [key]: 'ready' }));
    } catch (caught) {
      setMonthState((current) => ({ ...current, [key]: 'error' }));
      setEntries((current) => ({
        ...current,
        [key]: [],
      }));
      setError(messageFromError(caught, `DKS could not load backups for ${monthName(month)} ${String(year)}`));
    }
  }, [adminRole, bridge]);

  const toggleYear = (year: number): void => {
    setOpenYears((current) => (current.includes(year) ? current.filter((item) => item !== year) : [...current, year]));
  };

  const toggleMonth = (year: number, month: number): void => {
    const key = monthKey(year, month);
    const willOpen = !openMonths.includes(key);
    setOpenMonths((current) => (willOpen ? [...current, key] : current.filter((item) => item !== key)));
    if (willOpen && monthState[key] !== 'ready' && monthState[key] !== 'loading') {
      void loadMonth(year, month);
    }
  };

  const handleSaveWorkerUrl = async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    setSavingUrl(true);
    setWizardError(null);
    try {
      const result = await bridge.setupKey({
        role: adminRole,
        action: 'configure',
        workerUrl: workerUrl.trim(),
      });
      if (!result.ok) {
        setWizardError(result.message || 'That backup service address could not be saved');
      }
      // Re-read the state: it is the only truthful source for the toggle and URL.
      await load();
    } catch (caught) {
      setWizardError(messageFromError(caught, 'That backup service address could not be saved'));
    } finally {
      setSavingUrl(false);
    }
  };

  const handleGenerate = async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    setWizardBusy(true);
    setWizardError(null);
    try {
      const result = await bridge.setupKey({
        role: adminRole,
        action: 'generate',
        ...(workerUrl.trim() ? { workerUrl: workerUrl.trim() } : {}),
      });
      if (!result.ok || !result.recoveryKey) {
        setWizardStep('error');
        setWizardError(result.message || 'DKS could not create the backup key on this PC');
        return;
      }
      setRecoveryKey(result.recoveryKey);
      setSavedConfirmation(false);
      setTypedKey('');
      setWizardStep('showing');
      await load();
    } catch (caught) {
      setWizardStep('error');
      setWizardError(messageFromError(caught, 'DKS could not create the backup key on this PC'));
    } finally {
      setWizardBusy(false);
    }
  };

  const handleConfirmKey = async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    setWizardBusy(true);
    setWizardError(null);
    try {
      const result = await bridge.setupKey({ role: adminRole, action: 'confirm', recoveryKey: typedKey.trim() });
      if (!result.ok) {
        setWizardError(result.message || 'That recovery key does not match');
        setWizardBusy(false);
        return;
      }
      setWizardStep('confirmed');
      setRecoveryKey(null);
      setTypedKey('');
      await load();
    } catch (caught) {
      setWizardError(messageFromError(caught, 'That recovery key could not be checked'));
    } finally {
      setWizardBusy(false);
    }
  };

  /**
   * Import a recovery key made on another PC. Without this a backup taken on
   * the old machine could never be opened again: the wrapped key does not move
   * between PCs, only the recovery key does.
   */
  const handleImportKey = async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    setWizardBusy(true);
    setImportError(null);
    setImportDone(false);
    try {
      const result = await bridge.setupKey({
        role: adminRole,
        action: 'import',
        recoveryKey: importKey.trim(),
      });
      if (!result.ok) {
        setImportError(result.message || 'DKS could not use that recovery key');
        return;
      }
      setImportKey('');
      setImportOpen(false);
      setImportDone(true);
      setWizardStep('confirmed');
      await load();
    } catch (caught) {
      setImportError(messageFromError(caught, 'DKS could not use that recovery key'));
    } finally {
      setWizardBusy(false);
    }
  };

  const handleCopyKey = async (): Promise<void> => {
    if (!recoveryKey) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(recoveryKey);
      }
    } catch {
      // The key stays on screen; copying is a convenience, never a requirement.
    }
  };

  /**
   * Read the shared designation from Supabase and hand it to main.
   *
   * Main uses it only to decide whether THIS PC schedules automatic backups;
   * the Worker re-reads the same row on every upload, so a stale or hostile
   * local copy cannot make a non-designated PC's uploads succeed.
   */
  const syncDesignation = useCallback(async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    let impl: BackupDesignationBridge | null = designationBridge ?? null;
    if (designationBridge === undefined) {
      try {
        impl = await defaultDesignationBridge();
      } catch (caught) {
        setDesignationError(messageFromError(caught, 'DKS could not reach Supabase to read the backup PC'));
        return;
      }
    }
    if (!impl) return;
    try {
      const next = await impl.read();
      setDesignation(next);
      await bridge.setDesignation({ role: adminRole, designation: next });
      await load();
    } catch (caught) {
      setDesignationError(messageFromError(caught, 'DKS could not read which PC is designated for backup'));
    }
  }, [adminRole, bridge, designationBridge, load]);

  useEffect(() => {
    void syncDesignation();
  }, [syncDesignation]);

  /**
   * Make this PC the designated backup PC. This transfers automatic backup duty
   * away from whichever PC held it, which is why the UI asks for confirmation.
   */
  const handleClaimDesignation = async (): Promise<void> => {
    if (!bridge || !adminRole || !state) return;
    let impl: BackupDesignationBridge | null = designationBridge ?? null;
    if (designationBridge === undefined) impl = await defaultDesignationBridge();
    if (!impl) {
      setDesignationError('DKS is not connected to Supabase, so the backup PC cannot be changed.');
      return;
    }
    setClaimBusy(true);
    setDesignationError(null);
    try {
      const label = labelDraft.trim() || state.deviceLabel;
      const next = await impl.claim({ deviceId: state.deviceId, label });
      setDesignation(next);
      await bridge.setDesignation({ role: adminRole, designation: next });
      setClaimConfirmOpen(false);
      setLabelDraft('');
      await load();
    } catch (caught) {
      setDesignationError(messageFromError(caught, 'DKS could not make this PC the backup PC'));
    } finally {
      setClaimBusy(false);
    }
  };

  const handleRunNow = async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    setRunning(true);
    setRunMessage(null);
    try {
      const result = await bridge.runNow({ role: adminRole, trigger: 'manual' });
      setRunMessage(result.detail ?? OUTCOME_LABELS[result.outcome]);
      await load();
    } catch (caught) {
      setRunMessage(messageFromError(caught, 'The backup did not finish'));
    } finally {
      setRunning(false);
    }
  };

  const handleToggleEnabled = async (enabled: boolean): Promise<void> => {
    if (!bridge || !adminRole) return;
    // Optimistic paint, then re-read: the UI never keeps a state the main
    // process did not confirm.
    setState((current) => (current ? { ...current, enabled } : current));
    try {
      const result = await bridge.setupKey({ role: adminRole, action: 'configure', enabled });
      if (!result.ok) {
        setError(result.message || 'DKS could not change the backup setting');
      }
      await load();
    } catch (caught) {
      setError(messageFromError(caught, 'DKS could not change the backup setting'));
      await load();
    }
  };

  const handleDrill = async (): Promise<void> => {
    if (!bridge || !adminRole) return;
    setDrillBusy(true);
    setDrillResult(null);
    try {
      setDrillResult(await bridge.testDrill({ role: adminRole }));
    } catch (caught) {
      setDrillResult({
        ok: false,
        stage: 'download',
        sizeBytes: null,
        integrityCheck: null,
        message: messageFromError(caught, 'The drill could not run'),
      });
    } finally {
      setDrillBusy(false);
    }
  };

  if (!bridge) {
    return (
      <section className="settings-section settings-backup" aria-labelledby="backup-settings-title">
        <div className="settings-section__heading">
          <div>
            <p className="settings-eyebrow">Backup &amp; recovery</p>
            <h2 id="backup-settings-title">Cloud backup</h2>
          </div>
        </div>
        <p className="settings-muted">
          Cloud backup runs inside the DKS desktop app. Open Settings from the installed DKS to use it.
        </p>
      </section>
    );
  }

  const keyConfigured = state?.keyConfigured === true;

  if (!adminRole) {
    // The Settings nav only offers this tab to administrators, but the guard is
    // repeated here so a non-admin can never trigger a bridge call — and so the
    // panel says something true instead of sitting empty.
    return (
      <section className="settings-section settings-backup" aria-labelledby="backup-settings-title">
        <div className="settings-section__heading">
          <div>
            <p className="settings-eyebrow">Backup &amp; recovery</p>
            <h2 id="backup-settings-title">Cloud backup</h2>
          </div>
        </div>
        <p className="settings-muted">
          Cloud backup is available to administrators only. Ask an administrator to review or run a backup.
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section settings-backup" aria-labelledby="backup-settings-title">
      <div className="settings-section__heading">
        <div>
          <p className="settings-eyebrow">Backup &amp; recovery</p>
          <h2 id="backup-settings-title">Cloud backup</h2>
        </div>
        <span className="settings-section__hint">
          {state ? `Retention ${String(state.retentionDays)} days` : 'Retention 90 days'}
        </span>
      </div>

      {status === 'loading' ? (
        <div className="settings-backup__skeleton" role="status">Loading the backup status…</div>
      ) : null}

      {status === 'error' ? (
        <div className="settings-alert settings-alert--error" role="alert">
          <span className="settings-alert__message">{error ?? 'DKS could not read the backup status'}</span>
          <button type="button" className="button button--secondary" onClick={() => void load()}>Try again</button>
        </div>
      ) : null}

      {status === 'ready' && state ? (
        <>
          <div className="settings-maintenance__card settings-backup__status">
            <div className="settings-backup__status-grid">
              <StatusItem label="Connection" value={connectionLabel(state)} />
              <StatusItem
                label="Last successful backup"
                value={formatBackupInstant(state.lastSuccessAt) ?? 'Not yet'}
              />
              <StatusItem label="Next check" value={formatBackupInstant(state.nextCheckAt) ?? 'Not scheduled'} />
              <StatusItem label="Last size" value={formatBytes(state.lastSizeBytes) ?? '—'} />
              <StatusItem
                label="Records in last backup"
                value={state.lastRecordCount === null ? '—' : String(state.lastRecordCount)}
              />
              <StatusItem
                label="Waiting to upload"
                value={state.pendingUploads === 0 ? 'Nothing' : `${String(state.pendingUploads)} file(s)`}
              />
              <StatusItem label="Backup key on this PC" value={state.keyId ? shortKeyId(state.keyId) : 'Not set up'} />
              <StatusItem label="What a backup holds" value={sourceLabel(state.source)} />
              <StatusItem
                label="Backup PC"
                value={state.designated
                  ? `${state.deviceLabel} (this PC)`
                  : state.designatedDeviceLabel
                    ? `${state.designatedDeviceLabel} (another PC)`
                    : state.designatedDeviceId
                      ? `${shortDeviceId(state.designatedDeviceId)} (another PC)`
                      : 'Not designated yet'}
              />
              <StatusItem
                label="Local cache synced"
                value={state.cacheComplete ? 'Yes' : 'Not yet — backups wait'}
              />
            </div>

            <p className="settings-muted settings-backup__scope">
              Encrypted snapshot of the <strong>designated Admin PC’s synchronised local workspace</strong>.
              Supabase remains the live authority: this is a disaster-recovery copy, not an authoritative
              backup of the organisation’s data, and it is never restored over live data in this release.
            </p>

            <label className="settings-toggle settings-backup__toggle" htmlFor="settings-backup-enabled">
              <input
                id="settings-backup-enabled"
                aria-label="Cloud backup"
                type="checkbox"
                checked={state.enabled}
                onChange={(event) => void handleToggleEnabled(event.target.checked)}
              />
              <span>{state.enabled ? 'On' : 'Off'}</span>
            </label>

            <p className="settings-muted">
              Backups run only while DKS is open: at the first launch each day in Muscat, every hour while it
              stays open, and once before it closes. A day with no launch produces no backup for that day.
            </p>

            {state.lastError ? (
              <p className="settings-backup__note" role="status">{state.lastError}</p>
            ) : null}

            {!state.designated ? (
              <p className="settings-backup__note" role="status">
                {state.designatedDeviceId
                  ? <>
                      Automatic backup runs on another designated Admin PC
                      {state.designatedDeviceLabel
                        ? ` — ${state.designatedDeviceLabel}`
                        : ` — ${shortDeviceId(state.designatedDeviceId)}`}.
                      {' '}You can still list, download, import a recovery key and test a restore from here.
                    </>
                  : 'No Admin PC is designated for cloud backup yet. Designate one below to start automatic backups.'}
              </p>
            ) : null}

            <div className="settings-backup__actions">
              {/* v1: only the designated PC may start a backup. Allowing a second
                  Admin PC to force one would create a second backup lineage. */}
              {state.designated ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => void handleRunNow()}
                  disabled={running || !state.enabled}
                >
                  {running ? 'Backing up…' : 'Back up now'}
                </button>
              ) : null}
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void handleDrill()}
                disabled={drillBusy || !keyConfigured}
              >
                {drillBusy ? 'Checking the latest backup…' : 'Test restore'}
              </button>
            </div>

            {runMessage ? <p className="settings-muted" role="status">{runMessage}</p> : null}
            {drillResult ? (
              <p
                className={drillResult.ok ? 'settings-backup__note settings-backup__note--ok' : 'settings-backup__note'}
                role={drillResult.ok ? 'status' : 'alert'}
              >
                {drillResult.message}
              </p>
            ) : null}
          </div>

          <div className="settings-maintenance__card settings-backup__service">
            <h3>Backup service</h3>
            <label className="settings-field" htmlFor="settings-backup-worker-url">
              <span>Backup service address</span>
              <input
                id="settings-backup-worker-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={workerUrl}
                placeholder="https://dks-backup.&lt;account&gt;.workers.dev"
                onChange={(event) => setWorkerUrl(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void handleSaveWorkerUrl()}
              disabled={savingUrl || workerUrl.trim().length === 0}
            >
              {savingUrl ? 'Saving…' : 'Save address'}
            </button>
          </div>

          <div className="settings-maintenance__card settings-backup__device" aria-labelledby="backup-device-title">
            <h3 id="backup-device-title">Backup PC</h3>
            <p className="settings-muted">
              One Admin PC runs the automatic backups. This PC is
              {' '}<strong>{state.deviceLabel}</strong>{' '}
              (<code className="settings-backup__key-id">{shortDeviceId(state.deviceId)}</code>).
              The designation is stored in Supabase, so it applies to every PC in the workspace.
            </p>
            <dl className="settings-backup__device-grid">
              <div>
                <dt>Designated</dt>
                <dd>
                  {state.designated
                    ? 'This PC'
                    : state.designatedDeviceLabel
                      ? state.designatedDeviceLabel
                      : state.designatedDeviceId
                        ? shortDeviceId(state.designatedDeviceId)
                        : 'No PC yet'}
                </dd>
              </div>
              <div>
                <dt>Changed</dt>
                <dd>{state.designatedAt ? formatBackupInstant(state.designatedAt) ?? '—' : '—'}</dd>
              </div>
            </dl>

            {designationError ? (
              <p className="settings-backup__note" role="alert">{designationError}</p>
            ) : null}

            {state.designated ? (
              <p className="settings-muted">
                Automatic backups run from this PC. To move the duty, run DKS on the other Admin PC and
                designate it there.
              </p>
            ) : claimConfirmOpen ? (
              <div className="settings-backup__import">
                <p className="settings-backup__key-warning" role="alert">
                  This transfers automatic backup duty{designation?.label ? ` away from ${designation.label}` : ''} to
                  this PC. The other PC stops backing up. Both PCs keep their own recovery keys, so backups
                  already stored stay openable only with the key of the PC that made them.
                </p>
                <label className="settings-field" htmlFor="settings-backup-device-label">
                  <span>Label for this PC (no personal names)</span>
                  <input
                    id="settings-backup-device-label"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={60}
                    value={labelDraft}
                    placeholder={state.deviceLabel}
                    onChange={(event) => setLabelDraft(event.target.value)}
                  />
                </label>
                <div className="settings-backup__import-actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => void handleClaimDesignation()}
                    disabled={claimBusy}
                  >
                    {claimBusy ? 'Designating…' : 'Yes, make this PC the backup PC'}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => {
                      setClaimConfirmOpen(false);
                      setLabelDraft('');
                    }}
                    disabled={claimBusy}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setClaimConfirmOpen(true)}
                disabled={claimBusy}
              >
                Make this PC the backup PC
              </button>
            )}
          </div>

          <div className="settings-maintenance__card settings-backup__wizard" aria-labelledby="backup-key-title">
            <h3 id="backup-key-title">Recovery key</h3>
            {keyConfigured && wizardStep !== 'showing' ? (
              <p className="settings-muted">
                A recovery key is set up on this PC. Generate a new one only if you have lost it — the old key
                will stop working for backups made after that.
              </p>
            ) : null}
            {!keyConfigured && wizardStep === 'start' ? (
              <p className="settings-muted">
                DKS encrypts every backup with a key that never leaves this PC. Create it now, then copy the
                recovery key somewhere safe: without it a backup cannot be opened again.
              </p>
            ) : null}

            {wizardStep === 'start' || wizardStep === 'error' || (keyConfigured && wizardStep !== 'showing') ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void handleGenerate()}
                disabled={wizardBusy}
              >
                {wizardBusy ? 'Creating…' : keyConfigured ? 'Create a new recovery key' : 'Create recovery key'}
              </button>
            ) : null}

            {wizardStep === 'showing' && recoveryKey ? (
              <div className="settings-backup__key">
                <p className="settings-backup__key-warning" role="alert">
                  This is the only time DKS shows this key. Copy it now and keep it somewhere safe.
                </p>
                <div className="settings-backup__key-row">
                  <code className="settings-backup__key-value">{recoveryKey}</code>
                  <button type="button" className="button button--secondary" onClick={() => void handleCopyKey()}>
                    Copy
                  </button>
                </div>
                <label className="settings-field settings-field--inline" htmlFor="settings-backup-key-saved">
                  <input
                    id="settings-backup-key-saved"
                    type="checkbox"
                    checked={savedConfirmation}
                    onChange={(event) => setSavedConfirmation(event.target.checked)}
                  />
                  <span>I have saved this recovery key</span>
                </label>
                <label className="settings-field" htmlFor="settings-backup-key-typed">
                  <span>Paste it back to confirm</span>
                  <input
                    id="settings-backup-key-typed"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={typedKey}
                    onChange={(event) => setTypedKey(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => void handleConfirmKey()}
                  disabled={wizardBusy || !savedConfirmation || typedKey.trim().length === 0}
                >
                  {wizardBusy ? 'Checking…' : 'Confirm recovery key'}
                </button>
              </div>
            ) : null}

            {keyConfigured && wizardStep !== 'showing' ? (
              <p className="settings-muted">
                Backup key on this PC: <code className="settings-backup__key-id">{shortKeyId(state?.keyId ?? '')}</code>
              </p>
            ) : null}

            {wizardStep !== 'showing' ? (
              importOpen ? (
                <div className="settings-backup__import">
                  <p className="settings-muted">
                    Paste the recovery key from the PC that made the backups you need to open. DKS stores it
                    wrapped by this PC’s operating system key store; it is never written in plain text.
                  </p>
                  <label className="settings-field" htmlFor="settings-backup-key-import">
                    <span>Recovery key from another PC</span>
                    <input
                      id="settings-backup-key-import"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={importKey}
                      onChange={(event) => setImportKey(event.target.value)}
                    />
                  </label>
                  <div className="settings-backup__import-actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => void handleImportKey()}
                      disabled={wizardBusy || importKey.trim().length === 0}
                    >
                      {wizardBusy ? 'Importing…' : 'Use this recovery key'}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => {
                        setImportOpen(false);
                        setImportKey('');
                        setImportError(null);
                      }}
                      disabled={wizardBusy}
                    >
                      Cancel
                    </button>
                  </div>
                  {importError ? (
                    <p className="settings-backup__note" role="alert">{importError}</p>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setImportOpen(true)}
                  disabled={wizardBusy}
                >
                  Open backups made on another PC
                </button>
              )
            ) : null}

            {importDone ? (
              <p className="settings-backup__note settings-backup__note--ok" role="status">
                Recovery key imported. Backups made with that key can now be opened on this PC.
              </p>
            ) : null}

            {wizardStep === 'confirmed' ? (
              <p className="settings-backup__note settings-backup__note--ok" role="status">
                Recovery key confirmed. Cloud backup is ready.
              </p>
            ) : null}

            {wizardError ? (
              <p className="settings-backup__note" role="alert">{wizardError}</p>
            ) : null}
          </div>

          <div className="settings-maintenance__card settings-backup__history" aria-labelledby="backup-history-title">
            <h3 id="backup-history-title">Backup history</h3>
            <p className="settings-muted">Newest first. Times and weekdays are Muscat time.</p>
            <ul className="settings-backup__years">
              {years.map((year) => {
                const yearOpen = openYears.includes(year);
                const months = monthsForYear(year, currentYear);
                return (
                  <li key={year}>
                    <button
                      type="button"
                      className="settings-backup__disclosure"
                      aria-expanded={yearOpen}
                      onClick={() => toggleYear(year)}
                    >
                      {String(year)}
                    </button>
                    {yearOpen ? (
                      <ul className="settings-backup__months">
                        {months.map((month) => {
                          const key = monthKey(year, month);
                          const monthOpen = openMonths.includes(key);
                          const monthStatus = monthState[key] ?? 'idle';
                          const dayEntries = entries[key] ?? [];
                          return (
                            <li key={key}>
                              <button
                                type="button"
                                className="settings-backup__disclosure"
                                aria-expanded={monthOpen}
                                onClick={() => toggleMonth(year, month)}
                              >
                                {monthName(month)}
                              </button>
                              {monthOpen ? (
                                monthStatus === 'loading' ? (
                                  <p className="settings-muted" role="status">Loading…</p>
                                ) : monthStatus === 'error' ? (
                                  <p className="settings-backup__note" role="alert">
                                    This month could not be loaded.
                                    <button type="button" className="settings-backup__link" onClick={() => void loadMonth(year, month)}>
                                      Try again
                                    </button>
                                  </p>
                                ) : dayEntries.length === 0 ? (
                                  <p className="settings-muted">No backups this month</p>
                                ) : (
                                  <ul className="settings-backup__days">
                                    {dayEntries.map((entry) => (
                                      <li key={entry.objectKey ?? entry.day} className="settings-backup__day">
                                        <div className="settings-backup__day-main">
                                          <span className="settings-backup__day-date">
                                            {formatBackupDay(entry.day)}
                                            {weekdayOfBackupDay(entry.day) ? (
                                              <span className="settings-muted">{` · ${weekdayOfBackupDay(entry.day)}`}</span>
                                            ) : null}
                                          </span>
                                          <span className="settings-backup__day-meta">
                                            {formatBytes(entry.sizeBytes) ?? '—'}
                                            {entry.recordCount === null ? '' : ` · ${String(entry.recordCount)} records`}
                                          </span>
                                        </div>
                                        <span className={`settings-backup__badge settings-backup__badge--${entry.outcome}`}>
                                          {OUTCOME_LABELS[entry.outcome]}
                                        </span>
                                        <div className="settings-backup__day-actions">
                                          <button
                                            type="button"
                                            className="button button--secondary"
                                            disabled
                                            title="Coming in a later update"
                                          >
                                            Recover
                                          </button>
                                          <button
                                            type="button"
                                            className="button button--secondary"
                                            disabled
                                            title="Coming in a later update"
                                          >
                                            Delete
                                          </button>
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                )
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="settings-muted">
              Recover and Delete are coming in a later update.
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}

function StatusItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="settings-backup__status-item">
      <span className="settings-backup__status-label">{label}</span>
      <span className="settings-backup__status-value">{value}</span>
    </div>
  );
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function monthName(month: number): string {
  return MONTH_NAMES[Math.min(11, Math.max(0, month - 1))];
}

/** Months that can already hold a backup: the current month and everything before it. */
function monthsForYear(year: number, currentYear: number): number[] {
  const lastMonth = year === currentYear ? new Date().getMonth() + 1 : 12;
  return Array.from({ length: Math.max(1, lastMonth) }, (_unused, index) => lastMonth - index);
}

function resolveBridge(): BackupBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.dks?.backup ?? null;
}

export default BackupRecoverySection;
