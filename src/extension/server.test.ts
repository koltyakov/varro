import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '../shared/protocol';

type ShowMessageMock = (message: string, ...items: string[]) => Promise<string | undefined>;

const { loggerMock, vscodeMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

import { OpenCodeServer } from './server';

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
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

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await server.dispose();
    await flushMicrotasks();
  });

  it('clears pending restart timers during dispose', async () => {
    const server = new OpenCodeServer(4096, false);
    const restart = vi.fn();
    setRestartTimer(server, setTimeout(restart, 1_000));

    await server.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

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

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await server.dispose();
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
});
