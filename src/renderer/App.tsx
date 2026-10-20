import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { createAuthService, AuthService } from '../features/auth/auth-service';
import { AuthScreen } from '../features/auth/AuthScreen';
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '../lib/theme';
import type { AppView, DksLocalSyncState, ThemePreference } from '../lib/types';
import { isSupabaseConfigured } from '../lib/supabase';
import { AppShell } from './components/AppShell';
import { createAppStore } from '../lib/store';
import { createElectronSheetRepository } from '../features/sheet/electron-repository';
import type { SheetRepository } from '../features/sheet/repository';
import {
  createSnooze,
  evaluateAlerts,
  evaluateSummaryNotifications,
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
  runSupabaseSync,
  type SupabaseDataClient,
  type SupabaseSyncLocal,
} from '../features/sync/supabase-sync';

export interface AppProps {
  initialView?: AppView;
  initialThemePreference?: ThemePreference;
  startInWorkspace?: boolean;
  authService?: AuthService;
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
  demoMode,
  sheetRepository: providedSheetRepository,
}: AppProps) {
  const [authService] = useState(() => providedAuthService ?? createAuthService());
  const [appStore] = useState(() => createAppStore(authService));
  const [sheetRepository] = useState<SheetRepository>(
    () => providedSheetRepository ?? createElectronSheetRepository({ role: 'office' }),
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

  const isWorkspaceVisible = authStatus === 'authenticated' || authStatus === 'demo';

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
          for (const record of generated) {
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
          [...existing, ...generated].forEach((record) => merged.set(record.id, record));
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
  }, [isWorkspaceVisible, profile?.id, sheetRepository, snoozes]);

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
    };
    const syncClient = client as unknown as SupabaseDataClient;

    const run = async () => {
      if (stopped || running) {
        return;
      }
      running = true;
      const result = await runSupabaseSync({ client: syncClient, local: syncLocal });
      running = false;
      if (!stopped && result.status === 'healthy') {
        setRepositoryRevision((revision) => revision + 1);
      }
    };

    void run();
    const interval = window.setInterval(() => void run(), 60_000);

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
      window.clearInterval(interval);
      if (channel) {
        void realtime.removeChannel?.(channel);
      }
    };
  }, [authService, authStatus, isWorkspaceVisible, profile?.id]);

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
  };

  const handleNotificationDismiss = (id: string) => {
    setNotifications((current) => current.map((record) => (
      record.id === id ? { ...record, dismissed: true } : record
    )));
    void persistNotification(id, { dismissed: true, read: true });
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
      isDemoMode={authStatus === 'demo'}
      sheetRepository={sheetRepository}
      repositoryRevision={repositoryRevision}
      notifications={notifications}
      onNotificationMarkRead={handleNotificationMarkRead}
      onNotificationDismiss={handleNotificationDismiss}
      onNotificationSnooze={handleNotificationSnooze}
      onLogout={() => appStore.getState().signOut()}
    />
  );
}
