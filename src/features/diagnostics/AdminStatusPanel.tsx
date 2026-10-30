import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { resolveAppVersion } from '../../lib/app-info';
import { formatBusinessDateTime } from '../../lib/date';
import { can } from '../../lib/permissions';
import type {
  DksAdminLocalStatus,
  DksDiagnosticsApi,
  DksLocalSyncState,
  DksUpdateState,
} from '../../lib/types';
import {
  type ConnectivityQueryClient,
  createInitialConnectivityReport,
  type EndpointCheckResult,
  formatSanitizedDiagnosticsText,
  runSupabaseConnectivityChecks,
  type SupabaseConnectivityReport,
} from './connectivity-checks';
import { defaultErrorReporter } from './error-reporting';
import './admin-status.css';

export interface AdminStatusOutboxFailureSummary {
  failedCount: number;
  terminalCount: number;
}

export interface AdminStatusPanelProps {
  role: 'admin' | 'office' | string | null | undefined;
  appVersion?: string;
  syncStatus?: DksLocalSyncState;
  outboxFailures?: AdminStatusOutboxFailureSummary;
  localStoreError?: string | null;
  updateState?: DksUpdateState;
  errorReportingEnabled?: boolean;
  diagnosticsApi?: DksDiagnosticsApi | null;
  dataClient?: ConnectivityQueryClient | null;
  accessToken?: string | null;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  fetchImpl?: typeof fetch;
  onCopyText?: (text: string) => Promise<void> | void;
}

function buildFallbackLocalStatus(props: AdminStatusPanelProps): DksAdminLocalStatus {
  const hasDesktopBridge = typeof window !== 'undefined' && Boolean(window.dks?.local);
  const storeAvailable = props.localStoreError ? false : hasDesktopBridge;
  const fallbackSummary = defaultErrorReporter.getFallbackSummary();
  const rawPlat = typeof window !== 'undefined' ? window.dks?.platform : undefined;
  const platform = rawPlat === 'win32' || rawPlat === 'darwin' || rawPlat === 'linux' ? rawPlat : 'unknown';

  return {
    appVersion: props.appVersion ?? resolveAppVersion(),
    packaged: false,
    platform,
    arch: 'unknown',
    osRelease: '0.0.0',
    electronVersion: null,
    localStore: {
      available: storeAvailable,
      schemaVersion: null,
      failureCode: props.localStoreError
        ? (/NODE_MODULE_VERSION|ABI/i.test(props.localStoreError) ? 'ABI_MISMATCH' : 'OPEN_FAILED')
        : null,
    },
    sync: {
      status: props.syncStatus?.status ?? 'unknown',
      lastSyncAt: props.syncStatus?.lastSyncAt ?? null,
      pendingOutboxCount: props.syncStatus?.pendingCount ?? 0,
      failedOutboxCount: props.outboxFailures?.failedCount ?? 0,
      terminalOutboxCount: props.outboxFailures?.terminalCount ?? 0,
    },
    updater: {
      status: props.updateState?.status ?? 'disabled',
      version: props.updateState?.version ?? null,
      errorKind: props.updateState?.errorKind ?? null,
      errorCode: props.updateState?.errorCode ?? null,
    },
    errorReporting: {
      ...fallbackSummary,
      enabled: props.errorReportingEnabled ?? fallbackSummary.enabled,
    },
  };
}

function renderConnectivityBadge(result: EndpointCheckResult): {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  detail?: string;
} {
  switch (result.status) {
    case 'reachable':
      return {
        label: 'Reachable',
        tone: 'ok',
        detail: result.latencyMs !== null ? `${result.latencyMs} ms` : undefined,
      };
    case 'unreachable':
      return {
        label: 'Unreachable',
        tone: 'error',
        detail: result.httpStatus !== null ? `HTTP ${result.httpStatus}` : undefined,
      };
    case 'checking':
      return { label: 'Checking…', tone: 'neutral' };
    case 'unconfigured':
      return { label: 'Not configured', tone: 'warn' };
    case 'unknown':
      return { label: 'Unknown', tone: 'neutral' };
    case 'not_checked':
    default:
      return { label: 'Not checked', tone: 'neutral' };
  }
}

function renderSyncStatusBadge(
  sync: DksAdminLocalStatus['sync'],
): { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' } {
  if (sync.status === 'syncing') {
    return { label: 'Syncing…', tone: 'neutral' };
  }
  if (sync.status === 'error' || sync.failedOutboxCount > 0 || sync.terminalOutboxCount > 0) {
    return { label: 'Sync error', tone: 'error' };
  }
  if (sync.pendingOutboxCount > 0) {
    return { label: `Pending (${sync.pendingOutboxCount})`, tone: 'warn' };
  }
  if (sync.status === 'healthy') {
    return { label: 'Healthy', tone: 'ok' };
  }
  if (sync.status === 'offline') {
    return { label: 'Offline — local only', tone: 'warn' };
  }
  return { label: 'Unknown', tone: 'neutral' };
}

function renderUpdaterLabel(updater: DksAdminLocalStatus['updater']): {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
} {
  switch (updater.status) {
    case 'disabled':
      return { label: 'Disabled in unpackaged build (not checked)', tone: 'neutral' };
    case 'idle':
      return { label: 'Not checked in this session', tone: 'neutral' };
    case 'checking':
      return { label: 'Checking release feed…', tone: 'neutral' };
    case 'not-available':
      return { label: 'Checked — up to date', tone: 'ok' };
    case 'available':
      return {
        label: updater.version ? `Update ${updater.version} available` : 'Update available',
        tone: 'warn',
      };
    case 'downloading':
      return { label: 'Downloading update…', tone: 'neutral' };
    case 'downloaded':
      return {
        label: updater.version ? `Update ${updater.version} ready to install` : 'Update ready to install',
        tone: 'ok',
      };
    case 'error':
      return {
        label: updater.errorKind === 'download' ? 'Update download failed' : 'Update check failed',
        tone: 'error',
      };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

function renderDeliveryOutcome(outcome: DksAdminLocalStatus['errorReporting']['lastDeliveryOutcome']): string {
  switch (outcome) {
    case 'delivered':
      return 'Delivered in this session';
    case 'suppressed_remote':
      return 'Deduplicated on server';
    case 'deferred_backoff':
      return 'Queued — awaiting retry window';
    case 'rate_limited':
      return 'Rate-limited — backing off';
    case 'disabled':
      return 'Disabled';
    case 'failed':
      return 'Failed after retry budget';
    case 'never':
    default:
      return 'Not attempted in this session';
  }
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand?.('copy');
    document.body.removeChild(textarea);
  }
}

export function AdminStatusPanel(props: AdminStatusPanelProps) {
  const authorized = can(props.role, 'adminStatus');
  const [open, setOpen] = useState(false);
  const [localStatus, setLocalStatus] = useState<DksAdminLocalStatus | null>(null);
  const [ipcLoaded, setIpcLoaded] = useState(false);
  const [checkingConnectivity, setCheckingConnectivity] = useState(false);
  const [connectivity, setConnectivity] = useState<SupabaseConnectivityReport>(() =>
    createInitialConnectivityReport(
      props.supabaseUrl !== undefined || props.supabaseAnonKey !== undefined
        ? Boolean(props.supabaseUrl && props.supabaseAnonKey)
        : undefined,
    ));
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const connectivityAbortRef = useRef<AbortController | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titleId = useId();
  const subtitleId = useId();

  const resolvedDiagnosticsApi = useMemo(() => {
    if (props.diagnosticsApi !== undefined) {
      return props.diagnosticsApi ?? undefined;
    }
    return typeof window !== 'undefined' ? window.dks?.diagnostics : undefined;
  }, [props.diagnosticsApi]);

  const effectiveLocal = useMemo<DksAdminLocalStatus>(() => {
    const fallback = buildFallbackLocalStatus(props);
    if (!localStatus) {
      return fallback;
    }
    return {
      ...localStatus,
      errorReporting: {
        ...localStatus.errorReporting,
        enabled: props.errorReportingEnabled ?? localStatus.errorReporting.enabled,
      },
    };
  }, [
    localStatus,
    props.appVersion,
    props.errorReportingEnabled,
    props.localStoreError,
    props.outboxFailures,
    props.syncStatus,
    props.updateState,
  ]);

  const refreshLocalStatus = useCallback(async () => {
    if (!authorized || !resolvedDiagnosticsApi) {
      setIpcLoaded(false);
      return;
    }
    try {
      const snapshot = await resolvedDiagnosticsApi.getAdminStatus({ role: 'admin' });
      setLocalStatus(snapshot);
      setIpcLoaded(true);
    } catch {
      setIpcLoaded(false);
    }
  }, [authorized, resolvedDiagnosticsApi]);

  useEffect(() => {
    if (!open || !authorized) {
      return;
    }
    void refreshLocalStatus();
  }, [open, authorized, refreshLocalStatus]);

  useEffect(() => {
    if (!open) return undefined;

    const frame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    connectivityAbortRef.current?.abort();
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);

  if (!authorized) {
    return null;
  }

  const handleClose = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleRunConnectivityChecks = async () => {
    if (checkingConnectivity) return;
    connectivityAbortRef.current?.abort();
    const controller = new AbortController();
    connectivityAbortRef.current = controller;
    setCheckingConnectivity(true);
    setConnectivity((prev) => ({
      ...prev,
      authEndpoint: {
        ...prev.authEndpoint,
        status: prev.configured ? 'checking' : 'unconfigured',
      },
      databaseRlsRead: {
        ...prev.databaseRlsRead,
        status: prev.configured ? 'checking' : 'unconfigured',
      },
    }));

    try {
      const report = await runSupabaseConnectivityChecks({
        supabaseUrl: props.supabaseUrl,
        supabaseAnonKey: props.supabaseAnonKey,
        accessToken: props.accessToken,
        dataClient: props.dataClient,
        fetchImpl: props.fetchImpl,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setConnectivity(report);
      }
    } finally {
      if (!controller.signal.aborted) {
        setCheckingConnectivity(false);
      }
      void refreshLocalStatus();
    }
  };

  const handleCopyDiagnostics = async () => {
    const text = formatSanitizedDiagnosticsText({
      local: effectiveLocal,
      connectivity,
    });
    try {
      if (props.onCopyText) {
        await props.onCopyText(text);
      } else {
        await writeTextToClipboard(text);
      }
      setCopyFeedback('Sanitized diagnostics copied to clipboard.');
    } catch {
      setCopyFeedback('Unable to access clipboard on this device.');
    }
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopyFeedback(null);
    }, 3_500);
  };

  const triggerAttention: 'ok' | 'warn' | 'error' = (
    (ipcLoaded && !effectiveLocal.localStore.available)
    || Boolean(props.localStoreError)
    || effectiveLocal.sync.status === 'error'
    || effectiveLocal.sync.failedOutboxCount > 0
    || effectiveLocal.sync.terminalOutboxCount > 0
  )
    ? 'error'
    : effectiveLocal.sync.pendingOutboxCount > 0 || effectiveLocal.sync.status === 'offline'
      ? 'warn'
      : 'ok';

  const localStoreKnown = ipcLoaded || Boolean(props.localStoreError) || Boolean(
    typeof window !== 'undefined' && window.dks?.local,
  );
  const syncBadge = renderSyncStatusBadge(effectiveLocal.sync);
  const updaterBadge = renderUpdaterLabel(effectiveLocal.updater);
  const authBadge = renderConnectivityBadge(connectivity.authEndpoint);
  const dbBadge = renderConnectivityBadge(connectivity.databaseRlsRead);
  const lastSyncFormatted = effectiveLocal.sync.lastSyncAt
    ? formatBusinessDateTime(effectiveLocal.sync.lastSyncAt)
    : 'Never synced on this device';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="admin-status-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={
            triggerAttention === 'error'
              ? 'admin-status-trigger__dot admin-status-trigger__dot--error'
              : triggerAttention === 'warn'
                ? 'admin-status-trigger__dot admin-status-trigger__dot--warn'
                : 'admin-status-trigger__dot'
          }
          aria-hidden="true"
        />
        <span>Status</span>
      </button>

      {open ? (
        <div
          className="admin-status-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleClose();
            }
          }}
        >
          <div
            ref={dialogRef}
            className="admin-status-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={subtitleId}
          >
            <header className="admin-status-dialog__header">
              <div>
                <p className="admin-eyebrow">Admin Diagnostics</p>
                <h2 id={titleId} className="admin-status-dialog__title">
                  System status
                </h2>
                <p id={subtitleId} className="admin-status-dialog__subtitle">
                  Local storage, sync queue, point-in-time connectivity checks, and privacy-safe error reporting.
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="admin-status-dialog__close"
                onClick={handleClose}
              >
                Close
              </button>
            </header>

            <div className="admin-status-dialog__body">
              <section className="admin-status-section" aria-label="Application and local store">
                <div className="admin-status-section__header">
                  <h3 className="admin-status-section__title">Application &amp; local store</h3>
                </div>
                <dl className="admin-status-rows">
                  <div className="admin-status-row">
                    <dt>App version</dt>
                    <dd>
                      <span>{effectiveLocal.appVersion}</span>
                      <span className="admin-status-badge">
                        {effectiveLocal.packaged ? 'Packaged' : 'Development'}
                      </span>
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Local SQLite store</dt>
                    <dd>
                      {!localStoreKnown ? (
                        <span className="admin-status-badge">Unknown (preload bridge not active)</span>
                      ) : effectiveLocal.localStore.available ? (
                        <>
                          <span className="admin-status-badge admin-status-badge--ok">Available</span>
                          {effectiveLocal.localStore.schemaVersion !== null ? (
                            <span>Schema v{effectiveLocal.localStore.schemaVersion}</span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <span className="admin-status-badge admin-status-badge--error">Unavailable</span>
                          {effectiveLocal.localStore.failureCode ? (
                            <span>{effectiveLocal.localStore.failureCode}</span>
                          ) : null}
                        </>
                      )}
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Release updates</dt>
                    <dd>
                      <span
                        className={
                          updaterBadge.tone === 'ok'
                            ? 'admin-status-badge admin-status-badge--ok'
                            : updaterBadge.tone === 'warn'
                              ? 'admin-status-badge admin-status-badge--warn'
                              : updaterBadge.tone === 'error'
                                ? 'admin-status-badge admin-status-badge--error'
                                : 'admin-status-badge'
                        }
                      >
                        {updaterBadge.label}
                      </span>
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="admin-status-section" aria-label="Sync and outbox">
                <div className="admin-status-section__header">
                  <h3 className="admin-status-section__title">Sync &amp; local outbox</h3>
                </div>
                <dl className="admin-status-rows">
                  <div className="admin-status-row">
                    <dt>Sync state</dt>
                    <dd>
                      <span
                        className={
                          syncBadge.tone === 'ok'
                            ? 'admin-status-badge admin-status-badge--ok'
                            : syncBadge.tone === 'warn'
                              ? 'admin-status-badge admin-status-badge--warn'
                              : syncBadge.tone === 'error'
                                ? 'admin-status-badge admin-status-badge--error'
                                : 'admin-status-badge'
                        }
                      >
                        {syncBadge.label}
                      </span>
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Pending outbox items</dt>
                    <dd>{effectiveLocal.sync.pendingOutboxCount}</dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Failed / blocked outbox items</dt>
                    <dd>
                      {effectiveLocal.sync.failedOutboxCount} failed · {effectiveLocal.sync.terminalOutboxCount} blocked
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Last successful sync (Muscat)</dt>
                    <dd>{lastSyncFormatted}</dd>
                  </div>
                </dl>
              </section>

              <section
                className="admin-status-section"
                aria-label="Supabase connectivity checks"
                aria-busy={checkingConnectivity}
              >
                <div className="admin-status-section__header">
                  <h3 className="admin-status-section__title">Supabase connectivity checks</h3>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={checkingConnectivity || !connectivity.configured}
                    onClick={() => { void handleRunConnectivityChecks(); }}
                  >
                    {checkingConnectivity ? 'Checking…' : 'Run connectivity checks'}
                  </button>
                </div>
                <dl className="admin-status-rows">
                  <div className="admin-status-row">
                    <dt>Auth service (/auth/v1/health)</dt>
                    <dd>
                      <span
                        className={
                          authBadge.tone === 'ok'
                            ? 'admin-status-badge admin-status-badge--ok'
                            : authBadge.tone === 'warn'
                              ? 'admin-status-badge admin-status-badge--warn'
                              : authBadge.tone === 'error'
                                ? 'admin-status-badge admin-status-badge--error'
                                : 'admin-status-badge'
                        }
                      >
                        {authBadge.label}
                      </span>
                      {authBadge.detail ? <span>{authBadge.detail}</span> : null}
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Database &amp; RLS read (settings)</dt>
                    <dd>
                      <span
                        className={
                          dbBadge.tone === 'ok'
                            ? 'admin-status-badge admin-status-badge--ok'
                            : dbBadge.tone === 'warn'
                              ? 'admin-status-badge admin-status-badge--warn'
                              : dbBadge.tone === 'error'
                                ? 'admin-status-badge admin-status-badge--error'
                                : 'admin-status-badge'
                        }
                      >
                        {dbBadge.label}
                      </span>
                      {dbBadge.detail ? <span>{dbBadge.detail}</span> : null}
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Background workers (Email / GitHub reporting)</dt>
                    <dd>
                      <span className="admin-status-badge">Unknown (not probed from desktop)</span>
                    </dd>
                  </div>
                  {connectivity.authEndpoint.checkedAt ? (
                    <div className="admin-status-row">
                      <dt>Last connectivity check (Muscat)</dt>
                      <dd>{formatBusinessDateTime(connectivity.authEndpoint.checkedAt)}</dd>
                    </div>
                  ) : null}
                </dl>
                <p className="admin-status-note">
                  Reachability checks only confirm whether this device reached the queried endpoint just now. A passing check does not prove full backend health, write availability, or third-party worker delivery.
                </p>
              </section>

              <section className="admin-status-section" aria-label="Automated error reporting">
                <div className="admin-status-section__header">
                  <h3 className="admin-status-section__title">Automated error reporting</h3>
                </div>
                <dl className="admin-status-rows">
                  <div className="admin-status-row">
                    <dt>Background reporting</dt>
                    <dd>
                      <span
                        className={
                          effectiveLocal.errorReporting.enabled
                            ? 'admin-status-badge admin-status-badge--ok'
                            : 'admin-status-badge'
                        }
                      >
                        {effectiveLocal.errorReporting.enabled ? 'Enabled' : 'Disabled by administrator'}
                      </span>
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Local report queue</dt>
                    <dd>
                      {effectiveLocal.errorReporting.pendingCount} pending · {effectiveLocal.errorReporting.failedCount} failed · {effectiveLocal.errorReporting.suppressedCount} duplicates suppressed
                    </dd>
                  </div>
                  <div className="admin-status-row">
                    <dt>Last delivery outcome</dt>
                    <dd>{renderDeliveryOutcome(effectiveLocal.errorReporting.lastDeliveryOutcome)}</dd>
                  </div>
                </dl>
                <p className="admin-status-note">
                  Only allowlisted diagnostic codes, component names, app version, and OS release are ever queued or sent. Customer data, emails, IDs, paths, and raw stack traces are excluded. Manage in Settings → About &amp; updates.
                </p>
              </section>
            </div>

            <footer className="admin-status-dialog__footer">
              <p className="admin-status-dialog__feedback" role="status" aria-live="polite">
                {copyFeedback ?? ''}
              </p>
              <div className="admin-status-dialog__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => { void refreshLocalStatus(); }}
                >
                  Refresh local status
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => { void handleCopyDiagnostics(); }}
                >
                  Copy diagnostics
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}
