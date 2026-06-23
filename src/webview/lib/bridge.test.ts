import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

let cleanup: (() => void) | null = null;

async function loadBridge() {
  const bridge = await import('./bridge');
  cleanup = bridge.cleanupBridge;
  return bridge;
}

beforeEach(() => {
  vi.resetModules();
  cleanup = null;
  delete window.__sendToExtension;
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.__sendToExtension;
});

describe('bridge', () => {
  it('subscribes and unsubscribes message handlers', async () => {
    const bridge = await loadBridge();
    const handler = vi.fn();
    const stop = bridge.onMessage(handler);
    const firstMessage = { type: 'command/focus-input' };

    window.dispatchEvent(new MessageEvent('message', { data: firstMessage }));
    stop();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'command/abort' } }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(firstMessage);
  });

  it('sends API request bodies without cloning and resolves matching responses', async () => {
    const bridge = await loadBridge();
    const send = vi.fn();
    const body = { nested: { value: 1 } };

    window.__sendToExtension = send;
    const request = bridge.apiCall<{ ok: boolean }>('POST', '/session', body);
    const message = send.mock.calls[0]?.[0] as {
      payload: { id: number; body?: { nested: { value: number } } };
    };
    body.nested.value = 2;

    expect(message).toEqual({
      type: 'api/request',
      payload: {
        id: 1,
        method: 'POST',
        path: '/session',
        body: { nested: { value: 2 } },
      },
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'api/response',
          payload: { id: message.payload.id, data: { ok: true } },
        },
      })
    );

    await expect(request).resolves.toEqual({ ok: true });
    expect(message.payload.body).toBe(body);
  });

  it('rejects API requests when the extension returns an error', async () => {
    const bridge = await loadBridge();
    const send = vi.fn();

    window.__sendToExtension = send;
    const request = bridge.apiCall('DELETE', '/session/1');
    const rejection = expect(request).rejects.toThrow('permission denied');
    const firstCall = send.mock.calls[0] as [{ payload: { id: number } }] | undefined;
    if (!firstCall) throw new Error('Expected bridge request to be sent');
    const id = firstCall[0].payload.id;

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'api/response',
          payload: { id, error: 'permission denied' },
        },
      })
    );

    await rejection;
  });

  it('rejects pending API requests when the bridge is cleaned up', async () => {
    const bridge = await loadBridge();
    window.__sendToExtension = vi.fn();

    const request = bridge.apiCall('GET', '/session');
    const rejection = expect(request).rejects.toThrow('Bridge cleaned up');
    bridge.cleanupBridge();

    await rejection;
  });

  it('times out API requests that never receive a response', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    window.__sendToExtension = vi.fn();

    const request = bridge.apiCall('GET', '/slow');
    const rejection = expect(request).rejects.toThrow('API call timed out: GET /slow');
    await vi.advanceTimersByTimeAsync(35_000);

    await rejection;
  });

  it('uses the long timeout for async prompt requests', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    window.__sendToExtension = vi.fn();

    const request = bridge.apiCall('POST', '/session/1/prompt_async', { parts: [] });
    const rejection = expect(request).rejects.toThrow(
      'API call timed out: POST /session/1/prompt_async'
    );

    await vi.advanceTimersByTimeAsync(35_000);
    await Promise.resolve();
    expect(window.__sendToExtension).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
  });

  it('fails fast when the extension transport is unavailable', async () => {
    const bridge = await loadBridge();

    await expect(bridge.apiCall('GET', '/session')).rejects.toThrow(
      'Extension transport unavailable: GET /session'
    );
  });

  it('retries once when transport is unavailable during startup', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    const send = vi.fn();

    const request = bridge.apiCall<{ ok: boolean }>('GET', '/session');
    await Promise.resolve();

    window.__sendToExtension = send;
    await vi.advanceTimersByTimeAsync(150);

    const id = (send.mock.calls[0]?.[0] as { payload: { id: number } } | undefined)?.payload.id;
    if (!id) throw new Error('Expected retried request id');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'api/response', payload: { id, data: { ok: true } } },
      })
    );

    await expect(request).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight API requests', async () => {
    const bridge = await loadBridge();
    window.__sendToExtension = vi.fn();
    const controller = new AbortController();

    const request = bridge.apiCall('GET', '/session', undefined, { signal: controller.signal });
    controller.abort(new Error('request cancelled'));

    await expect(request).rejects.toThrow('request cancelled');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const bridge = await loadBridge();
    window.__sendToExtension = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));

    await expect(
      bridge.apiCall('GET', '/session', undefined, { signal: controller.signal })
    ).rejects.toThrow('already cancelled');

    expect(window.__sendToExtension).not.toHaveBeenCalled();
    bridge.cleanupBridge();
  });
});
