import { autoUpdater } from 'electron-updater';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
}

export interface UpdateCheckResult {
  updateInfo?: {
    version?: string;
  };
}

export interface UpdaterAdapter {
  checkForUpdates: () => Promise<UpdateCheckResult | null | undefined>;
  downloadUpdate?: () => Promise<unknown>;
  quitAndInstall?: () => void;
}

export interface UpdaterServiceOptions {
  adapter?: UpdaterAdapter;
  enabled?: boolean;
  downloadInBackground?: boolean;
}

export interface UpdaterService {
  checkForUpdates: () => Promise<UpdateState>;
  restartToUpdate: () => Promise<boolean>;
  getState: () => UpdateState;
  onStatus: (listener: (state: UpdateState) => void) => () => void;
}

export interface UpdaterSchedulerOptions {
  intervalMs?: number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface UpdaterScheduler {
  start: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
}

export const UPDATER_CHECK_CHANNEL = 'dks:updater:check' as const;
export const UPDATER_RESTART_CHANNEL = 'dks:updater:restart' as const;
export const UPDATER_STATUS_CHANNEL = 'dks:updater:status' as const;

function createDefaultAdapter(): UpdaterAdapter {
  // electron-updater is intentionally kept behind this adapter. The rest of
  // the main process can therefore treat update failures as ordinary state.
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    return {
      checkForUpdates: async () => {
        const result = await autoUpdater.checkForUpdates();
        return result as UpdateCheckResult | null | undefined;
      },
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      quitAndInstall: () => autoUpdater.quitAndInstall(),
    };
  } catch {
    return {
      checkForUpdates: async () => null,
    };
  }
}

function cloneState(state: UpdateState): UpdateState {
  return state.version ? { status: state.status, version: state.version } : { status: state.status };
}

function updateVersion(result: UpdateCheckResult | null | undefined): string | undefined {
  const version = result?.updateInfo?.version;
  return typeof version === 'string' && version.trim() ? version.trim() : undefined;
}

/**
 * Wrap electron-updater with a no-throw, serializable state machine.
 *
 * No error object is retained or sent to the renderer. Network and release
 * configuration failures are represented by `status: 'error'` only.
 */
export function createUpdaterService(options: UpdaterServiceOptions = {}): UpdaterService {
  const adapter = options.adapter ?? createDefaultAdapter();
  const enabled = options.enabled ?? true;
  const downloadInBackground = options.downloadInBackground ?? true;
  const listeners = new Set<(state: UpdateState) => void>();

  let state: UpdateState = { status: 'idle' };
  let checkPromise: Promise<UpdateState> | undefined;

  const setState = (nextState: UpdateState): UpdateState => {
    state = cloneState(nextState);
    const snapshot = cloneState(state);

    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer listener must never break update handling.
      }
    }

    return cloneState(state);
  };

  const checkForUpdates = async (): Promise<UpdateState> => {
    if (!enabled) {
      return setState({ status: 'not-available' });
    }

    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      setState({ status: 'checking' });

      try {
        const result = await adapter.checkForUpdates();
        const version = updateVersion(result);

        if (!version) {
          return setState({ status: 'not-available' });
        }

        setState({ status: 'available', version });

        if (downloadInBackground && adapter.downloadUpdate) {
          setState({ status: 'downloading', version });
          await adapter.downloadUpdate();
          return setState({ status: 'downloaded', version });
        }

        return cloneState(state);
      } catch {
        return setState({ status: 'error' });
      }
    })();

    try {
      return await checkPromise;
    } finally {
      checkPromise = undefined;
    }
  };

  const restartToUpdate = async (): Promise<boolean> => {
    if (state.status !== 'downloaded' || !adapter.quitAndInstall) {
      return false;
    }

    try {
      adapter.quitAndInstall();
      return true;
    } catch {
      setState({ status: 'error' });
      return false;
    }
  };

  return {
    checkForUpdates,
    restartToUpdate,
    getState: () => cloneState(state),
    onStatus: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Run one safe launch check and then hourly checks.  The timer and service are
 * injectable so startup can be tested without a real network or an open timer.
 */
export function createUpdaterScheduler(
  service: Pick<UpdaterService, 'checkForUpdates'>,
  options: UpdaterSchedulerOptions = {},
): UpdaterScheduler {
  const intervalMs = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
    ? options.intervalMs as number
    : DEFAULT_UPDATE_INTERVAL_MS;
  const schedule = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let handle: unknown;
  let running = false;

  const check = async (): Promise<void> => {
    try {
      await service.checkForUpdates();
    } catch {
      // A scheduler must never turn a transient updater/network failure into a
      // process-level rejection.
    }
  };

  return {
    start: async () => {
      if (running) {
        return;
      }
      running = true;
      await check();
      if (!running) {
        return;
      }
      try {
        handle = schedule(() => {
          if (!running) {
            return;
          }
          void check();
        }, intervalMs);
      } catch {
        // Timers can be unavailable in restricted test/host environments.
        handle = undefined;
      }
    },
    stop: () => {
      if (!running) {
        return;
      }
      running = false;
      if (handle !== undefined) {
        try {
          cancel(handle);
        } catch {
          // Shutdown is best effort.
        }
        handle = undefined;
      }
    },
    isRunning: () => running,
  };
}

export const scheduleUpdaterChecks = createUpdaterScheduler;
