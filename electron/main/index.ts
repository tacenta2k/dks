import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
} from 'electron';
import type { IpcMainEvent } from 'electron';
import * as path from 'node:path';
import log from 'electron-log';

import {
  createNotificationService,
  NOTIFICATION_SHOW_CHANNEL,
  type NotificationService,
} from './notifications';
import {
  createUpdaterService,
  UPDATER_CHECK_CHANNEL,
  UPDATER_RESTART_CHANNEL,
  UPDATER_STATUS_CHANNEL,
  type UpdateState,
  type UpdaterService,
  createUpdaterScheduler,
  type UpdaterScheduler,
} from './updater';
import { createTray, destroyTray, type TrayActions } from './tray';
import { shouldStartHidden, startupRegistration } from './startup';
import type { Tray } from 'electron';
import { createSqliteStore, type SqliteStore } from './sqlite';
import {
  registerLocalIpcHandlers,
  type LocalIpcMain,
} from './local-ipc';

/**
 * R2-05: Windows resolves the toast/notification author from the application
 * identity. Without these two calls a development build shows
 * "Electron.app.electron". They must run before any window, tray or
 * notification is created, so they are applied at module load (the main entry
 * imports this module before `app.whenReady()`).
 *
 * productName / appId in electron-builder.yml stay unchanged: the packaged
 * installer still ships DKS with com.dks.tracker.
 */
export const APP_DISPLAY_NAME = 'DKS' as const;
export const APP_USER_MODEL_ID = 'com.dks.tracker' as const;

export function configureAppIdentity(): void {
  try {
    app.setName(APP_DISPLAY_NAME);
  } catch (error) {
    log.warn('[dks] app.setName failed', error);
  }
  try {
    // Required on Windows for toast notifications to be attributed to DKS.
    app.setAppUserModelId(APP_USER_MODEL_ID);
  } catch (error) {
    log.warn('[dks] app.setAppUserModelId failed', error);
  }
}

// Applied immediately (not inside whenReady) so no notification or window can
// be created before the identity is set.
configureAppIdentity();

export const APP_VERSION_CHANNEL = 'dks:app-version' as const;
export const MINIMIZE_TO_TRAY_CHANNEL = 'dks:minimize-to-tray' as const;
export const QUIT_CHANNEL = 'dks:quit' as const;
export const LOGOUT_REQUESTED_CHANNEL = 'dks:logout-requested' as const;
export const NAVIGATION_REQUESTED_CHANNEL = 'dks:navigation-requested' as const;
export const OPEN_EXTERNAL_CHANNEL = 'dks:open-external' as const;

/** Only these hosts may be opened in the system browser from the renderer. */
const ALLOWED_EXTERNAL_HOSTS = new Set(['github.com', 'www.github.com']);

export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export type DksNavigationTarget = 'dashboard' | 'sheet';

export interface AutoLaunchStatus {
  supported: boolean;
  enabled: boolean;
}

export interface CreateMainWindowOptions {
  startHidden?: boolean;
  rendererUrl?: string;
  rendererFile?: string;
}

const DEFAULT_RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let lifecycleStarted = false;
let ipcHandlersRegistered = false;
let notificationService: NotificationService | undefined;
let updaterService: UpdaterService | undefined;
let updaterScheduler: UpdaterScheduler | undefined;
let localStore: SqliteStore | undefined;
let unregisterLocalIpc: (() => void) | undefined;

function safeInvoke(action: () => void): void {
  try {
    action();
  } catch {
    // Main-process cleanup and shell actions are intentionally best effort.
  }
}

function getAppVersion(): string {
  try {
    const version = app.getVersion();
    return typeof version === 'string' && version.trim() ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isUsableWindow(window: BrowserWindow | null): window is BrowserWindow {
  if (!window) {
    return false;
  }

  try {
    return !window.isDestroyed();
  } catch {
    return false;
  }
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!isUsableWindow(mainWindow)) {
    return;
  }

  try {
    mainWindow.webContents.send(channel, ...args);
  } catch {
    // A window can disappear between the check and send during shutdown.
  }
}

function loadRenderer(window: BrowserWindow, options: CreateMainWindowOptions): void {
  const rendererUrl = options.rendererUrl
    ?? process.env.ELECTRON_RENDERER_URL
    ?? process.env.VITE_DEV_SERVER_URL;
  const rendererFile = options.rendererFile ?? DEFAULT_RENDERER_FILE;

  try {
    if (rendererUrl) {
      log.info(`[dks] loading renderer from dev URL ${rendererUrl}`);
      void window.loadURL(rendererUrl).catch((error) => {
        log.error('[dks] renderer dev URL failed to load', error);
      });
      return;
    }

    log.info(`[dks] loading renderer from ${rendererFile}`);
    void window.loadFile(rendererFile).catch((error) => {
      log.error('[dks] renderer file failed to load', error);
    });
  } catch (error) {
    // A renderer load failure should leave the shell available for diagnostics.
    log.error('[dks] renderer load threw', error);
  }
}

/**
 * R3 batch D — startup registration.
 *
 * Exactly one mechanism is used: Electron's native `app.setLoginItemSettings`
 * (Windows: the `HKCU\…\CurrentVersion\Run` value named after the app, i.e.
 * `DKS`). The unused `auto-launch` dependency was removed from package.json so
 * a second writer can never produce a duplicate startup entry.
 *
 * A development run does not write anything: `npm run dev` used to register
 * `electron.exe`, which is a stale target the moment the checkout moves, and
 * calling `setLoginItemSettings` with `openAtLogin: false` would silently
 * remove the installed app's autostart. It only logs what it found.
 */
function configureAutoLaunch(enabled = true): AutoLaunchStatus {
  const registration = startupRegistration({
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    appName: app.getName(),
  });

  if (registration.reason === 'development') {
    log.info('[dks] startup registration skipped (not a packaged build)', {
      execPath: process.execPath,
      appName: app.getName(),
    });
    return { supported: false, enabled: false };
  }

  try {
    if (typeof app.setLoginItemSettings !== 'function') {
      return { supported: false, enabled: false };
    }

    app.setLoginItemSettings({
      ...registration.settings,
      openAtLogin: enabled,
    });

    // Read-only diagnostic: this is the value Windows will run at sign-in for
    // this executable. Written to the log so support can compare it with the
    // Startup list without touching the registry.
    const current = typeof app.getLoginItemSettings === 'function'
      ? app.getLoginItemSettings({ path: process.execPath } as never)
      : null;
    log.info('[dks] startup registration', {
      appName: app.getName(),
      execPath: process.execPath,
      openAtLogin: current?.openAtLogin ?? enabled,
      willLaunchAtLogin: current?.executableWillLaunchAtLogin ?? null,
    });

    return { supported: true, enabled };
  } catch {
    return { supported: false, enabled: false };
  }
}

export function createMainWindow(options: CreateMainWindowOptions = {}): BrowserWindow {
  if (isUsableWindow(mainWindow)) {
    return mainWindow;
  }

  // `startHidden` (tray autostart / --hidden) must keep the window invisible;
  // a normal development or desktop launch must show and focus it.  The show
  // flag is therefore the negation of the hidden request.
  const startHidden = options.startHidden ?? shouldStartHidden(process.argv);
  log.info(`[dks] createMainWindow (hidden=${String(startHidden)})`);

  const window = new BrowserWindow({
    width: 1_440,
    height: 920,
    minWidth: 1_020,
    minHeight: 680,
    show: !startHidden,
    autoHideMenuBar: true,
    title: 'DKS',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow = window;

  if (!startHidden) {
    safeInvoke(() => {
      window.show();
      window.focus();
    });
  }

  window.on('close', (event) => {
    if (quitting) {
      return;
    }

    event.preventDefault();
    safeInvoke(() => window.hide());
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  try {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch {
    // Older Electron versions may not provide this optional hardening hook.
  }

  loadRenderer(window, options);
  return window;
}

export function showMainWindow(target?: DksNavigationTarget): void {
  const window = isUsableWindow(mainWindow) ? mainWindow : createMainWindow();

  safeInvoke(() => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });

  if (target) {
    sendToRenderer(NAVIGATION_REQUESTED_CHANNEL, target);
  }
}

export function hideMainWindow(): void {
  if (isUsableWindow(mainWindow)) {
    safeInvoke(() => mainWindow?.hide());
  }
}

export function requestLogout(): void {
  safeInvoke(() => showMainWindow());
  sendToRenderer(LOGOUT_REQUESTED_CHANNEL);
}

export function requestQuit(): void {
  quitting = true;
  updaterScheduler?.stop();
  updaterScheduler = undefined;
  destroyTray(tray);
  tray = null;
  safeInvoke(() => app.quit());
}

function closeLocalStore(): void {
  if (unregisterLocalIpc) {
    safeInvoke(() => unregisterLocalIpc?.());
    unregisterLocalIpc = undefined;
  }

  if (!localStore) {
    return;
  }

  const store = localStore;
  localStore = undefined;
  safeInvoke(() => {
    void store.flush().catch(() => undefined);
  });
  safeInvoke(() => {
    store.close();
  });
}

/**
 * Open exactly one app-owned local store after Electron is ready. The user
 * data path stays in the main process; only structured records cross IPC.
 */
function openLocalStore(): void {
  if (localStore) {
    return;
  }

  let opened: SqliteStore | undefined;
  try {
    const userDataPath = app.getPath('userData');
    opened = createSqliteStore({ userDataPath });
    localStore = opened;
    unregisterLocalIpc = registerLocalIpcHandlers({
      ipcMain: ipcMain as unknown as LocalIpcMain,
      store: localStore,
    });
    log.info('[dks] local SQLite store opened and IPC handlers registered');
  } catch (error) {
    // The shell and cloud features can still start when local storage is not
    // available; the renderer simply observes an absent local bridge.
    log.error('[dks] failed to open the local SQLite store', error);
    safeInvoke(() => opened?.close());
    localStore = undefined;
    unregisterLocalIpc = undefined;
  }
}

export function acquireSingleInstanceLock(): boolean {
  try {
    if (typeof app.requestSingleInstanceLock !== 'function') {
      return true;
    }

    const acquired = app.requestSingleInstanceLock();
    if (!acquired) {
      safeInvoke(() => app.quit());
      return false;
    }

    app.on('second-instance', () => {
      showMainWindow();
    });
    return true;
  } catch {
    // A missing platform lock should not make the app unusable.
    return true;
  }
}

function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) {
    return;
  }

  ipcHandlersRegistered = true;

  ipcMain.on(APP_VERSION_CHANNEL, (event: IpcMainEvent) => {
    event.returnValue = getAppVersion();
  });
  ipcMain.on(MINIMIZE_TO_TRAY_CHANNEL, hideMainWindow);
  ipcMain.on(QUIT_CHANNEL, requestQuit);

  ipcMain.handle(NOTIFICATION_SHOW_CHANNEL, (_event, request: unknown) => (
    notificationService?.show(request) ?? { delivered: false, reason: 'unavailable' }
  ));
  ipcMain.handle(UPDATER_CHECK_CHANNEL, async () => (
    updaterService?.checkForUpdates() ?? Promise.resolve<UpdateState>({ status: 'not-available' })
  ));
  ipcMain.handle(UPDATER_RESTART_CHANNEL, async () => (
    updaterService?.restartToUpdate() ?? Promise.resolve(false)
  ));
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, url: unknown) => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('[dks] blocked openExternal request', url);
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch (error) {
      log.warn('[dks] openExternal failed', error);
      return false;
    }
  });
}

function createDksTray(): Tray | null {
  const actions: TrayActions = {
    open: () => showMainWindow(),
    dashboard: () => showMainWindow('dashboard'),
    logout: requestLogout,
    exit: requestQuit,
  };

  try {
    return createTray({ actions, tooltip: 'DKS' });
  } catch {
    return null;
  }
}

function installLifecycleListeners(): void {
  app.on('before-quit', () => {
    quitting = true;
    updaterScheduler?.stop();
    closeLocalStore();
  });

  app.on('window-all-closed', () => {
    // DKS is a tray application. The process remains alive until Exit is used.
  });

  app.on('activate', () => {
    showMainWindow();
  });
}

export async function startMainProcess(): Promise<boolean> {
  if (lifecycleStarted) {
    return true;
  }
  lifecycleStarted = true;

  if (!acquireSingleInstanceLock()) {
    lifecycleStarted = false;
    return false;
  }

  installLifecycleListeners();

  try {
    await app.whenReady();
  } catch {
    lifecycleStarted = false;
    return false;
  }

  const startHidden = shouldStartHidden(process.argv);
  configureAutoLaunch(true);
  log.info(`[dks] starting main process (version=${getAppVersion()}, hidden=${String(startHidden)}, packaged=${String(app.isPackaged)})`);

  openLocalStore();
  notificationService = createNotificationService();
  updaterService = createUpdaterService({ enabled: Boolean(app.isPackaged) });
  updaterService.onStatus((state) => {
    sendToRenderer(UPDATER_STATUS_CHANNEL, state);
  });
  registerIpcHandlers();

  createMainWindow({ startHidden });
  tray = createDksTray();
  if (app.isPackaged) {
    updaterScheduler = createUpdaterScheduler(updaterService);
    void updaterScheduler.start();
  }

  return true;
}

void startMainProcess().catch((error) => {
  log.error('[dks] main process failed to start', error);
});
