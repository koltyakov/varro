/* oxlint-disable anti-slop/no-module-mocking -- Discovery and CLI activation must not touch installed apps during unit tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { DictationRecordingState } from '../shared/protocol';
import packageJson from '../../package.json';

interface HandyTestEnvironment {
  remoteName: string | undefined;
}

interface RecordingFixture {
  state: DictationRecordingState;
  revision: number;
  observation: number;
}

interface LogPathFixture {
  get?: () => string | undefined;
}

const mocks = vi.hoisted(() => {
  const env: HandyTestEnvironment = { remoteName: undefined };
  const recording: RecordingFixture = {
    state: 'unknown',
    revision: 0,
    observation: 0,
  };
  const logPath: LogPathFixture = {};
  return {
    runFile:
      vi.fn<
        (
          file: string,
          args: string[],
          options: ExecFileOptions
        ) => Promise<{ stdout: string; stderr: string }>
      >(),
    stat: vi.fn(),
    access: vi.fn(),
    read: vi.fn<() => Promise<DictationRecordingState>>(),
    watch: vi.fn<(listener: (state: DictationRecordingState) => void) => boolean>(),
    stopWatching: vi.fn(),
    dispose: vi.fn(),
    recording,
    logPath,
    env,
  };
});
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.runFile }),
}));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, access: mocks.access }));
vi.mock('vscode', () => ({
  env: mocks.env,
}));
vi.mock('./handy-recording-state', () => ({
  HandyRecordingStateReader: class {
    constructor(getPath: () => string | undefined) {
      mocks.logPath.get = getPath;
    }
    get state() {
      return mocks.recording.state;
    }
    get revision() {
      return mocks.recording.revision;
    }
    get observation() {
      return mocks.recording.observation;
    }
    read = mocks.read;
    watch = mocks.watch;
    stopWatching = mocks.stopWatching;
    dispose = mocks.dispose;
    assume(state: DictationRecordingState) {
      mocks.recording.state = state;
      mocks.recording.revision++;
    }
    reset(state: DictationRecordingState) {
      this.assume(state);
      mocks.stopWatching();
    }
  },
}));

import { HandyIntegration } from './handy-integration';

const originalPlatform = process.platform;
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'getuid', { value: () => 501, configurable: true });
  mocks.env.remoteName = undefined;
  mocks.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
  mocks.access.mockResolvedValue(undefined);
  mocks.recording.state = 'unknown';
  mocks.recording.revision = 0;
  mocks.recording.observation = 0;
  mocks.read.mockImplementation(async () => mocks.recording.state);
  mocks.watch.mockReturnValue(true);
  mocks.runFile.mockImplementation(async (_file, args) => {
    if (args[0] === '--toggle-transcription' || args[0] === '--cancel') {
      mocks.recording.state =
        args[0] === '--cancel'
          ? 'idle'
          : mocks.recording.state === 'recording'
            ? 'processing'
            : 'recording';
      mocks.recording.observation++;
      mocks.recording.revision++;
    }
    return { stdout: '123\n', stderr: '' };
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid);
  else Reflect.deleteProperty(process, 'getuid');
  vi.unstubAllEnvs();
});

describe('HandyIntegration', () => {
  it('never discovers or activates on a remote host', async () => {
    mocks.env.remoteName = 'ssh-remote';
    expect(await new HandyIntegration().request('start')).toMatchObject({
      available: false,
      running: false,
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.runFile).not.toHaveBeenCalled();
  });

  it('discovers a macOS bundle and inspects processes without launching Handy', async () => {
    expect(await new HandyIntegration().request('status')).toMatchObject({
      available: true,
      running: true,
    });
    expect(mocks.stat).toHaveBeenCalledWith('/Applications/Handy.app/Contents/MacOS/Handy');
    expect(mocks.stat).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
    expect(mocks.runFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/pgrep',
      ['-u', String(process.getuid!()), '-x', 'Handy|handy'],
      expect.objectContaining({ timeout: 2000 })
    );
  });

  it('does not run commands when Handy is missing or stopped', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'));
    expect(await new HandyIntegration().request('start')).toMatchObject({
      available: false,
      running: false,
    });
    expect(mocks.runFile).not.toHaveBeenCalled();
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.runFile.mockRejectedValue(Object.assign(new Error('no match'), { code: 1 }));
    expect(await new HandyIntegration().request('start')).toMatchObject({
      available: true,
      running: false,
      error: expect.stringContaining('Start Handy'),
    });
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['start', '--toggle-transcription'],
    ['stop', '--toggle-transcription'],
    ['cancel', '--cancel'],
  ] as const)('invokes %s with fixed arguments and a bound', async (action, flag) => {
    if (action !== 'start') mocks.recording.state = 'recording';
    expect(await new HandyIntegration().request(action)).toMatchObject({
      available: true,
      running: true,
    });
    expect(mocks.runFile).toHaveBeenLastCalledWith(
      '/Applications/Handy.app/Contents/MacOS/Handy',
      [flag],
      { timeout: 2000, maxBuffer: 65536, windowsHide: true }
    );
  });

  it('finds Linux executables on PATH but ignores relative entries', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const directory = '/custom/bin with spaces;safe';
    vi.stubEnv('PATH', `.${delimiter}${directory}`);
    mocks.stat.mockImplementation(async (path: string) => {
      if (path === join(directory, 'handy')) return { isFile: () => true };
      throw new Error('missing');
    });
    await new HandyIntegration().request('start');
    expect(mocks.stat).not.toHaveBeenCalledWith('handy');
    expect(mocks.runFile).toHaveBeenLastCalledWith(
      join(directory, 'handy'),
      ['--toggle-transcription'],
      expect.any(Object)
    );
  });

  it('detects Windows processes without PowerShell or shell commands', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('LOCALAPPDATA', '/user/local');
    mocks.runFile.mockResolvedValue({
      stdout: '"handy.exe","123","Console","1","12 K"\r\n',
      stderr: '',
    });
    expect(await new HandyIntegration().request('status')).toMatchObject({
      available: true,
      running: true,
    });
    expect(mocks.runFile).toHaveBeenCalledExactlyOnceWith(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq handy.exe', '/FO', 'CSV', '/NH'],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('reports inspection and command failures without retrying a toggle', async () => {
    mocks.runFile.mockRejectedValue(new Error('inspection denied'));
    expect((await new HandyIntegration().request('start')).error).toContain('inspection denied');
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
    mocks.runFile
      .mockReset()
      .mockResolvedValueOnce({ stdout: '123', stderr: '' })
      .mockRejectedValueOnce(new Error('timed out'));
    expect((await new HandyIntegration().request('start')).error).toContain('timed out');
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it('does not activate after a late filesystem discovery', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      mocks.stat.mockImplementationOnce(async () => {
        controller.abort(new Error('discovery expired'));
        return { isFile: () => true };
      });
      expect((await new HandyIntegration().request('start')).error).toContain('discovery expired');
      expect(mocks.runFile).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('shares concurrent status discovery but rejects overlapping mutations', async () => {
    const integration = new HandyIntegration();
    const first = integration.request('start');
    const second = integration.request('start');
    const status = integration.request('status');
    expect(await first).toMatchObject({ available: true, running: true, state: 'recording' });
    expect((await second).error).toContain('pending');
    expect(await status).toMatchObject({ available: true, running: true, state: 'recording' });
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it('does not restart recording when a stale finish click follows cancellation in Handy', async () => {
    const integration = new HandyIntegration();
    await integration.request('start');
    mocks.recording.state = 'idle';
    mocks.runFile.mockClear();
    expect(await integration.request('stop')).toMatchObject({ state: 'idle' });
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
    expect(mocks.runFile.mock.calls[0]?.[0]).toBe('/usr/bin/pgrep');
    expect((await integration.request('start')).state).toBe('recording');
  });

  it('adopts recording already started in Handy without sending another toggle', async () => {
    mocks.recording.state = 'recording';
    expect((await new HandyIntegration().request('start')).state).toBe('recording');
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale processing observation block an explicit new start', async () => {
    mocks.recording.state = 'processing';
    expect(await new HandyIntegration().request('start')).toMatchObject({ state: 'recording' });
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it('keeps start and finish working without lifecycle logs or acknowledgements', async () => {
    mocks.runFile.mockResolvedValue({ stdout: '123\n', stderr: '' });
    mocks.read.mockImplementation(async () => {
      mocks.recording.state = 'unknown';
      return 'unknown';
    });
    const integration = new HandyIntegration();
    expect(await integration.request('start')).toMatchObject({ state: 'recording', running: true });
    expect(await integration.request('stop')).toMatchObject({ state: 'idle', running: true });
    expect(
      mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--toggle-transcription')
    ).toHaveLength(2);
  });

  it('watches only an explicitly activated dictation and keeps fallback state on watcher failure', async () => {
    const integration = new HandyIntegration();
    const notify = vi.fn();
    await integration.request('status', notify);
    expect(mocks.watch).not.toHaveBeenCalled();
    await integration.request('start', notify);
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    const update = mocks.watch.mock.calls[0]?.[0];
    if (!update) throw new Error('Missing state observer');
    mocks.recording.state = 'unknown';
    update('unknown');
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'recording' }));
    mocks.recording.state = 'idle';
    update('idle');
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'idle' }));
    mocks.recording.state = 'unknown';
    expect((await integration.request('status')).state).toBe('idle');
    integration.dispose();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight focus probe instead of dropping the start command', async () => {
    let release: ((result: { stdout: string; stderr: string }) => void) | undefined;
    mocks.runFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const integration = new HandyIntegration();
    const probe = integration.request('status');
    const start = integration.request('start');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release?.({ stdout: '123\n', stderr: '' });
    await probe;
    expect(await start).toMatchObject({ state: 'recording' });
    expect(
      mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--toggle-transcription')
    ).toHaveLength(1);
  });

  it.each([
    ['darwin', () => join(homedir(), 'Library/Logs/com.pais.handy/handy.log')],
    ['win32', () => join('/local-app-data', 'com.pais.handy/logs/handy.log')],
    ['linux', () => join('/xdg-data', 'com.pais.handy/logs/handy.log')],
  ] as const)('uses the standard %s lifecycle log path', (platform, expected) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.stubEnv('LOCALAPPDATA', '/local-app-data');
    vi.stubEnv('XDG_DATA_HOME', '/xdg-data');
    const integration = new HandyIntegration();
    expect(mocks.logPath.get?.()).toBe(expected());
    integration.dispose();
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'derives %s portable logs from the automatically discovered executable',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const executable = join('/portable', platform === 'win32' ? 'handy.exe' : 'handy');
      vi.stubEnv('PATH', '/portable');
      mocks.stat.mockImplementation(async (path: string) => {
        if (path === executable || path === join('/portable', 'portable'))
          return { isFile: () => true, isDirectory: () => false };
        if (path === join('/portable', 'Data'))
          return { isFile: () => false, isDirectory: () => true };
        throw new Error('missing');
      });
      if (platform === 'win32')
        mocks.runFile.mockResolvedValue({
          stdout: '"handy.exe","123","Console","1","12 K"\r\n',
          stderr: '',
        });
      const integration = new HandyIntegration();
      expect(await integration.request('start')).toMatchObject({
        state: 'recording',
        running: true,
      });
      expect(mocks.logPath.get?.()).toBe(join('/portable', 'Data/logs/handy.log'));
      integration.dispose();
    }
  );

  it('uses standard logs for a non-portable installation even when portable checks fail', async () => {
    const executable = '/Applications/Handy.app/Contents/MacOS/Handy';
    mocks.stat.mockImplementation(async (path: string) => {
      if (path === executable) return { isFile: () => true, isDirectory: () => false };
      throw new Error('portable directory unavailable');
    });
    const integration = new HandyIntegration();
    expect(await integration.request('start')).toMatchObject({ state: 'recording' });
    expect(mocks.logPath.get?.()).toBe(join(homedir(), 'Library/Logs/com.pais.handy/handy.log'));
    integration.dispose();
  });

  it('keeps portable dictation working when its log is missing', async () => {
    const executable = join('/portable', 'handy');
    vi.stubEnv('PATH', '/portable');
    mocks.stat.mockImplementation(async (path: string) => ({
      isFile: () => path === executable || path === join('/portable', 'portable'),
      isDirectory: () => path === join('/portable', 'Data'),
    }));
    mocks.read.mockImplementation(async () => {
      mocks.recording.state = 'unknown';
      return 'unknown';
    });
    const integration = new HandyIntegration();
    expect(await integration.request('start')).toMatchObject({ state: 'recording' });
    expect(mocks.logPath.get?.()).toBe(join('/portable', 'Data/logs/handy.log'));
    expect(await integration.request('stop')).toMatchObject({ state: 'idle' });
    integration.dispose();
  });

  it('does not expose dictation configuration settings', () => {
    expect(
      Object.keys(packageJson.contributes.configuration.properties).filter((key) =>
        key.startsWith('varro.dictation.')
      )
    ).toEqual([]);
  });
});
