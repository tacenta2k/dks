import { autoUpdater } from 'electron-updater';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  /**
   * Update checks are disabled in this build (development/unpackaged).
   * Distinct from 'not-available': the release feed was never contacted, so
   * the UI must not claim the app is up to date.
   */
  | 'disabled';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  /** Download completion 0–100 while status is 'downloading' (when reported). */
  progress?: number;
}

export interface UpdateCheckResult {
  /**
   * electron-updater's own verdict. When false, `updateInfo.version` still
   * names the latest release (the running version) — it must NOT be treated
   * as an available update. Optional only so minimal test adapters may omit
   * it; the real adapter always forwards the boolean.
   */
  isUpdateAvailable?: boolean;
  updateInfo?: {
    version?: string;
  };
}

export interface UpdaterAdapter {
  checkForUpdates: () => Promise<UpdateCheckResult | null | undefined>;
  downloadUpdate?: () => Promise<unknown>;
  quitAndInstall?: () => void;
  /** Register a download-progress listener (percent 0–100), when supported. */
  onDownloadProgress?: (listener: (percent: number) => void) => void;
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

    let progressListener: ((percent: number) => void) | undefined;
    autoUpdater.on('download-progress', (info) => {
      const percent = typeof info?.percent === 'number' ? info.percent : NaN;
      if (Number.isFinite(percent)) {
        progressListener?.(percent);
      }
    });

    return {
      checkForUpdates: async () => {
        const result = await autoUpdater.checkForUpdates();
        return result as UpdateCheckResult | null | undefined;
      },
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      // Explicit user action only: quit, install, relaunch. Local SQLite
      // data lives in userData and is untouched by the installer.
      quitAndInstall: () => autoUpdater.quitAndInstall(),
      onDownloadProgress: (listener) => {
        progressListener = listener;
      },
    };
  } catch {
    return {
      checkForUpdates: async () => null,
    };
  }
}

function cloneState(state: UpdateState): UpdateState {
  const clone: UpdateState = { status: state.status };
  if (state.version) {
    clone.version = state.version;
  }
  if (typeof state.progress === 'number' && Number.isFinite(state.progress)) {
    clone.progress = Math.max(0, Math.min(100, Math.round(state.progress)));
  }
  return clone;
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

  // Download progress is meaningful only mid-download; stale events after a
  // completed/failed download are ignored rather than resurrecting the state.
  try {
    adapter.onDownloadProgress?.((percent) => {
      if (state.status === 'downloading') {
        setState({ status: 'downloading', version: state.version, progress: percent });
      }
    });
  } catch {
    // Progress is cosmetic; never let it break the state machine.
  }

  const checkForUpdates = async (): Promise<UpdateState> => {
    if (!enabled) {
      // Development/unpackaged: no feed is contacted. Report 'disabled' —
      // never 'not-available', which would falsely claim "up to date".
      return setState({ status: 'disabled' });
    }

    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      setState({ status: 'checking' });

      try {
        const result = await adapter.checkForUpdates();
        const version = updateVersion(result);

        // electron-updater reports the latest version even when it equals
        // the running one; `isUpdateAvailable === false` means UP TO DATE,
        // not a download candidate.
        if (!version || result?.isUpdateAvailable === false) {
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
