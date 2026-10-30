'use strict';

/**
 * "Can rcedit actually edit this file right now?"
 *
 * The guard used to answer a weaker question — can the file be opened for
 * writing? Measurement on a Windows runner showed the gap (see
 * `scripts/diagnostics/packaging-lock-probe.cjs`, experiments C and D):
 *
 *   another process holds the exe with FileShare.ReadWrite
 *     → open-for-write SUCCEEDS
 *     → rcedit FAILS ("Unable to load file")
 *
 * rcedit opens the image with no sharing at all, so *any* other open handle on
 * it — even a read-only one that grants read+write sharing — blocks it. The
 * precondition is therefore exclusive access, not writability.
 *
 * Node cannot ask for a share mode through `fs.open`: libuv always requests
 * FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE. So the exact check
 * goes through one `[System.IO.File]::Open(..., [System.IO.FileShare]::None)`
 * call. That is the same thing rcedit needs, and it is cheap to run once the
 * plainly-writable check has already succeeded.
 *
 * Everything here is best-effort: when the check cannot run (no PowerShell,
 * restricted policy, non-Windows) the caller is told so and must fall back to
 * the weaker guarantee — it must never turn a missing check into a failure.
 */

const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

/**
 * PowerShell that opens the file exactly like rcedit does.
 *
 * Prints `EXCLUSIVE` when the open succeeded (and closed it again) or
 * `BLOCKED|<exception type>|<message>` when another handle is in the way.
 * Exit code 3 means the check itself could not run.
 */
function exclusiveOpenScript() {
  return String.raw`
param([Parameter(Mandatory=$true)][string]$Path)

try {
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None)
} catch {
    $errorId = $_.Exception.GetType().Name
    $message = $_.Exception.Message -replace "\r?\n", " "
    Write-Output "BLOCKED|$errorId|$message"
    exit 0
}

try {
    $stream.Close()
} catch {
    # Closing a handle we opened cannot legitimately fail; report it rather
    # than pretending the check passed.
    Write-Output "BLOCKED|CloseFailed|$($_.Exception.Message)"
    exit 0
}

Write-Output "EXCLUSIVE"
exit 0
`;
}

/** Parse the `EXCLUSIVE` / `BLOCKED|...` answer. */
function parseExclusiveOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim());
  if (lines.includes('EXCLUSIVE')) {
    return { exclusive: true, reason: null };
  }
  const blocked = lines.find((line) => line.startsWith('BLOCKED|'));
  if (blocked) {
    const [, errorId, message] = blocked.split('|');
    return { exclusive: false, reason: `${errorId}: ${message ?? ''}`.trim() };
  }
  return { exclusive: null, reason: 'no answer from the exclusive-open check' };
}

/** Default runner: `powershell -File <script> -Path <file>`. */
function runPowerShell(scriptPath, filePath) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Path',
    filePath,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/**
 * Write the check once and reuse it: this runs inside a polling loop, so
 * creating a temp directory per attempt would be wasteful.
 */
function createExclusiveOpenProbe(options = {}) {
  const {
    platform = process.platform,
    run = runPowerShell,
    writeScript = exclusiveOpenScript,
    log = () => {},
  } = options;

  let scriptPath = null;
  let announced = false;

  return async function probe(filePath) {
    if (platform !== 'win32') {
      return { supported: false, exclusive: null, reason: 'not running on Windows' };
    }
    try {
      if (!scriptPath) {
        const dir = mkdtempSync(path.join(tmpdir(), 'dks-exclusive-'));
        scriptPath = path.join(dir, 'exclusive-open.ps1');
        writeFileSync(scriptPath, writeScript(), 'utf8');
      }
      const result = run(scriptPath, filePath);
      if (result.error) {
        if (!announced) {
          announced = true;
          log(`[dks] exclusive-access check unavailable (${result.error}) — continuing with the weaker writable check`);
        }
        return { supported: false, exclusive: null, reason: result.error };
      }
      if (result.status !== 0) {
        const reason = (result.stderr ?? '').trim() || `exit ${String(result.status)}`;
        if (!announced) {
          announced = true;
          log(`[dks] exclusive-access check unavailable (${reason}) — continuing with the weaker writable check`);
        }
        return { supported: false, exclusive: null, reason };
      }
      const parsed = parseExclusiveOutput(result.stdout);
      if (parsed.exclusive === null) {
        if (!announced) {
          announced = true;
          log(`[dks] exclusive-access check gave no answer (${parsed.reason}) — continuing with the weaker writable check`);
        }
        return { supported: false, exclusive: null, reason: parsed.reason };
      }
      return { supported: true, ...parsed };
    } catch (error) {
      const reason = String(error && error.message ? error.message : error);
      if (!announced) {
        announced = true;
        log(`[dks] exclusive-access check threw (${reason}) — continuing with the weaker writable check`);
      }
      return { supported: false, exclusive: null, reason };
    }
  };
}

/** One-shot check (used by the diagnostics probe). */
async function checkExclusiveAccess(filePath, options = {}) {
  const probe = createExclusiveOpenProbe(options);
  try {
    return await probe(filePath);
  } finally {
    const dir = options.tempDir;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

module.exports = {
  checkExclusiveAccess,
  createExclusiveOpenProbe,
  exclusiveOpenScript,
  parseExclusiveOutput,
  runPowerShell,
};
