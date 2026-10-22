'use strict';

/**
 * R7 — final packaging gate.
 *
 * `scripts/verify-native-modules.mjs` checks the source tree before
 * electron-builder runs. This hook checks the artefact that is actually about
 * to be wrapped in an installer: the packaged application itself.
 *
 * R7b: the probe no longer requires
 * `resources/app.asar.unpacked/node_modules/better-sqlite3` directly. That
 * failed on Windows with `Cannot find module 'bindings'` because `bindings` is
 * an ordinary production dependency inside `app.asar`, not part of the
 * unpacked native module. The child probe is now anchored at
 * `resources/app.asar/package.json` (see `scripts/lib/app-asar-probe.cjs`), so
 * Electron resolves the package exactly as the running app does and redirects
 * the unpacked `better_sqlite3.node` automatically.
 *
 * If the binding is missing, not unpacked, resolved outside the app or built
 * for another ABI, the dist fails here — a broken installer can no longer be
 * produced.
 */

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const MODULE_NAME = 'better-sqlite3';
const PROBE_SCRIPT = path.join(__dirname, 'lib', 'app-asar-probe.cjs');
const MAX_LINES = 20;

function lastLines(text, limit = MAX_LINES) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.length > 300 ? `${line.slice(0, 299)}…` : line))
    .slice(-limit);
}

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

/**
 * ELECTRON_RUN_AS_NODE is set for this child process only; the hook itself
 * keeps running as plain Node.
 */
function probe(electron, appOutDir, appAsarPackageJson) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };
  // Never let the build machine's environment inject a lookup path into the
  // packaged app's module resolution.
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;

  const result = spawnSync(electron, [PROBE_SCRIPT, appAsarPackageJson], {
    cwd: appOutDir,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const value = (key) => new RegExp(`${key}=([^\\n]*)`).exec(stdout)?.[1]?.trim() ?? null;

  return {
    ok: result.status === 0 && /DKS_OK=1/.test(stdout),
    status: result.status,
    electronVersion: value('DKS_ELECTRON'),
    abi: value('DKS_ABI'),
    packageEntry: value('DKS_PACKAGE'),
    nativePath: value('DKS_NATIVE'),
    appRoot: value('DKS_APP_ROOT'),
    output: `${stdout}\n${stderr}`,
  };
}

module.exports = async function verifyPackagedNativeModules(context) {
  const { appOutDir } = context;
  const resourcesDir = path.join(appOutDir, 'resources');
  const appAsarPackageJson = path.join(resourcesDir, 'app.asar', 'package.json');
  const unpackedModule = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', MODULE_NAME);
  const unpackedBinary = path.join(unpackedModule, 'build', 'Release', 'better_sqlite3.node');

  if (!existsSync(resourcesDir)) {
    throw new Error(`[dks] packaged resources directory is missing: ${resourcesDir}`);
  }

  if (!existsSync(appAsarPackageJson)) {
    throw new Error(
      `[dks] ${path.join('resources', 'app.asar', 'package.json')} is missing — `
      + 'asar must stay enabled so the app resolves its dependencies from app.asar.',
    );
  }

  if (!existsSync(unpackedModule)) {
    throw new Error(
      `[dks] ${MODULE_NAME} was not unpacked into resources/app.asar.unpacked — `
      + 'check asarUnpack in electron-builder.yml.',
    );
  }

  if (!existsSync(unpackedBinary)) {
    throw new Error(
      `[dks] the packaged native binding is missing: ${path.relative(appOutDir, unpackedBinary)} — `
      + 'the app would start without a local database.',
    );
  }

  const electron = packagedExecutable(context);
  if (!electron) {
    throw new Error(
      `[dks] cannot find the packaged Electron executable in ${appOutDir}; `
      + 'the native module cannot be verified.',
    );
  }

  const result = probe(electron, appOutDir, appAsarPackageJson);
  const diagnostics = [
    `electron=${result.electronVersion ?? 'unknown'}`,
    `module ABI=${result.abi ?? 'unknown'}`,
    `package=${result.packageEntry ?? 'unresolved'}`,
    `native=${result.nativePath ?? 'unresolved'}`,
  ].join(', ');

  if (!result.ok) {
    throw new Error(
      `[dks] the packaged ${MODULE_NAME} could not be loaded by the packaged Electron `
      + `(${diagnostics}, exit ${String(result.status)}):\n`
      + lastLines(result.output).map((line) => `[dks]   ${line}`).join('\n') + '\n'
      + '[dks] Refusing to build an installer with a broken local database. '
      + 'Re-run `npm run dist` (it rebuilds the module for Electron).',
    );
  }

  // The probe must have loaded the app's own copy, never the dev checkout and
  // never the bare unpacked directory (that is what broke `bindings`).
  const expectedDir = path.join(resourcesDir, 'app.asar', 'node_modules', MODULE_NAME);
  if (!result.packageEntry || !result.packageEntry.startsWith(expectedDir)) {
    throw new Error(
      `[dks] ${MODULE_NAME} resolved to ${result.packageEntry ?? 'nothing'}; expected it inside `
      + `${path.relative(appOutDir, expectedDir)} (dev-checkout or unpacked resolution is not acceptable).`,
    );
  }

  const devModuleDir = path.join(__dirname, '..', 'node_modules', MODULE_NAME);
  if (result.packageEntry.startsWith(devModuleDir)) {
    throw new Error(`[dks] the probe loaded the development checkout (${result.packageEntry}).`);
  }

  const expectedNative = path.join(expectedDir, 'build', 'Release', 'better_sqlite3.node');
  if (result.nativePath !== expectedNative) {
    throw new Error(
      `[dks] the probe expected the unpacked binding at ${expectedNative} but saw `
      + `${result.nativePath ?? 'nothing'}.`,
    );
  }

  console.log(
    `[dks] packaged ${MODULE_NAME} loads under Electron `
    + `(module ABI ${result.abi ?? 'unknown'}, Electron ${result.electronVersion ?? 'unknown'}) `
    + `from ${path.relative(appOutDir, result.packageEntry)}`,
  );
};
