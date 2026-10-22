#!/usr/bin/env node
/**
 * R7 — `npm run dist` must never package a native module that Electron cannot
 * load.
 *
 * The broken Windows installer shipped a `better_sqlite3.node` built for the
 * host Node ABI (137) instead of the Electron ABI (132), because a stray
 * `npm rebuild better-sqlite3` had left a Node-ABI binary in the tree.
 *
 * This script loads the module with the project's own Electron binary in
 * ELECTRON_RUN_AS_NODE mode — the exact runtime the packaged app uses, and the
 * only reliable ABI assertion (Node refuses to dlopen a module built for a
 * different `NODE_MODULE_VERSION`).
 *
 * Repair order (nothing is deleted until a rebuild has been tried):
 *   1. `electron-builder install-app-deps` (no flags: the sub-command only
 *      accepts --platform/--arch and finds electron-builder.yml by itself).
 *   2. `@electron/rebuild --force --which-module better-sqlite3` directly.
 *   3. Only if the binary still mismatches: delete the stale build output and
 *      rebuild again.
 * After every step the probe is repeated; the dist only fails if the module
 * still cannot be loaded.
 *
 * `scripts/after-pack.cjs` repeats the check against the packaged
 * `app.asar.unpacked` copy, so even a broken rebuild hook cannot ship a
 * wrong-ABI binary.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// fileURLToPath(import.meta.url) rather than import.meta.dirname: the module is
// also imported by the unit tests, where the transform may not provide dirname.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(scriptDir, '..');
export const MODULE_NAME = 'better-sqlite3';
export const moduleDir = path.join(projectRoot, 'node_modules', MODULE_NAME);
export const binaryPath = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');

const OUTPUT_LINE_LIMIT = 20;
const OUTPUT_LINE_WIDTH = 300;

/** Last `limit` lines of mixed child output, capped per line. */
export function lastLines(text, limit = OUTPUT_LINE_LIMIT) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.length > OUTPUT_LINE_WIDTH
      ? `${line.slice(0, OUTPUT_LINE_WIDTH - 1)}…`
      : line));
  return lines.slice(-limit);
}

/**
 * A compiler/toolchain failure is the only case where the build-tools hint is
 * honest. A missing flag, a network error or a bad ABI must be reported as-is —
 * "node-gyp failed to rebuild" alone is a wrapper message, not a compiler
 * error (the sandbox run hit ECONNRESET and was wrongly blamed on MSVC).
 */
export function looksLikeToolchainError(text) {
  return /(MSBuild|error MSB\d+|cl\.exe|C1083|LNK\d{4}|vcbuild|Visual Studio|python is not set|Could not find any Visual Studio|make: \*\*\*|cc1plus|[^a-z]g\+\+:[^\n]*error)/i
    .test(String(text ?? ''));
}

/** The rebuild could not reach the header/prebuild host. */
export function looksLikeNetworkError(text) {
  return /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|getaddrinfo|network|proxy|self-signed certificate)/i
    .test(String(text ?? ''));
}

/** Absolute path of the project's Electron executable. */
export function electronExecutable() {
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

/** Electron version from node_modules (falling back to package.json). */
export function electronVersion() {
  try {
    const pkg = JSON.parse(readFileSync(
      path.join(projectRoot, 'node_modules', 'electron', 'package.json'),
      'utf8',
    ));
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // fall through
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const declared = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
    if (typeof declared === 'string' && declared.trim()) {
      return declared.replace(/^[^0-9]*/, '').trim();
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * `electron-builder install-app-deps` — no `--config`: the sub-command only
 * defines `--platform`/`--arch` (see electron-builder/out/cli/install-app-deps.js)
 * and reads `electron-builder.yml` from the project directory itself.
 * Passing `--config` aborts with "Unknown argument: config".
 */
export function installAppDepsCommand() {
  return {
    label: 'electron-builder install-app-deps',
    command: process.execPath,
    args: [path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js'), 'install-app-deps'],
    available: existsSync(path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js')),
  };
}

/**
 * `@electron/rebuild` directly. Verified against
 * `node_modules/@electron/rebuild/lib/cli.js --help`:
 *   --force (-f), --which-module (-w), --version (-v), --build-from-source.
 */
export function electronRebuildCommand({ buildFromSource = false } = {}) {
  const cli = path.join(projectRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  const version = electronVersion();
  const args = [cli, '--force', '--which-module', MODULE_NAME];
  if (version) {
    args.push('--version', version);
  }
  if (buildFromSource) {
    args.push('--build-from-source');
  }
  return {
    label: `@electron/rebuild (ABI for Electron ${version ?? 'unknown'})`,
    command: process.execPath,
    args,
    available: existsSync(cli),
  };
}

function printOutput(output) {
  for (const line of lastLines(output)) {
    console.error(`[dks]   ${line}`);
  }
}

function runCommand(spec) {
  if (!spec.available) {
    return { ok: false, output: `${spec.label} is not installed`, label: spec.label };
  }
  console.log(`[dks] ${spec.label}…`);
  const result = spawnSync(spec.command, spec.args, {
    cwd: projectRoot,
    env: { ...process.env, CI: process.env.CI ?? '1' },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    console.error(`[dks] ${spec.label} exited with ${String(result.status)}`);
    printOutput(output);
  }
  return { ok: result.status === 0, output, label: spec.label };
}

/**
 * Runs inside the Electron binary (ELECTRON_RUN_AS_NODE=1).
 *
 * It requires the **package directory**, not `build/Release/better_sqlite3.node`:
 * the raw addon exports `{ Database, Statement, … }` and is not a constructor,
 * and the package entry point is what the app actually loads (its own
 * `bindings` lookup then dlopens the .node, so the ABI check still applies).
 */
const PROBE_SCRIPT = `
const Database = require(process.env.DKS_NATIVE_MODULE_DIR);
const db = new Database(':memory:');
const row = db.prepare('select 1 as ok').get();
if (!row || row.ok !== 1) {
  throw new Error('unexpected result from the SQLite probe query');
}
db.close();
process.stdout.write('DKS_ABI=' + process.versions.modules + '\\n');
process.stdout.write('DKS_ELECTRON=' + process.versions.electron + '\\n');
`;

/**
 * The interesting line of a Node/Electron error, not the tail of its stack.
 * (A plain `lastLines` used to print only `at [eval]-wrapper:6:24 …` frames.)
 */
export function summarizeFailure(text, limit = 3) {
  const lines = lastLines(text, 400);
  const index = lines.findIndex((line) => (
    /^(Error|TypeError|RangeError|SyntaxError)\b/.test(line)
    || /NODE_MODULE_VERSION|was compiled against a different|Cannot find module|is not a constructor|does not exist/i.test(line)
  ));
  if (index >= 0) {
    return lines.slice(index, index + limit);
  }
  return lines.slice(-limit);
}

export function probeNativeModule(electron, target) {
  const result = spawnSync(electron, ['-e', PROBE_SCRIPT], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      DKS_NATIVE_MODULE_DIR: target,
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    ok: result.status === 0,
    abi: /DKS_ABI=(\d+)/.exec(stdout)?.[1] ?? null,
    detail: (stderr || stdout || `exit code ${String(result.status)}`).trim(),
  };
}

function fail(lines) {
  console.error('\n[dks] NATIVE MODULE CHECK FAILED\n');
  for (const line of lines) {
    console.error(`[dks] ${line}`);
  }
  console.error('');
  process.exit(1);
}

function probeOrMissing(electron) {
  if (!existsSync(binaryPath)) {
    return {
      ok: false,
      abi: null,
      detail: `${path.relative(projectRoot, binaryPath)} does not exist`,
    };
  }
  return probeNativeModule(electron, moduleDir);
}

function reportFailure(result) {
  return `[dks] ${MODULE_NAME} cannot be loaded by Electron: ${summarizeFailure(result.detail).join(' ')}`;
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

  let result = probeOrMissing(electron);
  const outputs = [];
  if (result.ok) {
    console.log(`[dks] ${MODULE_NAME} loads under Electron (module ABI ${result.abi ?? 'unknown'}) — safe to package`);
    return;
  }

  console.error(reportFailure(result));

  // 1. electron-builder's own rebuild (what `npm run dist` would run later).
  let attempt = runCommand(installAppDepsCommand());
  outputs.push(attempt.output);
  result = probeOrMissing(electron);

  // 2. Targeted @electron/rebuild (force: ignore any stale .forge-meta).
  if (!result.ok) {
    console.error(reportFailure(result));
    attempt = runCommand(electronRebuildCommand());
    outputs.push(attempt.output);
    result = probeOrMissing(electron);
  }

  // 3. Only now, with a mismatch still present after a rebuild, drop the stale
  //    build output (this is what defeats a correct `.forge-meta` left next to
  //    a Node-ABI binary) and rebuild again.
  if (!result.ok) {
    console.error(reportFailure(result));
    console.log(`[dks] deleting stale build output: ${path.relative(projectRoot, path.join(moduleDir, 'build'))}`);
    rmSync(path.join(moduleDir, 'build'), { recursive: true, force: true });
    attempt = runCommand(electronRebuildCommand());
    outputs.push(attempt.output);
    result = probeOrMissing(electron);
  }

  if (!result.ok) {
    const combined = outputs.join('\n');
    const lines = [
      `${MODULE_NAME} still cannot be loaded by Electron after a rebuild.`,
      ...summarizeFailure(result.detail),
    ];
    if (!attempt.ok) {
      lines.push(`The last repair command failed (${attempt.label}).`);
    }
    if (looksLikeToolchainError(combined)) {
      lines.push(
        'The rebuild reported a compiler/toolchain error. Install the Windows build tools',
        '("Desktop development with C++" in the Visual Studio Installer) and run `npm run dist` again.',
      );
    } else if (looksLikeNetworkError(combined)) {
      lines.push(
        'The rebuild could not download the Electron headers/prebuild. Check the network',
        '(or proxy) and run `npm run dist` again.',
      );
    } else {
      lines.push(
        'No compiler error was reported. Check the messages above, then delete node_modules',
        'and run `npm install` followed by `npm run dist`.',
      );
    }
    fail(lines);
  }

  console.log(
    `[dks] ${MODULE_NAME} loads under Electron (module ABI ${result.abi ?? 'unknown'}) — safe to package`,
  );
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}
