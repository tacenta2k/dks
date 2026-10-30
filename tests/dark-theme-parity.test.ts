import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..', 'src');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === 'node_modules' ? [] : cssFiles(full);
    }
    return full.endsWith('.css') ? [full] : [];
  });
}

const files = cssFiles(SRC);

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  expect(index, `missing CSS rule ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/**
 * R3 batch E — dark theme parity. Every panel, popover and dialog paints from
 * the theme tokens, so switching to dark cannot leave a white card behind.
 */
describe('dark theme parity (R3 batch E)', () => {
  it('has no hard-coded white/light panel backgrounds anywhere in the CSS', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, 'utf8')
        // Token definitions are the legitimate place for literal colours.
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => !/^\s*--[a-z-]+:\s*#/.test(line));
      for (const { line, index } of css) {
        const match = /background(?:-color)?:\s*(.+);/.exec(line);
        if (!match) {
          continue;
        }
        const value = match[1].trim();
        if (/^(#fff|#ffffff|white|rgb\(\s*255)/i.test(value)) {
          offenders.push(`${file.replace(SRC, 'src')}:${index + 1} ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('paints the sheet, popovers, dialogs and admin pages from theme tokens', () => {
    const sheet = readFileSync(join(SRC, 'features/sheet/sheet.css'), 'utf8');
    const shell = readFileSync(join(SRC, 'renderer/styles.css'), 'utf8');
    const admin = readFileSync(join(SRC, 'features/admin/admin.css'), 'utf8');
    const settings = readFileSync(join(SRC, 'features/settings/settings.css'), 'utf8');

    for (const [css, selector] of [
      [admin, '.admin-dialog {'],
      [shell, '.confirm-dialog {'],
      [shell, '.topbar-update {'],
      [shell, '.notification-bell__panel'],
      [sheet, '.sheet-more-filters__menu'],
    ] as const) {
      expect(ruleBody(css, selector)).toMatch(/background[^;]*var\(--color-surface/);
    }

    expect(ruleBody(shell, '.topbar-avatar__popup')).toMatch(/background[^;]*var\(--color-surface/);
    expect(settings).toContain(":root[data-theme='dark']");
    expect(sheet).toContain(":root[data-theme='dark']");
    // The AG Grid dark surface is themed, not left at the quartz default.
    expect(sheet).toContain('.sheet-grid.ag-theme-quartz-dark');
  });

  it('keeps the dark palette distinct from the light one', () => {
    const shell = readFileSync(join(SRC, 'renderer/styles.css'), 'utf8');
    const lightBlock = shell.slice(shell.indexOf(':root {'), shell.indexOf(":root[data-theme='dark']"));
    const darkBlock = shell.slice(shell.indexOf(":root[data-theme='dark']"), shell.indexOf('* {'));
    for (const token of ['--color-background', '--color-surface', '--color-surface-raised', '--color-text']) {
      expect(lightBlock).toContain(`${token}:`);
      expect(darkBlock).toContain(`${token}:`);
    }
    expect(darkBlock).not.toContain('--color-surface: #ffffff');
  });

  it('uses an AMOLED pure-black neutral hierarchy in dark mode while leaving light mode unchanged', () => {
    const shell = readFileSync(join(SRC, 'renderer/styles.css'), 'utf8');
    const sheet = readFileSync(join(SRC, 'features/sheet/sheet.css'), 'utf8');
    const lightBlock = shell.slice(shell.indexOf(':root {'), shell.indexOf(":root[data-theme='dark']"));
    const darkBlock = shell.slice(shell.indexOf(":root[data-theme='dark']"), shell.indexOf('* {'));

    // Light mode tokens stay completely untouched.
    expect(lightBlock).toContain('--color-background: #f5f7fb;');
    expect(lightBlock).toContain('--color-surface: #ffffff;');
    expect(lightBlock).toContain('--color-text: #162033;');
    expect(lightBlock).toContain('--color-primary: #4c5ee8;');

    // Dark mode uses pure black ground + neutral near-black tone steps (zero navy/indigo surfaces).
    expect(darkBlock).toContain('--color-background: #000000;');
    expect(darkBlock).toContain('--color-surface: #0a0a0a;');
    expect(darkBlock).toContain('--color-surface-muted: #141414;');
    expect(darkBlock).toContain('--color-surface-raised: #171717;');
    expect(darkBlock).toContain('--color-border: #222222;');
    expect(darkBlock).toContain('--color-border-strong: #3d3d3d;');

    for (const legacyBlueDarkHex of ['#111623', '#171e2f', '#1d2639', '#222c40', '#2b3850', '#3b4a66', '#272e58']) {
      expect(darkBlock.toLowerCase()).not.toContain(legacyBlueDarkHex);
    }

    // Verify WCAG AA (>= 4.5:1) luminance contrast across all dark text/surface pairs.
    const channel = (hex: string, offset: number) => {
      const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) =>
      0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
    const contrast = (fg: string, bg: string) => {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    for (const surface of ['#000000', '#0a0a0a', '#141414', '#171717']) {
      for (const fg of ['#f5f5f5', '#b5b5b5', '#949494']) {
        expect(contrast(fg, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast('#0a0a0a', '#ededed')).toBeGreaterThanOrEqual(4.5);

    // Decorative radial gradients and button glows are stripped in dark mode,
    // and AG Grid Quartz dark popups/menus override Quartz's #182230 slate default.
    expect(shell).toContain(":root[data-theme='dark'] .login-page");
    expect(shell).toContain(":root[data-theme='dark'] .button--primary");
    expect(sheet).toMatch(/\.sheet-grid\.ag-theme-quartz-dark\s*\{[^}]*--ag-menu-background-color:\s*var\(--color-surface-raised\)/s);
  });
});

/**
 * R2-05 / R3 batch E — Windows toast attribution in the packaged build. The
 * AppUserModelId set at runtime must match the installed shortcut's appId,
 * otherwise Windows shows "Electron" instead of "DKS".
 */
describe('packaged Windows notification identity', () => {
  const root = resolve(__dirname, '..');
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const identity = readFileSync(join(root, 'electron/main/index.ts'), 'utf8');

  it('ships as DKS with a start-menu shortcut naming the same identity', () => {
    expect(builder).toMatch(/^productName:\s*DKS$/m);
    expect(builder).toMatch(/^appId:\s*com\.dks\.tracker$/m);
    expect(builder).toMatch(/shortcutName:\s*DKS/);
  });

  it('sets that same id and display name before any window or notification', () => {
    expect(identity).toContain("APP_USER_MODEL_ID = 'com.dks.tracker'");
    expect(identity).toContain("APP_DISPLAY_NAME = 'DKS'");
    expect(identity).toContain('app.setAppUserModelId(APP_USER_MODEL_ID)');
    // Applied at module load, i.e. before `whenReady` creates the window.
    const callIndex = identity.indexOf('configureAppIdentity();');
    const readyIndex = identity.indexOf('await app.whenReady');
    expect(callIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(callIndex);
  });
});
