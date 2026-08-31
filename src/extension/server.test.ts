/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These server integration tests deliberately model malformed health data, partial child processes, and private lifecycle state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type * as FsModule from 'fs';
import type * as FsPromisesModule from 'fs/promises';
import type * as OsModule from 'os';
import { dirname, join } from 'path';
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
      show: vi.fn(),
    },
    mkdirMock: vi.fn(() => Promise.resolve(undefined)),
    spawnMock: vi.fn(),
    vscodeMock: {
      window: {
        activeTextEditor: undefined,
        showInformationMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
        showWarningMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
        createTerminal: vi.fn(() => ({
          show: vi.fn(),
          sendText: vi.fn(),
        })),
        onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
      },
      workspace: {
        getConfiguration: vi.fn(),
        getWorkspaceFolder: vi.fn(),
        workspaceFolders: undefined,
      },
      env: { openExternal: vi.fn() },
      Uri: { parse: vi.fn((value: string) => value) },
    },
    writeFileMock: vi.fn(() => Promise.resolve(undefined)),
  }));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('cross-spawn', () => ({ default: spawnMock, spawn: spawnMock }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OsModule>('os');
  return {
    ...actual,
    tmpdir: () => `${actual.tmpdir()}/varro-server-test-${process.pid}`,
  };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn((path: FsModule.PathOrFileDescriptor, options?: unknown) => {
      if (typeof path === 'string' && /(?:^|[/\\])varro-opencode-server-\d+\.json$/.test(path)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
      }
      return actual.readFileSync(path, options as never);
    }),
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

import { OpenCodeServer as RealOpenCodeServer } from './server';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';

let serverOwnershipPathSequence = 0;
class OpenCodeServer extends RealOpenCodeServer {
  constructor(
    port: number,
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    compactionSettings?: ConstructorParameters<typeof RealOpenCodeServer>[4]
  ) {
    super(
      port,
      autoStart,
      command,
      simulateMissingCli,
      compactionSettings,
      join('/tmp', `varro-server-test-${process.pid}-${++serverOwnershipPathSequence}.json`)
    );
  }
}

const MANIFEST_OPENCODE_VERSION = readMaximumTestedOpenCodeVersion();

function nextPatchVersion(version: string) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('OpenCodeServer port validation', () => {
  it.each([0, -1, 1.5, 65_536, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid runtime port %s',
    (port) => {
      expect(() => new OpenCodeServer(port, true)).toThrow('varro.server.port');
    }
  );
});

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

// The exit -> cleanup -> health-read -> recovery chain spans several awaits.
function settleRecovery() {
  return vi.advanceTimersByTimeAsync(0);
}

function crashDuringStartup(child: MockChildProcess, stderr: string) {
  child.stderr.emit('data', Buffer.from(stderr));
  child.emit('exit', 1, null);
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

type TestTimer = ReturnType<typeof setTimeout> | number;

function setRestartTimer(server: OpenCodeServer, timer: TestTimer | null) {
  (server as unknown as { restartTimer: TestTimer | null }).restartTimer = timer;
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

/**
 * Stubs the CLI spawn used by both `upgrade` and `--version`. `version` is what
 * `--version` prints, which is what the upgrade verification reads back: a stub
 * that prints nothing models a CLI that exited 0 without actually updating.
 */
function stubCliSpawn(options: { version?: string; stderr?: string } = {}) {
  spawnMock.mockImplementation((_command, args: string[]) => {
    let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    let stderrHandler: ((chunk: Buffer) => void) | undefined;
    const proc = {
      stdout: {
        on: vi.fn((event: string, listener: typeof stdoutHandler) => {
          if (event === 'data') stdoutHandler = listener;
        }),
        off: vi.fn(),
      },
      stderr: {
        on: vi.fn((event: string, listener: typeof stderrHandler) => {
          if (event === 'data') stderrHandler = listener;
        }),
        off: vi.fn(),
      },
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
      if (options.version && args?.includes('--version')) {
        stdoutHandler?.(Buffer.from(options.version));
      }
      // A CLI that prints the reason on stderr and still exits 0.
      if (options.stderr && args?.includes('upgrade')) {
        stderrHandler?.(Buffer.from(options.stderr));
      }
      exitHandler?.(0, null);
    });
    return proc as never;
  });
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

    const oversizedChunk = new TextEncoder().encode('x'.repeat(8_000_001));
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

  it('accepts large OpenCode sync events without reconnecting', async () => {
    const server = new OpenCodeServer(4096, false);
    const events: unknown[] = [];
    const statuses: ServerStatus[] = [];
    server.on('event', (event) => events.push(event));
    server.on('status', (status) => statuses.push(status));
    setRunning(server);

    const payload = JSON.stringify({
      type: 'sync',
      properties: { content: 'x'.repeat(2_500_000) },
    });
    const encoded = new TextEncoder().encode(`data: ${payload}\n\n`);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.length; offset += 64_000) {
      chunks.push(encoded.subarray(offset, offset + 64_000));
    }
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) =>
      createChunkedEventResponse(init?.signal as AbortSignal, chunks)
    );

    const stream = startEventStream(server);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    const event = events[0] as { type?: string; properties?: { content?: string } };
    expect(event.type).toBe('sync');
    expect(event.properties?.content).toHaveLength(2_500_000);
    expect(
      statuses.some((status) => status.state === 'running' && status.eventStream === 'degraded')
    ).toBe(false);

    stopEventStream(server);
    await stream;
  });

  it('drops oversized SSE payloads before parsing them', async () => {
    const server = new OpenCodeServer(4096, false);
    const events: unknown[] = [];
    server.on('event', (event) => events.push(event));
    setRunning(server);

    const oversizedPayload = `data: {"type":"${'x'.repeat(8_000_001)}"}\n\n`;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(createImmediateEventResponse(oversizedPayload));

    await startEventStream(server);

    expect(events).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Ignoring oversized event stream payload (8000012 chars > 8000000)'
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
    const processManager = (
      server as unknown as {
        processManager: {
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
        };
      }
    ).processManager;
    processManager.process = {
      stdout: { off: stdoutOff },
      stderr: { off: stderrOff },
      off: procOff,
      exitCode: null,
      signalCode: null,
    };
    processManager.processStdoutHandler = stdoutHandler;
    processManager.processStderrHandler = stderrHandler;
    processManager.processExitHandler = exitHandler;
    processManager.processErrorHandler = errorHandler;

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
      processManager: {
        ownershipLeaseCandidate: unknown;
        port: number;
      };
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
    // Do not let a lease from a concurrently running extension redirect this config-only test.
    api.processManager.ownershipLeaseCandidate = null;
    api.processManager.port = 4096;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.readInstalledCliVersion = vi.fn().mockResolvedValue(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => {
      resolve(server.url);
    };

    await server.start();

    const configText = await (
      server as unknown as {
        processManager: { serializeInjectedConfig: () => Promise<string> };
      }
    ).processManager.serializeInjectedConfig();
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
        'Preserving caller-provided OPENCODE_CONFIG; Varro runtime settings are not injected for this managed server'
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
        processManager: { serializeInjectedConfig: () => Promise<string> };
      }
    ).processManager.serializeInjectedConfig();
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
    api.request = vi.fn().mockImplementation(async (_method, path) => {
      if (path === '/experimental/session?limit=100') {
        return [{ directory: '/repo-a' }, { directory: '/repo-b' }];
      }
      if (path === '/session/status?directory=%2Frepo-a') {
        return {
          'session-1': { type: 'busy' },
          'session-3': { type: 'idle' },
        };
      }
      if (path === '/session/status?directory=%2Frepo-b') {
        return {
          'session-1': { type: 'busy' },
          'session-2': { type: 'retry' },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const info = await server.readServerInfo();

    expect(info.managedProcess).toBe(false);
    expect(info.activeAgentCount).toBe(2);
    expect(info.activeAgentError).toBeNull();
    expect(api.request).toHaveBeenCalledWith('GET', '/experimental/session?limit=100', undefined, {
      unscoped: true,
    });
  });

  it('reports the current status when health collection outlives a startup transition', async () => {
    const server = new OpenCodeServer(4096, true);
    const health = deferred<{ healthy: boolean; version?: string }>();
    const api = server as unknown as {
      _status: ServerStatus;
      readInstalledCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
    };
    api._status = { state: 'starting' };
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.18.15');
    api.readHealthInfo = vi.fn(() => health.promise);

    const infoPromise = server.readServerInfo();
    await flushMicrotasks();
    api._status = { state: 'error', message: 'startup failed' };
    health.resolve({ healthy: false });

    await expect(infoPromise).resolves.toMatchObject({
      status: { state: 'error', message: 'startup failed' },
      health: { healthy: false },
    });
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

  it('checks for deferred maintenance from a global event envelope without changing emission', () => {
    const server = new OpenCodeServer(4096, false);
    const requestMaintenanceCheck = vi.fn();
    const envelope = {
      directory: '/repo',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } },
      },
    };
    const listener = vi.fn();
    const api = server as unknown as {
      handleServerEvent: (value: unknown) => void;
      requestMaintenanceCheck: () => void;
    };
    api.requestMaintenanceCheck = requestMaintenanceCheck;
    server.on('event', listener);

    api.handleServerEvent(envelope);

    expect(listener).toHaveBeenCalledWith(envelope);
    expect(requestMaintenanceCheck).toHaveBeenCalledOnce();
  });

  it('restarts a managed process without emitting a stopped status', async () => {
    const server = new OpenCodeServer(4096, false);
    const statuses: ServerStatus[] = [];
    const api = server as unknown as {
      process: { kill: ReturnType<typeof vi.fn>; exitCode: number; signalCode: null } | null;
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
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
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
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
      processManager: { takeOwnershipOfExistingServer: () => Promise<boolean> };
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
    api.processManager.takeOwnershipOfExistingServer = vi.fn().mockResolvedValue(false);
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
    stubCliSpawn({ version: '1.14.22' });

    await runMaintenanceTick(server);
    await flushMicrotasks();

    expect(restartServerForCliUpdate).toHaveBeenCalledWith('1.14.20', '1.14.22');
  });

  it('does not treat an upgrade that left the CLI unchanged as done', async () => {
    // `opencode upgrade` handles its own errors: it can print "Upgrade failed"
    // and still exit 0. Trusting the exit code restarts the server against a
    // CLI that never moved, and silently records the new version as installed.
    stubPlatform('linux');

    const server = new OpenCodeServer(4096, true);
    const restartServerForCliUpdate = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readLatestCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
      restartServerForCliUpdate: (a: string, b: string) => Promise<void>;
    };

    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.restartServerForCliUpdate = restartServerForCliUpdate;
    // Exits 0 for `upgrade`, but `--version` still reports the old build.
    stubCliSpawn({ version: '1.14.20' });

    await runMaintenanceTick(server);
    await flushMicrotasks();

    expect(restartServerForCliUpdate).not.toHaveBeenCalled();
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledOnce();
    expect(vscodeMock.window.showWarningMessage.mock.calls[0]?.[0]).toContain(
      'could not update the OpenCode CLI to 1.14.22'
    );
  });

  it('keeps the printed cause when a zero-exit upgrade did nothing', async () => {
    // The cause only exists in what the command printed. Replacing it with a
    // generic "did not change" message classifies as `unknown` and loses the
    // one instruction that would actually work.
    stubPlatform('linux');

    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      process: Record<string, unknown> | null;
      managedProcess: boolean;
      readLatestCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: () => Promise<boolean>;
    };

    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    setRunning(server);
    api.process = {};
    api.managedProcess = true;
    api.readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    stubCliSpawn({
      version: '1.14.20',
      stderr: "EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
    });

    await runMaintenanceTick(server);
    await flushMicrotasks();

    // Classified from the real stderr, so the guidance is the permission one.
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledOnce();
    expect(vscodeMock.window.showWarningMessage.mock.calls[0]?.[0]).toContain(
      'denied write access'
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('EACCES: permission denied')
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

  it('retries a failed CLI registry check after the short failure cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:00Z'));
    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('1.14.22');
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };
    api.readLatestCliVersion = readLatestCliVersion;

    await maybeSuggestCliUpdate(server, '1.14.20');
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await maybeSuggestCliUpdate(server, '1.14.20');
    expect(readLatestCliVersion).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await maybeSuggestCliUpdate(server, '1.14.20');
    expect(readLatestCliVersion).toHaveBeenCalledTimes(2);
  });

  it('runs the upgrade command in an integrated terminal when the notification action is selected', async () => {
    stubPlatform('linux');

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
    stubCliSpawn({ version: '1.14.22' });

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
    stubCliSpawn({ version: '1.14.22' });

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();

    expect(request).toHaveBeenCalledWith('POST', '/global/upgrade', { target: '1.14.22' });
    // The endpoint replaces the `upgrade` spawn, not the read-back that
    // confirms the binary actually changed.
    expect(spawnMock).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['upgrade']),
      expect.any(Object)
    );
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
    stubCliSpawn({ version: '1.14.22' });

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
      readHealthInfo: ReturnType<typeof vi.fn>;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');
    vscodeMock.window.createTerminal.mockReturnValueOnce(terminal);

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();
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
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    api.request = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.14.20' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
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

  it('does not stop a managed Windows process while sessions are active', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, false);
    const stopManagedProcessForRestart = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: typeof stopManagedProcessForRestart;
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.18.8' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(true);
    api.stopManagedProcessForRestart = stopManagedProcessForRestart;
    setRunning(server);

    await expect(server.prepareForWindowsCliUpgrade()).rejects.toThrow('active sessions');

    expect(stopManagedProcessForRestart).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
  });

  it('does not stop a managed Windows process when health cannot be verified', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, false);
    const stopManagedProcessForRestart = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: typeof stopManagedProcessForRestart;
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.stopManagedProcessForRestart = stopManagedProcessForRestart;
    setRunning(server);

    await expect(server.prepareForWindowsCliUpgrade()).rejects.toThrow(
      'could not verify that the managed OpenCode server is idle'
    );

    expect(stopManagedProcessForRestart).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
  });

  it('blocks automatic startup after preparing a Windows terminal update', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const startOperation = vi.fn().mockResolvedValue(server.url);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      readHealthInfo: ReturnType<typeof vi.fn>;
      startOperation: typeof startOperation;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.startOperation = startOperation;
    api.processManager.stopServerForRestart = stopServerForRestart;

    await server.prepareForWindowsCliUpgrade();

    await expect(server.start()).rejects.toThrow('being updated in a terminal');
    expect(startOperation).not.toHaveBeenCalled();

    await expect(server.restart()).rejects.toThrow('close it before restarting');
    await server.finishWindowsCliUpgrade();
    await expect(server.restart()).resolves.toBe(server.url);
    expect(startOperation).toHaveBeenCalledOnce();
  });

  it('verifies the terminal update and restores a previously managed server after failure', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const startOperation = vi.fn().mockResolvedValue(server.url);
    const clearResolvedCommandCache = vi.fn();
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      readInstalledCliVersion: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
      startOperation: typeof startOperation;
      getWorkspaceCwd: ReturnType<typeof vi.fn>;
      processManager: { clearResolvedCommandCache: typeof clearResolvedCommandCache };
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.0' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.17.0');
    api.stopManagedProcessForRestart = vi.fn(async () => {
      api.managedProcess = false;
    });
    api.startOperation = startOperation;
    api.getWorkspaceCwd = vi.fn(() => '/repo');
    api.processManager.clearResolvedCommandCache = clearResolvedCommandCache;
    setRunning(server);

    await server.prepareForWindowsCliUpgrade('1.18.0');
    await server.finishWindowsCliUpgrade();

    expect(clearResolvedCommandCache).toHaveBeenCalledOnce();
    expect(api.readInstalledCliVersion).toHaveBeenCalledOnce();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Windows OpenCode terminal update closed, but CLI 1.17.0 is older than requested 1.18.0'
    );
    expect(startOperation).toHaveBeenCalledOnce();
  });

  it('releases a failed terminal update without restoring into a different workspace', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const startOperation = vi.fn().mockResolvedValue(server.url);
    let workspacePath = '/repo';
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      readInstalledCliVersion: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
      startOperation: typeof startOperation;
      getWorkspaceCwd: ReturnType<typeof vi.fn>;
      pendingTerminalCliUpgrades: number;
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.0' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.readInstalledCliVersion = vi.fn().mockRejectedValue(new Error('update was cancelled'));
    api.stopManagedProcessForRestart = vi.fn(async () => {
      api.managedProcess = false;
    });
    api.startOperation = startOperation;
    api.getWorkspaceCwd = vi.fn(() => workspacePath);
    setRunning(server);

    await server.prepareForWindowsCliUpgrade('1.18.0');
    workspacePath = '/other-repo';
    await server.finishWindowsCliUpgrade();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Could not verify OpenCode CLI after terminal update: update was cancelled'
    );
    expect(startOperation).not.toHaveBeenCalled();
    expect(api.pendingTerminalCliUpgrades).toBe(0);
  });

  it('serializes a new terminal update behind close verification and server restoration', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const firstVersion = deferred<string | null>();
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      readInstalledCliVersion: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
      startOperation: ReturnType<typeof vi.fn>;
      getWorkspaceCwd: ReturnType<typeof vi.fn>;
      pendingTerminalCliUpgrades: number;
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.0' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.readInstalledCliVersion = vi
      .fn()
      .mockImplementationOnce(() => firstVersion.promise)
      .mockResolvedValue('1.18.0');
    api.stopManagedProcessForRestart = vi.fn(async () => {
      api.managedProcess = false;
    });
    api.startOperation = vi.fn(async () => {
      api.managedProcess = true;
      return server.url;
    });
    api.getWorkspaceCwd = vi.fn(() => '/repo');
    setRunning(server);

    await server.prepareForWindowsCliUpgrade('1.18.0');
    const firstFinish = server.finishWindowsCliUpgrade();
    const secondPrepare = server.prepareForWindowsCliUpgrade('1.18.0');
    await Promise.resolve();

    expect(api.stopManagedProcessForRestart).toHaveBeenCalledOnce();
    firstVersion.resolve('1.18.0');
    await firstFinish;
    await secondPrepare;

    expect(api.startOperation).toHaveBeenCalledOnce();
    expect(api.stopManagedProcessForRestart).toHaveBeenCalledTimes(2);
    expect(api.pendingTerminalCliUpgrades).toBe(1);
    await server.finishWindowsCliUpgrade();
  });

  it('blocks new requests while a Windows terminal update reserves and stops the server', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, false);
    const requestsSettled = deferred<void>();
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      readInstalledCliVersion: ReturnType<typeof vi.fn>;
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
      getWorkspaceCwd: ReturnType<typeof vi.fn>;
      transport: {
        request: ReturnType<typeof vi.fn>;
        waitForRequestsToSettle: ReturnType<typeof vi.fn>;
      };
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.17.0' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.18.0');
    api.stopManagedProcessForRestart = vi.fn(async () => {
      api.managedProcess = false;
    });
    api.getWorkspaceCwd = vi.fn(() => '/repo');
    api.transport.request = vi.fn();
    api.transport.waitForRequestsToSettle = vi.fn(() => requestsSettled.promise);

    const preparation = server.prepareForWindowsCliUpgrade('1.18.0');
    await Promise.resolve();

    await expect(server.request('POST', '/session')).rejects.toThrow(
      'not accepting requests while the CLI is being updated'
    );
    expect(api.transport.request).not.toHaveBeenCalled();

    requestsSettled.resolve();
    await preparation;
    await expect(server.prepareForWindowsCliUpgrade('1.18.0')).rejects.toThrow(
      'update terminal is already open'
    );
    await server.finishWindowsCliUpgrade();
  });

  it('does not stop a server owned by another live Varro window for an update', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      processManager: { hasForeignActiveOwnership: boolean };
      stopManagedProcessForRestart: ReturnType<typeof vi.fn>;
    };
    Object.defineProperty(api.processManager, 'hasForeignActiveOwnership', {
      configurable: true,
      value: true,
    });
    api.stopManagedProcessForRestart = vi.fn();

    await expect(server.prepareForWindowsCliUpgrade()).rejects.toThrow(
      'owned by another Varro window'
    );
    expect(api.stopManagedProcessForRestart).not.toHaveBeenCalled();
  });

  it('does not update through a running Windows server owned outside this window', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, false);
    const api = server as unknown as {
      readHealthInfo: ReturnType<typeof vi.fn>;
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    setRunning(server);

    await expect(server.prepareForWindowsCliUpgrade()).rejects.toThrow(
      'not owned by this Varro window'
    );
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
    api.startEventStream = vi.fn(() => {
      expect(server.status.state).not.toBe('running');
    });
    api.requestMaintenanceCheck = vi.fn();
    api.processManager.prepareForHealthyExistingServer = prepareForHealthyExistingServer;

    await expect(server.start()).resolves.toBe(server.url);

    expect(server.status).toEqual({
      state: 'running',
      url: server.url,
      eventStream: 'degraded',
    });
    expect(prepareForHealthyExistingServer).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('allows a Varro window to replace a server leased by another extension host', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const hasActiveSessions = vi.fn().mockResolvedValue(false);
    const upgradeRunningServer = vi.fn().mockResolvedValue(true);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const launchManagedServer = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: typeof hasActiveSessions;
      upgradeRunningServer: typeof upgradeRunningServer;
      stopServerForRestart: typeof stopServerForRestart;
      ensureCompatibleCliForLaunch: () => Promise<void>;
      launchManagedServer: typeof launchManagedServer;
      processManager: {
        foreignActiveOwnership: boolean;
      };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = hasActiveSessions;
    api.upgradeRunningServer = upgradeRunningServer;
    api.stopServerForRestart = stopServerForRestart;
    api.ensureCompatibleCliForLaunch = vi.fn().mockResolvedValue(undefined);
    api.launchManagedServer = launchManagedServer;
    api.processManager.foreignActiveOwnership = true;

    await expect(server.start()).resolves.toBe(server.url);

    expect(hasActiveSessions).toHaveBeenCalledTimes(2);
    expect(upgradeRunningServer).toHaveBeenCalledOnce();
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(launchManagedServer).toHaveBeenCalledOnce();
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

  it('does not replace a server that becomes active while the upgrade is running', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const upgradeRunningServer = vi.fn().mockResolvedValue(true);
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      stopServerForRestart: typeof stopServerForRestart;
      upgradeRunningServer: typeof upgradeRunningServer;
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    api.stopServerForRestart = stopServerForRestart;
    api.upgradeRunningServer = upgradeRunningServer;

    await expect(server.start()).rejects.toThrow('has active sessions');

    expect(api.hasActiveSessions).toHaveBeenCalledTimes(2);
    expect(upgradeRunningServer).toHaveBeenCalledOnce();
    expect(stopServerForRestart).not.toHaveBeenCalled();
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
    expect(api.hasActiveSessions).toHaveBeenCalledTimes(2);
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(upgradeCli).toHaveBeenCalledWith(MINIMUM_SUPPORTED_OPENCODE_VERSION);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  type CompatibilityGateApi = {
    readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
    syncInjectedConfigFile: () => Promise<void>;
    hasActiveSessions: () => Promise<boolean>;
    stopServerForRestart: () => Promise<void>;
    upgradeRunningServer: () => Promise<boolean>;
    readInstalledCliVersion: () => Promise<string | null>;
    processManager: {
      upgradeCli: (targetVersion: string) => Promise<void>;
      getInstallInfo: () => unknown;
    };
  };

  // The real getInstallInfo probes the developer's own PATH, so pin it to keep
  // the recovery instructions deterministic across machines.
  function stubIncompatibleServer(
    server: OpenCodeServer,
    installMethod: 'npm' | 'bun' | 'unknown' = 'npm'
  ): CompatibilityGateApi {
    const api = server as unknown as CompatibilityGateApi;
    api.syncInjectedConfigFile = vi.fn().mockResolvedValue(undefined);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.15.13' });
    api.hasActiveSessions = vi.fn().mockResolvedValue(false);
    api.stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    api.upgradeRunningServer = vi.fn().mockResolvedValue(false);
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('1.15.13');
    api.processManager.getInstallInfo = vi.fn().mockReturnValue({
      resolvedCommand: '/Users/me/.npm-global/bin/opencode',
      configuredCommand: '',
      configuredCommandMissing: false,
      found: true,
      installMethod,
      searchedPaths: ['/Users/me/.npm-global/bin'],
    });
    return api;
  }

  it('recommends the install-specific command when the required update fails', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const api = stubIncompatibleServer(server, 'npm');
    api.processManager.upgradeCli = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: permission denied, mkdir '/usr/local/lib'"));

    await expect(server.start()).rejects.toThrow('The automatic update failed.');

    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.state).toBe('error');
    // The whole point: never re-recommend the command that just failed.
    expect(status.message).not.toContain('opencode upgrade');
    expect(status.message).toContain('npm install -g opencode-ai@latest');
    expect(status.detail).toEqual(
      expect.objectContaining({
        kind: 'update-failed',
        installMethod: 'npm',
        suggestedCommand: 'npm install -g opencode-ai@latest',
        required: MINIMUM_SUPPORTED_OPENCODE_VERSION,
      })
    );
  });

  it('tells windows users to close the running binary when the update is locked out', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      getConfigurationMock.mockImplementation(() => ({
        get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
      }));
      const server = new OpenCodeServer(4096, true);
      const api = stubIncompatibleServer(server, 'npm');
      api.processManager.upgradeCli = vi
        .fn()
        .mockRejectedValue(new Error('EPERM: operation not permitted, rename opencode.exe'));

      await expect(server.start()).rejects.toThrow('The automatic update failed.');

      const status = server.status as Extract<ServerStatus, { state: 'error' }>;
      expect(status.message).toContain('Close the OpenCode TUI');
      expect(status.detail).toEqual(expect.objectContaining({ kind: 'update-failed' }));
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('falls back to reinstall guidance when the install method is unrecognized', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const api = stubIncompatibleServer(server, 'unknown');
    api.processManager.upgradeCli = vi
      .fn()
      .mockRejectedValue(new Error('Error: unknown installation method'));

    await expect(server.start()).rejects.toThrow('The automatic update failed.');

    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.message).toContain('Reinstall OpenCode');
    expect(status.message).not.toContain('opencode upgrade');
    expect(status.detail).toEqual(
      expect.objectContaining({ kind: 'update-failed', installMethod: 'unknown' })
    );
    expect((status.detail as { suggestedCommand?: string }).suggestedCommand).toBeUndefined();
  });

  it('marks an update blocked by disabled auto-update with the setting to change', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? false : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    stubIncompatibleServer(server);

    await expect(server.start()).rejects.toThrow('Automatic updates are disabled.');

    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.detail).toEqual(
      expect.objectContaining({
        kind: 'update-blocked',
        blockedBy: 'auto-update-disabled',
        settingId: 'varro.server.autoUpdate',
        installMethod: 'npm',
        suggestedCommand: 'npm install -g opencode-ai@latest',
      })
    );
    expect(status.message).toContain('Enable varro.server.autoUpdate');
  });

  it('marks an update deferred by active sessions as blocked, not failed', async () => {
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    const server = new OpenCodeServer(4096, true);
    const api = stubIncompatibleServer(server);
    api.hasActiveSessions = vi.fn().mockResolvedValue(true);

    await expect(server.start()).rejects.toThrow('active sessions');

    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.detail).toEqual(
      expect.objectContaining({ kind: 'update-blocked', blockedBy: 'active-sessions' })
    );
  });

  it('fails closed when pending questions cannot be checked', async () => {
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      hasActiveSessions: () => Promise<boolean>;
      transport: { request: ReturnType<typeof vi.fn> };
    };
    api.transport.request = vi.fn(async (_method: string, path: string) => {
      if (path === '/question') throw new Error('question endpoint unavailable');
      return {};
    });

    await expect(api.hasActiveSessions()).rejects.toThrow('question endpoint unavailable');
  });

  it('fails closed when active-work responses are malformed', async () => {
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      hasActiveSessions: () => Promise<boolean>;
      transport: { request: ReturnType<typeof vi.fn> };
    };
    api.transport.request = vi.fn(async () => ({}));

    await expect(api.hasActiveSessions()).rejects.toThrow('invalid pending question response');
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
      processManager: { confirmManagedServerOwnership: () => Promise<boolean> };
    };

    api.readHealthInfo = vi
      .fn<() => Promise<{ healthy: boolean; version?: string }>>()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValueOnce({ healthy: true, version: MINIMUM_SUPPORTED_OPENCODE_VERSION });
    api.startAttemptId = 1;
    api.disposeGeneration = 0;
    api.processManager.confirmManagedServerOwnership = vi.fn().mockResolvedValue(true);

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

describe('OpenCodeServer restart blockers', () => {
  it('groups unique blocking sessions by normalized directory', async () => {
    const server = new OpenCodeServer(4096, true);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const pathname = new URL(String(input)).pathname;
      const body =
        pathname === '/session/status'
          ? {
              'session-1': { type: 'busy' },
              'session-2': { type: 'retry' },
              idle: { type: 'idle' },
            }
          : pathname === '/question' || pathname === '/permission'
            ? [{ sessionID: 'session-2' }, { sessionID: 'session-3' }]
            : [
                { id: 'session-1', directory: 'C:\\Repo' },
                { id: 'session-2', directory: 'c:/repo/' },
                { id: 'session-3', directory: '/other' },
              ];
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await expect(server.readRestartBlockers()).resolves.toEqual({
      totalSessionCount: 3,
      directories: [
        { directory: '/other', sessionCount: 1 },
        { directory: 'C:\\Repo', sessionCount: 2 },
      ],
    });
  });

  it('persists an inactive rescope as the desired server workspace on Windows', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);

    await expect(server.rescopeEventStream('/repo-selected')).resolves.toEqual({
      state: 'inactive',
      directory: '/repo-selected',
    });

    expect(server.getWorkspaceCwd()).toBe('/repo-selected');

    configureManagedStartup(server);
    await server.start();
    expect(spawnMock).toHaveBeenCalledOnce();
    const launch = spawnMock.mock.calls[0];
    expect(launch?.[2]).toEqual(expect.objectContaining({ cwd: '/repo-selected' }));
  });

  it('merges unscoped status, question, permission, and observed session IDs', async () => {
    const server = new OpenCodeServer(4096, true);
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/session/status') return { 'session-1': { type: 'busy' } };
      if (path === '/question') return [{ sessionID: 'session-2' }];
      if (path === '/permission') return [{ sessionID: 'session-3' }];
      if (path === '/session') return [];
      throw new Error(`Unexpected request: ${path}`);
    });
    const api = server as unknown as {
      transport: {
        request: typeof request;
        getPendingAttentionSessionIDs: () => string[];
      };
    };
    api.transport.request = request;
    api.transport.getPendingAttentionSessionIDs = () => ['session-1', 'session-4'];

    await expect(server.readRestartBlockers()).resolves.toEqual({
      totalSessionCount: 4,
      directories: [{ directory: null, sessionCount: 4 }],
    });
    expect(request).toHaveBeenCalledWith('GET', '/session/status', undefined, { unscoped: true });
    expect(request).toHaveBeenCalledWith('GET', '/question', undefined, { unscoped: true });
    expect(request).toHaveBeenCalledWith('GET', '/permission', undefined, { unscoped: true });
  });

  it('includes a synchronized attention ask when restart snapshots are empty', async () => {
    const server = new OpenCodeServer(4096, true);
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/session/status') return {};
      if (path === '/question' || path === '/permission' || path === '/session') return [];
      throw new Error(`Unexpected request: ${path}`);
    });
    const transport = (
      server as unknown as {
        transport: {
          observeServerEvent(event: unknown): void;
          request: typeof request;
        };
      }
    ).transport;
    transport.request = request;
    transport.observeServerEvent({
      payload: {
        type: 'sync',
        syncEvent: {
          type: 'permission.asked.1',
          data: { id: 'permission-1', sessionID: 'session-1' },
        },
      },
    });

    await expect(server.readRestartBlockers()).resolves.toEqual({
      totalSessionCount: 1,
      directories: [{ directory: null, sessionCount: 1 }],
    });
  });

  it.each([
    ['/session/status', { 'session-1': { state: 'busy' } }, 'session status'],
    ['/question', [{}], 'pending question'],
    ['/permission', [{}], 'pending permission'],
  ])('fails closed for a malformed %s entry', async (malformedPath, malformed, message) => {
    const server = new OpenCodeServer(4096, true);
    const api = server as unknown as {
      transport: { request: ReturnType<typeof vi.fn> };
    };
    api.transport.request = vi.fn(async (_method: string, path: string) => {
      if (path === malformedPath) return malformed;
      if (path === '/session/status') return {};
      return [];
    });

    await expect(server.readRestartBlockers()).rejects.toThrow(`invalid ${message} response`);
  });

  it('allows force restart without running the active-session preflight', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(server.url);
    const hasActiveSessions = vi.fn().mockResolvedValue(true);
    const api = server as unknown as {
      hasActiveSessions: typeof hasActiveSessions;
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.hasActiveSessions = hasActiveSessions;
    api.start = start;
    api.processManager.stopServerForRestart = stopServerForRestart;

    await expect(server.restart({ force: true })).resolves.toBe(server.url);

    expect(hasActiveSessions).not.toHaveBeenCalled();
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('reclaims a marked server before retrying an unmanaged-port failure', async () => {
    const server = new OpenCodeServer(4096, true);
    const takeOwnershipOfExistingServer = vi.fn().mockResolvedValue(true);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      _status: ServerStatus;
      start: typeof start;
      processManager: {
        takeOwnershipOfExistingServer: typeof takeOwnershipOfExistingServer;
        stopServerForRestart: typeof stopServerForRestart;
      };
    };
    api._status = {
      state: 'error',
      message: 'Port 4096 is occupied by a process Varro does not own',
    };
    api.start = start;
    api.processManager.takeOwnershipOfExistingServer = takeOwnershipOfExistingServer;
    api.processManager.stopServerForRestart = stopServerForRestart;

    await expect(server.restart({ force: true })).resolves.toBe(server.url);

    expect(takeOwnershipOfExistingServer).toHaveBeenCalledOnce();
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});

describe('OpenCodeServer adopted process recovery', () => {
  it('coalesces degraded checks and leaves a live adopted server running', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const revalidation = deferred<boolean>();
    const startOperation = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      updateEventStreamState: (state: 'healthy' | 'degraded') => void;
      startOperation: typeof startOperation;
      processManager: {
        isAdoptedManagedServer: boolean;
        revalidateAdoptedManagedServer: ReturnType<typeof vi.fn>;
      };
    };
    Object.defineProperty(api.processManager, 'isAdoptedManagedServer', {
      configurable: true,
      get: () => true,
    });
    api.processManager.revalidateAdoptedManagedServer = vi.fn(() => revalidation.promise);
    api.startOperation = startOperation;

    api.updateEventStreamState('degraded');
    api.updateEventStreamState('degraded');
    expect(api.processManager.revalidateAdoptedManagedServer).toHaveBeenCalledOnce();

    revalidation.resolve(true);
    await flushMicrotasks();

    expect(server.status).toEqual({
      state: 'running',
      url: server.url,
      eventStream: 'degraded',
    });
    expect(startOperation).not.toHaveBeenCalled();
  });

  it('uses the runtime retry path when the adopted server identity disappears', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const startOperation = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      updateEventStreamState: (state: 'healthy' | 'degraded') => void;
      startOperation: typeof startOperation;
      processManager: {
        isAdoptedManagedServer: boolean;
        revalidateAdoptedManagedServer: ReturnType<typeof vi.fn>;
      };
    };
    Object.defineProperty(api.processManager, 'isAdoptedManagedServer', {
      configurable: true,
      get: () => true,
    });
    api.processManager.revalidateAdoptedManagedServer = vi.fn().mockResolvedValue(false);
    api.startOperation = startOperation;

    api.updateEventStreamState('degraded');
    await flushMicrotasks();

    expect(server.status.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startOperation).toHaveBeenCalledWith(true);
  });

  it('does not run degraded recovery for an ordinary managed child', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const api = server as unknown as {
      updateEventStreamState: (state: 'healthy' | 'degraded') => void;
      processManager: {
        process: MockChildProcess;
        managedProcess: boolean;
        revalidateAdoptedManagedServer: ReturnType<typeof vi.fn>;
      };
    };
    api.processManager.process = createMockChildProcess();
    api.processManager.managedProcess = true;
    api.processManager.revalidateAdoptedManagedServer = vi.fn();

    api.updateEventStreamState('degraded');
    await flushMicrotasks();

    expect(api.processManager.revalidateAdoptedManagedServer).not.toHaveBeenCalled();
    expect(server.status).toEqual({
      state: 'running',
      url: server.url,
      eventStream: 'degraded',
    });
  });

  it('does not schedule adopted recovery after disposal begins', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const revalidation = deferred<boolean>();
    const startOperation = vi.fn().mockResolvedValue(server.url);
    const disposeProcess = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      updateEventStreamState: (state: 'healthy' | 'degraded') => void;
      startOperation: typeof startOperation;
      processManager: {
        isAdoptedManagedServer: boolean;
        revalidateAdoptedManagedServer: ReturnType<typeof vi.fn>;
        disposeProcess: typeof disposeProcess;
      };
    };
    Object.defineProperty(api.processManager, 'isAdoptedManagedServer', {
      configurable: true,
      get: () => true,
    });
    api.processManager.revalidateAdoptedManagedServer = vi.fn(() => revalidation.promise);
    api.processManager.disposeProcess = disposeProcess;
    api.startOperation = startOperation;

    api.updateEventStreamState('degraded');
    const disposal = server.dispose();
    revalidation.resolve(true);
    await disposal;
    await vi.runAllTimersAsync();

    expect(startOperation).not.toHaveBeenCalled();
    expect(disposeProcess).toHaveBeenCalledWith({ stopProcess: true });
    expect(server.status.state).toBe('stopped');
  });
});

describe('OpenCodeServer managed process lifecycle', () => {
  it('terminates the spawned child before rejecting a health-read failure', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server, false);
    api.readHealthInfo = vi
      .fn<() => Promise<{ healthy: boolean; version?: string }>>()
      .mockResolvedValueOnce({ healthy: false })
      .mockRejectedValueOnce(new Error('health read failed'));

    const startResult = expect(server.start()).rejects.toThrow('health read failed');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    await startResult;

    expect(children).toHaveLength(1);
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(
      (server as unknown as { processManager: { process: MockChildProcess | null } }).processManager
        .process
    ).toBeNull();
  });

  it('terminates the captured child before rejecting an asynchronous spawn error', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server, false);
    api.pollHealth = () => {};

    const startResult = expect(server.start()).rejects.toThrow('spawn EACCES');
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    children[0]!.emit('error', new Error('spawn EACCES'));
    await startResult;

    expect(server.status).toEqual({
      state: 'error',
      message: 'OpenCode server failed to spawn: spawn EACCES',
    });
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(
      (server as unknown as { processManager: { process: MockChildProcess | null } }).processManager
        .process
    ).toBeNull();
  });

  it('terminates the spawned child and rejects when ownership confirmation is false', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server, false);
    api.readHealthInfo = vi
      .fn<() => Promise<{ healthy: boolean; version?: string }>>()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValueOnce({
        healthy: true,
        version: MINIMUM_SUPPORTED_OPENCODE_VERSION,
      });
    const processManager = (
      server as unknown as {
        processManager: {
          confirmManagedServerOwnership: () => Promise<boolean>;
          process: MockChildProcess | null;
        };
      }
    ).processManager;
    processManager.confirmManagedServerOwnership = vi.fn().mockResolvedValue(false);

    const startResult = expect(server.start()).rejects.toThrow(
      'Could not confirm ownership of the OpenCode server started by Varro'
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    await startResult;

    expect(server.status).toEqual(
      expect.objectContaining({
        state: 'error',
        message: 'Could not confirm ownership of the OpenCode server started by Varro',
      })
    );
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(processManager.process).toBeNull();
  });

  it('cleans a tracked child from a failed startup before launching a retry', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    const previous = createMockChildProcess();
    const processManager = (
      server as unknown as {
        processManager: {
          process: MockChildProcess | null;
          managedProcess: boolean;
          stopServerForRestart: ReturnType<typeof vi.fn>;
        };
      }
    ).processManager;
    processManager.process = previous;
    processManager.managedProcess = true;
    processManager.stopServerForRestart = vi.fn(async () => {
      expect(processManager.process).toBe(previous);
      processManager.process = null;
      processManager.managedProcess = false;
    });

    await expect(server.start()).resolves.toBe(server.url);

    expect(processManager.stopServerForRestart).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    expect(processManager.stopServerForRestart.mock.invocationCallOrder[0]).toBeLessThan(
      spawnMock.mock.invocationCallOrder[0]!
    );
  });

  it('updates status and restarts when a managed child exits after startup', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    const transport = (
      server as unknown as {
        transport: {
          observeServerEvent(event: unknown): void;
          hasPendingAttentionRequests(): boolean;
        };
      }
    ).transport;

    await expect(server.start()).resolves.toBe(server.url);
    expect(children).toHaveLength(1);
    transport.observeServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-1', sessionID: 'session-1' },
    });
    expect(transport.hasPendingAttentionRequests()).toBe(true);

    children[0]!.emit('exit', 1, null);

    expect(server.status.state).toBe('stopped');
    expect(transport.hasPendingAttentionRequests()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(children).toHaveLength(2);
    expect(server.status.state).toBe('running');
  });

  it('aborts and drains requests before restarting after a managed child exits', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    const requestsSettled = deferred<void>();
    const transport = (
      server as unknown as {
        transport: {
          abortRequests(): void;
          waitForRequestsToSettle(): Promise<void>;
        };
      }
    ).transport;
    const abortRequests = vi.spyOn(transport, 'abortRequests');
    vi.spyOn(transport, 'waitForRequestsToSettle').mockReturnValue(requestsSettled.promise);

    await server.start();
    children[0]!.emit('exit', 1, null);

    expect(abortRequests).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    requestsSettled.resolve();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(children).toHaveLength(2);
  });

  it('isolates stale exit and error callbacks from a replacement child', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    const processManager = (
      server as unknown as { processManager: { process: MockChildProcess | null } }
    ).processManager;

    await server.start();
    const first = children[0]!;
    const staleExit = first.listeners('exit').at(-1) as (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => void;
    const staleError = first.listeners('error').at(-1) as (err: Error) => void;

    first.emit('exit', 1, null);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    const replacement = children[1]!;
    expect(processManager.process).toBe(replacement);
    const replacementExitListeners = replacement.listenerCount('exit');
    const replacementErrorListeners = replacement.listenerCount('error');

    staleExit(1, null);
    staleError(new Error('stale spawn error'));
    await flushMicrotasks();

    expect(processManager.process).toBe(replacement);
    expect(replacement.listenerCount('exit')).toBe(replacementExitListeners);
    expect(replacement.listenerCount('error')).toBe(replacementErrorListeners);
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
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
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

  it('keeps a live server running until restart preflight confirms it is idle', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      readHealthInfo: ReturnType<typeof vi.fn>;
      hasActiveSessions: ReturnType<typeof vi.fn>;
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.18.8' });
    api.hasActiveSessions = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    api.start = start;
    api.processManager.stopServerForRestart = stopServerForRestart;

    await expect(server.restart()).rejects.toThrow('active sessions');
    expect(stopServerForRestart).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');

    await flushMicrotasks();
    await expect(server.restart()).resolves.toBe(server.url);
    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('explicitly restarts an unresponsive managed process', async () => {
    const server = new OpenCodeServer(4096, true);
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(server.url);
    const api = server as unknown as {
      managedProcess: boolean;
      readHealthInfo: ReturnType<typeof vi.fn>;
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.managedProcess = true;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.start = start;
    api.processManager.stopServerForRestart = stopServerForRestart;

    await expect(server.restart()).resolves.toBe(server.url);

    expect(stopServerForRestart).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('aborts and drains an in-flight start request before restart preflight', async () => {
    const server = new OpenCodeServer(4096, true);
    const requestStarted = deferred<void>();
    const requestCleanup = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      requestStarted.resolve();
      await new Promise<void>((resolve) => {
        requestSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await requestCleanup.promise;
      throw new Error('aborted');
    });
    const stopServerForRestart = vi.fn().mockResolvedValue(undefined);
    const restartStart = vi.fn().mockResolvedValue(server.url);
    const readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    const api = server as unknown as {
      setStartPromise: (factory: (signal: AbortSignal) => Promise<string>) => Promise<string>;
      readHealthInfo: typeof readHealthInfo;
      start: typeof restartStart;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    const pendingStart = api
      .setStartPromise(async (signal) => {
        await server.request('GET', '/session');
        if (signal.aborted) throw signal.reason;
        return server.url;
      })
      .catch((err: unknown) => err);
    await requestStarted.promise;
    api.readHealthInfo = readHealthInfo;
    api.start = restartStart;
    api.processManager.stopServerForRestart = stopServerForRestart;

    const restart = server.restart();
    await flushMicrotasks();

    expect(requestSignal?.aborted).toBe(true);
    expect(readHealthInfo).not.toHaveBeenCalled();

    requestCleanup.resolve();
    expect(await pendingStart).toEqual(expect.objectContaining({ message: 'aborted' }));
    await expect(restart).resolves.toBe(server.url);
    expect(readHealthInfo).toHaveBeenCalledOnce();
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
      readHealthInfo: ReturnType<typeof vi.fn>;
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
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
      readHealthInfo: ReturnType<typeof vi.fn>;
      start: typeof start;
      processManager: { stopServerForRestart: typeof stopServerForRestart };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
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
      readHealthInfo: ReturnType<typeof vi.fn>;
      start: typeof start;
      processManager: { stopServerForRestart: () => Promise<void> };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.processManager.stopServerForRestart = vi.fn(() => stopping.promise);

    const restart = server.restart();
    const firstStart = server.start();
    const secondStart = server.start();

    await flushMicrotasks();
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
      readHealthInfo: ReturnType<typeof vi.fn>;
      start: typeof start;
      processManager: { stopServerForRestart: () => Promise<void> };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.start = start;
    api.processManager.stopServerForRestart = vi.fn().mockRejectedValue(stopError);

    const restart = server.restart();

    await flushMicrotasks();
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

describe('OpenCodeServer startup recovery', () => {
  function getProcessManager(server: OpenCodeServer) {
    return (
      server as unknown as {
        processManager: {
          port: number;
          process: MockChildProcess | null;
          hasPortInUseDetected(): boolean;
        };
      }
    ).processManager;
  }

  /**
   * Drives a managed startup where the first attempt never reaches a healthy
   * server, so every exit falls into the recovery path. Later attempts resolve
   * unless `resolveAfterAttempt` is null.
   */
  function configureFailingStartup(
    server: OpenCodeServer,
    options: { resolveAfterAttempt: number | null }
  ) {
    const { api, children } = configureManagedStartup(server, false);
    let attempt = 0;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    api.pollHealth = (_startAttemptId, _disposeGeneration, resolve) => {
      attempt += 1;
      if (options.resolveAfterAttempt === null || attempt <= options.resolveAfterAttempt) return;
      setRunning(server);
      resolve(server.url);
    };
    return { api, children };
  }

  it('reports a missing CLI when the windows shim is absent', async () => {
    // On Windows the fallback is `opencode.cmd`, launched through cmd.exe: the
    // spawn succeeds and the shell reports the missing shim on stderr, so the
    // ENOENT-only branch never fires and the user used to get a generic error.
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: null });
    (getProcessManager(server) as unknown as { getInstallInfo: () => unknown }).getInstallInfo = vi
      .fn()
      .mockReturnValue({
        resolvedCommand: 'opencode.cmd',
        configuredCommand: '',
        configuredCommandMissing: false,
        found: false,
        installMethod: 'unknown',
        searchedPaths: ['C:\\Users\\me\\AppData\\Roaming\\npm'],
      });

    const startResult = server.start();
    await flushMicrotasks();

    const failure = expect(startResult).rejects.toThrow();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const child = children[children.length - 1];
      if (!child) break;
      crashDuringStartup(
        child,
        "'opencode.cmd' is not recognized as an internal or external command,\r\noperable program or batch file."
      );
      await settleRecovery();
      await vi.advanceTimersByTimeAsync(30_000);
    }

    await failure;
    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.state).toBe('error');
    expect(status.message).toContain('OpenCode CLI not found');
    expect(status.detail).toEqual(expect.objectContaining({ kind: 'cli-missing' }));
  });

  it('does not blame a missing CLI when the resolved binary exists', async () => {
    // "not recognized" does not name the command the shell could not find, so
    // a nested failure from a CLI that is present must stay a generic error.
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: null });
    (getProcessManager(server) as unknown as { getInstallInfo: () => unknown }).getInstallInfo = vi
      .fn()
      .mockReturnValue({
        resolvedCommand: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd',
        configuredCommand: '',
        configuredCommandMissing: false,
        found: true,
        installMethod: 'npm',
        searchedPaths: [],
      });

    const failure = expect(server.start()).rejects.toThrow();
    await flushMicrotasks();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const child = children[children.length - 1];
      if (!child) break;
      crashDuringStartup(child, "'git' is not recognized as an internal or external command");
      await settleRecovery();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await failure;

    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.message).not.toContain('OpenCode CLI not found');
    expect(status.detail?.kind).not.toBe('cli-missing');
  });

  it('does not blame a missing CLI for an ENOENT from a present CLI', async () => {
    // A resolved CLI that cannot open a config path prints ENOENT too. Showing
    // the install screen there hides the error the user actually needs.
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: null });
    (getProcessManager(server) as unknown as { getInstallInfo: () => unknown }).getInstallInfo = vi
      .fn()
      .mockReturnValue({
        resolvedCommand: '/Users/me/.bun/bin/opencode',
        configuredCommand: '',
        configuredCommandMissing: false,
        found: true,
        installMethod: 'bun',
        searchedPaths: [],
      });

    const failure = expect(server.start()).rejects.toThrow();
    await flushMicrotasks();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const child = children[children.length - 1];
      if (!child) break;
      crashDuringStartup(
        child,
        "ENOENT: no such file or directory, open '/Users/me/.config/opencode/opencode.json'"
      );
      await settleRecovery();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await failure;

    const status = server.status as Extract<ServerStatus, { state: 'error' }>;
    expect(status.message).toContain('opencode.json');
    expect(status.message).not.toContain('OpenCode CLI not found');
    expect(status.detail?.kind).not.toBe('cli-missing');
  });

  it('advances to the next port and retries quickly when the port is already in use', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: 1 });
    const processManager = getProcessManager(server);

    const startResult = server.start();
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    crashDuringStartup(children[0]!, 'Error: listen EADDRINUSE: address already in use :::4096');
    await settleRecovery();
    expect(processManager.hasPortInUseDetected()).toBe(false);
    expect(processManager.port).toBe(4097);

    await vi.advanceTimersByTimeAsync(100);
    await expect(startResult).resolves.toBe(server.url);
    expect(children).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Port 4096 in use by another process; retrying on 4097'
    );
  });

  it('keeps advancing ports while successive attempts hit a used port', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: 2 });
    const processManager = getProcessManager(server);

    const startResult = server.start();
    await flushMicrotasks();

    for (const expectedPort of [4097, 4098]) {
      crashDuringStartup(children[children.length - 1]!, 'listen EADDRINUSE :::4096');
      await settleRecovery();
      expect(processManager.port).toBe(expectedPort);
      await vi.advanceTimersByTimeAsync(100);
    }

    await expect(startResult).resolves.toBe(server.url);
    expect(children).toHaveLength(3);
  });

  it('fails actionably instead of attempting a port above 65535', async () => {
    const server = new OpenCodeServer(65_535, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: null });

    const startResult = server.start();
    await flushMicrotasks();
    crashDuringStartup(children[0]!, 'Error: listen EADDRINUSE: address already in use :::65535');
    await settleRecovery();

    await expect(startResult).rejects.toThrow(/varro\.server\.port.*1.*65535/i);
    expect(children).toHaveLength(1);
    expect(getProcessManager(server).port).toBe(65_535);
    expect(
      spawnMock.mock.calls.some(([, args]) => (args as string[] | undefined)?.includes('65536'))
    ).toBe(false);
  });

  it('retries on the same port with backoff when the crash is not a port conflict', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: 1 });
    const processManager = getProcessManager(server);

    const startResult = server.start();
    await flushMicrotasks();

    crashDuringStartup(children[0]!, 'fatal: could not parse config');
    await settleRecovery();
    expect(processManager.port).toBe(4096);

    // The port-conflict path retries after 100ms; a generic crash waits for backoff.
    await vi.advanceTimersByTimeAsync(99);
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(901);
    await expect(startResult).resolves.toBe(server.url);
    expect(children).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledWith('Retrying server startup in 1000ms (attempt 1)');
  });

  it('backs off exponentially and fails with the last stderr line once retries are exhausted', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: null });

    const startResult = server.start();
    await flushMicrotasks();

    for (const delay of [1_000, 2_000, 4_000]) {
      crashDuringStartup(children[children.length - 1]!, 'fatal: could not parse config');
      await settleRecovery();
      await vi.advanceTimersByTimeAsync(delay);
      await flushMicrotasks();
    }

    expect(children).toHaveLength(4);
    crashDuringStartup(children[3]!, 'fatal: missing provider credentials');

    await expect(startResult).rejects.toThrow(
      'OpenCode server exited during startup (code 1): fatal: missing provider credentials'
    );
    expect(server.status).toEqual({
      state: 'error',
      message:
        'OpenCode server exited during startup (code 1): fatal: missing provider credentials',
    });
    expect(children).toHaveLength(4);
  });

  it('reports the exit signal rather than a code when the child is signalled', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: null });

    const startResult = server.start();
    await flushMicrotasks();

    for (const delay of [1_000, 2_000, 4_000]) {
      children[children.length - 1]!.emit('exit', 1, null);
      await settleRecovery();
      await vi.advanceTimersByTimeAsync(delay);
      await flushMicrotasks();
    }

    children[3]!.emit('exit', null, 'SIGKILL');

    await expect(startResult).rejects.toThrow('OpenCode server exited during startup (SIGKILL)');
  });

  it('recovers without retrying when the server turns out to be healthy after the exit', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureFailingStartup(server, { resolveAfterAttempt: null });
    api.readHealthInfo = vi
      .fn()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValue({ healthy: true, version: MINIMUM_SUPPORTED_OPENCODE_VERSION });
    const processManager = getProcessManager(server);
    (
      processManager as unknown as { confirmManagedServerOwnership: () => Promise<boolean> }
    ).confirmManagedServerOwnership = vi.fn().mockResolvedValue(true);

    const startResult = server.start();
    await flushMicrotasks();

    children[0]!.emit('exit', 0, null);
    await settleRecovery();

    await expect(startResult).resolves.toBe(server.url);
    expect(children).toHaveLength(1);
    expect(server.status.state).toBe('running');
  });

  it('rejects an incompatible server that comes up during startup recovery', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureFailingStartup(server, { resolveAfterAttempt: null });
    api.readHealthInfo = vi
      .fn()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValue({ healthy: true, version: '0.0.1' });

    const startResult = server.start();
    await flushMicrotasks();

    children[0]!.emit('exit', 0, null);
    await settleRecovery();

    await expect(startResult).rejects.toThrow(/0\.0\.1/);
    expect(server.status.state).toBe('error');
    expect(children).toHaveLength(1);
  });
});
