'use strict';

/**
 * R7 — final packaging gate.
 *
 * `scripts/verify-native-modules.mjs` checks the source tree before
 * electron-builder runs. This hook checks the artefact that is actually about
 * to be wrapped in an installer: the `better_sqlite3.node` inside
 * `resources/app.asar.unpacked`, loaded by the packaged Electron executable.
 *
 * If the binding is missing, not unpacked, or built for another ABI, the dist
 * fails here — a wrong-ABI installer can no longer be produced.
 */

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const MODULE_NAME = 'better-sqlite3';

// Require the package directory (what the app loads), not the raw .node file:
// the addon exports `{ Database, Statement, … }` and is not a constructor.
const PROBE_SCRIPT = `
const Database = require(process.env.DKS_NATIVE_MODULE_DIR);
const db = new Database(':memory:');
const row = db.prepare('select 1 as ok').get();
if (!row || row.ok !== 1) {
  throw new Error('unexpected result from the SQLite probe query');
}
db.close();
process.stdout.write('DKS_ABI=' + process.versions.modules + '\\n');
`;

function packagedExecutable(context) {
  const { appOutDir, electronPlatformName } = context;
  const productFilename = context.packager?.appInfo?.productFilename
    ?? context.packager?.appInfo?.productName
    ?? 'DKS';
  const candidates = electronPlatformName === 'darwin'
    ? [path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)]
    : electronPlatformName === 'win32'
      ? [path.join(appOutDir, `${productFilename}.exe`)]
      : [path.join(appOutDir, productFilename)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function probe(electron, target) {
  const result = spawnSync(electron, ['-e', PROBE_SCRIPT], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      DKS_NATIVE_MODULE_DIR: target,
    },
    encoding: 'utf8',
  });
  const stderr = result.stderr ?? '';
  const stdout = result.stdout ?? '';
  return {
    ok: result.status === 0,
    abi: /DKS_ABI=(\d+)/.exec(stdout)?.[1] ?? null,
    detail: (stderr || stdout || `exit code ${String(result.status)}`).trim(),
  };
}

module.exports = async function verifyPackagedNativeModules(context) {
  const { appOutDir } = context;
  const unpackedModule = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    MODULE_NAME,
  );
  const binary = path.join(unpackedModule, 'build', 'Release', 'better_sqlite3.node');

  if (!existsSync(unpackedModule)) {
    throw new Error(
      `[dks] ${MODULE_NAME} was not unpacked into resources/app.asar.unpacked — `
      + 'check asarUnpack in electron-builder.yml.',
    );
  }

  if (!existsSync(binary)) {
    throw new Error(
      `[dks] the packaged native binding is missing: ${path.relative(appOutDir, binary)} — `
      + 'the app would start without a local database.',
    );
  }

  const electron = packagedExecutable(context);
  if (!electron) {
    throw new Error(
      `[dks] cannot find the packaged Electron executable in ${appOutDir}; `
      + 'the native module ABI cannot be verified.',
    );
  }

  const result = probe(electron, unpackedModule);
  if (!result.ok) {
    throw new Error(
      `[dks] the packaged ${MODULE_NAME} binding cannot be loaded by the packaged Electron `
      + `(module ABI ${result.abi ?? 'unknown'}, Electron ${process.versions.electron ?? 'unknown'}): `
      + `${result.detail}\n`
      + '[dks] Refusing to build an installer that would show "No handler registered for '
      + "'dks:local:get-snapshot'\". Re-run `npm run dist` (it rebuilds the module for Electron).",
    );
  }

  console.log(`[dks] packaged ${MODULE_NAME} loads under Electron (module ABI ${result.abi ?? 'unknown'})`);
};
