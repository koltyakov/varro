import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type * as FsModule from 'fs';
import type * as FsPromisesModule from 'fs/promises';
import { dirname } from 'path';
import { MINIMUM_SUPPORTED_OPENCODE_VERSION } from '../shared/opencode-compatibility';
import type { ServerStatus } from '../shared/protocol';

type ShowMessageMock = (message: string, ...items: string[]) => Promise<string | undefined>;

const { getConfigurationMock, loggerMock, mkdirMock, spawnMock, vscodeMock, writeFileMock } =
  vi.hoisted(() => ({
    getConfigurationMock: vi.fn(),
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
        getConfiguration: vi.fn(),
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
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';

const MANIFEST_OPENCODE_VERSION = readMaximumTestedOpenCodeVersion();

function nextPatchVersion(version: string) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function createMockChildProcess(): MockChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });
}

function configureManagedStartup(server: OpenCodeServer, resolveHealth = true) {
  const children: MockChildProcess[] = [];
  const api = server as unknown as {
    syncInjectedConfigFile: () => Promise<void>;
    readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
    readInstalledCliVersion: () => Promise<string | null>;
    startEventStream: () => Promise<void>;
    requestMaintenanceCheck: () => void;
    pollHealth: (
      startAttemptId: number,
      disposeGeneration: number,
      resolve: (url: string) => void,
      reject: (err: Error) => void,
      attempt?: number
    ) => void;
  };
  api.syncInjectedConfigFile = vi.fn().mockResolvedValue(undefined);
  api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
  api.readInstalledCliVersion = vi.fn().mockResolvedValue(MINIMUM_SUPPORTED_OPENCODE_VERSION);
  api.startEventStream = vi.fn().mockResolvedValue(undefined);
  api.requestMaintenanceCheck = vi.fn();
  if (resolveHealth) {
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => {
      setRunning(server);
      resolve(server.url);
    };
  }
  spawnMock.mockImplementation(() => {
    const child = createMockChildProcess();
    children.push(child);
    return child as never;
  });
  return { api, children };
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
      maybeSuggestCliUpdate: (version: string | null) => Promise<string | null>;
    }
  ).maybeSuggestCliUpdate(installedCliVersion);
}

const originalPlatform = process.platform;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
const originalOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  getConfigurationMock.mockImplementation(() => ({
    get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? false : fallback),
  }));
  vscodeMock.workspace.getConfiguration = getConfigurationMock;
  spawnMock.mockReset();
  mkdirMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockReset();
  writeFileMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  await flushMicrotasks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  stubPlatform(originalPlatform);
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  if (originalOpenCodeConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = originalOpenCodeConfigContent;
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
  it('injects a temporary OPENCODE_CONFIG layer for managed server startup', async () => {
    const inheritedContent =
      '{\n  // inherited content\n  "provider": { "example": { "name": "Example" } },\n}\n';
    process.env.OPENCODE_CONFIG_CONTENT = inheritedContent;
    const server = new OpenCodeServer(4096, true, 'opencode', false, {
      auto: false,
      reserved: 1234,
    });
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const processOn = vi.fn();
    spawnMock.mockReturnValue({
      pid: 43212,
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      on: processOn,
      once: processOn,
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    } as never);

    const api = server as unknown as {
      readHealthInfo: ReturnType<typeof vi.fn>;
      readInstalledCliVersion: ReturnType<typeof vi.fn>;
      pollHealth: (
        startAttemptId: number,
        disposeGeneration: number,
        resolve: (url: string) => void,
        reject: (err: Error) => void,
        attempt?: number
      ) => void;
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.readInstalledCliVersion = vi.fn().mockResolvedValue(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => {
      resolve(server.url);
    };

    await server.start();

    const configText = await (
      server as unknown as {
        serializeInjectedConfig: () => Promise<string>;
      }
    ).serializeInjectedConfig();
    expect(String(configText)).toContain('"auto": false');
    expect(String(configText)).toContain('"reserved": 1234');
    expect(String(configText)).not.toContain('"example"');

    const spawnCall = spawnMock.mock.calls.find((call) =>
      (call[1] as string[] | undefined)?.includes('serve')
    );
    expect(spawnCall).toBeTruthy();
    const options = spawnCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const configPath = options?.env?.OPENCODE_CONFIG;
    expect(configPath).toContain('varro-opencode-config-');
    expect(configPath).toMatch(/opencode\.json$/);
    expect(options?.env?.OPENCODE_CONFIG_CONTENT).toBe(inheritedContent);
    const actualFs = await vi.importActual<typeof FsPromisesModule>('fs/promises');
    expect(await actualFs.readFile(configPath!, 'utf-8')).toBe(configText);
    await actualFs.rm(dirname(configPath!), { recursive: true, force: true });
  });

  it('preserves a caller-provided OPENCODE_CONFIG path', async () => {
    const previous = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = '/caller/opencode.jsonc';
    try {
      const server = new OpenCodeServer(4096, true, 'opencode', false, {
        auto: true,
        reserved: 2345,
      });
      const processManager = (
        server as unknown as {
          processManager: {
            syncInjectedConfigFile(): Promise<void>;
            buildServerEnv(): NodeJS.ProcessEnv;
          };
        }
      ).processManager;
      await processManager.syncInjectedConfigFile();

      expect(processManager.buildServerEnv().OPENCODE_CONFIG).toBe('/caller/opencode.jsonc');
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Preserving caller-provided OPENCODE_CONFIG; Varro compaction settings are not injected for this managed server'
      );
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previous;
    }
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
    const configText = await (
      server as unknown as {
        serializeInjectedConfig: () => Promise<string>;
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
  it('reports active agents and ownership in server diagnostics', async () => {
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      request: (method: string, path: string) => Promise<unknown>;
    };
    setRunning(server);
    api.managedProcess = false;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.18.2');
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.18' });
    api.request = vi.fn().mockResolvedValue({
      'session-1': { type: 'busy' },
      'session-2': { type: 'retry' },
      'session-3': { type: 'idle' },
    });

    const info = await server.readServerInfo();

    expect(info.managedProcess).toBe(false);
    expect(info.activeAgentCount).toBe(2);
    expect(info.activeAgentError).toBeNull();
  });

  it('restarts a managed idle server when the installed CLI is newer', async () => {
    const server = new OpenCodeServer(4096, false);
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartServerForCliUpdate: (
        serverVersion: string,
        installedCliVersion: string
      ) => Promise<void>;
    };

    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(null);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.restartServerForCliUpdate = restartServerForCliUpdate;

    await runMaintenanceTick(server);

    expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.14.20', '1.14.22');
  });

  it('checks for a deferred CLI restart when a session becomes idle', () => {
    const server = new OpenCodeServer(4096, false);
    const requestMaintenanceCheck = vi.fn();
    const event = {
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    };
    const listener = vi.fn();
    const api = server as unknown as {
      handleServerEvent: (value: unknown) => void;
      requestMaintenanceCheck: () => void;
    };
    api.requestMaintenanceCheck = requestMaintenanceCheck;
    server.on('event', listener);

    api.handleServerEvent(event);

    expect(listener).toHaveBeenCalledWith(event);
    expect(requestMaintenanceCheck).toHaveBeenCalledOnce();
  });

  it('restarts a managed process without emitting a stopped status', async () => {
    const server = new OpenCodeServer(4096, false);
    const statuses: ServerStatus[] = [];
    const api = server as unknown as {
      process: { kill: ReturnType<typeof vi.fn>; exitCode: number; signalCode: null } | null;
      managedProcess: boolean;
      stopServerForRestart: () => Promise<void>;
      start: () => Promise<string>;
      restartServerForCliUpdate: (
        serverVersion: string,
        installedCliVersion: string
      ) => Promise<void>;
    };

    setRunning(server);
    server.on('status', (status) => statuses.push(status));
    api.process = { kill: vi.fn(), exitCode: 0, signalCode: null };
    api.managedProcess = true;
    api.stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    api.start = vi.fn().mockResolvedValue(server.url);

    await api.restartServerForCliUpdate('1.14.20', '1.14.22');

    expect(api.stopServerForRestart).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(statuses.some((status) => status.state === 'stopped')).toBe(false);
  });

  it('does not restart when there are active sessions', async () => {
    const server = new OpenCodeServer(4096, false);
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartServerForCliUpdate: (
        serverVersion: string,
        installedCliVersion: string
      ) => Promise<void>;
    };

    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(null);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(true);
    api.restartServerForCliUpdate = restartServerForCliUpdate;

    await runMaintenanceTick(server);

    expect(restartServerForCliUpdate).not.toHaveBeenCalled();
  });

  it('does not restart an unmanaged server when auto-start is disabled', async () => {
    const server = new OpenCodeServer(4096, false);
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartServerForCliUpdate: (
        serverVersion: string,
        installedCliVersion: string
      ) => Promise<void>;
    };

    setRunning(server);
    api.process = null;
    api.managedProcess = false;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(null);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.restartServerForCliUpdate = restartServerForCliUpdate;

    await runMaintenanceTick(server);

    expect(restartServerForCliUpdate).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenCode CLI 1.14.22 is newer than running server 1.14.20, but Varro server auto-start is disabled; skipping automatic restart'
    );
  });

  it('keeps using an unmanaged running server when the installed CLI is newer', async () => {
    const server = new OpenCodeServer(4096, true);
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      maybeSuggestCliUpdate: (version: string | null) => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      processManager: { recoverLegacyManagedServerOwnership: () => Promise<boolean> };
      restartServerForCliUpdate: (
        serverVersion: string,
        installedCliVersion: string
      ) => Promise<void>;
    };

    setRunning(server);
    api.process = null;
    api.managedProcess = false;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.17.19');
    api.maybeSuggestCliUpdate = vi.fn().mockResolvedValue(null);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.18' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.processManager.recoverLegacyManagedServerOwnership = vi.fn().mockResolvedValue(false);
    api.restartServerForCliUpdate = restartServerForCliUpdate;

    await runMaintenanceTick(server);

    expect(restartServerForCliUpdate).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenCode CLI 1.17.19 is newer than running server 1.17.18, but Varro does not own the server; continuing with the existing server'
    );
  });

  it('restarts with the new CLI version after a background update', async () => {
    stubPlatform('linux');

    const server = new OpenCodeServer(4096, true);
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readInstalledCliVersion: () => Promise<string | null>;
      readLatestCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartServerForCliUpdate: (
        serverVersion: string,
        installedCliVersion: string
      ) => Promise<void>;
    };

    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.14.20');
    api.readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.restartServerForCliUpdate = restartServerForCliUpdate;
    spawnMock.mockImplementation((_command, _args) => {
      let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
      const proc = {
        stdout: { on: vi.fn(), off: vi.fn() },
        stderr: { on: vi.fn(), off: vi.fn() },
        once: vi.fn((event: string, listener: typeof exitHandler) => {
          if (event === 'exit') {
            exitHandler = listener;
          }
        }),
        removeAllListeners: vi.fn(),
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      };
      queueMicrotask(() => {
        exitHandler?.(0, null);
      });
      return proc as never;
    });

    await runMaintenanceTick(server);
    await flushMicrotasks();

    expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.14.20', '1.14.22');
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

  it('uses the running server upgrade endpoint when the notification action is selected', async () => {
    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const request = vi.fn().mockResolvedValue({ success: true, version: '1.14.22' });
    const requestMaintenanceCheck = vi.fn();
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
      request: typeof request;
      requestMaintenanceCheck: () => void;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    api.request = request;
    api.requestMaintenanceCheck = requestMaintenanceCheck;
    setRunning(server);
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(request).toHaveBeenCalledWith('POST', '/global/upgrade', { target: '1.14.22' });
    expect(requestMaintenanceCheck).toHaveBeenCalledOnce();
    expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
  });

  it('can auto-update the CLI in background when enabled', async () => {
    // Background auto-update is disabled on win32, so pin a POSIX platform.
    stubPlatform('linux');

    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };

    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = readLatestCliVersion;
    spawnMock.mockImplementation((_command, _args) => {
      let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
      const proc = {
        stdout: { on: vi.fn(), off: vi.fn() },
        stderr: { on: vi.fn(), off: vi.fn() },
        once: vi.fn((event: string, listener: typeof exitHandler) => {
          if (event === 'exit') {
            exitHandler = listener;
          }
        }),
        removeAllListeners: vi.fn(),
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      };
      queueMicrotask(() => {
        exitHandler?.(0, null);
      });
      return proc as never;
    });

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['upgrade', '1.14.22']),
      expect.any(Object)
    );
  });

  it('does not suggest an update beyond the manifest version by default', async () => {
    stubPlatform('linux');
    const server = new OpenCodeServer(4096, false);
    const nextUntestedVersion = nextPatchVersion(MANIFEST_OPENCODE_VERSION);
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = vi.fn().mockResolvedValue(nextUntestedVersion);

    await maybeSuggestCliUpdate(server, MANIFEST_OPENCODE_VERSION);
    await flushMicrotasks();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not show a compatibility prompt for an installed untested version', async () => {
    const server = new OpenCodeServer(4096, false);
    const installedVersion = nextPatchVersion(MANIFEST_OPENCODE_VERSION);
    const latestVersion = nextPatchVersion(installedVersion);
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };
    api.readLatestCliVersion = vi.fn().mockResolvedValue(latestVersion);

    await maybeSuggestCliUpdate(server, installedVersion);
    await flushMicrotasks();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('suggests an update beyond the manifest version when the debug setting is enabled', async () => {
    stubPlatform('linux');
    const server = new OpenCodeServer(4096, false);
    const nextUntestedVersion = nextPatchVersion(MANIFEST_OPENCODE_VERSION);
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => {
        if (key === 'server.autoUpdate') return true;
        if (key === 'debug.suggestUntestedOpenCodeUpdates') return true;
        return fallback;
      },
    }));
    api.readLatestCliVersion = vi.fn().mockResolvedValue(nextUntestedVersion);

    await maybeSuggestCliUpdate(server, MANIFEST_OPENCODE_VERSION);
    await flushMicrotasks();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      `OpenCode CLI ${nextUntestedVersion} is available, but Varro has only been tested through ${MANIFEST_OPENCODE_VERSION}. Review compatibility before updating with: opencode upgrade`,
      'Run Upgrade'
    );
  });

  it('auto-updates through the running server upgrade endpoint when available', async () => {
    stubPlatform('linux');

    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const request = vi.fn().mockResolvedValue({ success: true, version: '1.14.22' });
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
      request: typeof request;
    };

    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = readLatestCliVersion;
    api.request = request;
    setRunning(server);

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(request).toHaveBeenCalledWith('POST', '/global/upgrade', { target: '1.14.22' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('falls back to background CLI upgrade when the server upgrade endpoint is unavailable', async () => {
    stubPlatform('linux');

    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    const request = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
      request: typeof request;
    };

    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = readLatestCliVersion;
    api.request = request;
    setRunning(server);
    spawnMock.mockImplementation((_command, _args) => {
      let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
      const proc = {
        stdout: { on: vi.fn(), off: vi.fn() },
        stderr: { on: vi.fn(), off: vi.fn() },
        once: vi.fn((event: string, listener: typeof exitHandler) => {
          if (event === 'exit') {
            exitHandler = listener;
          }
        }),
        removeAllListeners: vi.fn(),
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      };
      queueMicrotask(() => {
        exitHandler?.(0, null);
      });
      return proc as never;
    });

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(request).toHaveBeenCalledWith('POST', '/global/upgrade', { target: '1.14.22' });
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['upgrade']),
      expect.any(Object)
    );
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
      request: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    api.request = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    api.process = {
      kill,
      exitCode: 0,
      signalCode: null,
      once: vi.fn(),
      off: vi.fn(),
    };
    api.managedProcess = true;
    api.stopManagedProcessForRestart = vi.fn(async () => {
      api.process = null;
      api.managedProcess = false;
    });
    setRunning(server);
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');
    vscodeMock.window.createTerminal.mockReturnValueOnce(terminal);

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(kill).not.toHaveBeenCalled();
    expect(statuses.some((status) => status.state === 'stopped')).toBe(true);
    expect(terminal.sendText).toHaveBeenCalledWith('opencode upgrade', true);
  });
});

describe('OpenCodeServer compatibility gate', () => {
  it('uses a healthy server newer than the tested compatibility ceiling', async () => {
    const server = new OpenCodeServer(4096, true);
    const prepareForHealthyExistingServer = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      startEventStream: () => void;
      requestMaintenanceCheck: () => void;
      processManager: {
        prepareForHealthyExistingServer: typeof prepareForHealthyExistingServer;
      };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.19' });
    api.startEventStream = vi.fn();
    api.requestMaintenanceCheck = vi.fn();
    api.processManager.prepareForHealthyExistingServer = prepareForHealthyExistingServer;

    await expect(server.start()).resolves.toBe(server.url);

    expect(server.status.state).toBe('running');
    expect(prepareForHealthyExistingServer).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not update or replace a server actively leased by another extension host', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const hasActiveSessions = vi.fn().mockResolvedValue(false);
    const upgradeRunningServer = vi.fn().mockResolvedValue(true);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: typeof hasActiveSessions;
      upgradeRunningServer: typeof upgradeRunningServer;
      processManager: {
        foreignActiveOwnership: boolean;
        refreshManagedServerOwnership: () => Promise<boolean>;
      };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = hasActiveSessions;
    api.upgradeRunningServer = upgradeRunningServer;
    api.processManager.foreignActiveOwnership = true;
    api.processManager.refreshManagedServerOwnership = vi.fn().mockResolvedValue(false);

    await expect(server.start()).rejects.toThrow('actively owned by another Varro extension host');

    expect(hasActiveSessions).not.toHaveBeenCalled();
    expect(upgradeRunningServer).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('blocks an outdated running server when automatic updates are disabled', async () => {
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      syncInjectedConfigFile: () => Promise<void>;
    };
    api.syncInjectedConfigFile = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });

    await expect(server.start()).rejects.toThrow('OpenCode update required');

    expect(server.status).toEqual(
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining(
          `Varro requires OpenCode ${MINIMUM_SUPPORTED_OPENCODE_VERSION} or newer`
        ),
      })
    );
    expect(server.status).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Automatic updates are disabled'),
      })
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not replace an outdated server while it has active sessions', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const upgradeRunningServer = vi.fn().mockResolvedValue(true);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      syncInjectedConfigFile: () => Promise<void>;
      hasActiveSessions: () => Promise<boolean>;
      stopServerForRestart: () => Promise<void>;
      upgradeRunningServer: () => Promise<boolean>;
    };
    api.syncInjectedConfigFile = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(true);
    api.stopServerForRestart = stopServerForRestart;
    api.upgradeRunningServer = upgradeRunningServer;

    await expect(server.start()).rejects.toThrow('has active sessions');

    expect(upgradeRunningServer).not.toHaveBeenCalled();
    expect(stopServerForRestart).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('updates and replaces an idle outdated server before reporting success', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true, 'opencode');
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const upgradeRunningServer = vi.fn().mockResolvedValue(false);
    const upgradeCli = vi.fn().mockResolvedValue(undefined);
    const readInstalledCliVersion = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('1.15.13')
      .mockResolvedValue(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      syncInjectedConfigFile: () => Promise<void>;
      hasActiveSessions: () => Promise<boolean>;
      stopServerForRestart: () => Promise<void>;
      upgradeRunningServer: () => Promise<boolean>;
      readInstalledCliVersion: () => Promise<string | null>;
      pollHealth: (
        startAttemptId: number,
        disposeGeneration: number,
        resolve: (url: string) => void,
        reject: (err: Error) => void
      ) => void;
      processManager: { upgradeCli: (targetVersion: string) => Promise<void> };
    };
    api.syncInjectedConfigFile = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.stopServerForRestart = stopServerForRestart;
    api.upgradeRunningServer = upgradeRunningServer;
    api.readInstalledCliVersion = readInstalledCliVersion;
    api.processManager.upgradeCli = upgradeCli;
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => resolve(server.url);
    spawnMock.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    } as never);

    await expect(server.start()).resolves.toBe(server.url);

    expect(upgradeRunningServer).toHaveBeenCalledWith(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(upgradeCli).toHaveBeenCalledWith(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('shows actionable recovery when the required automatic update fails', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      syncInjectedConfigFile: () => Promise<void>;
      hasActiveSessions: () => Promise<boolean>;
      stopServerForRestart: () => Promise<void>;
      upgradeRunningServer: () => Promise<boolean>;
      readInstalledCliVersion: () => Promise<string | null>;
      processManager: { upgradeCli: (targetVersion: string) => Promise<void> };
    };
    api.syncInjectedConfigFile = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    api.upgradeRunningServer = vi.fn().mockResolvedValue(false);
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.15.13');
    api.processManager.upgradeCli = vi.fn().mockRejectedValue(new Error('permission denied'));

    await expect(server.start()).rejects.toThrow('The automatic update failed: permission denied');

    expect(server.status).toEqual(
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining('Run "opencode upgrade"'),
      })
    );
  });
});

describe('OpenCodeServer startup health polling', () => {
  it('keeps the original pollHealth callbacks across recursive retries', async () => {
    const server = new OpenCodeServer(4096, false);
    const resolved = vi.fn();
    const rejected = vi.fn();
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
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

    api.readHealthInfo = vi
      .fn<() => Promise<{ healthy: boolean; version?: string }>>()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValueOnce({ healthy: true, version: MINIMUM_SUPPORTED_OPENCODE_VERSION });
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

describe('OpenCodeServer managed process lifecycle', () => {
  it('updates status and restarts when a managed child exits after startup', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);

    await expect(server.start()).resolves.toBe(server.url);
    expect(children).toHaveLength(1);

    children[0]!.emit('exit', 1, null);

    expect(server.status.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(children).toHaveLength(2);
    expect(server.status.state).toBe('running');
  });

  it('rejects a start when dispose cancels health polling', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server, false);
    const api = server as unknown as {
      processManager: { disposeProcess: () => Promise<void> };
    };
    api.processManager.disposeProcess = vi.fn().mockResolvedValue(undefined);
    const startPromise = server.start();
    const startResult = expect(startPromise).rejects.toThrow('Server start was cancelled');
    await flushMicrotasks();
    await flushMicrotasks();
    expect(children).toHaveLength(1);
    await server.dispose();

    await startResult;
    expect(server.status.state).toBe('stopped');
  });

  it('awaits cancelled pre-spawn config work without late status mutation', async () => {
    const server = new OpenCodeServer(4096, true);
    const configWork = deferred<void>();
    const statuses: ServerStatus[] = [];
    server.on('status', (status) => statuses.push(status));
    const disposeProcess = vi.fn().mockResolvedValue(undefined);
    const readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    const api = server as unknown as {
      syncInjectedConfigFile: () => Promise<void>;
      readHealthInfo: typeof readHealthInfo;
      readInstalledCliVersion: () => Promise<string | null>;
      processManager: {
        disposeProcess: typeof disposeProcess;
      };
    };
    api.syncInjectedConfigFile = vi.fn(() => configWork.promise);
    api.readHealthInfo = readHealthInfo;
    api.readInstalledCliVersion = vi.fn().mockResolvedValue(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    api.processManager.disposeProcess = disposeProcess;

    const startResult = server.start().then(
      () => null,
      (err: unknown) => err
    );
    await flushMicrotasks();

    let disposeSettled = false;
    const disposePromise = server.dispose().then(() => {
      disposeSettled = true;
    });
    await flushMicrotasks();

    expect(disposeSettled).toBe(false);
    expect(disposeProcess).not.toHaveBeenCalled();
    expect(readHealthInfo).toHaveBeenCalledTimes(1);

    configWork.resolve();

    expect(await startResult).toEqual(
      expect.objectContaining({ message: 'Server start was cancelled' })
    );
    await disposePromise;
    await vi.runAllTimersAsync();
    expect(disposeProcess).toHaveBeenCalledTimes(1);
    expect(readHealthInfo).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(statuses.map((status) => status.state)).toEqual(['stopped']);
    expect(server.status.state).toBe('stopped');
  });

  it('cancels an in-flight start before restarting', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server, false);
    let pollCount = 0;
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => {
      pollCount += 1;
      if (pollCount === 1) return;
      setRunning(server);
      resolve(server.url);
    };
    const processManager = (
      server as unknown as {
        processManager: {
          process: MockChildProcess | null;
          managedProcess: boolean;
          stopServerForRestart: () => Promise<void>;
        };
      }
    ).processManager;
    processManager.stopServerForRestart = vi.fn(async () => {
      processManager.process = null;
      processManager.managedProcess = false;
    });

    const startPromise = server.start();
    const startResult = expect(startPromise).rejects.toThrow('Server start was cancelled');
    await flushMicrotasks();
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    const restartPromise = server.restart();

    await startResult;
    await expect(restartPromise).resolves.toBe(server.url);
    expect(processManager.stopServerForRestart).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(2);
    expect(server.status.state).toBe('running');
  });

  it('waits for cancelled CLI work to settle before stopping for restart', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server);
    const upgradeWork = deferred<void>();
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    api.readInstalledCliVersion = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('1.15.13')
      .mockResolvedValue(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    const processManager = (
      server as unknown as {
        processManager: {
          upgradeCli: () => Promise<void>;
          stopServerForRestart: typeof stopServerForRestart;
        };
      }
    ).processManager;
    processManager.upgradeCli = vi.fn(() => upgradeWork.promise);
    processManager.stopServerForRestart = stopServerForRestart;

    const startResult = server.start().then(
      () => null,
      (err: unknown) => err
    );
    await flushMicrotasks();
    await flushMicrotasks();
    expect(processManager.upgradeCli).toHaveBeenCalledTimes(1);

    const restartPromise = server.restart();
    await flushMicrotasks();

    expect(stopServerForRestart).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);

    upgradeWork.resolve();

    expect(await startResult).toEqual(
      expect.objectContaining({ message: 'Server start was cancelled' })
    );
    await expect(restartPromise).resolves.toBe(server.url);
    expect(stopServerForRestart).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
    expect(server.status.state).toBe('running');
  });

  it('returns the same operation for concurrent restarts', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    let finishStopping!: () => void;
    const stopping = new Promise<void>((resolve) => {
      finishStopping = resolve;
    });
    const start = vi.fn().mockResolvedValue(server.url);
    const stopServerForRestart = vi.fn(() => stopping);
    const api = server as unknown as {
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.start = start;
    api.processManager.stopServerForRestart = stopServerForRestart;

    const first = server.restart();
    const second = server.restart();

    expect(first).toBe(second);
    await flushMicrotasks();
    expect(stopServerForRestart).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    finishStopping();

    await expect(Promise.all([first, second])).resolves.toEqual([server.url, server.url]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('holds requests behind restart while process stop is deferred', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const stopping = deferred<void>();
    const start = vi.fn().mockResolvedValue(server.url);
    const stopServerForRestart = vi.fn(() => stopping.promise);
    const api = server as unknown as {
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.start = start;
    api.processManager.stopServerForRestart = stopServerForRestart;
    const fetchMock = vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => '{}',
    } as Response);

    const restart = server.restart();
    const request = server.request('GET', '/session');
    await flushMicrotasks();

    expect(server.status.state).toBe('starting');
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();

    stopping.resolve();
    await expect(restart).resolves.toBe(server.url);
    await expect(request).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('makes concurrent starts join the in-flight restart', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const stopping = deferred<void>();
    const start = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      start: typeof start;
      processManager: { stopServerForRestart: () => Promise<void> };
    };
    api.processManager.stopServerForRestart = vi.fn(() => stopping.promise);

    const restart = server.restart();
    const firstStart = server.start();
    const secondStart = server.start();

    expect(server.status.state).toBe('starting');
    expect(firstStart).toBe(restart);
    expect(secondStart).toBe(restart);

    api.start = start;
    stopping.resolve();
    await expect(Promise.all([restart, firstStart, secondStart])).resolves.toEqual([
      server.url,
      server.url,
      server.url,
    ]);
    expect(start).toHaveBeenCalledOnce();
  });

  it('surfaces a stop rejection without returning to a running status', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const statuses: ServerStatus[] = [];
    server.on('status', (status) => statuses.push(status));
    const start = vi.fn().mockResolvedValue(server.url);
    const stopError = new Error('listener would not stop');
    const api = server as unknown as {
      start: typeof start;
      processManager: { stopServerForRestart: () => Promise<void> };
    };
    api.start = start;
    api.processManager.stopServerForRestart = vi.fn().mockRejectedValue(stopError);

    const restart = server.restart();

    expect(server.status.state).toBe('starting');
    await expect(restart).rejects.toThrow(stopError.message);
    expect(server.status).toEqual({
      state: 'error',
      message: 'Failed to stop OpenCode server for restart: listener would not stop',
    });
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'error']);
    expect(start).not.toHaveBeenCalled();
  });

  it('gives isolated crashes a fresh retry budget after the stability window', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await server.start();

    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(children).toHaveLength(2);
    expect(server.status.state).toBe('running');

    await vi.advanceTimersByTimeAsync(30_000);
    children[1]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(children).toHaveLength(3);
    expect(server.status.state).toBe('running');
  });

  it('enters error after an immediate crash loop exhausts runtime restart attempts', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await server.start();

    for (const delay of [1_000, 2_000, 4_000]) {
      children[children.length - 1]!.emit('exit', 1, null);
      expect(server.status.state).toBe('stopped');
      await vi.advanceTimersByTimeAsync(delay);
      await flushMicrotasks();
      expect(server.status.state).toBe('running');
    }

    children[children.length - 1]!.emit('exit', 1, null);

    expect(server.status).toEqual({
      state: 'error',
      message:
        'OpenCode server stopped unexpectedly (code 1). Restart attempts (3) were exhausted.',
    });
    expect(children).toHaveLength(4);
  });
});
