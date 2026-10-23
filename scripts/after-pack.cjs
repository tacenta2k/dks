'use strict';

/**
 * R8 — final packaging gate.
 *
 * `scripts/verify-native-modules.mjs` checks the source tree before
 * electron-builder runs. This hook checks the artefact that is actually about
 * to be wrapped in an installer: the packaged application itself, as electron-
 * builder really lays it out on Windows —
 *
 *   resources/app.asar              one 127 MB archive FILE (not a folder)
 *   resources/app.asar.unpacked/    the unpacked native modules
 *   resources/icon.png              the app icon
 *
 * The confirmed Windows failure: an earlier revision ran
 * `existsSync(resources/app.asar/package.json)` in plain Node. `app.asar` is a
 * single archive file, so that can never be true and `npm run dist` always
 * died here. Plain Node therefore only ever checks the archive *file* and its
 * header listing (`@electron/asar`, same library electron-builder packs with).
 * Everything *inside* the archive is verified by the child probe
 * (`scripts/lib/app-asar-probe.cjs`) executed by the packaged Electron with
 * `ELECTRON_RUN_AS_NODE=1`, whose fs and module loader are ASAR-aware — the
 * same resolution the real app performs:
 *
 *   - better-sqlite3's entry point and its JS production dependencies
 *     (`bindings`, `file-uri-to-path`) must resolve from inside `app.asar`;
 *   - the ABI-matched native binding must exist in `app.asar.unpacked`
 *     (checked on disk here, and re-checked through Electron's redirect there);
 *   - requiring better-sqlite3 must open an in-memory DB and run `select 1`.
 *
 * If any of that fails, the dist fails here with a message that names the
 * actual problem (missing archive / missing packaged dependency / missing
 * native binding / ABI mismatch) — a broken installer can no longer be
 * produced. asar stays enabled, better-sqlite3 stays unpacked, and nothing is
 * vendored or skipped.
 */

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const {
  MODULE_NAME,
  assertAsarArchiveFile,
  classifyProbeFailure,
  expectedProbePaths,
  findMissingPackagedEntries,
  pickProbeErrorLines,
  samePath,
} = require('./lib/app-asar-inspect.cjs');

const PROBE_SCRIPT = path.join(__dirname, 'lib', 'app-asar-probe.cjs');

function rel(appOutDir, target) {
  return path.relative(appOutDir, target) || target;
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

function readReport(stdout) {
  const value = (key) => new RegExp(`${key}=([^\\n]*)`).exec(stdout)?.[1]?.trim() || null;
  return {
    electronVersion: value('DKS_ELECTRON'),
    abi: value('DKS_ABI'),
    appRoot: value('DKS_APP_ROOT'),
    packageEntry: value('DKS_PACKAGE'),
    nativePath: value('DKS_NATIVE'),
    bindingsEntry: value('DKS_BINDINGS'),
    fileUriToPathEntry: value('DKS_FILE_URI_TO_PATH'),
    ok: /DKS_OK=1/.test(stdout),
  };
}

/**
 * ELECTRON_RUN_AS_NODE is set for this child process only; the hook itself
 * keeps running as plain Node. The child environment is scrubbed so the build
 * machine cannot inject lookups into the packaged app's module resolution —
 * and a stray ELECTRON_NO_ASAR cannot silently disable the archive support
 * this verification relies on.
 */
function probe(electron, appOutDir, appAsarPackageJson) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_NO_ASAR;

  const result = spawnSync(electron, [PROBE_SCRIPT, appAsarPackageJson], {
    cwd: appOutDir,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    ...readReport(result.stdout ?? ''),
    status: result.status,
    spawnError: result.error ? String(result.error.message ?? result.error) : null,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function probeFailureError(appOutDir, result) {
  const diagnostics = [
    `electron=${result.electronVersion ?? 'unknown'}`,
    `module ABI=${result.abi ?? 'unknown'}`,
    `package=${result.packageEntry ?? 'unresolved'}`,
    `native=${result.nativePath ?? 'unresolved'}`,
    `bindings=${result.bindingsEntry ?? 'unresolved'}`,
    `file-uri-to-path=${result.fileUriToPathEntry ?? 'unresolved'}`,
  ].join(', ');
  const detail = pickProbeErrorLines(result.output)
    .map((line) => `[dks]   ${line}`)
    .join('\n');
  const suffix = `${diagnostics}, exit ${String(result.status)}${result.spawnError ? `, spawn: ${result.spawnError}` : ''}`;
  const hint = '[dks] Refusing to build an installer with a broken local database. '
    + 'Re-run `npm run dist` — its pre-package guard (verify:native) rebuilds better-sqlite3 for Electron.';

  const kind = classifyProbeFailure(result.output);
  if (kind === 'abi-mismatch') {
    return new Error(
      `[dks] ABI mismatch — the packaged better-sqlite3 native binding was built for a different `
      + `NODE_MODULE_VERSION than the packaged Electron (${suffix}):\n${detail}\n${hint}`,
    );
  }
  if (kind === 'missing-module') {
    return new Error(
      `[dks] a packaged JS dependency could not be resolved from resources/app.asar by the packaged `
      + `Electron (${suffix}):\n${detail}\n${hint}`,
    );
  }
  return new Error(
    `[dks] the packaged ${MODULE_NAME} could not be loaded by the packaged Electron (${suffix}):\n`
    + `${detail}\n${hint}`,
  );
}

function assertProbePath(appOutDir, label, actual, expected, devModuleDir) {
  if (typeof actual === 'string' && actual.length > 0 && actual.startsWith(devModuleDir)) {
    throw new Error(`[dks] the probe loaded ${label} from the development checkout (${actual}).`);
  }
  if (!samePath(actual, expected)) {
    throw new Error(
      `[dks] ${label} resolved to ${actual ?? 'nothing'}; expected ${rel(appOutDir, expected)} — `
      + 'resolution must stay inside resources/app.asar (never app.asar.unpacked, never the build '
      + 'machine).',
    );
  }
}

module.exports = async function verifyPackagedNativeModules(context) {
  const { appOutDir } = context;
  const resourcesDir = path.join(appOutDir, 'resources');
  const expected = expectedProbePaths(resourcesDir);

  if (!existsSync(resourcesDir)) {
    throw new Error(`[dks] packaged resources directory is missing: ${resourcesDir}`);
  }

  // The archive itself: one FILE. Never existsSync/stat below it in Node.
  assertAsarArchiveFile(expected.appAsar);

  // The unpacked native module is a real on-disk layout — plain fs is right here.
  if (!existsSync(expected.unpackedModuleDir)) {
    throw new Error(
      `[dks] ${MODULE_NAME} was not unpacked into resources/app.asar.unpacked — `
      + 'check asarUnpack in electron-builder.yml.',
    );
  }
  if (!existsSync(expected.unpackedNativeBinary)) {
    throw new Error(
      `[dks] the packaged native binding is missing: ${rel(appOutDir, expected.unpackedNativeBinary)} — `
      + 'the app would start without a local database.',
    );
  }

  // Archive contents, verified in plain Node from the asar header: the app
  // manifest, better-sqlite3's own JavaScript and every JS dependency it
  // lazily requires must all be readable at runtime. Missing files are named
  // individually — this is what used to surface much later as
  // "Cannot find module 'bindings'".
  const missing = findMissingPackagedEntries(expected.appAsar, resourcesDir);
  if (missing.length > 0) {
    const lines = missing
      .map((problem) => `[dks]   - ${problem.label}: ${problem.entry}`)
      .join('\n');
    throw new Error(
      `[dks] resources/app.asar is missing packaged files the app needs:\n${lines}\n`
      + '[dks] production dependencies must ship inside the asar (or its app.asar.unpacked mirror) — '
      + 'check the dependency set in package.json and the asarUnpack globs.',
    );
  }

  const electron = packagedExecutable(context);
  if (!electron) {
    throw new Error(
      `[dks] cannot find the packaged Electron executable in ${appOutDir}; `
      + 'the native module cannot be verified.',
    );
  }

  const result = probe(electron, appOutDir, expected.appAsarPackageJson);
  if (!result.ok) {
    throw probeFailureError(appOutDir, result);
  }

  // The probe must have loaded the app's own copies, resolved through the
  // archive — never the dev checkout and never the bare unpacked directory.
  const devModuleDir = path.join(__dirname, '..', 'node_modules', MODULE_NAME);
  assertProbePath(appOutDir, MODULE_NAME, result.packageEntry, expected.packageEntry, devModuleDir);
  assertProbePath(appOutDir, "'bindings'", result.bindingsEntry, expected.bindingsEntry, devModuleDir);
  assertProbePath(appOutDir, "'file-uri-to-path'", result.fileUriToPathEntry, expected.fileUriToPathEntry, devModuleDir);
  assertProbePath(appOutDir, 'the native binding', result.nativePath, expected.nativePath, devModuleDir);

  console.log(
    `[dks] packaged ${MODULE_NAME} loads under Electron `
    + `(module ABI ${result.abi ?? 'unknown'}, Electron ${result.electronVersion ?? 'unknown'}) `
    + `from ${rel(appOutDir, result.packageEntry)}`,
  );
};
