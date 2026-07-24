import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ServerUtils from './server-utils';

const { spawnMock, waitForProcessExitMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  waitForProcessExitMock: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })) },
  workspace: {},
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('./server-utils', async () => {
  const actual = await vi.importActual<typeof ServerUtils>('./server-utils');
  return { ...actual, waitForProcessExit: waitForProcessExitMock };
});

import {
  areCompactionSettingsEqual,
  getOpenCodeConfigPaths,
  normalizeCompactionSettings,
  OpenCodeProcess,
  sweepStaleInjectedConfigDirectories,
} from './open-code-process';

const originalPlatform = process.platform;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
const originalOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
// Linux caps PIDs well below this, so birth-identity tests cannot read a real /proc entry.
const MOCK_LINUX_PID = 1_073_741_824;

beforeEach(() => {
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  if (originalOpenCodeConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = originalOpenCodeConfigContent;
});

function mockLinuxLeaseProcess(options?: {
  birthIdentity?: () => string;
  commandLine?: string;
  executable?: string;
  lsofMissing?: boolean;
  parentPid?: number;
  pid?: number;
  port?: number;
}) {
  const pid = options?.pid ?? MOCK_LINUX_PID;
  const port = options?.port ?? 4096;
  spawnMock.mockImplementation((command: string, args: string[]) => {
    const result = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (command === 'lsof' && options?.lsofMissing) {
        result.emit('error', Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }));
        return;
      }
      if (command === 'lsof') {
        result.stdout.emit('data', Buffer.from(`${pid}\n`));
      } else if (command === 'ss') {
        result.stdout.emit(
          'data',
          Buffer.from(
            `LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:* users:(("opencode",pid=${pid},fd=3))\n`
          )
        );
      } else if (command === 'readlink') {
        result.stdout.emit('data', Buffer.from(`${options?.executable ?? '/usr/bin/opencode'}\n`));
      } else if (command === 'ps' && args.includes('ppid=')) {
        result.stdout.emit('data', Buffer.from(`${options?.parentPid ?? 1}\n`));
      } else if (command === 'ps' && args.includes('command=')) {
        result.stdout.emit(
          'data',
          Buffer.from(
            `${options?.commandLine ?? `${options?.executable ?? '/usr/bin/opencode'} serve --port ${options?.port ?? 4096}`}\n`
          )
        );
      } else if (command === 'ps' && args.includes('lstart=')) {
        result.stdout.emit(
          'data',
          Buffer.from(`${options?.birthIdentity?.() ?? 'Fri Jul 10 12:00:00 2026'}\n`)
        );
      }
      result.emit('close', 0);
    });
    return result;
  });
}

describe('normalizeCompactionSettings', () => {
  it('returns defaults for undefined input', () => {
    expect(normalizeCompactionSettings(undefined)).toEqual({ auto: null, reserved: null });
  });

  it('returns defaults for empty object', () => {
    expect(normalizeCompactionSettings({})).toEqual({ auto: null, reserved: null });
  });

  it('preserves boolean auto', () => {
    expect(normalizeCompactionSettings({ auto: true })).toEqual({ auto: true, reserved: null });
    expect(normalizeCompactionSettings({ auto: false })).toEqual({ auto: false, reserved: null });
  });

  it('treats truthy/falsy non-boolean auto as null', () => {
    expect(normalizeCompactionSettings({ auto: 1 as unknown as boolean })).toEqual({
      auto: null,
      reserved: null,
    });
    expect(normalizeCompactionSettings({ auto: 'yes' as unknown as boolean })).toEqual({
      auto: null,
      reserved: null,
    });
  });

  it('preserves valid non-negative integer reserved', () => {
    expect(normalizeCompactionSettings({ reserved: 0 })).toEqual({ auto: null, reserved: 0 });
    expect(normalizeCompactionSettings({ reserved: 5000 })).toEqual({
      auto: null,
      reserved: 5000,
    });
  });

  it('rejects negative reserved', () => {
    expect(normalizeCompactionSettings({ reserved: -1 })).toEqual({ auto: null, reserved: null });
  });

  it('rejects non-integer reserved', () => {
    expect(normalizeCompactionSettings({ reserved: 1.5 })).toEqual({ auto: null, reserved: null });
  });

  it('rejects NaN reserved', () => {
    expect(normalizeCompactionSettings({ reserved: NaN })).toEqual({ auto: null, reserved: null });
  });

  it('rejects non-number reserved', () => {
    expect(normalizeCompactionSettings({ reserved: '100' as unknown as number })).toEqual({
      auto: null,
      reserved: null,
    });
  });

  it('preserves both fields together', () => {
    expect(normalizeCompactionSettings({ auto: true, reserved: 1024 })).toEqual({
      auto: true,
      reserved: 1024,
    });
  });
});

describe('areCompactionSettingsEqual', () => {
  it('returns true for identical object reference', () => {
    const a = { auto: true, reserved: 100 };
    expect(areCompactionSettingsEqual(a, a)).toBe(true);
  });

  it('returns true for equal settings', () => {
    expect(
      areCompactionSettingsEqual({ auto: false, reserved: 0 }, { auto: false, reserved: 0 })
    ).toBe(true);
  });

  it('returns false when auto differs', () => {
    expect(
      areCompactionSettingsEqual({ auto: true, reserved: null }, { auto: false, reserved: null })
    ).toBe(false);
  });

  it('returns false when reserved differs', () => {
    expect(
      areCompactionSettingsEqual({ auto: null, reserved: 10 }, { auto: null, reserved: 20 })
    ).toBe(false);
  });

  it('returns false when auto is null vs boolean', () => {
    expect(
      areCompactionSettingsEqual({ auto: null, reserved: null }, { auto: true, reserved: null })
    ).toBe(false);
  });

  it('returns true when both are fully null', () => {
    expect(
      areCompactionSettingsEqual({ auto: null, reserved: null }, { auto: null, reserved: null })
    ).toBe(true);
  });
});

describe('OpenCodeProcess Windows termination', () => {
  it('taskkills only the known managed wrapper tree, then verifies the port is free', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    waitForProcessExitMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let listenerQueries = 0;
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'powershell.exe' && args.at(-1)?.includes('Get-NetTCPConnection')) {
          listenerQueries += 1;
          if (listenerQueries === 1) child.stdout.emit('data', Buffer.from('777\n'));
        } else if (command === 'powershell.exe') {
          child.stdout.emit('data', Buffer.from('opencode serve --port 4096\n'));
        }
        child.emit('close', 0);
      });
      return child;
    });
    const manager = new OpenCodeProcess(4096, true);
    const kill = vi.fn();
    const proc = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill,
      exitCode: null,
      signalCode: null,
    });

    await (
      manager as unknown as { terminateManagedProcess(proc: typeof proc): Promise<void> }
    ).terminateManagedProcess(proc);

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '123', '/T', '/F'],
      expect.anything()
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '777', '/T', '/F'],
      expect.anything()
    );
    expect(listenerQueries).toBeGreaterThanOrEqual(2);
  });

  it('kills a surviving cmd listener after the wrapper has already exited', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    waitForProcessExitMock.mockResolvedValue(true);
    let listening = true;
    const wrapper = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'cmd.exe') return wrapper;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const script = args.at(-1) || '';
        if (command === 'powershell.exe' && script.includes('Get-NetTCPConnection')) {
          if (listening) child.stdout.emit('data', Buffer.from('777\n'));
        } else if (command === 'powershell.exe' && script.includes('ParentProcessId')) {
          child.stdout.emit('data', Buffer.from('123\n'));
        } else if (command === 'taskkill.exe' && args[1] === '777') {
          listening = false;
        }
        child.emit('close', 0);
      });
      return child;
    });
    const manager = new OpenCodeProcess(4096, true, 'C:\\OpenCode\\opencode.cmd');
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    wrapper.exitCode = 0;
    wrapper.emit('exit', 0, null);
    await manager.releaseExitedProcess(wrapper);

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '123', '/T', '/F'],
      expect.anything()
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '777', '/T', '/F'],
      expect.anything()
    );
    expect(manager.process).toBeNull();
  });

  it('reports an unmanaged occupied port without terminating its listener', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'powershell.exe' && args.at(-1)?.includes('Get-NetTCPConnection')) {
          child.stdout.emit('data', Buffer.from('777\n'));
        }
        child.emit('close', 0);
      });
      return child;
    });
    const manager = new OpenCodeProcess(4096, true);

    await expect(manager.stopServerForRestart()).rejects.toThrow(
      'Port 4096 is occupied by a process Varro does not own'
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'taskkill.exe',
      expect.anything(),
      expect.anything()
    );
  });
});

describe('OpenCodeProcess startup termination', () => {
  it('terminates a surviving POSIX listener through its launch process group', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const wrapperPid = MOCK_LINUX_PID + 1;
    const listenerPid = MOCK_LINUX_PID + 2;
    let groupAlive = true;
    let listening = true;
    const child = Object.assign(new EventEmitter(), {
      pid: wrapperPid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === '/usr/bin/opencode-wrapper') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'lsof' && listening) {
          result.stdout.emit('data', Buffer.from(`${listenerPid}\n`));
        } else if (command === 'ps' && args.includes('pgid=')) {
          result.stdout.emit('data', Buffer.from(`${wrapperPid}\n`));
        }
        result.emit('close', 0);
      });
      return result;
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -wrapperPid) return true;
      if (signal === 0) {
        if (groupAlive) return true;
        throw Object.assign(new Error('no process group'), { code: 'ESRCH' });
      }
      if (signal === 'SIGKILL') {
        groupAlive = false;
        listening = false;
      }
      return true;
    });
    const manager = new OpenCodeProcess(4096, true, '/usr/bin/opencode-wrapper');
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    child.exitCode = 0;
    child.emit('exit', 0, null);
    const cleanup = manager.releaseExitedProcess(child);
    await vi.advanceTimersByTimeAsync(5_100);
    await cleanup;

    expect(kill).toHaveBeenCalledWith(-wrapperPid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-wrapperPid, 'SIGKILL');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/opencode-wrapper',
      ['serve', '--port', '4096'],
      expect.objectContaining({ detached: true })
    );
    expect(manager.process).toBeNull();
    kill.mockRestore();
  });

  it('allows a later cleanup attempt after bounded termination fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const child = Object.assign(new EventEmitter(), {
      pid: 124,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    spawnMock.mockReturnValue(child);
    const manager = new OpenCodeProcess(4096, true, 'opencode');
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const terminateManagedProcess = vi
      .fn()
      .mockRejectedValueOnce(new Error('process tree survived'))
      .mockResolvedValueOnce(undefined);
    (
      manager as unknown as {
        terminateManagedProcess: typeof terminateManagedProcess;
      }
    ).terminateManagedProcess = terminateManagedProcess;

    await expect(manager.terminateLaunchAttempt(child)).rejects.toThrow('process tree survived');
    expect(manager.process).toBe(child);

    await expect(manager.terminateLaunchAttempt(child)).resolves.toBeUndefined();
    expect(manager.process).toBeNull();
    expect(terminateManagedProcess).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCodeProcess server ownership leases', () => {
  it('lets an attached host claim after the owner relinquishes without reloading', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    let listening = true;
    let serverEnv: NodeJS.ProcessEnv | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation(
      (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'opencode') {
          serverEnv = options?.env;
          return child;
        }
        const result = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          if (command === 'lsof' && listening) {
            result.stdout.emit('data', Buffer.from('43210\n'));
          } else if (command === 'ps' && args.includes('comm=')) {
            result.stdout.emit('data', Buffer.from('/usr/local/bin/opencode\n'));
          } else if (command === 'ps' && args.includes('lstart=')) {
            result.stdout.emit('data', Buffer.from('Fri Jul 10 12:00:00 2026\n'));
          }
          result.emit('close', 0);
        });
        return result;
      }
    );
    const first = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    first.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    await expect(first.confirmManagedServerOwnership()).resolves.toBe(true);
    const lease = JSON.parse(await readFile(leasePath, 'utf-8')) as {
      pid: number;
      port: number;
      executable: string;
      birthIdentity: string;
      owner: string;
      host: string;
      state: string;
    };
    expect(lease).toEqual({
      version: 1,
      pid: 43_210,
      port: 4096,
      executable: '/usr/local/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: expect.stringMatching(/^[a-f0-9]{32}$/),
      host: expect.stringMatching(/^[a-f0-9]{32}$/),
      state: 'active',
      createdAt: expect.any(Number),
    });
    expect(serverEnv?.VARRO_SERVER_OWNER).toBe(lease.owner);

    const second = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    await expect(second.recoverManagedServerOwnership()).resolves.toBe(false);
    expect(second.managedProcess).toBe(false);
    expect(second.hasForeignActiveOwnership).toBe(true);

    await first.disposeProcess({ stopProcess: false });
    expect(child.kill).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toEqual(
      expect.objectContaining({ state: 'relinquished' })
    );

    await expect(
      Promise.all([second.refreshManagedServerOwnership(), second.refreshManagedServerOwnership()])
    ).resolves.toEqual([true, true]);
    expect(second.managedProcess).toBe(true);
    expect(second.hasForeignActiveOwnership).toBe(false);
    expect(second.managedProcessId).toBe(43_210);

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      listening = false;
      return true;
    });
    await second.stopServerForRestart();

    expect(kill).toHaveBeenCalledWith(43_210, 'SIGTERM');
    await expect(stat(leasePath)).rejects.toThrow();
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not signal a POSIX listener whose executable does not match the lease', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: 777,
        port: 4096,
        executable: '/owned/opencode',
        birthIdentity: 'linux:100',
        owner: 'owned-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'lsof') {
          result.stdout.emit('data', Buffer.from('777\n'));
        } else if (command === 'ps' && args.includes('comm=')) {
          result.stdout.emit('data', Buffer.from('/foreign/opencode\n'));
        }
        result.emit('close', 0);
      });
      return result;
    });
    const kill = vi.spyOn(process, 'kill');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);
    await expect(manager.stopServerForRestart()).rejects.toThrow(
      'Port 4096 is occupied by a process Varro does not own'
    );

    expect(kill).not.toHaveBeenCalled();
    await expect(stat(leasePath)).rejects.toThrow();
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('retries Windows ownership confirmation while the listener becomes visible', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    let listenerQueries = 0;
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'C:\\OpenCode\\opencode.exe') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const script = args.at(-1) || '';
        if (command === 'powershell.exe' && script.includes('Get-NetTCPConnection')) {
          listenerQueries += 1;
          if (listenerQueries > 1) result.stdout.emit('data', Buffer.from('43210\n'));
        } else if (command === 'powershell.exe' && script.includes('ExecutablePath')) {
          result.stdout.emit('data', Buffer.from('C:\\OpenCode\\opencode.exe\n'));
        } else if (command === 'powershell.exe' && script.includes('CreationDate')) {
          result.stdout.emit('data', Buffer.from('123456\n'));
        }
        result.emit('close', 0);
      });
      return result;
    });
    const manager = new OpenCodeProcess(
      4096,
      true,
      'C:\\OpenCode\\opencode.exe',
      false,
      undefined,
      leasePath
    );
    manager.launchServer({
      getWorkspaceCwd: () => undefined,
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    await expect(manager.confirmManagedServerOwnership()).resolves.toBe(true);

    expect(listenerQueries).toBe(2);
    expect(manager.managedProcess).toBe(true);
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toEqual(
      expect.objectContaining({ pid: 43_210, state: 'active' })
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('allows slow Windows process inspection to finish', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const inspectionKills: Array<ReturnType<typeof vi.fn>> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'C:\\OpenCode\\opencode.exe') return child;
      const kill = vi.fn();
      inspectionKills.push(kill);
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill,
      });
      setTimeout(() => {
        const script = args.at(-1) || '';
        if (script.includes('Get-NetTCPConnection')) {
          result.stdout.emit('data', Buffer.from('43210\n'));
        } else if (script.includes('ExecutablePath')) {
          result.stdout.emit('data', Buffer.from('C:\\OpenCode\\opencode.exe\n'));
        } else if (script.includes('CreationDate')) {
          result.stdout.emit('data', Buffer.from('123456\n'));
        }
        result.emit('close', 0);
      }, 3_000);
      return result;
    });
    const manager = new OpenCodeProcess(
      4096,
      true,
      'C:\\OpenCode\\opencode.exe',
      false,
      undefined,
      leasePath
    );
    manager.launchServer({
      getWorkspaceCwd: () => undefined,
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    const confirmation = manager.confirmManagedServerOwnership();
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(confirmation).resolves.toBe(true);
    expect(inspectionKills).toHaveLength(3);
    expect(inspectionKills.every((kill) => kill.mock.calls.length === 0)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  it('taskkills only a recovered Windows listener matching the lease', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: 777,
        port: 4096,
        executable: 'C:\\OpenCode\\opencode.exe',
        birthIdentity: 'win32:123456',
        owner: 'windows-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    let listening = true;
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const script = args.at(-1) || '';
        if (command === 'powershell.exe' && script.includes('Get-NetTCPConnection')) {
          if (listening) result.stdout.emit('data', Buffer.from('777\n'));
        } else if (command === 'powershell.exe' && script.includes('ExecutablePath')) {
          result.stdout.emit('data', Buffer.from('C:\\OpenCode\\opencode.exe\n'));
        } else if (command === 'powershell.exe' && script.includes('CreationDate')) {
          result.stdout.emit('data', Buffer.from('123456\n'));
        } else if (command === 'taskkill.exe') {
          listening = false;
        }
        result.emit('close', 0);
      });
      return result;
    });
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(true);
    await manager.stopServerForRestart();

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '777', '/T', '/F'],
      expect.anything()
    );
    await expect(stat(leasePath)).rejects.toThrow();
    await rm(directory, { recursive: true, force: true });
  });

  it('cleans a stale lease and restores the configured port', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: 998_877,
        port: 4100,
        executable: '/usr/local/bin/opencode',
        birthIdentity: 'linux:100',
        owner: 'stale-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    spawnMock.mockImplementation(() => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => result.emit('close', 0));
      return result;
    });
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    expect(manager.port).toBe(4100);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);

    expect(manager.port).toBe(4096);
    expect(manager.managedProcess).toBe(false);
    await expect(stat(leasePath)).rejects.toThrow();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects an old lease without a process birth identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: 777,
        port: 4100,
        executable: '/usr/bin/opencode',
        owner: 'old-nonce',
        createdAt: Date.now(),
      }),
      'utf-8'
    );

    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    expect(manager.port).toBe(4096);
    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);
    await expect(stat(leasePath)).rejects.toThrow();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a reused PID even when its listener and executable match', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:old-process',
        owner: 'reused-pid-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    mockLinuxLeaseProcess({ birthIdentity: () => 'new-process' });
    const kill = vi.spyOn(process, 'kill');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);

    expect(kill).not.toHaveBeenCalled();
    await expect(stat(leasePath)).rejects.toThrow();
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('rechecks birth identity immediately before signalling a matching executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:original-process',
        owner: 'signal-race-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    let birthQueries = 0;
    mockLinuxLeaseProcess({
      birthIdentity: () => (++birthQueries <= 2 ? 'original-process' : 'replacement-process'),
    });
    const kill = vi.spyOn(process, 'kill');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(true);

    await expect(manager.stopServerForRestart()).rejects.toThrow(
      'ownership lease no longer matches'
    );

    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('attaches as unmanaged while another extension host has an active lease', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const activeLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'active-nonce',
      host: 'active-host',
      state: 'active',
      createdAt: Date.now(),
    };
    await writeFile(leasePath, JSON.stringify(activeLease), 'utf-8');
    mockLinuxLeaseProcess();
    const kill = vi.spyOn(process, 'kill');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);
    expect(manager.managedProcess).toBe(false);
    expect(manager.hasForeignActiveOwnership).toBe(true);
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toEqual(activeLease);
    const readInstalledCliVersion = vi.fn().mockResolvedValue('2.0.0');
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    await manager.runMaintenanceTick({
      isDisposing: () => false,
      getStatus: () => ({ state: 'running', url: manager.url }),
      readInstalledCliVersion,
      maybeSuggestCliUpdate: vi.fn().mockResolvedValue(null),
      readHealthInfo: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }),
      hasActiveSessions: vi.fn().mockResolvedValue(false),
      recoverLegacyManagedServerOwnership: vi.fn().mockResolvedValue(false),
      restartServerForCliUpdate,
    });
    expect(readInstalledCliVersion).not.toHaveBeenCalled();
    expect(restartServerForCliUpdate).not.toHaveBeenCalled();
    await expect(manager.stopServerForRestart()).rejects.toThrow(
      'Port 4096 is occupied by a process Varro does not own'
    );
    expect(kill).not.toHaveBeenCalled();

    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('coalesces an immediate maintenance request while a check is running', async () => {
    const manager = new OpenCodeProcess(4096, false);
    let resolveInstalledVersion!: (version: string | null) => void;
    const installedVersion = new Promise<string | null>((resolve) => {
      resolveInstalledVersion = resolve;
    });
    const tick = vi.fn();
    const operation = manager.runMaintenanceTick({
      isDisposing: () => false,
      getStatus: () => ({ state: 'stopped' }),
      readInstalledCliVersion: () => installedVersion,
      maybeSuggestCliUpdate: vi.fn().mockResolvedValue(null),
      readHealthInfo: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }),
      hasActiveSessions: vi.fn().mockResolvedValue(false),
      recoverLegacyManagedServerOwnership: vi.fn().mockResolvedValue(false),
      restartServerForCliUpdate: vi.fn().mockResolvedValue(undefined),
    });

    manager.requestMaintenanceCheck(tick);
    expect(tick).not.toHaveBeenCalled();

    resolveInstalledVersion('1.0.0');
    await operation;

    expect(tick).toHaveBeenCalledOnce();
  });

  it('recovers and restarts an idle orphaned server created before ownership leases', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    mockLinuxLeaseProcess();
    const manager = new OpenCodeProcess(
      4096,
      true,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath
    );

    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    await manager.runMaintenanceTick({
      isDisposing: () => false,
      getStatus: () => ({ state: 'running', url: manager.url }),
      readInstalledCliVersion: vi.fn().mockResolvedValue('1.18.2'),
      maybeSuggestCliUpdate: vi.fn().mockResolvedValue(null),
      readHealthInfo: vi.fn().mockResolvedValue({ healthy: true, version: '1.17.18' }),
      hasActiveSessions: vi.fn().mockResolvedValue(false),
      recoverLegacyManagedServerOwnership: () => manager.recoverLegacyManagedServerOwnership(),
      restartServerForCliUpdate,
    });

    expect(manager.managedProcess).toBe(true);
    expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.17.18', '1.18.2');
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      state: 'active',
    });

    await rm(directory, { recursive: true, force: true });
  });

  it('does not recover ownership of a non-orphaned matching listener', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    mockLinuxLeaseProcess({ parentPid: 42 });
    const manager = new OpenCodeProcess(
      4096,
      true,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath
    );

    await expect(manager.recoverLegacyManagedServerOwnership()).resolves.toBe(false);
    expect(manager.managedProcess).toBe(false);
    await expect(readFile(leasePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });

    await rm(directory, { recursive: true, force: true });
  });

  it('falls back to ss when lsof is unavailable on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'fallback-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    mockLinuxLeaseProcess({ lsofMissing: true });
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledWith('ss', ['-ltnp'], expect.anything());

    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a recovered config path outside a direct managed tmp directory', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const victimDirectory = await mkdtemp(join(tmpdir(), 'varro-malicious-config-'));
    const victimConfig = join(victimDirectory, 'opencode.json');
    await writeFile(victimConfig, '{"keep":true}', 'utf-8');
    await writeFile(
      join(victimDirectory, 'owner.json'),
      JSON.stringify({ pid: MOCK_LINUX_PID, owner: 'malicious-path-nonce' }),
      'utf-8'
    );
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'malicious-path-nonce',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
        configPath: victimConfig,
      }),
      'utf-8'
    );
    mockLinuxLeaseProcess();
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);

    expect(
      (manager as unknown as { injectedConfigPath: string | null }).injectedConfigPath
    ).toBeNull();
    await expect(readFile(victimConfig, 'utf-8')).resolves.toBe('{"keep":true}');
    await expect(stat(leasePath)).rejects.toThrow();
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(victimDirectory, { recursive: true, force: true }),
    ]);
  });
});

describe('OpenCodeProcess config ownership', () => {
  it('uses the documented global config directory and all supported filenames on Windows', () => {
    expect(getOpenCodeConfigPaths({}, 'C:\\Users\\Andrew', 'win32')).toEqual([
      'C:\\Users\\Andrew\\.config\\opencode\\config.json',
      'C:\\Users\\Andrew\\.config\\opencode\\opencode.json',
      'C:\\Users\\Andrew\\.config\\opencode\\opencode.jsonc',
    ]);
  });

  it('binds exit cleanup to the config owned by that process', async () => {
    const first = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const second = Object.assign(new EventEmitter(), {
      pid: 102,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, {
      auto: true,
      reserved: 4096,
    });
    const callbacks = {
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    await manager.syncInjectedConfigFile();
    manager.launchServer(callbacks);
    const firstPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;
    manager.process = null;
    await manager.syncInjectedConfigFile();
    manager.launchServer(callbacks);
    const secondPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;
    (
      manager as unknown as {
        terminateManagedProcess: ReturnType<typeof vi.fn>;
      }
    ).terminateManagedProcess = vi.fn().mockResolvedValue(undefined);

    first.emit('exit', 1, null);
    await manager.releaseExitedProcess(first);

    expect(firstPath).not.toBe(secondPath);
    expect(JSON.parse(await readFile(secondPath, 'utf-8'))).toEqual({
      compaction: { auto: true, reserved: 4096 },
    });
    await manager.cleanupPreparedInjectedConfigFile();
  });

  it('refuses to overwrite a live tracked child', () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    spawnMock.mockReturnValue(child);
    const manager = new OpenCodeProcess(4096, true, 'opencode');
    const callbacks = {
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    expect(manager.launchServer(callbacks)).toBe(child);
    expect(() => manager.launchServer(callbacks)).toThrow(
      'Cannot launch OpenCode while a managed child is still running'
    );

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(manager.process).toBe(child);

    child.exitCode = 0;
    expect(() => manager.launchServer(callbacks)).toThrow(
      'Cannot launch OpenCode before the previous managed process tree is cleaned'
    );
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('preserves a child-owned config when disconnect leaves the child alive', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockReturnValueOnce(child);
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, { auto: true });
    await manager.syncInjectedConfigFile();
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const configPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;

    await manager.disposeProcess({ stopProcess: false });

    expect(child.kill).not.toHaveBeenCalled();
    await expect(stat(configPath)).resolves.toBeTruthy();
    await expect(readFile(join(dirname(configPath), 'owner.json'), 'utf-8')).resolves.toContain(
      '"pid":43210'
    );
    await rm(dirname(configPath), { recursive: true, force: true });
  });

  it('cleans a disconnected child-owned config when that child exits', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 43211,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockReturnValueOnce(child);
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, { auto: true });
    await manager.syncInjectedConfigFile();
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const configPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;
    await manager.disposeProcess({ stopProcess: false });
    (
      manager as unknown as {
        terminateManagedProcess: ReturnType<typeof vi.fn>;
      }
    ).terminateManagedProcess = vi.fn().mockResolvedValue(undefined);

    child.emit('exit', 0, null);
    await manager.releaseExitedProcess(child);

    await expect(stat(configPath)).rejects.toThrow();
  });

  it('does not create a temporary config until managed spawn preparation', async () => {
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, { auto: true });

    await manager.updateCompactionSettings(
      { auto: false, reserved: 2048 },
      {
        status: { state: 'stopped' },
        request: vi.fn(),
        restartManagedServerForCompactionSettings: vi.fn(),
      }
    );

    expect(
      (manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }).buildServerEnv()
        .OPENCODE_CONFIG
    ).toBeUndefined();
  });

  it('cleans prepared config when attaching to an existing server', async () => {
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, { auto: true });
    await manager.syncInjectedConfigFile();
    const configPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;

    await manager.prepareForHealthyExistingServer();

    await expect(stat(configPath)).rejects.toThrow();
  });

  it('cleans prepared config when spawn throws before returning a child', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, { auto: true });
    await manager.syncInjectedConfigFile();
    const configPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;

    expect(() =>
      manager.launchServer({
        getWorkspaceCwd: () => '/repo',
        onStdout: vi.fn(),
        onStderr: vi.fn(),
        onExit: vi.fn(),
        onError: vi.fn(),
      })
    ).toThrow('spawn failed');
    await (manager as unknown as { injectedConfigOperation: Promise<void> })
      .injectedConfigOperation;

    await expect(stat(configPath)).rejects.toThrow();
  });

  it('does not recursively delete through a managed-prefix directory symlink', async () => {
    const victimDirectory = await mkdtemp(join(tmpdir(), 'varro-config-victim-'));
    const victimConfig = join(victimDirectory, 'opencode.json');
    const linkedDirectory = join(
      tmpdir(),
      `varro-opencode-config-linked-${process.pid}-${Date.now()}`
    );
    await writeFile(victimConfig, '{"keep":true}', 'utf-8');
    await symlink(victimDirectory, linkedDirectory, 'dir');
    const manager = new OpenCodeProcess(4096, true, 'opencode');
    (manager as unknown as { injectedConfigPath: string | null }).injectedConfigPath = join(
      linkedDirectory,
      'opencode.json'
    );

    await manager.cleanupPreparedInjectedConfigFile();

    await expect(readFile(victimConfig, 'utf-8')).resolves.toBe('{"keep":true}');
    await rm(linkedDirectory, { force: true });
    await rm(victimDirectory, { recursive: true, force: true });
  });

  it('sweeps only stale temporary config directories', async () => {
    const stale = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    const live = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    const fresh = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 999_999 }), 'utf-8');
    await writeFile(join(live, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf-8');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(stale, old, old);
    await utimes(live, old, old);

    await sweepStaleInjectedConfigDirectories();

    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(live)).resolves.toBeTruthy();
    await expect(stat(fresh)).resolves.toBeTruthy();
    await Promise.all([
      rm(live, { recursive: true, force: true }),
      rm(fresh, { recursive: true, force: true }),
    ]);
  });
});
