'use strict';

/**
 * Who is holding this file open?
 *
 * `packaged-process-guard.cjs` waits until the packaged `DKS.exe` can be
 * opened for writing, because that is the state app-builder's rcedit needs.
 * When the wait fails it can say "still in use" but not *by what* — and the
 * v0.1.11 release failed exactly there, with rcedit's
 * "Fatal error: Unable to commit changes." and no record of the holder.
 *
 * The Restart Manager API is the right tool: `RmRegisterResources` +
 * `RmGetList` report every process that has the file open, which is the same
 * information Windows shows in the "file is in use by…" dialog. It needs no
 * extra download (unlike Sysinternals `handle.exe`) and it works for handles
 * opened read-only, read-write or with any sharing mode — including the
 * transient handles a virus scanner takes on a freshly written executable.
 *
 * Everything here is diagnostics: a failed lookup returns a reason and never
 * throws, so it can be called from the packaging path without changing what
 * the build does.
 */

const { spawnSync } = require('node:child_process');

/**
 * PowerShell that P/Invokes rstrtmgr.dll and prints one line per holder:
 *
 *   HOLDER|<pid>|<application type>|<app name>|<service>|<restartable>
 *
 * Exit codes: 0 = listed (possibly zero holders), 3 = the API failed,
 * 4 = bad arguments. Anything else is a PowerShell failure.
 */
function holdersScript() {
  return String.raw`
param([Parameter(Mandatory=$true)][string]$Path)

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class DksRestartManager
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmRegisterResources(
        uint pSessionHandle,
        uint nFiles,
        string[] rgsFilenames,
        uint nApplications,
        RM_UNIQUE_PROCESS[] rgApplications,
        uint nServices,
        string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(
        uint dwSessionHandle,
        out uint pnProcInfoNeeded,
        ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps,
        ref uint lpdwRebootReasons);
}
'@

try {
    Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null
} catch {
    Write-Error "Add-Type failed: $($_.Exception.Message)"
    exit 3
}

$session = 0
$key = [Guid]::NewGuid().ToString()
$result = [DksRestartManager]::RmStartSession([ref]$session, 0, $key)
if ($result -ne 0) {
    Write-Error "RmStartSession failed: $result"
    exit 3
}

try {
    $files = @((Resolve-Path -LiteralPath $Path).ProviderPath)
    $result = [DksRestartManager]::RmRegisterResources($session, [uint32]$files.Count, $files, 0, $null, 0, $null)
    if ($result -ne 0) {
        Write-Error "RmRegisterResources failed: $result"
        exit 3
    }

    $needed = 0
    $count = 0
    $reasons = 0
    $result = [DksRestartManager]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reasons)
    if ($result -eq 234) {
        $infos = New-Object 'DksRestartManager+RM_PROCESS_INFO[]' $needed
        $count = $needed
        $result = [DksRestartManager]::RmGetList($session, [ref]$needed, [ref]$count, $infos, [ref]$reasons)
        if ($result -ne 0) {
            Write-Error "RmGetList failed: $result"
            exit 3
        }
        for ($i = 0; $i -lt $count; $i++) {
            $info = $infos[$i]
            $restartable = if ($info.bRestartable) { 'restartable' } else { 'not-restartable' }
            "HOLDER|$($info.Process.dwProcessId)|$($info.ApplicationType)|$($info.strAppName)|$($info.strServiceShortName)|$restartable"
        }
    } elseif ($result -ne 0) {
        Write-Error "RmGetList failed: $result"
        exit 3
    }
} finally {
    [DksRestartManager]::RmEndSession($session) | Out-Null
}
exit 0
`;
}

/** Restart Manager `RM_APP_TYPE` values, for readable diagnostics. */
const APPLICATION_TYPES = Object.freeze({
  1000: 'unknown',
  1001: 'main-window',
  1002: 'other-window',
  1003: 'service',
  1004: 'explorer',
  1005: 'console',
  1006: 'critical',
});

/**
 * Parse the `HOLDER|...` lines. Unknown/short lines are ignored: this is
 * diagnostics, never a decision input.
 */
function parseHoldersOutput(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('HOLDER|'))
    .map((line) => {
      const [, pid, applicationType, appName, service, restartable] = line.split('|');
      const numericPid = Number(pid);
      if (!Number.isFinite(numericPid)) {
        return null;
      }
      return {
        pid: numericPid,
        applicationType: APPLICATION_TYPES[Number(applicationType)] ?? `type-${applicationType}`,
        appName: (appName ?? '').trim() || null,
        service: (service ?? '').trim() || null,
        restartable: restartable === 'restartable',
      };
    })
    .filter(Boolean);
}

/** One-line-per-holder summary for the build log. */
function formatHolders(filePath, holders) {
  if (!Array.isArray(holders) || holders.length === 0) {
    return `[dks] Restart Manager: no process holds ${filePath} open`;
  }
  const lines = holders.map((holder) => {
    const who = holder.appName ?? holder.service ?? 'unnamed process';
    return `[dks]   pid ${holder.pid} ${who} (${holder.applicationType}${holder.service ? `, service ${holder.service}` : ''})`;
  });
  return [
    `[dks] Restart Manager: ${holders.length} process(es) hold ${filePath} open`,
    ...lines,
  ].join('\n');
}

/** Default runner: `powershell -File` with the script written to a temp path. */
function runPowerShellScript(scriptPath, filePath) {
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
 * List the processes holding `filePath` open (Windows only).
 *
 * Returns `{ supported, holders, output, reason }`. `supported: false` means
 * the lookup itself could not run (no PowerShell, no rstrtmgr.dll, unsupported
 * platform) — callers log the reason and carry on.
 */
async function findFileHolders(filePath, options = {}) {
  const {
    platform = process.platform,
    run = null,
    writeScript = null,
    log = () => {},
  } = options;

  if (platform !== 'win32') {
    return { supported: false, holders: [], output: '', reason: 'not running on Windows' };
  }

  let scriptPath = null;
  try {
    scriptPath = writeScript ? writeScript(holdersScript()) : null;
    if (!scriptPath) {
      return { supported: false, holders: [], output: '', reason: 'no script writer injected' };
    }
    const result = (run ?? runPowerShellScript)(scriptPath, filePath);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (result.error) {
      log(`[dks] Restart Manager lookup failed (${result.error}) — continuing`);
      return { supported: false, holders: [], output, reason: result.error };
    }
    if (result.status !== 0) {
      const reason = (result.stderr ?? '').trim() || `exit ${String(result.status)}`;
      log(`[dks] Restart Manager lookup failed (${reason}) — continuing`);
      return { supported: false, holders: [], output, reason };
    }
    return { supported: true, holders: parseHoldersOutput(result.stdout), output, reason: null };
  } catch (error) {
    const reason = String(error && error.message ? error.message : error);
    log(`[dks] Restart Manager lookup threw (${reason}) — continuing`);
    return { supported: false, holders: [], output: '', reason };
  } finally {
    if (scriptPath) {
      try {
        require('node:fs').rmSync(scriptPath, { force: true });
      } catch {
        // best effort
      }
    }
  }
}

/** Write the Restart Manager script to a temporary file and return its path. */
function writeHoldersScript(script) {
  const { mkdtempSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'dks-holders-'));
  const scriptPath = path.join(dir, 'file-holders.ps1');
  writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

module.exports = {
  APPLICATION_TYPES,
  findFileHolders,
  formatHolders,
  holdersScript,
  parseHoldersOutput,
  runPowerShellScript,
  writeHoldersScript,
};
