import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { createAuthService, AuthService } from '../features/auth/auth-service';
import { AuthScreen } from '../features/auth/AuthScreen';
import { OfficeApprovalGate } from '../features/auth/OfficeApprovalGate';
import { OfficeApprovalsPanel } from '../features/admin/OfficeApprovalsPanel';
import type { OfficeApprovalService } from '../features/auth/office-approval-service';
import {
  hasSavedThemePreference,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../lib/theme';
import type { AppView, DksLocalSyncState, ThemePreference } from '../lib/types';
import { localStoreErrorMessage } from '../lib/local-store-error';
import { sanitizeSyncError } from '../lib/sync-error';
import { createSyncingRepositoryProxy } from '../lib/sync-trigger';
import { isSupabaseConfigured } from '../lib/supabase';
import { AppShell, type SyncPendingItem } from './components/AppShell';
import { createAppStore } from '../lib/store';
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
  snoozeUntil,
  type AlertSnooze,
  type NotificationRecord,
  type SnoozeDuration,
} from '../features/notifications/alert-service';
import {
  fromLocalNotification,
  toLocalNotificationInput,
} from '../features/notifications/local-notifications';
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
} from '../features/sync/supabase-sync';

export interface AppProps {
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
}

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
}: AppProps) {
  const [authService] = useState(() => providedAuthService ?? createAuthService());
  const [appStore] = useState(() => createAppStore(authService, providedApprovalService));
  const [baseSheetRepository] = useState<SheetRepository>(
    () => providedSheetRepository ?? createElectronSheetRepository({ role: 'office' }),
  );
  // Local-mutation -> sync flush (Blocker 3): every successful local write
  // schedules an immediate sync instead of waiting for the 60s timer.
  const requestSyncRef = useRef<(() => void) | null>(null);
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
  const session = useStore(appStore, (state) => state.session);
  const profile = useStore(appStore, (state) => state.profile);
  const health = useStore(appStore, (state) => state.health);
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

  const handleThemeChange = (preference: ThemePreference) => {
    setThemePreference(preference);
    appStore.getState().setTheme(preference);
    saveThemePreference(preference);
  };

  // Office-only session approval gate. The signed-in user may still hold a
  // valid password-authenticated session, but until the SERVER confirms this
  // session is approved the workspace (Sheet, Dashboard, local cache, sync)
  // never mounts and its effects never run.
  const sessionApproval = useStore(appStore, (state) => state.sessionApproval);
  const isWorkspaceVisible = (authStatus === 'authenticated' || authStatus === 'demo')
    && (profile?.role !== 'office' || sessionApproval === 'approved');

  // Push the session clearance into the main process so a pending Office
  // session cannot read/write local cached customer records via IPC either.
  useEffect(() => {
    const local = typeof window !== 'undefined' ? window.dks?.local : undefined;
    if (!local || typeof local.setSessionClearance !== 'function') {
      return;
    }
    const pending = authStatus === 'authenticated'
      && profile?.role === 'office'
      && sessionApproval !== 'approved'
      && sessionApproval !== 'not-required';
    void local.setSessionClearance(pending ? 'office-pending' : 'allowed')
      .catch(() => undefined);
  }, [authStatus, profile?.role, sessionApproval]);

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
        const generatedExpiry = evaluateAlerts({
          rows: rows.map((row) => ({
            id: row.id,
            data: row.data,
            category: row.category,
            deleted: row.deleted,
          })),
          columns,
          now: new Date(),
          snoozes,
          existingNotifications: existing,
          rowLabel: (row) => typeof row.data?.name === 'string' ? row.data.name : row.id,
        });
        const generated = [
          ...generatedExpiry,
          ...evaluateSummaryNotifications({
            alerts: [
              ...existing.filter((record): record is Extract<NotificationRecord, { kind: 'expiry' }> => record.kind === 'expiry'),
              ...generatedExpiry,
            ],
            now: new Date(),
            existingNotifications: existing,
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
              await osNotifications.show({ title: record.title, body: record.body });
            } catch {
              // OS notification delivery is best effort; the in-app record remains durable.
            }
          }
        }

        if (!cancelled) {
          const merged = new Map<string, NotificationRecord>();
          [...existing, ...remoteAdmin, ...generated].forEach((record) => merged.set(record.id, record));
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
    if (!isWorkspaceVisible || authStatus === 'demo') {
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
      return undefined;
    }

    let stopped = false;
    let running = false;
    let runStartedAt = 0;
    const syncLocal: SupabaseSyncLocal = {
      getSnapshot: () => local.getSnapshot(),
      setSyncStatus: async (state) => {
        const next = await local.setSyncStatus(state as Parameters<typeof local.setSyncStatus>[0]);
        setSyncStatus(next);
        return next;
      },
      applyRemoteSnapshot: (input) => local.applyRemoteSnapshot?.(input)
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
      retryFailedOutbox: async () => (await local.retryFailedOutbox?.())?.requeued ?? 0,
      // R3 batch B: adopt the server's column id after a duplicate-name
      // reconciliation so the column stops failing on every sync.
      rekeyColumn: async (oldId, newId) => {
        await local.rekeyColumn?.({ oldId, newId });
      },
    };
    const syncClient = client as unknown as SupabaseDataClient;

    const run = async () => {
      if (stopped || running) {
        return;
      }
      running = true;
      runStartedAt = Date.now();
      try {
        const result = await runSupabaseSync({
          client: syncClient,
          local: syncLocal,
          userId: profile?.id ?? null,
        });
        if (!stopped && result.status === 'healthy') {
          setRepositoryRevision((revision) => revision + 1);
        }
      } finally {
        running = false;
      }
    };

    // Proxy-triggered flushes (local mutations) land here.
    requestSyncRef.current = () => void run();
    void run();
    const interval = window.setInterval(() => {
      // Hang guard: a sync stuck for more than 5 minutes (e.g. a network
      // socket that never resolves) releases the lock and surfaces the
      // timeout. The outbox is never cleared — the next tick retries.
      if (running && Date.now() - runStartedAt > 5 * 60_000) {
        running = false;
        void syncLocal.setSyncStatus({
          status: 'error',
          lastError: 'Sync timed out after 5 minutes; retrying.',
        }).catch(() => undefined);
      }
      void run();
    }, 60_000);

    type RealtimeChannelLike = {
      on: (
        event: string,
        filter: Record<string, string>,
        callback: () => void,
      ) => RealtimeChannelLike;
      subscribe: () => unknown;
    };
    type RealtimeClientLike = {
      channel?: (name: string) => RealtimeChannelLike;
      removeChannel?: (channel: RealtimeChannelLike) => unknown;
    };
    const realtime = client as unknown as RealtimeClientLike;
    const channel = realtime.channel?.('dks-data-sync');
    if (channel) {
      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, () => void run())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'app_columns' }, () => void run())
        .subscribe();
    }

    return () => {
      stopped = true;
      requestSyncRef.current = null;
      window.clearInterval(interval);
      if (channel) {
        void realtime.removeChannel?.(channel);
      }
    };
  }, [authService, authStatus, isWorkspaceVisible, profile?.id]);

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
      .getSnapshot()
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
    if (!local?.listOutbox) {
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
          })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [syncStatus]);

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

  if (!isWorkspaceVisible) {
    // A password-authenticated Office session with no approval yet gets the
    // dedicated gate — never the AuthScreen (that would let it re-sign-in in
    // a loop) and NEVER any other workspace surface.
    if (authStatus === 'authenticated' && profile?.role === 'office') {
      return (
        <OfficeApprovalGate
          appStore={appStore}
          onSignOut={() => void appStore.getState().signOut()}
        />
      );
    }
    return (
      <AuthScreen
        onSignIn={(email, password) => appStore.getState().signIn(email, password)}
        authStatus={authStatus}
        authError={authError?.message ?? null}
        health={health}
        demoAvailable={demoAvailable}
        onDemoContinue={() => appStore.getState().setDemoSession()}
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
      auditProfiles={auditProfiles}
      auditRemoteClient={authService.authClient as unknown as { rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> } | null}
      repositoryRevision={repositoryRevision}
      notifications={notifications}
      onNotificationMarkRead={handleNotificationMarkRead}
      onNotificationDismiss={handleNotificationDismiss}
      onNotificationClearAll={handleNotificationClearAll}
      onNotificationView={handleNotificationView}
      onNotificationRestore={handleNotificationRestore}
      onNotificationSnooze={handleNotificationSnooze}
      officeApprovalsSlot={profile?.role === 'admin'
        ? <OfficeApprovalsPanel />
        : null}
      onLogout={() => appStore.getState().signOut()}
    />
  );
}
