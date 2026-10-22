import { spawnSync } from 'node:child_process';
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

/**
 * R7 follow-up: the first repair implementation called
 * `electron-builder install-app-deps --config electron-builder.yml`, which the
 * sub-command rejects with "Unknown argument: config". The repair then blamed
 * missing Windows build tools. These tests lock the real command line, checked
 * against the installed CLI rather than against assumptions.
 */
describe('native module repair step (R7 follow-up)', () => {
  it('calls install-app-deps with no unsupported flags', async () => {
    const { installAppDepsCommand } = await import('../scripts/verify-native-modules.mjs');
    const spec = installAppDepsCommand();

    expect(spec.available).toBe(true);
    expect(spec.command).toBe(process.execPath);
    const subcommandIndex = spec.args.indexOf('install-app-deps');
    expect(subcommandIndex).toBeGreaterThan(-1);
    expect(spec.args[subcommandIndex - 1]).toContain('electron-builder');
    // install-app-deps only defines --platform/--arch and reads
    // electron-builder.yml from the project itself: no --config.
    expect(spec.args.slice(subcommandIndex + 1)).toEqual([]);
    expect(spec.args).not.toContain('--config');
  });

  it('falls back to @electron/rebuild with flags the installed CLI documents', async () => {
    const { electronRebuildCommand } = await import('../scripts/verify-native-modules.mjs');
    const spec = electronRebuildCommand();

    expect(spec.available).toBe(true);
    const help = spawnSync(process.execPath, [spec.args[0], '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    const documented = new Set(
      [...(help.stdout ?? '').matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]),
    );
    expect(documented.size).toBeGreaterThan(5);

    for (const flag of spec.args.filter((arg) => arg.startsWith('--'))) {
      expect(documented.has(flag), `${flag} is not documented by @electron/rebuild --help`).toBe(true);
    }
    // Force a rebuild of exactly one module; no source build unless asked.
    expect(spec.args).toEqual(expect.arrayContaining(['--force', '--which-module', 'better-sqlite3']));
    expect(spec.args).not.toContain('--config');
    expect(electronRebuildCommand({ buildFromSource: true }).args).toContain('--build-from-source');
  });

  it('truncates captured child output instead of dumping Electron internals', async () => {
    const { lastLines } = await import('../scripts/verify-native-modules.mjs');
    const noisy = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');

    const lines = lastLines(noisy);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('line 180');
    expect(lines.at(-1)).toBe('line 199');
    // One pathological minified line cannot flood the terminal either.
    expect(lastLines('x'.repeat(5_000), 1)[0].length).toBeLessThanOrEqual(300);
    expect(lastLines(undefined)).toEqual([]);
  });

  it('only blames the toolchain when the rebuild reported a compiler error', async () => {
    const { looksLikeToolchainError, looksLikeNetworkError } = await import(
      '../scripts/verify-native-modules.mjs'
    );

    expect(looksLikeToolchainError('gyp ERR! stack Error: Could not find any Visual Studio installation')).toBe(true);
    expect(looksLikeToolchainError('error MSB8020: The build tools for v143 cannot be found')).toBe(true);
    expect(looksLikeToolchainError('Unknown argument: config')).toBe(false);
    expect(looksLikeToolchainError('NODE_MODULE_VERSION 137')).toBe(false);
    expect(looksLikeToolchainError('')).toBe(false);
    // The sandbox rebuild failed with a network error inside node-gyp; that must
    // not be reported as "install Visual Studio".
    expect(looksLikeToolchainError('node-gyp failed to rebuild better-sqlite3')).toBe(false);
    expect(looksLikeNetworkError('code: ECONNRESET host: www.electronjs.org')).toBe(true);
    expect(looksLikeNetworkError('gyp ERR! stack Error: Could not find any Visual Studio installation')).toBe(false);
  });

  it('summarises the real error line instead of stack frames', async () => {
    const { summarizeFailure } = await import('../scripts/verify-native-modules.mjs');
    const stderr = [
      '/home/user/dks/[eval]-wrapper:6',
      'throw err;',
      '^',
      "Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137.",
      '    at Module._extensions..node (node:internal/modules/cjs/loader:1454:18)',
      '    at Module.load (node:internal/modules/cjs/loader:1148:32)',
    ].join('\n');

    const summary = summarizeFailure(stderr);
    expect(summary[0]).toContain('NODE_MODULE_VERSION 137');
    expect(summary.length).toBeLessThanOrEqual(3);
    expect(summary.join(' ')).not.toContain('[eval]-wrapper');
    expect(summary.join(' ')).not.toContain('throw err');
  });

  it('probes the package entry point, which a correct build must satisfy', async () => {
    const { probeNativeModule } = await import('../scripts/verify-native-modules.mjs');
    // Requires `better-sqlite3` (not the raw .node, which is not a constructor)
    // with the current Node: this is the exact false-negative that made the
    // first guard report a healthy build as broken.
    const result = probeNativeModule(process.execPath, resolve(ROOT, 'node_modules/better-sqlite3'));
    expect(result.detail).not.toContain('is not a constructor');
    expect(result.ok, result.detail).toBe(true);
    expect(result.abi).toBe(process.versions.modules);
  });

  it('keeps the repair itself free of unsupported flags and inherited stdio', () => {
    const source = readNormalised('scripts/verify-native-modules.mjs');

    // `--config` may only appear in the explanatory comments (backticks).
    expect(source).not.toMatch(/['"]--config['"]/);
    expect(source).not.toContain("stdio: 'inherit'");
    // Every repair attempt is followed by a fresh probe.
    expect((source.match(/probeOrMissing\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('maxBuffer');
  });
});
