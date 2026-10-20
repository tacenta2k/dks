import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export interface TrayActions {
  open: () => void;
  dashboard: () => void;
  logout: () => void;
  exit: () => void;
}

export interface CreateTrayOptions {
  actions: TrayActions;
  iconPath?: string;
  tooltip?: string;
  urgentCount?: number;
}

export interface TrayStatus {
  urgentCount: number;
  urgent: boolean;
  tooltip: string;
}

export function normaliseUrgentCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/** Build the text-only status used by both the tray and tests. */
export function formatTrayTooltip(urgentCount: number, appName = 'DKS'): string {
  const count = normaliseUrgentCount(urgentCount);
  const name = typeof appName === 'string' ? appName.trim() || 'DKS' : 'DKS';
  if (count === 0) {
    return name;
  }
  return `${name} · ${count} urgent ${count === 1 ? 'expiry' : 'expiries'}`;
}

export function getTrayStatus(urgentCount: number, appName = 'DKS'): TrayStatus {
  const count = normaliseUrgentCount(urgentCount);
  return {
    urgentCount: count,
    urgent: count > 0,
    tooltip: formatTrayTooltip(count, appName),
  };
}

export const trayStatusFor = getTrayStatus;
export const tooltipForUrgentCount = formatTrayTooltip;
export const normalizeUrgentCount = normaliseUrgentCount;
export const trayTooltip = formatTrayTooltip;
export const urgentStatusFor = getTrayStatus;

function invokeSafely(action: () => void): () => void {
  return () => {
    try {
      action();
    } catch {
      // Tray callbacks are best effort and must not terminate the app.
    }
  };
}

/** Build the stable, user-facing tray menu used by DKS. */
export function buildTrayMenu(actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Open DKS',
      click: invokeSafely(actions.open),
    },
    {
      label: 'Dashboard',
      click: invokeSafely(actions.dashboard),
    },
    {
      label: 'Logout',
      click: invokeSafely(actions.logout),
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: invokeSafely(actions.exit),
    },
  ];
}

function createTrayImage(iconPath?: string): Electron.NativeImage {
  if (!iconPath) {
    return nativeImage.createEmpty();
  }

  try {
    return nativeImage.createFromPath(iconPath);
  } catch {
    return nativeImage.createEmpty();
  }
}

/** Create a tray icon without exposing Electron objects to the renderer. */
export function createTray(options: CreateTrayOptions): Tray {
  const tray = new Tray(createTrayImage(options.iconPath));
  const tooltip = options.tooltip ?? formatTrayTooltip(options.urgentCount ?? 0);

  try {
    tray.setToolTip(tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(options.actions)));
    tray.on('click', invokeSafely(options.actions.open));
    tray.on('double-click', invokeSafely(options.actions.open));
  } catch {
    // A tray is optional on some desktop environments. Keep the app usable.
  }

  return tray;
}

/** Apply a serializable urgent status without making tray updates throw. */
export function updateTrayStatus(
  tray: Pick<Tray, 'setToolTip'> | null | undefined,
  urgentCount: number,
  appName = 'DKS',
): TrayStatus {
  const status = getTrayStatus(urgentCount, appName);
  if (!tray) {
    return status;
  }

  try {
    tray.setToolTip(status.tooltip);
  } catch {
    // Tray support is optional on some Linux desktop environments.
  }
  return status;
}

export function destroyTray(tray: Tray | null | undefined): void {
  if (!tray) {
    return;
  }

  try {
    tray.destroy();
  } catch {
    // Shutdown should continue even if the shell has already removed the tray.
  }
}
