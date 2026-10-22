/**
 * DKS app icon resolution (main process).
 *
 * The icon files are produced by `scripts/generate-icons.mjs` from the official
 * logo (`build/logo-source.png`):
 *
 *   build/icon.ico   256/48/32/16 px Windows icon (exe, installer, taskbar)
 *   build/icon.png   1024 px master
 *
 * electron-builder embeds `build/icon.ico` in the packaged executable and
 * copies `build/icon.png` next to it as an extra resource, so the packaged app
 * can hand the very same artwork to `BrowserWindow` and the tray. During
 * development the files are read straight from the repository `build/`.
 *
 * This module is intentionally pure (no `electron` import) so the resolution
 * rules can be unit tested; `electron/main/index.ts` turns the path into a
 * `nativeImage`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const APP_ICON_BASENAME = 'icon';

export type AppIconSource = 'packaged' | 'development' | 'missing';

export interface AppIconResolutionInput {
  isPackaged: boolean;
  /** `app.getAppPath()` — the repository root in development. */
  appPath: string;
  /** `process.resourcesPath` — where extraResources land when packaged. */
  resourcesPath: string;
  /** `process.platform`; Windows prefers the .ico, the others the .png. */
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  exists?: (candidate: string) => boolean;
}

export interface AppIconLocation {
  /** Absolute path to the best available icon file, or null. */
  path: string | null;
  source: AppIconSource;
  /** Every candidate that was tried, in order (support diagnostics). */
  candidates: string[];
}

const defaultExists = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * The path flavour that belongs to the *simulated* platform, not to the host
 * running the code.
 *
 * `path.join` follows `process.platform`, so a win32 resolution executed on
 * POSIX (unit tests, CI) used to produce mixed separators, and a POSIX
 * resolution executed on Windows produced `\\opt\\dks\\resources\\icon.png`.
 * Picking the implementation from the platform argument makes the result
 * deterministic everywhere.
 */
export function pathImplementationFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Resolution order:
 *   packaged    → <resources>/icon.ico, <resources>/icon.png
 *   development → <appPath>/build/icon.ico, <appPath>/build/icon.png
 * The extension order follows the platform: `.ico` first on Windows (crisp at
 * every taskbar size), `.png` first elsewhere.
 */
export function resolveAppIcon(input: AppIconResolutionInput): AppIconLocation {
  const exists = input.exists ?? defaultExists;
  const platform = input.platform ?? process.platform;
  const platformPath = pathImplementationFor(platform);
  const extensions = platform === 'win32' ? ['ico', 'png'] : ['png', 'ico'];
  const directory = input.isPackaged
    ? input.resourcesPath
    : platformPath.join(input.appPath, 'build');

  const candidates = extensions.map(
    (extension) => platformPath.join(directory, `${APP_ICON_BASENAME}.${extension}`),
  );
  const found = candidates.find((candidate) => exists(candidate));

  return {
    path: found ?? null,
    source: found ? (input.isPackaged ? 'packaged' : 'development') : 'missing',
    candidates,
  };
}
