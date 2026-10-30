'use strict';

/**
 * Packaging lock diagnostics — does "DKS.exe is writable" actually mean
 * "rcedit can rewrite DKS.exe"?
 *
 * electron-builder's Windows order is (app-builder-lib 25.1.8,
 * platformPackager.doPack):
 *
 *   installAppDependencies → copyAppFiles → afterPack (our packaged-app probe)
 *     → sanityCheckPackage → doSignAfterPack → signAndEditResources
 *     → app-builder rcedit  (3 retries, 1 s apart)
 *
 * `scripts/after-pack.cjs` starts `release\win-unpacked\DKS.exe` with
 * ELECTRON_RUN_AS_NODE and then waits until the file can be opened for
 * writing before returning. That wait is the guard against
 *
 *   Fatal error: Unable to commit changes.
 *
 * This script measures what that check proves, on the real Windows runner:
 *
 *   A. While a process runs from the exe: the write-open fails and rcedit
 *      fails with the exact message → the check does detect a live image.
 *   B. After that process exits: the write-open succeeds and rcedit succeeds
 *      → a passing check is not a false positive for that case.
 *   C. While a THIRD party holds a shared read+write handle (the shape a
 *      virus scanner uses) the write-open can still succeed — the question is
 *      whether rcedit does. This is the guard's blind spot if it exists.
 *   D. While a third party holds a read-only-share handle: the write-open
 *      fails → the guard does catch that class.
 *   E. The real hand-off: run the real afterPack hook, then rcedit the real
 *      packaged exe immediately, three times, and report each outcome.
 *
 * It is read-only with respect to the build output: the exe is copied for A–D
 * and E only re-runs what electron-builder already ran. Exit code is 0 when
 * the experiments ran (their outcomes are the report), 1 when the packaged app
 * is missing.
 */

const { spawn } = require('node:child_process');
const { closeSync, copyFileSync, existsSync, openSync, rmSync } = require('node:fs');
const path = require('node:path');

const holdersModule = require(path.join(__dirname, '..', 'lib', 'file-holders.cjs'));

const projectRoot = process.cwd();
const appOutDir = path.join(projectRoot, 'release', 'win-unpacked');
const packagedExe = path.join(appOutDir, 'DKS.exe');
const probeCopy = path.join(appOutDir, 'DKS-lockprobe.exe');

const results = [];

function record(id, description, outcome) {
  results.push({ id, description, outcome });
  console.log(`[probe] ${id}: ${description} -> ${outcome}`);
}

function tryOpenForWrite(filePath) {
  try {
    const descriptor = openSync(filePath, 'r+');
    closeSync(descriptor);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code ?? 'unknown', message: String(error.message ?? error) };
  }
}

function describeOpen(result) {
  return result.ok ? 'OPEN OK' : `OPEN FAILED ${result.code}`;
}

/**
 * Exactly what electron-builder does: app-builder's rcedit with the same kind
 * of arguments WinPackager.signAndEditResources builds.
 */
async function runRcedit(filePath) {
  const args = [
    filePath,
    '--set-version-string', 'FileDescription', 'DKS',
    '--set-version-string', 'ProductName', 'DKS',
    '--set-file-version', '0.1.11',
    '--set-product-version', '0.1.11',
  ];
  try {
    // eslint-disable-next-line global-require
    const { executeAppBuilder } = require('builder-util');
    await executeAppBuilder(['rcedit', '--args', JSON.stringify(args)], undefined, {}, 0);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error).trim() };
  }
}

function describeRcedit(result) {
  if (result.ok) {
    return 'rcedit OK';
  }
  const compact = result.message.replace(/\s+/g, ' ').slice(0, 240);
  return `rcedit FAILED: ${compact}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWritable(filePath, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const open = tryOpenForWrite(filePath);
    if (open.ok) {
      return { ok: true, waitedMs: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) {
      return { ok: false, waitedMs: Date.now() - started, last: open };
    }
    await delay(250);
  }
}

/** Start the copy as a long-lived node process (same image, node mode). */
function startRunner(filePath) {
  const child = spawn(filePath, ['-e', 'setTimeout(function () {}, 600000)'], {
    cwd: appOutDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, output: () => `${stdout}${stderr}`.trim() };
}

function stopRunner(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('close', () => resolve());
    killer.once('error', () => resolve());
  });
}

/**
 * PowerShell child that holds a handle with a chosen share mode, then sleeps.
 *
 * The values are written into a temporary .ps1 and passed with `-File`/`-Path`:
 * with `-Command`, arguments after the script are not `$args`, which is exactly
 * why the first version of this experiment reported "FAILED to open the handle".
 */
function holdHandle(filePath, access, share, seconds) {
  const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'dks-hold-'));
  const scriptPath = path.join(dir, 'hold.ps1');
  writeFileSync(scriptPath, [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$Path,',
    '  [Parameter(Mandatory=$true)][ValidateSet("Read","ReadWrite")][string]$Access,',
    '  [Parameter(Mandatory=$true)][ValidateSet("Read","ReadWrite","Delete","None")][string]$Share,',
    '  [Parameter(Mandatory=$true)][int]$Seconds',
    ')',
    'try {',
    '  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::$Access, [System.IO.FileShare]::$Share)',
    '} catch {',
    '  Write-Output "FAILED: $($_.Exception.GetType().Name) $($_.Exception.Message)"',
    '  exit 2',
    '}',
    'Write-Output "HELD"',
    'Start-Sleep -Seconds $Seconds',
    '$fs.Close()',
    'exit 0',
  ].join('\n'), 'utf8');

  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Path', filePath,
    '-Access', access,
    '-Share', share,
    '-Seconds', String(seconds),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const settled = stdout.includes('HELD') || stdout.includes('FAILED') || Date.now() - started > 15_000;
      if (settled) {
        clearInterval(timer);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        resolve({ child, ready: stdout.includes('HELD'), stdout: `${stdout}${stderr}`.trim() });
      }
    }, 100);
  });
}

async function experimentRunningImage() {
  try {
    rmSync(probeCopy, { force: true });
    copyFileSync(packagedExe, probeCopy);
  } catch (error) {
    record('A0', 'copy packaged exe for the experiments', `FAILED ${String(error.message ?? error)}`);
    return;
  }

  const runner = startRunner(probeCopy);
  await delay(2_000);
  const alive = runner.child.exitCode === null;
  record('A1', 'probe runner is alive', alive ? `yes (pid ${runner.child.pid})` : `no (${runner.output().slice(0, 200)})`);

  // A: a live image must refuse the write handle.
  const runningOpen = tryOpenForWrite(probeCopy);
  record('A2', 'write-open while a process runs from the exe', describeOpen(runningOpen));

  // A: and rcedit must fail with the release-run message.
  const runningRcedit = await runRcedit(probeCopy);
  record('A3', 'rcedit while a process runs from the exe', describeRcedit(runningRcedit));

  await stopRunner(runner.child);
  const afterKill = await waitForWritable(probeCopy);
  record('B1', 'write-open after the process was killed', afterKill.ok
    ? `OPEN OK after ${afterKill.waitedMs}ms`
    : `OPEN FAILED ${afterKill.last ? afterKill.last.code : 'unknown'} after ${afterKill.waitedMs}ms`);

  const idleRcedit = await runRcedit(probeCopy);
  record('B2', 'rcedit with no process running from the exe', describeRcedit(idleRcedit));

  return { runningOpen, runningRcedit, idleRcedit };
}

async function experimentThirdPartyHandles() {
  // C: shared read+write, no delete — the "writable but maybe not replaceable"
  // shape. If the write-open passes here but rcedit fails, the guard's check is
  // insufficient by construction.
  const writable = await holdHandle(probeCopy, 'ReadWrite', 'ReadWrite', 25);
  if (writable.ready) {
    const open = tryOpenForWrite(probeCopy);
    record('C1', 'write-open while another handle has FileShare.ReadWrite', describeOpen(open));
    const holders = await holdersModule.findFileHolders(probeCopy, { log: (line) => console.log(line) });
    record('C2', 'Restart Manager holders while that handle is open', holders.supported
      ? `${holders.holders.length} holder(s): ${holders.holders.map((h) => `pid ${h.pid} ${h.appName ?? h.service ?? '?'}`).join(', ') || 'none'}`
      : `unsupported (${holders.reason})`);
    const rcedit = await runRcedit(probeCopy);
    record('C3', 'rcedit while another handle has FileShare.ReadWrite', describeRcedit(rcedit));
  } else {
    record('C1', 'hold FileShare.ReadWrite handle', `FAILED: ${writable.stdout}`);
  }
  await stopRunner(writable.child);

  // D: read-only share — the class the guard does catch.
  const reader = await holdHandle(probeCopy, 'Read', 'Read', 20);
  if (reader.ready) {
    const open = tryOpenForWrite(probeCopy);
    record('D1', 'write-open while another handle has FileShare.Read', describeOpen(open));
    const holders = await holdersModule.findFileHolders(probeCopy, { log: (line) => console.log(line) });
    record('D2', 'Restart Manager holders while that handle is open', holders.supported
      ? `${holders.holders.length} holder(s): ${holders.holders.map((h) => `pid ${h.pid} ${h.appName ?? h.service ?? '?'}`).join(', ') || 'none'}`
      : `unsupported (${holders.reason})`);
  } else {
    record('D1', 'hold FileShare.Read handle', `FAILED: ${reader.stdout}`);
  }
  await stopRunner(reader.child);
}

async function experimentRealHandoff(rounds = 3) {
  const afterPack = require(path.join(projectRoot, 'scripts', 'after-pack.cjs'));
  for (let round = 1; round <= rounds; round += 1) {
    const context = {
      appOutDir,
      outDir: path.join(projectRoot, 'release'),
      electronPlatformName: 'win32',
      arch: 1,
      targets: [],
      packager: { appInfo: { productFilename: 'DKS', productName: 'DKS' } },
    };
    try {
      await afterPack(context);
      record(`E${round}a`, 'afterPack hook (probe + lock guard) completed', 'yes');
    } catch (error) {
      record(`E${round}a`, 'afterPack hook (probe + lock guard) completed', `THREW: ${String(error.message ?? error).slice(0, 200)}`);
      continue;
    }
    const open = tryOpenForWrite(packagedExe);
    record(`E${round}b`, 'write-open immediately after the hook returned', describeOpen(open));
    const rcedit = await runRcedit(packagedExe);
    record(`E${round}c`, 'rcedit immediately after the hook returned', describeRcedit(rcedit));
  }
}

async function main() {
  console.log(`[probe] platform=${process.platform} appOutDir=${appOutDir}`);
  if (process.platform !== 'win32') {
    console.log('[probe] Windows-only diagnostics — skipping');
    return;
  }
  if (!existsSync(packagedExe)) {
    console.log(`[probe] packaged executable not found at ${packagedExe}`);
    process.exitCode = 1;
    return;
  }

  await experimentRunningImage();
  await experimentThirdPartyHandles();
  await experimentRealHandoff();

  rmSync(probeCopy, { force: true });
  console.log('\n[probe] summary');
  for (const entry of results) {
    console.log(`[probe]   ${entry.id} ${entry.description}: ${entry.outcome}`);
  }
}

main().catch((error) => {
  console.error(`[probe] diagnostics failed: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
