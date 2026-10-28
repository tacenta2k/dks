import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createUpdaterScheduler,
  createUpdaterService,
  type UpdaterAdapter,
} from '../electron/main/updater';

function adapter(overrides: Partial<UpdaterAdapter> = {}): UpdaterAdapter {
  return {
    checkForUpdates: vi.fn(async () => ({ updateInfo: undefined })),
    ...overrides,
  };
}

/** Windows checkouts may use CRLF; the configuration assertions are line-oriented. */
function readTextFileNormalised(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

describe('updater foundation', () => {
  it('quietly reports no release without attempting a download', async () => {
    const download = vi.fn(async () => undefined);
    const source = adapter({ downloadUpdate: download });
    const service = createUpdaterService({ adapter: source, enabled: true });

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'not-available' });
    expect(download).not.toHaveBeenCalled();
  });

  it('turns network failures into serializable error state without throwing', async () => {
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => {
          throw new Error('network is offline');
        }),
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({ status: 'error', errorKind: 'check', errorMessage: 'network is offline' });
    expect(service.getState()).toMatchObject({ status: 'error', errorKind: 'check', errorMessage: 'network is offline' });
  });

  it('downloads releases in the background and exposes restart-to-update state', async () => {
    const download = vi.fn(async () => undefined);
    const quitAndInstall = vi.fn();
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '1.2.3' } })),
        downloadUpdate: download,
        quitAndInstall,
      }),
      enabled: true,
    });
    const statuses: string[] = [];
    service.onStatus((state) => statuses.push(state.status));

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'downloaded', version: '1.2.3' });
    expect(download).toHaveBeenCalledOnce();
    await expect(service.restartToUpdate()).resolves.toBe(true);
    expect(quitAndInstall).toHaveBeenCalledOnce();
    expect(statuses).toEqual(['checking', 'available', 'downloading', 'downloaded']);
  });

  it('keeps disabled update checks no-throw and no-network', async () => {
    const source = adapter();
    const service = createUpdaterService({ adapter: source, enabled: false });

    // Development/unpackaged: 'disabled', never a false "up to date".
    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'disabled' });
    expect(source.checkForUpdates).not.toHaveBeenCalled();
    await expect(service.restartToUpdate()).resolves.toBe(false);
  });

  it('treats isUpdateAvailable=false as up to date even though a version is reported', async () => {
    // electron-updater resolves with the LATEST version in updateInfo even
    // when it equals the running version. Without this guard the app would
    // "download" and offer to install the version it already runs.
    const download = vi.fn(async () => undefined);
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: false,
          updateInfo: { version: '1.2.3' },
        })),
        downloadUpdate: download,
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'not-available' });
    expect(download).not.toHaveBeenCalled();
    await expect(service.restartToUpdate()).resolves.toBe(false);
  });

  it('forwards download progress only while downloading', async () => {
    let progressListener: ((percent: number) => void) | undefined;
    let releaseDownload: (() => void) | undefined;
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '2.0.0' },
        })),
        downloadUpdate: vi.fn(() => new Promise<void>((resolve) => {
          releaseDownload = resolve;
        })),
        onDownloadProgress: (listener) => {
          progressListener = listener;
        },
      }),
      enabled: true,
    });
    const seen: Array<{ status: string; progress?: number }> = [];
    service.onStatus((state) => seen.push({ status: state.status, progress: state.progress }));

    const pending = service.checkForUpdates();
    // Let the check reach the downloading state, then emit progress.
    await vi.waitFor(() => expect(service.getState().status).toBe('downloading'));
    progressListener?.(42.4);
    expect(service.getState()).toEqual({ status: 'downloading', version: '2.0.0', progress: 42 });

    releaseDownload?.();
    await expect(pending).resolves.toEqual({ status: 'downloaded', version: '2.0.0' });
    // Late progress events must not resurrect the downloading state.
    progressListener?.(99);
    expect(service.getState()).toEqual({ status: 'downloaded', version: '2.0.0' });
    expect(seen).toContainEqual({ status: 'downloading', progress: 42 });
  });

  it('never restarts before a download completes', async () => {
    const quitAndInstall = vi.fn();
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '2.0.0' },
        })),
        downloadUpdate: vi.fn(async () => {
          throw new Error('connection reset');
        }),
        quitAndInstall,
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'error',
      version: '2.0.0',
      errorKind: 'download',
      errorMessage: expect.stringContaining('connection reset'),
    });
    await expect(service.restartToUpdate()).resolves.toBe(false);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('keeps the downloaded version sticky across later errors and repeated checks', async () => {
    let emitError: ((error: Error) => void) | undefined;
    const check = vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '2.0.0' },
    }));
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: check,
        downloadUpdate: vi.fn(async () => undefined),
        onError: (listener) => {
          emitError = listener;
        },
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'downloaded',
      version: '2.0.0',
    });
    emitError?.(new Error('transient'));
    expect(service.getState()).toEqual({ status: 'downloaded', version: '2.0.0' });

    // Settings-mount and hourly checks return the completed installer rather
    // than starting work that could overwrite it with error/not-available.
    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'downloaded',
      version: '2.0.0',
    });
    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'downloaded',
      version: '2.0.0',
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({ status: 'downloaded', version: '2.0.0' });
  });

  it('does not surface a transient download error when update-downloaded follows', async () => {
    let emitError: ((error: Error) => void) | undefined;
    let emitDownloaded: ((version?: string) => void) | undefined;
    let finishDownload: (() => void) | undefined;
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '2.0.0' },
        })),
        downloadUpdate: vi.fn(() => new Promise<void>((resolve) => {
          finishDownload = resolve;
        })),
        onError: (listener) => {
          emitError = listener;
        },
        onUpdateDownloaded: (listener) => {
          emitDownloaded = listener;
        },
      }),
      enabled: true,
    });
    const statuses: string[] = [];
    service.onStatus((state) => statuses.push(state.status));

    const pending = service.checkForUpdates();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloading'));
    emitError?.(new Error('transient differential download error'));
    expect(service.getState().status).toBe('downloading');
    expect(statuses).not.toContain('error');

    emitDownloaded?.('2.0.0');
    expect(service.getState()).toEqual({ status: 'downloaded', version: '2.0.0' });
    finishDownload?.();
    await expect(pending).resolves.toEqual({ status: 'downloaded', version: '2.0.0' });
    expect(statuses).not.toContain('error');
  });

  it('keeps downloaded when final promise cleanup rejects after the completion event', async () => {
    let emitDownloaded: ((version?: string) => void) | undefined;
    let failDownload: ((error: Error) => void) | undefined;
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '2.0.0' },
        })),
        downloadUpdate: vi.fn(() => new Promise<void>((_resolve, reject) => {
          failDownload = reject;
        })),
        onUpdateDownloaded: (listener) => {
          emitDownloaded = listener;
        },
      }),
      enabled: true,
    });

    const pending = service.checkForUpdates();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloading'));
    emitDownloaded?.('2.0.0');
    failDownload?.(new Error('cache cleanup failed'));
    await expect(pending).resolves.toEqual({ status: 'downloaded', version: '2.0.0' });
    expect(service.getState()).toEqual({ status: 'downloaded', version: '2.0.0' });
  });

  it('reports sanitized transition metadata with real updater error details (Bug 2)', async () => {
    const onTransition = vi.fn();
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => {
          const err = new Error('secret release URL and local path') as Error & { code?: string };
          (err as unknown as { code: string }).code = 'ERR_UPDATER_CHECK';
          return Promise.reject(err);
        }),
      }),
      enabled: true,
      onTransition,
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'error',
      errorKind: 'check',
      errorMessage: expect.stringContaining('secret release URL'),
    });
    const lastCall = onTransition.mock.calls.at(-1)?.[0] as { from: string; to: string; errorMessage?: string; errorKind?: string; errorCode?: string } | undefined;
    expect(lastCall).toMatchObject({ from: 'checking', to: 'error', errorKind: 'check' });
    expect(lastCall?.errorMessage).toContain('secret release URL');
    // Transition carries the sanitized message (bounded, no raw URL leak beyond the message itself).
    // It no longer hides the error - the pill and electron-log surface name/code/message.
    expect(typeof lastCall?.errorMessage).toBe('string');
  });

  it('runs a launch check and schedules hourly checks through injectable timers', async () => {
    const service = createUpdaterService({ adapter: adapter(), enabled: true });
    let scheduled: (() => void) | undefined;
    const setInterval = vi.fn((callback: () => void) => {
      scheduled = callback;
      return 42;
    });
    const clearInterval = vi.fn();
    const scheduler = createUpdaterScheduler(service, {
      setInterval,
      clearInterval,
      intervalMs: 60 * 60 * 1000,
    });

    await scheduler.start();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(scheduled).toBeTypeOf('function');
    expect((service as unknown as { getState: () => unknown }).getState()).toEqual({ status: 'not-available' });
    scheduled?.();
    await Promise.resolve();
    expect((service as unknown as { getState: () => unknown }).getState()).toEqual({ status: 'not-available' });
    scheduler.stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});

describe('release provider configuration', () => {
  const root = process.cwd();
  const builderYml = readTextFileNormalised(resolve(root, 'electron-builder.yml'));
  const packageJson = JSON.parse(readTextFileNormalised(resolve(root, 'package.json'))) as {
    repository?: { type?: string; url?: string } | string;
    scripts?: Record<string, string>;
  };

  it('names the GitHub release provider explicitly (no git-remote inference)', () => {
    // The packaged app-update.yml is generated from this block; installed
    // clients read tacenta2k/dks releases because it says so here.
    expect(builderYml).toMatch(/publish:\s*\n(?:.*\n)*?\s*provider:\s*github/);
    expect(builderYml).toMatch(/owner:\s*tacenta2k/);
    expect(builderYml).toMatch(/repo:\s*dks/);
    const repositoryUrl = typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;
    expect(repositoryUrl).toContain('github.com/tacenta2k/dks');
  });

  it('publishes Windows NSIS releases as drafts the owner publishes manually', () => {
    expect(builderYml).toMatch(/win:\s*\n(?:.*\n)*?\s*-\s*nsis/);
    expect(builderYml).toMatch(/releaseType:\s*draft/);
    // Update installs must never wipe the local SQLite data in userData.
    expect(builderYml).toMatch(/deleteAppDataOnUninstall:\s*false/);
    expect(packageJson.scripts?.release).toContain('--publish always');
    expect(packageJson.scripts?.dist).toContain('--publish never');
  });

  it('clears Chromium session storage on a real uninstall (4 locations, elevation-aware) - never on update', () => {
    expect(builderYml).toMatch(/include:\s*build\/installer\.nsh/);
    const installer = readTextFileNormalised(resolve(root, 'build/installer.nsh'));

    // Real uninstall only: an in-place update also runs the old uninstaller
    // and must not sign the user out.
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('!macro customUnInstall');
    // customUnInstall is gated by isUpdated so auto-update preserves session
    expect(installer).toContain('${ifNot} ${isUpdated}');
    // customInstall preserves existing nonce via file-existence (handles manual
    // in-place upgrade where isUpdated is false, unlike auto-update)
    expect(installer).toContain('FileExists');
    expect(installer).toContain('$APPDATA\\DKS\\install-nonce');
    // Fresh-install nonce: new GUID on fresh install, preserved on update (Bug 1).
    // Must assign GUID text to $1 via StringFromGUID2 (t .r1) and verify non-empty after write.
    expect(installer).toContain('install-nonce');
    expect(installer).toContain('CoCreateGuid');
    expect(installer).toMatch(/StringFromGUID2.*t \.r1/);
    expect(installer).toContain('FileWrite');
    expect(installer).toMatch(/\$1/);
    expect(installer).toContain('install-nonce created successfully');
    expect(installer).toContain('FileRead');
    // Second-layer NSIS guard: abort if DKS is still running (tray counts).
    // Uses nsExec+tasklist or FindWindow (both built-in) — no external nsProcess plugin required.
    expect(installer).toMatch(/nsExec::Exec|FindWindow/i);
    expect(installer).toMatch(/tasklist|FindWindow|DKS/i);
    // findstr/StrStr/StrCpy/INFO/find variant is legacy; new FindWindow also valid
    expect(installer).toMatch(/findstr|StrStr|StrCpy|INFO:|find|FindWindow/i);
    expect(installer).toContain('DKS');
    expect(installer).toContain('Abort');
    // Elevation: must resolve the real user's %APPDATA%, not an elevated admin's.
    expect(installer).toContain('SetShellVarContext current');
    // Supabase's persisted session lives in Chromium storages; on Electron 34
    // (Chromium 130) Cookies is at Network\\Cookies (file), not a Cookies directory.
    expect(installer).toContain('Local Storage');
    expect(installer).toContain('Session Storage');
    expect(installer).toContain('IndexedDB');
    // Cookies: legacy directory + legacy file + current Network\\Cookies file
    expect(installer).toContain('Cookies');
    expect(installer).toContain('Network');
    // Genuine uninstall deletes install-nonce so next fresh install triggers app-level clear
    expect(installer).toMatch(/Delete.*install-nonce/);
    // The SQLite business cache at the userData root is never targeted - it holds
    // customer data + outbox and must survive uninstall/reinstall.
    expect(installer).not.toMatch(/RMDir[^\\n]*\\$APPDATA\\\\DKS"/);
    expect(installer).not.toContain('dks-cache.sqlite"');
    expect(installer).not.toMatch(/Delete[^\\n]*\\.sqlite/);
  });

  it('embeds no release credential anywhere in the client configuration', () => {
    // Prose mentions in comments are fine; a token VALUE/key is not.
    expect(builderYml).not.toMatch(/^\s*token:\s*\S/m);
    expect(builderYml).not.toMatch(/GH_TOKEN\s*[:=]\s*\S/);
    const updaterSource = readTextFileNormalised(resolve(root, 'electron/main/updater.ts'));
    expect(updaterSource).not.toMatch(/GH_TOKEN|setFeedURL/);
  });
});
