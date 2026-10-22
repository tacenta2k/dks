import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const DEV_MODULES = resolve(ROOT, 'node_modules');

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
    // R7b: module resolution is anchored at app.asar, never at app.asar.unpacked
    // (bindings lives inside the asar), and the child process gets a clean env.
    expect(post).toContain("'app.asar', 'package.json'");
    expect(post).toContain("'lib', 'app-asar-probe.cjs'");
    expect(post).toContain('delete env.NODE_PATH');
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
    const { installAppDepsCommand } = await import('../scripts/lib/native-guard.mjs');
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
    const { electronRebuildCommand } = await import('../scripts/lib/native-guard.mjs');
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
    const { lastLines } = await import('../scripts/lib/native-guard.mjs');
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
      '../scripts/lib/native-guard.mjs'
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
    const { summarizeFailure } = await import('../scripts/lib/native-guard.mjs');
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
    const { probeNativeModule } = await import('../scripts/lib/native-guard.mjs');
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

/**
 * R7b — packaged module resolution.
 *
 * The afterPack probe used to require `app.asar.unpacked/node_modules/
 * better-sqlite3` directly. `better-sqlite3` lazily requires `bindings` from
 * its `Database` constructor, and `bindings` is an ordinary production
 * dependency that lives inside `app.asar`, so the probe died with
 * `Cannot find module 'bindings'` on Windows. The probe now runs inside the
 * packaged Electron with `createRequire(<resources>/app.asar/package.json)`.
 *
 * These tests build the packaged layout on disk (app.asar = the archive the
 * Node resolver can read as a directory) and execute the real probe script.
 */
describe('packaged module resolution through app.asar (R7b)', () => {
  const PROBE = resolve(ROOT, 'scripts/lib/app-asar-probe.cjs');

  function copyBetterSqlite(target: string) {
    mkdirSync(join(target, 'lib'), { recursive: true });
    mkdirSync(join(target, 'build', 'Release'), { recursive: true });
    copyFileSync(
      join(DEV_MODULES, 'better-sqlite3', 'package.json'),
      join(target, 'package.json'),
    );
    cpSync(join(DEV_MODULES, 'better-sqlite3', 'lib'), join(target, 'lib'), { recursive: true });
    copyFileSync(
      join(DEV_MODULES, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      join(target, 'build', 'Release', 'better_sqlite3.node'),
    );
  }

  /** `resources/app.asar` + `resources/app.asar.unpacked`, as electron-builder lays it out. */
  function createPackagedLayout() {
    // A space in the path: Windows installs live under "Program Files", and the
    // probe passes this path to a child process.
    const root = mkdtempSync(join(tmpdir(), 'dks packaged app asar '));
    const resources = join(root, 'resources');
    const appAsar = join(resources, 'app.asar');
    const unpacked = join(resources, 'app.asar.unpacked');
    const asarModules = join(appAsar, 'node_modules');
    const unpackedModules = join(unpacked, 'node_modules');

    mkdirSync(asarModules, { recursive: true });
    mkdirSync(unpackedModules, { recursive: true });
    writeFileSync(
      join(appAsar, 'package.json'),
      JSON.stringify({ name: 'DKS', main: 'dist-electron/main/index.js' }),
    );
    // asarUnpack: the module is present in the archive and unpacked on disk.
    copyBetterSqlite(join(asarModules, 'better-sqlite3'));
    copyBetterSqlite(join(unpackedModules, 'better-sqlite3'));
    // Plain production dependencies stay inside the archive only.
    cpSync(join(DEV_MODULES, 'bindings'), join(asarModules, 'bindings'), { recursive: true });
    cpSync(
      join(DEV_MODULES, 'file-uri-to-path'),
      join(asarModules, 'file-uri-to-path'),
      { recursive: true },
    );

    return {
      root,
      appAsar,
      appPackageJson: join(appAsar, 'package.json'),
      unpackedModule: join(unpackedModules, 'better-sqlite3'),
    };
  }

  it('loads the package through app.asar and opens a real in-memory database', () => {
    const layout = createPackagedLayout();
    try {
      const result = spawnSync(process.execPath, [PROBE, layout.appPackageJson], {
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('DKS_OK=1');
      expect(result.stdout).toContain('DKS_ABI=');
      expect(result.stdout).toContain(
        `DKS_PACKAGE=${join(layout.appAsar, 'node_modules', 'better-sqlite3', 'lib', 'index.js')}`,
      );
      expect(result.stdout).toContain(
        `DKS_NATIVE=${join(layout.appAsar, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')}`,
      );
    } finally {
      rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('reproduces the old failure: app.asar.unpacked cannot resolve bindings', () => {
    const layout = createPackagedLayout();
    try {
      const script = 'const Database = require(process.argv[1]);'
        + ' const db = new Database(":memory:"); db.close();';
      const result = spawnSync(process.execPath, ['-e', script, layout.unpackedModule], {
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot find module 'bindings'");
    } finally {
      rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('refuses a package that resolves outside app.asar (dev checkout)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dks-dev-leak-'));
    try {
      const appAsar = join(root, 'resources', 'app.asar');
      mkdirSync(appAsar, { recursive: true });
      writeFileSync(join(appAsar, 'package.json'), JSON.stringify({ name: 'DKS' }));
      // Reachable by walking up from app.asar/package.json, but not part of it.
      copyBetterSqlite(join(root, 'node_modules', 'better-sqlite3'));

      const result = spawnSync(process.execPath, [PROBE, join(appAsar, 'package.json')], {
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('resolved outside app.asar');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the importable helper free of a shebang (CRLF/Vitest hazard)', () => {
    // Reproduced on a CRLF checkout: Vite's SSR transform mangles a `#!` first
    // line, so `await import(...)` threw "SyntaxError: Invalid or unexpected
    // token" for every test that imported the script. Without the shebang the
    // same CRLF file imports cleanly. Tests import the helper, never the CLI.
    const helper = readFileSync(resolve(ROOT, 'scripts/lib/native-guard.mjs'), 'utf8');
    expect(helper.startsWith('#!')).toBe(false);

    const cli = readFileSync(resolve(ROOT, 'scripts/verify-native-modules.mjs'), 'utf8');
    expect(cli.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(cli).toContain("from './lib/native-guard.mjs'");
    // The CLI must not re-implement helpers (single source of truth).
    expect(cli).not.toContain('function installAppDepsCommand');
    expect(cli).not.toContain('function looksLikeToolchainError');
  });
});
