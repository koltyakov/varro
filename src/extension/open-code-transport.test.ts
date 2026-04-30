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

vi.mock('./rest-proxy', () => ({
  getOpenCodeDirectoryHeaders: vi.fn(() => ({})),
  scopeOpenCodeRequest: vi.fn((baseUrl: string, path: string, directory?: string) => ({
    url: new URL(path, baseUrl).toString(),
    directory,
  })),
}));

import { OpenCodeTransport } from './open-code-transport';

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
