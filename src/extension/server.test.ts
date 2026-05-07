import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsModule from 'fs';
import type * as FsPromisesModule from 'fs/promises';
import type { ServerStatus } from '../shared/protocol';

type ShowMessageMock = (message: string, ...items: string[]) => Promise<string | undefined>;

const { loggerMock, mkdirMock, spawnMock, vscodeMock, writeFileMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mkdirMock: vi.fn(() => Promise.resolve(undefined)),
  spawnMock: vi.fn(),
  vscodeMock: {
    window: {
      activeTextEditor: undefined,
      showInformationMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
      createTerminal: vi.fn(() => ({
        show: vi.fn(),
        sendText: vi.fn(),
      })),
    },
    workspace: {
      getWorkspaceFolder: vi.fn(),
      workspaceFolders: undefined,
    },
  },
  writeFileMock: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromisesModule>('fs/promises');
  return {
    ...actual,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
  };
});

import { OpenCodeServer } from './server';
import { existsSync } from 'fs';

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener('abort', abort, { once: true });
  });
}

function createPendingEventResponse(signal: AbortSignal) {
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            return waitForAbort(signal);
          },
        };
      },
    },
  } as unknown as Response;
}

function createChunkedEventResponse(signal: AbortSignal, chunks: Uint8Array[]) {
  let index = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            const chunk = chunks[index++];
            return chunk ? Promise.resolve({ value: chunk, done: false }) : waitForAbort(signal);
          },
        };
      },
    },
  } as unknown as Response;
}

function createImmediateEventResponse(payload: string) {
  const bytes = new TextEncoder().encode(payload);
  let delivered = false;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            if (!delivered) {
              delivered = true;
              return Promise.resolve({ value: bytes, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  } as unknown as Response;
}

function setRunning(server: OpenCodeServer, options?: { keepMaintenance?: boolean }) {
  (
    server as unknown as {
      setRunningStatus: (url?: string, eventStream?: 'healthy' | 'degraded') => void;
    }
  ).setRunningStatus(server.url, 'healthy');
  if (!options?.keepMaintenance) {
    (server as unknown as { stopMaintenanceLoop: () => void }).stopMaintenanceLoop();
  }
}

function startEventStream(server: OpenCodeServer) {
  return (server as unknown as { startEventStream: () => Promise<void> }).startEventStream();
}

function stopEventStream(server: OpenCodeServer) {
  (server as unknown as { stopEventStream: () => void }).stopEventStream();
}

function setRestartTimer(server: OpenCodeServer, timer: ReturnType<typeof setTimeout> | null) {
  (server as unknown as { restartTimer: ReturnType<typeof setTimeout> | null }).restartTimer =
    timer;
}

function runMaintenanceTick(server: OpenCodeServer) {
  return (server as unknown as { runMaintenanceTick: () => Promise<void> }).runMaintenanceTick();
}

function maybeSuggestCliUpdate(server: OpenCodeServer, installedCliVersion: string | null) {
  return (
    server as unknown as {
      maybeSuggestCliUpdate: (version: string | null) => Promise<void>;
    }
  ).maybeSuggestCliUpdate(installedCliVersion);
}

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  spawnMock.mockReset();
  mkdirMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockReset();
  writeFileMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpenCodeServer event stream', () => {
  it('does not abort a healthy stream after the connect timeout passes', async () => {
    const server = new OpenCodeServer(4096, false);
    setRunning(server);

    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return createPendingEventResponse(requestSignal);
    });

    const stream = startEventStream(server);
    await flushMicrotasks();

    expect(requestSignal).toBeDefined();

    await vi.advanceTimersByTimeAsync(10_001);
    expect(requestSignal?.aborted).toBe(false);

    stopEventStream(server);
    await stream;
  });

  it('reconnects when the event stream goes idle', async () => {
    const server = new OpenCodeServer(4096, false);
    const statuses: ServerStatus[] = [];
    server.on('status', (status) => statuses.push(status));
    setRunning(server);

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return createPendingEventResponse(signal);
    });

    const firstStream = startEventStream(server);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(45_000);
    await firstStream;

    expect(
      statuses.some(
        (status) =>
          status.state === 'running' &&
          status.url === server.url &&
          status.eventStream === 'degraded'
      )
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await server.dispose();
    await flushMicrotasks();
  });

  it('does not reconnect an event stream after dispose starts', async () => {
    const server = new OpenCodeServer(4096, false);
    setRunning(server);

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return createPendingEventResponse(signal);
    });

    const firstStream = startEventStream(server);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(45_000);
    await firstStream;

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const disposePromise = server.dispose();
    await vi.advanceTimersByTimeAsync(1_500);
    await flushMicrotasks();
    await disposePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears pending restart timers during dispose', async () => {
    const server = new OpenCodeServer(4096, false);
    const restart = vi.fn();
    setRestartTimer(server, setTimeout(restart, 1_000));

    await server.dispose();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(restart).not.toHaveBeenCalled();
  });

  it('reconnects when the event stream buffer exceeds the safety limit', async () => {
    const server = new OpenCodeServer(4096, false);
    const statuses: ServerStatus[] = [];
    server.on('status', (status) => statuses.push(status));
    setRunning(server);

    const oversizedChunk = new TextEncoder().encode('x'.repeat(1_000_001));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return createChunkedEventResponse(signal, [oversizedChunk]);
    });

    await startEventStream(server);

    expect(
      statuses.some(
        (status) =>
          status.state === 'running' &&
          status.url === server.url &&
          status.eventStream === 'degraded'
      )
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1_500);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await server.dispose();
  });

  it('drops oversized SSE payloads before parsing them', async () => {
    const server = new OpenCodeServer(4096, false);
    const events: unknown[] = [];
    server.on('event', (event) => events.push(event));
    setRunning(server);

    const oversizedPayload = `data: {"type":"${'x'.repeat(250_001)}"}\n\n`;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(createImmediateEventResponse(oversizedPayload));

    await startEventStream(server);

    expect(events).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Ignoring oversized event stream payload (250012 chars > 250000)'
    );

    await server.dispose();
  });

  it('ignores stale stream events after a newer stream replaces them', async () => {
    const server = new OpenCodeServer(4096, false);
    const events: unknown[] = [];
    server.on('event', (event) => events.push(event));
    setRunning(server);

    let releaseFirstRead: (() => void) | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      if (!releaseFirstRead) {
        let chunkDelivered = false;
        return {
          ok: true,
          body: {
            getReader() {
              return {
                async read() {
                  if (!chunkDelivered) {
                    chunkDelivered = true;
                    await new Promise<void>((resolve) => {
                      releaseFirstRead = resolve;
                    });
                    return {
                      value: new TextEncoder().encode('data: {"type":"session.created"}\n\n'),
                      done: false,
                    };
                  }
                  return waitForAbort(signal);
                },
              };
            },
          },
        } as unknown as Response;
      }

      return createPendingEventResponse(signal);
    });

    const firstStream = startEventStream(server);
    await flushMicrotasks();
    const secondStream = startEventStream(server);
    await flushMicrotasks();

    const release = releaseFirstRead as unknown;
    if (typeof release === 'function') {
      release();
    }
    await firstStream;

    expect(events).toEqual([]);

    stopEventStream(server);
    await secondStream;
  });

  it('keeps the managed process alive during disconnect', async () => {
    const server = new OpenCodeServer(4096, false);
    const kill = vi.fn();
    (
      server as unknown as {
        process: { kill: typeof kill; exitCode: null; signalCode: null };
      }
    ).process = {
      kill,
      exitCode: null,
      signalCode: null,
    };

    await server.disconnect();

    expect(kill).not.toHaveBeenCalled();
  });

  it('detaches managed process listeners during disconnect', async () => {
    const server = new OpenCodeServer(4096, false);
    const stdoutOff = vi.fn();
    const stderrOff = vi.fn();
    const procOff = vi.fn();
    const stdoutHandler = vi.fn();
    const stderrHandler = vi.fn();
    const exitHandler = vi.fn();
    const errorHandler = vi.fn();
    (
      server as unknown as {
        process: {
          stdout: { off: typeof stdoutOff };
          stderr: { off: typeof stderrOff };
          off: typeof procOff;
          exitCode: null;
          signalCode: null;
        };
        processStdoutHandler: (data: Buffer) => void;
        processStderrHandler: (data: Buffer) => void;
        processExitHandler: (code: number | null, signal: NodeJS.Signals | null) => void;
        processErrorHandler: (err: Error) => void;
      }
    ).process = {
      stdout: { off: stdoutOff },
      stderr: { off: stderrOff },
      off: procOff,
      exitCode: null,
      signalCode: null,
    };
    (
      server as unknown as {
        processStdoutHandler: (data: Buffer) => void;
        processStderrHandler: (data: Buffer) => void;
        processExitHandler: (code: number | null, signal: NodeJS.Signals | null) => void;
        processErrorHandler: (err: Error) => void;
      }
    ).processStdoutHandler = stdoutHandler;
    (
      server as unknown as {
        processStdoutHandler: (data: Buffer) => void;
        processStderrHandler: (data: Buffer) => void;
        processExitHandler: (code: number | null, signal: NodeJS.Signals | null) => void;
        processErrorHandler: (err: Error) => void;
      }
    ).processStderrHandler = stderrHandler;
    (
      server as unknown as {
        processStdoutHandler: (data: Buffer) => void;
        processStderrHandler: (data: Buffer) => void;
        processExitHandler: (code: number | null, signal: NodeJS.Signals | null) => void;
        processErrorHandler: (err: Error) => void;
      }
    ).processExitHandler = exitHandler;
    (
      server as unknown as {
        processStdoutHandler: (data: Buffer) => void;
        processStderrHandler: (data: Buffer) => void;
        processExitHandler: (code: number | null, signal: NodeJS.Signals | null) => void;
        processErrorHandler: (err: Error) => void;
      }
    ).processErrorHandler = errorHandler;

    await server.disconnect();

    expect(stdoutOff).toHaveBeenCalledWith('data', stdoutHandler);
    expect(stderrOff).toHaveBeenCalledWith('data', stderrHandler);
    expect(procOff).toHaveBeenCalledWith('exit', exitHandler);
    expect(procOff).toHaveBeenCalledWith('error', errorHandler);
  });
});

describe('OpenCodeServer compaction config injection', () => {
  it('injects OPENCODE_CONFIG for managed server startup', async () => {
    const server = new OpenCodeServer(4096, true, 'opencode', false, {
      auto: false,
      reserved: 1234,
    });
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const processOn = vi.fn();
    spawnMock.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      on: processOn,
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    } as never);

    const api = server as unknown as {
      checkHealth: ReturnType<typeof vi.fn>;
      pollHealth: (
        startAttemptId: number,
        disposeGeneration: number,
        resolve: (url: string) => void,
        reject: (err: Error) => void,
        attempt?: number
      ) => void;
    };
    api.checkHealth = vi.fn().mockResolvedValue(false);
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => {
      resolve(server.url);
    };

    await server.start();

    const configText = (
      server as unknown as {
        serializeInjectedConfig: () => string;
      }
    ).serializeInjectedConfig();
    expect(String(configText)).toContain('"auto": false');
    expect(String(configText)).toContain('"reserved": 1234');

    const spawnCall = spawnMock.mock.calls[0];
    expect(spawnCall).toBeTruthy();
    const options = spawnCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.OPENCODE_CONFIG).toContain('varro-opencode');
  });

  it('reapplies changed settings by disposing OpenCode instances', async () => {
    const server = new OpenCodeServer(4096, false);
    const request = vi.fn(async () => true);
    const api = server as unknown as {
      _status: ServerStatus;
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      request: typeof request;
    };

    api._status = { state: 'running', url: server.url };
    api.process = {};
    api.managedProcess = true;
    api.request = request;

    await server.updateCompactionSettings({ auto: false, reserved: 4321 });

    expect(request).toHaveBeenCalledWith('POST', '/global/dispose');
    const configText = (
      server as unknown as {
        serializeInjectedConfig: () => string;
      }
    ).serializeInjectedConfig();
    expect(String(configText)).toContain('"auto": false');
    expect(String(configText)).toContain('"reserved": 4321');
  });

  it('restarts the managed server when dispose fails during reapply', async () => {
    const server = new OpenCodeServer(4096, false);
    const restart = vi.fn(async () => undefined);
    const api = server as unknown as {
      _status: ServerStatus;
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      request: (method: string, path: string, body?: unknown) => Promise<unknown>;
      restartManagedServerForCompactionSettings: () => Promise<void>;
    };

    api._status = { state: 'running', url: server.url };
    api.process = {};
    api.managedProcess = true;
    api.request = vi.fn(async () => {
      throw new Error('dispose failed');
    });
    api.restartManagedServerForCompactionSettings = restart;

    await server.updateCompactionSettings({ auto: false });

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('warns instead of reapplying when the running server is unmanaged', async () => {
    const server = new OpenCodeServer(4096, false);
    const request = vi.fn(async () => true);
    const api = server as unknown as {
      _status: ServerStatus;
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      request: typeof request;
    };

    api._status = { state: 'running', url: server.url };
    api.process = null;
    api.managedProcess = false;
    api.request = request;

    await server.updateCompactionSettings({ auto: false });

    expect(request).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Varro chat auto-compaction settings can only be reapplied automatically for a Varro-managed OpenCode server'
    );
  });
});

describe('OpenCodeServer maintenance', () => {
  it('restarts a managed idle server when the installed CLI is newer', async () => {
    const server = new OpenCodeServer(4096, false);
    const restartManagedServer = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<void>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartManagedServer: (serverVersion: string, installedCliVersion: string) => Promise<void>;
    };

    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.restartManagedServer = restartManagedServer;

    await runMaintenanceTick(server);

    expect(restartManagedServer).toHaveBeenCalledWith('1.14.20', '1.14.22');
  });

  it('restarts a managed process without emitting a stopped status', async () => {
    const server = new OpenCodeServer(4096, false);
    const statuses: ServerStatus[] = [];
    const api = server as unknown as {
      process: { kill: ReturnType<typeof vi.fn>; exitCode: number; signalCode: null } | null;
      managedProcess: boolean;
      start: () => Promise<string>;
      restartManagedServer: (serverVersion: string, installedCliVersion: string) => Promise<void>;
    };

    setRunning(server);
    server.on('status', (status) => statuses.push(status));
    api.process = { kill: vi.fn(), exitCode: 0, signalCode: null };
    api.managedProcess = true;
    api.start = vi.fn().mockResolvedValue(server.url);

    await api.restartManagedServer('1.14.20', '1.14.22');

    expect(api.start).toHaveBeenCalledTimes(1);
    expect(statuses.some((status) => status.state === 'stopped')).toBe(false);
  });

  it('does not restart when there are active sessions', async () => {
    const server = new OpenCodeServer(4096, false);
    const restartManagedServer = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<void>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartManagedServer: (serverVersion: string, installedCliVersion: string) => Promise<void>;
    };

    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(true);
    api.restartManagedServer = restartManagedServer;

    await runMaintenanceTick(server);

    expect(restartManagedServer).not.toHaveBeenCalled();
  });

  it('does not restart an unmanaged server even when the CLI is newer', async () => {
    const server = new OpenCodeServer(4096, false);
    const restartManagedServer = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<void>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartManagedServer: (serverVersion: string, installedCliVersion: string) => Promise<void>;
    };

    setRunning(server);
    api.process = null;
    api.managedProcess = false;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.restartManagedServer = restartManagedServer;

    await runMaintenanceTick(server);

    expect(restartManagedServer).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenCode CLI 1.14.22 is newer than running server 1.14.20, but the server is not managed by Varro; skipping automatic restart'
    );
  });

  it('suggests a newer CLI version only on the slower update cadence', async () => {
    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };

    api.readLatestCliVersion = readLatestCliVersion;

    await maybeSuggestCliUpdate(server, '1.14.20');
    await maybeSuggestCliUpdate(server, '1.14.20');

    expect(readLatestCliVersion).toHaveBeenCalledTimes(1);
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'OpenCode CLI 1.14.22 is available (installed: 1.14.20). Update with: opencode upgrade',
      'Run Upgrade'
    );
  });

  it('runs the upgrade command in an integrated terminal when the notification action is selected', async () => {
    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const terminal = {
      show: vi.fn(),
      sendText: vi.fn(),
    };
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');
    vscodeMock.window.createTerminal.mockReturnValueOnce(terminal);

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
      name: 'OpenCode Upgrade',
      cwd: undefined,
    });
    expect(terminal.show).toHaveBeenCalledWith(false);
    expect(terminal.sendText).toHaveBeenCalledWith('opencode upgrade', true);
  });

  it('uses opencode upgrade on Windows when suggesting and running a CLI upgrade', async () => {
    stubPlatform('win32');

    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const terminal = {
      show: vi.fn(),
      sendText: vi.fn(),
    };
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');
    vscodeMock.window.createTerminal.mockReturnValueOnce(terminal);

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'OpenCode CLI 1.14.22 is available (installed: 1.14.20). Update with: opencode upgrade',
      'Run Upgrade'
    );
    expect(terminal.sendText).toHaveBeenCalledWith('opencode upgrade', true);
  });

  it('stops the managed process before running a Windows CLI upgrade', async () => {
    stubPlatform('win32');

    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const terminal = {
      show: vi.fn(),
      sendText: vi.fn(),
    };
    const kill = vi.fn();
    const statuses: ServerStatus[] = [];
    server.on('status', (status) => statuses.push(status));

    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
      process: {
        kill: typeof kill;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        once: (event: string, listener: () => void) => void;
        off: (event: string, listener: () => void) => void;
      } | null;
      managedProcess: boolean;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    api.process = {
      kill,
      exitCode: 0,
      signalCode: null,
      once: vi.fn(),
      off: vi.fn(),
    };
    api.managedProcess = true;
    setRunning(server);
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');
    vscodeMock.window.createTerminal.mockReturnValueOnce(terminal);

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(kill).not.toHaveBeenCalled();
    expect(statuses).toContainEqual({ state: 'stopped' });
    expect(terminal.sendText).toHaveBeenCalledWith('opencode upgrade', true);
  });
});

describe('OpenCodeServer startup health polling', () => {
  it('keeps the original pollHealth callbacks across recursive retries', async () => {
    const server = new OpenCodeServer(4096, false);
    const resolved = vi.fn();
    const rejected = vi.fn();
    const api = server as unknown as {
      checkHealth: () => Promise<boolean>;
      pollHealth: (
        startAttemptId: number,
        disposeGeneration: number,
        resolve: (url: string) => void,
        reject: (err: Error) => void,
        attempt?: number
      ) => void;
      startAttemptId: number;
      disposeGeneration: number;
    };

    api.checkHealth = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    api.startAttemptId = 1;
    api.disposeGeneration = 0;

    api.pollHealth(1, 0, resolved, rejected);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    expect(resolved).toHaveBeenCalledWith(server.url);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
  });
});

describe('OpenCodeServer command resolution', () => {
  it('caches the resolved CLI path across repeated lookups', () => {
    const server = new OpenCodeServer(4096, false);
    const api = server as unknown as {
      getResolvedCommandCacheKey: () => string;
      resolveCommand: () => string;
      resolvedCommandCache: { key: string; value: string } | null;
    };
    api.getResolvedCommandCacheKey = vi.fn(() => 'stable-key');
    api.resolvedCommandCache = { key: 'stable-key', value: '/tmp/bin/opencode' };

    expect(api.resolveCommand()).toBe('/tmp/bin/opencode');
    expect(api.getResolvedCommandCacheKey).toHaveBeenCalledTimes(1);
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
  });
});
