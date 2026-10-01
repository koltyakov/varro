/* oxlint-disable anti-slop/no-module-mocking -- OS account inspection is tested without invoking real process commands. */
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));
import { inspectLocalServerAccount } from './process-inspection';

const originalPlatform = process.platform;
const listenerPid = 1_072_000_000 + process.pid;

function mockCommands(
  platform: NodeJS.Platform,
  foreign = false,
  ambiguous = false,
  denied = false
) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      const script = args.at(-1) ?? '';
      let output: string;
      if (script.includes('GetOwnerSid'))
        output = denied ? '' : `S-1-5-21-${foreign ? 2 : 1}\nS-1-5-21-1`;
      else if (script.includes('CreationDate') || args.includes('lstart=')) output = '123';
      else if (args.includes('uid='))
        output = denied ? '' : String((process.geteuid?.() ?? 0) + (foreign ? 1 : 0));
      else output = ambiguous ? `${listenerPid}\n${listenerPid + 1}` : String(listenerPid);
      child.stdout.emit('data', Buffer.from(output));
      child.emit('close', 0);
    });
    return child;
  });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.clearAllMocks();
});

describe('local listener account inspection', () => {
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

  it.each(['darwin', 'linux', 'win32'] as const)(
    'preserves uncertainty when account inspection is denied on %s',
    async (platform) => {
      mockCommands(platform, false, false, true);
      await expect(inspectLocalServerAccount(4096)).resolves.toEqual({ kind: 'unknown' });
    }
  );
});
