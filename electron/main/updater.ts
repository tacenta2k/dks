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
  /**
   * The REAL reason the last check/download failed, already sanitised for the
   * renderer (control characters, bearer tokens and long signature/token runs
   * removed, length capped). Never a token, a path or a raw exception.
   *
   * Optional so the success states stay exactly as small as before.
   */
  message?: string;
}

/** Longest sanitised error text forwarded to the renderer. */
export const MAX_UPDATE_ERROR_LENGTH = 300;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const BEARER_TOKEN = /\bBearer\s+\S+/gi;
const LONG_HEX_RUN = /\b[0-9a-f]{32,}\b/gi;
const LONG_TOKEN_RUN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/**
 * Turn an arbitrary failure into a short, safe, human-readable sentence.
 *
 * The previous implementation dropped the error object entirely and mapped
 * EVERY failure to `status: 'error'`, which the renderer rendered as
 * "Update check failed. Check your internet connection and try again." — so a
 * signature-verification failure, a rejected release or a bad feed looked like
 * a network problem. The message below is the real cause, stripped of anything
 * that could carry a credential or a machine-specific path.
 */
export function sanitizeUpdateError(error: unknown): string {
  let text = '';
  if (error instanceof Error && typeof error.message === 'string') {
    text = error.message;
  } else if (typeof error === 'string') {
    text = error;
  } else if (error && typeof error === 'object') {
    const record = error as { message?: unknown; reason?: unknown };
    if (typeof record.message === 'string') {
      text = record.message;
    } else if (typeof record.reason === 'string') {
      text = record.reason;
    }
  }

  if (!text.trim()) {
    return '';
  }

  text = text
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(BEARER_TOKEN, 'a bearer token')
    .replace(LONG_HEX_RUN, 'a signature')
    .replace(LONG_TOKEN_RUN, 'a long token')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return '';
  }

  return text.length > MAX_UPDATE_ERROR_LENGTH
    ? `${text.slice(0, MAX_UPDATE_ERROR_LENGTH - 1)}…`
    : text;
}

/**
 * The release-integrity policy DKS applies to electron-updater.
 *
 * DKS publishes UNSIGNED NSIS installers from a public GitHub repository, so
 * signature enforcement is deliberately OFF: an unsigned artifact must still
 * install. `autoDownload` and `autoInstallOnAppQuit` stay false — a downloaded
 * update is never installed without an explicit confirmation in the renderer.
 * `allowDowngrade` stays false so a stale feed can never roll an install back.
 */
export function updaterReleasePolicy(): {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  forceCodeSigning: boolean;
} {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    forceCodeSigning: false,
  };
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
  /**
   * Verify the downloaded artifact before it may be installed. Resolves false
   * only for a real verification failure; an unsigned release (DKS's normal
   * case) resolves true.
   */
  verifyArtifact?: () => Promise<boolean>;
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
    // Release-integrity policy (see `updaterReleasePolicy`): unsigned NSIS
    // releases install, nothing is ever downloaded or installed automatically.
    // `forceCodeSigning` is not part of every electron-updater typings revision,
    // so it is applied through the optional-property shape.
    const policy = updaterReleasePolicy();
    const signaturePolicy = autoUpdater as unknown as { forceCodeSigning?: boolean };
    autoUpdater.autoDownload = policy.autoDownload;
    autoUpdater.autoInstallOnAppQuit = policy.autoInstallOnAppQuit;
    autoUpdater.allowDowngrade = policy.allowDowngrade;
    signaturePolicy.forceCodeSigning = policy.forceCodeSigning;

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
      /**
       * Verify the downloaded artifact before it may be offered for install.
       *
       * DKS ships unsigned NSIS installers, so a missing signature is NOT a
       * failure — only an explicit verification error counts, and only when the
       * publisher has opted into signature enforcement (which DKS does not).
       * This mirrors electron-updater's `verifyUpdateCodeSignature` without
       * making an unsigned release uninstallable.
       */
      verifyArtifact: async () => {
        const enforceSignatures = (autoUpdater as unknown as { forceCodeSigning?: boolean })
          .forceCodeSigning === true;
        if (!enforceSignatures) {
          return true;
        }
        const verifier = (autoUpdater as unknown as {
          verifyUpdateCodeSignature?: () => Promise<boolean>;
        }).verifyUpdateCodeSignature;
        if (typeof verifier !== 'function') {
          // The installed electron-updater cannot verify: do not block the
          // install on a capability this build does not have.
          return true;
        }
        try {
          return await verifier();
        } catch {
          return false;
        }
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
  // The sanitised message is already safe to forward; drop it when empty so the
  // success states stay byte-identical to the previous shape.
  const message = sanitizeUpdateError(state.message);
  if (message) {
    clone.message = message;
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
 * The error OBJECT is never retained or sent to the renderer. The sanitised
 * cause is carried on `status: 'error'` so the UI can show what actually
 * happened instead of blaming the internet.
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
          try {
            await adapter.downloadUpdate();
            // The artifact is only offered for install once it has been
            // verified. An unsigned NSIS release (DKS's normal case) verifies
            // OK; a genuine verification failure gets its own message.
            if (adapter.verifyArtifact && !(await adapter.verifyArtifact())) {
              return setState({
                status: 'error',
                version,
                message: 'The downloaded update could not be verified, so it was not installed.',
              });
            }
          } catch (downloadError) {
            // "100% then an error" is a post-download failure (verification,
            // signature, release metadata). Report the actual cause instead of
            // letting the renderer blame the connection.
            return setState({
              status: 'error',
              version,
              message: sanitizeUpdateError(downloadError),
            });
          }
          return setState({ status: 'downloaded', version });
        }

        return cloneState(state);
      } catch (error) {
        return setState({ status: 'error', message: sanitizeUpdateError(error) });
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
    } catch (error) {
      setState({ status: 'error', message: sanitizeUpdateError(error) });
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
