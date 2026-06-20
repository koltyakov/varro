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
  scopeOpenCodeRequest: vi.fn((baseUrl: string, path: string, directory?: string) => ({
    url: new URL(path, baseUrl).toString(),
    directory,
  })),
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
});

describe('OpenCodeTransport event stream path', () => {
  it('subscribes to the v2 /api/event stream', async () => {
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

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4096/api/event');
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
