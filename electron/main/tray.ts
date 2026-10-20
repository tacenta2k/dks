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
}

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
  const tooltip = options.tooltip ?? 'DKS';

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
