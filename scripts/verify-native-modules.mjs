#!/usr/bin/env node
/**
 * R7 — `npm run dist` must never package a native module that Electron cannot
 * load.
 *
 * The broken Windows installer shipped a `better_sqlite3.node` built for the
 * host Node ABI (137) instead of the Electron 34 ABI (132), because a stray
 * `npm rebuild better-sqlite3` had left a Node-ABI binary in the tree and the
 * electron-builder rebuild step had nothing to do.
 *
 * This script loads the module with the project's own Electron binary in
 * ELECTRON_RUN_AS_NODE mode — the exact runtime the packaged app uses. If the
 * load fails, it deletes the stale `build/` output and rebuilds the module for
 * Electron (`electron-builder install-app-deps`), then re-checks. If the
 * binary still cannot be loaded the dist is aborted with actionable output.
 *
 * `scripts/after-pack.cjs` repeats the check against the packaged
 * `app.asar.unpacked` copy, so even a broken electron-builder hook cannot ship
 * a wrong-ABI binary.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

const MODULE_NAME = 'better-sqlite3';
const moduleDir = path.join(projectRoot, 'node_modules', MODULE_NAME);
const binaryPath = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');

/**
 * Runs inside the Electron binary (ELECTRON_RUN_AS_NODE=1): requiring the
 * binding is the only reliable ABI assertion — Node refuses to dlopen a module
 * built for another `NODE_MODULE_VERSION`.
 */
const PROBE_SCRIPT = `
const target = process.env.DKS_NATIVE_MODULE;
const Database = require(target);
const db = new Database(':memory:');
const row = db.prepare('select 1 as ok').get();
if (!row || row.ok !== 1) {
  throw new Error('unexpected result from the SQLite probe query');
}
db.close();
process.stdout.write('DKS_ABI=' + process.versions.modules + '\\n');
process.stdout.write('DKS_ELECTRON=' + process.versions.electron + '\\n');
`;

function fail(lines) {
  console.error('\n[dks] NATIVE MODULE CHECK FAILED\n');
  for (const line of lines) {
    console.error(`[dks] ${line}`);
  }
  console.error('');
  process.exit(1);
}

function electronExecutable() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // reported by the caller
  }
  return null;
}

function probeTarget(electron, target) {
  const result = spawnSync(electron, ['-e', PROBE_SCRIPT], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      DKS_NATIVE_MODULE: target,
    },
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const abi = /DKS_ABI=(\d+)/.exec(stdout)?.[1] ?? null;
  return {
    ok: result.status === 0,
    abi,
    detail: (stderr || stdout || `exit code ${String(result.status)}`).trim(),
  };
}

function rebuildForElectron() {
  const cli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
  if (!existsSync(cli)) {
    fail([
      'electron-builder is not installed, so the native module cannot be rebuilt.',
      'Run `npm install` and try again.',
    ]);
  }
  console.log(`[dks] removing stale native build output: ${path.relative(projectRoot, path.join(moduleDir, 'build'))}`);
  rmSync(path.join(moduleDir, 'build'), { recursive: true, force: true });

  console.log('[dks] rebuilding native modules for Electron (electron-builder install-app-deps)…');
  const result = spawnSync(
    process.execPath,
    [cli, 'install-app-deps', '--config', 'electron-builder.yml'],
    { cwd: projectRoot, stdio: 'inherit', env: process.env },
  );
  if (result.status !== 0) {
    fail([
      'Rebuilding better-sqlite3 for Electron failed.',
      'Install the Windows build tools and re-run the dist:',
      '  npm install --global windows-build-tools   (or install "Desktop development with C++")',
      '  npm run dist',
    ]);
  }
}

function main() {
  if (!existsSync(moduleDir)) {
    fail([
      `${MODULE_NAME} is not installed in node_modules.`,
      'Run `npm install` and try again.',
    ]);
  }

  const electron = electronExecutable();
  if (!electron) {
    fail([
      'The Electron binary is missing from node_modules/electron.',
      'Run `npm install` (or reinstall Electron) and try again.',
    ]);
  }

  console.log(`[dks] checking ${MODULE_NAME} against ${path.relative(projectRoot, electron)}`);

  let result = existsSync(binaryPath)
    ? probeTarget(electron, binaryPath)
    : { ok: false, abi: null, detail: `${path.relative(projectRoot, binaryPath)} does not exist` };

  if (!result.ok) {
    console.warn(`[dks] ${MODULE_NAME} cannot be loaded by Electron: ${result.detail}`);
    rebuildForElectron();

    result = existsSync(binaryPath)
      ? probeTarget(electron, binaryPath)
      : { ok: false, abi: null, detail: `${path.relative(projectRoot, binaryPath)} is still missing` };

    if (!result.ok) {
      fail([
        `${MODULE_NAME} still cannot be loaded by Electron after a rebuild.`,
        result.detail,
        'Delete node_modules and run `npm install`, then `npm run dist` again.',
      ]);
    }
  }

  console.log(
    `[dks] ${MODULE_NAME} loads under Electron (module ABI ${result.abi ?? 'unknown'}) — safe to package`,
  );
}

main();
