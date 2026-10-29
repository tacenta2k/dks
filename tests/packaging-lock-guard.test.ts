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
  releaseExecutableLock(options: Record<string, unknown>): Promise<{ attempts: number; waitedMs: number }>;
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
