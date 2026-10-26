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
