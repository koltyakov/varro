import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, logWarn } from './log';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

afterEach(() => {
  delete window.__sendToExtension;
});

describe('log helpers', () => {
  it('posts error-level log messages', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    logError('loadSession', new Error('offline'));

    expect(send).toHaveBeenCalledWith({
      type: 'log',
      payload: { msg: 'loadSession', error: 'offline', level: 'error' },
    });
  });

  it('posts warn-level log messages with error details', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    logWarn('browser-persistence:remove:key', new Error('quota exceeded'));
    logWarn('browser-persistence:remove:key', 'plain string');

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'log',
      payload: {
        msg: 'browser-persistence:remove:key',
        error: 'quota exceeded',
        level: 'warn',
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'log',
      payload: { msg: 'browser-persistence:remove:key', error: 'plain string', level: 'warn' },
    });
  });

  it('omits the error field when no detail is provided', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    logWarn('session-event syncSession after session.idle');

    expect(send).toHaveBeenCalledWith({
      type: 'log',
      payload: { msg: 'session-event syncSession after session.idle', level: 'warn' },
    });
  });
});
