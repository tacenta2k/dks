import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createUpdaterScheduler,
  createUpdaterService,
  MAX_UPDATE_ERROR_LENGTH,
  sanitizeUpdateError,
  updaterReleasePolicy,
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

  it('turns network failures into serializable error state with the real cause', async () => {
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => {
          throw new Error('network is offline');
        }),
      }),
      enabled: true,
    });

    // The message is the actual cause, so the UI never blames the internet for
    // a signature or feed failure.
    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      message: 'network is offline',
    });
    expect(service.getState()).toEqual({ status: 'error', message: 'network is offline' });
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

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      version: '2.0.0',
      message: 'connection reset',
    });
    await expect(service.restartToUpdate()).resolves.toBe(false);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('reports a post-download failure as an error with its own cause', async () => {
    // "100% then an error": the download resolved but a later step (signature
    // verification, release metadata) failed. That must NOT be reported as
    // 'downloaded', and the cause must reach the renderer.
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '1.2.3' },
        })),
        downloadUpdate: vi.fn(async () => {
          throw new Error('signature verification failed for the downloaded update');
        }),
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      version: '1.2.3',
      message: 'signature verification failed for the downloaded update',
    });
    await expect(service.restartToUpdate()).resolves.toBe(false);
  });

  it('refuses to offer an unverified artifact for install', async () => {
    const quitAndInstall = vi.fn();
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '1.2.3' },
        })),
        downloadUpdate: vi.fn(async () => undefined),
        verifyArtifact: vi.fn(async () => false),
        quitAndInstall,
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      version: '1.2.3',
      message: 'The downloaded update could not be verified, so it was not installed.',
    });
    // Nothing is offered for install until a verified download exists.
    await expect(service.restartToUpdate()).resolves.toBe(false);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('offers an unsigned artifact for install once it verifies', async () => {
    // DKS ships unsigned NSIS installers, so "no signature" must not block the
    // install path — it is verified OK.
    const quitAndInstall = vi.fn();
    const verifyArtifact = vi.fn(async () => true);
    const service = createUpdaterService({
      adapter: adapter({
        checkForUpdates: vi.fn(async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '1.2.3' },
        })),
        downloadUpdate: vi.fn(async () => undefined),
        verifyArtifact,
        quitAndInstall,
      }),
      enabled: true,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'downloaded', version: '1.2.3' });
    expect(verifyArtifact).toHaveBeenCalledOnce();
    await expect(service.restartToUpdate()).resolves.toBe(true);
    expect(quitAndInstall).toHaveBeenCalledOnce();
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

describe('update error sanitising', () => {
  // Control characters are built from code points so the source stays plain
  // text (and the file never becomes "binary").
  const controlCharacters = String.fromCharCode(0, 1, 2, 31, 127, 128);

  it('keeps a plain cause readable', () => {
    expect(sanitizeUpdateError(new Error('network is offline'))).toBe('network is offline');
  });

  it('strips bearer tokens, signatures and control characters', () => {
    const raw = [
      'request failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      'signature 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      controlCharacters,
    ].join(' ');

    const cleaned = sanitizeUpdateError(new Error(raw));
    expect(cleaned).not.toMatch(/Bearer\s/);
    expect(cleaned).not.toMatch(/eyJ/);
    expect(cleaned).not.toMatch(/9f86d081/);
    expect(cleaned).toMatch(/request failed/);
    for (const character of controlCharacters) {
      expect(cleaned).not.toContain(character);
    }
  });

  it('accepts plain strings and error-like objects', () => {
    expect(sanitizeUpdateError('release feed rejected')).toBe('release feed rejected');
    expect(sanitizeUpdateError({ reason: 'release feed rejected' })).toBe('release feed rejected');
  });

  it('returns an empty string for anything without a cause', () => {
    expect(sanitizeUpdateError(null)).toBe('');
    expect(sanitizeUpdateError(undefined)).toBe('');
    expect(sanitizeUpdateError(42)).toBe('');
    expect(sanitizeUpdateError(new Error('   '))).toBe('');
    expect(sanitizeUpdateError(new Error(controlCharacters))).toBe('');
  });

  it('collapses a long token-like run so a credential can never reach the UI', () => {
    const raw = `update failed while reading the release feed: ${'abcdefghij'.repeat(12)}`;

    const cleaned = sanitizeUpdateError(new Error(raw));

    expect(cleaned).not.toContain('abcdefghij');
    expect(cleaned).toMatch(/update failed while reading the release feed/);
  });

  it('caps the length so a huge error cannot flood the UI', () => {
    const huge = `update failed: ${Array.from({ length: 300 }, (_, index) => `step ${index} rejected`).join(' ')}`;
    const cleaned = sanitizeUpdateError(new Error(huge));

    expect(cleaned.length).toBeLessThanOrEqual(MAX_UPDATE_ERROR_LENGTH);
    expect(cleaned.endsWith('…')).toBe(true);
    expect(cleaned.startsWith('update failed:')).toBe(true);
  });
});

describe('updater release policy', () => {
  it('keeps unsigned NSIS installs installable and never auto-installs', () => {
    // DKS publishes unsigned installers from a public GitHub repository, so
    // signature enforcement stays OFF. Nothing is downloaded or installed
    // without an explicit confirmation in the renderer.
    const policy = updaterReleasePolicy();
    expect(policy.forceCodeSigning).toBe(false);
    expect(policy.autoDownload).toBe(false);
    expect(policy.autoInstallOnAppQuit).toBe(false);
    expect(policy.allowDowngrade).toBe(false);
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

  it('clears only Chromium session storage on a real uninstall, never on update', () => {
    expect(builderYml).toMatch(/include:\s*build\/installer\.nsh/);
    const installer = readTextFileNormalised(resolve(root, 'build/installer.nsh'));

    // Real uninstall only: an in-place update also runs the old uninstaller
    // and must not sign the user out.
    expect(installer).toContain('!macro customUnInstall');
    expect(installer).toContain('${ifNot} ${isUpdated}');
    // Supabase's persisted session lives in Chromium Local Storage; removing
    // these two directories stops a reinstall silently restoring the login.
    expect(installer).toContain('RMDir /r "$APPDATA\\DKS\\Local Storage"');
    expect(installer).toContain('RMDir /r "$APPDATA\\DKS\\Session Storage"');
    // The SQLite business cache at the userData root is never targeted.
    expect(installer).not.toMatch(/RMDir[^\n]*\$APPDATA\\DKS"/);
    expect(installer).not.toContain('dks-cache.sqlite"');
    expect(installer).not.toMatch(/Delete[^\n]*\.sqlite/);
  });

  it('embeds no release credential anywhere in the client configuration', () => {
    // Prose mentions in comments are fine; a token VALUE/key is not.
    expect(builderYml).not.toMatch(/^\s*token:\s*\S/m);
    expect(builderYml).not.toMatch(/GH_TOKEN\s*[:=]\s*\S/);
    const updaterSource = readTextFileNormalised(resolve(root, 'electron/main/updater.ts'));
    expect(updaterSource).not.toMatch(/GH_TOKEN|setFeedURL/);
  });
});
