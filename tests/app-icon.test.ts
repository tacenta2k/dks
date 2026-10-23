import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { pathImplementationFor, resolveAppIcon } from '../electron/main/icons';

const ROOT = resolve(__dirname, '..');
const ICO = resolve(ROOT, 'build/icon.ico');
const PNG = resolve(ROOT, 'build/icon.png');
const SOURCE = resolve(ROOT, 'build/logo-source.png');

/** Minimal ICO directory reader (the format is a 6-byte header + 16-byte entries). */
function readIcoFrames(buffer: Buffer) {
  expect(buffer.readUInt16LE(0)).toBe(0); // reserved
  expect(buffer.readUInt16LE(2)).toBe(1); // 1 = icon
  const count = buffer.readUInt16LE(4);
  const frames = [] as Array<{ size: number; bytes: number; offset: number; png: boolean }>;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const size = buffer[entry] === 0 ? 256 : buffer[entry];
    const bytes = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    const signature = buffer.subarray(offset, offset + 8).toString('hex');
    // png-to-ico writes Windows DIB frames (BITMAPINFOHEADER, 0x28); a PNG
    // payload would start with the PNG signature. Both are valid in an .ico.
    const png = signature === '89504e470d0a1a0a';
    const dib = buffer.readUInt32LE(offset) === 40;
    frames.push({ size, bytes, offset, png: png || dib });
  }
  return frames;
}

describe('app icon assets (R3 batch H)', () => {
  it('keeps the official logo as the committed source file', () => {
    expect(existsSync(SOURCE)).toBe(true);
    const header = readFileSync(SOURCE).subarray(0, 8).toString('hex');
    expect(header).toBe('89504e470d0a1a0a'); // real PNG, not a renamed file
    expect(statSync(SOURCE).size).toBeGreaterThan(10_000);
  });

  it('ships a Windows .ico with 256, 48, 32 and 16 px frames', () => {
    const frames = readIcoFrames(readFileSync(ICO));
    expect(frames.map((frame) => frame.size)).toEqual([16, 32, 48, 256]);
    for (const frame of frames) {
      // Every frame is a real bitmap payload inside the container.
      expect(frame.png, `frame ${frame.size} is not a readable image payload`).toBe(true);
      // Each offset/byte pair stays inside the file.
      expect(frame.offset + frame.bytes).toBeLessThanOrEqual(statSync(ICO).size);
    }
  });

  it('keeps a 1024px PNG master next to the .ico', () => {
    const png = readFileSync(PNG).subarray(0, 24);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // IHDR width/height are big-endian uint32 at offsets 16 and 20.
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });

  it('generates the renderer assets used by the sidebar, sign-in and About', () => {
    for (const asset of [
      'src/assets/dks-mark.png',
      'src/assets/dks-logo.png',
      'src/assets/dks-logo-dark.png',
    ]) {
      const file = resolve(ROOT, asset);
      expect(existsSync(file), `${asset} is missing — run npm run icons`).toBe(true);
      expect(readFileSync(file).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
  });
});

/**
 * CRLF-safe helpers.
 *
 * A Windows checkout hands us `\r\n`; the sandbox hands us `\n`. Tests must not
 * depend on which one they got, so every read normalises first and the YAML is
 * inspected structurally instead of with a multi-line regex.
 */
function readNormalised(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
}

function stripYamlValue(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim();
  return withoutComment.replace(/^(['"])(.*)\1$/, '$2');
}

/** `key: value` of one indented block (`win:`, `nsis:`, …). */
function yamlSection(source: string, section: string): Map<string, string> {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const values = new Map<string, string>();
  let inside = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const indented = /^\s/.test(line);
    if (!indented) {
      const key = line.split(':')[0].trim();
      inside = key === section;
      continue;
    }
    if (!inside) {
      continue;
    }
    const trimmed = line.trim();
    // Sequence entries (`- from: …`) belong to lists, not to this map.
    if (trimmed.startsWith('-')) {
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = stripYamlValue(trimmed.slice(separator + 1));
    if (!values.has(key)) {
      values.set(key, value);
    }
  }
  return values;
}

/** `key: value` of the document's top level. */
function yamlTopLevel(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const value = stripYamlValue(line.slice(separator + 1));
    if (value) {
      values.set(line.slice(0, separator).trim(), value);
    }
  }
  return values;
}

describe('electron-builder icon wiring (R3 batch H)', () => {
  const builder = readNormalised('electron-builder.yml');

  it('points the exe, installer and Add/Remove Programs at build/icon.ico', () => {
    const win = yamlSection(builder, 'win');
    expect(win.get('icon')).toBe('build/icon.ico');
    expect(win.get('executableName')).toBe('DKS');

    const nsis = yamlSection(builder, 'nsis');
    expect(nsis.get('installerIcon')).toBe('build/icon.ico');
    expect(nsis.get('uninstallerIcon')).toBe('build/icon.ico');
    expect(nsis.get('installerHeaderIcon')).toBe('build/icon.ico');
    expect(nsis.get('shortcutName')).toBe('DKS');
  });

  it('keeps the DKS identity and ships the PNG for the window icon', () => {
    const top = yamlTopLevel(builder);
    expect(top.get('productName')).toBe('DKS');
    expect(top.get('appId')).toBe('com.dks.tracker');
    expect(top.get('icon')).toBe('build/icon.png');
    expect(builder).toContain('from: build/icon.png');
    expect(builder).toContain('to: icon.png');
  });

  it('parses the same values from a CRLF checkout (Windows)', () => {
    // The failure this locks: a multi-line regex with `$` never matched a
    // Windows checkout because every line ended with `\r`.
    const crlf = builder.replace(/\n/g, '\r\n');
    expect(crlf).toContain('\r\n');
    expect(crlf).not.toBe(builder);

    expect(yamlTopLevel(crlf).get('productName')).toBe('DKS');
    expect(yamlTopLevel(crlf).get('appId')).toBe('com.dks.tracker');
    expect(yamlTopLevel(crlf).get('icon')).toBe('build/icon.png');
    expect(yamlSection(crlf, 'win').get('icon')).toBe('build/icon.ico');
    const nsis = yamlSection(crlf, 'nsis');
    expect(nsis.get('installerIcon')).toBe('build/icon.ico');
    expect(nsis.get('uninstallerIcon')).toBe('build/icon.ico');
    expect(nsis.get('installerHeaderIcon')).toBe('build/icon.ico');
  });

  it('loads the window icon through nativeImage in the main process', () => {
    const main = readNormalised('electron/main/index.ts');
    expect(main).toContain('nativeImage.createFromPath');
    expect(main).toContain('icon: windowIcon');
    expect(main).toContain('resolveAppIcon');
    // A missing file must not crash window creation.
    expect(main).toContain('image.isEmpty() ? undefined : image');
  });
});

describe('app icon resolution rules (R3 batch H)', () => {
  const winResources = 'C:\\Program Files\\DKS\\resources';
  const winAppPath = 'C:\\Program Files\\DKS\\resources\\app.asar';
  const posixResources = '/opt/dks/resources';
  const posixAppPath = '/opt/dks/resources/app.asar';

  it('uses the icon next to the packaged resources on Windows', () => {
    const location = resolveAppIcon({
      isPackaged: true,
      appPath: winAppPath,
      resourcesPath: winResources,
      platform: 'win32',
      exists: (candidate) => candidate.endsWith('icon.ico'),
    });
    // Expected value is built with the same path flavour as the simulated
    // platform, never with the host's `path.join`.
    expect(location.path).toBe(path.win32.join(winResources, 'icon.ico'));
    expect(location.source).toBe('packaged');
  });

  it('falls back to the png when the ico is unavailable', () => {
    const location = resolveAppIcon({
      isPackaged: true,
      appPath: posixAppPath,
      resourcesPath: posixResources,
      platform: 'linux',
      exists: (candidate) => candidate.endsWith('icon.png'),
    });
    expect(location.path).toBe(path.posix.join(posixResources, 'icon.png'));
    expect(location.source).toBe('packaged');
  });

  it('reads the repository build/ folder during development (Windows)', () => {
    const appPath = 'C:\\dev\\dks';
    const location = resolveAppIcon({
      isPackaged: false,
      appPath,
      resourcesPath: 'C:\\dev\\dks\\node_modules\\electron\\dist\\resources',
      platform: 'win32',
      exists: (candidate) => candidate.endsWith('icon.png'),
    });
    expect(location.path).toBe(path.win32.join(appPath, 'build', 'icon.png'));
    expect(location.source).toBe('development');
    expect(location.path).not.toContain('/');
  });

  it('reads the repository build/ folder during development (POSIX)', () => {
    const appPath = '/home/user/dks';
    const location = resolveAppIcon({
      isPackaged: false,
      appPath,
      resourcesPath: '/home/user/dks/node_modules/electron/dist/resources',
      platform: 'linux',
      exists: (candidate) => candidate.endsWith('icon.png'),
    });
    expect(location.path).toBe(path.posix.join(appPath, 'build', 'icon.png'));
    expect(location.source).toBe('development');
    expect(location.path).not.toContain('\\');
  });

  it('uses the simulated platform separators on any host', () => {
    // Regression: `path.join` follows process.platform, so a win32 case run on
    // POSIX produced mixed separators and a POSIX case run on Windows produced
    // "\opt\dks\resources\icon.png".
    const win = resolveAppIcon({
      isPackaged: true,
      appPath: winAppPath,
      resourcesPath: winResources,
      platform: 'win32',
      exists: () => true,
    });
    const posix = resolveAppIcon({
      isPackaged: true,
      appPath: posixAppPath,
      resourcesPath: posixResources,
      platform: 'darwin',
      exists: () => true,
    });

    expect(win.path).toBe(path.win32.join(winResources, 'icon.ico'));
    expect(win.path).not.toContain('/');
    expect(posix.path).toBe(path.posix.join(posixResources, 'icon.png'));
    expect(posix.path).not.toContain('\\');

    // The helper the resolver uses follows the simulated platform too.
    expect(pathImplementationFor('win32').join('C:\\a', 'b')).toBe('C:\\a\\b');
    expect(pathImplementationFor('linux').join('/a', 'b')).toBe('/a/b');
    expect(pathImplementationFor('darwin').join('/a', 'b')).toBe('/a/b');
  });

  it('prefers the .ico on Windows and the .png elsewhere', () => {
    const both = (candidate: string) => candidate !== '';
    const win = resolveAppIcon({
      isPackaged: true,
      appPath: winAppPath,
      resourcesPath: winResources,
      platform: 'win32',
      exists: both,
    });
    const linux = resolveAppIcon({
      isPackaged: true,
      appPath: posixAppPath,
      resourcesPath: posixResources,
      platform: 'linux',
      exists: both,
    });
    expect(win.candidates.map((candidate) => path.win32.extname(candidate))).toEqual(['.ico', '.png']);
    expect(linux.candidates.map((candidate) => path.posix.extname(candidate))).toEqual(['.png', '.ico']);
    expect(win.path).toBe(path.win32.join(winResources, 'icon.ico'));
    expect(linux.path).toBe(path.posix.join(posixResources, 'icon.png'));
  });

  it('reports a missing icon instead of inventing a path', () => {
    const location = resolveAppIcon({
      isPackaged: true,
      appPath: posixAppPath,
      resourcesPath: posixResources,
      platform: 'win32',
      exists: () => false,
    });
    expect(location.path).toBeNull();
    expect(location.source).toBe('missing');
    expect(location.candidates).toEqual([
      path.win32.join(posixResources, 'icon.ico'),
      path.win32.join(posixResources, 'icon.png'),
    ]);
  });
});

describe('app branding surfaces (R3 batch H + final logo polish)', () => {
  const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');

  it('shows the official full logo in the sidebar and on the sign-in card — never the cropped mark', () => {
    const shell = read('src/renderer/components/AppShell.tsx');
    expect(shell).toContain("import dksLogo from '../../assets/dks-logo.png'");
    expect(shell).toContain("import dksLogoDark from '../../assets/dks-logo-dark.png'");
    expect(shell).toContain('brand-mark--logo');
    expect(shell).toContain('brand-logo__img--on-light');
    expect(shell).toContain('brand-logo__img--on-dark');
    // Neither a generated "D" crop nor a letter tile powers the sidebar brand.
    expect(shell).not.toContain('dks-mark');
    expect(shell).not.toContain('<span>D</span>');

    const auth = read('src/features/auth/AuthScreen.tsx');
    expect(auth).toContain("import dksLogo from '../../assets/dks-logo.png'");
    expect(auth).toContain("import dksLogoDark from '../../assets/dks-logo-dark.png'");
    expect(auth).toContain('brand-logo--sign-in');
    expect(auth).toContain('brand-logo__img--on-light');
    expect(auth).toContain('brand-logo__img--on-dark');
    expect(auth).not.toContain('dks-mark');

    // Theme swap happens in CSS: dark mode uses the lightened variant, so the
    // lockup never sits on a white rectangular plate in either theme.
    const css = read('src/renderer/styles.css');
    expect(css).toContain(":root[data-theme='dark'] .brand-logo__img--on-light");
    expect(css).toContain(":root[data-theme='dark'] .brand-logo__img--on-dark");
    // Collapsed ~56px rail: the same artwork scaled with object-contain.
    expect(css).toContain(".sidebar[data-collapsed='true'] .brand-mark--logo");
  });

  it('uses the official logo in About, with a dark-mode variant', () => {
    const settings = read('src/features/settings/SettingsPage.tsx');
    expect(settings).toContain("import dksLogo from '../../assets/dks-logo.png'");
    expect(settings).toContain("import dksLogoDark from '../../assets/dks-logo-dark.png'");
    expect(settings).toContain('className="settings-about__logo settings-about__logo--on-light"');
    expect(settings).toContain('className="settings-about__logo settings-about__logo--on-dark"');

    const css = read('src/features/settings/settings.css');
    expect(css).toContain(":root[data-theme='dark'] .settings-about__logo--on-light");
    expect(css).toContain(":root[data-theme='dark'] .settings-about__logo--on-dark");
  });

  it('sets the window title icon in the document head too', () => {
    expect(read('index.html')).toContain('rel="icon"');
  });
});
