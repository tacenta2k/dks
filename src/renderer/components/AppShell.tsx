import { useState, type ComponentProps } from 'react';

import { can } from '../../lib/permissions';
import type { Profile, SupabaseHealth } from '../../features/auth/auth-types';
import type { AppView, ResolvedTheme, ThemePreference } from '../../lib/types';
import type { DksLocalSyncState } from '../../lib/types';
import { DashboardPage } from '../../features/dashboard/DashboardPage';
import type { DashboardFilterId } from '../../features/dashboard/selectors';
import { NotificationBell } from '../../features/notifications/NotificationBell';
import type {
  NotificationRecord,
  SnoozeDuration,
} from '../../features/notifications/alert-service';
import {
  AdminAuditLogPanel,
  AdminRecycleBinPanel,
  AdminSheetActions,
  exportCurrentRows,
  saveArtifactWithBrowserFallback,
  type AdminActor,
} from '../../features/admin';
import type { ExportSaveCallback } from '../../features/import-export/export-service';
import type { PdfExportFile, PrintReportModel } from '../../features/print/print-service';
import { SheetPage } from '../../features/sheet/SheetPage';
import type { SheetRepository } from '../../features/sheet/repository';
import {
  SettingsPage,
  type BackupInfo,
  type PartialSettings,
} from '../../features/settings/SettingsPage';

type AdminView = 'recycle-bin' | 'audit-log';
type ShellView = AppView | 'settings' | AdminView;

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
  isDemoMode?: boolean;
  sheetRepository?: SheetRepository;
  repositoryRevision?: number;
  dashboardThresholds?: Parameters<typeof DashboardPage>[0]['thresholds'];
  dashboardColors?: Parameters<typeof DashboardPage>[0]['colors'];
  onDashboardFilter?: (filter: DashboardFilterId) => void;
  settings?: PartialSettings;
  initialSettings?: PartialSettings;
  settingsColumns?: ComponentProps<typeof SettingsPage>['columns'];
  onSettingsChange?: ComponentProps<typeof SettingsPage>['onSettingsChange'];
  backupInfo?: BackupInfo;
  onBackupNow?: ComponentProps<typeof SettingsPage>['onBackupNow'];
  appVersion?: string;
  onCheckForUpdates?: ComponentProps<typeof SettingsPage>['onCheckForUpdates'];
  resendNote?: string;
  onSaveExport?: ExportSaveCallback;
  onSavePdf?: (file: PdfExportFile) => void;
  onPrint?: (model: PrintReportModel) => void;
  notifications?: readonly NotificationRecord[];
  onNotificationMarkRead?: (id: string) => void;
  onNotificationDismiss?: (id: string) => void;
  onNotificationSnooze?: (record: NotificationRecord, duration: SnoozeDuration, customUntil?: string) => void;
  onLogout?: () => void | Promise<void>;
}

const themeLabels: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

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

function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark" aria-hidden="true">
        <span>D</span>
      </div>
      <div>
        <p className="brand-name">DKS</p>
        <p className="brand-caption">Office workspace</p>
      </div>
    </div>
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
  isDemoMode = false,
  sheetRepository,
  repositoryRevision = 0,
  dashboardThresholds,
  dashboardColors,
  onDashboardFilter,
  settings,
  initialSettings,
  settingsColumns,
  onSettingsChange,
  backupInfo,
  onBackupNow,
  appVersion,
  onCheckForUpdates,
  resendNote,
  onSaveExport,
  onSavePdf,
  onPrint,
  notifications = [],
  onNotificationMarkRead,
  onNotificationDismiss,
  onNotificationSnooze,
  onLogout = () => undefined,
}: AppShellProps) {
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(activeView === 'settings');
  const [adminView, setAdminView] = useState<AdminView | null>(null);
  const [sheetRevision, setSheetRevision] = useState(0);
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
  const isAdminFullPage = effectiveView === 'recycle-bin' || effectiveView === 'audit-log';
  const healthLabel = isDemoMode
    ? 'Offline demo'
    : health.reachable === 'reachable'
      ? 'Supabase healthy'
      : health.reachable === 'unreachable'
        ? 'Supabase unavailable'
        : health.configured
          ? 'Supabase checking'
          : 'Supabase not configured';
  const syncDetail = syncStatus.status === 'syncing'
    ? 'Syncing local changes…'
    : syncStatus.status === 'error'
      ? `Sync error${syncStatus.pendingCount > 0 ? ` · ${syncStatus.pendingCount} pending` : ''}`
      : syncStatus.pendingCount > 0
        ? `${healthLabel} · ${syncStatus.pendingCount} pending`
        : healthLabel;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Sidebar">
        <Brand />
        <nav className="sidebar__nav" aria-label="Primary navigation">
          <p className="sidebar__label">Workspace</p>
          <button
            className={`nav-item${effectiveView === 'dashboard' ? ' nav-item--active' : ''}`}
            type="button"
            aria-current={effectiveView === 'dashboard' ? 'page' : 'false'}
            aria-label="Open Dashboard"
            onClick={() => {
              setIsSettingsOpen(false);
              setAdminView(null);
              onNavigate('dashboard');
            }}
          >
            <span className="nav-item__icon nav-item__icon--grid" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>Dashboard</span>
          </button>
          <button
            className={`nav-item${effectiveView === 'sheet' ? ' nav-item--active' : ''}`}
            type="button"
            aria-current={effectiveView === 'sheet' ? 'page' : 'false'}
            aria-label="Open Sheet"
            onClick={() => {
              setIsSettingsOpen(false);
              setAdminView(null);
              onNavigate('sheet');
            }}
          >
            <span className="nav-item__icon nav-item__icon--sheet" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Visa sheet</span>
           </button>
          {can(role, 'adminNavigation') ? (
            <button
              className={`nav-item${effectiveView === 'settings' ? ' nav-item--active' : ''}`}
              type="button"
              aria-current={effectiveView === 'settings' ? 'page' : 'false'}
              aria-label="Open Admin tools / Settings"
              onClick={() => {
                setAdminView(null);
                setIsSettingsOpen(true);
              }}
            >
              <span className="nav-item__icon nav-item__icon--grid" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span>Settings</span>
            </button>
          ) : null}
          {can(role, 'recycleBin') ? (
            <button
              className={`nav-item${effectiveView === 'recycle-bin' ? ' nav-item--active' : ''}`}
              type="button"
              aria-current={effectiveView === 'recycle-bin' ? 'page' : 'false'}
              aria-label="Open Recycle Bin"
              onClick={() => {
                setIsSettingsOpen(false);
                setAdminView('recycle-bin');
                setSheetRevision((revision) => revision + 1);
              }}
            >
              <span className="nav-item__icon nav-item__icon--grid" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span>Recycle Bin</span>
            </button>
          ) : null}
          {can(role, 'auditLog') ? (
            <button
              className={`nav-item${effectiveView === 'audit-log' ? ' nav-item--active' : ''}`}
              type="button"
              aria-current={effectiveView === 'audit-log' ? 'page' : 'false'}
              aria-label="Open Audit Log"
              onClick={() => {
                setIsSettingsOpen(false);
                setAdminView('audit-log');
                setSheetRevision((revision) => revision + 1);
              }}
            >
              <span className="nav-item__icon nav-item__icon--grid" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span>Audit Log</span>
            </button>
          ) : null}
        </nav>
        <div className="sidebar__bottom">
          <div className="sync-status">
            <span className="sync-status__dot" aria-hidden="true" />
            <div>
              <p className="sync-status__title">Workspace health</p>
              <p className="sync-status__detail">{syncDetail}</p>
            </div>
          </div>
          <p className="sidebar__version">STEP 2 · Role-gated workspace</p>
        </div>
      </aside>

      <div className="app-shell__body">
        <header className="top-bar" role="banner" aria-label="DKS top bar">
          <div className="top-bar__heading">
             <p className="breadcrumb">DKS <span aria-hidden="true">/</span> {copy.eyebrow}</p>
            <p className="top-bar__context">A focused space for your team&apos;s records</p>
          </div>
          <div className="top-bar__actions">
            <NotificationBell
              notifications={notifications}
              onMarkRead={onNotificationMarkRead}
              onDismiss={onNotificationDismiss}
              onSnooze={onNotificationSnooze}
            />
            <div className="theme-control">
              <button
                className="theme-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={isThemeMenuOpen}
                aria-label={`Theme: ${themePreference}`}
                onClick={() => setIsThemeMenuOpen((isOpen) => !isOpen)}
              >
                <span className="theme-button__swatch" data-theme-icon={resolvedTheme} aria-hidden="true" />
                <span>Theme: {themeLabels[themePreference]}</span>
                <span className="theme-button__chevron" aria-hidden="true">⌄</span>
              </button>
              {isThemeMenuOpen ? (
                <div className="theme-menu" role="menu" aria-label="Theme preference">
                  {(Object.keys(themeLabels) as ThemePreference[]).map((preference) => (
                    <button
                      className="theme-menu__item"
                      type="button"
                      role="menuitemradio"
                      aria-checked={themePreference === preference}
                      key={preference}
                      onClick={() => {
                        onThemeChange(preference);
                        setIsThemeMenuOpen(false);
                      }}
                    >
                      <span>{themeLabels[preference]}</span>
                      {themePreference === preference ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {displayEmail ? (
              <div style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
                <span style={{ color: 'var(--color-text)', fontSize: 12, fontWeight: 700 }}>
                  {displayEmail}
                </span>
                {profile ? (
                  <span
                    aria-label={`Role: ${profile.role}`}
                    style={{ color: 'var(--color-text-muted)', fontSize: 10, fontWeight: 700 }}
                  >
                    {profile.role === 'admin' ? 'Admin' : 'Office'}
                  </span>
                ) : null}
              </div>
            ) : null}
            <button className="button" type="button" onClick={onLogout}>
              Log out
            </button>
            <div className="avatar" aria-label={displayEmail ? `Signed in as ${displayEmail}` : 'DKS preview user'}>
              {(displayEmail?.[0] ?? 'D').toUpperCase()}
            </div>
          </div>
        </header>

        <main
          className="content"
          aria-label={isAdminFullPage ? copy.title : undefined}
          aria-labelledby={isAdminFullPage ? undefined : 'page-title'}
        >
          {!isAdminFullPage ? <div className="content__intro">
            <div>
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1 id="page-title">{copy.title}</h1>
              <p className="content__description">{copy.description}</p>
            </div>
            <div className="content__badge">
              <span className="content__badge-dot" aria-hidden="true" />
              <span>Offline-first</span>
            </div>
            {can(role, 'export') ? (
              <button
                className="button"
                type="button"
                aria-label="Export data"
                onClick={() => {
                  if (sheetRepository) {
                    void exportCurrentRows(
                      sheetRepository,
                      role,
                      'csv',
                      onSaveExport ?? saveArtifactWithBrowserFallback,
                    );
                  }
                }}
              >
                Export data
              </button>
            ) : null}
          </div> : null}

           {effectiveView === 'dashboard' ? (
             <DashboardPage
                key={`dashboard-${repositoryRevision}`}
                repository={sheetRepository}
               thresholds={dashboardThresholds}
               colors={dashboardColors}
               onFilter={onDashboardFilter}
             />
           ) : effectiveView === 'sheet' ? (
             <div className="admin-integrated-sheet">
               <AdminSheetActions
                 repository={sheetRepository}
                 role={role}
                 actor={actor}
                 onSaveExport={onSaveExport}
                 onSavePdf={onSavePdf}
                 onPrint={onPrint}
                 onRepositoryChanged={() => setSheetRevision((revision) => revision + 1)}
               />
                <SheetPage
                   key={`${sheetRevision}-${repositoryRevision}`}
                  repository={sheetRepository}
                  hideAdminActions
                  role={role}
                />
             </div>
           ) : effectiveView === 'recycle-bin' ? (
             <AdminRecycleBinPanel
                key={`recycle-bin-${sheetRevision}-${repositoryRevision}`}
               repository={sheetRepository}
               role={role}
               actor={actor}
               onRepositoryChanged={() => setSheetRevision((revision) => revision + 1)}
             />
           ) : effectiveView === 'audit-log' ? (
             <AdminAuditLogPanel key={`audit-log-${sheetRevision}`} repository={sheetRepository} role={role} />
           ) : (
             <SettingsPage
               role={role}
               settings={settings}
               initialSettings={initialSettings}
               columns={settingsColumns}
               repository={sheetRepository}
               onSettingsChange={onSettingsChange}
               backupInfo={backupInfo}
               onBackupNow={onBackupNow}
               appVersion={appVersion}
               onCheckForUpdates={onCheckForUpdates}
               resendNote={resendNote}
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
