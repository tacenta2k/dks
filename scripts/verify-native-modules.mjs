#!/usr/bin/env node
/**
 * R7 — `npm run dist` must never package a native module that Electron cannot
 * load.
 *
 * The broken Windows installer shipped a `better_sqlite3.node` built for the
 * host Node ABI (137) instead of the Electron ABI (132), because a stray
 * `npm rebuild better-sqlite3` had left a Node-ABI binary in the tree.
 *
 * This CLI loads the module with the project's own Electron binary in
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
 * The importable helpers live in `scripts/lib/native-guard.mjs` (no shebang —
 * see the note there about the Windows CRLF/Vitest import failure). The
 * packaged artifact is checked separately by `scripts/after-pack.cjs`, which
 * loads better-sqlite3 through `resources/app.asar`.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  MODULE_NAME,
  binaryPath,
  electronExecutable,
  electronRebuildCommand,
  installAppDepsCommand,
  looksLikeNetworkError,
  looksLikeToolchainError,
  lastLines,
  moduleDir,
  probeNativeModule,
  projectRoot,
  summarizeFailure,
} from './lib/native-guard.mjs';
import { spawnSync } from 'node:child_process';

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

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main();
}
