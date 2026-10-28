import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

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

export type UpdateErrorKind = 'check' | 'download';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  /** Download completion 0–100 while status is 'downloading' (when reported). */
  progress?: number;
  /** Which operation definitively failed; used for truthful, retryable copy. */
  errorKind?: UpdateErrorKind;
  /** Human-readable error detail for the update pill (bounded, no URLs/file paths). */
  errorMessage?: string;
  /** Raw codes from electron-updater's Error (when present). */
  errorCode?: string;
  errorName?: string;
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
  /** The authoritative completion signal, emitted before final cache cleanup. */
  onUpdateDownloaded?: (listener: (version?: string) => void) => void;
  /**
   * Error events are diagnostic — electron-updater can recover internally;
   * the operation promise or update-downloaded event determines the outcome.
   * The listener now receives the real Error so it can be logged with
   * name/code/message (Bug 2).
   */
  onError?: (listener: (error: Error) => void) => void;
}

export interface UpdateTransition {
  from: UpdateStatus;
  to: UpdateStatus;
  version?: string;
  progress?: number;
  errorKind?: UpdateErrorKind;
  errorMessage?: string;
  errorCode?: string;
  errorName?: string;
}

export interface UpdaterServiceOptions {
  adapter?: UpdaterAdapter;
  enabled?: boolean;
  downloadInBackground?: boolean;
  /** Receives state metadata only — never Error objects, URLs or file paths. */
  onTransition?: (transition: UpdateTransition) => void;
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

// ---------------------------------------------------------------------------
// Error helpers — Bug 2: stop hiding the real error.
// ---------------------------------------------------------------------------

// Updater cache: electron-updater stores differential download artifacts in
// %LOCALAPPDATA%\dks-updater\pending (or equivalent per installMode).
// Failed-download cache cleanup is NOT implemented programmatically in this
// codebase (file: electron/main/updater.ts, function: createUpdaterService).
// Reason: electron-updater's differential downloader manages its own pending
// cache and will resume/retry on next checkForUpdates(); manual deletion of
// that folder is documented as a user recovery step (BUGFIX_VERIFICATION.md
// pending-cache note) and is not required for the 100% download-failed fix,
// which was the missing error diagnostics + same-build yml/exe verification.
// If cache corruption is suspected, clearing the pending folder manually
// before retry is the supported recovery.

function extractUpdaterError(error: unknown): { message: string; code?: string; name?: string } {
  if (error instanceof Error) {
    const anyErr = error as Error & { code?: unknown };
    const rawMessage = typeof anyErr.message === 'string' ? anyErr.message : String(error);
    // Bound the message: electron-updater can include URLs/paths; keep first 500 chars.
    const message = rawMessage.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500) || 'Unknown error';
    const code = typeof anyErr.code === 'string' && anyErr.code.trim() ? anyErr.code.trim().slice(0, 100) : undefined;
    const name = typeof anyErr.name === 'string' && anyErr.name.trim() ? anyErr.name.trim().slice(0, 100) : undefined;
    return { message, code, name };
  }
  if (typeof error === 'string' && error.trim()) {
    return { message: error.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500) };
  }
  try {
    return { message: String(error).slice(0, 500) || 'Unknown error' };
  } catch {
    return { message: 'Unknown error' };
  }
}

function formatErrorForUi(details: { message: string; code?: string; name?: string }): string {
  // For the pill we show code + message, bounded. Name is logged but pill uses message primarily.
  const parts: string[] = [];
  if (details.code) parts.push(details.code);
  parts.push(details.message);
  const joined = parts.join(': ').slice(0, 500);
  return joined;
}

function createDefaultAdapter(): UpdaterAdapter {
  // electron-updater is intentionally kept behind this adapter. The rest of
  // the main process can therefore treat update failures as ordinary state.
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Unsigned v0.1.5: force full download to avoid stale blockmap / differential
    // issues while we prove 0.1.5 -> 0.1.6. Temporary conservative choice,
    // revisitable once code-signing is in place.
    autoUpdater.disableDifferentialDownload = true;

    let progressListener: ((percent: number) => void) | undefined;
    let downloadedListener: ((version?: string) => void) | undefined;
    let errorListener: ((error: Error) => void) | undefined;
    autoUpdater.on('download-progress', (info) => {
      const percent = typeof info?.percent === 'number' ? info.percent : NaN;
      if (Number.isFinite(percent)) {
        progressListener?.(percent);
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      downloadedListener?.(typeof info?.version === 'string' ? info.version : undefined);
    });
    autoUpdater.on('error', (error: Error) => {
      // Forward the real Error for diagnostics. Do not treat this event as
      // final — downloadUpdate() still owns the final download verdict, and
      // a recovered differential download must never show error.
      const details = extractUpdaterError(error);
      try {
        log.error('[dks] updater error event', {
          name: details.name,
          code: details.code,
          message: details.message,
        });
      } catch {}
      try {
        errorListener?.(error);
      } catch {}
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
      onUpdateDownloaded: (listener) => {
        downloadedListener = listener;
      },
      onError: (listener) => {
        errorListener = listener;
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
  if (state.status === 'error' && (state.errorKind === 'check' || state.errorKind === 'download')) {
    clone.errorKind = state.errorKind;
  }
  if (typeof state.errorMessage === 'string' && state.errorMessage.trim()) {
    clone.errorMessage = state.errorMessage.slice(0, 500);
  }
  if (typeof state.errorCode === 'string' && state.errorCode.trim()) {
    clone.errorCode = state.errorCode.slice(0, 100);
  }
  if (typeof state.errorName === 'string' && state.errorName.trim()) {
    clone.errorName = state.errorName.slice(0, 100);
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
 * Failures now carry `errorName`/`errorCode`/`errorMessage` from electron-updater
 * so the UI and main log can surface the real cause (Bug 2). Network and
 * release configuration failures are still represented by `status: 'error'`.
 */
export function createUpdaterService(options: UpdaterServiceOptions = {}): UpdaterService {
  const adapter = options.adapter ?? createDefaultAdapter();
  const enabled = options.enabled ?? true;
  const downloadInBackground = options.downloadInBackground ?? true;
  const listeners = new Set<(state: UpdateState) => void>();

  let state: UpdateState = { status: 'idle' };
  let checkPromise: Promise<UpdateState> | undefined;
  let activeDownloadVersion: string | undefined;

  const setState = (nextState: UpdateState): UpdateState => {
    // A completed installer remains usable until this process quits. Later
    // launch/hourly/manual checks must never hide the only install action or
    // replace the version of the installer that is actually on disk.
    if (state.status === 'downloaded') {
      return cloneState(state);
    }

    const previous = state;
    state = cloneState(nextState);
    const snapshot = cloneState(state);

    if (
      previous.status !== state.status ||
      previous.version !== state.version ||
      previous.errorMessage !== state.errorMessage
    ) {
      try {
        options.onTransition?.({
          from: previous.status,
          to: state.status,
          ...(state.version ? { version: state.version } : {}),
          ...(typeof state.progress === 'number' ? { progress: state.progress } : {}),
          ...(state.errorKind ? { errorKind: state.errorKind } : {}),
          ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
          ...(state.errorCode ? { errorCode: state.errorCode } : {}),
          ...(state.errorName ? { errorName: state.errorName } : {}),
        });
      } catch {
        // Diagnostics must never affect update handling.
      }
    }

    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer listener must never break update handling.
      }
    }

    return cloneState(state);
  };

  const markDownloaded = (eventVersion?: string): UpdateState => {
    const version = updateVersion({ updateInfo: { version: eventVersion } })
      ?? activeDownloadVersion
      ?? state.version;
    return setState({ status: 'downloaded', ...(version ? { version } : {}) });
  };

  // Download progress is meaningful only mid-download; stale events after a
  // completed/failed download are ignored rather than resurrecting the state.
  try {
    adapter.onDownloadProgress?.((percent) => {
      if (state.status === 'downloading') {
        setState({ status: 'downloading', version: state.version, progress: percent });
      }
    });
    adapter.onUpdateDownloaded?.((version) => {
      // This is electron-updater's authoritative completion event. It can
      // precede final cache cleanup and resolution of downloadUpdate().
      markDownloaded(version);
    });
    adapter.onError?.((error: Error) => {
      // Error events are not final outcomes. The corresponding operation
      // promise rejects on definitive failure; a recovered differential
      // download instead reaches update-downloaded and must never show error.
      // Real error is already logged in the adapter's handler above.
      void error;
    });
  } catch {
    // Event hooks are supplemental; promise-based completion still works.
  }

  const checkForUpdates = async (): Promise<UpdateState> => {
    if (!enabled) {
      // Development/unpackaged: no feed is contacted. Report 'disabled' —
      // never 'not-available', which would falsely claim "up to date".
      return setState({ status: 'disabled' });
    }

    // Do not even start a new network operation after completion. Besides
    // preserving stickiness, this lets repeated Settings/scheduler checks
    // return the installer version that is ready right now.
    if (state.status === 'downloaded') {
      return cloneState(state);
    }

    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      setState({ status: 'checking' });

      let result: UpdateCheckResult | null | undefined;
      try {
        result = await adapter.checkForUpdates();
      } catch (error: unknown) {
        const details = extractUpdaterError(error);
        try {
          log.error('[dks] updater check failed', {
            name: details.name,
            code: details.code,
            message: details.message,
          });
        } catch {}
        return setState({
          status: 'error',
          errorKind: 'check',
          errorMessage: formatErrorForUi(details),
          ...(details.code ? { errorCode: details.code } : {}),
          ...(details.name ? { errorName: details.name } : {}),
        });
      }

      if (state.status === 'downloaded') {
        return cloneState(state);
      }

      const version = updateVersion(result);

      // electron-updater reports the latest version even when it equals
      // the running one; `isUpdateAvailable === false` means UP TO DATE,
      // not a download candidate.
      if (!version || result?.isUpdateAvailable === false) {
        return setState({ status: 'not-available' });
      }

      setState({ status: 'available', version });

      if (downloadInBackground && adapter.downloadUpdate) {
        activeDownloadVersion = version;
        setState({ status: 'downloading', version });
        try {
          await adapter.downloadUpdate();
        } catch (error: unknown) {
          // If update-downloaded already fired, setState preserves that
          // completed installer instead of misreporting a later cleanup error.
          const details = extractUpdaterError(error);
          try {
            log.error('[dks] updater download failed', {
              version,
              name: details.name,
              code: details.code,
              message: details.message,
            });
          } catch {}
          return setState({
            status: 'error',
            version,
            errorKind: 'download',
            errorMessage: formatErrorForUi(details),
            ...(details.code ? { errorCode: details.code } : {}),
            ...(details.name ? { errorName: details.name } : {}),
          });
        } finally {
          activeDownloadVersion = undefined;
        }
        return markDownloaded(version);
      }

      return cloneState(state);
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
      // A failed restart does not delete the downloaded installer. Keep the
      // ready state so the user can retry instead of losing the only action.
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
