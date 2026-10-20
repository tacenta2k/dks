import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import type {
  DksNotificationRequest,
  DksNotificationResult,
} from '../main/notifications';
import type { UpdateState } from '../main/updater';

export type DksNavigationTarget = 'dashboard' | 'sheet';

export interface DksPreloadApi {
  readonly platform: string;
  readonly appVersion: string;
  readonly notifications: {
    show: (request: DksNotificationRequest) => Promise<DksNotificationResult>;
  };
  readonly updater: {
    checkForUpdates: () => Promise<UpdateState>;
    restartToUpdate: () => Promise<boolean>;
    onStatus: (listener: (state: UpdateState) => void) => () => void;
  };
  readonly minimizeToTray: () => void;
  readonly quit: () => void;
  readonly onLogoutRequested: (listener: () => void) => () => void;
  readonly onNavigationRequested: (
    listener: (target: DksNavigationTarget) => void,
  ) => () => void;
}

const APP_VERSION_CHANNEL = 'dks:app-version';
const MINIMIZE_TO_TRAY_CHANNEL = 'dks:minimize-to-tray';
const QUIT_CHANNEL = 'dks:quit';
const LOGOUT_REQUESTED_CHANNEL = 'dks:logout-requested';
const NAVIGATION_REQUESTED_CHANNEL = 'dks:navigation-requested';
const NOTIFICATION_SHOW_CHANNEL = 'dks:notifications:show';
const UPDATER_CHECK_CHANNEL = 'dks:updater:check';
const UPDATER_RESTART_CHANNEL = 'dks:updater:restart';
const UPDATER_STATUS_CHANNEL = 'dks:updater:status';

function getAppVersion(): string {
  try {
    const version = ipcRenderer.sendSync(APP_VERSION_CHANNEL);
    return typeof version === 'string' && version.trim() ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normaliseUpdateState(value: unknown): UpdateState {
  if (typeof value !== 'object' || value === null) {
    return { status: 'error' };
  }

  const record = value as { status?: unknown; version?: unknown };
  const statuses: UpdateState['status'][] = [
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'not-available',
    'error',
  ];

  if (typeof record.status !== 'string' || !statuses.includes(record.status as UpdateState['status'])) {
    return { status: 'error' };
  }

  return typeof record.version === 'string' && record.version.trim()
    ? { status: record.status as UpdateState['status'], version: record.version }
    : { status: record.status as UpdateState['status'] };
}

function normaliseNotificationResult(value: unknown): DksNotificationResult {
  if (typeof value !== 'object' || value === null) {
    return { delivered: false, reason: 'unavailable' };
  }

  const record = value as { delivered?: unknown; reason?: unknown };
  if (record.delivered === true) {
    return { delivered: true };
  }

  const reasons = [
    'invalid',
    'unsupported',
    'unavailable',
    'error',
  ] as const;

  const reason = typeof record.reason === 'string' && reasons.includes(record.reason as (typeof reasons)[number])
    ? (record.reason as (typeof reasons)[number])
    : 'unavailable';

  return { delivered: false, reason };
}

function subscribeToLogout(listener: () => void): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  const handler = (_event: IpcRendererEvent) => {
    try {
      listener();
    } catch {
      // Renderer listeners are isolated from the preload bridge.
    }
  };

  ipcRenderer.on(LOGOUT_REQUESTED_CHANNEL, handler);
  return () => {
    try {
      ipcRenderer.removeListener(LOGOUT_REQUESTED_CHANNEL, handler);
    } catch {
      // The renderer may be tearing down at the same time.
    }
  };
}

function subscribeToNavigation(listener: (target: DksNavigationTarget) => void): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  const handler = (_event: IpcRendererEvent, value: unknown) => {
    if (value !== 'dashboard' && value !== 'sheet') {
      return;
    }

    try {
      listener(value);
    } catch {
      // Renderer listeners are isolated from the preload bridge.
    }
  };

  ipcRenderer.on(NAVIGATION_REQUESTED_CHANNEL, handler);
  return () => {
    try {
      ipcRenderer.removeListener(NAVIGATION_REQUESTED_CHANNEL, handler);
    } catch {
      // The renderer may be tearing down at the same time.
    }
  };
}

function subscribeToUpdateStatus(listener: (state: UpdateState) => void): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  const handler = (_event: IpcRendererEvent, value: unknown) => {
    try {
      listener(normaliseUpdateState(value));
    } catch {
      // Renderer listeners are isolated from the preload bridge.
    }
  };

  ipcRenderer.on(UPDATER_STATUS_CHANNEL, handler);
  return () => {
    try {
      ipcRenderer.removeListener(UPDATER_STATUS_CHANNEL, handler);
    } catch {
      // The renderer may be tearing down at the same time.
    }
  };
}

const notificationApi = Object.freeze({
  show: async (request: DksNotificationRequest): Promise<DksNotificationResult> => {
    try {
      const result = await ipcRenderer.invoke(NOTIFICATION_SHOW_CHANNEL, request);
      return normaliseNotificationResult(result);
    } catch {
      return { delivered: false, reason: 'unavailable' };
    }
  },
});

const updaterApi = Object.freeze({
  checkForUpdates: async (): Promise<UpdateState> => {
    try {
      return normaliseUpdateState(await ipcRenderer.invoke(UPDATER_CHECK_CHANNEL));
    } catch {
      return { status: 'error' };
    }
  },
  restartToUpdate: async (): Promise<boolean> => {
    try {
      return (await ipcRenderer.invoke(UPDATER_RESTART_CHANNEL)) === true;
    } catch {
      return false;
    }
  },
  onStatus: subscribeToUpdateStatus,
});

const dksApi: DksPreloadApi = Object.freeze({
  platform: typeof process === 'undefined' ? 'unknown' : process.platform,
  appVersion: getAppVersion(),
  notifications: notificationApi,
  updater: updaterApi,
  minimizeToTray: () => {
    try {
      ipcRenderer.send(MINIMIZE_TO_TRAY_CHANNEL);
    } catch {
      // The main process may already be shutting down.
    }
  },
  quit: () => {
    try {
      ipcRenderer.send(QUIT_CHANNEL);
    } catch {
      // The main process may already be shutting down.
    }
  },
  onLogoutRequested: subscribeToLogout,
  onNavigationRequested: subscribeToNavigation,
});

contextBridge.exposeInMainWorld('dks', dksApi);

export { dksApi };
