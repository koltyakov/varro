import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '../shared/protocol';

const { loggerMock, vscodeMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  vscodeMock: {
    window: {
      activeTextEditor: undefined,
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

function setRunning(server: OpenCodeServer) {
  (
    server as unknown as {
      setRunningStatus: (url?: string, eventStream?: 'healthy' | 'degraded') => void;
    }
  ).setRunningStatus(server.url, 'healthy');
}

function startEventStream(server: OpenCodeServer) {
  return (server as unknown as { startEventStream: () => Promise<void> }).startEventStream();
}

function stopEventStream(server: OpenCodeServer) {
  (server as unknown as { stopEventStream: () => void }).stopEventStream();
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
});
