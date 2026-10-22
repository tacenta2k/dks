import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * R7 — the packaged Windows app shipped a `better_sqlite3.node` built for the
 * host Node ABI (137) instead of the Electron ABI (132), so every
 * `dks:local:*` channel was missing at runtime.
 *
 * These assertions lock the packaging contract in place:
 *   - electron-builder keeps the asar and unpacks better-sqlite3 (a .node file
 *     inside an asar is not loadable);
 *   - `npm run dist` runs the Electron-ABI check *before* electron-builder;
 *   - electron-builder runs the afterPack check against the packaged copy.
 */

const ROOT = resolve(__dirname, '..');

/** CRLF-safe read: a Windows checkout must not change the result. */
function readNormalised(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
}

function stripYamlValue(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim();
  return withoutComment.replace(/^(['"])(.*)\1$/, '$2');
}

/** Top-level `key: value` pairs. */
function yamlTopLevel(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of source.split('\n')) {
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

/** The `- item` entries of one top-level list (`files:`, `asarUnpack:`). */
function yamlList(source: string, key: string): string[] {
  const items: string[] = [];
  let inside = false;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) {
      continue;
    }
    const indented = /^\s/.test(line);
    if (!indented) {
      inside = line.split(':')[0].trim() === key;
      continue;
    }
    if (!inside) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('-')) {
      const value = stripYamlValue(trimmed.slice(1));
      if (value) {
        items.push(value);
      }
    }
  }
  return items;
}

describe('packaged native modules (R7)', () => {
  const builder = readNormalised('electron-builder.yml');
  const top = yamlTopLevel(builder);
  const pkg = JSON.parse(readNormalised('package.json')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('treats better-sqlite3 as a shipped production dependency', () => {
    // It is a runtime dependency of the main process, not a dev tool.
    expect(pkg.dependencies['better-sqlite3']).toBeTruthy();
    expect(pkg.devDependencies['better-sqlite3']).toBeUndefined();
    // The main process really loads it, so "shipped" is not a theoretical claim.
    expect(readNormalised('electron/main/sqlite.ts')).toContain("from 'better-sqlite3'");
  });

  it('keeps the asar and unpacks the whole better-sqlite3 module', () => {
    expect(top.get('asar')).toBe('true');
    const unpacked = yamlList(builder, 'asarUnpack');
    expect(unpacked).toContain('node_modules/better-sqlite3/**');
    // Every unpacked entry must still be a directory glob (a single file would
    // miss build/Release/better_sqlite3.node).
    for (const entry of unpacked) {
      expect(entry.endsWith('/**'), `${entry} does not cover the module tree`).toBe(true);
    }
  });

  it('ships the built main/renderer output and the package manifest', () => {
    const files = yamlList(builder, 'files');
    expect(files).toContain('dist-electron/**');
    expect(files).toContain('package.json');
  });

  it('never turns the Electron rebuild off', () => {
    expect(top.get('npmRebuild')).toBe('true');
    // Compiling from source always is intentionally not enabled (it needs MSVC
    // even when a valid Electron prebuild exists); the hooks do the work.
    expect(top.get('buildDependenciesFromSource')).toBe('false');
  });

  it('verifies the ABI before packaging and again after packaging', () => {
    const dist = pkg.scripts.dist;
    const verifyIndex = dist.indexOf('npm run verify:native');
    const builderIndex = dist.indexOf('electron-builder');
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(builderIndex).toBeGreaterThan(verifyIndex);
    // `npm run build` still happens first: the hook verifies a built tree.
    expect(dist.indexOf('npm run build')).toBeLessThan(verifyIndex);
    expect(pkg.scripts.release).toContain('npm run verify:native');

    expect(pkg.scripts['verify:native']).toBe('node scripts/verify-native-modules.mjs');
    expect(existsSync(resolve(ROOT, 'scripts/verify-native-modules.mjs'))).toBe(true);

    expect(top.get('afterPack')).toBe('scripts/after-pack.cjs');
    expect(existsSync(resolve(ROOT, 'scripts/after-pack.cjs'))).toBe(true);
  });

  it('makes a stray Node-ABI rebuild impossible to package', () => {
    const pre = readNormalised('scripts/verify-native-modules.mjs');
    // Loads the module with the project's Electron binary — the only reliable
    // ABI assertion — and rebuilds when that fails.
    expect(pre).toContain('ELECTRON_RUN_AS_NODE');
    expect(pre).toContain('install-app-deps');
    expect(pre).toContain("rmSync(path.join(moduleDir, 'build')");
    expect(pre).toContain('process.exit(1)');

    const post = readNormalised('scripts/after-pack.cjs');
    // Checks the artefact that actually ends up in the installer.
    expect(post).toContain("'app.asar.unpacked'");
    expect(post).toContain('better_sqlite3.node');
    expect(post).toContain('ELECTRON_RUN_AS_NODE');
    expect(post).toContain('throw new Error');
  });
});
