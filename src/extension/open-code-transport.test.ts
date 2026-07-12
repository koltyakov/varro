import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warnMock, updateEventStreamStateMock, emitEventMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  updateEventStreamStateMock: vi.fn(),
  emitEventMock: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  },
}));

vi.mock('./util/opencode-request', () => ({
  getOpenCodeDirectoryHeaders: vi.fn(() => ({})),
  scopeOpenCodeRequest: vi.fn((baseUrl: string, path: string, directory?: string) => {
    const url = new URL(path, baseUrl);
    if (directory && !url.pathname.startsWith('/global/')) {
      url.searchParams.set('directory', directory);
      if (url.pathname.startsWith('/api/')) {
        url.searchParams.set('location[directory]', directory);
      }
    }
    return { url: url.toString(), directory };
  }),
}));

import { OpenCodeTransport } from './open-code-transport';
import { getOpenCodeDirectoryHeaders, scopeOpenCodeRequest } from './util/opencode-request';

function createTransport() {
  return new OpenCodeTransport({
    getUrl: () => 'http://localhost:4096',
    getWorkspaceCwd: () => undefined,
    getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
    isDisposing: () => false,
    updateEventStreamState: updateEventStreamStateMock,
    emitEvent: emitEventMock,
  });
}

function createPendingEventResponse(signal: AbortSignal) {
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<never>((_, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
                { once: true }
              );
            }),
        };
      },
    },
  } as unknown as Response;
}

function createClosedEventResponse() {
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: () => Promise.resolve({ value: undefined, done: true }),
        };
      },
    },
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('OpenCodeTransport reconnect delay', () => {
  it('keeps lower-bound jitter after reaching the max reconnect delay', () => {
    const transport = createTransport() as unknown as {
      eventReconnectDelay: number;
      getEventReconnectDelay(): number;
    };
    transport.eventReconnectDelay = 30_000;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(transport.getEventReconnectDelay()).toBe(24_000);
  });

  it('still caps the upper-bound reconnect jitter at the max delay', () => {
    const transport = createTransport() as unknown as {
      eventReconnectDelay: number;
      getEventReconnectDelay(): number;
    };
    transport.eventReconnectDelay = 30_000;
    vi.spyOn(Math, 'random').mockReturnValue(1);

    expect(transport.getEventReconnectDelay()).toBe(30_000);
  });

  it('clears the connect timeout when opening the stream fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failed')));

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => undefined,
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => true,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.startEventStream();
    await vi.advanceTimersByTimeAsync(10_001);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith('Event stream error: network failed');
  });

  it('keeps backing off when successful event stream responses close immediately', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi.fn().mockResolvedValue(createClosedEventResponse());
    vi.stubGlobal('fetch', fetchMock);
    const transport = createTransport() as unknown as {
      startEventStream(): Promise<void>;
      stopEventStream(): void;
      eventReconnectDelay: number;
    };

    await transport.startEventStream();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.eventReconnectDelay).toBe(2_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.eventReconnectDelay).toBe(4_000);
    transport.stopEventStream();
  });

  it('resets reconnect backoff after an event stream remains stable', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        signal = init?.signal as AbortSignal;
        return createPendingEventResponse(signal);
      })
    );
    const transport = createTransport() as unknown as {
      startEventStream(): Promise<void>;
      stopEventStream(): void;
      eventReconnectDelay: number;
      eventReconnectCount: number;
    };
    transport.eventReconnectDelay = 8_000;
    transport.eventReconnectCount = 3;

    const stream = transport.startEventStream();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(transport.eventReconnectDelay).toBe(8_000);
    expect(transport.eventReconnectCount).toBe(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(transport.eventReconnectDelay).toBe(1_000);
    expect(transport.eventReconnectCount).toBe(0);

    transport.stopEventStream();
    await stream;
  });
});

describe('OpenCodeTransport event stream path', () => {
  it('subscribes to the global event stream', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('stop'));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => undefined,
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => true,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.startEventStream();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4096/global/event');
  });

  it('sends the workspace header without adding query scope to the global stream', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('stop'));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => '/repo',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => true,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.startEventStream();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4096/global/event');
    expect(scopeOpenCodeRequest).toHaveBeenCalledWith(
      'http://localhost:4096',
      '/global/event',
      '/repo'
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenCalledWith('/repo');
  });

  it('filters global event envelopes to the active workspace', () => {
    const transport = createTransport() as unknown as {
      eventStreamDirectory: string;
      processSseChunk(chunk: string): void;
    };
    transport.eventStreamDirectory = '/repo-a';
    const matchingEvent = {
      directory: '/repo-a',
      payload: { type: 'session.created', properties: { info: { id: 'session-1' } } },
    };

    transport.processSseChunk(
      `data: ${JSON.stringify({
        directory: '/repo-b',
        payload: { type: 'session.created', properties: { info: { id: 'session-2' } } },
      })}`
    );
    transport.processSseChunk(`data: ${JSON.stringify(matchingEvent)}`);

    expect(emitEventMock).toHaveBeenCalledTimes(1);
    expect(emitEventMock).toHaveBeenCalledWith(matchingEvent);
  });

  it('tracks direct v2 permission events from properties payloads', () => {
    const transport = createTransport() as unknown as {
      observeServerEvent(event: unknown): void;
      hasPendingAttentionRequests(): boolean;
    };

    transport.observeServerEvent({
      id: 'evt_1',
      type: 'permission.asked',
      properties: {
        id: 'permission-1',
        sessionID: 'session-1',
        permission: 'bash',
        patterns: ['*'],
        metadata: {},
        always: [],
      },
    });

    expect(transport.hasPendingAttentionRequests()).toBe(true);

    transport.observeServerEvent({
      id: 'evt_2',
      type: 'permission.replied',
      properties: { sessionID: 'session-1', requestID: 'permission-1', reply: 'once' },
    });

    expect(transport.hasPendingAttentionRequests()).toBe(false);
  });

  it('tracks direct v2 permission events from data payloads', () => {
    const transport = createTransport() as unknown as {
      observeServerEvent(event: unknown): void;
      hasPendingAttentionRequests(): boolean;
    };

    transport.observeServerEvent({
      id: 'evt_1',
      type: 'permission.asked',
      data: { id: 'permission-1', sessionID: 'session-1' },
    });
    expect(transport.hasPendingAttentionRequests()).toBe(true);

    transport.observeServerEvent({
      id: 'evt_2',
      type: 'permission.replied',
      data: { requestID: 'permission-1', sessionID: 'session-1' },
    });
    expect(transport.hasPendingAttentionRequests()).toBe(false);
  });

  it('clears direct v2 attention requests when a session is deleted', () => {
    const transport = createTransport() as unknown as {
      observeServerEvent(event: unknown): void;
      hasPendingAttentionRequests(): boolean;
    };

    transport.observeServerEvent({
      id: 'evt_1',
      type: 'question.asked',
      properties: { id: 'question-1', sessionID: 'session-1', questions: [] },
    });
    expect(transport.hasPendingAttentionRequests()).toBe(true);

    transport.observeServerEvent({
      id: 'evt_2',
      type: 'session.deleted',
      properties: { sessionID: 'session-1', info: { id: 'session-1' } },
    });

    expect(transport.hasPendingAttentionRequests()).toBe(false);
  });

  it('keeps REST on the connected scope until a replacement stream connects', async () => {
    let resolveReplacement!: (response: Response) => void;
    let replacementSignal: AbortSignal | undefined;
    let eventRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/global/event') {
        return Promise.resolve({ ok: true, text: async () => '{}' } as Response);
      }
      eventRequests += 1;
      if (eventRequests === 1) {
        return Promise.resolve(createPendingEventResponse(init!.signal as AbortSignal));
      }
      replacementSignal = init!.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveReplacement = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => '/repo-a',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    void transport.startEventStream();
    await vi.waitFor(() => expect(eventRequests).toBe(1));
    const rescope = transport.rescopeEventStream('/repo-b');
    await vi.waitFor(() => expect(eventRequests).toBe(2));

    await transport.request('POST', '/session', {});
    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session',
      '/repo-a'
    );

    resolveReplacement(createPendingEventResponse(replacementSignal!));
    await expect(rescope).resolves.toEqual({ state: 'connected', directory: '/repo-b' });
    await transport.request('POST', '/session', {});
    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session',
      '/repo-b'
    );
    transport.stopEventStream();
  });

  it('commits the new REST scope after a bounded degraded wait', async () => {
    vi.useFakeTimers();
    let eventRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/global/event') {
        return Promise.resolve({ ok: true, text: async () => '{}' } as Response);
      }
      eventRequests += 1;
      if (eventRequests === 1) {
        return Promise.resolve(createPendingEventResponse(init!.signal as AbortSignal));
      }
      return new Promise<Response>((_, reject) => {
        const signal = init!.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => '/repo-a',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    void transport.startEventStream();
    await vi.waitFor(() => expect(eventRequests).toBe(1));
    const rescope = transport.rescopeEventStream('/repo-b');
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(rescope).resolves.toEqual({ state: 'degraded', directory: '/repo-b' });
    await transport.request('POST', '/session', {});
    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session',
      '/repo-b'
    );
    transport.stopEventStream();
  });

  it('cancels a pending scope without moving REST when the stream stops', async () => {
    let eventRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/global/event') {
        return Promise.resolve({ ok: true, text: async () => '{}' } as Response);
      }
      eventRequests += 1;
      if (eventRequests === 1) {
        return Promise.resolve(createPendingEventResponse(init!.signal as AbortSignal));
      }
      return new Promise<Response>((_, reject) => {
        const signal = init!.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => '/repo-a',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    void transport.startEventStream();
    await vi.waitFor(() => expect(eventRequests).toBe(1));
    const rescope = transport.rescopeEventStream('/repo-b');
    transport.stopEventStream();

    await expect(rescope).resolves.toEqual({ state: 'cancelled', directory: '/repo-b' });
    await transport.request('POST', '/session', {});
    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session',
      '/repo-a'
    );
  });

  it('supersedes B and commits only C during rapid scope changes', async () => {
    let eventRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/global/event') {
        return Promise.resolve({ ok: true, text: async () => '{}' } as Response);
      }
      eventRequests += 1;
      if (eventRequests === 1 || eventRequests === 3) {
        return Promise.resolve(createPendingEventResponse(init!.signal as AbortSignal));
      }
      return new Promise<Response>((_, reject) => {
        const signal = init!.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => '/repo-a',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    void transport.startEventStream();
    await vi.waitFor(() => expect(eventRequests).toBe(1));
    const scopeB = transport.rescopeEventStream('/repo-b');
    const scopeC = transport.rescopeEventStream('/repo-c');

    await expect(scopeB).resolves.toEqual({ state: 'superseded', directory: '/repo-b' });
    await expect(scopeC).resolves.toEqual({ state: 'connected', directory: '/repo-c' });
    await transport.request('POST', '/session', {});
    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session',
      '/repo-c'
    );
    transport.stopEventStream();
  });
});

describe('OpenCodeTransport requests', () => {
  it('only sends JSON content type when forwarding a request body', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const transport = createTransport();

    await transport.request('GET', '/session');
    await transport.request('POST', '/session', {});

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({});
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{}');
  });

  it('preserves structured server error details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ detail: 'Unsupported content type' }),
      })) as unknown as typeof fetch
    );

    await expect(
      createTransport().request('PATCH', '/session/session-1', { title: 'x' })
    ).rejects.toThrow('400 Unsupported content type');
  });

  it('captures the next message cursor when requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => '[]',
        headers: new Headers({ 'x-next-cursor': 'cursor-2' }),
      })) as unknown as typeof fetch
    );

    await expect(
      createTransport().request('GET', '/session/session-1/message?limit=200', undefined, {
        captureNextCursor: true,
      })
    ).resolves.toEqual({ data: [], nextCursor: 'cursor-2' });
  });
});

describe('OpenCodeTransport request scoping', () => {
  it('keeps session reads scoped on non-Windows platforms', async () => {
    stubPlatform('darwin');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '[]' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => 'C:\\Users\\Andrew\\Projects\\Varro',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.request('GET', '/session');
    await transport.request('DELETE', '/session/session-1');

    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096',
      '/session',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4096',
      '/session/session-1',
      undefined
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenNthCalledWith(
      1,
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenNthCalledWith(2, undefined);
  });

  it('keeps session reads unscoped on Windows while still scoping writes', async () => {
    stubPlatform('win32');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => 'C:\\Users\\Andrew\\Projects\\Varro',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.request('GET', '/session');
    await transport.request('POST', '/session', {});
    await transport.request('GET', '/session/session-1/message');
    await transport.request('POST', '/session/session-1/prompt_async', { parts: [] });

    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096',
      '/session',
      undefined
    );
    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4096',
      '/session',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      3,
      'http://localhost:4096',
      '/session/session-1/message',
      undefined
    );
    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      4,
      'http://localhost:4096',
      '/session/session-1/prompt_async',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
  });

  it('does not scope session metadata and message fetches on Windows', async () => {
    stubPlatform('win32');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '[]' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => 'C:\\Users\\Andrew\\Projects\\Varro',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.request('GET', '/session/session-1');
    await transport.request('GET', '/session/session-1/message');

    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096',
      '/session/session-1',
      undefined
    );
    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4096',
      '/session/session-1/message',
      undefined
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenNthCalledWith(1, undefined);
    expect(getOpenCodeDirectoryHeaders).toHaveBeenNthCalledWith(2, undefined);
  });

  it('keeps session metadata and message fetches scoped on non-Windows platforms', async () => {
    stubPlatform('darwin');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '[]' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => 'C:\\Users\\Andrew\\Projects\\Varro',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.request('GET', '/session/session-1');
    await transport.request('GET', '/session/session-1/message');

    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096',
      '/session/session-1',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(scopeOpenCodeRequest).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4096',
      '/session/session-1/message',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenNthCalledWith(
      1,
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenNthCalledWith(
      2,
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
  });

  it('scopes prompt_async session sends to the current workspace directory', async () => {
    stubPlatform('win32');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => 'C:\\Users\\Andrew\\Projects\\Varro',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.request('POST', '/session/session-1/prompt_async', { parts: [] });

    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session/session-1/prompt_async',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
    expect(getOpenCodeDirectoryHeaders).toHaveBeenLastCalledWith(
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
  });

  it('still scopes session creation to the current workspace directory', async () => {
    stubPlatform('win32');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => 'C:\\Users\\Andrew\\Projects\\Varro',
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: updateEventStreamStateMock,
      emitEvent: emitEventMock,
    });

    await transport.request('POST', '/session', {});

    expect(scopeOpenCodeRequest).toHaveBeenLastCalledWith(
      'http://localhost:4096',
      '/session',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );
  });
});
