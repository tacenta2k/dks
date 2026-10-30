import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

/**
 * R9 — the packaging lock behind
 *
 *   Fatal error: Unable to commit changes
 *
 * electron-builder runs `afterPack` and then immediately rewrites
 * `release\win-unpacked\DKS.exe` with rcedit. afterPack's own probe launches
 * that very executable (ELECTRON_RUN_AS_NODE) to prove the packaged
 * better-sqlite3 loads, so any probe process still alive when the hook returns
 * locks the image section and rcedit's EndUpdateResource fails. These tests
 * lock the hand-off in place:
 *
 *   - the probe is awaited to `close` and killed on timeout;
 *   - the hook waits until NOTHING runs from the packaged image (matched by
 *     full path, so an installed DKS elsewhere is never touched) and the file
 *     can be opened for writing — rcedit's exact precondition;
 *   - every wait is bounded and fails with a message that names the problem;
 *   - tasklist diagnostics are logged for every step.
 */

const ROOT = resolve(__dirname, '..');
const require2 = createRequire(import.meta.url);

interface Guard {
  DEFAULT_PROBE_TIMEOUT_MS: number;
  formatTasklistDiagnostics(input: { imageName: string; output?: string; rows?: unknown[] }): string;
  killProcessTree(pid: number, options: Record<string, unknown>): Promise<{ ok: boolean }>;
  listProcessesFromExecutable(options: Record<string, unknown>): Promise<{
    supported: boolean;
    processes: Array<{ pid: number; executablePath: string | null }>;
  }>;
  openForWrite(filePath: string): void;
  parseProcessPathList(output: string): Array<{ pid: number; executablePath: string | null }>;
  parseTasklistCsv(output: string): Array<{ imageName: string; pid: number }>;
  releaseExecutableLock(options: Record<string, unknown>): Promise<{
    attempts: number;
    waitedMs: number;
    exclusive?: { supported: boolean; exclusive: boolean | null; reason: string | null } | null;
    exclusiveUnavailable?: boolean;
  }>;
  runCapturedProcess(options: Record<string, unknown>): Promise<{
    status: number | null;
    signal: string | null;
    spawnError: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  tasklistArguments(imageName: string): string[];
  waitForExecutableUnlocked(options: Record<string, unknown>): Promise<{ attempts: number; waitedMs: number }>;
  windowsProcessListCommand(imageName: string): { command: string; args: string[] };
}

const guard = require2(join(ROOT, 'scripts', 'lib', 'packaged-process-guard.cjs')) as Guard;
const holdersModule = require2(join(ROOT, 'scripts', 'lib', 'file-holders.cjs')) as {
  formatHolders(filePath: string, holders: unknown[]): string;
  parseHoldersOutput(stdout: string): Array<{ pid: number; appName: string | null; applicationType: string; service: string | null }>;
  holdersScript(): string;
  findFileHolders(filePath: string, options?: Record<string, unknown>): Promise<{
    supported: boolean;
    holders: unknown[];
    reason: string | null;
  }>;
};

/**
 * The exclusive-access check spawns PowerShell, so it is stubbed everywhere;
 * the real semantics are covered by the dedicated tests below.
 */
const exclusiveOk = async () => ({ supported: true, exclusive: true, reason: null });

/** Holder lookups are stubbed everywhere: the real one spawns PowerShell. */
const noHolders = async () => ({ supported: true, holders: [] as unknown[], output: '', reason: null });

function readNormalised(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
}

const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

describe('packaged-process guard — Windows process listing', () => {
  it('parses tasklist CSV rows and reports them for the build log', () => {
    const output = [
      '"DKS.exe","7184","Console","1","78,912 K"',
      '"DKS.exe","8192","Console","1","12,345 K"',
      '',
      'INFO: No tasks are running which match the specified criteria.',
    ].join('\r\n');

    expect(guard.parseTasklistCsv(output)).toEqual([
      { imageName: 'DKS.exe', pid: 7184, sessionName: 'Console', sessionNumber: '1', memory: '78,912 K' },
      { imageName: 'DKS.exe', pid: 8192, sessionName: 'Console', sessionNumber: '1', memory: '12,345 K' },
    ]);

    const diagnostics = guard.formatTasklistDiagnostics({ imageName: 'DKS.exe (before rcedit)', output });
    expect(diagnostics).toContain('2 DKS.exe (before rcedit) process(es) running');
    expect(diagnostics).toContain('pid 7184 DKS.exe');
    expect(diagnostics).toContain('pid 8192 DKS.exe');

    // The "no tasks" INFO line is a diagnostic, never a fake process.
    expect(
      guard.formatTasklistDiagnostics({ imageName: 'DKS.exe', output: 'INFO: No tasks are running.' }),
    ).toContain('no DKS.exe process is running');
  });

  it('asks tasklist for exactly the packaged image name', () => {
    expect(guard.tasklistArguments('DKS.exe')).toEqual([
      '/FI',
      'IMAGENAME eq DKS.exe',
      '/FO',
      'CSV',
      '/NH',
    ]);
    const spec = guard.windowsProcessListCommand('DKS.exe');
    expect(spec.command).toBe('powershell.exe');
    expect(spec.args.join(' ')).toContain("Get-CimInstance Win32_Process -Filter \"Name='DKS.exe'\"");
    expect(spec.args.join(' ')).toContain('$_.ExecutablePath');
  });

  it('parses <pid>|<path> pairs and tolerates an unreadable path', () => {
    expect(guard.parseProcessPathList([
      '7184|C:\\build\\release\\win-unpacked\\DKS.exe',
      '8192|',
      'not a row',
    ].join('\r\n'))).toEqual([
      { pid: 7184, executablePath: 'C:\\build\\release\\win-unpacked\\DKS.exe' },
      { pid: 8192, executablePath: null },
    ]);
  });

  it('matches processes by FULL image path so an installed DKS is never killed', async () => {
    const packaged = 'C:\\build\\release\\win-unpacked\\DKS.exe';
    const installed = 'C:\\Users\\me\\AppData\\Local\\Programs\\DKS\\DKS.exe';
    const run = vi.fn(async () => ({
      status: 0,
      stdout: `7184|${packaged}\r\n9001|${installed}\r\n9002|\r\n`,
      stderr: '',
      error: null,
    }));

    const listed = await guard.listProcessesFromExecutable({
      exePath: packaged,
      imageName: 'DKS.exe',
      run,
    });

    expect(listed.supported).toBe(true);
    // Only the packaged copy is a lock on the file rcedit rewrites; a user's
    // running installed app shares the image NAME but not this path.
    expect(listed.processes).toEqual([{ pid: 7184, executablePath: packaged }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports an enumeration failure instead of silently assuming "nothing running"', async () => {
    const log = vi.fn();
    const listed = await guard.listProcessesFromExecutable({
      exePath: 'C:\\build\\release\\win-unpacked\\DKS.exe',
      imageName: 'DKS.exe',
      run: async () => ({ status: 1, stdout: '', stderr: 'Access denied', error: null }),
      log,
    });

    expect(listed.supported).toBe(false);
    expect(listed.processes).toEqual([]);
    expect(log.mock.calls.join('\n')).toContain('could not enumerate DKS.exe processes');
  });
});

describe('packaged-process guard — release before rcedit', () => {
  const exePath = 'C:\\build\\release\\win-unpacked\\DKS.exe';

  it('waits for the exe to become writable (the rcedit precondition)', async () => {
    const openFile = vi.fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      });
    const onRetry = vi.fn(async () => undefined);

    const result = await guard.waitForExecutableUnlocked({
      exePath,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      openFile,
      sleep: tick,
      onRetry,
    });

    expect(result.attempts).toBe(3);
    expect(openFile).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('fails with the rcedit symptom named when the lock never clears', async () => {
    const openFile = vi.fn(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    let clock = 0;

    await expect(guard.waitForExecutableUnlocked({
      exePath,
      timeoutMs: 2_000,
      pollIntervalMs: 500,
      openFile,
      sleep: async () => {
        clock += 500;
      },
      now: () => clock,
    })).rejects.toThrow(/still in use .*"Fatal error: Unable to commit changes"/s);
  });

  it('kills leftover processes from the packaged exe, logs tasklist, then verifies the lock', async () => {
    const log = vi.fn();
    const tasklist = vi.fn(() => ({
      status: 0,
      stdout: '"DKS.exe","7184","Console","1","78,912 K"',
      stderr: '',
      error: null,
    }));
    // First sweep sees the leftover probe; the next one sees a clean machine.
    let sweeps = 0;
    const run = vi.fn(async (command: string) => {
      if (command === 'taskkill.exe') {
        return { status: 0, stdout: 'SUCCESS: sent termination signal.', stderr: '', error: null };
      }
      sweeps += 1;
      return sweeps === 1
        ? { status: 0, stdout: `7184|${exePath}`, stderr: '', error: null }
        : { status: 0, stdout: '', stderr: '', error: null };
    });
    const openFile = vi.fn();

    const result = await guard.releaseExecutableLock({
      exePath,
      imageName: 'DKS.exe',
      platform: 'win32',
      run,
      log,
      sleep: tick,
      openFile,
      tasklist,
      findHolders: noHolders,
      writeHolders: () => null,
      exclusiveProbe: exclusiveOk,
      processSweepTimeoutMs: 5_000,
      unlockTimeoutMs: 5_000,
      pollIntervalMs: 0,
    });

    expect(result.attempts).toBe(1);
    expect(openFile).toHaveBeenCalledWith(exePath);
    // The leftover probe was killed by pid AND whole tree.
    expect(run).toHaveBeenCalledWith('taskkill.exe', ['/PID', '7184', '/T', '/F']);
    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('killing DKS.exe pid 7184 and its child processes before rcedit');
    expect(logged).toContain('stopped 1 leftover DKS.exe process(es)');
    expect(logged).toContain('tasklist:');
    expect(logged).toContain('pid 7184 DKS.exe');
    expect(logged).toContain('is writable');
    // tasklist is used for diagnostics, never for the kill decision.
    expect(tasklist).toHaveBeenCalledWith('tasklist.exe', guard.tasklistArguments('DKS.exe'));
  });

  it('kill-on-timeout: a process that will not die stops the build with a clear error', async () => {
    const log = vi.fn();
    let clock = 0;
    const run = vi.fn()
      // process listing always reports the same stuck probe
      .mockImplementation(async (command: string) => (
        command === 'powershell.exe'
          ? { status: 0, stdout: `7184|${exePath}`, stderr: '', error: null }
          : { status: 0, stdout: 'SUCCESS', stderr: '', error: null }
      ));

    const error = await guard.releaseExecutableLock({
      exePath,
      imageName: 'DKS.exe',
      platform: 'win32',
      run,
      log,
      sleep: async () => {
        clock += 250;
      },
      now: () => clock,
      openFile: vi.fn(),
      tasklist: vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })),
      findHolders: noHolders,
      writeHolders: () => null,
      exclusiveProbe: exclusiveOk,
      processSweepTimeoutMs: 1_000,
      unlockTimeoutMs: 1_000,
      pollIntervalMs: 250,
    }).then(
      () => null,
      (caught: Error) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error?.message ?? '';
    expect(message).toContain('did not exit after 1s of taskkill /T /F');
    expect(message).toContain('Unable to commit changes');
    expect(message).toContain('7184');

    // It really did try to kill the tree, repeatedly, before giving up.
    const taskkillCalls = run.mock.calls.filter((call) => call[0] === 'taskkill.exe');
    expect(taskkillCalls.length).toBeGreaterThan(1);
    expect(taskkillCalls[0][1]).toEqual(['/PID', '7184', '/T', '/F']);
  });

  it('is a no-op sweep outside Windows but still checks the file', async () => {
    const run = vi.fn();
    const openFile = vi.fn();
    const result = await guard.releaseExecutableLock({
      exePath: '/tmp/linux-unpacked/DKS',
      imageName: 'DKS',
      platform: 'linux',
      run,
      openFile,
      sleep: tick,
      pollIntervalMs: 0,
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.attempts).toBe(1);
    expect(openFile).toHaveBeenCalledWith('/tmp/linux-unpacked/DKS');
  });

  it('really opens the file for writing (rcedit needs write access, not read)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dks-lock-guard-'));
    const target = join(dir, 'DKS.exe');
    try {
      writeFileSync(target, 'image');
      expect(() => guard.openForWrite(target)).not.toThrow();
      expect(() => guard.openForWrite(join(dir, 'missing.exe'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('packaged-process guard — probe child lifecycle', () => {
  it('resolves only after the child stdout/stderr streams closed, not on exit', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const spawnProcess = vi.fn(() => child);

    const pending = guard.runCapturedProcess({
      command: 'DKS.exe',
      args: ['probe.cjs'],
      timeoutMs: 60_000,
      spawnProcess,
      killTree: vi.fn(),
    });

    child.stdout.write('DKS_OK=1\n');
    child.stdout.end();
    // `exit` alone must not resolve it: pipes may still hold the process.
    child.emit('exit', 0, null);
    await tick();
    child.emit('close', 0, null);

    const result = await pending;
    expect(result.stdout).toContain('DKS_OK=1');
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('kill-on-timeout: kills the child tree and reports the timeout', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 5150,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const killTree = vi.fn(async () => {
      // the kill is what finally closes the child
      child.emit('close', null, 'SIGKILL');
    });
    let fireTimeout: (() => void) | undefined;
    const log = vi.fn();

    const pending = guard.runCapturedProcess({
      command: 'DKS.exe',
      args: ['probe.cjs'],
      timeoutMs: 1_000,
      imageName: 'DKS.exe',
      spawnProcess: vi.fn(() => child),
      killTree,
      log,
      schedule: ((fn: () => void) => {
        fireTimeout = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      cancel: (() => undefined) as typeof clearTimeout,
    });

    await tick();
    fireTimeout?.();

    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(child, expect.objectContaining({ imageName: 'DKS.exe' }));
    expect(log.mock.calls.join('\n')).toContain('exceeded 1000ms — killing it');
  });

  it('uses a generous default timeout and captures a spawn failure', async () => {
    expect(guard.DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);

    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const pending = guard.runCapturedProcess({
      command: '/nope/DKS.exe',
      args: [],
      timeoutMs: 0,
      spawnProcess: vi.fn(() => child),
      killTree: vi.fn(),
    });
    await tick();
    child.emit('error', new Error('spawn ENOENT'));

    const result = await pending;
    expect(result.spawnError).toContain('ENOENT');
    expect(result.status).toBeNull();
  });
});

describe('after-pack hook wiring (R9)', () => {
  const hook = readNormalised('scripts/after-pack.cjs');
  const guardSource = readNormalised('scripts/lib/packaged-process-guard.cjs');

  it('awaits the packaged probe to full completion and never blocks the event loop', () => {
    // spawnSync would hold the hook until the child exits, but its pipes and
    // reaped process object meant the hook could return with the image still
    // mapped; the probe is now awaited to `close`.
    expect(hook).toContain('runCapturedProcess');
    expect(hook).not.toContain('spawnSync(electron');
    expect(hook).toContain('DKS_PROBE_TIMEOUT_MS');
    expect(guardSource).toContain("child.once('close'");
  });

  it('releases the executable lock before the hook returns (rcedit runs next)', () => {
    expect(hook).toContain('releaseExecutableLock');
    expect(hook).toContain('releasePackagedExecutable');
    // The guard runs on EVERY path: a failed probe must not leave a process
    // behind for rcedit either.
    const probeIndex = hook.indexOf('await probe(electron');
    const releaseIndex = hook.indexOf('await releasePackagedExecutable(electron)');
    const throwIndex = hook.indexOf('throw probeFailureError');
    expect(probeIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(probeIndex);
    expect(releaseIndex).toBeLessThan(throwIndex);
  });

  it('logs tasklist diagnostics and kills trees with taskkill /T /F', () => {
    expect(hook).toContain('logTasklist');
    expect(hook).toContain('formatTasklistDiagnostics');
    expect(guardSource).toContain("'taskkill.exe'");
    expect(guardSource).toContain("'/T'");
    expect(guardSource).toContain("'/F'");
    expect(guardSource).toContain('tasklist.exe');
  });

  it('is CRLF-safe and parseable on a Windows checkout', () => {
    const syntax = spawnSync(process.execPath, ['--check', join(ROOT, 'scripts/after-pack.cjs')], {
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    const guardSyntax = spawnSync(
      process.execPath,
      ['--check', join(ROOT, 'scripts/lib/packaged-process-guard.cjs')],
      { encoding: 'utf8' },
    );
    expect(guardSyntax.status, guardSyntax.stderr).toBe(0);
    expect(hook).not.toContain('\r');
  });
});

/**
 * Naming the holder.
 *
 * The v0.1.11 release failed with rcedit's "Fatal error: Unable to commit
 * changes." and the log could only say "the file was in use". The guard now
 * asks the Restart Manager API which process holds the file, and reports that
 * process — including when the wait ultimately fails.
 *
 * A lookup failure must never change what the build does, so every path is
 * covered here: unsupported platform, thrown error, non-zero exit, and a
 * holding process.
 */
describe('Restart Manager holder reporting', () => {
  const exePath = 'C:\\build\\release\\win-unpacked\\DKS.exe';

  it('parses holder lines into process identities', () => {
    const holders = holdersModule.parseHoldersOutput([
      'HOLDER|6260|1003|MsMpEng.exe||not-restartable',
      'HOLDER|7184|1001|DKS.exe||restartable',
      'HOLDER|9001|1005||DksUpdateSvc|not-restartable',
      'noise that must be ignored',
      'HOLDER|notapid|1001|x||restartable',
    ].join('\n'));

    expect(holders).toEqual([
      { pid: 6260, applicationType: 'service', appName: 'MsMpEng.exe', service: null, restartable: false },
      { pid: 7184, applicationType: 'main-window', appName: 'DKS.exe', service: null, restartable: true },
      { pid: 9001, applicationType: 'console', appName: null, service: 'DksUpdateSvc', restartable: false },
    ]);
  });

  it('formats an empty and a non-empty holder list for the build log', () => {
    expect(holdersModule.formatHolders(exePath, [])).toContain('no process holds');
    const formatted = holdersModule.formatHolders(exePath, [
      { pid: 6260, applicationType: 'service', appName: 'MsMpEng.exe', service: null, restartable: false },
    ]);
    expect(formatted).toContain('1 process(es) hold');
    expect(formatted).toContain('pid 6260 MsMpEng.exe (service)');
  });

  it('reports the holder while the file stays locked', async () => {
    const log = vi.fn();
    let ticks = 0;
    const findHolders = vi.fn(async () => ({
      supported: true,
      holders: [{ pid: 6260, applicationType: 'service', appName: 'MsMpEng.exe', service: null, restartable: false }],
      output: '',
      reason: null,
    }));
    const openFile = vi.fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });

    const result = await guard.releaseExecutableLock({
      exePath,
      imageName: 'DKS.exe',
      platform: 'win32',
      run: vi.fn(async () => ({ status: 0, stdout: '', stderr: '', error: null })),
      log,
      sleep: async () => {
        ticks += 1;
      },
      now: () => ticks * 250,
      openFile,
      tasklist: vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })),
      findHolders,
      writeHolders: () => 'C:\\temp\\holders.ps1',
      exclusiveProbe: exclusiveOk,
      unlockTimeoutMs: 5_000,
      pollIntervalMs: 250,
    });

    expect(result.attempts).toBe(2);
    expect(findHolders).toHaveBeenCalledWith(exePath, expect.objectContaining({ platform: 'win32' }));
    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('pid 6260 MsMpEng.exe');
  });

  it('names the holder in the error when the wait gives up', async () => {
    const log = vi.fn();
    let clock = 0;
    const error = await guard.releaseExecutableLock({
      exePath,
      imageName: 'DKS.exe',
      platform: 'win32',
      run: vi.fn(async () => ({ status: 0, stdout: '', stderr: '', error: null })),
      log,
      sleep: async () => {
        clock += 500;
      },
      now: () => clock,
      openFile: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
      tasklist: vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })),
      findHolders: async () => ({
        supported: true,
        holders: [{ pid: 6260, applicationType: 'service', appName: 'MsMpEng.exe', service: null, restartable: false }],
        output: '',
        reason: null,
      }),
      writeHolders: () => 'C:\\temp\\holders.ps1',
      exclusiveProbe: exclusiveOk,
      unlockTimeoutMs: 1_000,
      pollIntervalMs: 500,
    }).then(() => null, (caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('still in use');
    expect(error?.message).toContain('pid 6260 MsMpEng.exe');
  });

  it('a failing holder lookup never breaks the wait or hides the timeout', async () => {
    const log = vi.fn();
    let clock = 0;
    const result = await guard.releaseExecutableLock({
      exePath,
      imageName: 'DKS.exe',
      platform: 'win32',
      run: vi.fn(async () => ({ status: 0, stdout: '', stderr: '', error: null })),
      log,
      sleep: async () => {
        clock += 250;
      },
      now: () => clock,
      openFile: vi.fn()
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }),
      tasklist: vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })),
      findHolders: async () => {
        throw new Error('rstrtmgr.dll unavailable');
      },
      writeHolders: () => 'C:\\temp\\holders.ps1',
      exclusiveProbe: exclusiveOk,
      unlockTimeoutMs: 5_000,
      pollIntervalMs: 250,
    });

    expect(result.attempts).toBe(2);
    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Restart Manager lookup threw');
    expect(logged).toContain('is writable');
  });

  it('findFileHolders reports unsupported instead of throwing when the lookup cannot run', async () => {
    const log = vi.fn();
    const linux = await holdersModule.findFileHolders(exePath, { platform: 'linux', log });
    expect(linux).toMatchObject({ supported: false, holders: [] });

    // A caller that injects nothing still gets a real script written and run:
    // the lookup must never degrade to "cannot tell" just because the caller
    // did not pass a writer.
    let scriptSeen = '';
    const defaultWriter = await holdersModule.findFileHolders(exePath, {
      platform: 'win32',
      log,
      run: (scriptPath: string) => {
        scriptSeen = scriptPath;
        return { status: 0, stdout: '', stderr: '', error: null };
      },
    });
    expect(defaultWriter.supported).toBe(true);
    expect(defaultWriter.holders).toEqual([]);
    expect(scriptSeen).toMatch(/file-holders\.ps1$/);

    const failing = await holdersModule.findFileHolders(exePath, {
      platform: 'win32',
      log,
      writeScript: () => 'C:\\temp\\holders.ps1',
      run: () => ({ status: 1, stdout: '', stderr: 'Add-Type failed: access denied', error: null }),
    });
    expect(failing.supported).toBe(false);
    expect(failing.reason).toContain('Add-Type failed');
    expect(log.mock.calls.join('\n')).toContain('Restart Manager lookup failed');

    const success = await holdersModule.findFileHolders(exePath, {
      platform: 'win32',
      log,
      writeScript: () => 'C:\\temp\\holders.ps1',
      run: () => ({ status: 0, stdout: 'HOLDER|6260|1003|MsMpEng.exe||not-restartable', stderr: '', error: null }),
    });
    expect(success.supported).toBe(true);
    expect(success.holders).toHaveLength(1);
  });

  it('the generated PowerShell compiles: FILETIME is not imported ambiguously', () => {
    const script = holdersModule.holdersScript();
    // Add-Type fails with CS0104 when both namespaces are imported and the
    // struct says plain `FILETIME` — the first CI run of this lookup did
    // exactly that, so the failure mode is pinned here.
    expect(script).not.toContain('using System.Runtime.InteropServices.ComTypes;');
    expect(script).toContain('System.Runtime.InteropServices.ComTypes.FILETIME');
    expect(script).toContain('RmStartSession');
    expect(script).toContain('RmRegisterResources');
    expect(script).toContain('RmGetList');
    expect(script).toContain('RmEndSession');
  });
});

/**
 * Exclusive access is rcedit's real precondition.
 *
 * Measured on a Windows runner (scripts/diagnostics/packaging-lock-probe.cjs):
 * a third-party handle with FileShare.ReadWrite lets the open-for-write in the
 * old check succeed, and rcedit still fails — it opens the image with no
 * sharing at all. The guard therefore confirms exclusive access after the
 * cheap check, and never claims the weaker check is a guarantee.
 */
describe('exclusive access (rcedit\'s real precondition)', () => {
  const exePath = 'C:\\build\\release\\win-unpacked\\DKS.exe';
  const baseOptions = {
    exePath,
    imageName: 'DKS.exe',
    platform: 'win32' as const,
    run: async () => ({ status: 0, stdout: '', stderr: '', error: null }),
    tasklist: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    findHolders: noHolders,
    writeHolders: () => null,
  };

  it('keeps waiting while a handle blocks exclusive access, then confirms it', async () => {
    const log = vi.fn();
    let clock = 0;
    let answers = 0;
    const result = await guard.releaseExecutableLock({
      ...baseOptions,
      log,
      sleep: async () => {
        clock += 1_500;
      },
      now: () => clock,
      openFile: vi.fn(),
      exclusiveProbe: async () => {
        answers += 1;
        return answers === 1
          ? { supported: true, exclusive: false, reason: 'IOException: The process cannot access the file' }
          : { supported: true, exclusive: true, reason: null };
      },
      unlockTimeoutMs: 10_000,
      pollIntervalMs: 250,
    });

    expect(result.attempts).toBe(2);
    expect(result.exclusive).toMatchObject({ supported: true, exclusive: true });
    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('exclusive access is blocked');
    expect(logged).toContain("rcedit's precondition is confirmed");
    expect(logged).not.toContain('safe for rcedit');
  });

  it('fails with the exclusive-access reason when it never clears, naming the holder', async () => {
    let clock = 0;
    const error = await guard.releaseExecutableLock({
      ...baseOptions,
      log: vi.fn(),
      sleep: async () => {
        clock += 1_500;
      },
      now: () => clock,
      openFile: vi.fn(),
      exclusiveProbe: async () => ({
        supported: true,
        exclusive: false,
        reason: 'IOException: The process cannot access the file',
      }),
      findHolders: async () => ({
        supported: true,
        holders: [{ pid: 4242, applicationType: 'service', appName: 'MsMpEng.exe', service: null, restartable: false }],
        output: '',
        reason: null,
      }),
      unlockTimeoutMs: 3_000,
      pollIntervalMs: 250,
    }).then(() => null, (caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('exclusive access is blocked');
    expect(error?.message).toContain('pid 4242 MsMpEng.exe');
  });

  it('degrades to the weaker check when the probe cannot run — and says so', async () => {
    const log = vi.fn();
    const result = await guard.releaseExecutableLock({
      ...baseOptions,
      log,
      sleep: tick,
      openFile: vi.fn(),
      exclusiveProbe: async () => ({ supported: false, exclusive: null, reason: 'no PowerShell' }),
      unlockTimeoutMs: 5_000,
      pollIntervalMs: 250,
    });

    expect(result.exclusiveUnavailable).toBe(true);
    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('is writable');
    expect(logged).toContain('exclusive access could not be verified');
    expect(logged).toContain('rcedit can still fail');
    expect(logged).not.toContain("rcedit's precondition is confirmed");
  });

  it('does not run the exclusive check outside Windows', async () => {
    const exclusiveProbe = vi.fn();
    await guard.releaseExecutableLock({
      ...baseOptions,
      platform: 'linux',
      exePath: '/tmp/linux-unpacked/DKS',
      log: vi.fn(),
      sleep: tick,
      openFile: vi.fn(),
      exclusiveProbe,
      unlockTimeoutMs: 5_000,
      pollIntervalMs: 250,
    });
    expect(exclusiveProbe).not.toHaveBeenCalled();
  });
});
