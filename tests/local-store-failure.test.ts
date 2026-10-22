import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_IPC_CHANNELS,
  createLocalStoreFailureHandlers,
  registerLocalStoreFailureIpcHandlers,
  type LocalIpcChannel,
  type LocalIpcMain,
} from '../electron/main/local-ipc';
import { localStoreErrorMessage, LOCAL_STORE_ERROR_HEADLINE } from '../src/lib/local-store-error';
import {
  LOCAL_STORE_ABI_HINT,
  LOCAL_STORE_LOG_FALLBACK,
  createLocalStoreFailure,
  describeLocalStoreError,
  isNativeModuleAbiMismatch,
  localStoreUnavailableMessage,
} from '../electron/main/local-store-diagnostics';

const LOG_PATH = 'C:\\Users\\dks-user\\AppData\\Roaming\\DKS\\logs\\main.log';

const ABI_ERROR = new Error(
  "The module '\\?\C:\\Program Files\\DKS\\resources\\app.asar.unpacked\\node_modules\\"
  + "better-sqlite3\\build\\Release\\better_sqlite3.node'\n"
  + 'was compiled against a different Node.js version using\n'
  + 'NODE_MODULE_VERSION 137. This version of Node.js requires\n'
  + 'NODE_MODULE_VERSION 132. Please try re-compiling or re-installing the module.',
);

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const removed: string[] = [];
  const ipcMain: LocalIpcMain = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      removed.push(channel);
      handlers.delete(channel);
    },
  };
  return { ipcMain, handlers, removed };
}

describe('local store failure diagnostics (R7)', () => {
  it('recognises the wrong-ABI native module error', () => {
    expect(isNativeModuleAbiMismatch(ABI_ERROR)).toBe(true);
    expect(isNativeModuleAbiMismatch(new Error('disk is full'))).toBe(false);
  });

  it('bounds and collapses the raw error message', () => {
    const described = describeLocalStoreError(ABI_ERROR);
    expect(described).not.toContain('\n');
    expect(described.length).toBeLessThanOrEqual(120);
    // The path prefix is dropped in favour of the ABI numbers themselves.
    expect(described).toContain('ABI 137');
    expect(described).toContain('ABI 132');
    expect(described).not.toContain('Program Files');
    expect(describeLocalStoreError(new Error('   '))).toBe('the local database could not be opened');
    expect(describeLocalStoreError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(120);
  });

  it('builds a user-safe failure with the log path and the reinstall hint', () => {
    const failure = createLocalStoreFailure(ABI_ERROR, LOG_PATH);
    expect(failure.abiMismatch).toBe(true);
    expect(failure.logPath).toBe(LOG_PATH);

    const message = localStoreUnavailableMessage(failure, 'dks:local:get-snapshot');
    expect(message).toContain('Local database unavailable');
    expect(message).toContain(LOCAL_STORE_ABI_HINT);
    expect(message).toContain(LOG_PATH);
    // The renderer shows this verbatim after trimming the IPC wrapper.
    expect(message.startsWith('Local database unavailable: ')).toBe(true);
  });

  it('falls back to the documented Windows log path', () => {
    const failure = createLocalStoreFailure(new Error('boom'));
    expect(failure.logPath).toBeNull();
    expect(localStoreUnavailableMessage(failure)).toContain(LOCAL_STORE_LOG_FALLBACK);
    expect(localStoreUnavailableMessage(failure)).not.toContain(LOCAL_STORE_ABI_HINT);
  });
});

describe('local store failure IPC handlers (R7)', () => {
  it('answers every local channel instead of leaving it unregistered', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const failure = createLocalStoreFailure(ABI_ERROR, LOG_PATH);

    registerLocalStoreFailureIpcHandlers({ ipcMain, failure });

    const channels = Object.values(LOCAL_IPC_CHANNELS);
    expect(channels.length).toBeGreaterThanOrEqual(30);
    expect([...handlers.keys()].sort()).toEqual([...channels].sort());
  });

  it('rejects each channel with the real reason, the channel and the log path', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const failure = createLocalStoreFailure(ABI_ERROR, LOG_PATH);
    registerLocalStoreFailureIpcHandlers({ ipcMain, failure });

    for (const channel of Object.values(LOCAL_IPC_CHANNELS) as LocalIpcChannel[]) {
      const handler = handlers.get(channel);
      expect(handler, `${channel} is not registered`).toBeTypeOf('function');
      expect(() => handler?.({}, undefined)).toThrow(/Local database unavailable/);
      expect(() => handler?.({}, undefined)).toThrow(channel);
      expect(() => handler?.({}, undefined)).toThrow(/DKS\\logs\\main\.log/);
      expect(() => handler?.({}, undefined)).toThrow(/reinstall DKS/);
    }
  });

  it('still rejects with a meaningful message for a non-ABI failure', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerLocalStoreFailureIpcHandlers({
      ipcMain,
      failure: createLocalStoreFailure(new Error('database is locked'), LOG_PATH),
    });

    const handler = handlers.get(LOCAL_IPC_CHANNELS.getSnapshot);
    expect(() => handler?.({}, undefined)).toThrow(/database is locked/);
    expect(() => handler?.({}, undefined)).not.toThrow(/reinstall DKS/);
  });

  it('builds one handler per channel without needing an ipcMain', () => {
    const handlers = createLocalStoreFailureHandlers(createLocalStoreFailure(ABI_ERROR, LOG_PATH));
    expect(Object.keys(handlers)).toHaveLength(Object.keys(LOCAL_IPC_CHANNELS).length);
  });

  it('replaces an existing handler and unregisters cleanly', () => {
    const { ipcMain, handlers, removed } = fakeIpcMain();
    ipcMain.handle(LOCAL_IPC_CHANNELS.getSnapshot, () => ({ rows: [] }));

    const unregister = registerLocalStoreFailureIpcHandlers({
      ipcMain,
      failure: createLocalStoreFailure(ABI_ERROR, LOG_PATH),
    });

    // The stale (successful) handler is gone; the channel now reports the truth.
    expect(removed).toContain(LOCAL_IPC_CHANNELS.getSnapshot);
    expect(() => handlers.get(LOCAL_IPC_CHANNELS.getSnapshot)?.({}, undefined))
      .toThrow(/Local database unavailable/);

    unregister();
    expect(handlers.size).toBe(0);
  });

  it('never registers the failure stubs twice without removing the old ones', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const removeSpy = vi.spyOn(ipcMain, 'removeHandler');
    const failure = createLocalStoreFailure(ABI_ERROR, LOG_PATH);

    registerLocalStoreFailureIpcHandlers({ ipcMain, failure });
    registerLocalStoreFailureIpcHandlers({ ipcMain, failure });

    // Each registration clears the previous 30 stubs first.
    expect(removeSpy).toHaveBeenCalledTimes(2 * Object.keys(LOCAL_IPC_CHANNELS).length);
    expect(handlers.size).toBe(Object.keys(LOCAL_IPC_CHANNELS).length);
  });
});

describe('renderer local-store error text (R7)', () => {
  it('strips the Electron IPC wrapper before showing the message', () => {
    const failure = createLocalStoreFailure(ABI_ERROR, LOG_PATH);
    const raw = new Error(
      `Error invoking remote method 'dks:local:get-snapshot': Error: `
      + localStoreUnavailableMessage(failure, 'dks:local:get-snapshot'),
    );

    const message = localStoreErrorMessage(raw);
    expect(message.startsWith(`${LOCAL_STORE_ERROR_HEADLINE}: `)).toBe(true);
    expect(message).not.toContain('Error invoking remote method');
    expect(message).toContain(LOG_PATH);
  });

  it('bounds very long messages and never renders an empty line', () => {
    expect(localStoreErrorMessage(new Error('x'.repeat(5_000))).length).toBeLessThanOrEqual(320);
    expect(localStoreErrorMessage(new Error('   '))).toContain('See the DKS main log');
    expect(localStoreErrorMessage(null)).toContain('See the DKS main log');
  });
});
