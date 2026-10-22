'use strict';

/**
 * R8 — packaged-artifact probe.
 *
 * Executed by the **packaged Electron binary** with `ELECTRON_RUN_AS_NODE=1`
 * (set only in this child process's environment by `scripts/after-pack.cjs`):
 *
 *   DKS.exe app-asar-probe.cjs <resources>/app.asar/package.json
 *
 * The argument points INSIDE the real `app.asar` archive — a single archive
 * file on the packaged layout, not a filesystem folder. That is intentional:
 * `ELECTRON_RUN_AS_NODE` still initialises Electron's ASAR support
 * (Electron 34 `lib/node/init.ts` calls `wrapFsWithAsar(require('fs'))`, and
 * `process.dlopen`/`Module._extensions['.node']` are wrapped for the
 * `app.asar.unpacked` redirect), so the fs and module resolution below read
 * through the archive exactly like the running app does. Plain Node cannot —
 * `scripts/after-pack.cjs` therefore never stats below `resources/app.asar`
 * itself and verifies the archive's contents with `@electron/asar` instead.
 *
 * Why `createRequire(app.asar/package.json)` instead of requiring
 * `app.asar.unpacked/node_modules/better-sqlite3` directly:
 *
 *   better-sqlite3's JavaScript (`lib/database.js`) does `require('bindings')`.
 *   `bindings` is a normal production dependency and lives *inside*
 *   `app.asar`, not in the unpacked directory. Requiring the unpacked copy
 *   makes Node resolve `bindings` from `<resources>/app.asar.unpacked/node_modules`
 *   — where it does not exist — and the probe fails with
 *   `Cannot find module 'bindings'` (the Windows failure after `af95c5f`).
 *
 * What this proves, in order:
 *   1. DKS_ELECTRON / DKS_ABI / DKS_EXEC / DKS_APP_ROOT are written BEFORE
 *      anything can fail, so diagnostics never lose context.
 *   2. The archive is readable through Electron's ASAR-aware fs
 *      (`package.json` inside it must stat; a missing/corrupt archive or a
 *      disabled-ASAR runtime fails here with an explicit message).
 *   3. better-sqlite3's entry point AND its JS dependencies (`bindings`,
 *      `file-uri-to-path`) resolve from inside `app.asar` — never from
 *      `app.asar.unpacked`, never from a dev checkout.
 *   4. The native binding path is readable (Electron redirects it to
 *      `app.asar.unpacked`; a missing unpacked binary fails here).
 *   5. The packaged runtime can `require('better-sqlite3')`, open an
 *      in-memory database, run `select 1` and close it — the ABI assertion.
 */

const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { JS_DEPENDENCIES, MODULE_NAME } = require('./app-asar-inspect.cjs');

function write(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`[probe] ${message}\n`);
  process.exit(code);
}

const appPackageJson = process.argv[2];
if (!appPackageJson || !path.isAbsolute(appPackageJson)) {
  fail('usage: electron app-asar-probe.cjs <absolute path to resources/app.asar/package.json>', 2);
}

const appRoot = path.dirname(appPackageJson);

// (1) Diagnostics first — a later failure must not erase Electron/ABI context.
write(`DKS_ELECTRON=${process.versions.electron ?? ''}`);
write(`DKS_ABI=${process.versions.modules}`);
write(`DKS_EXEC=${process.execPath}`);
write(`DKS_APP_ROOT=${appRoot}`);

// (2) The archive must be readable through Electron's ASAR-aware fs. Under
// plain Node this is false — but this probe only ever runs under the packaged
// Electron. A failure here means the staged resources are broken (or ASAR was
// disabled, e.g. ELECTRON_NO_ASAR leaking into the child's environment).
if (!fs.existsSync(appPackageJson)) {
  fail(
    `cannot read ${appPackageJson} — the app.asar archive is missing, corrupt, or this Electron has `
    + 'ASAR support disabled (check for ELECTRON_NO_ASAR in the build environment)',
  );
}

const requireFromApp = createRequire(appPackageJson);

// Separator-insensitive segment matching: after realpath/archive-virtual
// joins, Windows resolutions can carry mixed separators.
const asarModuleSegment = '/app.asar/node_modules/';
const unpackedSegment = '/app.asar.unpacked/';

// (3) Resolve a package through the archive and prove it stayed inside it.
function resolveInsideAsar(name) {
  let entry;
  try {
    entry = requireFromApp.resolve(name);
  } catch (error) {
    fail(`cannot resolve ${name} from ${appPackageJson}: ${error.message}`);
  }
  const slashed = entry.replace(/\\/g, '/');
  if (slashed.includes(unpackedSegment)) {
    fail(`${name} resolved through app.asar.unpacked (${entry}) — must resolve through app.asar`);
  }
  if (!slashed.includes(asarModuleSegment)) {
    fail(`${name} resolved outside app.asar (${entry}) — refusing to trust this probe`);
  }
  if (!fs.existsSync(entry)) {
    fail(`${name} resolved to ${entry} but it is not readable inside app.asar`);
  }
  return entry;
}

const packageEntry = resolveInsideAsar(MODULE_NAME);
write(`DKS_PACKAGE=${packageEntry}`);

for (const dep of JS_DEPENDENCIES) {
  const depEntry = resolveInsideAsar(dep.name);
  write(`${dep.reportKey}=${depEntry}`);
}

// (4) The binding itself. The archive path is virtual; Electron's fs redirect
// answers it from resources/app.asar.unpacked, so existsSync is the truthful
// "was the native module really unpacked" check from inside the runtime.
const packageDir = path.dirname(path.dirname(packageEntry));
const nativeBinding = path.join(packageDir, 'build', 'Release', 'better_sqlite3.node');
write(`DKS_NATIVE=${nativeBinding}`);

if (!fs.existsSync(nativeBinding)) {
  fail(
    `the native binding is not readable at ${nativeBinding} — asarUnpack must place `
    + 'better_sqlite3.node in resources/app.asar.unpacked',
  );
}

// (5) The real load + query — dlopen against the wrong ABI rejects here.
let Database;
try {
  Database = requireFromApp(MODULE_NAME);
} catch (error) {
  fail(`cannot load ${MODULE_NAME} from the packaged app: ${error.message}`);
}

try {
  const db = new Database(':memory:');
  const row = db.prepare('select 1 as ok').get();
  db.close();
  if (!row || row.ok !== 1) {
    fail(`unexpected result from the SQLite probe query: ${JSON.stringify(row)}`);
  }
} catch (error) {
  fail(`packaged SQLite failed to open an in-memory database: ${error.message}`);
}

write('DKS_OK=1');
