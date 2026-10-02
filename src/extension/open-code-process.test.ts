/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These process-boundary tests deliberately model malformed config, OS results, child processes, and private lease state. */
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type * as FsPromises from 'fs/promises';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import type * as OsModule from 'os';
import { dirname, join, resolve as resolvePath } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import type { ManagedServerOwnershipLease } from '../shared/server-ownership';
import { asRecord } from '../shared/type-utils';
import { getPathVariableKey } from './util/server-path';
import type * as ServerUtils from './server-utils';
import { Service } from '@opencode/client/service';
import * as processInspection from './process-inspection';

const { loggerMock, spawnMock, vscodeMock, waitForProcessExitMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
  },
  spawnMock: vi.fn(),
  vscodeMock: {
    window: {
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
      showInformationMessage: vi.fn(() => Promise.resolve<string | undefined>(undefined)),
      showWarningMessage: vi.fn(() => Promise.resolve<string | undefined>(undefined)),
    },
    workspace: {
      workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
      getConfiguration: vi.fn(() => ({
        get: <T>(_key: string, fallback: T) => fallback,
      })),
    },
  },
  waitForProcessExitMock: vi.fn(),
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('@opencode/client/service', () => ({ Service: { discover: vi.fn() } }));
vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('cross-spawn', () => ({ default: spawnMock, spawn: spawnMock }));
vi.mock('./windows-process-inspector', () => ({
  WindowsProcessInspector: class {
    async read() {
      throw new Error('Native inspection unavailable in CIM fallback fixtures');
    }
  },
}));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises');
  if (process.platform !== 'win32') return actual;
  // Windows ignores POSIX creation modes. Model them for the Linux/macOS
  // ownership fixtures while retaining real files, symlinks, and atomic writes.
  const modes = new Map<string, number>();
  const mocked = {
    ...actual,
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      const [path, , options] = args;
      if (typeof path === 'string') {
        const key = resolvePath(path);
        const exists = await actual.stat(path).then(
          () => true,
          () => false
        );
        await actual.writeFile(...args);
        if (!exists)
          modes.set(key, typeof options === 'object' ? Number(options?.mode ?? 0o666) : 0o666);
      } else await actual.writeFile(...args);
    },
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      const [path, options] = args;
      const exists = await actual.stat(path).then(
        () => true,
        () => false
      );
      const result = await actual.mkdir(...args);
      if (!exists && typeof path === 'string')
        modes.set(
          resolvePath(path),
          typeof options === 'object' ? Number(options?.mode ?? 0o777) : 0o777
        );
      return result;
    },
    async chmod(...args: Parameters<typeof actual.chmod>) {
      await actual.chmod(...args);
      if (typeof args[0] === 'string') modes.set(resolvePath(args[0]), Number(args[1]));
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      await actual.rename(...args);
      if (typeof args[0] === 'string' && typeof args[1] === 'string') {
        const mode = modes.get(resolvePath(args[0]));
        if (mode !== undefined) modes.set(resolvePath(args[1]), mode);
        modes.delete(resolvePath(args[0]));
      }
    },
    async lstat(...args: Parameters<typeof actual.lstat>) {
      const info = await actual.lstat(...args);
      if (typeof args[0] === 'string' && !args[1]?.bigint) {
        const mode = modes.get(resolvePath(args[0]));
        if (mode !== undefined) info.mode = (Number(info.mode) & ~0o777) | mode;
      }
      return info;
    },
  };
  return { ...mocked, default: mocked };
});
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OsModule>('os');
  const root = `${actual.tmpdir()}/varro-process-tests-${process.pid}`;
  const mocked = { ...actual, tmpdir: () => root, homedir: () => `${root}/home` };
  return { ...mocked, default: mocked };
});
vi.mock('./server-utils', async () => {
  const actual = await vi.importActual<typeof ServerUtils>('./server-utils');
  return { ...actual, waitForProcessExit: waitForProcessExitMock };
});

import {
  areCompactionSettingsEqual,
  appendBoundedCliOutput,
  getOpenCodeConfigPaths,
  normalizeCompactionSettings,
  OpenCodeProcess,
  sweepStaleInjectedConfigDirectories,
  type UpgradeFailureReport,
} from './open-code-process';

const originalPlatform = process.platform;

async function requireFileSymlink(context: TestContext, target: string, link: string) {
  try {
    await symlink(target, link);
  } catch (error) {
    if (
      originalPlatform === 'win32' &&
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      context.skip('File symlinks require Windows Developer Mode or symlink privilege');
    }
    throw error;
  }
}
const originalGeteuid = Object.getOwnPropertyDescriptor(process, 'geteuid');
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
const originalOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalPath = process.env.PATH;
// Keep fake identities outside the real PID range and unique across concurrent test processes.
const MOCK_LINUX_PID = 1_073_000_000 + process.pid;
const MOCK_WINDOWS_PID = 100_000 + process.pid;

describe('appendBoundedCliOutput', () => {
  it('retains normal output and bounds noisy diagnostics to the latest mebibyte', () => {
    expect(appendBoundedCliOutput('first', ' second')).toBe('first second');

    const bounded = appendBoundedCliOutput('old'.repeat(500_000), `LATEST-${'x'.repeat(100)}`);
    expect(bounded.length).toBe(1024 * 1024);
    expect(bounded.startsWith('[earlier output truncated]\n')).toBe(true);
    expect(bounded.endsWith(`LATEST-${'x'.repeat(100)}`)).toBe(true);

    const updated = appendBoundedCliOutput(bounded, ' FINAL');
    expect(updated.length).toBe(1024 * 1024);
    expect(updated.endsWith(' FINAL')).toBe(true);
  });
});

describe('v2 shared service routing', () => {
  it('logs missing credentials and environment fallback once without exposing secrets', () => {
    const manager = new OpenCodeProcess(
      4096,
      false,
      '',
      false,
      undefined,
      join(tmpdir(), `varro-credential-diagnostic-${process.pid}.json`)
    );
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', '');
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'private-user');
    loggerMock.info.mockClear();
    try {
      expect(manager.serverAuthorization).toBeUndefined();
      expect(manager.serverAuthorization).toBeUndefined();
      expect(loggerMock.info).toHaveBeenCalledExactlyOnceWith(
        'No credentials for OpenCode were provided; connecting without authentication.'
      );

      vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'private-password');
      const authorization = `Basic ${Buffer.from('private-user:private-password').toString('base64')}`;
      expect(manager.serverAuthorization).toBe(authorization);
      expect(manager.serverAuthorization).toBe(authorization);
      expect(loggerMock.info).toHaveBeenCalledTimes(2);
      expect(loggerMock.info).toHaveBeenLastCalledWith(
        'Using OpenCode credentials from environment variables: OPENCODE_SERVER_PASSWORD=*; OPENCODE_SERVER_USERNAME=*'
      );
      const output = JSON.stringify(loggerMock.info.mock.calls);
      expect(output).not.toContain('private-password');
      expect(output).not.toContain('private-user');
      expect(output).not.toContain(authorization);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('discovers credentials for an existing v2 server before probing the CLI', async () => {
    const manager = new OpenCodeProcess(
      4096,
      true,
      '',
      false,
      undefined,
      join(tmpdir(), `varro-credential-test-${process.pid}.json`)
    );
    vi.mocked(Service.discover).mockResolvedValue({
      url: manager.url,
      auth: { type: 'basic', username: 'fixture-user', password: 'discovered-fixture-password' },
    });

    await manager.discoverServerCredentials();

    expect(manager.serverAuthorization).toBe(
      `Basic ${Buffer.from('fixture-user:discovered-fixture-password').toString('base64')}`
    );
    expect(manager.port).toBe(4096);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not use discovered credentials for a different endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varro-credential-discovery-'));
    const manager = new OpenCodeProcess(4096, true, '', false, undefined, join(root, 'lease.json'));
    const originalAuthorization = manager.serverAuthorization;
    vi.mocked(Service.discover).mockResolvedValue({
      url: 'http://127.0.0.1:43123',
      auth: { type: 'basic', username: 'opencode', password: 'other-fixture-password' },
    });
    vi.stubEnv('XDG_STATE_HOME', root);
    try {
      await manager.discoverServerCredentials();

      expect(manager.serverAuthorization).toBe(originalAuthorization);
      expect(manager.port).toBe(4096);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the registered service port and credentials without spawning a second runner', async () => {
    const manager = new OpenCodeProcess('auto', true, 'opencode2');
    manager.rememberInstalledCliVersion('2.0.6');
    vi.mocked(Service.discover).mockResolvedValue({
      url: 'http://127.0.0.1:43123',
      auth: { type: 'basic', username: 'opencode', password: 'fixture-password' },
    });

    expect(await manager.discoverSharedServer()).toBe(true);
    expect(manager.url).toBe('http://127.0.0.1:43123');
    expect(manager.serverAuthorization).toBe(
      `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(manager.managedProcess).toBe(false);
  });

  it.each(['2.0.5', '2.0.7'])(
    'shares validated %s service credentials between extension instances',
    async (version) => {
      const root = await mkdtemp(join(tmpdir(), 'varro-shared-credentials-'));
      vi.stubEnv('XDG_STATE_HOME', root);
      const registration = JSON.stringify({
        url: 'http://127.0.0.1:4096',
        pid: process.pid,
        version,
        password: 'shared-fixture-password',
      });
      await mkdir(join(root, 'opencode'));
      const path = join(root, 'opencode/service.json');
      await writeFile(path, registration);
      vi.mocked(Service.discover).mockRejectedValue(new Error('Unsupported discovery contract'));
      const authorization = `Basic ${Buffer.from('opencode:shared-fixture-password').toString('base64')}`;
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe(authorization);
        return Response.json({ version, pid: process.pid });
      });
      try {
        const managers = ['varro', 'openjet'].map(
          (name) =>
            new OpenCodeProcess(4096, true, '', false, undefined, join(root, `${name}.json`))
        );
        await Promise.all(managers.map((manager) => manager.discoverServerCredentials()));
        expect(managers.map((manager) => manager.serverAuthorization)).toEqual([
          authorization,
          authorization,
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await readFile(path, 'utf8')).toBe(registration);
        expect(spawnMock).not.toHaveBeenCalled();

        fetchMock.mockResolvedValue(Response.json({ version, pid: process.pid + 1 }));
        const stale = new OpenCodeProcess(
          4096,
          true,
          '',
          false,
          undefined,
          join(root, 'stale.json')
        );
        const previousAuthorization = stale.serverAuthorization;
        await stale.discoverServerCredentials();
        expect(stale.serverAuthorization).toBe(previousAuthorization);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('does not discover a v2 service for a v1 CLI', async () => {
    const manager = new OpenCodeProcess(4096, true, 'opencode');
    manager.rememberInstalledCliVersion('1.18.31');
    expect(await manager.discoverSharedServer()).toBe(false);
    expect(Service.discover).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'matching legacy service',
      host: '127.0.0.1',
      pid: process.pid,
      version: '2.0.5',
      status: 200,
      expected: true,
    },
    {
      name: 'different process',
      host: '127.0.0.1',
      pid: process.pid + 1,
      version: '2.0.5',
      status: 200,
      expected: false,
    },
    {
      name: 'different version',
      host: '127.0.0.1',
      pid: process.pid,
      version: '2.0.6',
      status: 200,
      expected: false,
    },
    {
      name: 'rejected credentials',
      host: '127.0.0.1',
      pid: process.pid,
      version: '2.0.5',
      status: 401,
      expected: false,
    },
    {
      name: 'remote registration',
      host: 'example.com',
      pid: process.pid,
      version: '2.0.5',
      status: 200,
      expected: false,
    },
  ])(
    'validates $name when the newer client cannot discover it',
    async ({ host, pid, version, status, expected }) => {
      const root = await mkdtemp(join(tmpdir(), 'varro-legacy-discovery-'));
      await mkdir(join(root, 'opencode'));
      const registration = JSON.stringify({
        url: `http://${host}:43123`,
        pid: process.pid,
        version: '2.0.5',
        password: 'legacy-fixture-password',
      });
      const path = join(root, 'opencode/service.json');
      await writeFile(path, registration);
      vi.stubEnv('XDG_STATE_HOME', root);
      vi.mocked(Service.discover).mockResolvedValue(undefined);
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ pid, version }), { status }));
      try {
        const manager = new OpenCodeProcess(
          'auto',
          true,
          'opencode2',
          false,
          undefined,
          join(root, 'lease.json')
        );
        manager.rememberInstalledCliVersion('2.0.6');
        expect(await manager.discoverSharedServer()).toBe(expected);
        expect(manager.port).toBe(expected ? 43123 : 4096);
        if (host === '127.0.0.1') {
          expect(fetchMock).toHaveBeenCalledWith(
            new URL('http://127.0.0.1:43123/api/status'),
            expect.objectContaining({
              headers: {
                Authorization: `Basic ${Buffer.from('opencode:legacy-fixture-password').toString('base64')}`,
              },
              redirect: 'error',
              signal: expect.any(AbortSignal),
            })
          );
        } else expect(fetchMock).not.toHaveBeenCalled();
        expect(await readFile(path, 'utf8')).toBe(registration);
        expect(spawnMock).not.toHaveBeenCalled();
        expect(manager.managedProcess).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('registers a new v2 server for nested CLI discovery', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockReturnValue(child);
    const manager = new OpenCodeProcess(4096, true, 'opencode2');
    manager.rememberInstalledCliVersion('2.0.6');
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    expect(spawnMock).toHaveBeenCalledWith(
      manager.resolveCommand(),
      ['serve', '--service', '--port', '4096'],
      expect.anything()
    );
  });
});

beforeEach(async () => {
  if (originalPlatform === 'win32')
    Object.defineProperty(process, 'geteuid', { value: () => 0, configurable: true });
  await mkdir(tmpdir(), { recursive: true, mode: 0o700 });
  vi.stubEnv('XDG_STATE_HOME', join(tmpdir(), 'state'));
  vi.stubEnv('LOCALAPPDATA', join(tmpdir(), 'appdata'));
  vi.mocked(Service.discover).mockReset();
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.XDG_CONFIG_HOME;
  vscodeMock.workspace.workspaceFolders = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalGeteuid) Object.defineProperty(process, 'geteuid', originalGeteuid);
  else Reflect.deleteProperty(process, 'geteuid');
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  if (originalOpenCodeConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = originalOpenCodeConfigContent;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

afterAll(async () => {
  await rm(tmpdir(), { recursive: true, force: true });
});

function mockLinuxLeaseProcess(options?: {
  birthIdentity?: (pid: number) => string;
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
      } else if (command === 'ps' && args.includes('lstart=')) {
        const queriedPid = Number(args[args.indexOf('-p') + 1]);
        result.stdout.emit(
          'data',
          Buffer.from(`${options?.birthIdentity?.(queriedPid) ?? 'Fri Jul 10 12:00:00 2026'}\n`)
        );
      }
      result.emit('close', 0);
    });
    return result;
  });
}

async function setAdoptedOwnership(
  manager: OpenCodeProcess,
  leasePath: string,
  birthIdentity = 'linux:Fri Jul 10 12:00:00 2026'
) {
  const api = manager as unknown as {
    hostOwner: string;
    ownershipLease: Record<string, unknown> | null;
  };
  const lease = {
    version: 1,
    pid: MOCK_LINUX_PID,
    port: 4096,
    executable: '/usr/bin/opencode',
    birthIdentity,
    owner: 'adopted-owner',
    host: api.hostOwner,
    state: 'active',
    createdAt: Date.now(),
  };
  await writeFile(leasePath, JSON.stringify(lease), 'utf-8');
  api.ownershipLease = lease;
  manager.managedProcess = true;
  return lease;
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

describe('OpenCodeProcess port validation', () => {
  it.each([0, -1, 1.5, 65_536, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid runtime port %s',
    (port) => {
      expect(() => new OpenCodeProcess(port, true)).toThrow('varro.server.port');
    }
  );

  it('accepts both valid port boundaries', () => {
    expect(new OpenCodeProcess(1, true).port).toBe(1);
    expect(new OpenCodeProcess(65_535, true).port).toBe(65_535);
  });

  it('never changes an explicitly configured port after a collision', () => {
    const manager = new OpenCodeProcess(65_534, true);

    expect(manager.tryAdvancePort()).toBe(false);
    expect(manager.port).toBe(65_534);
  });
});

describe('OpenCodeProcess Windows termination', () => {
  it('taskkills only the known managed wrapper tree, then verifies the port is free', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    waitForProcessExitMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let listenerQueries = 0;
    spawnMock.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'netstat.exe') {
          listenerQueries += 1;
          if (listenerQueries === 1)
            child.stdout.emit('data', Buffer.from('TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING 777\n'));
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
      manager as unknown as { terminateManagedProcess(proc: ChildProcess): Promise<void> }
    ).terminateManagedProcess(proc as unknown as ChildProcess);

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

  it('kills a surviving cmd listener without taskkilling its exited wrapper PID', async () => {
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
      if (command === 'C:\\OpenCode\\opencode.cmd') return wrapper;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const script = args.at(-1) || '';
        if (command === 'netstat.exe') {
          if (listening)
            child.stdout.emit('data', Buffer.from('TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING 777\n'));
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
    await manager.releaseExitedProcess(wrapper as unknown as ChildProcess);

    expect(wrapper.kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalledWith(
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
    spawnMock.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'netstat.exe') {
          child.stdout.emit('data', Buffer.from('TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING 777\n'));
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

describe('OpenCodeProcess update notification actions', () => {
  it.each([
    ['1.14.20', '1.14.22', 'opencode-ai'],
    ['2.0.0', '2.0.1', '@opencode%2Fcli'],
  ])('checks the registry for selected CLI %s', async (installed, latest, packageName) => {
    const manager = new OpenCodeProcess(4096, false);
    // A stale cache must not override the version passed by maintenance.
    manager.rememberInstalledCliVersion(installed.startsWith('1.') ? '2.0.0' : '1.14.20');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: latest })));

    await expect(manager.readLatestCliVersion(installed)).resolves.toBe(latest);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${packageName}/latest`,
      expect.any(Object)
    );
  });

  it('does not check for updates when no CLI is installed', async () => {
    const manager = new OpenCodeProcess(4096, false);
    vi.spyOn(manager, 'readInstalledCliVersion').mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(manager.readLatestCliVersion()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a registry release from another major version', async () => {
    const manager = new OpenCodeProcess(4096, false);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '2.0.1' }))
    );
    await expect(manager.readLatestCliVersion('1.14.20')).resolves.toBeNull();
  });

  it('does not promote or automatically upgrade v1 to v2', async () => {
    const manager = new OpenCodeProcess(4096, false, '/custom/opencode-v1');
    const upgradeRunningServer = vi.fn();
    const upgradeCli = vi.spyOn(manager, 'upgradeCli');
    await manager.maybeSuggestCliUpdate('1.14.20', {
      readLatestCliVersion: vi.fn().mockResolvedValue('2.0.1'),
      upgradeRunningServer,
      requestMaintenanceCheck: vi.fn(),
      getWorkspaceCwd: () => undefined,
      prepareForWindowsCliUpgrade: vi.fn(),
    });
    expect(upgradeRunningServer).not.toHaveBeenCalled();
    expect(upgradeCli).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('automatically updates the selected v2 CLI', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const manager = new OpenCodeProcess(4096, false, '/custom/opencode2');
    const upgradeCli = vi.spyOn(manager, 'upgradeCli').mockResolvedValue('');
    vi.spyOn(manager, 'readInstalledCliVersion').mockResolvedValue('2.0.1');
    await expect(
      manager.maybeSuggestCliUpdate('2.0.0', {
        readLatestCliVersion: vi.fn().mockResolvedValue('2.0.1'),
        upgradeRunningServer: vi.fn().mockResolvedValue(false),
        requestMaintenanceCheck: vi.fn(),
        getWorkspaceCwd: () => undefined,
        prepareForWindowsCliUpgrade: vi.fn(),
      })
    ).resolves.toBe('2.0.1');
    expect(upgradeCli).toHaveBeenCalledWith('2.0.1');
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('logs a rejected update action chain instead of leaving it unhandled', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');
    const manager = new OpenCodeProcess(4096, false);

    await manager.maybeSuggestCliUpdate('1.14.20', {
      readLatestCliVersion: vi.fn().mockResolvedValue('1.14.22'),
      upgradeRunningServer: vi.fn().mockRejectedValue(new Error('upgrade endpoint failed')),
      requestMaintenanceCheck: vi.fn(),
      getWorkspaceCwd: () => undefined,
      prepareForWindowsCliUpgrade: vi.fn().mockResolvedValue(undefined),
    });

    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to handle OpenCode CLI update notification action: upgrade endpoint failed'
      );
    });
  });

  it('logs a rejected failure-notification action chain instead of leaving it unhandled', async () => {
    vscodeMock.window.showWarningMessage.mockResolvedValueOnce('Update in Terminal');
    const manager = new OpenCodeProcess(4096, false);
    const failure: UpgradeFailureReport = {
      cause: 'permission denied',
      kind: 'permission-denied',
      installMethod: 'npm',
      guidance: 'Use the npm install command instead.',
      suggestedCommand: 'npm install -g opencode-ai@latest',
    };
    const notificationCallbacks = {
      readLatestCliVersion: vi.fn().mockResolvedValue(null),
      upgradeRunningServer: vi.fn().mockResolvedValue(false),
      requestMaintenanceCheck: vi.fn(),
      getWorkspaceCwd: () => undefined,
      prepareForWindowsCliUpgrade: vi.fn().mockRejectedValue(new Error('active sessions')),
    };

    (
      manager as unknown as {
        reportFailedBackgroundUpgrade: (
          latestCliVersion: string,
          failure: UpgradeFailureReport,
          callbacks: typeof notificationCallbacks
        ) => void;
      }
    ).reportFailedBackgroundUpgrade('1.14.22', failure, notificationCallbacks);

    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to handle OpenCode CLI update failure notification action: active sessions'
      );
    });
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
    const cleanup = manager.releaseExitedProcess(child as unknown as ChildProcess);
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
    const childProcess = child as unknown as ChildProcess;

    await expect(manager.terminateLaunchAttempt(childProcess)).rejects.toThrow(
      'process tree survived'
    );
    expect(manager.process).toBe(child);

    await expect(manager.terminateLaunchAttempt(childProcess)).resolves.toBeUndefined();
    expect(manager.process).toBeNull();
    expect(terminateManagedProcess).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCodeProcess server ownership leases', () => {
  describe('credential-backed shared-service replacement', () => {
    async function fixture(automaticKey = false) {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-credential-replacement-'));
      vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
      const directory = join(root, 'servers');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `varro-opencode-server-${automaticKey ? 4096 : 4196}.json`);
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID + 1,
        port: 4196,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'original-launch',
        host: 'original-editor',
        state: 'relinquished',
        createdAt: Date.now() - 1000,
        password: 'fixture-varro-password',
        configPath: join(root, 'retired-config/opencode.json'),
      };
      await writeFile(path, JSON.stringify(lease), { mode: 0o600 });
      await writeFile(`${path}.managed`, JSON.stringify(lease), { mode: 0o600 });
      mockLinuxLeaseProcess({ port: 49374 });
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (pid === lease.pid) throw Object.assign(new Error('retired'), { code: 'ESRCH' });
        return true;
      });
      const account = vi.spyOn(processInspection, 'inspectLocalServerAccount').mockResolvedValue({
        kind: 'same-user',
        identity: `${MOCK_LINUX_PID}:${lease.birthIdentity}:1000`,
      });
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, options) =>
          options?.headers
            ? new Response(JSON.stringify({ pid: MOCK_LINUX_PID, version: '2.0.21' }))
            : new Response(null, { status: 401 })
        );
      vi.mocked(Service.discover).mockResolvedValue({
        url: 'http://127.0.0.1:49374',
        auth: { type: 'basic', username: 'opencode', password: lease.password! },
      });
      const manager = new OpenCodeProcess('auto', true);
      manager.rememberInstalledCliVersion('2.0.21');
      await expect(manager.discoverSharedServer()).resolves.toBe(true);
      return { root, directory, path, lease, manager, kill, account, fetchMock };
    }

    it.each(['different-key', 'automatic-key', 'reused-pid', 'multiple-retired-records'])(
      'recovers a replacement through %s without restarting or carrying obsolete config',
      async (mode) => {
        const state = await fixture(mode === 'automatic-key');
        const { root, path, lease, manager, kill, fetchMock } = state;
        let selectedPath = path;
        try {
          if (mode === 'reused-pid') {
            kill.mockImplementation(() => true);
            vi.spyOn(processInspection, 'readProcessBirthIdentity').mockImplementation(
              async (pid) => (pid === lease.pid ? 'linux:a-reused-pid' : lease.birthIdentity)
            );
          }
          if (mode === 'multiple-retired-records') {
            selectedPath = join(state.directory, 'varro-opencode-server-4197.json');
            await writeFile(
              selectedPath,
              JSON.stringify({ ...lease, owner: 'newer-launch', createdAt: lease.createdAt + 1 }),
              { mode: 0o600 }
            );
          }
          await expect(manager.refreshDiscoveredServerRegistration()).resolves.toBe(true);
          const recovered = JSON.parse(
            await readFile(selectedPath, 'utf8')
          ) as ManagedServerOwnershipLease;
          expect(recovered).toMatchObject({
            pid: MOCK_LINUX_PID,
            port: 49374,
            password: lease.password,
            portMode: 'auto',
            state: 'active',
          });
          expect(recovered.owner).not.toBe(lease.owner);
          expect(recovered.configPath).toBeUndefined();
          await (
            manager as unknown as {
              clearManagedServerOwnership: (owner: string, host: string) => Promise<void>;
            }
          ).clearManagedServerOwnership(lease.owner, lease.host);
          expect(JSON.parse(await readFile(selectedPath, 'utf8'))).toEqual(recovered);
          expect(manager.serverOwnership).toBe('current-host');
          expect(manager.managedProcessId).toBe(MOCK_LINUX_PID);
          await expect(manager.verifyManagedServerConnection(true)).resolves.toBeUndefined();
          expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:49374/api/info',
            expect.objectContaining({
              headers: {
                Authorization: `Basic ${Buffer.from(`opencode:${lease.password}`).toString('base64')}`,
              },
              redirect: 'error',
            })
          );
          await expect(stat(`${selectedPath}.claim`)).rejects.toMatchObject({ code: 'ENOENT' });
          if (mode === 'multiple-retired-records')
            expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
          await manager.disposeProcess({ stopProcess: false });
          const reconnected = new OpenCodeProcess('auto', true);
          reconnected.rememberInstalledCliVersion('2.0.21');
          await reconnected.discoverSharedServer();
          await expect(reconnected.refreshDiscoveredServerRegistration()).resolves.toBe(true);
          await expect(reconnected.recoverManagedServerOwnership()).resolves.toBe(true);
          expect(reconnected.serverOwnership).toBe('current-host');
          expect(
            (reconnected as unknown as { ownershipLeasePath: string }).ownershipLeasePath
          ).toBe(selectedPath);
          expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
          expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain(lease.password);
          await reconnected.disposeProcess({ stopProcess: false });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    );

    it.each([
      'wrong-password',
      'wrong-username',
      'anonymous-access',
      'rejected-password',
      'wrong-http-pid',
      'foreign-user',
      'unknown-user',
      'live-original',
      'unknown-original',
      'wrong-executable',
      'missing-record',
      'public-record',
      'busy-claim',
      'changed-listener',
      'changed-record',
    ])('does not recover a replacement with %s evidence', async (mode) => {
      const { root, path, lease, manager, kill, account, fetchMock } = await fixture();
      try {
        if (mode === 'wrong-password' || mode === 'wrong-username' || mode === 'wrong-executable') {
          const altered = { ...lease };
          if (mode === 'wrong-password') altered.password = 'unrelated-password';
          if (mode === 'wrong-username') altered.username = 'another-user';
          if (mode === 'wrong-executable') altered.executable = '/other/opencode';
          await writeFile(path, JSON.stringify(altered));
        }
        if (mode === 'anonymous-access') fetchMock.mockResolvedValue(new Response('{}'));
        if (mode === 'rejected-password')
          fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
        if (mode === 'wrong-http-pid')
          fetchMock.mockImplementation(async (_url, options) =>
            options?.headers
              ? new Response(JSON.stringify({ pid: MOCK_LINUX_PID + 2, version: '2.0.21' }))
              : new Response(null, { status: 401 })
          );
        if (mode === 'foreign-user')
          account.mockResolvedValue({ kind: 'different-user', identity: 'foreign' });
        if (mode === 'unknown-user') account.mockResolvedValue({ kind: 'unknown' });
        if (mode === 'live-original' || mode === 'unknown-original')
          kill.mockImplementation(() => true);
        if (mode === 'unknown-original')
          vi.spyOn(processInspection, 'readProcessBirthIdentity').mockImplementation(async (pid) =>
            pid === lease.pid ? '' : lease.birthIdentity
          );
        if (mode === 'missing-record') await rm(path);
        if (mode === 'public-record') await chmod(path, 0o644);
        if (mode === 'busy-claim')
          await writeFile(
            `${path}.claim`,
            JSON.stringify({
              version: 1,
              host: 'busy-editor',
              hostPid: process.pid,
              createdAt: Date.now(),
            }),
            { mode: 0o600 }
          );
        if (mode === 'changed-listener')
          account
            .mockResolvedValueOnce({
              kind: 'same-user',
              identity: `${MOCK_LINUX_PID}:${lease.birthIdentity}:1000`,
            })
            .mockResolvedValue({ kind: 'same-user', identity: 'replacement-listener' });
        if (mode === 'changed-record')
          fetchMock.mockImplementation(async (_url, options) => {
            if (!options?.headers) return new Response(null, { status: 401 });
            await writeFile(path, JSON.stringify({ ...lease, owner: 'competing-owner' }));
            return new Response(JSON.stringify({ pid: MOCK_LINUX_PID, version: '2.0.21' }));
          });
        const before = await readFile(path, 'utf8').catch(() => null);
        const marker = await readFile(`${path}.managed`, 'utf8');
        if (['public-record', 'busy-claim', 'changed-listener', 'changed-record'].includes(mode))
          await expect(manager.refreshDiscoveredServerRegistration()).rejects.toThrow();
        else await expect(manager.refreshDiscoveredServerRegistration()).resolves.toBe(false);
        expect(manager.serverOwnership).toBe('unmanaged');
        if (mode !== 'changed-record')
          expect(await readFile(path, 'utf8').catch(() => null)).toBe(before);
        expect(await readFile(`${path}.managed`, 'utf8')).toBe(marker);
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.each(['during-authentication', 'before-publication', 'during-publication'])(
      'does not retain active ownership after cancellation %s',
      async (stage) => {
        const { root, path, lease, manager, account, fetchMock } = await fixture();
        const controller = new AbortController();
        const before = await readFile(path, 'utf8');
        const identity = {
          kind: 'same-user' as const,
          identity: `${MOCK_LINUX_PID}:${lease.birthIdentity}:1000`,
        };
        try {
          if (stage === 'during-authentication')
            fetchMock.mockImplementation(async (_url, options) => {
              if (!options?.headers) return new Response(null, { status: 401 });
              controller.abort(new Error('cancelled'));
              return new Response(JSON.stringify({ pid: MOCK_LINUX_PID, version: '2.0.21' }));
            });
          if (stage === 'before-publication')
            account.mockResolvedValueOnce(identity).mockImplementation(async () => {
              controller.abort(new Error('cancelled'));
              return identity;
            });
          if (stage === 'during-publication') {
            const privateManager = manager as unknown as {
              writeOwnershipLease: (value: ManagedServerOwnershipLease) => Promise<void>;
            };
            const writeLease = privateManager.writeOwnershipLease.bind(privateManager);
            vi.spyOn(privateManager, 'writeOwnershipLease').mockImplementation(async (value) => {
              await writeLease(value);
              if (value.state === 'active') controller.abort(new Error('cancelled'));
            });
          }
          await expect(
            manager.refreshDiscoveredServerRegistration(controller.signal)
          ).rejects.toThrow('cancelled');
          expect(manager.serverOwnership).toBe('unmanaged');
          if (stage === 'during-publication')
            expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
              pid: MOCK_LINUX_PID,
              port: 49374,
              state: 'relinquished',
            });
          else expect(await readFile(path, 'utf8')).toBe(before);
          await expect(stat(`${path}.claim`)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    );

    it('coordinates competing editors through one original recovery path', async () => {
      const { root, path, manager, kill } = await fixture();
      const contender = new OpenCodeProcess('auto', true);
      contender.rememberInstalledCliVersion('2.0.21');
      await contender.discoverSharedServer();
      try {
        const results = await Promise.allSettled([
          manager.refreshDiscoveredServerRegistration(),
          contender.refreshDiscoveredServerRegistration(),
        ]);
        expect(results.some((result) => result.status === 'fulfilled' && result.value)).toBe(true);
        for (const editor of [manager, contender]) {
          await expect(editor.refreshDiscoveredServerRegistration()).resolves.toBe(true);
          if (editor.hasOwnershipLeaseCandidate) await editor.recoverManagedServerOwnership();
          expect((editor as unknown as { ownershipLeasePath: string }).ownershipLeasePath).toBe(
            path
          );
        }
        expect(new Set([manager.serverOwnership, contender.serverOwnership])).toEqual(
          new Set(['current-host', 'other-host'])
        );
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        expect(
          (await readdir(join(root, 'servers'))).filter((name) => name.endsWith('.json'))
        ).toEqual(['varro-opencode-server-4196.json']);
        await manager.disposeProcess({ stopProcess: false });
        await contender.disposeProcess({ stopProcess: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it.each(['persistent', 'legacy'])(
    'keeps %s discovery ownership on the same path across editor reconnects',
    async (location) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-reconnect-discovery-'));
      vi.stubEnv('XDG_STATE_HOME', root);
      const directory = location === 'legacy' ? tmpdir() : join(root, 'varro', 'servers');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'varro-opencode-server-4194.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 49374,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'original-launch',
        host: 'original-editor',
        state: 'active',
        createdAt: Date.now(),
        password: 'unchanged-password',
      };
      const raw = JSON.stringify(lease);
      await writeFile(path, raw, { mode: 0o600 });
      mockLinuxLeaseProcess({ port: lease.port });
      try {
        for (let editor = 0; editor < 2; editor += 1) {
          const manager = new OpenCodeProcess('auto', true);
          manager.port = lease.port;
          await expect(manager.refreshDiscoveredServerRegistration()).resolves.toBe(true);
          await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);
          expect(manager.serverOwnership).toBe('other-host');
          expect((manager as unknown as { ownershipLeasePath: string }).ownershipLeasePath).toBe(
            path
          );
          await manager.disposeProcess({ stopProcess: false });
          expect(await readFile(path, 'utf8')).toBe(raw);
        }
        await expect(
          stat(join(root, 'varro/servers/varro-opencode-server-4096.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(path, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['active-lease', 'relinquished-lease', 'marker-only'])(
    'recovers a discovered shared service from its original %s coordination key',
    async (record) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-discovered-ownership-'));
      const automaticPath = join(root, 'varro-opencode-server-4096.json');
      const discoveredLeasePath = join(root, 'varro-opencode-server-4196.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 49374,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'original-varro-launch',
        host: 'another-editor',
        state: record === 'relinquished-lease' ? 'relinquished' : 'active',
        createdAt: Date.now(),
        password: 'original-password',
      };
      const marker = {
        pid: lease.pid,
        port: lease.port,
        executable: lease.executable,
        birthIdentity: lease.birthIdentity,
        owner: lease.owner,
        createdAt: lease.createdAt,
      };
      await writeFile(`${discoveredLeasePath}.managed`, JSON.stringify(marker));
      if (record !== 'marker-only') await writeFile(discoveredLeasePath, JSON.stringify(lease));
      mockLinuxLeaseProcess({ port: lease.port });
      const manager = new OpenCodeProcess(
        'auto',
        true,
        '',
        false,
        undefined,
        automaticPath,
        join(root, 'proc')
      );
      manager.port = lease.port;
      const kill = vi.spyOn(process, 'kill');
      try {
        const release = await manager.acquireManagedServerLaunchClaim(new AbortController().signal);
        await expect(manager.refreshDiscoveredServerRegistration()).resolves.toBe(true);
        expect((manager as unknown as { ownershipLeasePath: string }).ownershipLeasePath).toBe(
          discoveredLeasePath
        );
        expect(manager.port).toBe(lease.port);
        await release();
        await expect(stat(`${automaticPath}.claim`)).rejects.toMatchObject({ code: 'ENOENT' });
        if (manager.hasOwnershipLeaseCandidate) await manager.recoverManagedServerOwnership();
        await manager.prepareForHealthyExistingServer();
        expect(manager.serverOwnership).toBe(
          record === 'active-lease' ? 'other-host' : 'current-host'
        );
        await expect(manager.verifyManagedServerConnection(true)).resolves.toBeUndefined();
        expect(JSON.parse(await readFile(discoveredLeasePath, 'utf8'))).toMatchObject(marker);
        if (record === 'active-lease')
          expect(JSON.parse(await readFile(discoveredLeasePath, 'utf8'))).toEqual(lease);
        expect(JSON.parse(await readFile(`${discoveredLeasePath}.managed`, 'utf8'))).toMatchObject(
          marker
        );
        await expect(stat(automaticPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['pid', 'birth', 'executable', 'public', 'conflict'])(
    'does not adopt discovered ownership with a %s mismatch or ambiguity',
    async (mismatch) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-discovered-mismatch-'));
      vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
      const directory = join(root, 'servers');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const discoveredLeasePath = join(directory, 'varro-opencode-server-4196.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: mismatch === 'pid' ? MOCK_LINUX_PID + 1 : MOCK_LINUX_PID,
        port: 49374,
        executable: mismatch === 'executable' ? '/other/opencode' : '/usr/bin/opencode',
        birthIdentity:
          mismatch === 'birth' ? 'linux:another-start' : 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'existing-launch',
        host: 'another-editor',
        state: 'active',
        createdAt: Date.now(),
      };
      const raw = JSON.stringify(lease);
      await writeFile(discoveredLeasePath, raw, { mode: 0o600 });
      if (mismatch === 'public') await chmod(discoveredLeasePath, 0o644);
      if (mismatch === 'conflict')
        await writeFile(join(directory, 'varro-opencode-server-4197.json'), raw, { mode: 0o600 });
      mockLinuxLeaseProcess({ port: lease.port });
      const manager = new OpenCodeProcess('auto', true);
      manager.port = lease.port;
      try {
        if (mismatch === 'public')
          await expect(manager.refreshDiscoveredServerRegistration()).rejects.toThrow(
            'not private'
          );
        else if (mismatch === 'conflict')
          await expect(manager.refreshDiscoveredServerRegistration()).rejects.toThrow(
            'Conflicting Varro registrations'
          );
        else await expect(manager.refreshDiscoveredServerRegistration()).resolves.toBe(false);
        expect(manager.port).toBe(lease.port);
        expect(manager.serverOwnership).toBe('unmanaged');
        expect(manager.hasOwnershipLeaseCandidate).toBe(false);
        expect(await readFile(discoveredLeasePath, 'utf8')).toBe(raw);
        await expect(
          stat(join(directory, 'varro-opencode-server-4096.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('does not discover production or legacy ownership records from an AI test scope', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-discovery-isolation-'));
    vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
    const path = join(tmpdir(), 'varro-opencode-server-49374.json');
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 49374,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'normal-editor',
      host: 'normal-host',
      state: 'active',
      createdAt: Date.now(),
    };
    await writeFile(path, JSON.stringify(lease));
    mockLinuxLeaseProcess({ port: lease.port });
    const manager = new OpenCodeProcess('auto', true);
    manager.port = lease.port;
    try {
      await expect(manager.refreshDiscoveredServerRegistration()).resolves.toBe(false);
      expect(manager.serverOwnership).toBe('unmanaged');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
    } finally {
      await rm(path);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects public and symlinked default ownership records without altering them', async (context) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-private-record-'));
    vi.stubEnv('XDG_STATE_HOME', root);
    const path = join(root, 'varro', 'servers', 'varro-opencode-server-59997.json');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const victim = join(root, 'original');
    await writeFile(victim, 'keep');
    try {
      await writeFile(path, '{broken', { mode: 0o644 });
      const manager = new OpenCodeProcess(59997, true);
      await expect(manager.refreshStartupRegistration()).rejects.toThrow('not private');
      expect(await readFile(path, 'utf8')).toBe('{broken');
      await chmod(path, 0o600);
      await expect(manager.refreshStartupRegistration()).rejects.toThrow('left untouched');
      await rm(path);
      await requireFileSymlink(context, victim, path);
      await expect(manager.refreshStartupRegistration()).rejects.toThrow('not private');
      expect(await readFile(victim, 'utf8')).toBe('keep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses verified private lease credentials without waiting for the editor vault', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-managed-secrets-'));
    const path = join(root, 'lease.json');
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 50001,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'existing-launch',
      host: 'old-window',
      state: 'relinquished',
      createdAt: Date.now(),
      password: 'existing-password',
      username: 'custom-user',
    };
    await writeFile(path, JSON.stringify(lease));
    mockLinuxLeaseProcess({ port: lease.port });
    const manager = new OpenCodeProcess(
      'auto',
      true,
      '',
      false,
      undefined,
      path,
      join(root, 'proc')
    );
    const secrets = { get: vi.fn(), store: vi.fn().mockResolvedValue(undefined) };
    try {
      await manager.refreshStartupRegistration();
      await expect(manager.recoverManagedServerOwnership()).resolves.toBe(true);
      await manager.persistManagedServerCredentials(secrets);
      expect(secrets.store).toHaveBeenCalledWith(
        `varro.opencode.managedCredentials:${path}`,
        JSON.stringify({ owner: lease.owner, username: lease.username, password: lease.password })
      );
      const authorization = manager.serverAuthorization;
      secrets.get.mockImplementation(() => new Promise<string | undefined>(() => {}));
      await manager.restoreManagedServerCredentials(secrets);
      expect(secrets.get).not.toHaveBeenCalled();
      expect(manager.serverAuthorization).toBe(authorization);
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        password: lease.password,
        username: lease.username,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores vault credentials only for the matching credentialless lease', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-managed-secrets-fallback-'));
    const path = join(root, 'lease.json');
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 50001,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'existing-launch',
      host: 'old-window',
      state: 'relinquished',
      createdAt: Date.now(),
    };
    try {
      await writeFile(path, JSON.stringify(lease));
      mockLinuxLeaseProcess({ port: lease.port });
      const manager = new OpenCodeProcess(
        'auto',
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      await manager.refreshStartupRegistration();
      const authorization = manager.serverAuthorization;
      const secrets = { get: vi.fn<() => Promise<string | undefined>>() };
      secrets.get.mockResolvedValue(
        JSON.stringify({ owner: 'other-launch', username: 'other', password: 'wrong' })
      );
      await manager.restoreManagedServerCredentials(secrets);
      expect(manager.serverAuthorization).toBe(authorization);
      secrets.get.mockResolvedValue('{broken');
      await manager.restoreManagedServerCredentials(secrets);
      expect(manager.serverAuthorization).toBe(authorization);
      secrets.get.mockRejectedValue(new Error('storage unavailable'));
      await expect(manager.restoreManagedServerCredentials(secrets)).rejects.toThrow('unavailable');
      vi.useFakeTimers();
      let resolveLate!: (value: string) => void;
      secrets.get.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveLate = resolve;
          })
      );
      const stalled = manager.restoreManagedServerCredentials(secrets);
      const rejected = expect(stalled).rejects.toThrow('Managed credential lookup timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      resolveLate(
        JSON.stringify({ owner: lease.owner, username: 'late', password: 'late-password' })
      );
      await Promise.resolve();
      expect(manager.serverAuthorization).toBe(authorization);
      vi.useRealTimers();
      secrets.get.mockResolvedValue(
        JSON.stringify({ owner: lease.owner, username: 'custom-user', password: 'vault-password' })
      );
      await manager.restoreManagedServerCredentials(secrets);
      expect(manager.serverAuthorization).toBe(
        `Basic ${Buffer.from('custom-user:vault-password').toString('base64')}`
      );
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['auto', 4096] as const)(
    'reuses a live legacy fallback with %s without rewriting its lease',
    async (port) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-port-migration-'));
      const path = join(root, 'lease.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 50001,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'legacy',
        host: 'old-window',
        state: 'active',
        createdAt: Date.now(),
        password: 'existing-password',
      };
      const raw = JSON.stringify(lease);
      await writeFile(path, raw);
      mockLinuxLeaseProcess({ port: lease.port });
      try {
        const manager = new OpenCodeProcess(
          port,
          true,
          '',
          false,
          undefined,
          path,
          join(root, 'proc')
        );
        await expect(manager.refreshStartupRegistration()).resolves.toBe(true);
        expect(manager.port).toBe(50001);
        expect(manager.serverAuthorization).toBe(
          `Basic ${Buffer.from('opencode:existing-password').toString('base64')}`
        );
        expect(await readFile(path, 'utf8')).toBe(raw);
        expect(manager.managedProcess).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['candidate', 'present'],
    ['candidate', 'removed'],
    ['observed', 'present'],
    ['observed', 'removed'],
    ['owned', 'present'],
    ['owned', 'removed'],
  ])(
    'forgets a retired %s lease with its file %s before shared-service attachment',
    async (cache, record) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-retired-cache-'));
      const path = join(root, 'lease.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 50001,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'previous-server',
        host: 'previous-window',
        state: cache === 'owned' ? 'relinquished' : 'active',
        createdAt: Date.now(),
      };
      await writeFile(path, JSON.stringify(lease));
      mockLinuxLeaseProcess({ port: lease.port });
      const manager = new OpenCodeProcess(
        'auto',
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      const kill = vi.spyOn(process, 'kill');
      try {
        await expect(manager.refreshStartupRegistration()).resolves.toBe(true);
        if (cache !== 'candidate') {
          await expect(manager.recoverManagedServerOwnership()).resolves.toBe(cache === 'owned');
          expect(manager.serverOwnership).toBe(cache === 'owned' ? 'current-host' : 'other-host');
        }
        const raw = await readFile(path, 'utf8');
        if (record === 'removed') await rm(path);
        mockLinuxLeaseProcess({ pid: MOCK_LINUX_PID + 1, port: 49374 });
        await expect(manager.refreshStartupRegistration()).resolves.toBe(false);
        expect(manager.serverOwnership).toBe('unmanaged');
        expect(manager.hasOwnershipLeaseCandidate).toBe(false);
        if (record === 'present') expect(await readFile(path, 'utf8')).toBe(raw);
        else await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        (
          manager as unknown as { installedCliVersionCache: { value: string; checkedAt: number } }
        ).installedCliVersionCache = {
          value: '2.0.20',
          checkedAt: Date.now(),
        };
        vi.mocked(Service.discover).mockResolvedValue({
          url: 'http://127.0.0.1:49374',
          auth: { type: 'basic', username: 'opencode', password: 'new-service-password' },
        });
        await expect(manager.discoverSharedServer()).resolves.toBe(true);
        await expect(manager.verifyManagedServerConnection(true)).resolves.toBeUndefined();
        expect(manager.serverOwnership).toBe('unmanaged');
        expect(manager.serverAuthorization).toBe(
          `Basic ${Buffer.from('opencode:new-service-password').toString('base64')}`
        );
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['healthy', 'uncertain', 'corrupt'])(
    'retains cached evidence when a removed lease is %s',
    async (state) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-live-cache-'));
      const path = join(root, 'lease.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 50001,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'live-server',
        host: 'other-window',
        state: 'active',
        createdAt: Date.now(),
      };
      await writeFile(path, JSON.stringify(lease));
      mockLinuxLeaseProcess({ port: lease.port });
      const manager = new OpenCodeProcess(
        'auto',
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      try {
        await manager.refreshStartupRegistration();
        await manager.recoverManagedServerOwnership();
        await rm(path);
        if (state === 'healthy') {
          await expect(manager.refreshStartupRegistration()).resolves.toBe(true);
          expect(manager.port).toBe(lease.port);
          await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        } else if (state === 'uncertain') {
          mockLinuxLeaseProcess({ port: lease.port, birthIdentity: () => '' });
          await expect(manager.refreshStartupRegistration()).rejects.toThrow(
            'Cannot verify process start identity'
          );
        } else {
          await writeFile(path, '{corrupt replacement');
          await expect(manager.refreshStartupRegistration()).rejects.toThrow('left untouched');
          expect(await readFile(path, 'utf8')).toBe('{corrupt replacement');
        }
        expect(manager.serverOwnership).toBe('other-host');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['auto', 4096] as const)(
    'selects the next launch port after a legacy server exits with setting %s',
    async (port) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-retired-registration-'));
      const path = join(root, 'varro-opencode-server-4096.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:retired',
        owner: 'legacy',
        host: 'old-window',
        state: 'active',
        createdAt: Date.now(),
      };
      const raw = JSON.stringify(lease);
      await writeFile(path, raw);
      const manager = new OpenCodeProcess(port, true, '', false, undefined, path);
      try {
        await expect(manager.refreshStartupRegistration()).resolves.toBe(false);
        manager.selectAutomaticPort();
        if (port === 'auto') {
          expect(manager.port).toBeGreaterThanOrEqual(49152);
          expect(manager.port).toBeLessThanOrEqual(65535);
        } else {
          expect(manager.port).toBe(4096);
        }
        expect(await readFile(path, 'utf8')).toBe(raw);
        const release = await manager.acquireManagedServerLaunchClaim(new AbortController().signal);
        expect(asRecord(JSON.parse(await readFile(`${path}.claim`, 'utf8')))?.version).toBe(1);
        await release();
        await expect(stat(`${path}.claim`)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('restores a marked fallback when its lease was lost', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-marker-migration-'));
    const path = join(root, 'lease.json');
    const marker = {
      pid: MOCK_LINUX_PID,
      port: 50001,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'legacy',
      createdAt: Date.now(),
    };
    await writeFile(`${path}.managed`, JSON.stringify(marker));
    mockLinuxLeaseProcess();
    try {
      const manager = new OpenCodeProcess(
        'auto',
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      await expect(manager.refreshStartupRegistration()).resolves.toBe(true);
      expect(manager.port).toBe(50001);
      expect(JSON.parse(await readFile(`${path}.managed`, 'utf8'))).toEqual(marker);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not redirect an explicit port to a newly registered automatic endpoint', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-fixed-migration-'));
    const path = join(root, 'lease.json');
    const lease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 50001,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'automatic',
      host: 'other-window',
      state: 'active',
      createdAt: Date.now(),
      portMode: 'auto',
    };
    await writeFile(path, JSON.stringify(lease));
    mockLinuxLeaseProcess();
    try {
      const manager = new OpenCodeProcess(
        4096,
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      expect(manager.port).toBe(4096);
      await expect(manager.refreshStartupRegistration()).rejects.toThrow('Select auto');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not start over corrupt registration or failed process inspection', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'varro-corrupt-migration-'));
    const path = join(root, 'lease.json');
    await writeFile(path, '{broken');
    try {
      const manager = new OpenCodeProcess(
        'auto',
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      await expect(manager.refreshStartupRegistration()).rejects.toThrow('left untouched');
      expect(await readFile(path, 'utf8')).toBe('{broken');
      const lease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:original',
        owner: 'legacy',
        host: 'old',
        state: 'active',
        createdAt: Date.now(),
      };
      await writeFile(path, JSON.stringify(lease));
      mockLinuxLeaseProcess({ birthIdentity: () => '' });
      await expect(manager.refreshStartupRegistration()).rejects.toThrow(
        'Cannot verify process start identity'
      );
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes competing initial launches and releases the claim idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varro-launch-claim-'));
    const path = join(root, 'lease.json');
    const first = new OpenCodeProcess('auto', true, '', false, undefined, path);
    const second = new OpenCodeProcess('auto', true, '', false, undefined, path);
    // Birth inspection may be unavailable; the real current host PID still protects its claim.
    mockLinuxLeaseProcess();
    try {
      const releaseFirst = await first.acquireManagedServerLaunchClaim(
        new AbortController().signal
      );
      let acquired = false;
      const pending = second
        .acquireManagedServerLaunchClaim(new AbortController().signal)
        .then((release) => {
          acquired = true;
          return release;
        });
      await readFile(`${path}.claim`, 'utf8');
      expect(acquired).toBe(false);
      await releaseFirst();
      await releaseFirst();
      const releaseSecond = await pending;
      expect(acquired).toBe(true);
      await releaseSecond();
      await expect(stat(`${path}.claim`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps automatic selection stable through retries and bounds collision recovery', () => {
    const manager = new OpenCodeProcess(
      'auto',
      true,
      '',
      false,
      undefined,
      join(tmpdir(), 'unused-auto.json')
    );
    manager.selectAutomaticPort();
    const selected = manager.port;
    manager.selectAutomaticPort();
    expect(manager.port).toBe(selected);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const previous = manager.port;
      expect(manager.tryAdvancePort()).toBe(true);
      expect(manager.port).not.toBe(previous);
      expect(manager.port).toBeGreaterThanOrEqual(49152);
      expect(manager.port).toBeLessThanOrEqual(65535);
    }
    expect(manager.tryAdvancePort()).toBe(false);
  });

  it.each(['darwin', 'linux', 'win32'])('uses shared per-user state on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const manager = new OpenCodeProcess(49876, true);
    const path = (manager as unknown as { ownershipLeasePath: string }).ownershipLeasePath;
    const directory =
      platform === 'win32'
        ? join(tmpdir(), 'appdata', 'Varro', 'servers')
        : platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support', 'Varro', 'servers')
          : join(tmpdir(), 'state', 'varro', 'servers');
    expect(path).toBe(join(directory, 'varro-opencode-server-49876.json'));
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['darwin', 'linux', 'win32'])(
    'isolates AI claims from persistent and legacy editor records on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-test-claims-'));
      const legacy = join(tmpdir(), 'varro-opencode-server-49879.json');
      const raw = '{existing editor record must remain untouched}';
      await writeFile(legacy, raw);
      vi.stubEnv('VARRO_TEST_SERVER_URL', 'http://127.0.0.1:49879');
      vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
      try {
        const managers = ['VSCode', 'VSCode-Nightly', 'VSCodium', 'Varro-OpenJet'].map(
          () => new OpenCodeProcess(49879, true)
        );
        const expected = join(root, 'servers', 'varro-opencode-server-49879.json');
        for (const manager of managers)
          expect((manager as unknown as { ownershipLeasePath: string }).ownershipLeasePath).toBe(
            expected
          );
        await expect(managers[0]!.refreshStartupRegistration()).resolves.toBe(false);
        expect(await readFile(legacy, 'utf8')).toBe(raw);
      } finally {
        await rm(legacy);
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('keeps an existing legacy lease as the coordination point', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const path = join(tmpdir(), 'varro-opencode-server-49877.json');
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 49877,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:123',
      owner: 'legacy-server',
      host: 'legacy-host',
      state: 'active',
      createdAt: Date.now(),
    };
    await writeFile(path, JSON.stringify(lease));
    try {
      const manager = new OpenCodeProcess(49877, true);
      expect((manager as unknown as { ownershipLeasePath: string }).ownershipLeasePath).toBe(path);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
    } finally {
      await rm(path);
    }
  });

  it('recovers a legacy marker after macOS loses the replaced executable path', async (context) => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ownership-macos-update-')));
    const executable = join(root, 'opencode.exe');
    const command = join(root, 'opencode2');
    await writeFile(executable, 'updated binary');
    const path = join(tmpdir(), 'varro-opencode-server-49878.json');
    const marker = {
      pid: MOCK_LINUX_PID,
      port: 49878,
      executable,
      birthIdentity: 'darwin:original-start',
      owner: 'updated-server',
      createdAt: Date.now(),
    };
    await writeFile(`${path}.managed`, JSON.stringify(marker));
    let birthIdentity = 'original-start';
    spawnMock.mockImplementation((tool: string, args: string[]) => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const output =
          tool === 'lsof'
            ? args.includes('txt')
              ? 'p123\nftxt\nn/opencode'
              : String(MOCK_LINUX_PID)
            : args.includes('comm=')
              ? command
              : birthIdentity;
        result.stdout.emit('data', Buffer.from(`${output}\n`));
        result.emit('close', 0);
      });
      return result;
    });
    try {
      await requireFileSymlink(context, executable, command);
      const manager = new OpenCodeProcess(49878, true);
      await expect(manager.takeOwnershipOfExistingServer()).resolves.toBe(true);
      expect(manager.serverOwnership).toBe('current-host');
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(marker);
      await expect(manager.refreshManagedServerOwnership()).resolves.toBe(true);

      birthIdentity = 'reused-pid';
      await expect(manager.refreshManagedServerOwnership()).resolves.toBe(false);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(path, { force: true });
      await rm(`${path}.managed`, { force: true });
    }
  });

  it.each(['darwin', 'linux', 'win32'])(
    'recovers a crashed host and elects one competing window on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'ownership-recovery-'));
      const path = join(root, 'lease.json');
      const executable = platform === 'win32' ? 'C:\\OpenCode\\opencode.exe' : '/usr/bin/opencode';
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable,
        birthIdentity: `${platform}:123456`,
        owner: 'shared-server',
        host: 'crashed-host',
        hostPid: MOCK_LINUX_PID + 1,
        hostBirthIdentity: `${platform}:old-host`,
        state: 'active',
        createdAt: Date.now(),
      };
      await writeFile(path, JSON.stringify(lease));
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === process.pid && signal === 0) return true;
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      spawnMock.mockImplementation((command: string, args: string[]) => {
        const result = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          const script = args.at(-1) ?? '';
          let output = '';
          if (command === 'netstat.exe')
            output = `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${MOCK_LINUX_PID}`;
          else if (script.includes('VARRO_EXECUTABLE='))
            output = `VARRO_EXECUTABLE=${executable.toLowerCase()}\nVARRO_BIRTH=123456`;
          else if (
            (command === 'lsof' && args.some((arg) => arg.startsWith('-tiTCP:'))) ||
            script.includes('Get-NetTCPConnection')
          )
            output = String(MOCK_LINUX_PID);
          else if (
            command === 'readlink' ||
            args.includes('comm=') ||
            script.includes('ExecutablePath')
          )
            output = executable.toLowerCase();
          else if (args.includes('lstart=') || script.includes('CreationDate')) output = '123456';
          result.stdout.emit('data', Buffer.from(`${output}\n`));
          result.emit('close', 0);
        });
        return result;
      });
      const createManager = () =>
        new OpenCodeProcess(4096, true, '', false, undefined, path, join(root, 'proc'));
      try {
        const first = createManager();
        const second = createManager();
        const results = await Promise.all([
          first.recoverManagedServerOwnership(),
          second.recoverManagedServerOwnership(),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const owner = first.managedProcess ? first : second;
        const observer = owner === first ? second : first;
        await expect(observer.refreshManagedServerOwnership()).resolves.toBe(false);
        expect(observer.serverOwnership).toBe('other-host');

        await owner.disposeProcess({ stopProcess: false });
        expect(JSON.parse(await readFile(path, 'utf8')).state).toBe('relinquished');
        const restarted = createManager();
        await expect(restarted.recoverManagedServerOwnership()).resolves.toBe(true);
        expect(restarted.managedProcessId).toBe(MOCK_LINUX_PID);
        await expect(observer.refreshManagedServerOwnership()).resolves.toBe(false);
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        expect(spawnMock.mock.calls.some(([command]) => command === 'taskkill.exe')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('does not stop or clean up a launched process after another window takes ownership', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'ownership-transfer-'));
    const path = join(root, 'lease.json');
    mockLinuxLeaseProcess();
    const inspect = spawnMock.getMockImplementation()!;
    const child = Object.assign(new EventEmitter(), {
      pid: MOCK_LINUX_PID,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation((command: string, args: string[]) =>
      command === '/usr/bin/opencode' ? child : inspect(command, args)
    );
    const first = new OpenCodeProcess(
      4096,
      true,
      '/usr/bin/opencode',
      false,
      undefined,
      path,
      join(root, 'proc')
    );
    first.launchServer({
      getWorkspaceCwd: () => root,
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    try {
      await expect(first.confirmManagedServerOwnership()).resolves.toBe(true);
      await rm(path);
      await expect(first.refreshManagedServerOwnership()).resolves.toBe(true);
      await expect(stat(path)).resolves.toBeTruthy();
      const releaseStartup = await first.acquireManagedServerRestartOwnership();
      try {
        await expect(first.confirmManagedServerOwnership()).resolves.toBe(true);
      } finally {
        await releaseStartup();
      }
      const second = new OpenCodeProcess(
        4096,
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      await expect(second.recoverManagedServerOwnership()).resolves.toBe(false);
      const release = await second.acquireManagedServerRestartOwnership();
      try {
        await expect(first.refreshManagedServerOwnership()).resolves.toBe(false);
        expect(first.serverOwnership).toBe('other-host');
        const current = await readFile(path, 'utf8');
        await first.disposeProcess({ stopProcess: true });
        expect(child.kill).not.toHaveBeenCalled();
        expect(await readFile(path, 'utf8')).toBe(current);
        await expect(stat(`${path}.managed`)).resolves.toBeTruthy();
      } finally {
        await release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'same boot after a binary update', oldBoot: false, legacy: false, expected: true },
    { name: 'reused PID and ticks after reboot', oldBoot: true, legacy: false, expected: false },
    { name: 'legacy ticks within the current boot', oldBoot: false, legacy: true, expected: true },
  ])('validates Linux identity for $name', async ({ oldBoot, legacy, expected }) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'ownership-boot-'));
    const procRoot = join(root, 'proc');
    const bootId = '12345678-1234-1234-1234-123456789abc';
    const path = join(root, 'lease.json');
    await mkdir(join(procRoot, String(MOCK_LINUX_PID)), { recursive: true });
    await mkdir(join(procRoot, 'sys/kernel/random'), { recursive: true });
    const fields = Array.from({ length: 20 }, () => '0');
    fields[19] = '123456';
    await writeFile(
      join(procRoot, String(MOCK_LINUX_PID), 'stat'),
      `${MOCK_LINUX_PID} (opencode) ${fields.join(' ')}`
    );
    await writeFile(join(procRoot, 'sys/kernel/random/boot_id'), bootId);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: legacy
          ? 'linux:123456'
          : `linux:${oldBoot ? bootId.replace('abc', 'def') : bootId}:123456`,
        owner: 'boot-owner',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      })
    );
    mockLinuxLeaseProcess({ executable: '/usr/bin/opencode (deleted)' });
    try {
      const manager = new OpenCodeProcess(4096, true, '', false, undefined, path, procRoot);
      await expect(manager.recoverManagedServerOwnership()).resolves.toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically writes complete leases from two managers in the same extension host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ownership-writes-'));
    const path = join(root, 'state', 'lease.json');
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:123',
      owner: 'same-server',
      host: 'first',
      state: 'active',
      createdAt: Date.now(),
    };
    const first = new OpenCodeProcess(4096, true, '', false, undefined, path);
    const second = new OpenCodeProcess(4096, true, '', false, undefined, path);
    const write = (manager: OpenCodeProcess, host: string) =>
      (
        manager as unknown as {
          writeOwnershipLease(value: ManagedServerOwnershipLease): Promise<void>;
        }
      ).writeOwnershipLease({ ...lease, host });
    try {
      await Promise.all([write(first, 'first'), write(second, 'second')]);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(
        expect.objectContaining({ owner: 'same-server', birthIdentity: 'linux:123' })
      );
      const reader = new OpenCodeProcess(4096, true, '', false, undefined, path);
      expect(reader.hasOwnershipLeaseCandidate).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains ownership evidence when process inspection temporarily fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'ownership-inspection-'));
    const path = join(root, 'lease.json');
    const lease: ManagedServerOwnershipLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'same-server',
      host: 'old-host',
      state: 'relinquished',
      createdAt: Date.now(),
    };
    await writeFile(path, JSON.stringify(lease));
    mockLinuxLeaseProcess({ birthIdentity: () => '' });
    try {
      const manager = new OpenCodeProcess(
        4096,
        true,
        '',
        false,
        undefined,
        path,
        join(root, 'proc')
      );
      await expect(manager.recoverManagedServerOwnership()).rejects.toThrow(
        'Cannot verify process start identity'
      );
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
      mockLinuxLeaseProcess();
      await expect(manager.refreshManagedServerOwnership()).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { birth: '123456', failure: undefined },
    { birth: '654321', failure: 'The managed OpenCode listener changed' },
    { birth: undefined, failure: 'Cannot verify executable identity' },
  ])(
    'revalidates a Windows managed connection after an inspection failure: %j',
    async ({ birth, failure }) => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'ownership-windows-inspection-'));
      const path = join(root, 'lease.json');
      const lease: ManagedServerOwnershipLease = {
        version: 1,
        pid: MOCK_WINDOWS_PID,
        port: 4096,
        executable: 'C:\\OpenCode\\opencode.exe',
        birthIdentity: 'win32:123456',
        owner: 'same-server',
        host: 'old-host',
        state: 'relinquished',
        createdAt: Date.now(),
      };
      await writeFile(path, JSON.stringify(lease));
      let inspections = 0;
      spawnMock.mockImplementation((command: string) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          if (command === 'netstat.exe') {
            child.stdout.emit(
              'data',
              Buffer.from(`TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${lease.pid}`)
            );
            child.emit('close', 0);
            return;
          }
          inspections += 1;
          if (inspections > 1 && birth) {
            child.stdout.emit(
              'data',
              Buffer.from(`VARRO_EXECUTABLE=${lease.executable}\nVARRO_BIRTH=${birth}`)
            );
            child.emit('close', 0);
          } else {
            child.stderr.emit('data', Buffer.from('CIM temporarily unavailable'));
            child.emit('close', 1);
          }
        });
        return child;
      });
      try {
        const manager = new OpenCodeProcess(4096, true, '', false, undefined, path);
        const verification = manager.verifyManagedServerConnection(true);
        if (failure) await expect(verification).rejects.toThrow(failure);
        else await expect(verification).resolves.toBeUndefined();
        expect(inspections).toBe(2);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(lease);
        expect(manager.hasOwnershipLeaseCandidate).toBe(true);
        expect(spawnMock.mock.calls.map(([command]) => command)).toEqual([
          'netstat.exe',
          'powershell.exe',
          'powershell.exe',
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('keeps adopted ownership when its listener identity is still alive', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    await setAdoptedOwnership(manager, leasePath);
    mockLinuxLeaseProcess();
    const kill = vi.spyOn(process, 'kill');

    expect(manager.isAdoptedManagedServer).toBe(true);
    await expect(manager.revalidateAdoptedManagedServer()).resolves.toBe(true);

    expect(manager.isAdoptedManagedServer).toBe(true);
    expect(manager.managedProcess).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    await expect(stat(leasePath)).resolves.toBeDefined();
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('cleans adopted ownership when its listener disappears without signalling a PID', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    await setAdoptedOwnership(manager, leasePath);
    spawnMock.mockImplementation(() => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => result.emit('close', 0));
      return result;
    });
    const kill = vi.spyOn(process, 'kill');

    await expect(manager.revalidateAdoptedManagedServer()).resolves.toBe(false);

    expect(manager.isAdoptedManagedServer).toBe(false);
    expect(manager.managedProcess).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('cleans a reused adopted PID without signalling the replacement process', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const manager = new OpenCodeProcess(4096, true, 'opencode', false, undefined, leasePath);
    await setAdoptedOwnership(manager, leasePath, 'linux:old-process');
    mockLinuxLeaseProcess({ birthIdentity: () => 'replacement-process' });
    const kill = vi.spyOn(process, 'kill');

    await expect(manager.revalidateAdoptedManagedServer()).resolves.toBe(false);

    expect(manager.isAdoptedManagedServer).toBe(false);
    expect(manager.managedProcess).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('confirms a spawned Linux descendant through procfs when inspection tools are unavailable', async (context) => {
    if (originalPlatform === 'win32')
      context.skip('Linux procfs fixtures require POSIX socket symlinks');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const procRoot = join(directory, 'proc');
    const wrapperPid = MOCK_WINDOWS_PID;
    const listenerPid = MOCK_WINDOWS_PID + 1;
    const socketInode = '987654';
    const child = Object.assign(new EventEmitter(), {
      pid: wrapperPid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const statFields = Array.from({ length: 20 }, () => '0');
    statFields[0] = 'S';
    statFields[1] = String(wrapperPid);
    statFields[2] = String(wrapperPid);
    statFields[19] = '123456';
    await Promise.all([
      mkdir(join(procRoot, 'net'), { recursive: true }),
      mkdir(join(procRoot, String(wrapperPid), 'fd'), { recursive: true }),
      mkdir(join(procRoot, String(listenerPid), 'fd'), { recursive: true }),
    ]);
    await writeFile(
      join(procRoot, 'net/tcp'),
      `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${socketInode}\n`
    );
    await Promise.all([
      writeFile(join(procRoot, 'net/tcp6'), ''),
      writeFile(
        join(procRoot, String(listenerPid), 'stat'),
        `${listenerPid} (opencode) ${statFields.join(' ')}`
      ),
      symlink(`socket:[${socketInode}]`, join(procRoot, String(listenerPid), 'fd/3')),
      symlink('/usr/bin/opencode', join(procRoot, String(listenerPid), 'exe')),
    ]);
    const procExecutable = await readlink(join(procRoot, String(listenerPid), 'exe'));
    spawnMock.mockImplementation((command: string) => {
      if (command === '/usr/bin/opencode') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() =>
        result.emit(
          'error',
          Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
        )
      );
      return result;
    });
    const manager = new OpenCodeProcess(
      4096,
      false,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath,
      procRoot
    );
    manager.launchServer({
      getWorkspaceCwd: () => '/repo',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    await expect(manager.confirmManagedServerOwnership()).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledWith('lsof', expect.anything(), expect.anything());
    expect(spawnMock).toHaveBeenCalledWith('ss', expect.anything(), expect.anything());
    expect(spawnMock).toHaveBeenCalledWith(
      'ps',
      ['-p', String(process.pid), '-o', 'lstart='],
      expect.anything()
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'ps',
      ['-p', String(listenerPid), '-o', 'lstart='],
      expect.anything()
    );
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      pid: listenerPid,
      port: 4096,
      executable: procExecutable,
      birthIdentity: 'linux:123456',
      state: 'active',
    });
    expect(JSON.parse(await readFile(`${leasePath}.managed`, 'utf-8'))).toMatchObject({
      pid: listenerPid,
      port: 4096,
      executable: procExecutable,
      birthIdentity: 'linux:123456',
    });

    await rm(directory, { recursive: true, force: true });
  });

  it('lets an attached host claim after the owner relinquishes without reloading', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const procRoot = join(directory, 'proc');
    let listening = true;
    let serverEnv: NodeJS.ProcessEnv | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: MOCK_WINDOWS_PID,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation(
      (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'opencode' || command.endsWith('/opencode')) {
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
            result.stdout.emit('data', Buffer.from(`${MOCK_WINDOWS_PID}\n`));
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
    const first = new OpenCodeProcess(
      4096,
      true,
      'opencode',
      false,
      undefined,
      leasePath,
      procRoot
    );
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
      password: expect.any(String),
      portMode: 'fixed',
      version: 1,
      pid: MOCK_WINDOWS_PID,
      port: 4096,
      executable: '/usr/local/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: expect.stringMatching(/^[a-f0-9]{32}$/),
      host: expect.stringMatching(/^[a-f0-9]{32}$/),
      hostPid: process.pid,
      hostBirthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      state: 'active',
      createdAt: expect.any(Number),
    });
    expect(serverEnv?.VARRO_SERVER_OWNER).toBe(lease.owner);

    const second = new OpenCodeProcess(
      4096,
      true,
      'opencode',
      false,
      undefined,
      leasePath,
      procRoot
    );
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
    expect(second.managedProcessId).toBe(MOCK_WINDOWS_PID);

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      listening = false;
      return true;
    });
    await second.stopServerForRestart();

    expect(kill).toHaveBeenCalledWith(MOCK_WINDOWS_PID, 'SIGTERM');
    await expect(stat(leasePath)).rejects.toThrow();
    await expect(stat(`${leasePath}.managed`)).rejects.toThrow();
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
      pid: MOCK_WINDOWS_PID,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    let listenerQueries = 0;
    spawnMock.mockImplementation((command: string, _args: string[]) => {
      if (command === 'C:\\OpenCode\\opencode.exe') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'netstat.exe') {
          listenerQueries += 1;
          if (listenerQueries > 1) {
            result.stdout.emit(
              'data',
              Buffer.from(`TCP  127.0.0.1:4096  0.0.0.0:0  LISTENING  ${MOCK_WINDOWS_PID}\n`)
            );
          }
        } else if (command === 'powershell.exe') {
          result.stdout.emit(
            'data',
            Buffer.from(
              [
                `VARRO_PID=${MOCK_WINDOWS_PID}`,
                'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe',
                'VARRO_BIRTH=123456',
                'VARRO_HOST_BIRTH=654321',
              ].join('\n')
            )
          );
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
      expect.objectContaining({ pid: MOCK_WINDOWS_PID, state: 'active' })
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('uses exact netstat listeners with one Windows process snapshot', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const wrapperPid = MOCK_WINDOWS_PID;
    const listenerPid = MOCK_WINDOWS_PID + 1;
    const child = Object.assign(new EventEmitter(), {
      pid: wrapperPid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation((command: string, _args: string[]) => {
      if (command === 'C:\\OpenCode\\opencode.exe') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'netstat.exe') {
          result.stdout.emit(
            'data',
            Buffer.from(
              [
                `TCP    0.0.0.0:40960    0.0.0.0:0    LISTENING    ${listenerPid + 1}`,
                `UDP    0.0.0.0:4096     *:*                       ${listenerPid + 2}`,
                `TCP    [::]:4096        [::]:0         ABHÖREN      ${listenerPid}`,
              ].join('\r\n')
            )
          );
        } else if (command === 'powershell.exe') {
          result.stdout.emit(
            'data',
            Buffer.from(
              [
                `VARRO_PID=${listenerPid}`,
                'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe',
                'VARRO_BIRTH=123456',
                'VARRO_HOST_BIRTH=654321',
              ].join('\n')
            )
          );
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

    expect(spawnMock).toHaveBeenCalledWith('netstat.exe', ['-ano'], expect.anything());
    expect(spawnMock.mock.calls.filter(([command]) => command === 'powershell.exe')).toHaveLength(
      1
    );
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toEqual(
      expect.objectContaining({
        pid: listenerPid,
        executable: 'C:\\OpenCode\\opencode.exe',
        birthIdentity: 'win32:123456',
      })
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a netstat listener that is not descended from the launched Windows process', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const wrapperPid = MOCK_WINDOWS_PID;
    const listenerPid = MOCK_WINDOWS_PID + 1;
    const child = Object.assign(new EventEmitter(), {
      pid: wrapperPid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation((command: string, _args: string[]) => {
      if (command === 'C:\\OpenCode\\opencode.exe') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'netstat.exe') {
          result.stdout.emit(
            'data',
            Buffer.from(`TCP  127.0.0.1:4096  0.0.0.0:0  LISTENING  ${listenerPid}\n`)
          );
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

    await expect(manager.confirmManagedServerOwnership()).resolves.toBe(false);

    await expect(readFile(leasePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    const inspections = spawnMock.mock.calls.filter(([command]) => command === 'powershell.exe');
    expect(inspections).toHaveLength(3);
    expect(inspections.every(([, args]) => args.at(-1)?.includes('Get-CimInstance'))).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  it('allows slow Windows process inspection to finish', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const child = Object.assign(new EventEmitter(), {
      pid: MOCK_WINDOWS_PID,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const inspectionKills: Array<ReturnType<typeof vi.fn>> = [];
    spawnMock.mockImplementation((command: string, _args: string[]) => {
      if (command === 'C:\\OpenCode\\opencode.exe') return child;
      const kill = vi.fn();
      if (command === 'powershell.exe') inspectionKills.push(kill);
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill,
      });
      if (command === 'netstat.exe') {
        queueMicrotask(() => {
          result.stdout.emit(
            'data',
            Buffer.from(`TCP  127.0.0.1:4096  0.0.0.0:0  LISTENING  ${MOCK_WINDOWS_PID}\n`)
          );
          result.emit('close', 0);
        });
      } else {
        setTimeout(() => {
          result.stdout.emit(
            'data',
            Buffer.from(
              [
                `VARRO_PID=${MOCK_WINDOWS_PID}`,
                'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe',
                'VARRO_BIRTH=123456',
                'VARRO_HOST_BIRTH=654321',
              ].join('\n')
            )
          );
          result.emit('close', 0);
        }, 3_000);
      }
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
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(confirmation).resolves.toBe(true);
    expect(inspectionKills).toHaveLength(1);
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
        if (command === 'netstat.exe') {
          if (listening)
            result.stdout.emit('data', Buffer.from('TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING 777\n'));
        } else if (command === 'powershell.exe' && script.includes('VARRO_EXECUTABLE=')) {
          result.stdout.emit(
            'data',
            Buffer.from('VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123456\n')
          );
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

    const attached = new OpenCodeProcess(4096, false, 'opencode', false, undefined, leasePath);
    expect(attached.url).toBe('http://127.0.0.1:4096');
    expect(attached.managedProcess).toBe(false);

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
    // Readers reject unknown/incomplete records without deleting a concurrent replacement.
    await expect(stat(leasePath)).resolves.toBeTruthy();
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
      birthIdentity: (pid) =>
        pid !== MOCK_LINUX_PID || ++birthQueries <= 2 ? 'original-process' : 'replacement-process',
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
    const procRoot = join(directory, 'proc');
    const activeLease = {
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      owner: 'active-nonce',
      host: 'active-host',
      hostPid: process.pid,
      hostBirthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      state: 'active',
      createdAt: Date.now(),
    };
    await writeFile(leasePath, JSON.stringify(activeLease), 'utf-8');
    mockLinuxLeaseProcess();
    const kill = vi.spyOn(process, 'kill');
    const manager = new OpenCodeProcess(
      4096,
      true,
      'opencode',
      false,
      undefined,
      leasePath,
      procRoot
    );

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(false);
    expect(manager.managedProcess).toBe(false);
    expect(manager.hasForeignActiveOwnership).toBe(true);
    expect(manager.serverOwnership).toBe('other-host');
    expect(manager.managedProcessId).toBe(MOCK_LINUX_PID);
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
      takeOwnershipOfExistingServer: vi.fn().mockResolvedValue(false),
      restartServerForCliUpdate,
    });
    expect(readInstalledCliVersion).not.toHaveBeenCalled();
    expect(restartServerForCliUpdate).not.toHaveBeenCalled();
    await expect(manager.stopServerForRestart()).rejects.toThrow(
      'Port 4096 is occupied by a process Varro does not own'
    );
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);

    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('reclaims an active lease after its extension host exits unexpectedly', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    const procRoot = join(directory, 'proc');
    const deadHostPid = MOCK_LINUX_PID - 1;
    await writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        pid: MOCK_LINUX_PID,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        owner: 'active-nonce',
        host: 'dead-host',
        hostPid: deadHostPid,
        hostBirthIdentity: 'linux:old-host-process',
        state: 'active',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    mockLinuxLeaseProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadHostPid && signal === 0) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return true;
    });
    const manager = new OpenCodeProcess(
      4096,
      true,
      'opencode',
      false,
      undefined,
      leasePath,
      procRoot
    );

    await expect(manager.recoverManagedServerOwnership()).resolves.toBe(true);

    expect(manager.managedProcess).toBe(true);
    expect(manager.hasForeignActiveOwnership).toBe(false);
    expect(manager.managedProcessId).toBe(MOCK_LINUX_PID);
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toEqual(
      expect.objectContaining({
        owner: 'active-nonce',
        host: expect.stringMatching(/^[a-f0-9]{32}$/),
        hostPid: process.pid,
        hostBirthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        state: 'active',
      })
    );
    expect(kill).toHaveBeenCalledWith(deadHostPid, 0);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);

    kill.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  it('coalesces a forced maintenance request while a check is running', async () => {
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
      takeOwnershipOfExistingServer: vi.fn().mockResolvedValue(false),
      restartServerForCliUpdate: vi.fn().mockResolvedValue(undefined),
    });

    manager.requestMaintenanceCheck(tick, true);
    expect(tick).not.toHaveBeenCalled();

    resolveInstalledVersion('1.0.0');
    await operation;

    expect(tick).toHaveBeenCalledOnce();
  });

  it('throttles repeated opportunistic maintenance requests', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00Z'));
    const manager = new OpenCodeProcess(4096, false);
    const tick = vi.fn();

    try {
      manager.requestMaintenanceCheck(tick);
      manager.requestMaintenanceCheck(tick);
      vi.advanceTimersByTime(4 * 60_000);
      manager.requestMaintenanceCheck(tick);
      expect(tick).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(60_000);
      manager.requestMaintenanceCheck(tick);
      expect(tick).toHaveBeenCalledTimes(2);

      manager.requestMaintenanceCheck(tick, true);
      expect(tick).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers and restarts a Varro-marked server when its lease is missing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await Promise.all([
      writeFile(
        `${leasePath}.managed`,
        JSON.stringify({
          pid: MOCK_LINUX_PID,
          owner: 'recovered-owner',
          createdAt: 1234,
          port: 4096,
          executable: '/usr/bin/opencode',
          birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        }),
        'utf-8'
      ),
      writeFile(`${leasePath}.claim`, '', 'utf-8'),
    ]);
    const staleClaimTime = new Date(Date.now() - 60_000);
    await utimes(`${leasePath}.claim`, staleClaimTime, staleClaimTime);
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
      takeOwnershipOfExistingServer: () => manager.takeOwnershipOfExistingServer(),
      restartServerForCliUpdate,
    });

    expect(manager.managedProcess).toBe(true);
    expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.17.18', '1.18.2');
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      version: 1,
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      owner: 'recovered-owner',
      state: 'active',
    });
    await expect(stat(`${leasePath}.claim`)).rejects.toMatchObject({ code: 'ENOENT' });

    await rm(directory, { recursive: true, force: true });
  });

  it('keeps a live host claim and does not remove a replacement claim', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    await writeFile(
      `${leasePath}.managed`,
      JSON.stringify({
        pid: MOCK_LINUX_PID,
        owner: 'restart-owner',
        createdAt: 1234,
        port: 4096,
        executable: '/usr/bin/opencode',
        birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
      }),
      'utf-8'
    );
    mockLinuxLeaseProcess();
    const manager = new OpenCodeProcess(
      4096,
      true,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath
    );

    await expect(manager.takeOwnershipOfExistingServer()).resolves.toBe(true);
    const ownership = manager.acquireManagedServerRestartOwnership();
    const release = typeof ownership === 'function' ? ownership : await ownership;

    expect(manager.serverOwnership).toBe('current-host');
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      pid: MOCK_LINUX_PID,
      owner: 'restart-owner',
      state: 'active',
    });
    const claimPath = `${leasePath}.claim`;
    expect(JSON.parse(await readFile(claimPath, 'utf-8'))).toMatchObject({
      hostPid: process.pid,
      hostBirthIdentity: expect.any(String),
    });

    await rm(claimPath);
    await writeFile(
      claimPath,
      JSON.stringify({
        version: 1,
        host: 'replacement-host',
        hostPid: process.pid,
        createdAt: Date.now() + 1,
      }),
      'utf-8'
    );

    await release();
    expect(JSON.parse(await readFile(claimPath, 'utf-8'))).toMatchObject({
      host: 'replacement-host',
    });
    await rm(directory, { recursive: true, force: true });
  });

  it('does not take ownership of an unmarked listener when auto-start is enabled', async () => {
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

    await expect(manager.takeOwnershipOfExistingServer()).resolves.toBe(false);

    expect(manager.managedProcess).toBe(false);
    await expect(readFile(leasePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true, force: true });
  });

  it('recovers a legacy marked server on macOS from its inherited environment', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const configDirectory = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    const leasePath = join(directory, 'lease.json');
    const configPath = join(configDirectory, 'opencode.json');
    const pid = MOCK_WINDOWS_PID;
    await Promise.all([
      writeFile(configPath, '{}', 'utf-8'),
      writeFile(
        join(configDirectory, 'owner.json'),
        JSON.stringify({ pid, owner: 'legacy-owner', createdAt: 1234 }),
        'utf-8'
      ),
    ]);
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        if (command === 'lsof' && args.some((arg) => arg.includes('-tiTCP:4096'))) {
          result.stdout.emit('data', Buffer.from(`${pid}\n`));
        } else if (command === 'lsof') {
          result.stdout.emit('data', Buffer.from(`p${pid}\nftxt\nn/usr/bin/opencode\n`));
        } else if (command === 'ps' && args.includes('lstart=')) {
          result.stdout.emit('data', Buffer.from('Fri Jul 10 12:00:00 2026\n'));
        } else if (command === 'ps' && args.includes('comm=')) {
          result.stdout.emit('data', Buffer.from('/usr/bin/opencode\n'));
        } else if (command === 'ps' && args.includes('command=')) {
          result.stdout.emit(
            'data',
            Buffer.from(
              `/usr/bin/opencode serve --port 4096 OPENCODE_CONFIG=${configPath} VARRO_SERVER_OWNER=legacy-owner\n`
            )
          );
        }
        result.emit('close', 0);
      });
      return result;
    });
    const manager = new OpenCodeProcess(
      4096,
      true,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath
    );

    await expect(manager.takeOwnershipOfExistingServer()).resolves.toBe(true);

    expect(manager.serverOwnership).toBe('current-host');
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      pid,
      owner: 'legacy-owner',
      configPath,
    });
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(configDirectory, { recursive: true, force: true }),
    ]);
  });

  it('recovers an identity-marked server on Windows without environment inspection', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const configDirectory = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    const leasePath = join(directory, 'lease.json');
    const configPath = join(configDirectory, 'opencode.json');
    const pid = MOCK_WINDOWS_PID;
    await Promise.all([
      writeFile(configPath, '{}', 'utf-8'),
      writeFile(
        join(configDirectory, 'owner.json'),
        JSON.stringify({
          pid,
          owner: 'windows-owner',
          createdAt: 1234,
          port: 4096,
          executable: 'C:\\OpenCode\\opencode.exe',
          birthIdentity: 'win32:123456',
        }),
        'utf-8'
      ),
    ]);
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const script = args.at(-1) || '';
        if (command === 'netstat.exe') {
          result.stdout.emit(
            'data',
            Buffer.from(`TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${pid}\n`)
          );
        } else if (command === 'powershell.exe' && script.includes('VARRO_EXECUTABLE=')) {
          result.stdout.emit(
            'data',
            Buffer.from('VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123456\n')
          );
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

    await expect(manager.takeOwnershipOfExistingServer()).resolves.toBe(true);

    expect(manager.serverOwnership).toBe('current-host');
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      pid,
      owner: 'windows-owner',
      configPath,
    });
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(configDirectory, { recursive: true, force: true }),
    ]);
  });

  it('does not take ownership of an existing server when auto-start is disabled', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const leasePath = join(directory, 'lease.json');
    mockLinuxLeaseProcess({ parentPid: 42 });
    const manager = new OpenCodeProcess(
      4096,
      false,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath
    );

    await expect(manager.takeOwnershipOfExistingServer()).resolves.toBe(false);
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

    await expect(manager.recoverManagedServerOwnership()).rejects.toThrow(
      'ownership evidence were retained'
    );

    expect(
      (manager as unknown as { injectedConfigPath: string | null }).injectedConfigPath
    ).toBeNull();
    await expect(readFile(victimConfig, 'utf-8')).resolves.toBe('{"keep":true}');
    await expect(stat(leasePath)).resolves.toBeDefined();
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(victimDirectory, { recursive: true, force: true }),
    ]);
  });
});

describe('OpenCodeProcess config ownership', () => {
  it.each(['replacement', 'runtime-present', 'foreign', 'unmanaged'])(
    'identifies runtime config recovery only for an owned replacement: %s',
    (scenario) => {
      const manager = new OpenCodeProcess(4096, true, 'opencode');
      const state = manager as unknown as {
        hostOwner: string;
        ownershipLease: ManagedServerOwnershipLease;
      };
      state.ownershipLease = {
        version: 1,
        pid: 777,
        port: 4096,
        executable: 'fixture',
        birthIdentity: 'fixture:1',
        owner: 'fixture-owner',
        host: scenario === 'foreign' ? 'other-host' : state.hostOwner,
        state: 'active',
        createdAt: Date.now(),
      };
      if (scenario === 'runtime-present')
        state.ownershipLease.configPath = '/fixture/opencode.json';
      manager.managedProcess = scenario !== 'unmanaged';
      expect(manager.needsRuntimeConfigRecovery).toBe(scenario === 'replacement');
      expect(manager.hasRuntimeConfigRecoveryCandidate).toBe(scenario !== 'runtime-present');
    }
  );

  it.each(['missing', 'caller-config', 'native-ask', 'legacy-ask', 'malformed'])(
    'preserves caller configuration during runtime Ask recovery: %s',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'varro-ask-recovery-'));
      process.env.XDG_CONFIG_HOME = root;
      if (scenario === 'caller-config') process.env.OPENCODE_CONFIG = '/fixture/opencode.json';
      if (scenario === 'native-ask')
        process.env.OPENCODE_CONFIG_CONTENT = '{"agents":{"Ask":{"disabled":true}}}';
      if (scenario === 'legacy-ask')
        process.env.OPENCODE_CONFIG_CONTENT = '{"agent":{"ask":{"mode":"subagent"}}}';
      if (scenario === 'malformed') process.env.OPENCODE_CONFIG_CONTENT = '{broken';
      const manager = new OpenCodeProcess(4096, true, 'opencode');
      try {
        await expect(manager.shouldRestoreRuntimeAskAgent()).resolves.toBe(scenario === 'missing');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { installed: '1.18.33', running: '2.0.20', expected: true },
    { installed: '2.0.20', running: '2.0.19', expected: false },
  ])(
    'uses the running $running version instead of installed $installed for runtime rewrites',
    async ({ installed, running, expected }) => {
      const root = await mkdtemp(join(tmpdir(), 'varro-stream-live-version-'));
      process.env.XDG_CONFIG_HOME = root;
      const manager = new OpenCodeProcess(4096, true, 'opencode');
      manager.rememberInstalledCliVersion(installed);
      manager.rememberRunningServerVersion(running);
      try {
        expect(asRecord(JSON.parse(await manager.serializeInjectedConfig()))?.providers).toEqual(
          expected ? { openai: { settings: { chunkTimeout: 300000 } } } : undefined
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    'missing',
    'already-written',
    'explicit',
    'malformed',
    'foreign',
    'transferred',
    'replaced',
    'untrusted-owner',
    'old-version',
  ])('reconciles an owned reused timeout policy safely: %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'varro-stream-reused-'));
    process.env.XDG_CONFIG_HOME = root;
    const manager = new OpenCodeProcess(
      4096,
      true,
      'opencode',
      false,
      undefined,
      join(root, 'lease.json')
    );
    await manager.syncInjectedConfigFile();
    const state = manager as unknown as {
      injectedConfigPath: string;
      hostOwner: string;
      ownershipLease: ManagedServerOwnershipLease;
      matchesOwnershipLease(lease: ManagedServerOwnershipLease): Promise<boolean>;
      readOwnershipLease(): Promise<ManagedServerOwnershipLease | null>;
    };
    const configPath = state.injectedConfigPath;
    const settings: { transport: string; chunkTimeout?: number } = { transport: 'websocket' };
    if (scenario === 'already-written') settings.chunkTimeout = 300000;
    if (scenario === 'explicit') settings.chunkTimeout = 900000;
    const original =
      scenario === 'malformed'
        ? '{broken'
        : JSON.stringify({
            keep: { unrelated: true },
            providers: { openai: { settings } },
          });
    await writeFile(configPath, original);
    state.ownershipLease = {
      version: 1,
      pid: 777,
      port: 4096,
      executable: 'fixture',
      birthIdentity: 'fixture:1',
      owner: 'fixture-owner',
      host: scenario === 'foreign' ? 'other-host' : state.hostOwner,
      state: 'active',
      createdAt: Date.now(),
      configPath,
    };
    manager.managedProcess = true;
    vi.spyOn(state, 'readOwnershipLease').mockImplementation(async () =>
      scenario === 'transferred'
        ? { ...state.ownershipLease, host: 'other-host' }
        : state.ownershipLease
    );
    vi.spyOn(state, 'matchesOwnershipLease').mockResolvedValue(scenario !== 'replaced');
    await writeFile(
      join(dirname(configPath), 'owner.json'),
      JSON.stringify({
        pid: 777,
        owner: scenario === 'untrusted-owner' ? 'other-owner' : 'fixture-owner',
      })
    );
    try {
      const expected = scenario === 'missing' || scenario === 'already-written';
      await expect(
        manager.reconcileInjectedStreamTimeout(scenario === 'old-version' ? '2.0.19' : '2.0.20')
      ).resolves.toBe(expected);
      const result = await readFile(configPath, 'utf-8');
      if (scenario === 'missing')
        expect(JSON.parse(result)).toEqual({
          keep: { unrelated: true },
          providers: { openai: { settings: { transport: 'websocket', chunkTimeout: 300000 } } },
        });
      else expect(result).toBe(original);
    } finally {
      await manager.cleanupPreparedInjectedConfigFile();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'no override', content: '{}', expected: true },
    {
      name: 'native stream timeout',
      content: '{"providers":{"openai":{"settings":{"chunkTimeout":900000}}}}',
      expected: false,
    },
    {
      name: 'legacy stream timeout',
      content: '{"provider":{"openai":{"options":{"chunkTimeout":900000}}}}',
      expected: false,
    },
    {
      name: 'explicit disabled timeout',
      content: '{"providers":{"openai":{"settings":{"timeout":false}}}}',
      expected: false,
    },
    {
      name: 'another provider timeout',
      content: '{"providers":{"fixture":{"settings":{"chunkTimeout":900000}}}}',
      expected: true,
    },
    { name: 'malformed config', content: '{broken', expected: false },
  ])('bounds managed V2 OpenAI silence while preserving $name', async ({ content, expected }) => {
    const configHome = await mkdtemp(join(tmpdir(), 'varro-stream-timeout-'));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.OPENCODE_CONFIG_CONTENT = content;
    const manager = new OpenCodeProcess(4096, true, 'opencode');
    manager.rememberInstalledCliVersion('2.0.20');
    try {
      const config = asRecord(JSON.parse(await manager.serializeInjectedConfig()));
      expect(config?.providers).toEqual(
        expected ? { openai: { settings: { chunkTimeout: 300000 } } } : undefined
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  it.each(['opencode.jsonc', '.opencode/opencode.jsonc'])(
    'preserves an ancestor %s OpenAI timeout without modifying its config',
    async (filename) => {
      const root = await mkdtemp(join(tmpdir(), 'varro-stream-ancestor-'));
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      const workspace = join(root, 'parent/project');
      const configPath = join(root, 'parent', filename);
      const content =
        '{ // custom policy\n "providers": {"openai": {"settings": {"chunkTimeout": 0,}}}}';
      await mkdir(workspace, { recursive: true });
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, content);
      await mkdir(join(workspace, '.git'));
      vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
      const manager = new OpenCodeProcess(4096, true, 'opencode');
      manager.rememberInstalledCliVersion('2.0.20');
      try {
        expect(
          asRecord(JSON.parse(await manager.serializeInjectedConfig()))?.providers
        ).toBeUndefined();
        expect(await readFile(configPath, 'utf-8')).toBe(content);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['1.18.33', '2.0.5', '2.0.19'])(
    'does not inject unverified stream settings for OpenCode %s',
    async (version) => {
      const root = await mkdtemp(join(tmpdir(), 'varro-stream-version-'));
      process.env.XDG_CONFIG_HOME = root;
      const manager = new OpenCodeProcess(4096, true, 'opencode');
      manager.rememberInstalledCliVersion(version);
      try {
        expect(
          asRecord(JSON.parse(await manager.serializeInjectedConfig()))?.providers
        ).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('uses the documented global config directory and all supported filenames on Windows', () => {
    expect(getOpenCodeConfigPaths({}, 'C:\\Users\\Andrew', 'win32')).toEqual([
      'C:\\Users\\Andrew\\.config\\opencode\\config.json',
      'C:\\Users\\Andrew\\.config\\opencode\\opencode.json',
      'C:\\Users\\Andrew\\.config\\opencode\\opencode.jsonc',
    ]);
  });

  it('automatically injects the Ask agent only into the temporary runtime config', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'varro-empty-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    const config = JSON.parse(await manager.serializeInjectedConfig()) as {
      agent?: Record<string, Record<string, unknown>>;
    };

    expect(config.agent?.ask).toMatchObject({
      description: 'Answers questions and investigates the codebase without modifying anything',
      mode: 'primary',
      prompt: expect.stringContaining('Suggest switching to the Build agent.'),
      permission: {
        '*': 'deny',
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
      },
    });
    await rm(configHome, { recursive: true, force: true });
  });

  it.each(['agent', 'agents'])(
    'prefers a case-conflicting Ask agent from inherited OpenCode %s config',
    async (key) => {
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        [key]: { Ask: { description: 'User-defined agent', mode: 'primary' } },
      });
      const manager = new OpenCodeProcess(4096, true, 'opencode');

      expect(JSON.parse(await manager.serializeInjectedConfig())).toEqual({
        experimental: { continue_loop_on_deny: true },
      });
    }
  );

  it('prefers an Ask agent from an ancestor project OpenCode config', async () => {
    const project = await mkdtemp(join(tmpdir(), 'varro-project-config-'));
    const workspace = join(project, 'packages', 'app');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(project, '.git'));
    await writeFile(
      join(project, 'opencode.jsonc'),
      '{ "agent": { "ask": { "description": "Project agent" } } }',
      'utf-8'
    );
    const configHome = await mkdtemp(join(tmpdir(), 'varro-empty-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    expect(JSON.parse(await manager.serializeInjectedConfig())).toEqual({
      experimental: { continue_loop_on_deny: true },
    });

    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(configHome, { recursive: true, force: true }),
    ]);
  });

  it('checks nearer JSONC configs before JSON and ancestor configs', async () => {
    const project = await mkdtemp(join(tmpdir(), 'varro-project-config-'));
    const workspace = join(project, 'packages', 'app');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(project, '.git'));
    await Promise.all([
      writeFile(
        join(workspace, 'opencode.jsonc'),
        '{ "agent": { "ask": { "description": "Nearest agent" } } }',
        'utf-8'
      ),
      mkdir(join(workspace, 'opencode.json')),
      mkdir(join(project, 'opencode.jsonc')),
    ]);
    const configHome = await mkdtemp(join(tmpdir(), 'varro-empty-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    expect(JSON.parse(await manager.serializeInjectedConfig())).toEqual({
      experimental: { continue_loop_on_deny: true },
    });
    expect(loggerMock.warn).not.toHaveBeenCalled();

    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(configHome, { recursive: true, force: true }),
    ]);
  });

  it('does not discover project configs above the git boundary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'varro-project-config-'));
    const project = join(parent, 'repo');
    const workspace = join(project, 'packages', 'app');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(project, '.git'));
    await writeFile(
      join(parent, 'opencode.jsonc'),
      '{ "agent": { "ask": { "description": "Outer agent" } } }',
      'utf-8'
    );
    const configHome = await mkdtemp(join(tmpdir(), 'varro-empty-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    const config = JSON.parse(await manager.serializeInjectedConfig()) as {
      agent?: Record<string, unknown>;
    };
    expect(config.agent?.ask).toBeDefined();

    await Promise.all([
      rm(parent, { recursive: true, force: true }),
      rm(configHome, { recursive: true, force: true }),
    ]);
  });

  it('injects continuation defaults and Ask with no compaction override', async () => {
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    await manager.syncInjectedConfigFile();
    try {
      const env = (manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }).buildServerEnv();
      expect(env.OPENCODE_CONFIG).toBeTruthy();
      expect(JSON.parse(await readFile(env.OPENCODE_CONFIG!, 'utf-8'))).toMatchObject({
        experimental: { continue_loop_on_deny: true },
        agent: { ask: { mode: 'primary' } },
      });
    } finally {
      await manager.cleanupPreparedInjectedConfigFile();
    }
  });

  it('preserves caller OPENCODE_CONFIG instead of injecting runtime defaults', async () => {
    process.env.OPENCODE_CONFIG = '/caller/opencode.jsonc';
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    await manager.syncInjectedConfigFile();

    expect(
      (manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }).buildServerEnv()
        .OPENCODE_CONFIG
    ).toBe(process.env.OPENCODE_CONFIG);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('Preserving caller-provided OPENCODE_CONFIG')
    );
  });

  it('leaves inline and project continuation overrides for OpenCode to apply after defaults', async () => {
    const project = await mkdtemp(join(tmpdir(), 'varro-project-config-'));
    const projectConfig = join(project, 'opencode.json');
    const override = JSON.stringify({ experimental: { continue_loop_on_deny: false } });
    await writeFile(projectConfig, override, 'utf-8');
    process.env.OPENCODE_CONFIG_CONTENT = override;
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: project } }];
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    try {
      await manager.syncInjectedConfigFile();
      const env = (manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }).buildServerEnv();
      expect(env.OPENCODE_CONFIG_CONTENT).toBe(override);
      expect(env.OPENCODE_CONFIG).not.toBe(projectConfig);
      expect(JSON.parse(await readFile(env.OPENCODE_CONFIG!, 'utf-8'))).toMatchObject({
        experimental: { continue_loop_on_deny: true },
      });
      expect(await readFile(projectConfig, 'utf-8')).toBe(override);
    } finally {
      await manager.cleanupPreparedInjectedConfigFile();
      await rm(project, { recursive: true, force: true });
    }
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
    await manager.releaseExitedProcess(first as unknown as ChildProcess);

    expect(firstPath).not.toBe(secondPath);
    expect(JSON.parse(await readFile(secondPath, 'utf-8'))).toMatchObject({
      experimental: { continue_loop_on_deny: true },
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

  it('passes a special-character Windows shim path directly to cross-spawn', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const child = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockReturnValue(child);
    const command = 'C:\\Tools & More (x86)\\open^code%20!.cmd';
    const manager = new OpenCodeProcess(4096, true, command);

    manager.launchServer({
      getWorkspaceCwd: () => 'C:\\work & trees',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    expect(spawnMock).toHaveBeenCalledWith(
      command,
      ['serve', '--port', '4096'],
      expect.objectContaining({ cwd: 'C:\\work & trees', windowsHide: true })
    );
  });

  it('coalesces and caches installed CLI version reads', async () => {
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('1.18.26\n'));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    });
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    await expect(
      Promise.all([manager.readInstalledCliVersion(), manager.readInstalledCliVersion()])
    ).resolves.toEqual(['1.18.26', '1.18.26']);
    await expect(manager.readInstalledCliVersion()).resolves.toBe('1.18.26');

    expect(spawnMock).toHaveBeenCalledOnce();

    manager.clearResolvedCommandCache();
    await expect(manager.readInstalledCliVersion()).resolves.toBe('1.18.26');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('reuses a known installed CLI version without launching another probe', async () => {
    const manager = new OpenCodeProcess(4096, true, 'opencode');

    manager.rememberInstalledCliVersion('1.18.26');

    await expect(manager.readInstalledCliVersion()).resolves.toBe('1.18.26');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'drains late CLI output after exit code %s before settling on close',
    async (code) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      spawnMock.mockReturnValue(child);
      const manager = new OpenCodeProcess(4096, true, 'opencode');
      const api = manager as unknown as {
        runCliCommandWithDiagnostics(args: string[]): Promise<{ stdout: string; stderr: string }>;
      };
      const settled = vi.fn();
      const result = api.runCliCommandWithDiagnostics(['--version']);
      void result.then(settled, settled);
      child.stdout.emit('data', Buffer.from('first '));
      child.emit('exit', code, null);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      child.stdout.emit('data', Buffer.from('late stdout\n'));
      child.stderr.emit('data', Buffer.from('late diagnostic\n'));
      child.emit('close', code, null);

      if (code === 0) {
        await expect(result).resolves.toEqual({
          stdout: 'first late stdout',
          stderr: 'late diagnostic',
        });
      } else {
        await expect(result).rejects.toThrow('late diagnostic');
      }
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);
    }
  );

  it('taskkills a timed-out Windows CLI shim process tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: MOCK_WINDOWS_PID,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation((command: string) => {
      if (command === 'C:\\OpenCode\\opencode.cmd') return child;
      const result = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      });
      queueMicrotask(() => result.emit('close', 0));
      return result;
    });
    const manager = new OpenCodeProcess(4096, true, 'C:\\OpenCode\\opencode.cmd');

    const version = manager.readInstalledCliVersion();
    const rejection = expect(version).rejects.toThrow('OpenCode CLI command timed out');
    await vi.advanceTimersByTimeAsync(originalPlatform === 'win32' ? 10_100 : 5_100);

    await rejection;
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', String(MOCK_WINDOWS_PID), '/T', '/F'],
      expect.anything()
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('preserves a child-owned config when disconnect leaves the child alive', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: MOCK_WINDOWS_PID,
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
      `"pid":${MOCK_WINDOWS_PID}`
    );
    await rm(dirname(configPath), { recursive: true, force: true });
  });

  it('cleans a disconnected child-owned config when that child exits', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: MOCK_WINDOWS_PID + 1,
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
    await manager.releaseExitedProcess(child as unknown as ChildProcess);

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
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const manager = new OpenCodeProcess(
      4096,
      false,
      'opencode',
      false,
      { auto: true },
      join(directory, 'lease.json')
    );
    await manager.syncInjectedConfigFile();
    const configPath = (
      manager as unknown as { buildServerEnv(): NodeJS.ProcessEnv }
    ).buildServerEnv().OPENCODE_CONFIG!;
    manager.takeOwnershipOfExistingServer = vi.fn().mockResolvedValue(false);

    await manager.prepareForHealthyExistingServer();

    await expect(stat(configPath)).rejects.toThrow();
    await rm(directory, { recursive: true, force: true });
  });

  it('takes ownership when attaching to a marked OpenCode server', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-server-lease-test-'));
    const configDirectory = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    const leasePath = join(directory, 'lease.json');
    const configPath = join(configDirectory, 'opencode.json');
    await Promise.all([
      writeFile(configPath, '{}', 'utf-8'),
      writeFile(
        join(configDirectory, 'owner.json'),
        JSON.stringify({
          pid: MOCK_LINUX_PID,
          owner: 'attached-owner',
          createdAt: 1234,
          port: 4096,
          executable: '/usr/bin/opencode',
          birthIdentity: 'linux:Fri Jul 10 12:00:00 2026',
        }),
        'utf-8'
      ),
    ]);
    mockLinuxLeaseProcess({ parentPid: 42 });
    const manager = new OpenCodeProcess(
      4096,
      true,
      '/usr/bin/opencode',
      false,
      undefined,
      leasePath
    );

    await manager.prepareForHealthyExistingServer();

    expect(manager.managedProcess).toBe(true);
    expect(manager.managedProcessId).toBe(MOCK_LINUX_PID);
    expect(JSON.parse(await readFile(leasePath, 'utf-8'))).toMatchObject({
      pid: MOCK_LINUX_PID,
      port: 4096,
      executable: '/usr/bin/opencode',
      owner: 'attached-owner',
      configPath,
      state: 'active',
    });
    await expect(stat(configPath)).resolves.toBeDefined();

    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(configDirectory, { recursive: true, force: true }),
    ]);
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
    await symlink(
      victimDirectory,
      linkedDirectory,
      originalPlatform === 'win32' ? 'junction' : 'dir'
    );
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

    const sweepTime = Date.now() + 10 * 60_000;
    await Promise.all([
      sweepStaleInjectedConfigDirectories(sweepTime),
      sweepStaleInjectedConfigDirectories(sweepTime),
    ]);

    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(live)).resolves.toBeTruthy();
    await expect(stat(fresh)).resolves.toBeTruthy();
    const skipped = await mkdtemp(join(tmpdir(), 'varro-opencode-config-'));
    await writeFile(join(skipped, 'owner.json'), JSON.stringify({ pid: 999_999 }), 'utf-8');
    await utimes(skipped, old, old);
    await sweepStaleInjectedConfigDirectories(sweepTime + 1);
    await expect(stat(skipped)).resolves.toBeTruthy();
    await Promise.all([
      rm(live, { recursive: true, force: true }),
      rm(fresh, { recursive: true, force: true }),
      rm(skipped, { recursive: true, force: true }),
    ]);
  });
});

describe('OpenCodeProcess install resolution', () => {
  it.each([
    { configured: false, laterVersion: '2.0.17', brokenWrapper: false },
    { configured: true, laterVersion: '2.0.17', brokenWrapper: false },
    { configured: false, laterVersion: '1.18.33', brokenWrapper: false },
    { configured: false, laterVersion: '2.0.17', brokenWrapper: true },
  ])(
    'verifies shadowed CLI candidates with $configured, $laterVersion, $brokenWrapper',
    async ({ configured, laterVersion, brokenWrapper }) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const root = await mkdtemp(join(tmpdir(), 'varro-shadowed-cli-'));
      const early = join(root, 'early');
      const later = join(root, 'later');
      await mkdir(early);
      await mkdir(later);
      const wrapper = join(early, 'opencode2');
      const installed = join(later, 'opencode2');
      await writeFile(wrapper, '#!/bin/sh\nexec opencode "$@"\n');
      await writeFile(installed, '');
      const manager = new OpenCodeProcess('auto', true, configured ? wrapper : '');
      vi.spyOn(
        manager as unknown as { serverPathEntries(): string[] },
        'serverPathEntries'
      ).mockReturnValue([early, later]);
      spawnMock.mockImplementation((command: string) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          if (command === wrapper && brokenWrapper) {
            child.stderr.emit('data', Buffer.from('wrapper failed'));
            child.emit('close', 1, null);
          } else {
            child.stdout.emit('data', Buffer.from(command === wrapper ? '1.18.34' : laterVersion));
            child.emit('close', 0, null);
          }
        });
        return child;
      });
      try {
        expect(manager.resolveCommand()).toBe(wrapper);
        const useLater = !configured && laterVersion.startsWith('2.');
        await expect(manager.readInstalledCliVersion()).resolves.toBe(
          useLater ? laterVersion : '1.18.34'
        );
        expect(manager.resolveCommand()).toBe(useLater ? installed : wrapper);
        expect(spawnMock).toHaveBeenCalledTimes(configured ? 1 : 2);
        await manager.readInstalledCliVersion();
        expect(spawnMock).toHaveBeenCalledTimes(configured ? 1 : 2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { name: 'idle managed server', configured: false, active: false, managed: true },
    { name: 'busy managed server', configured: false, active: true, managed: true },
    { name: 'explicit v1 CLI', configured: true, active: false, managed: true },
    { name: 'unmanaged server', configured: false, active: false, managed: false },
  ])('checks a newly installed v2 CLI for $name', async ({ configured, active, managed }) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-opencode-discovery-'));
    const v1 = join(directory, 'opencode');
    const v2 = join(directory, 'opencode2');
    await writeFile(v1, '');
    const manager = new OpenCodeProcess(4096, true, configured ? v1 : '');
    vi.spyOn(
      manager as unknown as { serverPathEntries(): string[] },
      'serverPathEntries'
    ).mockReturnValue([directory]);
    spawnMock.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(command === v2 ? '2.0.6\n' : '1.18.26\n'));
        child.emit('close', 0, null);
      });
      return child;
    });
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const callbacks = {
      isDisposing: () => false,
      getStatus: () => ({ state: 'running' as const, url: manager.url }),
      readInstalledCliVersion: () => manager.readInstalledCliVersion(),
      maybeSuggestCliUpdate: vi.fn().mockResolvedValue(null),
      readHealthInfo: vi.fn().mockResolvedValue({ healthy: true, version: '1.18.26' }),
      hasActiveSessions: vi.fn().mockResolvedValue(active),
      takeOwnershipOfExistingServer: vi.fn().mockResolvedValue(false),
      restartServerForCliUpdate,
    };
    manager.managedProcess = managed;
    try {
      await expect(manager.readInstalledCliVersion()).resolves.toBe('1.18.26');
      expect(manager.resolveCommand()).toBe(v1);
      await writeFile(v2, '');

      // Routine reads retain the short-lived version cache.
      await expect(manager.readInstalledCliVersion()).resolves.toBe('1.18.26');
      expect(spawnMock).toHaveBeenCalledOnce();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000);
      await manager.runMaintenanceTick(callbacks);

      expect(manager.resolveCommand()).toBe(configured ? v1 : v2);
      if (!configured) expect(callbacks.maybeSuggestCliUpdate).not.toHaveBeenCalled();
      if (!configured && managed && !active) {
        expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.18.26', '2.0.6');
      } else {
        expect(restartServerForCliUpdate).not.toHaveBeenCalled();
      }
      if (active) {
        callbacks.hasActiveSessions.mockResolvedValue(false);
        await manager.runMaintenanceTick(callbacks);
        expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.18.26', '2.0.6');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['darwin', ''],
    ['linux', ''],
    ['win32', '.exe'],
    ['win32', '.cmd'],
    ['win32', '.bat'],
  ])('prefers v2 across search directories on %s with suffix %s', async (platform, suffix) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const directory = await mkdtemp(join(tmpdir(), 'varro-opencode-discovery-'));
    const v1Directory = join(directory, 'v1');
    const v2Directory = join(directory, 'v2');
    await mkdir(v1Directory);
    await mkdir(v2Directory);
    const v1 = join(v1Directory, `opencode${suffix}`);
    const v2 = join(v2Directory, `opencode2${suffix}`);
    await writeFile(v1, '');
    await writeFile(v2, '');
    const manager = new OpenCodeProcess(4096, true, '  ');
    vi.spyOn(
      manager as unknown as { serverPathEntries(): string[] },
      'serverPathEntries'
    ).mockReturnValue([v1Directory, v2Directory]);
    try {
      expect(manager.resolveCommandInfo()).toEqual({ command: v2, found: true });

      manager.updateLaunchSettings({ autoStart: true, command: 'opencode' });
      expect(manager.resolveCommandInfo()).toEqual({ command: v1, found: true });

      manager.updateLaunchSettings({ autoStart: true, command: v1 });
      expect(manager.resolveCommandInfo()).toEqual({ command: v1, found: true });

      manager.updateLaunchSettings({ autoStart: true, command: '' });
      expect(manager.resolveCommandInfo()).toEqual({ command: v2, found: true });

      await rm(v2);
      manager.clearResolvedCommandCache();
      expect(manager.resolveCommandInfo()).toEqual({ command: v1, found: true });

      await rm(v1);
      manager.clearResolvedCommandCache();
      expect(manager.resolveCommandInfo()).toEqual({
        command: platform === 'win32' ? 'opencode.cmd' : 'opencode',
        found: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a configured path that does not exist as missing', () => {
    const missingPath = join(tmpdir(), 'varro-missing-opencode-binary');
    const manager = new OpenCodeProcess(4096, true, missingPath);

    const info = manager.getInstallInfo();

    expect(info.configuredCommandMissing).toBe(true);
    expect(info.configuredCommand).toBe(missingPath);
    expect(info.installMethod).toBe('custom');
    // A configured command bypasses the PATH scan entirely.
    expect(info.searchedPaths).toEqual([]);
  });

  it('reports a configured bare command that is absent from PATH as missing', () => {
    const manager = new OpenCodeProcess(4096, true, 'varro-missing-opencode-command');

    const info = manager.getInstallInfo();

    expect(info.configuredCommandMissing).toBe(true);
    expect(info.found).toBe(false);
    expect(info.searchedPaths.length).toBeGreaterThan(0);
  });

  it('resolves a configured bare command through the server PATH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'varro-opencode-path-'));
    const binary = join(directory, 'opencode');
    await writeFile(binary, '#!/bin/sh\n', 'utf-8');
    // Windows worker environments are case-sensitive, unlike the native host.
    vi.stubEnv(getPathVariableKey(), directory);
    try {
      const manager = new OpenCodeProcess(4096, true, 'opencode');

      expect(manager.resolveCommand()).toBe(binary);
      expect(manager.getInstallInfo().configuredCommandMissing).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts a configured path that exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'varro-opencode-bin-'));
    const binary = join(directory, 'opencode');
    await writeFile(binary, '#!/bin/sh\n', 'utf-8');
    try {
      const manager = new OpenCodeProcess(4096, true, binary);

      expect(manager.getInstallInfo().configuredCommandMissing).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses updated launch settings without recreating the process manager', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'varro-opencode-settings-'));
    const binary = join(directory, 'opencode');
    await writeFile(binary, '#!/bin/sh\n', 'utf-8');
    try {
      const manager = new OpenCodeProcess(4096, true, '/missing/opencode');

      manager.updateLaunchSettings({ autoStart: false, command: binary });

      expect(manager.isAutoStartEnabled).toBe(false);
      expect(manager.resolveCommand()).toBe(binary);
      expect(manager.getInstallInfo().configuredCommandMissing).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('classifies an upgrade error into guidance that omits the failed command', () => {
    const manager = new OpenCodeProcess(4096, true, '/home/me/.bun/bin/opencode');
    vi.spyOn(manager, 'getInstallInfo').mockReturnValue({
      resolvedCommand: '/home/me/.bun/bin/opencode',
      configuredCommand: '',
      configuredCommandMissing: false,
      found: true,
      installMethod: 'bun',
      searchedPaths: ['/home/me/.bun/bin'],
    });

    const report = manager.describeUpgradeError(new Error('bun: command not found'));

    expect(report.kind).toBe('missing-package-manager');
    expect(report.installMethod).toBe('bun');
    expect(report.cause).toBe('bun: command not found');
    expect(report.guidance).not.toContain('opencode upgrade');
    expect(report.guidance).toContain('bun');
    // `bun add -g ...` cannot run when bun is what went missing, so there is no
    // command to offer - only the explanation.
    expect(report.suggestedCommand).toBeNull();
  });

  it('still offers the install command for failures the manager can retry', () => {
    const manager = new OpenCodeProcess(4096, true, '');
    vi.spyOn(manager, 'getInstallInfo').mockReturnValue({
      resolvedCommand: '/Users/me/.npm-global/bin/opencode',
      configuredCommand: '',
      configuredCommandMissing: false,
      found: true,
      installMethod: 'npm',
      searchedPaths: [],
    });

    const report = manager.describeUpgradeError(new Error('ETIMEDOUT connecting to registry'));

    expect(report.kind).toBe('network');
    expect(report.suggestedCommand).toBe('npm install -g opencode-ai@latest');
  });
});
