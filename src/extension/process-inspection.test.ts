/* oxlint-disable anti-slop/no-module-mocking -- OS account inspection is tested without invoking real process commands. */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, nativeReadMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  nativeReadMock: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('./windows-process-inspector', () => ({
  WindowsProcessInspector: class {
    read = nativeReadMock;
  },
}));
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));
import { logger } from './logger';
import {
  findListeningPids,
  inspectLocalServerAccount,
  readWindowsProcessIdentity,
} from './process-inspection';

const originalPlatform = process.platform;
const originalGeteuid = Object.getOwnPropertyDescriptor(process, 'geteuid');
const hostUid = 1000;
const listenerPid = 1_072_000_000 + process.pid;

beforeEach(() => {
  nativeReadMock.mockRejectedValue(new Error('Native inspection unavailable'));
});

function mockCommands(
  platform: NodeJS.Platform,
  foreign = false,
  ambiguous = false,
  denied = false
) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'geteuid', { value: () => hostUid, configurable: true });
  spawnMock.mockImplementation((command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      const script = args.at(-1) ?? '';
      let output: string;
      if (command === 'netstat.exe')
        output = [listenerPid, ...(ambiguous ? [listenerPid + 1] : [])]
          .map((pid) => `  TCP  127.0.0.1:4096  0.0.0.0:0  LISTENING  ${pid}`)
          .join('\n');
      else if (script.includes('GetOwnerSid'))
        output = denied
          ? ''
          : `VARRO_BIRTH=123\nVARRO_LISTENER_SID=S-1-5-21-${foreign ? 2 : 1}\nVARRO_HOST_SID=S-1-5-21-1`;
      else if (script.includes('CreationDate') || args.includes('lstart=')) output = '123';
      else if (args.includes('uid=')) output = denied ? '' : String(hostUid + (foreign ? 1 : 0));
      else output = ambiguous ? `${listenerPid}\n${listenerPid + 1}` : String(listenerPid);
      child.stdout.emit('data', Buffer.from(output));
      child.emit('close', 0);
    });
    return child;
  });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalGeteuid) Object.defineProperty(process, 'geteuid', originalGeteuid);
  else Reflect.deleteProperty(process, 'geteuid');
  vi.clearAllMocks();
});

describe('local listener account inspection', () => {
  it('uses one PowerShell invocation for Windows account and PID-reuse checks', async () => {
    mockCommands('win32');
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({
      kind: 'same-user',
      identity: `${listenerPid}:win32:123:S-1-5-21-1`,
    });
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual([
      'netstat.exe',
      'powershell.exe',
    ]);
    const script = spawnMock.mock.calls[1]?.[1].at(-1);
    expect(script).toContain('$verified.CreationDate.ToUniversalTime().Ticks -ne $birth');
    expect(script).toContain('GetOwnerSid');
  });
  it.each(['darwin', 'linux', 'win32'] as const)(
    'distinguishes account identities on %s',
    async (platform) => {
      mockCommands(platform);
      await expect(inspectLocalServerAccount(4096)).resolves.toMatchObject({
        kind: 'same-user',
        identity: expect.any(String),
      });
      mockCommands(platform, true);
      await expect(inspectLocalServerAccount(4096)).resolves.toMatchObject({
        kind: 'different-user',
        identity: expect.any(String),
      });
    }
  );

  it.each(['darwin', 'linux', 'win32'] as const)(
    'does not infer ownership from ambiguous listeners on %s',
    async (platform) => {
      mockCommands(platform, false, true);
      await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
    }
  );

  it.each(['darwin', 'linux'] as const)(
    'preserves uncertainty when the host UID is unavailable on %s',
    async (platform) => {
      mockCommands(platform);
      Reflect.deleteProperty(process, 'geteuid');
      await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
    }
  );

  it.each(['darwin', 'linux', 'win32'] as const)(
    'preserves uncertainty when account inspection is denied on %s',
    async (platform) => {
      mockCommands(platform, false, false, true);
      await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
    }
  );
});

describe('Windows listener and process inspection', () => {
  function commandOutput(
    run: (command: string, args: string[]) => { stdout: string; code: number }
  ) {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        const result = run(command, args);
        child.stdout.emit('data', Buffer.from(result.stdout));
        child.emit('close', result.code);
      });
      return child;
    });
  }

  it('selects exact listening endpoints without loading PowerShell', async () => {
    commandOutput(() => ({
      stdout: [
        `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${listenerPid}`,
        `TCP [::1]:4096 [::]:0 LISTENING ${listenerPid}`,
        `TCP 127.0.0.1:14096 0.0.0.0:0 LISTENING ${listenerPid + 1}`,
        `TCP 127.0.0.1:4096 127.0.0.1:1234 ESTABLISHED ${listenerPid + 2}`,
        `TCP 127.0.0.1:1234 127.0.0.1:4096 ESTABLISHED ${listenerPid + 3}`,
        `UDP 127.0.0.1:4096 *:* ${listenerPid + 4}`,
      ].join('\n'),
      code: 0,
    }));
    await expect(findListeningPids(4096)).resolves.toEqual([listenerPid]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('uses native identity and account reads without starting a CIM inspection', async () => {
    commandOutput(() => ({
      stdout: `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${listenerPid}`,
      code: 0,
    }));
    nativeReadMock.mockResolvedValue({
      executable: 'C:\\OpenCode\\opencode.exe',
      birthIdentity: 'win32:123',
      listenerSid: 'S-1-5-21-1',
      hostSid: 'S-1-5-21-1',
    });
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toEqual({
      executable: 'C:\\OpenCode\\opencode.exe',
      birthIdentity: 'win32:123',
    });
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({
      kind: 'same-user',
      identity: `${listenerPid}:win32:123:S-1-5-21-1`,
    });
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual(['netstat.exe']);
  });

  it('does not treat missing native account evidence as same-user proof', async () => {
    commandOutput((command) => ({
      stdout:
        command === 'netstat.exe' ? `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${listenerPid}` : '',
      code: 0,
    }));
    nativeReadMock.mockResolvedValue({
      executable: 'C:\\OpenCode\\opencode.exe',
      birthIdentity: 'win32:123',
      listenerSid: '',
      hostSid: '',
    });
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
  });

  it('does not launch PowerShell for a successfully inspected empty port', async () => {
    commandOutput(() => ({ stdout: '', code: 0 }));
    await expect(findListeningPids(4096)).resolves.toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to PowerShell when netstat fails', async () => {
    commandOutput((command) => ({
      stdout: command === 'netstat.exe' ? '' : String(listenerPid),
      code: command === 'netstat.exe' ? 1 : 0,
    }));
    await expect(findListeningPids(4096)).resolves.toEqual([listenerPid]);
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual([
      'netstat.exe',
      'powershell.exe',
    ]);
  });

  it('reports failure when both listener commands fail', async () => {
    commandOutput(() => ({ stdout: '', code: 1 }));
    await expect(findListeningPids(4096)).rejects.toThrow('Cannot inspect the listener');
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
  });

  it('reads executable and birth identity in one process snapshot', async () => {
    commandOutput(() => ({
      stdout: 'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123456',
      code: 0,
    }));
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toEqual({
      executable: 'C:\\OpenCode\\opencode.exe',
      birthIdentity: 'win32:123456',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1].at(-1)).toContain(
      '$verified.CreationDate.ToUniversalTime().Ticks -ne $birth'
    );
  });

  it('retries a failed executable inspection with a fresh PID-reuse-checked snapshot', async () => {
    let attempts = 0;
    commandOutput(() =>
      ++attempts === 1
        ? { stdout: '', code: 1 }
        : { stdout: 'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123456', code: 0 }
    );
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toEqual({
      executable: 'C:\\OpenCode\\opencode.exe',
      birthIdentity: 'win32:123456',
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const [, args] of spawnMock.mock.calls) {
      expect(args.at(-1)).toContain('$verified.CreationDate.ToUniversalTime().Ticks -ne $birth');
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exit code 1'));
  });

  it('retries missing executable output without accepting birth identity alone', async () => {
    let attempts = 0;
    commandOutput(() => ({
      stdout:
        ++attempts === 1
          ? 'VARRO_BIRTH=123456'
          : 'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123456',
      code: 0,
    }));
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toEqual({
      executable: 'C:\\OpenCode\\opencode.exe',
      birthIdentity: 'win32:123456',
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('retries a timed-out inspection without trusting its partial output', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const children: Array<EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }> =
      [];
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
        exitCode: null,
      });
      children.push(child);
      return child;
    });
    try {
      const inspection = readWindowsProcessIdentity(listenerPid);
      await Promise.resolve();
      children[0]!.stdout.emit(
        'data',
        Buffer.from('VARRO_EXECUTABLE=C:\\Old\\opencode.exe\nVARRO_BIRTH=123456')
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(2);
      expect(children[0]!.kill).toHaveBeenCalled();
      children[1]!.stdout.emit(
        'data',
        Buffer.from('VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=654321')
      );
      children[1]!.emit('close', 0);
      await expect(inspection).resolves.toEqual({
        executable: 'C:\\OpenCode\\opencode.exe',
        birthIdentity: 'win32:654321',
      });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 10000ms'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transient account inspection failure before reporting unknown ownership', async () => {
    let attempts = 0;
    commandOutput((command) => {
      if (command === 'netstat.exe')
        return { stdout: `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${listenerPid}`, code: 0 };
      return ++attempts === 1
        ? { stdout: '', code: 1 }
        : {
            stdout: 'VARRO_BIRTH=123\nVARRO_LISTENER_SID=S-1-5-21-1\nVARRO_HOST_SID=S-1-5-21-1',
            code: 0,
          };
    });
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({
      kind: 'same-user',
      identity: `${listenerPid}:win32:123:S-1-5-21-1`,
    });
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual([
      'netstat.exe',
      'powershell.exe',
      'powershell.exe',
    ]);
  });

  it('does not reuse a successful identity when subsequent inspections fail', async () => {
    let attempts = 0;
    commandOutput(() =>
      ++attempts === 1
        ? { stdout: 'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123456', code: 0 }
        : { stdout: '', code: 1 }
    );
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toMatchObject({
      birthIdentity: 'win32:123456',
    });
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toEqual({
      executable: '',
      birthIdentity: '',
    });
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { stdout: 'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe\nVARRO_BIRTH=123', code: 1 },
    { stdout: 'VARRO_EXECUTABLE=C:\\OpenCode\\opencode.exe', code: 0 },
    { stdout: 'VARRO_BIRTH=123456', code: 0 },
    { stdout: 'VARRO_BIRTH=invalid', code: 0 },
  ])('does not accept a failed or incomplete process inspection: %j', async (result) => {
    commandOutput((command) =>
      command === 'netstat.exe'
        ? { stdout: `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${listenerPid}`, code: 0 }
        : result
    );
    await expect(readWindowsProcessIdentity(listenerPid)).resolves.toEqual({
      executable: '',
      birthIdentity: '',
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([
    'VARRO_BIRTH=123\nVARRO_LISTENER_SID=S-1-5-21-1',
    'VARRO_BIRTH=123\nVARRO_LISTENER_SID=invalid\nVARRO_HOST_SID=S-1-5-21-1',
  ])('preserves unknown account ownership for incomplete or invalid SID output', async (stdout) => {
    commandOutput((command) => ({
      stdout:
        command === 'netstat.exe'
          ? `TCP 127.0.0.1:4096 0.0.0.0:0 LISTENING ${listenerPid}`
          : stdout,
      code: 0,
    }));
    await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
  });
});
