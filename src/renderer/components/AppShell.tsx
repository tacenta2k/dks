import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { can } from '../../lib/permissions';
import { formatLocalDateTime } from '../../lib/date';
import { resolveSyncIndicator } from '../../lib/sync-indicator';
import { LOCAL_STORE_ERROR_HEADLINE } from '../../lib/local-store-error';
import type { Profile, SupabaseHealth } from '../../features/auth/auth-types';
import type {
  AppView,
  DksLocalSyncState,
  DksUpdateState,
  DksUpdaterApi,
  ResolvedTheme,
  ThemePreference,
} from '../../lib/types';
import { DashboardPage } from '../../features/dashboard/DashboardPage';
import type { DashboardFilterId } from '../../features/dashboard/selectors';
import dksLogo from '../../assets/dks-logo.png';
import dksLogoDark from '../../assets/dks-logo-dark.png';
import { NotificationBell } from '../../features/notifications/NotificationBell';
import type {
  NotificationRecord,
  SnoozeDuration,
} from '../../features/notifications/alert-service';
import {
  AdminAuditLogPanel,
  AdminRecycleBinPanel,
  AdminSheetActions,
  type AdminActor,
} from '../../features/admin';
import type { ExportSaveCallback } from '../../features/import-export/export-service';
import type { PdfExportFile, PrintReportModel } from '../../features/print/print-service';
import { SheetPage } from '../../features/sheet/SheetPage';
import type { SheetRepository } from '../../features/sheet/repository';
import {
  SettingsPage,
  type PartialSettings,
} from '../../features/settings/SettingsPage';
import type { AuditProfile } from '../../features/audit/AuditLogPage';
import type { AuditClearRemoteClient } from '../../features/audit/audit-service';
import { ConfirmDialog } from '../../features/ui/ConfirmDialog';

type AdminView = 'recycle-bin' | 'audit-log';
type ShellView = AppView | 'settings' | AdminView;

/** One queued local change shown under the sync status (Blocker 3). */
export interface SyncPendingItem {
  id: number | string;
  entityType: string;
  operation: string;
  attempts: number;
  lastError: string | null;
}

export interface AppShellProps {
  activeView?: ShellView;
  onNavigate?: (view: AppView) => void;
  themePreference?: ThemePreference;
  resolvedTheme?: ResolvedTheme;
  onThemeChange?: (preference: ThemePreference) => void;
  profile?: Profile | null;
  userEmail?: string | null;
  health?: SupabaseHealth;
  syncStatus?: DksLocalSyncState;
  /** App-owned updater status; the ready pill is shown for both roles. */
  updateState?: DksUpdateState;
  /** Existing validated updater bridge shared with Settings → About. */
  updater?: DksUpdaterApi | null;
  onUpdateStateChange?: (state: DksUpdateState) => void;
  /** Per-item pending outbox details (sanitised) for the sync status panel. */
  pendingOutbox?: readonly SyncPendingItem[];
  /**
   * R7: set when the local SQLite store could not be opened. The shell then
   * shows a real error state instead of an "offline" pill.
   */
  localStoreError?: string | null;
  isDemoMode?: boolean;
  sheetRepository?: SheetRepository;
  repositoryRevision?: number;
  dashboardThresholds?: Parameters<typeof DashboardPage>[0]['thresholds'];
  dashboardColors?: Parameters<typeof DashboardPage>[0]['colors'];
  onDashboardFilter?: (filter: DashboardFilterId) => void;
  /** Pending dashboard-card filter for the Visa Sheet (token re-applies it). */
  sheetDashboardFilter?: { filter: DashboardFilterId; token: number } | null;
  settings?: PartialSettings;
  initialSettings?: PartialSettings;
  settingsColumns?: ComponentProps<typeof SettingsPage>['columns'];
  onSettingsChange?: ComponentProps<typeof SettingsPage>['onSettingsChange'];
  /** Admin-only: client for the "Email notifications" settings section. */
  emailPrefsClient?: ComponentProps<typeof SettingsPage>['emailPrefsClient'];
  appVersion?: string;
  onCheckForUpdates?: ComponentProps<typeof SettingsPage>['onCheckForUpdates'];
  resendNote?: string;
  settingsError?: ComponentProps<typeof SettingsPage>['settingsError'];
  auditProfiles?: readonly AuditProfile[];
  /** Supabase client for the admin-only clear-audit RPC (R2-10). */
  auditRemoteClient?: AuditClearRemoteClient | null;
  onSaveExport?: ExportSaveCallback;
  onSavePdf?: (file: PdfExportFile) => void;
  onPrint?: (model: PrintReportModel) => void;
  notifications?: readonly NotificationRecord[];
  onNotificationMarkRead?: (id: string) => void;
  onNotificationDismiss?: (id: string) => void;
  onNotificationClearAll?: () => void;
  onNotificationView?: (record: Extract<NotificationRecord, { kind: 'office-delete' }>) => void;
  onNotificationRestore?: (record: Extract<NotificationRecord, { kind: 'office-delete' }>) => void | Promise<void>;
  onNotificationSnooze?: (record: NotificationRecord, duration: SnoozeDuration, customUntil?: string) => void;
  /** Admin-only Office sign-in approvals control (renders next to the bell). */
  officeApprovalsSlot?: ReactNode;
  onLogout?: () => void | Promise<void>;
}

const viewCopy: Record<AppView, { eyebrow: string; title: string; description: string }> = {
  dashboard: {
    eyebrow: 'Overview',
    title: 'Dashboard',
    description: 'Your workspace is ready for the next step.',
  },
  sheet: {
    eyebrow: 'Workspace',
    title: 'Visa sheet',
    description: 'Your visa records will appear here in STEP 4.',
  },
};

const settingsCopy = {
  eyebrow: 'Administration',
  title: 'Settings',
  description: 'Manage expiry rules, workspace defaults, and local maintenance controls.',
};

const adminViewCopy: Record<AdminView, { eyebrow: string; title: string; description: string }> = {
  'recycle-bin': {
    eyebrow: 'Administration',
    title: 'Recycle bin',
    description: 'Review deleted records and restore or permanently remove them.',
  },
  'audit-log': {
    eyebrow: 'Administration',
    title: 'Audit log',
    description: 'Review the local history of administrative record actions.',
  },
};

const SIDEBAR_COLLAPSED_KEY = 'dks.sidebarCollapsed';

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function Brand({ caption = 'Office workspace' }: { caption?: string }) {
  return (
    <div className="brand-lockup" title="DKS">
      {/* The official DKS logo — the full lockup from build/logo-source.png,
          never the generated cropped mark. It scales into the collapsed rail
          with object-contain and needs no white plate in either theme. */}
      <div className="brand-mark brand-mark--image brand-mark--logo">
        <img
          className="brand-logo__img brand-logo__img--on-light"
          src={dksLogo}
          alt="DKS — Software for businesses"
          width={96}
          height={43}
          draggable={false}
        />
        <img
          className="brand-logo__img brand-logo__img--on-dark"
          src={dksLogoDark}
          alt=""
          aria-hidden="true"
          width={96}
          height={43}
          draggable={false}
        />
      </div>
      <div className="brand-text">
        <p className="brand-caption">{caption}</p>
      </div>
    </div>
  );
}

type NavIconKind = 'dashboard' | 'sheet' | 'settings' | 'recycle' | 'audit';

/** Distinct line icon per page (FIXES_UI §4: "use distinct icons for each page"). */
function NavIcon({ kind }: { kind: NavIconKind }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false as const,
  };
  let body: ReactNode = null;
  if (kind === 'dashboard') {
    body = (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
      </>
    );
  } else if (kind === 'sheet') {
    body = (
      <>
        <rect x="3" y="4" width="18" height="16" rx="1.8" />
        <line x1="3" y1="9.4" x2="21" y2="9.4" />
        <line x1="3" y1="14.7" x2="21" y2="14.7" />
        <line x1="9.5" y1="4" x2="9.5" y2="20" />
      </>
    );
  } else if (kind === 'settings') {
    body = (
      <>
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="17" x2="20" y2="17" />
        <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
        <circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
      </>
    );
  } else if (kind === 'recycle') {
    body = (
      <>
        <path d="M4 7h16" />
        <path d="M9.5 7V4.5h5V7" />
        <path d="M6 7l1.1 12.5h9.8L18 7" />
        <line x1="10.2" y1="11" x2="10.2" y2="15.5" />
        <line x1="13.8" y1="11" x2="13.8" y2="15.5" />
      </>
    );
  } else {
    body = (
      <>
        <circle cx="12" cy="12" r="8" />
        <line x1="12" y1="12" x2="12" y2="7.5" />
        <line x1="12" y1="12" x2="15.5" y2="13.5" />
      </>
    );
  }
  return (
    <svg className="nav-item__icon" {...common}>
      {body}
    </svg>
  );
}

/** Icon-only theme toggle glyph (FIXES_UI §3.4): moon in light, sun in dark. */
function ThemeIcon({ dark }: { dark: boolean }) {
  if (dark) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="4.2" />
        <line x1="12" y1="3" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="21" />
        <line x1="3" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="21" y2="12" />
        <line x1="5.6" y1="5.6" x2="7" y2="7" />
        <line x1="17" y1="17" x2="18.4" y2="18.4" />
        <line x1="18.4" y1="5.6" x2="17" y2="7" />
        <line x1="7" y1="17" x2="5.6" y2="18.4" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}

export function AppShell({
  activeView = 'dashboard',
  onNavigate = () => undefined,
  themePreference = 'system',
  resolvedTheme = 'light',
  onThemeChange = () => undefined,
  profile = null,
  userEmail = null,
  health = {
    configured: false,
    reachable: 'unknown',
    authenticated: false,
    error: null,
  },
  syncStatus = {
    status: 'offline',
    lastSyncAt: null,
    lastError: null,
    pendingCount: 0,
  },
  updateState,
  updater,
  onUpdateStateChange,
  pendingOutbox = [],
  localStoreError = null,
  isDemoMode = false,
  sheetRepository,
  repositoryRevision = 0,
  dashboardThresholds,
  dashboardColors,
  onDashboardFilter,
  sheetDashboardFilter = null,
  settings,
  initialSettings,
  settingsColumns,
  onSettingsChange,
  emailPrefsClient = null,
  appVersion,
  onCheckForUpdates,
  resendNote,
  settingsError,
  auditProfiles = [],
  auditRemoteClient = null,
  onSaveExport,
  onSavePdf,
  onPrint,
  notifications = [],
  onNotificationMarkRead,
  onNotificationDismiss,
  onNotificationClearAll,
  onNotificationView,
  onNotificationRestore,
  onNotificationSnooze,
  officeApprovalsSlot = null,
  onLogout = () => undefined,
}: AppShellProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(activeView === 'settings');
  const [adminView, setAdminView] = useState<AdminView | null>(null);
  const [sheetRevision, setSheetRevision] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [syncOpen, setSyncOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [restartPromptVersion, setRestartPromptVersion] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const syncRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);

  // FIXES_UI §4: sidebar collapsed state persists after app restart.
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      /* storage unavailable (private mode) — collapse state is best-effort */
    }
  }, [sidebarCollapsed]);

  // FIXES_UI §3.2/§3.5: Escape or clicking outside closes the sync popover and
  // the account popup.
  useEffect(() => {
    if (!syncOpen && !avatarOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSyncOpen(false);
        setAvatarOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (syncRef.current && target && !syncRef.current.contains(target)) {
        setSyncOpen(false);
      }
      if (avatarRef.current && target && !avatarRef.current.contains(target)) {
        setAvatarOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [syncOpen, avatarOpen]);
  // Both counters drive IN-PLACE re-fetches of the visible page (no remount):
  // sheetRevision = local mutation, repositoryRevision = sync landed data.
  const pageRefreshToken = sheetRevision * 100_000 + repositoryRevision;
  const effectiveView: ShellView = adminView
    ?? (isSettingsOpen || activeView === 'settings' ? 'settings' : activeView);
  const copy = effectiveView === 'settings'
    ? settingsCopy
    : effectiveView === 'recycle-bin' || effectiveView === 'audit-log'
      ? adminViewCopy[effectiveView]
      : viewCopy[effectiveView];
  const role = profile?.role;
  const displayEmail = userEmail ?? profile?.email ?? (isDemoMode ? 'demo@dks.local' : null);
  const actor: AdminActor | null = profile
    ? { id: profile.id, name: profile.fullName ?? profile.email, email: profile.email }
    : null;
  // FIXES_UI §3.2 / R2-12: four real states from the outbox — never a
  // decorative label. "Saved to cloud" only after confirmed acknowledgement
  // (status healthy AND no pending items); any queued or failed item shows
  // "Sync error · N pending" (or "Syncing… · N pending") so the pill can
  // never claim success while work is outstanding.
  const localStoreFailureMessage = typeof localStoreError === 'string' && localStoreError.trim()
    ? localStoreError.trim()
    : null;
  // R7: a missing local database is never reported as "offline"; "Offline —
  // saved locally" would be a lie because nothing can be saved at all.
  const syncIndicator = localStoreFailureMessage
    ? { key: 'error' as const, label: LOCAL_STORE_ERROR_HEADLINE, pendingSuffix: '' }
    : resolveSyncIndicator(syncStatus.status, syncStatus.pendingCount);
  const syncStateKey = syncIndicator.key;
  const pendingSuffix = syncIndicator.pendingSuffix;
  const syncLabel = syncIndicator.label;
  const brandCaption = profile?.role === 'admin' ? 'Admin workspace' : 'Office workspace';
  const updateReadyVersion = updateState?.status === 'downloaded'
    ? updateState.version?.trim() || null
    : null;
  const openRestartPrompt = () => {
    setRestartError(null);
    setRestartPromptVersion(updateReadyVersion ?? '');
  };
  const closeRestartPrompt = () => {
    setRestartError(null);
    setRestartPromptVersion(null);
  };
  const confirmRestartToUpdate = async () => {
    setRestartError(null);
    let started = false;
    try {
      started = updater ? await updater.restartToUpdate() : false;
    } catch {
      started = false;
    }
    if (started) {
      setRestartPromptVersion(null);
      return;
    }
    setRestartError('DKS could not restart to install the update. Please try again.');
  };

  return (
    <div className="app-shell">
      <aside
        className="sidebar"
        data-collapsed={sidebarCollapsed}
        aria-label="Sidebar"
      >
        <Brand caption={brandCaption} />
        <nav className="sidebar__nav" aria-label="Primary navigation">
          <button
            className={`nav-item${effectiveView === 'dashboard' ? ' nav-item--active' : ''}`}
            type="button"
            aria-current={effectiveView === 'dashboard' ? 'page' : 'false'}
            aria-label="Dashboard"
            title="Dashboard"
            onClick={() => {
              setIsSettingsOpen(false);
              setAdminView(null);
              onNavigate('dashboard');
            }}
          >
            <NavIcon kind="dashboard" />
            <span className="nav-item__label">Dashboard</span>
          </button>
          <button
            className={`nav-item${effectiveView === 'sheet' ? ' nav-item--active' : ''}`}
            type="button"
            aria-current={effectiveView === 'sheet' ? 'page' : 'false'}
            aria-label="Visa Sheet"
            title="Visa Sheet"
            onClick={() => {
              setIsSettingsOpen(false);
              setAdminView(null);
              onNavigate('sheet');
            }}
          >
            <NavIcon kind="sheet" />
            <span className="nav-item__label">Visa Sheet</span>
          </button>
          {can(role, 'adminNavigation') ? (
            <button
              className={`nav-item${effectiveView === 'settings' ? ' nav-item--active' : ''}`}
              type="button"
              aria-current={effectiveView === 'settings' ? 'page' : 'false'}
              aria-label="Settings"
              title="Settings"
              onClick={() => {
                setAdminView(null);
                setIsSettingsOpen(true);
              }}
            >
              <NavIcon kind="settings" />
              <span className="nav-item__label">Settings</span>
            </button>
          ) : null}
          {can(role, 'recycleBin') ? (
            <button
              className={`nav-item${effectiveView === 'recycle-bin' ? ' nav-item--active' : ''}`}
              type="button"
              aria-current={effectiveView === 'recycle-bin' ? 'page' : 'false'}
              aria-label="Recycle Bin"
              title="Recycle Bin"
              onClick={() => {
                setIsSettingsOpen(false);
                setAdminView('recycle-bin');
                setSheetRevision((revision) => revision + 1);
              }}
            >
              <NavIcon kind="recycle" />
              <span className="nav-item__label">Recycle Bin</span>
            </button>
          ) : null}
          {can(role, 'auditLog') ? (
            <button
              className={`nav-item${effectiveView === 'audit-log' ? ' nav-item--active' : ''}`}
              type="button"
              aria-current={effectiveView === 'audit-log' ? 'page' : 'false'}
              aria-label="Audit Log"
              title="Audit Log"
              onClick={() => {
                setIsSettingsOpen(false);
                setAdminView('audit-log');
                setSheetRevision((revision) => revision + 1);
              }}
            >
              <NavIcon kind="audit" />
              <span className="nav-item__label">Audit Log</span>
            </button>
          ) : null}
        </nav>
      </aside>

      <div className="app-shell__body">
        <header className="top-bar" role="banner" aria-label="DKS top bar">
          <div className="top-bar__left">
            <button
              className="top-bar__menu"
              type="button"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <span aria-hidden="true">☰</span>
            </button>
            <h1 className="top-bar__title">{copy.title}</h1>
          </div>
          <div className="top-bar__actions">
            {updateState?.status === 'downloaded' ? (
              <div className="topbar-update" role="status">
                <span className="topbar-update__dot" aria-hidden="true" />
                <span className="topbar-update__label">
                  Update{updateReadyVersion ? ` ${updateReadyVersion}` : ''} ready
                </span>
                <button
                  className="topbar-update__button"
                  type="button"
                  onClick={openRestartPrompt}
                >
                  Restart to install
                </button>
              </div>
            ) : null}
            <div className="topbar-sync" ref={syncRef}>
              <button
                className="topbar-sync__button"
                type="button"
                data-state={syncStateKey}
                aria-haspopup="dialog"
                aria-expanded={syncOpen}
                title={syncLabel}
                onClick={() => setSyncOpen((value) => !value)}
              >
                <span className="sync-status__dot" data-state={syncStateKey} aria-hidden="true" />
                <span className="sync-status__detail">{syncLabel}</span>
              </button>
              <div
                className={`topbar-sync__popover${syncOpen ? ' is-open' : ''}`}
                role="dialog"
                aria-label="Sync details"
              >
                <p className="topbar-sync__line">
                  Last sync: {syncStatus.lastSyncAt ? formatLocalDateTime(syncStatus.lastSyncAt) : 'Not yet'}
                </p>
                <p className="topbar-sync__line">
                  {syncStatus.pendingCount} pending change{syncStatus.pendingCount === 1 ? '' : 's'}
                </p>
                {syncStatus.lastError !== null || syncStatus.pendingCount > 0 ? (
                  <details className="sync-status__issues">
                    <summary>
                      {syncStatus.lastError
                        ?? `${syncStatus.pendingCount} pending change${syncStatus.pendingCount === 1 ? '' : 's'}`}
                    </summary>
                    {pendingOutbox.length > 0 ? (
                      <ul className="sync-status__list">
                        {pendingOutbox.map((item) => (
                          <li key={item.id}>
                            {item.entityType} · {item.operation} · attempted {item.attempts}×
                            {item.lastError ? ` · ${item.lastError}` : ' · waiting for sync'}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </details>
                ) : null}
              </div>
            </div>
            {officeApprovalsSlot ?? null}
            <NotificationBell
              notifications={notifications}
              onMarkRead={onNotificationMarkRead}
              onDismiss={onNotificationDismiss}
              onClearAll={onNotificationClearAll}
              onView={onNotificationView}
              onRestore={onNotificationRestore}
              onSnooze={onNotificationSnooze}
            />
            <button
              className="topbar-theme"
              type="button"
              aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={() => onThemeChange(resolvedTheme === 'dark' ? 'light' : 'dark')}
            >
              <ThemeIcon dark={resolvedTheme === 'dark'} />
            </button>
            <div className="topbar-avatar" ref={avatarRef}>
              <button
                className="avatar"
                type="button"
                aria-label="Account"
                aria-haspopup="menu"
                aria-expanded={avatarOpen}
                onClick={() => setAvatarOpen((value) => !value)}
              >
                {(displayEmail?.[0] ?? 'D').toUpperCase()}
              </button>
              {avatarOpen ? (
                <div className="topbar-avatar__popup" role="menu" aria-label="Account menu">
                  <div className="topbar-avatar__identity">
                    <p className="topbar-avatar__email">{displayEmail ?? 'Not signed in'}</p>
                    <p className="topbar-avatar__role">
                      {profile ? (profile.role === 'admin' ? 'Admin' : 'Office') : 'Preview'}
                    </p>
                  </div>
                  <hr className="topbar-avatar__divider" />
                  <button
                    className="topbar-avatar__logout"
                    type="button"
                    onClick={() => {
                      setAvatarOpen(false);
                      onLogout();
                    }}
                  >
                    Log out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <ConfirmDialog
          open={restartPromptVersion !== null}
          title="Restart to install update?"
          confirmLabel="Restart now"
          error={restartError}
          onConfirm={confirmRestartToUpdate}
          onCancel={closeRestartPrompt}
        >
          Restart DKS to install update{restartPromptVersion ? ` ${restartPromptVersion}` : ''}?
          Your work is already saved on this device. DKS will close and reopen.
        </ConfirmDialog>

        <main
          className={`content${effectiveView === 'sheet' ? ' content--sheet' : ''}`}
          aria-label={copy.title}
        >
          {localStoreFailureMessage ? (
            <div className="local-store-error" role="alert" data-testid="local-store-error">
              <p className="local-store-error__headline">
                <span className="local-store-error__dot" aria-hidden="true" />
                {LOCAL_STORE_ERROR_HEADLINE}
              </p>
              <p className="local-store-error__body">
                Entries cannot be read or saved on this device until the local database starts.
                Settings and the cloud connection are unaffected.
              </p>
              <details className="local-store-error__details">
                <summary>Technical details</summary>
                <p>{localStoreFailureMessage}</p>
              </details>
            </div>
          ) : null}

           {effectiveView === 'dashboard' ? (
             // No revision in the key: remounting on every sync destroyed
             // in-progress input focus. The token below re-fetches in place.
             <DashboardPage
                repository={sheetRepository}
               thresholds={dashboardThresholds}
                colors={dashboardColors}
                onFilter={onDashboardFilter}
                refreshToken={pageRefreshToken}
              />
           ) : effectiveView === 'sheet' ? (
             // R2-09: no centered wrapper and no Administrator Tools card. The
             // grid fills the page; the Admin-only Tools menu lives in the
             // sheet's single toolbar, and Office gets no tools at all.
             <SheetPage
               repository={sheetRepository}
               role={role}
               refreshToken={pageRefreshToken}
               dashboardFilter={sheetDashboardFilter?.filter ?? null}
               dashboardFilterToken={sheetDashboardFilter?.token ?? 0}
               theme={resolvedTheme}
               thresholds={dashboardThresholds}
               toolsMenu={(
                 <AdminSheetActions
                   repository={sheetRepository}
                   role={role}
                   actor={actor}
                   onSaveExport={onSaveExport}
                   onSavePdf={onSavePdf}
                   onPrint={onPrint}
                   onRepositoryChanged={() => setSheetRevision((revision) => revision + 1)}
                 />
               )}
             />
           ) : effectiveView === 'recycle-bin' ? (
              <AdminRecycleBinPanel
                repository={sheetRepository}
                role={role}
                actor={actor}
                onRepositoryChanged={() => setSheetRevision((revision) => revision + 1)}
                refreshToken={pageRefreshToken}
              />
           ) : effectiveView === 'audit-log' ? (
             <AdminAuditLogPanel
               key={`audit-log-${sheetRevision}`}
               repository={sheetRepository}
               role={role}
               profiles={auditProfiles}
               actorLabel={actor?.name ?? null}
               remoteClient={auditRemoteClient ?? null}
             />
           ) : (
             <SettingsPage
               role={role}
               settings={settings}
               initialSettings={initialSettings}
               columns={settingsColumns}
               repository={sheetRepository}
               onSettingsChange={onSettingsChange}
               emailPrefsClient={emailPrefsClient}
               appVersion={appVersion}
               updater={updater}
               updateState={updateState}
               onUpdateStateChange={onUpdateStateChange}
                onCheckForUpdates={onCheckForUpdates}
                resendNote={resendNote}
                settingsError={settingsError}
               onClose={() => {
                 setIsSettingsOpen(false);
                 setAdminView(null);
                 onNavigate('dashboard');
               }}
             />
           )}
        </main>
      </div>
    </div>
  );
}
