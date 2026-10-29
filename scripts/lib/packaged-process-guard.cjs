'use strict';

/**
 * R9 — packaged-executable lock guard for the afterPack hook.
 *
 * electron-builder runs hooks in this order on Windows:
 *
 *   afterPack  →  sanityCheckPackage  →  doSignAfterPack  →  signApp  →
 *   signAndEditResources  →  app-builder rcedit (icon + version resources)
 *
 * `scripts/after-pack.cjs` launches the PACKAGED application binary
 * (`release\win-unpacked\DKS.exe`) with `ELECTRON_RUN_AS_NODE=1` to prove the
 * packaged better-sqlite3 loads. While any process created from that image is
 * still alive — the probe itself, a helper it spawned, or a slow-to-reap
 * process object — Windows keeps the image section mapped, and rcedit cannot
 * rewrite the PE resources. rcedit then fails with
 *
 *   Fatal error: Unable to commit changes
 *
 * (an `ERROR_SHARING_VIOLATION` from `EndUpdateResource`), *after* the probe
 * itself succeeded. electron-builder already retries rcedit three times, so a
 * transient millisecond gap is tolerated — a process that is genuinely still
 * running is not, and neither is a child the probe left behind.
 *
 * This module makes the hand-off deterministic. The hook must not return while
 * the executable is still in use:
 *
 *   1. wait for the child process tree to be fully gone (the caller awaits the
 *      child's `close` event, and a timed-out probe is killed);
 *   2. sweep any process still running the PACKAGED executable — matched by
 *      the full image path, so a developer's installed DKS at
 *      %LOCALAPPDATA%\Programs\DKS\DKS.exe is never touched — and kill its
 *      tree;
 *   3. wait until the executable can actually be opened for writing, which is
 *      exactly the precondition rcedit needs.
 *
 * Every step logs `tasklist` diagnostics, and every wait is bounded: the hook
 * fails with a message that names the problem instead of letting rcedit fail
 * with "Unable to commit changes" 20 seconds later.
 *
 * Nothing here imports Electron or electron-builder; commands are injected so
 * the Windows code paths are unit-testable on Linux.
 */

const { spawn, spawnSync } = require('node:child_process');
const { closeSync, openSync } = require('node:fs');
const path = require('node:path');

/** How long to keep sweeping processes created from the packaged exe. */
const DEFAULT_PROCESS_SWEEP_TIMEOUT_MS = 20_000;
/**
 * How long to wait for the exe to become writable (rcedit's precondition).
 * Generous on purpose: on a CI runner an on-access virus scanner can hold the
 * freshly written image for a while, and waiting is always cheaper than the
 * opaque rcedit failure this guard exists to prevent.
 */
const DEFAULT_UNLOCK_TIMEOUT_MS = 60_000;
/** Poll interval for both waits — short, so a fast exit costs no wall time. */
const DEFAULT_POLL_INTERVAL_MS = 250;
/** Default hard limit for the packaged-Electron probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

function lowerCasePath(value) {
  return path.resolve(String(value)).toLowerCase();
}

/**
 * Parse `tasklist /FO CSV /NH` output (diagnostics only — it is never used to
 * decide what to kill, because it does not report the image path).
 *
 *   "DKS.exe","7184","Console","1","78,912 K"
 */
function parseTasklistCsv(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => {
      const cells = line.slice(1).split('","').map((cell) => cell.replace(/"$/, ''));
      if (cells.length < 2) {
        return null;
      }
      const pid = Number(cells[1]);
      if (!Number.isFinite(pid)) {
        return null;
      }
      return {
        imageName: cells[0],
        pid,
        sessionName: cells[2] ?? null,
        sessionNumber: cells[3] ?? null,
        memory: cells[4] ?? null,
      };
    })
    .filter(Boolean);
}

/** `tasklist` arguments that list every process with this image name. */
function tasklistArguments(imageName) {
  return ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'];
}

/** Human-readable diagnostics for the build log. */
function formatTasklistDiagnostics({ imageName, rows, output }) {
  const processes = rows ?? parseTasklistCsv(output);
  if (!processes || processes.length === 0) {
    return `[dks] tasklist: no ${imageName} process is running`;
  }
  const lines = processes.map((process) => {
    const session = [process.sessionName, process.sessionNumber].filter(Boolean).join(' ');
    const memory = process.memory ? ` ${process.memory}` : '';
    return `[dks]   pid ${process.pid} ${process.imageName}${session ? ` session ${session}` : ''}${memory}`.trimEnd();
  });
  return [`[dks] tasklist: ${processes.length} ${imageName} process(es) running`, ...lines].join('\n');
}

/**
 * PowerShell that prints `<pid>|<ExecutablePath>` for every process with the
 * image name. Win32_Process is the only listing that reports the FULL image
 * path, which is what makes the kill below path-exact.
 */
function windowsProcessListCommand(imageName) {
  const script = 'Get-CimInstance Win32_Process -Filter "Name='
    + `'${imageName}'" | ForEach-Object { "{0}|{1}" -f $_.ProcessId, $_.ExecutablePath }`;
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  };
}

/** Parse the `<pid>|<path>` lines printed by `windowsProcessListCommand`. */
function parseProcessPathList(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\|/.test(line))
    .map((line) => {
      const separator = line.indexOf('|');
      return {
        pid: Number(line.slice(0, separator)),
        executablePath: line.slice(separator + 1).trim() || null,
      };
    })
    .filter((entry) => Number.isFinite(entry.pid));
}

/**
 * Processes running the packaged executable itself.
 *
 * `supported: false` means the listing tool itself failed (no WMI, locked-down
 * runner). That is reported, never silently treated as "nothing is running" —
 * the caller still gates on the executable becoming writable.
 */
async function listProcessesFromExecutable({ exePath, imageName, run, log = () => {} }) {
  const spec = windowsProcessListCommand(imageName);
  const result = await run(spec.command, spec.args);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error || result.status !== 0) {
    log(`[dks] could not enumerate ${imageName} processes (${result.error ?? `exit ${String(result.status)}`}); `
      + 'falling back to the executable write check');
    return { supported: false, processes: [], output };
  }
  const all = parseProcessPathList(result.stdout);
  const wanted = lowerCasePath(exePath);
  const processes = all.filter((entry) => (
    entry.executablePath !== null && lowerCasePath(entry.executablePath) === wanted
  ));
  return { supported: true, processes, all, output };
}

/** Kill one process AND its children (`taskkill /T`), forcibly. */
async function killProcessTree(pid, { imageName = '', run, log = () => {} } = {}) {
  log(`[dks] killing ${imageName || 'process'} pid ${pid} and its child processes before rcedit`);
  const result = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  return {
    pid,
    ok: !result.error && result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/** Sleep that tests can replace. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Default "can rcedit rewrite this file?" probe: open it for writing. */
function openForWrite(filePath) {
  const descriptor = openSync(filePath, 'r+');
  closeSync(descriptor);
}

/**
 * Wait until `filePath` can be opened for writing.
 *
 * This is precisely rcedit's precondition: while any process runs from an
 * executable image, Windows refuses a write handle with a sharing violation.
 * `onRetry` receives every failed attempt so the build log shows what is
 * holding the file.
 */
async function waitForExecutableUnlocked(options) {
  const {
    exePath,
    timeoutMs = DEFAULT_UNLOCK_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    openFile = openForWrite,
    sleep = delay,
    onRetry,
    now = Date.now,
  } = options;
  const startedAt = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let failure = null;
    try {
      openFile(exePath);
    } catch (error) {
      failure = error;
    }
    if (!failure) {
      return { attempts, waitedMs: now() - startedAt };
    }
    if (now() - startedAt >= timeoutMs) {
      const waited = Math.round((now() - startedAt) / 1000);
      throw new Error(
        `[dks] ${path.basename(exePath)} is still in use after ${waited}s `
        + `(open for write failed ${attempts}×: ${failure.code ?? failure.message}). `
        + 'electron-builder edits the executable with rcedit right after afterPack, and rcedit '
        + 'fails with "Fatal error: Unable to commit changes" while any process still runs from it. '
        + 'A packaged-app probe or a DKS instance started from release\\win-unpacked did not exit — '
        + 'see the tasklist diagnostics above.',
      );
    }
    if (onRetry) {
      await onRetry({ attempt: attempts, error: failure, waitedMs: now() - startedAt });
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Block until nothing runs from the packaged executable and the file is
 * writable — the exact state rcedit requires.
 *
 * Windows: processes are enumerated by FULL image path and killed with
 * `taskkill /T /F`, so an installed DKS elsewhere on the machine is untouched.
 * Other platforms have no image lock; the write check still runs (it is cheap
 * and documents intent).
 */
async function releaseExecutableLock(options) {
  const {
    exePath,
    imageName = path.basename(exePath),
    platform = process.platform,
    run = spawnCaptureAsync,
    log = () => {},
    sleep = delay,
    openFile = openForWrite,
    tasklist = spawnCapture,
    processSweepTimeoutMs = DEFAULT_PROCESS_SWEEP_TIMEOUT_MS,
    unlockTimeoutMs = DEFAULT_UNLOCK_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
  } = options;

  const tasklistSnapshot = async (label) => {
    if (platform !== 'win32') {
      return [];
    }
    const args = tasklistArguments(imageName);
    const result = tasklist('tasklist.exe', args);
    log(formatTasklistDiagnostics({ imageName: `${imageName} (${label})`, output: result.stdout }));
    return parseTasklistCsv(result.stdout);
  };

  if (platform === 'win32') {
    const sweepStartedAt = now();
    let killed = 0;
    for (;;) {
      const listed = await listProcessesFromExecutable({ exePath, imageName, run, log });
      if (listed.supported && listed.processes.length === 0) {
        break;
      }
      if (!listed.supported) {
        break; // enumerated failure already logged; the write check below gates
      }
      for (const process of listed.processes) {
        const killedOne = await killProcessTree(process.pid, { imageName, run, log });
        if (killedOne.output) {
          log(`[dks] taskkill: ${killedOne.output}`);
        }
        killed += 1;
      }
      if (now() - sweepStartedAt >= processSweepTimeoutMs) {
        const stillRunning = listed.processes.map((process) => process.pid).join(', ');
        throw new Error(
          `[dks] a process started from ${exePath} (pid ${stillRunning}) did not exit after `
          + `${Math.round(processSweepTimeoutMs / 1000)}s of taskkill /T /F. `
          + 'rcedit cannot rewrite a running executable, so packaging stops here instead of '
          + 'failing later with "Fatal error: Unable to commit changes". Close DKS (tray → Quit) '
          + 'and retry the build.',
        );
      }
      await sleep(pollIntervalMs);
    }
    if (killed > 0) {
      log(`[dks] stopped ${killed} leftover ${imageName} process(es) from the packaged app before rcedit`);
    }
    await tasklistSnapshot('before rcedit');
  }

  const unlocked = await waitForExecutableUnlocked({
    exePath,
    timeoutMs: unlockTimeoutMs,
    pollIntervalMs,
    openFile,
    sleep,
    now,
    onRetry: async ({ attempt, error }) => {
      log(
        `[dks] ${path.basename(exePath)} still locked (attempt ${attempt}: `
        + `${error.code ?? error.message}) — waiting ${pollIntervalMs}ms before the next check`,
      );
      if (platform === 'win32' && (attempt === 1 || attempt % 8 === 0)) {
        await tasklistSnapshot(`while locked, attempt ${attempt}`);
      }
    },
  });
  log(
    `[dks] ${path.basename(exePath)} is writable (checked ${unlocked.attempts}×, `
    + `${unlocked.waitedMs}ms) — safe for rcedit`,
  );
  return unlocked;
}

/** Async spawn that captures output (used for taskkill / process listing). */
function spawnCaptureAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      finish({ status: null, stdout, stderr, error: String(error.message ?? error) });
    });
    child.once('close', (status) => {
      finish({ status, stdout, stderr, error: null });
    });
  });
}

/** Blocking spawn that captures output (diagnostics only). */
function spawnCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/** Kill a running child and everything it spawned. */
async function killChildTree(child, { platform = process.platform, log = () => {}, imageName = '' } = {}) {
  if (!child || child.pid === undefined) {
    return;
  }
  if (platform === 'win32') {
    await killProcessTree(child.pid, { imageName, run: spawnCaptureAsync, log });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Run a child to completion with a hard timeout, resolving only after its
 * stdio streams have closed (`close`, not `exit`) so no inherited pipe — and
 * with it no process — is left behind by the caller.
 *
 * On timeout the child tree is killed, and the promise resolves (not rejects)
 * with `timedOut: true` so callers keep one error-reporting path.
 */
async function runCapturedProcess(options) {
  const {
    command,
    args,
    env,
    cwd,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    platform = process.platform,
    log = () => {},
    imageName = '',
    spawnProcess = spawn,
    schedule = setTimeout,
    cancel = clearTimeout,
    killTree = killChildTree,
  } = options;

  const child = spawnProcess(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let closed = false;

  const closedPromise = new Promise((resolve) => {
    const finish = (status, error, signal) => {
      if (closed) {
        return;
      }
      closed = true;
      resolve({ status, error: error ?? null, signal: signal ?? null });
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => finish(null, String(error.message ?? error)));
    child.once('close', (status, signal) => finish(status, null, signal));
  });

  let timer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = schedule(async () => {
      if (closed) {
        return;
      }
      timedOut = true;
      log(`[dks] the ${imageName || path.basename(command)} probe exceeded ${timeoutMs}ms — killing it`);
      await killTree(child, { platform, log, imageName });
    }, timeoutMs);
  }

  const result = await closedPromise;
  if (timer) {
    cancel(timer);
  }

  return {
    status: result.status,
    signal: result.signal,
    spawnError: result.error,
    stdout,
    stderr,
    timedOut,
  };
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROCESS_SWEEP_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_UNLOCK_TIMEOUT_MS,
  delay,
  formatTasklistDiagnostics,
  killChildTree,
  killProcessTree,
  listProcessesFromExecutable,
  openForWrite,
  parseProcessPathList,
  parseTasklistCsv,
  releaseExecutableLock,
  runCapturedProcess,
  spawnCapture,
  spawnCaptureAsync,
  tasklistArguments,
  waitForExecutableUnlocked,
  windowsProcessListCommand,
};
