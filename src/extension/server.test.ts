/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These server integration tests deliberately model malformed health data, partial child processes, and private lifecycle state. */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EventEmitter } from 'events';
import { stat } from 'fs/promises';
import type * as vscode from 'vscode';
import type * as FsModule from 'fs';
import type * as FsPromisesModule from 'fs/promises';
import type * as OsModule from 'os';
import { dirname, join } from 'path';
import { MINIMUM_SUPPORTED_OPENCODE_VERSION } from '../shared/opencode-compatibility';
import type { ServerStatus } from '../shared/protocol';
import type { ManagedServerOwnershipLease } from '../shared/server-ownership';

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
        showInputBox: vi.fn<(options: vscode.InputBoxOptions) => Promise<string | undefined>>(),
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
vi.mock('./server-connection-info', () => ({
  readLocalServerConnectionInfo: vi.fn(async () => ({
    startedAt: null,
    vscodeClients: null,
    otherClients: null,
  })),
}));
vi.mock('./util/windows-cli-update', () => ({ runWindowsCliUpdate: vi.fn() }));
vi.mock('vscode', () => vscodeMock);
vi.mock('@opencode/client/service', () => ({
  Service: { discover: vi.fn().mockResolvedValue(undefined) },
}));
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
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => {
      if (typeof args[0] === 'string' && args[0].startsWith('\\\\mac\\')) {
        return Promise.reject(new Error("UNC host 'mac' access is not allowed"));
      }
      return actual.stat(...args);
    }),
  };
});

import { OpenCodeServer as RealOpenCodeServer } from './server';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import { runWindowsCliUpdate } from './util/windows-cli-update';
import type { OpenCodeProcess } from './open-code-process';
import { inspectLocalServerAccount } from './process-inspection';
import {
  ManagedServerConnectionChangedError,
  ProcessInspectionTimeoutError,
  ServerNotListeningError,
} from './process-inspection-error';
import { readLocalServerConnectionInfo } from './server-connection-info';
import type { ServerConnectionAdmission } from './server-connection-admission';
import type * as ProcessInspection from './process-inspection';
import { getVarroStateDirectory } from './varro-state-paths';

vi.mock('./process-inspection', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessInspection>()),
  inspectLocalServerAccount: vi.fn(async () => ({
    kind: 'same-user',
    identity: 'fixture-listener',
  })),
}));

let serverOwnershipPathSequence = 0;
const fixtureServers: RealOpenCodeServer[] = [];
class OpenCodeServer extends RealOpenCodeServer {
  constructor(
    port: number | 'auto',
    autoStart: boolean,
    command?: string,
    simulateMissingCli = false,
    secrets?: vscode.SecretStorage,
    legacyDefaultEndpoint = false
  ) {
    super(
      port,
      autoStart,
      command,
      simulateMissingCli,
      join('/tmp', `varro-server-test-${process.pid}-${++serverOwnershipPathSequence}.json`),
      secrets,
      legacyDefaultEndpoint
    );
    // Filesystem coordination is exercised with real private files in process tests.
    const { processManager } = this as unknown as { processManager: OpenCodeProcess };
    vi.spyOn(processManager, 'refreshStartupRegistration').mockResolvedValue(false);
    vi.spyOn(processManager, 'acquireManagedServerLaunchClaim').mockResolvedValue(async () => {});
    fixtureServers.push(this);
  }
}

const MANIFEST_OPENCODE_VERSION = readMaximumTestedOpenCodeVersion();

function nextPatchVersion(version: string) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

async function flushMicrotasks() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

describe('OpenCodeServer port validation', () => {
  it.each([0, -1, 1.5, 65_536, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid runtime port %s',
    (port) => {
      expect(() => new OpenCodeServer(port, true)).toThrow('varro.server.port');
    }
  );
});

describe('startup wait bounds', () => {
  it('does not await a redundant managed-vault store after admission', async () => {
    vi.useFakeTimers();
    const secrets = {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
      onDidChange: vi.fn(() => ({ dispose() {} })),
    };
    const server = new OpenCodeServer(4096, true, '', false, secrets);
    const state = server as unknown as {
      admission: { admit(): Promise<void> };
      processManager: OpenCodeProcess;
      admitManagedServer(signal?: AbortSignal): Promise<void>;
    };
    const admitted = vi.spyOn(state.admission, 'admit').mockResolvedValue(undefined);
    const persistence = vi
      .spyOn(state.processManager, 'persistManagedServerCredentials')
      .mockImplementation(() => new Promise<void>(() => {}));
    try {
      await state.admitManagedServer();
      expect(admitted).toHaveBeenCalledOnce();
      expect(persistence).toHaveBeenCalledExactlyOnceWith(secrets);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('Managed credential persistence timed out')
      );
    } finally {
      await server.disconnect();
    }
  });

  it('bounds a never-settling health poll and forwards cancellation to its request', async () => {
    vi.useFakeTimers();
    const server = new OpenCodeServer(4096, false);
    const state = server as unknown as {
      startAttemptId: number;
      pollHealth(
        id: number,
        generation: number,
        resolve: (url: string) => void,
        reject: (error: Error) => void,
        attempt: number,
        signal: AbortSignal,
        read: (signal?: AbortSignal) => Promise<{ healthy: boolean }>
      ): void;
    };
    state.startAttemptId = 1;
    const controller = new AbortController();
    const read = vi.fn((_signal?: AbortSignal) => new Promise<{ healthy: boolean }>(() => {}));
    const resolved = vi.fn();
    const rejected = vi.fn();
    try {
      state.pollHealth(1, 0, resolved, rejected, 0, controller.signal, read);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]?.[0]?.aborted).toBe(true);
      expect(rejected).toHaveBeenCalledOnce();
      expect(rejected.mock.calls[0]?.[0].message).toContain('Server health check timed out');
      expect(resolved).not.toHaveBeenCalled();
    } finally {
      await server.disconnect();
    }
  });
});

describe('managed runtime Ask recovery', () => {
  function fixture() {
    const server = new OpenCodeServer(4096, true);
    const state = server as unknown as {
      _status: ServerStatus;
      processManager: OpenCodeProcess;
      transport: { request: RealOpenCodeServer['request'] };
      readHealthInfo(): Promise<{ healthy: boolean; version?: string }>;
      startEventStream(): Promise<void>;
      disposeGeneration: number;
      runtimeAskRecoveryPending: boolean;
      restoreManagedRuntimeConfigAtStartup(
        generation: number,
        signal: AbortSignal
      ): Promise<string | undefined>;
      reconcileManagedAskAgent(): Promise<void>;
      runRestart(stop: () => Promise<void>): Promise<string>;
      launchManagedServer(
        generation: number,
        preserveRetryCount: boolean,
        signal: AbortSignal
      ): Promise<string>;
      handleServerEvent(event: unknown): void;
      requestMaintenanceCheck(force?: boolean): void;
    };
    state._status = { state: 'running', url: server.url };
    state.processManager.managedProcess = true;
    vi.spyOn(state, 'readHealthInfo').mockResolvedValue({ healthy: true, version: '2.0.21' });
    const needed = vi
      .spyOn(state.processManager, 'needsRuntimeConfigRecovery', 'get')
      .mockReturnValue(true);
    vi.spyOn(state.processManager, 'hasRuntimeConfigRecoveryCandidate', 'get').mockImplementation(
      () => state.processManager.needsRuntimeConfigRecovery
    );
    const inject = vi
      .spyOn(state.processManager, 'shouldRestoreRuntimeAskAgent')
      .mockResolvedValue(true);
    vi.spyOn(state.processManager, 'prepareForHealthyExistingServer').mockResolvedValue(undefined);
    vi.spyOn(state.processManager, 'requestMaintenanceCheck').mockImplementation(() => {});
    const wire = vi
      .spyOn(state.transport, 'request')
      .mockResolvedValue([{ name: 'build' }, { name: 'plan' }]);
    const idle = vi
      .spyOn(server, 'readRestartBlockers')
      .mockResolvedValue({ totalSessionCount: 0, directories: [] });
    const ownership = vi
      .spyOn(state.processManager, 'refreshManagedServerOwnership')
      .mockResolvedValue(true);
    const release = vi.fn(async () => {});
    const claim = vi
      .spyOn(state.processManager, 'acquireManagedServerRestartOwnership')
      .mockResolvedValue(release);
    const stop = vi
      .spyOn(state.processManager, 'stopServerForRestart')
      .mockResolvedValue(undefined);
    const launch = vi.spyOn(state, 'launchManagedServer').mockResolvedValue(server.url);
    const restart = vi.spyOn(state, 'runRestart').mockImplementation(async (stopServer) => {
      await stopServer();
      needed.mockReturnValue(false);
      wire.mockResolvedValue([{ name: 'build' }, { name: 'plan' }, { name: 'ask' }]);
      return server.url;
    });
    return {
      server,
      state,
      needed,
      inject,
      wire,
      idle,
      ownership,
      release,
      claim,
      stop,
      launch,
      restart,
    };
  }

  it('relaunches a recovered replacement with runtime config before publishing startup catalogs', async () => {
    const { state, idle, claim, stop, launch, release, restart } = fixture();
    const signal = new AbortController().signal;
    await expect(
      state.restoreManagedRuntimeConfigAtStartup(state.disposeGeneration, signal)
    ).resolves.toBe('http://127.0.0.1:4096');
    expect(idle).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(state.disposeGeneration, false, signal);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[0]!);
    expect(restart).not.toHaveBeenCalled();
  });

  it.each([
    'busy',
    'busy-after-claim',
    'configured',
    'ask-present',
    'healthy-runtime',
    'external',
    'cancelled',
  ])('does not replace the startup server for %s', async (scenario) => {
    const { state, server, idle, inject, needed, wire, stop, launch } = fixture();
    const controller = new AbortController();
    if (scenario === 'busy') idle.mockResolvedValue({ totalSessionCount: 1, directories: [] });
    if (scenario === 'busy-after-claim')
      idle
        .mockResolvedValueOnce({ totalSessionCount: 0, directories: [] })
        .mockResolvedValue({ totalSessionCount: 1, directories: [] });
    if (scenario === 'configured') inject.mockResolvedValue(false);
    if (scenario === 'ask-present') wire.mockResolvedValue([{ name: 'Ask' }]);
    if (scenario === 'healthy-runtime') needed.mockReturnValue(false);
    if (scenario === 'external') vi.spyOn(server, 'isAttachOnly', 'get').mockReturnValue(true);
    if (scenario === 'cancelled') controller.abort(new Error('Cancelled'));
    const result = state.restoreManagedRuntimeConfigAtStartup(
      state.disposeGeneration,
      controller.signal
    );
    if (scenario === 'cancelled') await expect(result).rejects.toThrow('Cancelled');
    else await expect(result).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns the real repaired Ask agent from catalog reads', async () => {
    const { server, wire, restart, stop } = fixture();
    await expect(server.request('GET', '/agent')).resolves.toContainEqual({ name: 'ask' });
    expect(restart).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(wire).toHaveBeenLastCalledWith('GET', '/agent', undefined, undefined);
  });

  it('lets a send continue after stalled Ask preparation without a late restart', async () => {
    const { server, wire, idle, restart, stop } = fixture();
    const blockers = deferred<{ totalSessionCount: number; directories: [] }>();
    idle.mockReturnValue(blockers.promise);
    let sent = false;
    const request = server
      .request('POST', '/session/ses_fixture/prompt_async', { parts: [] })
      .then(() => {
        sent = true;
      });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toBe(true);
    await request;
    blockers.resolve({ totalSessionCount: 0, directories: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(wire).toHaveBeenLastCalledWith(
      'POST',
      '/session/ses_fixture/prompt_async',
      { parts: [] },
      undefined
    );
  });

  it('repairs a registered replacement through the actual startup branch before starting SSE', async () => {
    const { server, state, launch, stop } = fixture();
    state._status = { state: 'stopped' };
    vi.mocked(state.processManager.refreshStartupRegistration).mockResolvedValue(true);
    const stream = vi.spyOn(state, 'startEventStream').mockResolvedValue(undefined);
    await expect(server.start()).resolves.toBe(server.url);
    expect(stop).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['idle', 'new-work'])(
    'uses the real restart safety preflight for %s',
    async (scenario) => {
      const { server, state, idle, restart, claim, stop } = fixture();
      restart.mockRestore();
      const start = vi.spyOn(server, 'start').mockResolvedValue(server.url);
      if (scenario === 'new-work')
        idle
          .mockResolvedValueOnce({ totalSessionCount: 0, directories: [] })
          .mockResolvedValue({ totalSessionCount: 1, directories: [] });
      const result = state.reconcileManagedAskAgent();
      if (scenario === 'new-work') {
        await expect(result).rejects.toThrow('active sessions');
        expect(claim).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
      } else {
        await result;
        expect(idle).toHaveBeenCalledTimes(2);
        expect(claim).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
      }
    }
  );

  it('shares concurrent repairs and retries after an idle event', async () => {
    const { state, idle, restart } = fixture();
    idle.mockResolvedValue({ totalSessionCount: 1, directories: [] });
    await Promise.all([state.reconcileManagedAskAgent(), state.reconcileManagedAskAgent()]);
    expect(restart).not.toHaveBeenCalled();
    expect(state.runtimeAskRecoveryPending).toBe(true);
    const maintenance = vi.spyOn(state, 'requestMaintenanceCheck');
    state.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_fixture', status: { type: 'idle' } },
    });
    expect(maintenance).toHaveBeenCalledWith(true);
    idle.mockResolvedValue({ totalSessionCount: 0, directories: [] });
    await Promise.all([state.reconcileManagedAskAgent(), state.reconcileManagedAskAgent()]);
    expect(restart).toHaveBeenCalledOnce();
    expect(state.runtimeAskRecoveryPending).toBe(false);
  });

  it.each(['ownership-lost', 'generation-lost', 'malformed-catalog', 'read-failed'])(
    'keeps the running server untouched for %s',
    async (scenario) => {
      const { state, wire, ownership, restart, stop } = fixture();
      if (scenario === 'ownership-lost') ownership.mockResolvedValue(false);
      if (scenario === 'generation-lost')
        wire.mockImplementation(async () => {
          state.disposeGeneration += 1;
          return [{ name: 'build' }];
        });
      if (scenario === 'malformed-catalog') wire.mockResolvedValue({});
      if (scenario === 'read-failed') wire.mockRejectedValue(new Error('Catalog unavailable'));
      const result = state.reconcileManagedAskAgent();
      if (scenario === 'malformed-catalog')
        await expect(result).rejects.toThrow('invalid agent catalog');
      else if (scenario === 'read-failed')
        await expect(result).rejects.toThrow('Catalog unavailable');
      else await result;
      expect(restart).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    }
  );
});

describe('reused managed stream timeout', () => {
  function fixture() {
    const server = new OpenCodeServer(4096, true);
    const state = server as unknown as {
      _status: ServerStatus;
      processManager: OpenCodeProcess;
      transport: { version: number; request: RealOpenCodeServer['request'] };
      preserveExistingProcess: boolean;
      reconcileManagedStreamTimeout(): Promise<void>;
      disposeGeneration: number;
      readHealthInfo(): Promise<{ healthy: boolean; version?: string }>;
    };
    state._status = { state: 'running', url: server.url };
    state.preserveExistingProcess = true;
    state.processManager.managedProcess = true;
    vi.spyOn(state.transport, 'version', 'get').mockReturnValue(2);
    vi.spyOn(state, 'readHealthInfo').mockResolvedValue({ healthy: true, version: '2.0.20' });
    const wire = vi
      .spyOn(state.transport, 'request')
      .mockResolvedValue({ data: { settings: { transport: 'websocket' } } });
    const reconcile = vi
      .spyOn(state.processManager, 'reconcileInjectedStreamTimeout')
      .mockResolvedValue(true);
    vi.spyOn(state.processManager, 'refreshManagedServerOwnership').mockResolvedValue(true);
    const idle = vi
      .spyOn(server, 'readRestartBlockers')
      .mockResolvedValue({ totalSessionCount: 0, directories: [] });
    return { server, state, wire, reconcile, idle };
  }

  it('reloads a reused server only after two globally idle checks, without restarting', async () => {
    const { server, state, wire, reconcile, idle } = fixture();
    const restart = vi.spyOn(server, 'restart');
    await state.reconcileManagedStreamTimeout();
    expect(reconcile).toHaveBeenCalledWith('2.0.20');
    expect(idle).toHaveBeenCalledTimes(2);
    expect(wire).toHaveBeenLastCalledWith('POST', '/global/dispose');
    expect(restart).not.toHaveBeenCalled();
  });

  it.each([
    'busy-before',
    'busy-after',
    'explicit-timeout',
    'ownership-lost',
    'generation-lost',
    'unmanaged',
    'old-version',
  ])('does not reload for %s', async (scenario) => {
    const { state, wire, reconcile, idle } = fixture();
    if (scenario === 'busy-before')
      idle.mockResolvedValue({ totalSessionCount: 1, directories: [] });
    if (scenario === 'busy-after')
      idle
        .mockResolvedValueOnce({ totalSessionCount: 0, directories: [] })
        .mockResolvedValue({ totalSessionCount: 1, directories: [] });
    if (scenario === 'explicit-timeout')
      wire.mockResolvedValue({ data: { settings: { timeout: false } } });
    if (scenario === 'ownership-lost')
      vi.mocked(state.processManager.refreshManagedServerOwnership).mockResolvedValue(false);
    if (scenario === 'generation-lost')
      reconcile.mockImplementation(async () => {
        state.disposeGeneration += 1;
        return true;
      });
    if (scenario === 'unmanaged') state.processManager.managedProcess = false;
    if (scenario === 'old-version')
      vi.mocked(state.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.19' });
    await state.reconcileManagedStreamTimeout();
    expect(wire.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    if (['busy-before', 'explicit-timeout', 'unmanaged', 'old-version'].includes(scenario))
      expect(reconcile).not.toHaveBeenCalled();
  });

  it('retries failed reloads without restarting or abandoning the protection', async () => {
    const { state, wire } = fixture();
    wire.mockImplementation(async (method) => {
      if (method === 'POST') throw new Error('Reload unavailable');
      return { data: { settings: {} } };
    });
    await expect(state.reconcileManagedStreamTimeout()).rejects.toThrow('Reload unavailable');
    wire.mockResolvedValue({ data: { settings: {} } });
    await state.reconcileManagedStreamTimeout();
    expect(wire).toHaveBeenLastCalledWith('POST', '/global/dispose');
  });

  it('applies protection before the first send on a reused connection', async () => {
    const { server, wire } = fixture();
    await server.request('POST', '/session/ses_fixture/prompt_async', { parts: [] });
    expect(wire.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path)).toEqual(
      ['/global/dispose', '/session/ses_fixture/prompt_async']
    );
  });

  it('does not hold a send behind stalled optional maintenance or reload after its deadline', async () => {
    vi.useFakeTimers();
    const { server, wire, reconcile, idle } = fixture();
    const blockers = deferred<{ totalSessionCount: number; directories: [] }>();
    idle.mockReturnValue(blockers.promise);
    let sent = false;
    const request = server
      .request('POST', '/session/ses_fixture/prompt_async', { parts: [] })
      .then(() => {
        sent = true;
      });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toBe(true);
    await request;
    expect(reconcile).not.toHaveBeenCalled();
    blockers.resolve({ totalSessionCount: 0, directories: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).not.toHaveBeenCalled();
    expect(wire.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path)).toEqual(
      ['/session/ses_fixture/prompt_async']
    );
  });

  it('waits for an owned timeout-policy write before dispatching a send', async () => {
    const { server, wire, reconcile } = fixture();
    const write = deferred<boolean>();
    reconcile.mockReturnValue(write.promise);
    const request = server.request('POST', '/session/ses_fixture/prompt_async', { parts: [] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(wire.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    write.resolve(true);
    await request;
    expect(wire.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path)).toEqual(
      ['/global/dispose', '/session/ses_fixture/prompt_async']
    );
  });
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
  void (server as unknown as { admission: ServerConnectionAdmission }).admission
    .admit()
    .catch(() => {
      // Lifecycle tests deliberately dispose immediately after publishing a fake running state.
    });
  (
    server as unknown as {
      setRunningStatus: (url?: string, eventStream?: 'healthy' | 'degraded') => void;
    }
  ).setRunningStatus(server.url, 'healthy');
  if (!options?.keepMaintenance) {
    (server as unknown as { stopMaintenanceLoop: () => void }).stopMaintenanceLoop();
  }
}

async function startEventStream(server: OpenCodeServer) {
  await (server as unknown as { admission: ServerConnectionAdmission }).admission.admit();
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
 * Stubs the CLI spawn used by `upgrade`/`update` and `--version`. `version` is what
 * `--version` prints, which is what the upgrade verification reads back: a stub
 * that prints nothing models a CLI that exited 0 without actually updating.
 */
function stubCliSpawn(options: { version?: string; stderr?: string } = {}) {
  spawnMock.mockImplementation((_command, args: string[]) => {
    let closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
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
      once: vi.fn((event: string, listener: typeof closeHandler) => {
        if (event === 'close') {
          closeHandler = listener;
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
      if (options.stderr && args?.some((arg) => arg === 'upgrade' || arg === 'update')) {
        stderrHandler?.(Buffer.from(options.stderr));
      }
      closeHandler?.(0, null);
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
  vi.mocked(inspectLocalServerAccount).mockResolvedValue({
    kind: 'same-user',
    identity: 'fixture-listener',
  });
  vscodeMock.window.showWarningMessage.mockReset().mockResolvedValue(undefined);
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
  // Do not let draining fake timers start a previous fixture's maintenance
  // and CLI probes under the next test's spawn mock.
  for (const server of fixtureServers.splice(0)) {
    (server as unknown as { stopMaintenanceLoop(): void }).stopMaintenanceLoop();
  }
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

describe('automatic-port migration and admission', () => {
  it('reuses a registered Varro server quietly when Windows account inspection is unavailable', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.24' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({ kind: 'unknown' });
    const verify = vi.spyOn(processManager, 'verifyManagedServerAdmission').mockResolvedValue(true);
    const prepare = vi
      .spyOn(processManager, 'prepareForHealthyExistingServer')
      .mockResolvedValue(undefined);
    await expect(server.start()).resolves.toBe(server.url);
    await flushMicrotasks();
    expect(verify).toHaveBeenCalledOnce();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(server.isAttachOnly).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(children).toHaveLength(0);
    expect(server.status.state).toBe('running');
    await server.disconnect();
  });

  it('quietly admits a newly confirmed Varro launch with unavailable account evidence', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer('auto', true);
    const state = server as unknown as {
      processManager: OpenCodeProcess;
      admitManagedServer(): Promise<void>;
      registeredEndpoint: boolean;
    };
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({ kind: 'unknown' });
    vi.spyOn(state.processManager, 'verifyManagedServerAdmission').mockResolvedValue(true);
    await state.admitManagedServer();
    expect(state.registeredEndpoint).toBe(true);
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(server.isAttachOnly).toBe(false);
    await server.disconnect();
  });

  it('keeps credential-only reconnection quiet but attach-only, without background ownership repair', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.24' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({ kind: 'unknown' });
    vi.spyOn(processManager, 'hasCredentialVerifiedConnection', 'get').mockReturnValue(true);
    vi.spyOn(processManager, 'verifyManagedServerAdmission').mockResolvedValue(true);
    const prepare = vi.spyOn(processManager, 'prepareForHealthyExistingServer');
    await expect(server.start()).resolves.toBe(server.url);
    await flushMicrotasks();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(server.isAttachOnly).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
    await expect(server.restart()).rejects.toThrow('attach-only');
    await server.disconnect();
  });

  it('keeps a late recovered registration managed after shared-service admission', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const state = server as unknown as {
      processManager: OpenCodeProcess;
      registeredEndpoint: boolean;
      externalEndpoint: boolean;
    };
    vi.spyOn(state.processManager, 'discoverSharedServer').mockReturnValue(Promise.resolve(true));
    vi.spyOn(state.processManager, 'refreshDiscoveredServerRegistration').mockResolvedValue(false);
    vi.spyOn(state.processManager, 'verifyManagedServerAdmission').mockResolvedValue(true);
    vi.spyOn(state.processManager, 'prepareForHealthyExistingServer').mockResolvedValue(undefined);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.24' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({ kind: 'unknown' });
    await expect(server.start()).resolves.toBe(server.url);
    await flushMicrotasks();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(state.registeredEndpoint).toBe(true);
    expect(state.externalEndpoint).toBe(false);
    expect(server.isAttachOnly).toBe(false);
    expect(children).toHaveLength(0);
    await server.disconnect();
  });

  it('blocks HTTP and SSE until quiet managed verification succeeds', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.24' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({ kind: 'unknown' });
    const pending = deferred<boolean>();
    const verify = vi
      .spyOn(processManager, 'verifyManagedServerAdmission')
      .mockReturnValue(pending.promise);
    const start = expect(server.start()).rejects.toThrow('registration changed');
    await flushMicrotasks();
    expect(verify).toHaveBeenCalledOnce();
    const request = expect(server.request('GET', '/config')).rejects.toThrow(
      'registration changed'
    );
    await flushMicrotasks();
    expect(fetch).not.toHaveBeenCalled();
    expect(api.startEventStream).not.toHaveBeenCalled();
    pending.reject(new ManagedServerConnectionChangedError('registration changed'));
    await Promise.all([start, request]);
    expect(fetch).not.toHaveBeenCalled();
    expect(api.startEventStream).not.toHaveBeenCalled();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    await server.disconnect();
  });

  it('runs ownership and account checks together but sends no HTTP until both succeed', async () => {
    const server = new OpenCodeServer(4096, false);
    const api = server as unknown as {
      processManager: OpenCodeProcess;
      admission: ServerConnectionAdmission;
    };
    const ownership = deferred<void>();
    const account = deferred<void>();
    const verifyOwnership = vi
      .spyOn(api.processManager, 'verifyManagedServerConnection')
      .mockReturnValue(ownership.promise);
    const verifyAccount = vi.spyOn(api.admission, 'verify').mockReturnValue(account.promise);
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    const request = server.request('GET', '/config');
    await flushMicrotasks();
    expect(verifyOwnership).toHaveBeenCalledOnce();
    expect(verifyAccount).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    ownership.resolve();
    await flushMicrotasks();
    expect(fetch).not.toHaveBeenCalled();
    account.resolve();
    await request;
    expect(fetch).toHaveBeenCalled();
    await server.disconnect();
  });

  it.each(['ownership', 'account'] as const)(
    'sends no HTTP if the %s check fails',
    async (failedCheck) => {
      const server = new OpenCodeServer(4096, false);
      const api = server as unknown as {
        processManager: OpenCodeProcess;
        admission: ServerConnectionAdmission;
      };
      const verifyOwnership = vi
        .spyOn(api.processManager, 'verifyManagedServerConnection')
        .mockResolvedValue();
      const verifyAccount = vi.spyOn(api.admission, 'verify').mockResolvedValue();
      (failedCheck === 'ownership' ? verifyOwnership : verifyAccount).mockRejectedValue(
        new Error('verification failed')
      );
      await expect(server.request('GET', '/config')).rejects.toThrow('verification failed');
      expect(fetch).not.toHaveBeenCalled();
      await server.disconnect();
    }
  );

  it.each(['ownership', 'account'] as const)(
    'keeps the running view and stream when the %s inspection times out, but blocks HTTP',
    async (failedCheck) => {
      const server = new OpenCodeServer(4096, false);
      const api = server as unknown as {
        processManager: OpenCodeProcess;
        admission: ServerConnectionAdmission;
        stopEventStream(): void;
      };
      setRunning(server);
      await flushMicrotasks();
      const stopStream = vi.spyOn(api, 'stopEventStream');
      const verifyOwnership = vi
        .spyOn(api.processManager, 'verifyManagedServerConnection')
        .mockResolvedValue();
      const verifyAccount = vi.spyOn(api.admission, 'verify').mockResolvedValue();
      (failedCheck === 'ownership' ? verifyOwnership : verifyAccount).mockRejectedValueOnce(
        new ProcessInspectionTimeoutError('lsof timed out after 5000ms')
      );
      await expect(server.request('GET', '/config')).rejects.toThrow('lsof timed out');
      expect(fetch).not.toHaveBeenCalled();
      expect(stopStream).not.toHaveBeenCalled();
      expect(server.status.state).toBe('running');
      expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
      vi.mocked(fetch).mockResolvedValue(new Response('{}'));
      await server.request('GET', '/config');
      expect(fetch).toHaveBeenCalledOnce();
      expect(server.status.state).toBe('running');
      await server.disconnect();
    }
  );

  it.each(['current-host', 'other-host'] as const)(
    'recovers a Varro-registered shared service as %s rather than attach-only',
    async (ownership) => {
      const server = new OpenCodeServer('auto', true);
      const { api, children } = configureManagedStartup(server);
      const { processManager } = server as unknown as { processManager: OpenCodeProcess };
      vi.mocked(api.readInstalledCliVersion).mockResolvedValue('2.0.20');
      vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.20' });
      vi.spyOn(processManager, 'discoverSharedServer').mockImplementation(() => {
        processManager.port = 49374;
        return Promise.resolve(true);
      });
      const registration = vi
        .spyOn(processManager, 'refreshDiscoveredServerRegistration')
        .mockResolvedValue(true);
      const privateManager = processManager as unknown as {
        hasOwnershipLeaseCandidate: boolean;
        foreignActiveOwnership: boolean;
        adoptManagedServerOwnership: (lease: ManagedServerOwnershipLease) => void;
        observeForeignManagedServer: (lease: ManagedServerOwnershipLease) => void;
      };
      Object.defineProperty(privateManager, 'hasOwnershipLeaseCandidate', {
        configurable: true,
        value: true,
      });
      const recovery = vi
        .spyOn(processManager, 'recoverManagedServerOwnership')
        .mockImplementation(async () => {
          const lease: ManagedServerOwnershipLease = {
            version: 1,
            pid: 1_073_000_000 + process.pid,
            port: 49374,
            executable: '/fixture/opencode',
            birthIdentity: 'fixture-birth',
            owner: 'fixture-owner',
            host: 'another-editor',
            state: 'active',
            createdAt: Date.now(),
          };
          if (ownership === 'current-host') privateManager.adoptManagedServerOwnership(lease);
          else {
            privateManager.observeForeignManagedServer(lease);
            privateManager.foreignActiveOwnership = true;
          }
          return ownership === 'current-host';
        });
      vi.spyOn(processManager, 'prepareForHealthyExistingServer').mockResolvedValue(undefined);
      vi.spyOn(
        server as unknown as { readActiveAgentCount: () => Promise<number> },
        'readActiveAgentCount'
      ).mockResolvedValue(2);
      await expect(server.start()).resolves.toBe('http://127.0.0.1:49374');
      const info = await server.readServerInfo();
      expect(registration).toHaveBeenCalledOnce();
      expect(recovery).toHaveBeenCalledOnce();
      expect(info.ownership).toBe(ownership);
      expect(info.activeAgentCount).toBe(2);
      expect(server.isAttachOnly).toBe(false);
      expect(children).toHaveLength(0);
      await server.disconnect();
    }
  );

  it('keeps an unregistered shared service external without claiming it', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(api.readInstalledCliVersion).mockResolvedValue('2.0.20');
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.20' });
    vi.spyOn(processManager, 'discoverSharedServer').mockResolvedValue(true);
    vi.spyOn(processManager, 'refreshDiscoveredServerRegistration').mockResolvedValue(false);
    const recovery = vi.spyOn(processManager, 'recoverManagedServerOwnership');
    const prepare = vi.spyOn(processManager, 'prepareForHealthyExistingServer');
    await server.start();
    expect(server.isAttachOnly).toBe(true);
    expect(recovery).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
    await server.disconnect();
  });

  it('waits for ownership preparation before reporting diagnostics, without blocking startup', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.20' });
    const preparation = deferred<void>();
    vi.spyOn(processManager, 'prepareForHealthyExistingServer').mockImplementation(
      () => preparation.promise
    );
    await expect(server.start()).resolves.toBe(server.url);
    let reported = false;
    const info = server.readServerInfo().then((value) => {
      reported = true;
      return value;
    });
    await flushMicrotasks();
    expect(reported).toBe(false);
    preparation.resolve();
    await info;
    expect(reported).toBe(true);
    await server.disconnect();
  });

  it('retries a temporary ownership inspection failure during the same startup', async () => {
    const server = new OpenCodeServer(4097, true);
    const { api } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.34' });
    vi.spyOn(processManager, 'hasOwnershipLeaseCandidate', 'get').mockReturnValue(true);
    const recover = vi
      .spyOn(processManager, 'recoverManagedServerOwnership')
      .mockRejectedValue(new Error('Cannot verify process start identity'));
    const prepare = vi
      .spyOn(processManager, 'prepareForHealthyExistingServer')
      .mockImplementation(async () => {
        (processManager as unknown as { _managedProcess: boolean })._managedProcess = true;
      });
    await expect(server.start()).resolves.toBe(server.url);
    const info = await server.readServerInfo();
    expect(recover).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(info.ownership).toBe('current-host');
    expect(server.isAttachOnly).toBe(false);
    await server.disconnect();
  });

  it('waits for inherited ownership preparation before an explicit restart', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.33' });
    const preparation = deferred<void>();
    vi.spyOn(processManager, 'prepareForHealthyExistingServer').mockImplementation(
      () => preparation.promise
    );
    const stop = vi.spyOn(processManager, 'stopServerForRestart').mockResolvedValue(undefined);
    await server.start();
    const start = vi.spyOn(server, 'start').mockResolvedValue(server.url);
    const restart = server.restart({ force: true });
    await flushMicrotasks();
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    preparation.resolve();
    await expect(restart).resolves.toBe(server.url);
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    await server.disconnect();
  });

  it('waits for pending ownership recovery before rejecting an attach-only restart', async () => {
    const server = new OpenCodeServer(4097, true);
    const { api } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.34' });
    const preparation = deferred<void>();
    vi.spyOn(processManager, 'prepareForHealthyExistingServer').mockImplementation(async () => {
      await preparation.promise;
      vi.spyOn(processManager, 'managedProcess', 'get').mockReturnValue(true);
    });
    const stop = vi.spyOn(processManager, 'stopServerForRestart').mockResolvedValue(undefined);
    await server.start();
    // A launch-setting update can make attachment look external during handoff.
    server.updateLaunchSettings({ autoStart: false, command: '' });
    expect(server.isAttachOnly).toBe(true);
    const start = vi.spyOn(server, 'start').mockResolvedValue(server.url);
    const restart = server.restart({ force: true });
    await flushMicrotasks();
    expect(stop).not.toHaveBeenCalled();
    preparation.resolve();
    await expect(restart).resolves.toBe(server.url);
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    await server.disconnect();
  });

  it('does not grant lifecycle rights to a verified same-user manual server', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api } = configureManagedStartup(server);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.33' });
    await server.start();
    expect(server.isAttachOnly).toBe(true);
    await expect(server.restart({ force: true })).rejects.toThrow(
      'Varro has not established ownership of this server'
    );
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    await server.disconnect();
  });

  it('leaves an unsupported registered server running without applying an update', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.15.13' });
    const upgrade = vi.spyOn(processManager, 'upgradeCli');
    await expect(server.start()).rejects.toThrow('left running');
    expect(upgrade).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });

  it('does not probe or adopt the old default endpoint on a fresh automatic launch', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const url = await server.start();
    expect(url).toBe(server.url);
    expect(api.readHealthInfo).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    expect(new URL(server.url).port).not.toBe('4096');
    await server.disconnect();
  });

  it('leaves a reused registered server untouched when ownership cannot be verified', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.spyOn(processManager, 'prepareForHealthyExistingServer').mockResolvedValue(undefined);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.33' });
    await expect(server.start()).resolves.toBe(server.url);
    await runMaintenanceTick(server);
    expect(children).toHaveLength(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(api.readInstalledCliVersion).not.toHaveBeenCalled();
    await server.disconnect();
  });

  it.each([
    { platform: 'win32', serverVersion: '1.17.13', cliVersion: '1.18.34' },
    { platform: 'linux', serverVersion: '2.0.20', cliVersion: '2.0.22' },
  ] as const)(
    'restarts a reused owned server from $serverVersion to $cliVersion on $platform',
    async ({ platform, serverVersion, cliVersion }) => {
      stubPlatform(platform);
      const server = new OpenCodeServer('auto', true);
      const { api, children } = configureManagedStartup(server);
      const state = server as unknown as {
        processManager: OpenCodeProcess;
        hasActiveSessions(): Promise<boolean>;
        maybeSuggestCliUpdate(version: string | null): Promise<string | null>;
        restartServerForCliUpdate(serverVersion: string, cliVersion: string): Promise<void>;
      };
      vi.mocked(state.processManager.refreshStartupRegistration).mockResolvedValue(true);
      vi.spyOn(state.processManager, 'prepareForHealthyExistingServer').mockResolvedValue(
        undefined
      );
      const ownership = vi
        .spyOn(state.processManager, 'refreshManagedServerOwnership')
        .mockImplementation(async () => {
          state.processManager.managedProcess = true;
          return true;
        });
      vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: serverVersion });
      vi.mocked(api.readInstalledCliVersion).mockResolvedValue(cliVersion);
      const active = vi.spyOn(state, 'hasActiveSessions').mockResolvedValue(false);
      const update = vi.spyOn(state, 'maybeSuggestCliUpdate').mockResolvedValue(null);
      const restart = vi.spyOn(state, 'restartServerForCliUpdate').mockResolvedValue(undefined);

      await server.start();
      await runMaintenanceTick(server);

      expect(ownership).toHaveBeenCalledOnce();
      expect(active).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledExactlyOnceWith(serverVersion, cliVersion);
      // The verified owner checks for a same-family install before restarting.
      expect(update).toHaveBeenCalledExactlyOnceWith(cliVersion);
      expect(children).toHaveLength(0);
      await server.disconnect();
    }
  );

  it('does not replace a registered process when its health probe fails', async () => {
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration).mockResolvedValue(true);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: false });
    await expect(server.start()).rejects.toThrow('left untouched');
    expect(children).toHaveLength(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps business requests blocked while foreign-user consent is pending or dismissed', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.33' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({
      kind: 'different-user',
      identity: 'foreign',
    });
    const answer = deferred<string | undefined>();
    vscodeMock.window.showWarningMessage.mockImplementation(() => answer.promise);
    const start = expect(server.start()).rejects.toThrow('cancelled');
    await flushMicrotasks();
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledOnce();
    // Modal messages provide their own Cancel button when no close action is supplied.
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('The listening process belongs to another OS user.'),
      { modal: true },
      'Connect anyway'
    );
    const deletion = expect(server.request('DELETE', '/session/foreign')).rejects.toThrow(
      'cancelled'
    );
    await flushMicrotasks();
    expect(fetch).not.toHaveBeenCalled();
    expect(api.startEventStream).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
    answer.resolve(undefined);
    await Promise.all([start, deletion]);
    expect(fetch).not.toHaveBeenCalled();
    expect(server.status.state).toBe('error');
  });

  it('does not turn connection consent into lifecycle ownership', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api } = configureManagedStartup(server);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.33' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({
      kind: 'different-user',
      identity: 'foreign',
    });
    vscodeMock.window.showWarningMessage.mockResolvedValue('Connect anyway');
    await expect(server.start()).resolves.toBe(server.url);
    expect(server.isAttachOnly).toBe(true);
    await expect(server.restart({ force: true })).rejects.toThrow('attach-only');
    await runMaintenanceTick(server);
    expect(spawnMock).not.toHaveBeenCalled();
    await server.disconnect();
  });

  it('allows a migrated default-port user to choose a separate automatic server', async () => {
    const server = new OpenCodeServer('auto', true, '', false, undefined, true);
    const { api, children } = configureManagedStartup(server);
    vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '1.18.33' });
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({
      kind: 'different-user',
      identity: 'foreign',
    });
    vscodeMock.window.showWarningMessage.mockResolvedValue('Start my server on another port');
    const url = await server.start();
    expect(url).toBe(server.url);
    expect(children).toHaveLength(1);
    expect(new URL(server.url).port).not.toBe('4096');
    await server.disconnect();
  });
});

describe('established connection background monitoring', () => {
  async function fixture() {
    const server = new OpenCodeServer(4096, false);
    const account = {
      kind: 'same-user' as const,
      identity: `${process.pid}:fixture-birth:1000`,
      pid: process.pid,
      birthIdentity: 'fixture-birth',
    };
    const api = server as unknown as {
      processManager: OpenCodeProcess;
      startEventStream(): Promise<void>;
      stopEventStream(): void;
    };
    const identity = vi.spyOn(api.processManager, 'connectionIdentity', 'get').mockReturnValue({
      port: 4096,
      pid: account.pid,
      birthIdentity: account.birthIdentity,
      executable: '/fixture/opencode',
    });
    const verify = vi
      .spyOn(api.processManager, 'verifyManagedServerConnection')
      .mockResolvedValue();
    vi.mocked(inspectLocalServerAccount).mockResolvedValue(account);
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    setRunning(server);
    await flushMicrotasks();
    await server.request('GET', '/config');
    verify.mockClear();
    vi.mocked(inspectLocalServerAccount).mockClear();
    vi.mocked(fetch).mockClear();
    return { server, api, account, verify, identity };
  }

  it('does not inspect ownership on routine requests after the one-second ticket expires', async () => {
    const { server, verify } = await fixture();
    for (let index = 0; index < 10; index++) {
      await vi.advanceTimersByTimeAsync(1001);
      await server.request('GET', '/config');
    }
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(verify).not.toHaveBeenCalled();
    expect(inspectLocalServerAccount).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
    await server.disconnect();
  });

  it('keeps REST and the chat working through repeated background timeouts', async () => {
    const { server, api, verify } = await fixture();
    const stop = vi.spyOn(api, 'stopEventStream');
    vi.mocked(inspectLocalServerAccount).mockRejectedValue(
      new ProcessInspectionTimeoutError('lsof timed out')
    );
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await server.request('GET', '/config');
    }
    expect(inspectLocalServerAccount).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stop).not.toHaveBeenCalled();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
    await server.disconnect();
  });

  it('does not wait for a stalled background account check before sending requests', async () => {
    const { server, account } = await fixture();
    const pending = deferred<ProcessInspection.LocalServerAccount>();
    vi.mocked(inspectLocalServerAccount).mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    await server.request('GET', '/config');
    expect(fetch).toHaveBeenCalledOnce();
    expect(server.status.state).toBe('running');
    pending.resolve(account);
    await flushMicrotasks();
    await server.disconnect();
  });

  it('freshly verifies a changed process birth identity before resuming routine reuse', async () => {
    const { server, account, identity, verify } = await fixture();
    const replacement = {
      ...account,
      birthIdentity: 'replacement-birth',
      identity: `${account.pid}:replacement-birth:1000`,
    };
    vi.mocked(inspectLocalServerAccount).mockResolvedValue(replacement);
    await vi.advanceTimersByTimeAsync(30_000);
    identity.mockReturnValue({
      port: 4096,
      pid: replacement.pid,
      birthIdentity: replacement.birthIdentity,
      executable: '/fixture/opencode',
    });
    verify.mockClear();
    vi.mocked(inspectLocalServerAccount).mockClear();
    await server.request('GET', '/config');
    expect(verify).toHaveBeenCalledWith(true);
    expect(inspectLocalServerAccount).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1001);
    await server.request('GET', '/config');
    expect(verify).toHaveBeenCalledOnce();
    expect(inspectLocalServerAccount).toHaveBeenCalledOnce();
    expect(server.status.state).toBe('running');
    await server.disconnect();
  });

  it('always reinspects on SSE reconnect rather than transferring the established confirmation', async () => {
    const { server, api, verify } = await fixture();
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      createPendingEventResponse(init!.signal!)
    );
    const stream = api.startEventStream();
    await flushMicrotasks();
    expect(verify).toHaveBeenCalledWith(true);
    expect(inspectLocalServerAccount).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    api.stopEventStream();
    await stream;
    await server.disconnect();
  });

  it('cancels background monitoring on disconnect', async () => {
    const { server, verify } = await fixture();
    await server.disconnect();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(verify).not.toHaveBeenCalled();
    expect(inspectLocalServerAccount).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still admits private restart-preflight reads without opening public requests', async () => {
    const { server, verify } = await fixture();
    const state = server as unknown as {
      lifecycle: { beginManagedRestart(): number | null };
      connectionMonitor: { invalidate(): void };
      transport: { request: RealOpenCodeServer['request'] };
    };
    state.lifecycle.beginManagedRestart();
    state.connectionMonitor.invalidate();
    await expect(server.request('GET', '/config')).rejects.toThrow('while stopping');
    expect(fetch).not.toHaveBeenCalled();
    await state.transport.request('GET', '/config');
    expect(verify).toHaveBeenCalledWith(true);
    expect(fetch).toHaveBeenCalledOnce();
    await server.disconnect();
  });
});

describe('OpenCodeServer credential prompts', () => {
  function setup(stored?: string, autoStart = false) {
    const secrets = {
      get: vi.fn(async () => stored),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
      onDidChange: vi.fn(() => ({ dispose() {} })),
    };
    const server = new OpenCodeServer(4097, autoStart, '', false, secrets);
    const api = server as unknown as {
      beginRunningEventStream: () => void;
      startExistingServerPreparation: () => void;
      processManager: { discoverServerCredentials: () => Promise<void> };
    };
    api.beginRunningEventStream = vi.fn();
    api.startExistingServerPreparation = vi.fn();
    api.processManager.discoverServerCredentials = vi.fn(async () => {});
    vscodeMock.window.showInputBox.mockReset();
    const authorization = `Basic ${Buffer.from('fixture-user: password with spaces ').toString('base64')}`;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get('Authorization') !== authorization)
        return new Response(null, { status: 401 });
      return new URL(String(input)).pathname === '/api/info'
        ? new Response(JSON.stringify({ version: '2.0.8', pid: 1234 }))
        : new Response(null, { status: 404 });
    });
    return { server, secrets, authorization };
  }

  it('rechecks a newly published managed lease before asking for credentials or attaching as external', async () => {
    const { server, secrets, authorization } = setup(undefined, true);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    const registration = vi.mocked(processManager.refreshStartupRegistration);
    registration.mockResolvedValueOnce(false).mockImplementation(async () => {
      // Model publication by the previous editor after the first registration read.
      Object.defineProperty(processManager, 'serverAuthorization', { value: authorization });
      return true;
    });
    const restore = vi.spyOn(processManager, 'restoreManagedServerCredentials').mockResolvedValue();
    await expect(server.start()).resolves.toBe(server.url);
    expect(registration).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledOnce();
    expect(server.isAttachOnly).toBe(false);
    expect(vscodeMock.window.showInputBox).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not use newly published lease credentials when registration cannot be verified', async () => {
    const { server, secrets } = setup(undefined, true);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.mocked(processManager.refreshStartupRegistration)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('The registered OpenCode listener cannot be verified'));
    const restore = vi.spyOn(processManager, 'restoreManagedServerCredentials');
    await expect(server.start()).rejects.toThrow('listener cannot be verified');
    expect(restore).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInputBox).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('shares one prompt across concurrent starts, verifies and saves credentials', async () => {
    const { server, secrets, authorization } = setup();
    vscodeMock.window.showInputBox
      .mockResolvedValueOnce('fixture-user')
      .mockResolvedValueOnce(' password with spaces ');

    await expect(Promise.all([server.start(), server.start()])).resolves.toEqual([
      server.url,
      server.url,
    ]);

    expect(vscodeMock.window.showInputBox).toHaveBeenCalledTimes(2);
    expect(vscodeMock.window.showInputBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: true, ignoreFocusOut: true })
    );
    expect(secrets.store).toHaveBeenCalledExactlyOnceWith(
      `varro.opencode.serverCredentials:${server.url}`,
      JSON.stringify({ username: 'fixture-user', password: ' password with spaces ' })
    );
    expect(spawnMock).not.toHaveBeenCalled();
    const logs = JSON.stringify(loggerMock.info.mock.calls);
    expect(logs).not.toContain(' password with spaces ');
    expect(logs).not.toContain(authorization);
  });

  it('reuses credentials from secret storage without prompting', async () => {
    const { server, secrets } = setup(
      JSON.stringify({ username: 'fixture-user', password: ' password with spaces ' })
    );
    await expect(server.start()).resolves.toBe(server.url);
    expect(secrets.get).toHaveBeenCalledWith(`varro.opencode.serverCredentials:${server.url}`);
    expect(vscodeMock.window.showInputBox).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('replaces rejected saved credentials after verifying the new password', async () => {
    const { server, secrets } = setup(
      JSON.stringify({ username: 'fixture-user', password: 'old-password' })
    );
    vscodeMock.window.showInputBox
      .mockResolvedValueOnce('fixture-user')
      .mockResolvedValueOnce(' password with spaces ');
    await expect(server.start()).resolves.toBe(server.url);
    expect(secrets.store).toHaveBeenCalledOnce();
  });

  it.each(['username', 'password', 'rejected'])(
    'does not save or launch a server when credentials are %s',
    async (outcome) => {
      const { server, secrets } = setup();
      if (outcome !== 'username') {
        vscodeMock.window.showInputBox
          .mockResolvedValueOnce('fixture-user')
          .mockResolvedValueOnce(outcome === 'rejected' ? 'wrong-password' : undefined);
      }
      await expect(server.start()).rejects.toThrow('authentication failed');
      expect(secrets.store).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    }
  );

  it('does not prompt for a network failure', async () => {
    const { server, secrets } = setup();
    vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'));
    await expect(server.start()).rejects.toThrow();
    expect(vscodeMock.window.showInputBox).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
  });
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

describe('OpenCodeServer runtime config injection', () => {
  it('injects runtime defaults without overriding caller compaction configuration', async () => {
    const inheritedContent =
      '{\n  // inherited content\n  "provider": { "example": { "name": "Example" } },\n  "compaction": { "auto": false, "buffer": 16000 },\n}\n';
    process.env.OPENCODE_CONFIG_CONTENT = inheritedContent;
    const server = new OpenCodeServer(4096, true, 'opencode');
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
    const config = JSON.parse(configText);
    expect(config).not.toHaveProperty('compaction');
    expect(config).toMatchObject({
      experimental: { continue_loop_on_deny: true },
      agent: { ask: { mode: 'primary' } },
    });
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
      const server = new OpenCodeServer(4096, true, 'opencode');
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
});

describe('OpenCodeServer maintenance', () => {
  it('includes live server start and client counts in diagnostics without changing ownership', async () => {
    const server = new OpenCodeServer(4096, false);
    const api = server as unknown as {
      processManager: OpenCodeProcess;
      readInstalledCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      readActiveAgentCount: () => Promise<number>;
    };
    setRunning(server);
    api.readInstalledCliVersion = vi.fn().mockResolvedValue('2.0.21');
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '2.0.21' });
    api.readActiveAgentCount = vi.fn().mockResolvedValue(2);
    const pid = vi.spyOn(api.processManager, 'managedProcessId', 'get').mockReturnValue(1234);
    const connections = { startedAt: 1_790_852_400_000, vscodeClients: 2, otherClients: 1 };
    vi.mocked(readLocalServerConnectionInfo).mockResolvedValueOnce(connections);
    const info = await server.readServerInfo();
    expect(readLocalServerConnectionInfo).toHaveBeenCalledWith(4096, 1234);
    expect(info.connections).toEqual(connections);
    expect(info.activeAgentCount).toBe(2);
    expect(info.ownership).toBe('unmanaged');

    vi.mocked(readLocalServerConnectionInfo).mockImplementationOnce(async () => {
      pid.mockReturnValue(4321);
      return connections;
    });
    const replaced = await server.readServerInfo();
    expect(replaced.connections).toEqual({
      startedAt: null,
      vscodeClients: null,
      otherClients: null,
    });

    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    vi.mocked(readLocalServerConnectionInfo).mockClear();
    const unhealthy = await server.readServerInfo();
    expect(readLocalServerConnectionInfo).not.toHaveBeenCalled();
    expect(unhealthy.connections).toEqual({
      startedAt: null,
      vscodeClients: null,
      otherClients: null,
    });
  });

  it.each([
    { label: 'available', found: true, exists: true },
    { label: 'inaccessible', found: true, exists: false },
    { label: 'missing', found: false, exists: true },
  ])('reports the CLI file creation date when it is $label', async ({ found, exists }) => {
    const fs = await vi.importActual<typeof FsPromisesModule>('fs/promises');
    const fixtureRoot = join(process.cwd(), 'tmp');
    await fs.mkdir(fixtureRoot, { recursive: true });
    const fixture = await fs.mkdtemp(join(fixtureRoot, 'varro-cli-date-'));
    onTestFinished(() => fs.rm(fixture, { recursive: true, force: true }));
    const binary = join(fixture, 'cli');
    const command = process.platform === 'win32' ? binary : join(fixture, 'opencode2');
    let birthtimeMs: number | null = null;
    if (exists) {
      await fs.writeFile(binary, 'fixture CLI');
      // Package modification dates can predate installation. Follow the executable link instead.
      await fs.utimes(binary, new Date(2000, 0, 1), new Date(2000, 0, 1));
      if (command !== binary) await fs.symlink(binary, command);
      birthtimeMs = (await fs.stat(binary)).birthtimeMs;
    }
    const server = new OpenCodeServer(4096, false);
    const api = server as unknown as {
      processManager: OpenCodeProcess;
      readInstalledCliVersion: () => Promise<string | null>;
      readHealthInfo: () => Promise<{ healthy: boolean }>;
    };
    api.readInstalledCliVersion = vi.fn().mockResolvedValue(found ? '2.0.21' : null);
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    vi.spyOn(api.processManager, 'getInstallInfo').mockReturnValue({
      resolvedCommand: command,
      configuredCommand: '',
      configuredCommandMissing: false,
      found,
      installMethod: 'bun',
      searchedPaths: [],
    });
    const info = await server.readServerInfo();

    expect(info.resolvedCommand).toBe(command);
    expect(info.cliInstalledAt).toBe(
      found && birthtimeMs !== null && Number.isFinite(birthtimeMs) && birthtimeMs > 0
        ? birthtimeMs
        : null
    );
    expect(info.cliVersion).toBe(found ? '2.0.21' : null);
    expect(info.health.healthy).toBe(false);
    if (found && exists) {
      // Replacing the target on upgrade must refresh the timestamp, not keep a cached date.
      const replacement = join(fixture, 'replacement');
      await fs.writeFile(replacement, 'updated CLI');
      await fs.rename(replacement, binary);
      const updatedBirthtimeMs = (await fs.stat(binary)).birthtimeMs;
      const updatedInfo = await server.readServerInfo();
      expect(updatedInfo.cliInstalledAt).toBe(updatedBirthtimeMs > 0 ? updatedBirthtimeMs : null);
    }
  });

  describe.each(['shared-service', 'manual-fixed-port', 'auto-start-disabled'] as const)(
    'attach-only %s diagnostics',
    (mode) => {
      it.each(['installed', 'missing', 'failed'] as const)(
        'checks the local CLI when it is %s without granting lifecycle rights',
        async (result) => {
          const server = new OpenCodeServer(
            mode === 'shared-service' ? 'auto' : 4096,
            mode !== 'auto-start-disabled'
          );
          const { api, children } = configureManagedStartup(server);
          const { processManager } = server as unknown as { processManager: OpenCodeProcess };
          vi.mocked(api.readHealthInfo).mockResolvedValue({ healthy: true, version: '2.0.21' });
          if (mode === 'shared-service') {
            vi.spyOn(processManager, 'discoverSharedServer').mockResolvedValue(true);
            vi.spyOn(processManager, 'refreshDiscoveredServerRegistration').mockResolvedValue(
              false
            );
          }
          const versionCheck = vi.mocked(api.readInstalledCliVersion);
          versionCheck.mockResolvedValue('2.0.20');
          vi.spyOn(
            server as unknown as { readActiveAgentCount: () => Promise<number> },
            'readActiveAgentCount'
          ).mockResolvedValue(2);
          const upgrade = vi.spyOn(processManager, 'upgradeCli');
          const stop = vi.spyOn(processManager, 'stopServerForRestart');
          const recovery = vi.spyOn(processManager, 'recoverManagedServerOwnership');

          await server.start();
          versionCheck.mockClear();
          if (result === 'failed')
            versionCheck.mockRejectedValue(new Error('CLI inspection failed'));
          else versionCheck.mockResolvedValue(result === 'installed' ? '2.0.20' : null);
          const info = await server.readServerInfo();
          expect(versionCheck).toHaveBeenCalledOnce();
          expect(info.cliVersion).toBe(result === 'installed' ? '2.0.20' : null);
          expect(info.cliVersionError).toBe(result === 'failed' ? 'CLI inspection failed' : null);
          expect(info.health.version).toBe('2.0.21');
          expect(info.activeAgentCount).toBe(2);
          expect(info.ownership).toBe('unmanaged');
          expect(info.managedProcess).toBe(false);
          expect(server.isAttachOnly).toBe(true);
          await runMaintenanceTick(server);
          await expect(server.restart({ force: true })).rejects.toThrow('attach-only');
          expect(versionCheck).toHaveBeenCalledOnce();
          expect(upgrade).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
          expect(recovery).not.toHaveBeenCalled();
          expect(api.syncInjectedConfigFile).not.toHaveBeenCalled();
          expect(children).toHaveLength(0);
          await server.disconnect();
        }
      );
    }
  );

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
      if (
        path ===
        `/session/status?directory=${encodeURIComponent(getVarroStateDirectory('scratch'))}`
      ) {
        return {};
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
    expect(info.workspaceCwd).toBe(getVarroStateDirectory('scratch'));
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

  it.each([
    {
      installed: '2.0.22',
      running: '2.0.18',
      busy: false,
      healthy: true,
      restart: true,
      checks: true,
    },
    {
      installed: '2.0.22',
      running: '2.0.18',
      busy: true,
      healthy: true,
      restart: false,
      checks: true,
    },
    {
      installed: '2.0.18',
      running: '2.0.18',
      busy: false,
      healthy: true,
      restart: false,
      checks: true,
    },
    {
      installed: '2.0.17',
      running: '2.0.18',
      busy: false,
      healthy: true,
      restart: false,
      checks: true,
    },
    {
      installed: null,
      running: '2.0.18',
      busy: false,
      healthy: true,
      restart: false,
      checks: false,
    },
    {
      installed: '2.0.22',
      running: '2.0.18',
      busy: false,
      healthy: false,
      restart: false,
      checks: false,
    },
    {
      installed: '2.0.22',
      running: '1.18.33',
      busy: false,
      healthy: true,
      restart: false,
      checks: false,
    },
    {
      installed: '1.18.34',
      running: '2.0.18',
      busy: false,
      healthy: true,
      restart: false,
      checks: false,
    },
  ])(
    'checks installed updates on a reused managed server ($running -> $installed, busy: $busy, healthy: $healthy)',
    async ({ installed, running, busy, healthy, restart, checks }) => {
      const server = new OpenCodeServer('auto', true);
      const api = server as unknown as {
        processManager: OpenCodeProcess;
        managedProcess: boolean;
        preserveExistingProcess: boolean;
        readInstalledCliVersion: () => Promise<string | null>;
        readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
        hasActiveSessions: () => Promise<boolean>;
        restartServerForCliUpdate: (serverVersion: string, cliVersion: string) => Promise<void>;
        maybeSuggestCliUpdate: (version: string | null) => Promise<string | null>;
      };
      setRunning(server);
      api.managedProcess = true;
      api.preserveExistingProcess = true;
      vi.spyOn(api.processManager, 'refreshManagedServerOwnership').mockResolvedValue(true);
      api.readInstalledCliVersion = vi.fn().mockResolvedValue(installed);
      api.readHealthInfo = vi.fn().mockResolvedValue({ healthy, version: running });
      api.hasActiveSessions = vi.fn().mockResolvedValue(busy);
      const restartForUpdate = vi.spyOn(api, 'restartServerForCliUpdate').mockResolvedValue();
      const suggestUpdate = vi.spyOn(api, 'maybeSuggestCliUpdate').mockResolvedValue(null);

      await runMaintenanceTick(server);

      expect(api.readInstalledCliVersion).toHaveBeenCalledOnce();
      // Unknown, unhealthy, or cross-family evidence never reaches the installer.
      if (checks) expect(suggestUpdate).toHaveBeenCalledExactlyOnceWith(installed);
      else expect(suggestUpdate).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      if (restart) expect(restartForUpdate).toHaveBeenCalledWith(running, installed);
      else expect(restartForUpdate).not.toHaveBeenCalled();
      if (busy) {
        vi.mocked(api.hasActiveSessions).mockResolvedValue(false);
        await runMaintenanceTick(server);
        expect(restartForUpdate).toHaveBeenCalledWith(running, installed);
      }
    }
  );

  it.each(['new-work', 'failed-verification'] as const)(
    'leaves a reused managed server running after restart preflight detects %s',
    async (scenario) => {
      const server = new OpenCodeServer('auto', true);
      const api = server as unknown as {
        processManager: OpenCodeProcess;
        managedProcess: boolean;
        preserveExistingProcess: boolean;
        readInstalledCliVersion: () => Promise<string | null>;
        readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
        hasActiveSessions: () => Promise<boolean>;
      };
      setRunning(server);
      api.managedProcess = true;
      api.preserveExistingProcess = true;
      vi.spyOn(api.processManager, 'refreshManagedServerOwnership').mockResolvedValue(true);
      api.readInstalledCliVersion = vi.fn().mockResolvedValue('2.0.22');
      api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '2.0.18' });
      const idle = vi.spyOn(api, 'hasActiveSessions').mockResolvedValueOnce(false);
      if (scenario === 'new-work') idle.mockResolvedValueOnce(true);
      else idle.mockRejectedValueOnce(new Error('Pending attention could not be verified'));
      const stop = vi.spyOn(api.processManager, 'stopServerForRestart');
      const claim = vi.spyOn(api.processManager, 'acquireManagedServerRestartOwnership');
      const start = vi.spyOn(server, 'start');

      await runMaintenanceTick(server);

      expect(idle).toHaveBeenCalledTimes(2);
      expect(claim).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(server.status.state).toBe('running');
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('OpenCode background maintenance failed:')
      );
    }
  );

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

  it.each(['1.14.22', '2.0.6'])(
    'restarts a managed process for CLI %s without emitting a stopped status',
    async (cliVersion) => {
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

      await api.restartServerForCliUpdate('1.14.20', cliVersion);

      expect(api.stopServerForRestart).toHaveBeenCalledTimes(1);
      expect(api.start).toHaveBeenCalledTimes(1);
      expect(api.stopServerForRestart).toHaveBeenCalledBefore(vi.mocked(api.start));
      expect(statuses.some((status) => status.state === 'stopped')).toBe(false);
    }
  );

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
    expect(api.readInstalledCliVersion).not.toHaveBeenCalled();
    expect(api.maybeSuggestCliUpdate).not.toHaveBeenCalled();
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

  it.each([
    { platform: 'linux', installed: '1.14.20', latest: '1.14.22', busy: false },
    { platform: 'win32', installed: '2.0.21', latest: '2.0.22', busy: false },
    { platform: 'win32', installed: '2.0.21', latest: '2.0.22', busy: true },
  ] as const)(
    'applies a background update on $platform and restarts only when idle (busy: $busy)',
    async ({ platform, installed, latest, busy }) => {
      stubPlatform(platform);

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
      api.readInstalledCliVersion = vi.fn().mockResolvedValue(installed);
      api.readLatestCliVersion = vi.fn().mockResolvedValue(latest);
      api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: installed });
      api.hasActiveSessions = vi.fn().mockResolvedValue(busy);
      api.restartServerForCliUpdate = restartServerForCliUpdate;
      stubCliSpawn({ version: latest });

      await runMaintenanceTick(server);
      await flushMicrotasks();

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        [platform === 'win32' ? 'update' : 'upgrade', latest],
        expect.any(Object)
      );
      if (busy) expect(restartServerForCliUpdate).not.toHaveBeenCalled();
      else expect(restartServerForCliUpdate).toHaveBeenCalledWith(installed, latest);
    }
  );

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
      expect.stringMatching(
        /OpenCode CLI 1\.14\.22 is available \(installed: 1\.14\.20\)\. Update with: .* upgrade 1\.14\.22$/
      ),
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
    await vi.waitFor(() => expect(terminal.sendText).toHaveBeenCalledOnce());

    expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
      name: 'OpenCode Upgrade',
      cwd: getVarroStateDirectory('scratch'),
    });
    expect(terminal.show).toHaveBeenCalledWith(false);
    expect(terminal.sendText).toHaveBeenCalledWith(
      expect.stringMatching(/^'.+' upgrade 1\.14\.22$/),
      true
    );
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
    // Background v1 auto-update is disabled on win32, so pin a POSIX platform.
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

  it('auto-updates beyond the tested manifest version when enabled', async () => {
    stubPlatform('linux');
    const server = new OpenCodeServer(4096, false);
    const nextVersion = nextPatchVersion(MANIFEST_OPENCODE_VERSION);
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = vi.fn().mockResolvedValue(nextVersion);
    stubCliSpawn({ version: nextVersion });

    await maybeSuggestCliUpdate(server, MANIFEST_OPENCODE_VERSION);
    await flushMicrotasks();

    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['upgrade', nextVersion]),
      expect.any(Object)
    );
  });

  it('auto-updates Windows v2 directly through the resolved CLI without stopping the server', async () => {
    stubPlatform('win32');
    const command = 'C:\\OpenCode Install\\opencode2.exe';
    const server = new OpenCodeServer(4096, false, command);
    const request = vi.fn().mockResolvedValue({ success: true, version: '2.0.22' });
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
      request: typeof request;
    };
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = vi.fn().mockResolvedValue('2.0.22');
    api.request = request;
    const prepare = vi.spyOn(server, 'prepareForWindowsCliUpgrade');
    setRunning(server);
    stubCliSpawn({ version: '2.0.22' });

    await expect(maybeSuggestCliUpdate(server, '2.0.21')).resolves.toBe('2.0.22');

    expect(request).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(command, ['update', '2.0.22'], expect.any(Object));
    expect(spawnMock).toHaveBeenCalledWith(command, ['--version'], expect.any(Object));
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(runWindowsCliUpdate).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
  });

  it('reports a Windows v2 update that exits successfully without replacing the CLI', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, false, 'C:\\OpenCode\\opencode2.exe');
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
    };
    getConfigurationMock.mockImplementation(() => ({
      get: (key: string, fallback?: unknown) => (key === 'server.autoUpdate' ? true : fallback),
    }));
    api.readLatestCliVersion = vi.fn().mockResolvedValue('2.0.22');
    stubCliSpawn({ version: '2.0.21', stderr: 'EPERM: binary is being used by another process' });

    await expect(maybeSuggestCliUpdate(server, '2.0.21')).resolves.toBeNull();
    await flushMicrotasks();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ['update', '2.0.22'],
      expect.any(Object)
    );
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Varro could not update the OpenCode CLI to 2.0.22 automatically.'),
      'Show Logs'
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('EPERM: binary is being used by another process')
    );
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('offers a normal update beyond the tested manifest version when auto-update is disabled', async () => {
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
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        `OpenCode CLI ${latestVersion} is available (installed: ${installedVersion}). Update with: `
      ),
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
    const api = server as unknown as {
      readLatestCliVersion: () => Promise<string | null>;
      readHealthInfo: ReturnType<typeof vi.fn>;
    };

    api.readLatestCliVersion = readLatestCliVersion;
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: false });
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Run Upgrade');

    await maybeSuggestCliUpdate(server, '1.14.20');
    await vi.waitFor(() => expect(runWindowsCliUpdate).toHaveBeenCalledOnce());

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(
        /OpenCode CLI 1\.14\.22 is available \(installed: 1\.14\.20\)\. Update with: & '.+' upgrade 1\.14\.22$/
      ),
      'Run Upgrade'
    );
    expect(runWindowsCliUpdate).toHaveBeenCalledWith(
      expect.stringMatching(/^& '.+' upgrade 1\.14\.22$/),
      'OpenCode Upgrade',
      getVarroStateDirectory('scratch'),
      expect.any(Function)
    );
  });

  it('stops the managed process before running a Windows CLI upgrade', async () => {
    stubPlatform('win32');

    const server = new OpenCodeServer(4096, false);
    const readLatestCliVersion = vi.fn().mockResolvedValue('1.14.22');
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

    await maybeSuggestCliUpdate(server, '1.14.20');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(kill).not.toHaveBeenCalled();
    expect(statuses.some((status) => status.state === 'stopped')).toBe(true);
    expect(runWindowsCliUpdate).toHaveBeenCalledWith(
      expect.stringMatching(/^& '.+' upgrade 1\.14\.22$/),
      'OpenCode Upgrade',
      getVarroStateDirectory('scratch'),
      expect.any(Function)
    );
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
    const startOperation = vi.fn(async () => {
      setRunning(server);
      await server.request('GET', '/session');
      return server.url;
    });
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
      transport: { request: ReturnType<typeof vi.fn> };
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
    api.transport.request = vi.fn().mockResolvedValue([]);
    setRunning(server);

    await server.prepareForWindowsCliUpgrade('1.18.0');
    await server.finishWindowsCliUpgrade();

    expect(clearResolvedCommandCache).toHaveBeenCalledOnce();
    expect(api.readInstalledCliVersion).toHaveBeenCalledOnce();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Windows OpenCode terminal update closed, but CLI 1.17.0 is older than requested 1.18.0'
    );
    expect(startOperation).toHaveBeenCalledOnce();
    expect(api.transport.request).toHaveBeenCalledWith('GET', '/session', undefined, undefined);
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
  it.each(['1.18.31', '2.0.10'])(
    'attaches to %s without local ownership, CLI checks, or process control',
    async (version) => {
      const server = new OpenCodeServer(4096, false);
      const api = server as unknown as {
        readHealthInfo: () => Promise<{ healthy: boolean; version: string }>;
        readInstalledCliVersion: () => Promise<string | null>;
        startEventStream: () => Promise<void>;
        processManager: {
          recoverManagedServerOwnership: () => Promise<boolean>;
          prepareForHealthyExistingServer: () => Promise<void>;
          stopServerForRestart: () => Promise<void>;
        };
      };
      api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version });
      api.readInstalledCliVersion = vi.fn();
      api.startEventStream = vi.fn().mockResolvedValue(undefined);
      api.processManager.recoverManagedServerOwnership = vi.fn();
      api.processManager.prepareForHealthyExistingServer = vi.fn();
      api.processManager.stopServerForRestart = vi.fn();

      await expect(server.start()).resolves.toBe('http://127.0.0.1:4096');
      await expect(server.restart({ force: true })).rejects.toThrow('attach-only mode');
      await runMaintenanceTick(server);
      expect(server.status.state).toBe('running');
      expect(api.readInstalledCliVersion).not.toHaveBeenCalled();
      expect(api.processManager.recoverManagedServerOwnership).not.toHaveBeenCalled();
      expect(api.processManager.prepareForHealthyExistingServer).not.toHaveBeenCalled();
      expect(api.processManager.stopServerForRestart).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      await server.disconnect();
    }
  );

  it('retries a failed attach without trying to claim or stop the server', async () => {
    const server = new OpenCodeServer(4096, false);
    const api = server as unknown as {
      _status: ServerStatus;
      start: () => Promise<string>;
      processManager: { takeOwnershipOfExistingServer: () => Promise<boolean> };
    };
    api._status = { state: 'error', message: 'connection refused' };
    api.start = vi.fn().mockResolvedValue(server.url);
    api.processManager.takeOwnershipOfExistingServer = vi.fn();
    await expect(server.restart()).resolves.toBe(server.url);
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.processManager.takeOwnershipOfExistingServer).not.toHaveBeenCalled();
  });

  it('does not block a healthy existing server on ownership recovery', async () => {
    const server = new OpenCodeServer(4096, true);
    const recovery = deferred<boolean>();
    const recoverManagedServerOwnership = vi.fn(() => recovery.promise);
    const prepareForHealthyExistingServer = vi.fn().mockResolvedValue(undefined);
    const rememberInstalledCliVersion = vi.fn();
    const requestMaintenanceCheck = vi.fn();
    const api = server as unknown as {
      readHealthInfo: () => Promise<{ healthy: boolean; version?: string }>;
      requestMaintenanceCheck: typeof requestMaintenanceCheck;
      processManager: {
        recoverManagedServerOwnership: typeof recoverManagedServerOwnership;
        prepareForHealthyExistingServer: typeof prepareForHealthyExistingServer;
        rememberInstalledCliVersion: typeof rememberInstalledCliVersion;
        hasOwnershipLeaseCandidate: boolean;
      };
    };
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '1.18.26' });
    api.requestMaintenanceCheck = requestMaintenanceCheck;
    Object.defineProperty(api.processManager, 'hasOwnershipLeaseCandidate', {
      configurable: true,
      value: true,
    });
    api.processManager.recoverManagedServerOwnership = recoverManagedServerOwnership;
    api.processManager.prepareForHealthyExistingServer = prepareForHealthyExistingServer;
    api.processManager.rememberInstalledCliVersion = rememberInstalledCliVersion;
    vi.mocked(
      (api.processManager as unknown as OpenCodeProcess).refreshStartupRegistration
    ).mockResolvedValue(true);

    await expect(server.start()).resolves.toBe(server.url);

    expect(recoverManagedServerOwnership).toHaveBeenCalledOnce();
    expect(prepareForHealthyExistingServer).not.toHaveBeenCalled();
    expect(rememberInstalledCliVersion).not.toHaveBeenCalled();
    expect(requestMaintenanceCheck).not.toHaveBeenCalled();

    recovery.resolve(true);
    await flushMicrotasks();
    expect(prepareForHealthyExistingServer).toHaveBeenCalledOnce();
    expect(rememberInstalledCliVersion).not.toHaveBeenCalled();
    expect(requestMaintenanceCheck).toHaveBeenCalledOnce();
  });

  it('uses a healthy supported v2 server without a compatibility prompt', async () => {
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
    api.readHealthInfo = vi.fn().mockResolvedValue({ healthy: true, version: '2.0.5' });
    api.startEventStream = vi.fn(() => {
      expect(server.status.state).not.toBe('running');
      return Promise.resolve();
    });
    api.requestMaintenanceCheck = vi.fn();
    api.processManager.prepareForHealthyExistingServer = prepareForHealthyExistingServer;

    await expect(server.start()).resolves.toBe(server.url);

    expect(server.status).toEqual({
      state: 'running',
      url: server.url,
      apiVersion: server.apiVersion,
      eventStream: 'degraded',
    });
    expect(prepareForHealthyExistingServer).not.toHaveBeenCalled();
    expect(server.isAttachOnly).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // Exercise the existing remediation/preflight helpers explicitly. Startup now
  // preserves an already-running server instead of invoking these helpers.
  async function remediateIncompatibleServer(server: OpenCodeServer): Promise<string> {
    const api = server as unknown as {
      admission: ServerConnectionAdmission;
      lifecycle: { beginStart: () => number };
      replaceIncompatibleServer: (
        version: string,
        generation: number,
        signal: AbortSignal
      ) => Promise<void>;
      ensureCompatibleCliForLaunch: (
        version: undefined,
        generation: number,
        signal: AbortSignal
      ) => Promise<void>;
      launchManagedServer: (
        generation: number,
        preserveRetryCount: boolean,
        signal: AbortSignal
      ) => Promise<string>;
    };
    const generation = api.lifecycle.beginStart();
    const signal = new AbortController().signal;
    await api.admission.admit();
    await api.replaceIncompatibleServer('1.15.13', generation, signal);
    await api.ensureCompatibleCliForLaunch(undefined, generation, signal);
    return api.launchManagedServer(generation, false, signal);
  }

  it('coordinates explicit remediation of a server leased by another extension host', async () => {
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

    await expect(remediateIncompatibleServer(server)).resolves.toBe(server.url);

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow('OpenCode update required');

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow('has active sessions');

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow('has active sessions');

    expect(api.hasActiveSessions).toHaveBeenCalledTimes(2);
    expect(upgradeRunningServer).toHaveBeenCalledOnce();
    expect(stopServerForRestart).not.toHaveBeenCalled();
  });

  it('updates and replaces an idle outdated server during explicit remediation', async () => {
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

    await expect(remediateIncompatibleServer(server)).resolves.toBe(server.url);

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow(
      'The automatic update failed.'
    );

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

      await expect(remediateIncompatibleServer(server)).rejects.toThrow(
        'The automatic update failed.'
      );

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow(
      'The automatic update failed.'
    );

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow(
      'Automatic updates are disabled.'
    );

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

    await expect(remediateIncompatibleServer(server)).rejects.toThrow('active sessions');

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
  async function createCliFixture() {
    const fs = await vi.importActual<typeof FsModule>('fs');
    const os = await vi.importActual<typeof OsModule>('os');
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'varro-cli-startup-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const v1 = join(directory, 'opencode');
    const v2 = join(directory, 'opencode2');
    fs.writeFileSync(v1, '');
    return { directory, v1, v2, installV2: () => fs.writeFileSync(v2, '') };
  }

  it.each([
    { cached: '1.18.26', installed: '2.0.20', configured: false },
    { cached: '2.0.20', installed: '1.18.26', configured: true },
  ])('launches CLI $installed despite cached version $cached', async (versions) => {
    stubPlatform('linux');
    const fixture = await createCliFixture();
    fixture.installV2();
    const executable = versions.configured ? fixture.v1 : fixture.v2;
    const server = new OpenCodeServer('auto', true, versions.configured ? fixture.v1 : '');
    const { api } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    processManager.rememberInstalledCliVersion(versions.cached);
    api.readInstalledCliVersion = () => processManager.readInstalledCliVersion();
    vi.spyOn(
      processManager as unknown as { serverPathEntries(): string[] },
      'serverPathEntries'
    ).mockReturnValue([fixture.directory]);
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = createMockChildProcess();
      if (args[0] === '--version') {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(versions.installed));
          child.emit('close', 0, null);
        });
      }
      return child;
    });

    const url = await server.start();
    expect(url).toBe(server.url);

    expect(spawnMock).toHaveBeenCalledWith(executable, ['--version'], expect.anything());
    expect(spawnMock).toHaveBeenLastCalledWith(
      executable,
      [
        'serve',
        ...(versions.installed.startsWith('2.') ? ['--service'] : []),
        '--port',
        new URL(server.url).port,
      ],
      expect.anything()
    );
    expect(Number(new URL(server.url).port)).toBeGreaterThanOrEqual(49152);
  });

  it('discovers v2 installed while a v1 server was running on crash recovery', async () => {
    stubPlatform('linux');
    const fixture = await createCliFixture();
    const server = new OpenCodeServer('auto', true);
    const { api, children } = configureManagedStartup(server);
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    vi.spyOn(processManager, 'discoverSharedServer').mockReturnValue(false);
    api.readInstalledCliVersion = () => processManager.readInstalledCliVersion();
    vi.spyOn(
      processManager as unknown as { serverPathEntries(): string[] },
      'serverPathEntries'
    ).mockReturnValue([fixture.directory]);
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const child = createMockChildProcess();
      if (args[0] === '--version') {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(command === fixture.v2 ? '2.0.20' : '1.18.26'));
          child.emit('close', 0, null);
        });
      } else {
        children.push(child);
      }
      return child;
    });
    await server.start();
    fixture.installV2();
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(children).toHaveLength(2);
    expect(server.status.state).toBe('running');
    expect(spawnMock).toHaveBeenLastCalledWith(
      fixture.v2,
      ['serve', '--service', '--port', new URL(server.url).port],
      expect.anything()
    );
  });

  it('checks the Windows CLI major before choosing the managed startup mode', async () => {
    stubPlatform('win32');
    const server = new OpenCodeServer(4096, true);
    const { api } = configureManagedStartup(server);

    await expect(server.start()).resolves.toBe(server.url);

    expect(api.readInstalledCliVersion).toHaveBeenCalledOnce();
  });

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
      processManager: {
        confirmManagedServerOwnership: () => Promise<boolean>;
        rememberInstalledCliVersion: (version: string) => void;
      };
    };

    api.readHealthInfo = vi
      .fn<() => Promise<{ healthy: boolean; version?: string }>>()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValueOnce({ healthy: true, version: MINIMUM_SUPPORTED_OPENCODE_VERSION });
    api.startAttemptId = 1;
    api.disposeGeneration = 0;
    api.processManager.confirmManagedServerOwnership = vi.fn().mockResolvedValue(true);
    api.processManager.rememberInstalledCliVersion = vi.fn();

    api.pollHealth(1, 0, resolved, rejected);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    expect(resolved).toHaveBeenCalledWith(server.url);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(api.processManager.rememberInstalledCliVersion).not.toHaveBeenCalled();
  });
});

describe('OpenCodeServer restart blockers', () => {
  it('includes busy sessions observed in a nested OpenCode instance', async () => {
    const server = new OpenCodeServer(4096, true);
    const nestedDirectory = '/repo/packages/app';
    const request = vi.fn(
      async (_method: string, path: string, _body?: unknown, options?: { directory?: string }) => {
        if (path.startsWith('/experimental/session')) {
          return [{ id: 'nested-session', directory: nestedDirectory }];
        }
        if (path === '/session/status') {
          return options?.directory === nestedDirectory
            ? { 'nested-session': { type: 'busy' } }
            : {};
        }
        if (path === '/question' || path === '/permission') return [];
        if (path === '/session') {
          return options?.directory === nestedDirectory
            ? [{ id: 'nested-session', directory: nestedDirectory }]
            : [];
        }
        throw new Error(`Unexpected request: ${path}`);
      }
    );
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
      directory: nestedDirectory,
      payload: {
        type: 'session.status',
        properties: { sessionID: 'nested-session', status: { type: 'busy' } },
      },
    });

    await expect(server.readRestartBlockers()).resolves.toEqual({
      totalSessionCount: 1,
      directories: [{ directory: nestedDirectory, sessionCount: 1 }],
    });
  });

  it('discovers a busy nested instance without observing its prior status event', async () => {
    const server = new OpenCodeServer(4096, true);
    const nestedDirectory = '/repo/packages/app';
    const request = vi.fn(
      async (_method: string, path: string, _body?: unknown, options?: { directory?: string }) => {
        if (path.startsWith('/experimental/session')) {
          return [{ id: 'nested-session', directory: nestedDirectory }];
        }
        if (path === '/session/status') {
          return options?.directory === nestedDirectory
            ? { 'nested-session': { type: 'busy' } }
            : {};
        }
        if (path === '/question' || path === '/permission' || path === '/session') return [];
        throw new Error(`Unexpected request: ${path}`);
      }
    );
    const transport = (
      server as unknown as {
        transport: { request: typeof request };
      }
    ).transport;
    transport.request = request;

    await expect(server.readRestartBlockers()).resolves.toEqual({
      totalSessionCount: 1,
      directories: [{ directory: nestedDirectory, sessionCount: 1 }],
    });
    expect(request).toHaveBeenCalledWith(
      'GET',
      expect.stringMatching(/^\/experimental\/session/),
      undefined,
      expect.objectContaining({ unscoped: true })
    );
    expect(request).toHaveBeenCalledWith('GET', '/session/status', undefined, {
      directory: nestedDirectory,
    });
  });

  it.each(['idle', 'busy', 'attention'])(
    'handles a deleted v2 session directory while the session is %s',
    async (state) => {
      const server = new OpenCodeServer(4096, true);
      const directory = join(process.cwd(), `missing-restart-directory-${process.pid}`);
      const request = vi.fn(
        async (
          _method: string,
          path: string,
          _body?: unknown,
          options?: { directory?: string }
        ) => {
          if (options?.directory === directory) throw new Error('500 Internal Server Error');
          if (path === '/api/debug/location') return [];
          if (path.startsWith('/experimental/session')) return [{ id: 'old-session', directory }];
          if (path === '/session/status')
            return state === 'busy' ? { 'old-session': { type: 'busy' } } : {};
          if (path === '/question' || path === '/permission') return [];
          throw new Error(`Unexpected request: ${path}`);
        }
      );
      const api = server as unknown as {
        transport: {
          apiVersion: number;
          request: typeof request;
          getPendingAttentionSessionIDs: () => string[];
        };
      };
      api.transport.apiVersion = 2;
      api.transport.request = request;
      api.transport.getPendingAttentionSessionIDs = () =>
        state === 'attention' ? ['old-session'] : [];

      await expect(server.readRestartBlockers()).resolves.toEqual({
        totalSessionCount: state === 'idle' ? 0 : 1,
        directories: state === 'idle' ? [] : [{ directory, sessionCount: 1 }],
      });
      expect(request.mock.calls.every((call) => !call[3]?.directory)).toBe(true);
    }
  );

  it('still blocks v2 restart when attention reads fail for an existing directory', async () => {
    const server = new OpenCodeServer(4096, true);
    const request = vi.fn(
      async (_method: string, path: string, _body?: unknown, options?: { directory?: string }) => {
        if (path.startsWith('/experimental/session'))
          return [{ id: 'session-1', directory: process.cwd() }];
        if (path === '/api/debug/location') return [{ directory: process.cwd() }];
        if (path === '/session/status') return {};
        if (options?.directory) throw new Error('500 Internal Server Error');
        return [];
      }
    );
    const api = server as unknown as {
      transport: { apiVersion: number; request: typeof request };
    };
    api.transport.apiVersion = 2;
    api.transport.request = request;

    await expect(server.readRestartBlockers()).rejects.toThrow('500 Internal Server Error');
  });

  it.each(['idle', 'busy', 'question', 'permission', 'observed'])(
    'does not probe a historical UNC directory while its session is %s',
    async (state) => {
      const server = new OpenCodeServer(4096, true);
      const directory = '\\\\mac\\Home\\repo';
      const request = vi.fn(
        async (
          _method: string,
          path: string,
          _body?: unknown,
          options?: { directory?: string }
        ) => {
          if (options?.directory) throw new Error("UNC host 'mac' access is not allowed");
          if (path === '/api/debug/location') return [];
          if (path.startsWith('/experimental/session')) return [{ id: 'old-session', directory }];
          if (path === '/session/status')
            return state === 'busy' ? { 'old-session': { type: 'busy' } } : {};
          if (path === '/question')
            return state === 'question' ? [{ sessionID: 'old-session' }] : [];
          if (path === '/permission')
            return state === 'permission' ? [{ sessionID: 'old-session' }] : [];
          throw new Error(`Unexpected request: ${path}`);
        }
      );
      const api = server as unknown as {
        transport: {
          apiVersion: number;
          request: typeof request;
          getPendingAttentionSessionIDs: () => string[];
          getObservedSessionDirectories: () => Map<string, string>;
        };
      };
      api.transport.apiVersion = 2;
      api.transport.request = request;
      api.transport.getPendingAttentionSessionIDs = () =>
        state === 'observed' ? ['old-session'] : [];
      api.transport.getObservedSessionDirectories = () => new Map([['old-session', directory]]);

      await expect(server.readRestartBlockers()).resolves.toEqual({
        totalSessionCount: state === 'idle' ? 0 : 1,
        directories: state === 'idle' ? [] : [{ directory, sessionCount: 1 }],
      });
      expect(stat).not.toHaveBeenCalled();
      expect(request.mock.calls.every((call) => !call[3]?.directory)).toBe(true);
    }
  );

  it.each(['question', 'permission', 'shell'])(
    'checks loaded UNC locations absent from history for pending %s work',
    async (state) => {
      const server = new OpenCodeServer(4096, true);
      const directory = '\\\\mac\\Home\\repo';
      const request = vi.fn(
        async (
          _method: string,
          path: string,
          _body?: unknown,
          options?: { directory?: string }
        ) => {
          if (path === '/api/debug/location') return [{ directory }];
          if (path.startsWith('/experimental/session')) return [];
          const scoped = options?.directory === directory;
          if (path === '/session/status')
            return scoped && state === 'shell' ? { 'loaded-session': { type: 'busy' } } : {};
          if (path === '/question')
            return scoped && state === 'question' ? [{ sessionID: 'loaded-session' }] : [];
          if (path === '/permission')
            return scoped && state === 'permission' ? [{ sessionID: 'loaded-session' }] : [];
          throw new Error(`Unexpected request: ${path}`);
        }
      );
      const api = server as unknown as {
        transport: { apiVersion: number; request: typeof request };
      };
      api.transport.apiVersion = 2;
      api.transport.request = request;

      await expect(server.readRestartBlockers()).resolves.toEqual({
        totalSessionCount: 1,
        directories: [{ directory, sessionCount: 1 }],
      });
      expect(stat).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith('GET', '/question', undefined, { directory });
      expect(request).toHaveBeenCalledWith('GET', '/permission', undefined, { directory });
    }
  );

  it.each([{}, [null], [{ directory: '' }], [{ directory: 42 }]])(
    'fails closed for a malformed loaded location list %j',
    async (locations) => {
      const server = new OpenCodeServer(4096, true);
      const api = server as unknown as {
        transport: { apiVersion: number; request: ReturnType<typeof vi.fn> };
      };
      api.transport.apiVersion = 2;
      api.transport.request = vi.fn(async (_method: string, path: string) => {
        if (path === '/api/debug/location') return locations;
        return path === '/session/status' ? {} : [];
      });

      await expect(server.readRestartBlockers()).rejects.toThrow('invalid loaded location list');
    }
  );

  it('fails closed when a loaded UNC location cannot be inspected', async () => {
    const server = new OpenCodeServer(4096, true);
    const directory = '\\\\mac\\Home\\repo';
    const api = server as unknown as {
      transport: { apiVersion: number; request: ReturnType<typeof vi.fn> };
    };
    api.transport.apiVersion = 2;
    api.transport.request = vi.fn(
      async (_method: string, path: string, _body?: unknown, options?: { directory?: string }) => {
        if (path === '/api/debug/location') return [{ directory }];
        if (options?.directory) throw new Error("UNC host 'mac' access is not allowed");
        return path === '/session/status' ? {} : [];
      }
    );

    await expect(server.readRestartBlockers()).rejects.toThrow(
      "UNC host 'mac' access is not allowed"
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('groups unique blocking sessions by normalized directory', async () => {
    const server = new OpenCodeServer(4096, true);
    setRunning(server);
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
      if (path.startsWith('/experimental/session')) return [];
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
      if (path.startsWith('/experimental/session')) return [];
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

  it('retries attachment after an error when the running server is not owned', async () => {
    const server = new OpenCodeServer(4096, true);
    const takeOwnershipOfExistingServer = vi.fn().mockResolvedValue(false);
    const stopServerForRestart = vi.fn();
    const startEventStreamMock = vi.fn().mockResolvedValue(undefined);
    const api = server as unknown as {
      _status: ServerStatus;
      startEventStream: typeof startEventStreamMock;
      requestMaintenanceCheck: ReturnType<typeof vi.fn>;
      processManager: {
        takeOwnershipOfExistingServer: typeof takeOwnershipOfExistingServer;
        stopServerForRestart: typeof stopServerForRestart;
        discoverServerCredentials: ReturnType<typeof vi.fn>;
      };
    };
    api._status = { state: 'error', message: 'OpenCode server authentication failed' };
    api.startEventStream = startEventStreamMock;
    api.requestMaintenanceCheck = vi.fn();
    api.processManager.takeOwnershipOfExistingServer = takeOwnershipOfExistingServer;
    api.processManager.stopServerForRestart = stopServerForRestart;
    let authenticated = false;
    api.processManager.discoverServerCredentials = vi.fn(async () => {
      authenticated = true;
    });
    Object.defineProperty(api.processManager, 'serverAuthorization', {
      get: () => (authenticated ? 'Basic fixture' : undefined),
    });
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (!authenticated) return new Response(null, { status: 401 });
      const pathname = new URL(String(input)).pathname;
      return pathname === '/api/info'
        ? new Response(JSON.stringify({ version: '2.0.7', pid: 1234 }), { status: 200 })
        : new Response(null, { status: 404 });
    });

    await expect(server.restart()).resolves.toBe(server.url);

    expect(api.processManager.discoverServerCredentials).toHaveBeenCalledOnce();
    expect(stopServerForRestart).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
  });
});

describe('OpenCodeServer registered server follow recovery', () => {
  const exitedPid = 1_074_000_000 + process.pid;

  function fixture(registered: boolean, pid = exitedPid) {
    const server = new OpenCodeServer('auto', true);
    const startOperation = vi.fn(async () => {
      setRunning(server);
      return server.url;
    });
    const api = server as unknown as {
      processManager: OpenCodeProcess;
      startOperation: typeof startOperation;
      retryCount: number;
      updateEventStreamState: (state: 'healthy' | 'degraded') => void;
    };
    api.startOperation = startOperation;
    vi.spyOn(api.processManager, 'connectionIdentity', 'get').mockReturnValue(
      registered
        ? { port: 4096, pid, birthIdentity: 'fixture-birth', executable: '/fixture' }
        : undefined
    );
    const verify = vi
      .spyOn(api.processManager, 'verifyManagedServerConnection')
      .mockResolvedValue();
    setRunning(server);
    return { server, api, startOperation, verify };
  }

  it('reattaches through the registration when the listener closes instead of prompting', async () => {
    const { server, api, startOperation } = fixture(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1001);
    vi.mocked(inspectLocalServerAccount).mockRejectedValue(
      new ServerNotListeningError('No OpenCode server is listening on port 4096')
    );

    await expect(server.request('GET', '/config')).rejects.toThrow(
      'No OpenCode server is listening'
    );

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(server.status.state).toBe('stopped');
    // Followers give the owning window a head start to publish its replacement.
    await vi.advanceTimersByTimeAsync(1000);
    expect(startOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(startOperation).toHaveBeenCalledExactlyOnceWith(true);
    expect(server.status.state).toBe('running');
    expect(api.retryCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.retryCount).toBe(0);
    await server.disconnect();
  });

  it('keeps follow recovery when the initial stream admission finds the port closed', async () => {
    const { server, startOperation } = fixture(true);
    await flushMicrotasks();
    vi.mocked(inspectLocalServerAccount).mockRejectedValue(
      new ServerNotListeningError('No OpenCode server is listening on port 4096')
    );

    (server as unknown as { beginRunningEventStream(): void }).beginRunningEventStream();
    await flushMicrotasks();

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(server.status.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(2000);
    expect(startOperation).toHaveBeenCalledExactlyOnceWith(true);
    await server.disconnect();
  });

  it('reattaches when the registered listener was replaced', async () => {
    const { server, startOperation, verify } = fixture(true);
    await flushMicrotasks();
    verify.mockRejectedValue(
      new ManagedServerConnectionChangedError('The managed OpenCode listener changed')
    );

    await expect(server.request('GET', '/config')).rejects.toThrow('listener changed');

    expect(server.status.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(2000);
    expect(startOperation).toHaveBeenCalledExactlyOnceWith(true);
    await server.disconnect();
  });

  it('reports a closed external endpoint without prompting or relaunching it', async () => {
    const { server, startOperation } = fixture(false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1001);
    vi.mocked(inspectLocalServerAccount).mockRejectedValue(
      new ServerNotListeningError('No OpenCode server is listening on port 4096')
    );

    await expect(server.request('GET', '/config')).rejects.toThrow(
      'No OpenCode server is listening'
    );

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(server.status).toEqual({
      state: 'error',
      message: 'No OpenCode server is listening on port 4096',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(startOperation).not.toHaveBeenCalled();
    await server.disconnect();
  });

  it('follows an exited registered PID as soon as the event stream degrades', async () => {
    const { server, api, startOperation, verify } = fixture(true);
    await flushMicrotasks();

    api.updateEventStreamState('degraded');

    expect(server.status.state).toBe('stopped');
    expect(verify).not.toHaveBeenCalled();
    expect(inspectLocalServerAccount).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(startOperation).toHaveBeenCalledExactlyOnceWith(true);
    await server.disconnect();
  });

  it('keeps a live registered server on the ordinary stream reconnect path', async () => {
    const { server, api, startOperation } = fixture(true, process.pid);
    await flushMicrotasks();

    api.updateEventStreamState('degraded');

    expect(server.status).toEqual({
      state: 'running',
      url: server.url,
      apiVersion: server.apiVersion,
      eventStream: 'degraded',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(startOperation).not.toHaveBeenCalled();
    await server.disconnect();
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
      apiVersion: server.apiVersion,
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
      apiVersion: server.apiVersion,
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

  it('does not gate healthy launch attachment on lifecycle ownership confirmation', async () => {
    const server = new OpenCodeServer(4096, true);
    const { api, children } = configureManagedStartup(server, false);
    api.readHealthInfo = vi
      .fn()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValue({ healthy: true, version: MINIMUM_SUPPORTED_OPENCODE_VERSION });
    const { processManager } = server as unknown as { processManager: OpenCodeProcess };
    const ownership = vi
      .spyOn(processManager, 'confirmManagedServerOwnership')
      .mockResolvedValue(false);
    const connection = vi
      .spyOn(processManager, 'confirmManagedServerConnection')
      .mockResolvedValue(true);
    vi.spyOn(processManager, 'hasCredentialVerifiedConnection', 'get').mockReturnValue(true);
    vi.spyOn(processManager, 'verifyManagedServerAdmission').mockResolvedValue(true);
    vi.mocked(inspectLocalServerAccount).mockResolvedValue({ kind: 'unknown' });
    const started = server.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    await expect(started).resolves.toBe(server.url);
    expect(connection).toHaveBeenCalledOnce();
    expect(ownership).not.toHaveBeenCalled();
    expect(server.status.state).toBe('running');
    expect(server.isAttachOnly).toBe(true);
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    await expect(server.restart()).rejects.toThrow('attach-only');
    await server.disconnect();
    expect(children[0]!.kill).not.toHaveBeenCalled();
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

  it('bounds managed process output logging during a noisy stream', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await expect(server.start()).resolves.toBe(server.url);
    loggerMock.info.mockClear();

    for (let index = 0; index < 100; index += 1) {
      children[0]!.stdout.emit('data', Buffer.alloc(64 * 1024, 'x'));
    }

    expect(loggerMock.info.mock.calls.length).toBeLessThan(100);
    expect(
      loggerMock.info.mock.calls.reduce((length, [message]) => length + message.length, 0)
    ).toBeLessThan(256 * 1024);
  });

  it('bounds logger calls for a stream of tiny process chunks', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await expect(server.start()).resolves.toBe(server.url);
    loggerMock.info.mockClear();

    for (let index = 0; index < 1_000; index += 1) {
      children[0]!.stdout.emit('data', Buffer.from('x'));
    }

    expect(loggerMock.info.mock.calls.length).toBeLessThanOrEqual(256);
  });

  it('stops decoding stdout chunks after the process log budget is exhausted', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await expect(server.start()).resolves.toBe(server.url);
    const toString = vi.spyOn(Buffer.prototype, 'toString');

    for (let index = 0; index < 256; index += 1) {
      children[0]!.stdout.emit('data', Buffer.from('x'));
    }
    const decodedAtLimit = toString.mock.calls.length;
    for (let index = 0; index < 1_000; index += 1) {
      children[0]!.stdout.emit('data', Buffer.from('ignored'));
    }

    expect(toString).toHaveBeenCalledTimes(decodedAtLimit);
  });

  it('charges whitespace-only chunks against the process log budget', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await expect(server.start()).resolves.toBe(server.url);
    const toString = vi.spyOn(Buffer.prototype, 'toString');

    for (let index = 0; index < 256; index += 1) {
      children[0]!.stdout.emit('data', Buffer.alloc(64 * 1024, ' '));
    }
    const decodedAtLimit = toString.mock.calls.length;
    for (let index = 0; index < 1_000; index += 1) {
      children[0]!.stdout.emit('data', Buffer.alloc(64 * 1024, ' '));
    }

    expect(toString).toHaveBeenCalledTimes(decodedAtLimit);
  });

  it('decodes only a bounded prefix of one oversized stdout chunk', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server);
    await expect(server.start()).resolves.toBe(server.url);
    const chunk = Buffer.alloc(16 * 1024 * 1024, 'x');
    const fullDecode = vi.spyOn(chunk, 'toString');

    children[0]!.stdout.emit('data', chunk);

    const decodedLengths = fullDecode.mock.contexts.flatMap((context, index) =>
      fullDecode.mock.calls[index]?.[0] === 'hex' || !Buffer.isBuffer(context)
        ? []
        : [context.length]
    );
    expect(Math.max(...decodedLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(loggerMock.info.mock.calls.at(-1)?.[0].length).toBeLessThan(17 * 1024);
  });

  it('bounds stderr decoding while managed startup is still pending', async () => {
    const server = new OpenCodeServer(4096, true);
    const { children } = configureManagedStartup(server, false);
    const startPromise = server.start();
    const startResult = expect(startPromise).rejects.toThrow('Server start was cancelled');
    await flushMicrotasks();
    await flushMicrotasks();
    const toString = vi.spyOn(Buffer.prototype, 'toString');

    for (let index = 0; index < 1_000; index += 1) {
      children[0]!.stderr.emit('data', Buffer.alloc(64 * 1024, 'x'));
    }

    const decodedBytes = toString.mock.contexts.reduce(
      (total, context) => total + (Buffer.isBuffer(context) ? context.length : 0),
      0
    );
    expect(decodedBytes).toBeLessThan(2 * 1024 * 1024);
    await server.dispose();
    await startResult;
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
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'stopped']);
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
    // Managed startup skips the CLI preflight on Windows.
    stubPlatform('linux');
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
    await (server as unknown as { admission: ServerConnectionAdmission }).admission.admit();
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

    expect(server.status.state).not.toBe('running');
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
    expect(server.status.state).not.toBe('running');
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

  it('selects another automatic port and retries quickly after a collision', async () => {
    const server = new OpenCodeServer('auto', true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: 1 });
    const processManager = getProcessManager(server);

    const startResult = server.start();
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    const occupiedPort = processManager.port;

    crashDuringStartup(children[0]!, 'Error: listen EADDRINUSE: address already in use :::4096');
    await settleRecovery();
    expect(processManager.hasPortInUseDetected()).toBe(false);
    expect(processManager.port).not.toBe(occupiedPort);
    expect(processManager.port).toBeGreaterThanOrEqual(49_152);

    await vi.advanceTimersByTimeAsync(100);
    await expect(startResult).resolves.toBe(server.url);
    expect(children).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      `Port ${occupiedPort} in use by another process; retrying on ${processManager.port}`
    );
  });

  it('keeps advancing ports while successive attempts hit a used port', async () => {
    const server = new OpenCodeServer('auto', true);
    const { children } = configureFailingStartup(server, { resolveAfterAttempt: 2 });
    const processManager = getProcessManager(server);

    const startResult = server.start();
    await flushMicrotasks();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const previousPort = processManager.port;
      crashDuringStartup(children[children.length - 1]!, 'listen EADDRINUSE :::4096');
      await settleRecovery();
      expect(processManager.port).not.toBe(previousPort);
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
