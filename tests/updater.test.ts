import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  BEFORE_INSTALL_TIMEOUT_MS,
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
    // Second-layer NSIS guard: running.lock created by Electron on start, tasklist as secondary (electron-builder pattern)
    expect(installer).toMatch(/running\.lock/i);
    expect(installer).toContain('DKS');
    expect(installer).toContain('Abort');
    // Must be IfSilent-guarded so /S never shows GUI (was hang in 6h run)
    expect(installer).toMatch(/IfSilent/);
    // No CI-specific hardcoded paths may ship in the installer
    expect(installer).not.toContain('runneradmin');
    expect(installer).not.toContain('C:\\Users');
    // Guarded by isUpdated so auto-update does not sign out
    expect(installer).toContain('isUpdated');
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

describe('v0.1.8 Issue A — session is flushed before the installer takes over', () => {
  const downloadedService = (extra: Partial<Parameters<typeof createUpdaterService>[0]> = {}) => {
    const quitAndInstall = vi.fn();
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '9.9.9' } })),
        downloadUpdate: vi.fn(async () => undefined),
        quitAndInstall,
      }),
      enabled: true,
      ...extra,
    });
    return { service, quitAndInstall };
  };

  it('awaits beforeQuitAndInstall BEFORE quitAndInstall', async () => {
    const order: string[] = [];
    const { service, quitAndInstall } = downloadedService({
      beforeQuitAndInstall: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('flush');
      },
    });
    quitAndInstall.mockImplementation(() => order.push('install'));
    await service.checkForUpdates();
    await expect(service.restartToUpdate()).resolves.toBe(true);
    expect(order).toEqual(['flush', 'install']);
  });

  it('a failing flush never blocks the install', async () => {
    const { service, quitAndInstall } = downloadedService({
      beforeQuitAndInstall: async () => { throw new Error('flush failed'); },
    });
    await service.checkForUpdates();
    await expect(service.restartToUpdate()).resolves.toBe(true);
    expect(quitAndInstall).toHaveBeenCalledOnce();
  });

  it('a hanging flush is bounded by BEFORE_INSTALL_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const { service, quitAndInstall } = downloadedService({
        beforeQuitAndInstall: () => new Promise<void>(() => undefined),
      });
      await service.checkForUpdates();
      const pending = service.restartToUpdate();
      await vi.advanceTimersByTimeAsync(BEFORE_INSTALL_TIMEOUT_MS + 10);
      await expect(pending).resolves.toBe(true);
      expect(quitAndInstall).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the real adapter keeps electron-updater\'s exact install arguments (isSilent=false, isForceRunAfter=true)', () => {
    const source = readFileSync(resolve(__dirname, '../electron/main/updater.ts'), 'utf8');
    expect(source).toContain('autoUpdater.quitAndInstall(false, true)');
    const main = readFileSync(resolve(__dirname, '../electron/main/index.ts'), 'utf8');
    expect(main).toContain('beforeQuitAndInstall: flushSessionStorageBeforeInstall');
    expect(main).toMatch(/flushStorageData\(\)/);
    expect(main).toMatch(/cookies\?\.flushStore\?\.\(\)/);
  });
});

describe('v0.1.8 Issue A — pinned evidence for the updater install invocation', () => {
  const root = resolve(__dirname, '..');
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

  it('electron-updater builds `--updated [--force-run]` and quitAndInstall() defaults to non-silent + autoRun', () => {
    const nsis = read('node_modules/electron-updater/out/NsisUpdater.js');
    expect(nsis).toContain('const args = ["--updated"];');
    expect(nsis).toMatch(/if \(options\.isSilent\) \{\s*args\.push\("\/S"\);/);
    expect(nsis).toMatch(/if \(options\.isForceRunAfter\) \{\s*args\.push\("--force-run"\);/);
    const base = read('node_modules/electron-updater/out/BaseUpdater.js');
    expect(base).toContain('quitAndInstall(isSilent = false, isForceRunAfter = false)');
    expect(base).toContain('this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)');
    expect(read('node_modules/electron-updater/out/AppUpdater.js')).toContain('this.autoRunAppAfterInstall = true;');
  });

  it('electron-builder always passes --updated to the OLD uninstaller during an in-place install', () => {
    const util = read('node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh');
    expect(util).toContain('StrCpy $0 "$0 --updated"');
    expect(util).toContain(`ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir' $R0`);
    // and DKS keeps deleteAppDataOnUninstall false, so the --updated branch is the one taken
    expect(read('electron-builder.yml')).toMatch(/deleteAppDataOnUninstall:\s*false/);
  });

  it('installer.nsh: isUpdated → never fresh; uninstall cleanup is skipped when updating', () => {
    const nsh = read('build/installer.nsh');
    expect(nsh).toMatch(/!macro customInit[\s\S]*?Delete "\$APPDATA\\DKS\\\.dks-isFresh"\s*\$\{If\} \$\{isUpdated\}/);
    expect(nsh).toMatch(/!macro customUnInstall\s*\$\{ifNot\} \$\{isUpdated\}/);
  });

  it('CI case E runs the exact updater arguments and asserts marker/nonce/session', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('NSIS case E — electron-updater install invocation');
    // E1: the exact non-silent quitAndInstall() invocation, wizard driven like the user did.
    expect(ci).toContain('$p = Start-UpdaterInstall "--updated --force-run"');
    expect(ci).toContain("Invoke-WizardButton $p.Id '^(Next|Install)'");
    expect(ci).toContain("Invoke-WizardButton $p.Id '^Finish'");
    expect(ci).toContain('-ArgumentList "--updated /S --force-run"');
    expect(ci).toContain('gh release download v0.1.6');
    expect(ci).toContain('session-reset-required EXISTS after an updater-style install');
    expect(ci).toContain('install-nonce changed');
    expect(ci).toContain('install nonce matches stored nonce — preserving session');
  });

  it('pinned: the assisted wizard shows the install-mode page on update (not skipped by --updated)', () => {
    const tpl = 'node_modules/app-builder-lib/templates/nsis';
    const assisted = read(`${tpl}/assistedInstaller.nsh`);
    // License and directory pages are guarded by skipPageIfUpdated; the install-mode page is not.
    expect(assisted).toMatch(/skipPageIfUpdated\s+!insertmacro licensePage/);
    expect(assisted).toMatch(/!ifndef INSTALL_MODE_PER_ALL_USERS\s+!insertmacro PAGE_INSTALL_MODE/);
    const multiUser = read(`${tpl}/multiUserUi.nsh`);
    expect(multiUser).toContain('${OrIf} ${isForCurrentUser}');
    // isUpdated / isForCurrentUser are generated CLI-parameter tests (StdUtils.TestParameter).
    const generator = read('node_modules/app-builder-lib/out/targets/nsis/nsisScriptGenerator.js');
    expect(generator).toContain('StdUtils.TestParameter');
    const target = read('node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
    expect(target).toContain('scriptGenerator.flags(["updated", "force-run", "keep-shortcuts", "no-desktop-shortcut", "delete-app-data", "allusers", "currentuser"])');
    expect(target).toMatch(/if \(options\.perMachine === true\) \{\s*defines\.INSTALL_MODE_PER_ALL_USERS = null;/);
  });
});
