'use strict';

/**
 * R8 — packaged `resources/app.asar` inspection helpers.
 *
 * Shared by `scripts/after-pack.cjs` (the electron-builder hook, plain Node on
 * the build machine) and `scripts/lib/app-asar-probe.cjs` (the child probe
 * executed by the *packaged* Electron). Pure and side-effect-free: importing
 * this module performs no I/O, and `@electron/asar` is only required lazily
 * inside the functions that need it. No shebang, no top-level execution and
 * no `process.exit`, so the Vitest suites can import it directly (compare
 * `scripts/lib/native-guard.mjs` — a `#!` first line breaks Vite's SSR
 * transform on CRLF checkouts).
 *
 * The confirmed Windows failure this module fixes:
 *
 *   `dir /a release\win-unpacked\resources` shows the real staged output:
 *
 *     app.asar               127 MB FILE  (the archive)
 *     app.asar.unpacked      <DIR>       (unpacked native modules)
 *     icon.png               FILE
 *
 *   The previous hook checked `resources\app.asar\package.json` with plain
 *   Node `existsSync`. `app.asar` is a single archive *file*, so the check
 *   failed and `npm run dist` died even though the archive was intact.
 *   Plain Node must therefore verify the archive *file* (and its listing via
 *   `@electron/asar`), while reading *inside* the archive is delegated to the
 *   packaged Electron runtime, whose fs and module loader are ASAR-aware
 *   (Electron 34 `lib/node/init.ts` calls `wrapFsWithAsar` also in
 *   ELECTRON_RUN_AS_NODE mode, and `process.dlopen` is wrapped for the
 *   `app.asar.unpacked` redirect).
 */

const { existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');

const MODULE_NAME = 'better-sqlite3';

/**
 * better-sqlite3's plain JS production dependencies. They are packed inside
 * `app.asar` (the `asarUnpack` glob only covers `node_modules/better-sqlite3/**`),
 * and `bindings` lazily `require('file-uri-to-path')` on POSIX.
 * `reportKey` is the `DKS_*` line the child probe prints for each.
 */
const JS_DEPENDENCIES = [
  { name: 'bindings', reportKey: 'DKS_BINDINGS' },
  { name: 'file-uri-to-path', reportKey: 'DKS_FILE_URI_TO_PATH' },
];

const NATIVE_BINARY_REL = path.join('build', 'Release', 'better_sqlite3.node');

/** Every path the guard reasons about, derived from the packaged resources dir. */
function expectedProbePaths(resourcesDir) {
  const appAsar = path.join(resourcesDir, 'app.asar');
  const packedModules = path.join(appAsar, 'node_modules');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  return {
    appAsar,
    appAsarPackageJson: path.join(appAsar, 'package.json'),
    unpackedDir,
    unpackedModuleDir: path.join(unpackedDir, 'node_modules', MODULE_NAME),
    unpackedNativeBinary: path.join(unpackedDir, 'node_modules', MODULE_NAME, NATIVE_BINARY_REL),
    packageEntry: path.join(packedModules, MODULE_NAME, 'lib', 'index.js'),
    nativePath: path.join(packedModules, MODULE_NAME, NATIVE_BINARY_REL),
    bindingsEntry: path.join(packedModules, 'bindings', 'bindings.js'),
    fileUriToPathEntry: path.join(packedModules, 'file-uri-to-path', 'index.js'),
  };
}

/**
 * The packaged app MUST ship `resources/app.asar` as one archive file.
 * Never `existsSync` anything *below* it here — this file runs in plain Node,
 * which cannot look inside an asar archive. Throws a clear error otherwise.
 */
function assertAsarArchiveFile(appAsarPath) {
  if (!existsSync(appAsarPath)) {
    throw new Error(
      `[dks] resources/app.asar is missing at ${appAsarPath} — electron-builder did not produce the `
      + 'application archive. Keep `asar: true` in electron-builder.yml so the app resolves its '
      + 'dependencies from resources/app.asar.',
    );
  }
  const stat = statSync(appAsarPath);
  if (!stat.isFile()) {
    throw new Error(
      `[dks] resources/app.asar must be a single asar archive file, but ${appAsarPath} is a `
      + `${stat.isDirectory() ? 'directory' : 'non-file entry'} — the packaging layout is unexpected; `
      + 'do not expand the archive on disk.',
    );
  }
}

/** Lazily required so importing this module never pulls electron-builder deps. */
function loadAsar() {
  try {
    return require('@electron/asar');
  } catch (error) {
    throw new Error(
      `[dks] cannot load @electron/asar (${error.message}) — it is a dependency of electron-builder; `
      + 'reinstall dependencies before packaging.',
    );
  }
}

/**
 * Normalised `/`-separated archive entry names without a leading slash.
 * Throws when the file is not a readable archive at all.
 */
function listAsarEntries(appAsarPath) {
  const asar = loadAsar();
  let raw;
  try {
    raw = asar.listPackage(appAsarPath);
  } catch (error) {
    throw new Error(
      `[dks] resources/app.asar is not a readable asar archive: ${error.message}. `
      + 'The staged output is corrupt — re-run `npm run dist`.',
    );
  }
  return raw
    .map((entry) => String(entry).replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((entry) => entry.length > 0);
}

function readAsarJson(asar, appAsarPath, entry) {
  let raw;
  try {
    raw = asar.extractFile(appAsarPath, entry);
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

/** Package manifest from the archive, falling back to the unpack mirror. */
function readPackagedJson(asar, appAsarPath, unpackedDir, entry) {
  const fromArchive = readAsarJson(asar, appAsarPath, entry);
  if (fromArchive !== null) {
    return fromArchive;
  }
  try {
    const mirrorPath = path.join(unpackedDir, ...entry.split('/'));
    return JSON.parse(readFileSync(mirrorPath, 'utf8'));
  } catch {
    return null;
  }
}

/** `package.json#main` of an archive package, `/`-joined, `./` stripped. */
function archiveMain(pkg, base) {
  const main = typeof pkg?.main === 'string' && pkg.main.trim() ? pkg.main.trim() : 'index.js';
  const clean = main.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  return `${base}/${clean}`;
}

/**
 * Verifies — in plain Node, from the archive header — that every packaged
 * file better-sqlite3 needs at runtime is actually inside `app.asar` (or, as
 * a tolerated equivalent for unpackable trees, mirrored in
 * `resources/app.asar.unpacked`). Returns an array of
 * `{ entry, label }` problems; an empty array means the archive is complete.
 *
 * This is the deterministic half of "packaged JS dependency missing": a
 * `Cannot find module 'bindings'` at probe time should be impossible after
 * this check, and if the layout changes the error names the exact file.
 */
function findMissingPackagedEntries(appAsarPath, resourcesDir) {
  const asar = loadAsar();
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  const entries = new Set(listAsarEntries(appAsarPath));
  const problems = [];

  const present = (rel) => entries.has(rel);
  const unpackMirrored = (rel) => (
    existsSync(path.join(resourcesDir, 'app.asar.unpacked', ...rel.split('/')))
  );

  const need = (rel, label, { allowUnpackMirror = true } = {}) => {
    if (present(rel)) {
      return;
    }
    if (allowUnpackMirror && unpackMirrored(rel)) {
      return;
    }
    problems.push({ entry: rel, label });
  };

  // The application manifest is the anchor the probe passes to createRequire.
  const appManifest = readAsarJson(asar, appAsarPath, 'package.json');
  if (!present('package.json') || appManifest === null) {
    problems.push({ entry: 'package.json', label: 'the app manifest' });
  }

  // better-sqlite3's own JS (whole tree is under the asarUnpack glob, so the
  // app.asar.unpacked mirror is an equivalent layout for it).
  const moduleBase = `node_modules/${MODULE_NAME}`;
  const modulePkg = readPackagedJson(asar, appAsarPath, unpackedDir, `${moduleBase}/package.json`);
  if (modulePkg === null) {
    problems.push({ entry: `${moduleBase}/package.json`, label: 'the better-sqlite3 package' });
  } else {
    const mainRel = archiveMain(modulePkg, moduleBase);
    need(mainRel, `the better-sqlite3 entry point (${mainRel})`);
  }

  // The plain JS dependencies better-sqlite3 lazily requires. These are NOT
  // covered by the asarUnpack glob, so they must be readable from the archive
  // (an unpacked mirror is still accepted — Electron resolves both).
  for (const dep of JS_DEPENDENCIES) {
    const depBase = `node_modules/${dep.name}`;
    const depPkg = readPackagedJson(asar, appAsarPath, unpackedDir, `${depBase}/package.json`);
    if (depPkg === null) {
      problems.push({
        entry: `${depBase}/package.json`,
        label: `the packaged JS dependency '${dep.name}'`,
      });
      continue;
    }
    need(
      archiveMain(depPkg, depBase),
      `the packaged JS dependency '${dep.name}'`,
    );
  }

  return problems;
}

/** Diagnostic tail of child output (mirrors `native-guard.mjs`'s lastLines). */
function lastLines(text, limit = 20) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.length > 300 ? `${line.slice(0, 299)}…` : line));
  return lines.slice(-limit);
}

const INTERESTING_LINE = /^(Error|TypeError|RangeError|SyntaxError|ReferenceError)\b|NODE_MODULE_VERSION|was compiled against|Cannot find module|is not a constructor|did not self-register|not a valid Win32|cannot open shared object|no such file or directory|ASAR|app\.asar/i;

/**
 * The signal lines of a failed probe, not a stack tail: the loader error
 * (`NODE_MODULE_VERSION …`, `Cannot find module 'bindings'`, the probe's own
 * `[probe] …` message) rather than `at [eval]-wrapper` frames.
 */
function pickProbeErrorLines(output, limit = 8) {
  const lines = lastLines(output, 400);
  const interesting = lines.filter((line) => INTERESTING_LINE.test(line));
  const chosen = interesting.length > 0 ? interesting : lines.slice(-limit);
  return chosen.slice(0, limit);
}

/**
 * Coarse classification of a failed child probe, driving a headline that
 * names the actual failure instead of a generic "probe failed".
 *   - 'abi-mismatch'    — binding built for another NODE_MODULE_VERSION
 *   - 'missing-module'  — a packaged JS dependency could not be resolved
 *   - 'unknown'         — anything else; the picked lines carry the detail
 */
function classifyProbeFailure(output) {
  const text = String(output ?? '');
  if (/NODE_MODULE_VERSION|was compiled against a different (Node\.js |node )?version|ABI mismatch/i.test(text)) {
    return 'abi-mismatch';
  }
  if (/Cannot find module|MODULE_NOT_FOUND/.test(text)) {
    return 'missing-module';
  }
  return 'unknown';
}

/**
 * Compare two absolute paths the probe reported (normalised, same machine).
 * Windows paths are case-insensitive; fold there so a drive-letter or
 * realpath case difference cannot produce a false guard failure.
 */
function samePath(actual, expected) {
  if (typeof actual !== 'string' || actual.length === 0) {
    return false;
  }
  const clean = (value) => {
    const normalised = path.normalize(value.replace(/[\\/]+$/, ''));
    return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
  };
  return clean(actual) === clean(expected);
}

module.exports = {
  JS_DEPENDENCIES,
  MODULE_NAME,
  assertAsarArchiveFile,
  classifyProbeFailure,
  expectedProbePaths,
  findMissingPackagedEntries,
  lastLines,
  listAsarEntries,
  pickProbeErrorLines,
  samePath,
};
