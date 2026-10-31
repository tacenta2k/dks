import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { createAuthService, AuthService } from '../features/auth/auth-service';
import { AuthScreen } from '../features/auth/AuthScreen';
import { RESTORE_UNREACHABLE_CODE } from '../features/auth/auth-errors';
import { OfficeApprovalGate } from '../features/auth/OfficeApprovalGate';
import { OfficeApprovalsPanel } from '../features/admin/OfficeApprovalsPanel';
import { AdminStatusPanel } from '../features/diagnostics/AdminStatusPanel';
import type { ConnectivityQueryClient } from '../features/diagnostics/connectivity-checks';
import {
  defaultErrorReporter,
  extractSafeHttpStatus,
  extractSafePostgresCode,
  isRoutineOfflineError,
} from '../features/diagnostics/error-reporting';
import { createOfficeApprovalService, type OfficeApprovalService } from '../features/auth/office-approval-service';
import {
  hasSavedThemePreference,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../lib/theme';
import type {
  AppView,
  DksLocalSyncState,
  DksUpdateState,
  DksUpdaterApi,
  ThemePreference,
} from '../lib/types';
import { localStoreErrorMessage } from '../lib/local-store-error';
import { sanitizeSyncError } from '../lib/sync-error';
import { rowDisplayLabel } from '../lib/labels';
import type { DashboardFilterId } from '../features/dashboard/selectors';
import { createSyncingRepositoryProxy } from '../lib/sync-trigger';
import { isSupabaseConfigured } from '../lib/supabase';
import { AppShell, type SyncPendingItem } from './components/AppShell';
import { StartupSplash } from './components/StartupSplash';
import { createAppStore, type AppStoreOptions } from '../lib/store';
import { activeTimingSpan, startTimingSpan } from '../lib/timing';
import { createElectronSheetRepository } from '../features/sheet/electron-repository';
import type { SheetRepository } from '../features/sheet/repository';
import type { DksSettings, PartialSettings } from '../features/settings/SettingsPage';
import type { AuditProfile } from '../features/audit/AuditLogPage';
import {
  loadWorkspaceSettings,
  partialSettingsToRecord,
  saveWorkspaceSettings,
  settingsRecordToPartialSettings,
  type SettingsDataClient,
} from '../features/settings/settings-service';
import {
  createSnooze,
  dedupeNotifications,
  evaluateAlerts,
  evaluateSummaryNotifications,
  isNotificationSnoozed,
  notificationStableKey,
  refreshExpiryNotificationLabels,
  snoozeUntil,
  type AlertSnooze,
  type NotificationRecord,
  type SnoozeDuration,
} from '../features/notifications/alert-service';
import {
  fromLocalNotification,
  toLocalNotificationInput,
} from '../features/notifications/local-notifications';
import { notificationOsContent } from '../features/notifications/notification-display';
import {
  dismissAdminNotification,
  loadAdminNotifications,
  restoreDeletedEntry,
  type AdminNotificationClient,
} from '../features/notifications/remote-notifications';
import {
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseSyncLocal,
  type SupabaseSyncResult,
} from '../features/sync/supabase-sync';
import {
  createLiveSheetWatcher,
  type LiveSheetClientLike,
} from '../features/sync/live-sheet-realtime';

export interface AppProps {
  /** Store tuning (tests shorten the transient-restore back-off). */
  storeOptions?: AppStoreOptions;
  initialView?: AppView;
  initialThemePreference?: ThemePreference;
  startInWorkspace?: boolean;
  authService?: AuthService;
  /**
   * Office sign-in approval service (default: the real Supabase-backed one).
   * Tests inject fakes here to drive pending/approved/denied states.
   */
  approvalService?: OfficeApprovalService | null;
  demoMode?: boolean;
  sheetRepository?: SheetRepository;
  /**
   * Desktop updater bridge (default: the frozen `window.dks.updater` preload
   * API). Tests inject a fake here; `null` forces the no-bridge state.
   */
  updater?: DksUpdaterApi | null;
}

/** Upper bound for the start-up splash if session restoration never settles. */
const RESTORE_SPLASH_MAX_MS = 20_000;

function getSystemDarkPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function App({
  initialView = 'dashboard',
  initialThemePreference,
  startInWorkspace = false,
  authService: providedAuthService,
  approvalService: providedApprovalService,
  demoMode,
  sheetRepository: providedSheetRepository,
  updater: providedUpdater,
  storeOptions,
}: AppProps) {
  const [authService] = useState(() => providedAuthService ?? createAuthService());
  const [approvalService] = useState(() => providedApprovalService === undefined
    ? createOfficeApprovalService()
    : providedApprovalService);
  const [appStore] = useState(() => createAppStore(authService, approvalService, storeOptions));
  const [baseSheetRepository] = useState<SheetRepository>(
    () => providedSheetRepository ?? createElectronSheetRepository({ role: 'office' }),
  );
  // Local-mutation -> sync flush (Blocker 3): every successful local write
  // schedules an immediate sync instead of waiting for the 60s timer.
  const requestSyncRef = useRef<(() => void) | null>(null);
  const syncNowRef = useRef<(() => Promise<void>) | null>(null);
  const syncFlushTimerRef = useRef<number | null>(null);
  const requestSync = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (syncFlushTimerRef.current !== null) {
      window.clearTimeout(syncFlushTimerRef.current);
    }
    syncFlushTimerRef.current = window.setTimeout(() => {
      syncFlushTimerRef.current = null;
      requestSyncRef.current?.();
    }, 1_500);
  }, []);
  const [sheetRepository] = useState<SheetRepository>(() =>
    createSyncingRepositoryProxy(baseSheetRepository, requestSync),
  );
  const [activeView, setActiveView] = useState<AppView>(initialView);
  // Dashboard card navigation: the clicked card's exact filter, applied by
  // the Visa Sheet (token increments so re-clicking a card re-applies it).
  const [dashboardSheetFilter, setDashboardSheetFilter] = useState<
    { filter: DashboardFilterId; token: number } | null
  >(null);
  const handleDashboardFilter = useCallback((filter: DashboardFilterId) => {
    setDashboardSheetFilter((current) => ({ filter, token: (current?.token ?? 0) + 1 }));
    setActiveView('sheet');
  }, []);
  const handleDashboardRefresh = useCallback(async () => {
    if (!syncNowRef.current) {
      throw new Error('Cloud sync is not available on this device.');
    }
    await syncNowRef.current();
  }, []);
  const [updaterBridge] = useState<DksUpdaterApi | null>(() => (
    providedUpdater !== undefined
      ? providedUpdater
      : (typeof window !== 'undefined' ? window.dks?.updater ?? null : null)
  ));
  const [updateState, setUpdateState] = useState<DksUpdateState>({ status: 'idle' });

  // Single renderer subscription to the main-process updater status event.
  // The shell's update-ready pill and the Admin Settings panel both render
  // from this one state value; neither polls or opens another IPC channel.
  useEffect(() => {
    if (!updaterBridge) {
      return undefined;
    }
    return updaterBridge.onStatus(setUpdateState);
  }, [updaterBridge]);
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    initialThemePreference ?? loadThemePreference(),
  );
  const [systemDark, setSystemDark] = useState(getSystemDarkPreference);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [snoozes, setSnoozes] = useState<AlertSnooze[]>([]);
  const [repositoryRevision, setRepositoryRevision] = useState(0);
  const [syncStatus, setSyncStatus] = useState<DksLocalSyncState>({
    status: 'offline',
    lastSyncAt: null,
    lastError: null,
    pendingCount: 0,
  });
  const [pendingOutbox, setPendingOutbox] = useState<readonly SyncPendingItem[]>([]);
  // R7: a local-storage failure is not "offline". It is surfaced explicitly so
  // the shell never claims the data was saved locally when it was not.
  const [localStoreError, setLocalStoreError] = useState<string | null>(null);
  const [workspaceSettings, setWorkspaceSettings] = useState<PartialSettings | undefined>(undefined);
  const [auditProfiles, setAuditProfiles] = useState<AuditProfile[]>([]);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const lastSettingsSignature = useRef('');
  const resolvedTheme = resolveTheme(themePreference, systemDark);
  const authStatus = useStore(appStore, (state) => state.authStatus);
  const authError = useStore(appStore, (state) => state.authError);
  const isRestoringSession = useStore(appStore, (state) => state.isRestoringSession);
  // Fail-safe only: if session restoration never settles (a hung network
  // request), stop showing the splash eventually so the user is never stuck.
  const [restoreSplashExpired, setRestoreSplashExpired] = useState(false);
  const session = useStore(appStore, (state) => state.session);
  const profile = useStore(appStore, (state) => state.profile);
  const health = useStore(appStore, (state) => state.health);
  const handleSignOutAllOfficeSessions = useCallback(async () => {
    if (authStatus !== 'authenticated' || profile?.role !== 'admin') {
      throw new Error('Only an administrator can sign out Office sessions.');
    }
    const result = await appStore.getState().signOutAllOfficeSessions();
    if (result.error || !result.data) {
      throw new Error(result.error?.message ?? 'Office sessions could not be signed out.');
    }
    return result.data;
  }, [appStore, authStatus, profile?.role]);
  const isDevelopment = import.meta.env.DEV || import.meta.env.MODE === 'test';
  const demoAvailable =
    !isSupabaseConfigured() && !authService.isConfigured && isDevelopment && (demoMode ?? true);

  useEffect(() => {
    sheetRepository.setRole?.(profile?.role ?? 'office');
  }, [profile?.role, sheetRepository]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    let mediaQuery: MediaQueryList;
    try {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }

    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };

    mediaQuery.addEventListener?.('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener?.('change', handleSystemThemeChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (authService.isConfigured) {
      void appStore.getState().restoreSession();
      return undefined;
    }

    appStore.getState().reset();
    if (demoAvailable && startInWorkspace) {
      appStore.getState().setDemoSession();
    }

    return undefined;
  }, [appStore, authService, demoAvailable, startInWorkspace]);

  useEffect(() => {
    if (!isRestoringSession) {
      return undefined;
    }
    const timer = window.setTimeout(() => setRestoreSplashExpired(true), RESTORE_SPLASH_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [isRestoringSession]);

  const handleThemeChange = (preference: ThemePreference) => {
    setThemePreference(preference);
    appStore.getState().setTheme(preference);
    saveThemePreference(preference);
  };

  // Office clearance is a barrier, not a fire-and-forget side effect. The
  // workspace stays unmounted until clearance, snapshot and an initial sync
  // attempt have run in that order. A stable request id prevents token refresh
  // or quiet background sync from remounting a page/editor.
  const sessionApproval = useStore(appStore, (state) => state.sessionApproval);
  const approvalRequest = useStore(appStore, (state) => state.sessionApprovalRequest);
  const [officePreparation, setOfficePreparation] = useState<{ requestId: string; phase: 'snapshot' | 'ready' } | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const clearanceQueue = useRef<Promise<void>>(Promise.resolve());
  const officeSignedIn = authStatus === 'authenticated' && profile?.role === 'office';
  const decisionBlocked = profile?.role === 'office' && (sessionApproval === 'denied' || sessionApproval === 'revoked');
  const officeApproved = officeSignedIn && sessionApproval === 'approved';
  const requestId = approvalRequest?.id ?? '';
  const officeSnapshotReady = officeApproved && officePreparation?.requestId === requestId;
  const isWorkspaceVisible = (authStatus === 'authenticated' || authStatus === 'demo')
    && (profile?.role !== 'office' || (officeSnapshotReady && officePreparation?.phase === 'ready'));
  const syncAllowed = profile?.role === 'office' ? officeSnapshotReady : isWorkspaceVisible;

  const pushClearance = useCallback(
    (state: 'office-pending' | 'allowed', role?: 'admin' | 'office' | null): Promise<void> => {
      const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
      const next = clearanceQueue.current.catch(() => undefined).then(async () => {
        if (!local) return; // browser/demo tests without the desktop bridge
        if (!local.setSessionClearance) throw new Error('Local session clearance is unavailable.');
        // The object form reports the session role through the EXISTING
        // clearance mechanism, so the local store can scope Office reads to
        // the 3-day creation window (Admin reads stay unfiltered).
        const actual = await local.setSessionClearance(role === undefined ? state : { state, role });
        if (actual !== state) throw new Error('Local session clearance could not be changed.');
      });
      clearanceQueue.current = next.catch(() => undefined);
      return next;
    },
    [],
  );

  // Preload notifies on every successful customer-data IPC operation. Neither
  // a clearance change nor close counts as a successful database operation.
  useEffect(() => {
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    return local?.onOperationSuccess?.(() => setLocalStoreError(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    if (!officeSignedIn && !decisionBlocked) {
      setOfficePreparation(null);
      setPreparationError(null);
      // Admin/demo/sign-out must release a prior Office fence as well. The
      // reported role scopes local reads: Admin = unfiltered, sign-out/demo =
      // unreported (legacy reads; the purge never runs without an Office role).
      void pushClearance(
        'allowed',
        authStatus === 'authenticated' && profile?.role === 'admin' ? 'admin' : null,
      ).catch(() => undefined);
      return () => { cancelled = true; };
    }
    if (!officeApproved) {
      setOfficePreparation(null);
      setPreparationError(null);
      void (async () => {
        try {
          await pushClearance('office-pending', 'office');
        } catch (error) {
          if (!cancelled) setPreparationError(localStoreErrorMessage(error));
        } finally {
          // Even if the bridge fails, clear Auth locally and keep the gate
          // closed; a failed IPC transition must not preserve valid tokens.
          if (!cancelled && decisionBlocked) await appStore.getState().endOfficeSessionAfterDecision();
        }
      })();
      return () => { cancelled = true; };
    }

    void (async () => {
      // Issue B: approved → clearance → local snapshot → first sync → ready.
      const openSpan = activeTimingSpan('office-open') ?? startTimingSpan('office-open');
      try {
        await pushClearance('allowed', 'office');
        openSpan.mark('clearance');
        if (cancelled || appStore.getState().sessionApproval !== 'approved') return;
        if (local?.getSnapshot) {
          const snapshot = await local.getSnapshot({ role: 'office' });
          openSpan.mark('local_snapshot');
          if (cancelled || appStore.getState().sessionApproval !== 'approved') return;
          setLocalStoreError(null);
          if (snapshot.syncStatus) setSyncStatus(snapshot.syncStatus);
        }
        setPreparationError(null);
        setOfficePreparation({ requestId, phase: 'snapshot' });
      } catch (error) {
        openSpan.end({ outcome: 'error', role: 'office' });
        if (!cancelled) {
          const message = localStoreErrorMessage(error);
          setLocalStoreError(message);
          setPreparationError(message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [appStore, authStatus, profile?.role, officeSignedIn, decisionBlocked, officeApproved, pushClearance, requestId, preparationAttempt]);

  // One approval channel per signed-in client. Payloads are deliberately
  // ignored: only my_office_signin() can change the approval state. Polling
  // and focus refresh remain active even after the workspace is opened.
  const watchOfficeApproval = officeSignedIn && !decisionBlocked;
  useEffect(() => {
    if (!watchOfficeApproval) return undefined;
    const tick = () => { void appStore.getState().refreshSessionApproval(); };
    const unsubscribe = requestId ? approvalService?.subscribeChanges?.(tick, requestId) : undefined;
    const interval = window.setInterval(tick, 5_000);
    window.addEventListener('focus', tick);
    return () => {
      unsubscribe?.();
      window.clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, [appStore, approvalService, requestId, watchOfficeApproval]);

  useEffect(() => {
    if (!isWorkspaceVisible || authStatus === 'demo') {
      setWorkspaceSettings(undefined);
      setSettingsLoadError(null);
      lastSettingsSignature.current = '';
      return undefined;
    }

    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    const client = authService.authClient;
    let cancelled = false;

    const load = async () => {
      try {
        if (local?.getSettings) {
          const cached = await local.getSettings();
          const cachedPartial = settingsRecordToPartialSettings(cached);
          if (!cancelled && Object.keys(cachedPartial).length > 0) {
            setWorkspaceSettings(cachedPartial);
          }
        }

        if (!client) {
          return;
        }
        const remote = await loadWorkspaceSettings(client as unknown as SettingsDataClient);
        if (cancelled) {
          return;
        }
        setWorkspaceSettings(remote);
        setSettingsLoadError(null);
        // R2-08: the workspace "default theme" only applies to a NEW sign-in on
        // a PC with no saved personal preference. A personal choice always wins
        // and is never overwritten by loading/opening Settings.
        if (remote.theme && !hasSavedThemePreference()) {
          setThemePreference(remote.theme);
          appStore.getState().setTheme(remote.theme);
          saveThemePreference(remote.theme);
        }
        if (local?.setSettings) {
          const cache = partialSettingsToRecord(remote);
          if (Object.keys(cache).length > 0) {
            await local.setSettings({ settings: cache });
            await local.acknowledgeSettings?.();
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setSettingsLoadError(caught instanceof Error ? caught.message : 'Unable to load workspace settings.');
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [appStore, authService, authStatus, isWorkspaceVisible, profile?.id]);

  // S3: resolve audit actors by joining `profiles` so the Audit Log shows a
  // real person (or "Office (shared account)") instead of "Unknown".
  useEffect(() => {
    if (!isWorkspaceVisible || authStatus === 'demo' || profile?.role !== 'admin') {
      setAuditProfiles([]);
      return undefined;
    }
    const client = authService.authClient;
    if (!client) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.from('profiles').select('id,email,full_name,role') as unknown as {
          data?: AuditProfile[] | null;
        };
        if (!cancelled && Array.isArray(result?.data)) {
          setAuditProfiles(result.data);
        }
      } catch {
        // Profile lookup is best-effort; the audit log falls back to the
        // recorded actor names and neutral labels.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authService, authStatus, isWorkspaceVisible, profile?.id, profile?.role]);

  const persistWorkspaceSettings = async (settings: DksSettings): Promise<void> => {
    const signature = JSON.stringify(settings);
    if (signature === lastSettingsSignature.current) {
      return;
    }
    lastSettingsSignature.current = signature;
    setWorkspaceSettings(settings);
    void defaultErrorReporter.setEnabledByAdmin(settings.errorReportingEnabled);

    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    const cache = partialSettingsToRecord(settings);
    if (local?.setSettings) {
      await local.setSettings({ settings: cache });
    }

    const columns = await sheetRepository.getColumns();
    const currentPrimary = columns.find((column) => (
      column.isPrimaryExpiry === true || column.is_primary_expiry === true
    ));
    const selectedPrimary = columns.find((column) => column.id === settings.primaryExpiryColumnId);
    // Auto-heal a stale settings.primaryExpiryColumnId: only a live
    // date_expiry column may become/stay primary. A settings value pointing
    // at a deleted or non-expiry column must never write primary marks.
    const selectedPrimaryIsLiveExpiry = !!selectedPrimary
      && selectedPrimary.type === 'date_expiry'
      && selectedPrimary.deleted !== true
      && selectedPrimary.visible !== false;
    if (selectedPrimaryIsLiveExpiry && currentPrimary?.id !== selectedPrimary.id) {
      for (const column of columns.filter((candidate) => candidate.type === 'date_expiry')) {
        const primary = column.id === selectedPrimary.id;
        await sheetRepository.updateColumn(column.id, {
          isPrimaryExpiry: primary,
          is_primary_expiry: primary,
        });
      }
      setRepositoryRevision((revision) => revision + 1);
    }

    // R2-08: saving the workspace settings (including the "Theme default" for
    // new sign-ins) must NOT re-theme the current session. The personal toggle
    // in the top bar owns the active theme.

    if (authStatus === 'demo') {
      return;
    }
    const client = authService.authClient;
    if (!client) {
      throw new Error('Supabase is not configured; settings remain in the local cache.');
    }
    try {
      await saveWorkspaceSettings(client as unknown as SettingsDataClient, settings);
      await local?.acknowledgeSettings?.();
      setSettingsLoadError(null);
    } catch (error) {
      if (!isRoutineOfflineError(error)) {
        void defaultErrorReporter.report({
          category: 'settings',
          severity: 'error',
          code: 'SETTINGS_SAVE_FAILED',
          component: 'renderer/settings',
          httpStatus: extractSafeHttpStatus(error),
          postgresCode: extractSafePostgresCode(error),
        });
      }
      setSettingsLoadError(error instanceof Error ? error.message : 'Workspace settings sync failed.');
      throw error;
    }
  };

  useEffect(() => {
    if (!isWorkspaceVisible) {
      setNotifications((current) => current.length === 0 ? current : []);
      setSnoozes((current) => current.length === 0 ? current : []);
      return undefined;
    }

    let cancelled = false;
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;

    let loading = false;
    const loadNotifications = async () => {
      if (loading || cancelled) {
        return;
      }
      loading = true;
      try {
        const localRecords = local ? await local.listNotifications() : [];
        const existing = localRecords
          .map(fromLocalNotification)
          .filter((record): record is NotificationRecord => record !== null);
        let remoteAdmin: NotificationRecord[] = [];
        if (profile?.role === 'admin' && authService.authClient) {
          try {
            remoteAdmin = await loadAdminNotifications(
              authService.authClient as unknown as AdminNotificationClient,
            );
          } catch {
            // A notification read failure must not suppress local expiry alerts.
          }
        }
        const [rows, columns] = await Promise.all([
          sheetRepository.getRows(),
          sheetRepository.getColumns(),
        ]);
        const alertRows = rows.map((row) => ({
          id: row.id,
          data: row.data,
          category: row.category,
          deleted: row.deleted,
        }));
        // Legacy persisted expiry notifications may carry a body baked in
        // with the raw entry UUID. Re-resolve their display text from the
        // row's current human label (identity/dedupe/snooze/read state are
        // untouched) and repair the stored payload once — after the repair
        // the body matches, so later loads write nothing.
        const refreshedExisting = refreshExpiryNotificationLabels(existing, alertRows, columns);
        if (local && typeof local.updateNotification === 'function') {
          for (const [index, record] of refreshedExisting.entries()) {
            const original = existing[index];
            if (record.kind === 'expiry' && original && record.body !== original.body) {
              try {
                await local.updateNotification({ id: record.id, payload: { body: record.body } });
              } catch {
                // Display is already corrected in memory; a failed repair is
                // retried on the next load.
              }
            }
          }
        }
        const generatedExpiry = evaluateAlerts({
          rows: alertRows,
          columns,
          now: new Date(),
          snoozes,
          existingNotifications: refreshedExisting,
          // Shared human label (customer-visible columns by id AND name);
          // the evaluator still rejects an unusable label and falls back to
          // "Unnamed record" — a raw entry UUID never reaches a body.
          rowLabel: (row) => rowDisplayLabel(
            { id: row.id, data: row.data ?? {} },
            columns,
          ),
        });
        const generated = [
          ...generatedExpiry,
          ...evaluateSummaryNotifications({
            alerts: [
              ...refreshedExisting.filter((record): record is Extract<NotificationRecord, { kind: 'expiry' }> => record.kind === 'expiry'),
              ...generatedExpiry,
            ],
            now: new Date(),
            existingNotifications: refreshedExisting,
          }),
        ];

        if (local) {
          for (const record of [...remoteAdmin, ...generated]) {
            if (typeof local.addNotification === 'function') {
              await local.addNotification(toLocalNotificationInput(record));
            }
          }
        }
        const osNotifications = typeof window !== 'undefined'
          ? (window.dks as unknown as {
            notifications?: { show?: (request: { title: string; body: string }) => Promise<unknown> };
          } | undefined)?.notifications
          : undefined;
        if (osNotifications?.show) {
          for (const record of generated) {
            try {
              await osNotifications.show(notificationOsContent(record));
            } catch {
              // OS notification delivery is best effort; the in-app record remains durable.
            }
          }
        }

        if (!cancelled) {
          const merged = new Map<string, NotificationRecord>();
          [...refreshedExisting, ...remoteAdmin, ...generated].forEach((record) => merged.set(record.id, record));
          setNotifications(Array.from(merged.values()));
        }
      } catch {
        if (!cancelled) {
          setNotifications([]);
        }
      } finally {
        loading = false;
      }
    };

    void loadNotifications();
    const interval = local ? window.setInterval(() => void loadNotifications(), 60_000) : undefined;
    return () => {
      cancelled = true;
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [authService, isWorkspaceVisible, profile?.id, sheetRepository, snoozes]);

  useEffect(() => {
    if (!syncAllowed || authStatus === 'demo') {
      setSyncStatus((current) => (
        current.status === 'offline' && current.lastError === null
          ? current
          : { ...current, status: 'offline', lastError: null }
      ));
      return undefined;
    }

    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    const client = authService.authClient;
    if (!local || !client || typeof local.applyRemoteSnapshot !== 'function') {
      if (officeApproved) setOfficePreparation({ requestId, phase: 'ready' });
      return undefined;
    }

    let stopped = false;
    let running = false;
    let runStartedAt = 0;
    const syncLocal: SupabaseSyncLocal = {
      // The sync engine reads the SAME scoped snapshot as the UI: Office reads
      // are filtered to the 3-day window except rows with unsynced outbox work
      // (which the engine must see to push). Role is read at call time so a
      // session change can never leak a stale scope into a sync run.
      getSnapshot: () => local.getSnapshot({ role: appStore.getState().profile?.role ?? undefined }),
      setSyncStatus: async (state) => {
        const next = await local.setSyncStatus(state as Parameters<typeof local.setSyncStatus>[0]);
        setSyncStatus(next);
        return next;
      },
      applyRemoteSnapshot: (input) => local.applyRemoteSnapshot?.({
        ...input,
        role: appStore.getState().profile?.role ?? undefined,
      })
        ?? Promise.reject(new Error('Remote snapshot application is unavailable')),
      acknowledgeOutbox: async () => {
        const next = await local.acknowledgeOutbox?.() ?? {
          status: 'healthy' as const,
          lastSyncAt: null,
          lastError: null,
          pendingCount: 0,
        };
        setSyncStatus(next);
        return next;
      },
      listOutbox: async (input) => local.listOutbox?.(input) ?? [],
      markOutboxSynced: async (id) => {
        await local.markOutboxSynced?.({ id });
      },
      markOutboxFailed: async (id, message) => {
        await local.markOutboxFailed?.({ id, message });
      },
      markOutboxTerminal: async (id, message) => {
        if (!local.markOutboxTerminal) throw new Error('Terminal outbox recording is unavailable.');
        await local.markOutboxTerminal({ id, message });
        void defaultErrorReporter.report({
          category: 'sync',
          severity: 'warning',
          code: 'SYNC_OUTBOX_TERMINAL',
          component: 'renderer/sync',
        });
      },
      retryFailedOutbox: async () => (await local.retryFailedOutbox?.())?.requeued ?? 0,
      // R3 batch B: adopt the server's column id after a duplicate-name
      // reconciliation so the column stops failing on every sync.
      rekeyColumn: async (oldId, newId) => {
        await local.rekeyColumn?.({ oldId, newId });
      },
    };
    const syncClient = client as unknown as SupabaseDataClient;

    let activeRun: Promise<SupabaseSyncResult | null> | null = null;
    const run = (): Promise<SupabaseSyncResult | null> => {
      const current = appStore.getState();
      if (stopped || current.authStatus !== 'authenticated'
        || (current.profile?.role === 'office'
          && (current.sessionApproval !== 'approved' || current.sessionApprovalRequest?.id !== requestId))) {
        return Promise.resolve(null);
      }
      if (activeRun) {
        return activeRun;
      }
      running = true;
      runStartedAt = Date.now();
      const thisRun = (async (): Promise<SupabaseSyncResult> => {
        const result = await runSupabaseSync({
          client: syncClient,
          local: syncLocal,
          userId: profile?.id ?? null,
          // Read the store at each async boundary, not a stale render value:
          // a Realtime revocation must stop an already-running sync too.
          isSessionAllowed: () => {
            if (stopped) return false;
            const current = appStore.getState();
            return current.authStatus === 'authenticated'
              && (current.profile?.role !== 'office'
                || (current.sessionApproval === 'approved' && current.sessionApprovalRequest?.id === requestId));
          },
        });
        if (!stopped && result.status === 'healthy') {
          setRepositoryRevision((revision) => revision + 1);
        } else if (!stopped && result.status === 'error') {
          const firstErr = result.error ?? result.errors[0] ?? '';
          if (firstErr && !isRoutineOfflineError(firstErr)) {
            void defaultErrorReporter.report({
              category: 'sync',
              severity: 'warning',
              code: 'SYNC_REMOTE_FAILED',
              component: 'renderer/sync',
            });
          }
        }
        return result;
      })().finally(() => {
        if (activeRun === thisRun) {
          activeRun = null;
          running = false;
        }
      });
      activeRun = thisRun;
      return thisRun;
    };
    const runInBackground = () => {
      void run().catch(() => undefined);
    };

    // Proxy-triggered flushes (local mutations) land here.
    requestSyncRef.current = runInBackground;
    syncNowRef.current = async () => {
      const result = await run();
      if (!result) {
        throw new Error('Cloud sync is not available on this device.');
      }
      if (result.status !== 'healthy') {
        throw new Error(result.error ?? result.errors[0] ?? 'Some changes have not synchronised yet.');
      }
    };
    // Wait for the first attempt before mounting Office. A bounded wait keeps
    // the local-first workspace usable when the network hangs; the same run
    // continues quietly and refreshes the mounted page through refreshToken.
    let openingTimer: number | undefined;
    if (officeApproved) {
      const openingDeadline = new Promise<void>((resolve) => {
        openingTimer = window.setTimeout(resolve, 1_500);
      });
      let firstSyncDone = false;
      void Promise.race([run().then(() => { firstSyncDone = true; }).catch(() => { firstSyncDone = true; }), openingDeadline]).then(() => {
        if (openingTimer !== undefined) window.clearTimeout(openingTimer);
        const openSpan = activeTimingSpan('office-open');
        openSpan?.mark('first_sync');
        openSpan?.end({ outcome: firstSyncDone ? 'synced' : 'deadline', role: 'office' });
        if (!stopped && appStore.getState().sessionApproval === 'approved') {
          setOfficePreparation({ requestId, phase: 'ready' });
        }
      });
    } else {
      // Issue B: Admin's first sync after the workspace opened.
      const openSpan = startTimingSpan('workspace-open');
      void run()
        .then((result) => {
          openSpan.mark('first_sync');
          openSpan.end({ outcome: result?.status ?? 'skipped', role: 'admin' });
        })
        .catch(() => {
          openSpan.mark('first_sync');
          openSpan.end({ outcome: 'error', role: 'admin' });
        });
    }
    const interval = window.setInterval(() => {
      // Hang guard: a sync stuck for more than 5 minutes (e.g. a network
      // socket that never resolves) releases the lock and surfaces the
      // timeout. The outbox is never cleared — the next tick retries.
      if (running && Date.now() - runStartedAt > 5 * 60_000) {
        running = false;
        activeRun = null;
        void syncLocal.setSyncStatus({
          status: 'error',
          lastError: 'Sync timed out after 5 minutes; retrying.',
        }).catch(() => undefined);
      }
      runInBackground();
    }, 60_000);

    // ONE Realtime channel per signed-in client on the two tables the Visa
    // Sheet reconciles from. Events are change notifications only: they are
    // coalesced for ~1 s and then run this same pull/reconcile, which refreshes
    // the mounted Sheet/Dashboard/Recycle Bin quietly through refreshToken. A
    // payload is never applied, so LWW/outbox semantics are unchanged. This
    // effect only lives while the session is allowed (authenticated, and for
    // Office approved with the current request id), so signing out, revocation
    // or the pending gate disposes the watcher and unsubscribes the channel.
    const liveSheetWatcher = createLiveSheetWatcher({
      client: client as unknown as LiveSheetClientLike,
      onWakeup: runInBackground,
      // Echo hint only: while our own run is pushing/pulling it refreshes the
      // page itself. Correctness never depends on this.
      isBusy: () => running,
    });

    return () => {
      stopped = true;
      // Unsubscribe BEFORE anything else so no event can start a sync after
      // sign-out / revocation / the clearance-pending gate.
      liveSheetWatcher.dispose();
      requestSyncRef.current = null;
      syncNowRef.current = null;
      window.clearInterval(interval);
      if (openingTimer !== undefined) window.clearTimeout(openingTimer);
    };
  }, [appStore, authService, authStatus, officeApproved, syncAllowed, profile?.id, requestId]);

  // SYNC-10: restore the persisted sync state on restart so the top bar shows
  // the real outbox (pending count / last sync / error) immediately instead of
  // flashing the default offline/0 state before the first background tick.
  // Demo mode has no real outbox, so it is left untouched.
  useEffect(() => {
    if (!isWorkspaceVisible || authStatus === 'demo') {
      return undefined;
    }
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    if (!local?.getSnapshot) {
      return undefined;
    }
    let cancelled = false;
    void local
      .getSnapshot({ role: appStore.getState().profile?.role ?? undefined })
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setLocalStoreError(null);
        if (snapshot.syncStatus) {
          setSyncStatus(snapshot.syncStatus);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLocalStoreError(localStoreErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus, isWorkspaceVisible]);

  // Pending outbox details for the sync status (Blocker 3): surface WHAT is
  // stuck and WHY (sanitised) — the count itself comes from syncStatus and
  // is never hidden.
  useEffect(() => {
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    if (!isWorkspaceVisible || !local?.listOutbox) {
      setPendingOutbox([]);
      return undefined;
    }
    let cancelled = false;
    local.listOutbox({ status: 'all' })
      .then((items) => {
        if (cancelled) {
          return;
        }
        setPendingOutbox(items
          .filter((item) => (item.status ?? 'pending') !== 'synced')
          .map((item): SyncPendingItem => ({
            id: item.id,
            entityType: item.entityType ?? item.entity_type ?? 'entry',
            operation: item.operation ?? 'change',
            attempts: item.attempts ?? 0,
            lastError: sanitizeSyncError(item.lastError ?? item.last_error ?? '') || null,
            status: item.status,
          })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isWorkspaceVisible, syncStatus]);

  const persistNotification = async (
    id: string,
    patch: { read?: boolean; dismissed?: boolean; payload?: Record<string, unknown> },
  ) => {
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    if (!local || typeof local.updateNotification !== 'function') {
      return;
    }
    try {
      await local.updateNotification({ id, ...patch });
    } catch {
      // The alert remains usable in memory when the local cache is unavailable.
    }
  };

  const handleNotificationMarkRead = (id: string) => {
    setNotifications((current) => current.map((record) => (
      record.id === id ? { ...record, read: true } : record
    )));
    void persistNotification(id, { read: true });
    if (id.startsWith('admin-notification-') && authService.authClient) {
      void dismissAdminNotification(
        authService.authClient as unknown as AdminNotificationClient,
        id,
      ).catch(() => undefined);
    }
  };

  /**
   * Dismiss is addressed by the REAL record id (a store row). Internally the
   * id is expanded through the alert's stable key (kind + rowId/entryId +
   * milestone), so every duplicate record of the SAME logical alert is
   * dismissed together — in React state, in the local SQLite cache and, for
   * admin notifications, on the server. Dedupe keys never leave this layer:
   * components and persistence always deal in ids.
   */
  const dismissNotificationRecords = (records: readonly NotificationRecord[]) => {
    const dismissedAt = records.map((record) => ({ ...record, dismissed: true, read: true }));
    setNotifications((current) => {
      const dismissedIds = new Set(records.map((record) => record.id));
      return current.map((record) => (
        dismissedIds.has(record.id) ? { ...record, dismissed: true, read: true } : record
      ));
    });
    for (const record of dismissedAt) {
      void persistNotification(record.id, { dismissed: true, read: true });
      if (record.id.startsWith('admin-notification-') && authService.authClient) {
        void dismissAdminNotification(
          authService.authClient as unknown as AdminNotificationClient,
          record.id,
        ).catch(() => undefined);
      }
    }
  };

  const handleNotificationDismiss = (idOrKey: string) => {
    // Expand the clicked record id to every record of the SAME logical alert
    // (stable key), so persisted duplicates disappear together. Stable keys
    // never cross this boundary — callers only ever deal in record ids.
    const target = notifications.find((record) => record.id === idOrKey)
      ?? notifications.find((record) => notificationStableKey(record) === idOrKey);
    if (!target) {
      return;
    }
    const targetKey = notificationStableKey(target);
    const matches = notifications.filter((record) => (
      notificationStableKey(record) === targetKey
    ));
    dismissNotificationRecords(matches);
  };

  // Clear all: every alert currently listed disappears at once; the popover
  // shows "No notifications" immediately and the dismissal is durable.
  const handleNotificationClearAll = () => {
    const visible = dedupeNotifications(notifications).filter((record) => (
      record.dismissed !== true && !isNotificationSnoozed(record)
    ));
    const keys = new Set(visible.map((record) => notificationStableKey(record)));
    const matches = notifications.filter((record) => (
      keys.has(notificationStableKey(record)) && record.dismissed !== true
    ));
    if (matches.length === 0) {
      return;
    }
    dismissNotificationRecords(matches);
  };

  const handleNotificationView = (record: Extract<NotificationRecord, { kind: 'office-delete' }>) => {
    setActiveView('sheet');
    handleNotificationMarkRead(record.id);
  };

  const handleNotificationRestore = async (record: Extract<NotificationRecord, { kind: 'office-delete' }>) => {
    if (!authService.authClient) {
      return;
    }
    try {
      await restoreDeletedEntry(
        authService.authClient as unknown as AdminNotificationClient,
        record.entryId,
      );
      if (sheetRepository.restoreRow) {
        await sheetRepository.restoreRow(record.entryId, { actor: profile?.email ?? null });
      }
      await dismissAdminNotification(
        authService.authClient as unknown as AdminNotificationClient,
        record.id,
      );
      setNotifications((current) => current.map((candidate) => (
        candidate.id === record.id ? { ...candidate, read: true, dismissed: true } : candidate
      )));
      setRepositoryRevision((revision) => revision + 1);
    } catch {
      // The notification remains visible until the server-side restore succeeds.
    }
  };

  const handleNotificationSnooze = (
    record: NotificationRecord,
    duration: SnoozeDuration,
    customUntil?: string,
  ) => {
    if (record.kind !== 'expiry') {
      return;
    }
    const until = snoozeUntil(duration, new Date(), customUntil);
    const nextSnooze = createSnooze(record.rowId, duration, new Date(), record.expiryValue, customUntil);
    setSnoozes((current) => [
      ...current.filter((snooze) => snooze.rowId !== nextSnooze.rowId),
      nextSnooze,
    ]);
    const nextRecord = { ...record, read: true, snoozedUntil: until };
    setNotifications((current) => current.map((candidate) => (
      candidate.id === record.id ? nextRecord : candidate
    )));
    void persistNotification(record.id, {
      read: true,
      payload: nextRecord,
    });
  };

  // Keep the background error-reporting controller synchronized with the
  // cleared session and shared workspace preference without blocking UI flows.
  useEffect(() => {
    const role = profile?.role === 'admin' || profile?.role === 'office' ? profile.role : null;
    const sessionCleared = authStatus === 'authenticated' && isWorkspaceVisible && role !== null;
    defaultErrorReporter.setSessionContext({
      accessToken: sessionCleared ? (session?.access_token ?? null) : null,
      role: sessionCleared ? role : null,
      sessionCleared,
    });

    if (!sessionCleared) {
      return undefined;
    }

    const enabled = workspaceSettings?.errorReportingEnabled ?? true;
    void defaultErrorReporter.syncWorkspacePreference(enabled, role);
    if (!enabled) {
      return undefined;
    }

    const flushSoon = window.setTimeout(() => {
      void defaultErrorReporter.flushPending();
    }, 1_200);
    const interval = window.setInterval(() => {
      void defaultErrorReporter.flushPending();
    }, 120_000);
    const onOnline = () => {
      void defaultErrorReporter.flushPending();
    };
    window.addEventListener('online', onOnline);

    return () => {
      window.clearTimeout(flushSoon);
      window.clearInterval(interval);
      window.removeEventListener('online', onOnline);
    };
  }, [
    authStatus,
    isWorkspaceVisible,
    profile?.role,
    session?.access_token,
    workspaceSettings?.errorReportingEnabled,
  ]);

  // Cloud backup: hand the main process the current signed-in session so it can
  // authorise Worker calls. The token is refreshed by Supabase in the renderer,
  // so this re-runs on every refresh and clears on sign-out. The main process
  // never stores it, and the Worker verifies the signature itself.
  //
  // ADMIN ONLY in v1. An Office session is never pushed, so the scheduler on an
  // Office PC has no credential to run with — and the Worker would refuse the
  // upload with OFFICE_NOT_ALLOWED anyway.
  useEffect(() => {
    const backupBridge = typeof window !== 'undefined' ? window.dks?.backup : undefined;
    if (!backupBridge) {
      return undefined;
    }
    const accessToken = authStatus === 'authenticated' && profile?.role === 'admin'
      ? (session?.access_token ?? null)
      : null;

    if (!accessToken) {
      void backupBridge.setSession(null);
      return undefined;
    }

    void backupBridge.setSession({ role: 'admin', accessToken });
    return undefined;
  }, [authStatus, profile?.role, session?.access_token]);

  if (!isWorkspaceVisible) {
    // A password-authenticated Office session with no approval yet gets the
    // dedicated gate — never the AuthScreen (that would let it re-sign-in in
    // a loop) and NEVER any other workspace surface.
    if (officeSignedIn || decisionBlocked) {
      return (
        <OfficeApprovalGate
          appStore={appStore}
          preparationError={preparationError}
          onRetryPreparation={() => setPreparationAttempt((attempt) => attempt + 1)}
          onSignOut={() => void appStore.getState().signOut()}
        />
      );
    }
    // v0.1.7: while the saved session is still being restored, show the
    // neutral splash — NEVER the email/password form. The AuthScreen appears
    // only once restoration has finished and there is no session.
    if (isRestoringSession && !restoreSplashExpired) {
      return <StartupSplash />;
    }
    return (
      <AuthScreen
        onSignIn={(email, password) => appStore.getState().signIn(email, password)}
        authStatus={authStatus}
        authError={authError?.message ?? null}
        health={health}
        demoAvailable={demoAvailable}
        onDemoContinue={() => appStore.getState().setDemoSession()}
        onRetrySession={authError?.code === RESTORE_UNREACHABLE_CODE
          ? () => appStore.getState().restoreSession()
          : undefined}
      />
    );
  }

  return (
    <AppShell
      activeView={activeView}
      onNavigate={setActiveView}
      themePreference={themePreference}
      resolvedTheme={resolvedTheme}
      onThemeChange={handleThemeChange}
      profile={profile}
      userEmail={session?.user.email ?? null}
      health={health}
      syncStatus={syncStatus}
      updateState={updateState}
      updater={updaterBridge}
      onUpdateStateChange={setUpdateState}
      pendingOutbox={pendingOutbox}
      localStoreError={localStoreError}
      isDemoMode={authStatus === 'demo'}
      sheetRepository={sheetRepository}
      settings={workspaceSettings}
      onSettingsChange={persistWorkspaceSettings}
      emailPrefsClient={profile?.role === 'admin'
        ? (authService.authClient as unknown as import('../features/settings/email-preferences').EmailPrefsClient | null)
        : null}
      settingsError={settingsLoadError}
      onSignOutAllOfficeSessions={authStatus === 'authenticated' && profile?.role === 'admin'
        ? handleSignOutAllOfficeSessions
        : undefined}
      auditProfiles={auditProfiles}
      auditRemoteClient={authService.authClient as unknown as { rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> } | null}
      repositoryRevision={repositoryRevision}
      onDashboardFilter={handleDashboardFilter}
      onDashboardRefresh={handleDashboardRefresh}
      sheetDashboardFilter={dashboardSheetFilter}
      notifications={notifications}
      onNotificationMarkRead={handleNotificationMarkRead}
      onNotificationDismiss={handleNotificationDismiss}
      onNotificationClearAll={handleNotificationClearAll}
      onNotificationView={handleNotificationView}
      onNotificationRestore={handleNotificationRestore}
      onNotificationSnooze={handleNotificationSnooze}
      officeApprovalsSlot={profile?.role === 'admin'
        ? <OfficeApprovalsPanel service={approvalService} />
        : null}
      adminStatusSlot={profile?.role === 'admin'
        ? (
          <AdminStatusPanel
            role="admin"
            syncStatus={syncStatus}
            localStoreError={localStoreError}
            updateState={updateState}
            errorReportingEnabled={workspaceSettings?.errorReportingEnabled}
            accessToken={session?.access_token ?? null}
            dataClient={authService.authClient as unknown as ConnectivityQueryClient | null}
            outboxFailures={{
              failedCount: pendingOutbox.filter(
                (item) => item.status === 'failed' || (item.status !== 'terminal' && item.attempts > 0 && Boolean(item.lastError)),
              ).length,
              terminalCount: pendingOutbox.filter((item) => item.status === 'terminal').length,
            }}
          />
        )
        : null}
      onLogout={() => appStore.getState().signOut()}
    />
  );
}
