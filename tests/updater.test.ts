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

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'error' });
    expect(service.getState()).toEqual({ status: 'error' });
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

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'not-available' });
    expect(source.checkForUpdates).not.toHaveBeenCalled();
    await expect(service.restartToUpdate()).resolves.toBe(false);
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
