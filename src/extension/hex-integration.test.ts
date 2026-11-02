/* oxlint-disable anti-slop/no-module-mocking -- Dictation discovery and CLI tests must never activate installed apps or microphones. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { delimiter, join } from 'node:path';
import type { JsonObject } from '../shared/type-utils';

interface TestEnvironment {
  remoteName?: string;
}

interface HexFixture {
  state: 'idle' | 'recording' | 'transcribing' | 'unknown';
  running: boolean;
}

const mocks = vi.hoisted(() => {
  const env: TestEnvironment = {};
  const capture: HexFixture = { state: 'idle', running: true };
  return {
    env,
    capture,
    stat: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
    runFile:
      vi.fn<
        (
          file: string,
          args: string[],
          options: ExecFileOptions
        ) => Promise<{ stdout: string; stderr: string }>
      >(),
  };
});
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.runFile }),
}));
vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
  access: mocks.access,
  readFile: mocks.readFile,
}));
vi.mock('vscode', () => ({
  env: mocks.env,
}));

import { HexIntegration } from './hex-integration';

function output(reply: JsonObject) {
  return { stdout: JSON.stringify({ version: 4, ...reply }), stderr: '' };
}

function statusOutput() {
  return output({
    status: 'status',
    listener: { running: mocks.capture.running },
    capture: { state: mocks.capture.state },
  });
}

function refusal(code: string, message: string) {
  return Object.assign(new Error(message), {
    code: code === 'not-running' ? 3 : 1,
    ...output({ status: 'error', code, message }),
  });
}

const originalPlatform = process.platform;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mocks.env.remoteName = undefined;
  mocks.capture.state = 'idle';
  mocks.capture.running = true;
  mocks.stat.mockResolvedValue({ isFile: () => true });
  mocks.access.mockResolvedValue(undefined);
  mocks.runFile.mockImplementation(async (_file, args) => {
    if (args[0] === 'status') return statusOutput();
    mocks.capture.state =
      args[1] === 'start' ? 'recording' : args[1] === 'stop' ? 'transcribing' : 'idle';
    return output({ status: 'done', changed: true });
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('HexIntegration', () => {
  it('does no discovery or CLI work on remote hosts or after disposal', async () => {
    const integration = new HexIntegration();
    mocks.env.remoteName = 'ssh-remote';
    expect(await integration.request('start')).toMatchObject({ available: false, running: false });
    mocks.env.remoteName = undefined;
    integration.dispose();
    await integration.request('start');
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.runFile).not.toHaveBeenCalled();
  });

  it('discovers the macOS executable and reads JSON status without starting Hex or watching', async () => {
    expect(await new HexIntegration().request('status')).toMatchObject({
      available: true,
      running: true,
      state: 'idle',
    });
    expect(mocks.runFile).toHaveBeenCalledExactlyOnceWith(
      '/Applications/Hex.app/Contents/MacOS/hex',
      ['status', '--json'],
      {
        timeout: 2000,
        maxBuffer: 1048576,
        windowsHide: true,
      }
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run commands when missing, not running, or not listening', async () => {
    const integration = new HexIntegration();
    mocks.stat.mockRejectedValue(new Error('missing'));
    expect(await integration.request('start')).toMatchObject({ available: false, running: false });
    expect(mocks.runFile).not.toHaveBeenCalled();
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.runFile.mockRejectedValue(refusal('not-running', 'Hex is not running'));
    expect(await integration.request('status')).toMatchObject({
      available: true,
      running: false,
      state: 'idle',
    });
    expect(await integration.request('start')).toMatchObject({
      running: false,
      error: expect.stringContaining('Start Hex'),
    });
    mocks.runFile.mockResolvedValue(
      output({ status: 'status', listener: { running: false }, capture: { state: 'unknown' } })
    );
    expect(await integration.request('start')).toMatchObject({
      running: false,
      error: expect.stringContaining('Start Hex'),
    });
    expect(mocks.runFile.mock.calls.every(([, args]) => args[0] === 'status')).toBe(true);
  });

  it.each([
    ['start', 'recording'],
    ['stop', 'processing'],
    ['cancel', 'idle'],
  ] as const)('runs explicit %s with fixed arguments and observes %s', async (action, state) => {
    const integration = new HexIntegration();
    expect(await integration.request(action)).toMatchObject({
      available: true,
      running: true,
      state,
    });
    expect(mocks.runFile).toHaveBeenNthCalledWith(
      2,
      '/Applications/Hex.app/Contents/MacOS/hex',
      ['dictation', action, '--json'],
      {
        timeout: 12000,
        maxBuffer: 1048576,
        windowsHide: true,
      }
    );
    expect(mocks.runFile.mock.calls.map(([, args]) => args)).toEqual([
      ['status', '--json'],
      ['dictation', action, '--json'],
      ['status', '--json'],
    ]);
  });

  it('finds Linux executables on absolute PATH entries only', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // Exercise shell syntax without using Windows' PATH separator.
    const directory = '/custom/bin with spaces&safe';
    vi.stubEnv('PATH', `.${delimiter}${directory}`);
    mocks.stat.mockImplementation(async (path: string) => {
      if (path === join(directory, 'hex')) return { isFile: () => true };
      throw new Error('missing');
    });
    expect(await new HexIntegration().request('start')).toMatchObject({ available: true });
    expect(mocks.stat).not.toHaveBeenCalledWith('hex');
    expect(mocks.runFile).toHaveBeenNthCalledWith(
      2,
      join(directory, 'hex'),
      ['dictation', 'start', '--json'],
      expect.any(Object)
    );
  });

  it('finds the managed Windows version without starting a shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('APPDATA', '/roaming');
    mocks.readFile.mockResolvedValue('0.0.0-dev-456\r\n');
    expect(await new HexIntegration().request('status')).toMatchObject({ available: true });
    expect(mocks.readFile).toHaveBeenCalledWith(join('/roaming', 'hex/current-version'), 'utf8');
    expect(mocks.runFile.mock.calls[0]?.[0]).toBe(
      join('/roaming', 'hex/versions/0.0.0-dev-456/hex.exe')
    );
  });

  it.each(['..', '.', '../outside', 'version/../../outside', 'x'.repeat(129)])(
    'rejects unsafe Windows version pointer %s',
    async (version) => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      vi.stubEnv('APPDATA', '/roaming');
      vi.stubEnv('PATH', 'relative');
      mocks.readFile.mockResolvedValue(version);
      expect(await new HexIntegration().request('status')).toMatchObject({ available: false });
      expect(mocks.stat).not.toHaveBeenCalled();
    }
  );

  it('reports structured command refusals without retrying or toggling', async () => {
    mocks.runFile
      .mockResolvedValueOnce(statusOutput())
      .mockRejectedValueOnce(refusal('not-ready', 'Microphone permission is required'));
    expect(await new HexIntegration().request('start')).toMatchObject({
      error: expect.stringContaining('Microphone permission is required'),
      state: 'idle',
    });
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it('treats silent discarded recordings as finished rather than a command failure', async () => {
    mocks.runFile
      .mockResolvedValueOnce(statusOutput())
      .mockRejectedValueOnce(refusal('discarded', 'No speech'));
    const result = await new HexIntegration().request('stop');
    expect(result.state).toBe('idle');
    expect(result.error).toBeUndefined();
  });

  it.each([
    'not JSON',
    '{}',
    '{"version":4,"status":"status","listener":{"running":true},"capture":{"state":"invented"}}',
  ])('reports incompatible or malformed replies without recording', async (stdout) => {
    mocks.runFile.mockResolvedValue({ stdout, stderr: '' });
    expect((await new HexIntegration().request('start')).error).toBeTypeOf('string');
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
  });

  it('preserves command timeout diagnostics and never retries delivery', async () => {
    mocks.runFile
      .mockResolvedValueOnce(statusOutput())
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { stdout: '' }));
    expect((await new HexIntegration().request('start')).error).toContain('timed out');
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it('does not activate after disposal during discovery or a late filesystem read', async () => {
    const integration = new HexIntegration();
    mocks.stat.mockImplementationOnce(async () => {
      integration.dispose();
      return { isFile: () => true };
    });
    await integration.request('start');
    expect(mocks.runFile).not.toHaveBeenCalled();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      mocks.stat.mockImplementationOnce(async () => {
        controller.abort(new Error('discovery expired'));
        return { isFile: () => true };
      });
      expect((await new HexIntegration().request('start')).error).toContain('discovery expired');
      expect(mocks.runFile).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('watches explicit dictation through external finish and transcription, then stops at idle', async () => {
    const integration = new HexIntegration();
    const notify = vi.fn();
    await integration.request('start', notify);
    await vi.advanceTimersByTimeAsync(1000);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'recording' }));
    mocks.capture.state = 'transcribing';
    await vi.advanceTimersByTimeAsync(1000);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'processing' }));
    mocks.capture.state = 'idle';
    await vi.advanceTimersByTimeAsync(1000);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'idle' }));
    expect(vi.getTimerCount()).toBe(0);
    integration.dispose();
  });

  it('does not publish an old in-flight observation after cancellation or disposal', async () => {
    const integration = new HexIntegration();
    const notify = vi.fn();
    await integration.request('start', notify);
    let release: ((value: { stdout: string; stderr: string }) => void) | undefined;
    mocks.runFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(1000);
    await integration.request('cancel', notify);
    release?.(
      output({ status: 'status', listener: { running: true }, capture: { state: 'recording' } })
    );
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    await integration.request('start', notify);
    integration.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(notify).not.toHaveBeenCalled();
  });
});
