'use strict';

/**
 * R7b — packaged-artifact probe.
 *
 * Executed by the **packaged Electron binary** with `ELECTRON_RUN_AS_NODE=1`
 * (set only in this child process's environment by `scripts/after-pack.cjs`):
 *
 *   electron app-asar-probe.cjs <resources>/app.asar/package.json
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
 *   Anchoring the require at `app.asar/package.json` is exactly how the app
 *   itself resolves modules: `bindings` is read from the asar, and Electron
 *   transparently redirects the unpacked `better_sqlite3.node` to
 *   `app.asar.unpacked`. Requiring the package and instantiating a real
 *   in-memory database then exercises the same code path as the app.
 *
 * Diagnostics (Electron version, ABI, resolved package/native paths) are
 * written BEFORE the module is loaded, so a resolution failure still leaves
 * context behind.
 */

const path = require('node:path');
const { createRequire } = require('node:module');

const MODULE_NAME = 'better-sqlite3';

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
const requireFromApp = createRequire(appPackageJson);

write(`DKS_ELECTRON=${process.versions.electron ?? ''}`);
write(`DKS_ABI=${process.versions.modules}`);
write(`DKS_EXEC=${process.execPath}`);
write(`DKS_APP_ROOT=${appRoot}`);

let packageEntry;
try {
  packageEntry = requireFromApp.resolve(MODULE_NAME);
} catch (error) {
  fail(`cannot resolve ${MODULE_NAME} from ${appPackageJson}: ${error.message}`);
}

const packageDir = path.dirname(path.dirname(packageEntry));
const nativeBinding = path.join(packageDir, 'build', 'Release', 'better_sqlite3.node');

write(`DKS_PACKAGE=${packageEntry}`);
write(`DKS_NATIVE=${nativeBinding}`);

// The app must resolve its own copy. Escaping to the build machine's checkout
// would make this probe meaningless, so it is refused outright.
const expectedSegment = `${path.sep}app.asar${path.sep}node_modules${path.sep}`;
if (!packageEntry.includes(expectedSegment)) {
  fail(`${MODULE_NAME} resolved outside app.asar (${packageEntry}) — refusing to trust this probe`);
}
if (packageEntry.includes(`${path.sep}app.asar.unpacked${path.sep}`)) {
  fail(`${MODULE_NAME} resolved through app.asar.unpacked (${packageEntry}) — must resolve through app.asar`);
}

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
