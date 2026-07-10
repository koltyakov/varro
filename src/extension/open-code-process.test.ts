import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

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
    waitForProcessExitMock.mockResolvedValue(false);
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
    expect(listenerQueries).toBe(2);
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

    first.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstPath).not.toBe(secondPath);
    expect(JSON.parse(await readFile(secondPath, 'utf-8'))).toEqual({
      compaction: { auto: true, reserved: 4096 },
    });
    await manager.cleanupPreparedInjectedConfigFile();
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

    child.emit('exit', 0, null);
    await (manager as unknown as { injectedConfigOperation: Promise<void> })
      .injectedConfigOperation;

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
