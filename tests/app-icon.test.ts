import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAppIcon } from '../electron/main/icons';

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

describe('electron-builder icon wiring (R3 batch H)', () => {
  const builder = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8');

  it('points the exe, installer and Add/Remove Programs at build/icon.ico', () => {
    expect(builder).toMatch(/^win:\n(?:.*\n)*?\s+icon: build\/icon\.ico$/m);
    expect(builder).toContain('installerIcon: build/icon.ico');
    expect(builder).toContain('uninstallerIcon: build/icon.ico');
    expect(builder).toContain('installerHeaderIcon: build/icon.ico');
    expect(builder).toMatch(/^icon: build\/icon\.png$/m);
  });

  it('keeps the DKS identity and ships the PNG for the window icon', () => {
    expect(builder).toMatch(/^productName: DKS$/m);
    expect(builder).toMatch(/^appId: com\.dks\.tracker$/m);
    expect(builder).toContain('from: build/icon.png');
    expect(builder).toContain('to: icon.png');
  });

  it('loads the window icon through nativeImage in the main process', () => {
    const main = readFileSync(resolve(ROOT, 'electron/main/index.ts'), 'utf8');
    expect(main).toContain('nativeImage.createFromPath');
    expect(main).toContain('icon: windowIcon');
    expect(main).toContain('resolveAppIcon');
    // A missing file must not crash window creation.
    expect(main).toContain('image.isEmpty() ? undefined : image');
  });
});

describe('app icon resolution rules (R3 batch H)', () => {
  it('uses the icon next to the packaged resources', () => {
    const location = resolveAppIcon({
      isPackaged: true,
      appPath: 'C:\\Program Files\\DKS\\resources\\app.asar',
      resourcesPath: 'C:\\Program Files\\DKS\\resources',
      platform: 'win32',
      exists: (candidate) => candidate.endsWith('icon.ico'),
    });
    expect(location.path).toBe(join('C:\\Program Files\\DKS\\resources', 'icon.ico'));
    expect(location.source).toBe('packaged');
  });

  it('falls back to the png when the ico is unavailable', () => {
    const location = resolveAppIcon({
      isPackaged: true,
      appPath: '/opt/dks/resources/app.asar',
      resourcesPath: '/opt/dks/resources',
      platform: 'linux',
      exists: (candidate) => candidate.endsWith('icon.png'),
    });
    expect(location.path).toBe('/opt/dks/resources/icon.png');
    expect(location.source).toBe('packaged');
  });

  it('reads the repository build/ folder during development', () => {
    const location = resolveAppIcon({
      isPackaged: false,
      appPath: '/home/user/dks',
      resourcesPath: '/home/user/dks/node_modules/electron/dist/resources',
      platform: 'win32',
      exists: (candidate) => candidate.endsWith('icon.png'),
    });
    expect(location.path).toBe('/home/user/dks/build/icon.png');
    expect(location.source).toBe('development');
  });

  it('prefers the .ico on Windows and the .png elsewhere', () => {
    const both = (candidate: string) => candidate !== '';
    const win = resolveAppIcon({
      isPackaged: true,
      appPath: 'C:\\dks\\resources\\app.asar',
      resourcesPath: 'C:\\dks\\resources',
      platform: 'win32',
      exists: both,
    });
    const linux = resolveAppIcon({
      isPackaged: true,
      appPath: '/opt/dks/resources/app.asar',
      resourcesPath: '/opt/dks/resources',
      platform: 'linux',
      exists: both,
    });
    expect(win.path?.endsWith('.ico')).toBe(true);
    expect(linux.path?.endsWith('.png')).toBe(true);
  });

  it('reports a missing icon instead of inventing a path', () => {
    const location = resolveAppIcon({
      isPackaged: true,
      appPath: '/opt/dks/resources/app.asar',
      resourcesPath: '/opt/dks/resources',
      platform: 'win32',
      exists: () => false,
    });
    expect(location.path).toBeNull();
    expect(location.source).toBe('missing');
    expect(location.candidates).toHaveLength(2);
  });
});

describe('app branding surfaces (R3 batch H)', () => {
  const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');

  it('shows the real mark in the sidebar and on the sign-in card', () => {
    const shell = read('src/renderer/components/AppShell.tsx');
    expect(shell).toContain("import dksMark from '../../assets/dks-mark.png'");
    expect(shell).toContain('brand-mark--image');
    expect(shell).toContain('<img src={dksMark}');
    // The old letter tile is gone.
    expect(shell).not.toContain('<span>D</span>');

    const auth = read('src/features/auth/AuthScreen.tsx');
    expect(auth).toContain("import dksMark from '../../assets/dks-mark.png'");
    expect(auth).toContain('brand-mark--image');
    expect(auth).toContain('<img src={dksMark}');
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
