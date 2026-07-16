import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './extension-message';
import { isPermissionMode, parseServerEvent, type ExtensionMessage } from './protocol';

describe('protocol parsers', () => {
  it('recognizes only supported permission modes', () => {
    expect(['default', 'auto', 'full'].every(isPermissionMode)).toBe(true);
    expect(['', 'Default', 'ask', null, undefined].some(isPermissionMode)).toBe(false);
  });

  it('validator round-trips a server/status running payload', () => {
    const msg: ExtensionMessage = {
      type: 'server/status',
      payload: { state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' },
    };
    expect(parseExtensionMessage(msg)).toEqual(msg);
  });

  it('parses wrapped OpenCode global event payloads', () => {
    expect(
      parseServerEvent({
        directory: '/repo',
        payload: {
          id: 'event-1',
          type: 'session.updated',
          properties: {
            sessionID: 'session-1',
            info: {
              id: 'session-1',
              title: 'Implement parser fix',
            },
          },
        },
      })
    ).toEqual({
      type: 'session.updated',
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'session-1',
          title: 'Implement parser fix',
        },
      },
    });
  });

  it('parses wrapped OpenCode sync event payloads', () => {
    expect(
      parseServerEvent({
        directory: '/repo',
        payload: {
          type: 'sync',
          name: 'session.updated.1',
          id: 'event-1',
          seq: 42,
          aggregateID: 'sessionID',
          data: {
            sessionID: 'session-1',
            info: {
              id: 'session-1',
              title: 'Implement sync parser fix',
            },
          },
        },
      })
    ).toEqual({
      type: 'session.updated',
      seq: 42,
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'session-1',
          title: 'Implement sync parser fix',
        },
      },
    });
  });

  it('parses wrapped OpenCode v2 syncEvent payloads', () => {
    expect(
      parseServerEvent({
        directory: '/repo',
        payload: {
          type: 'sync',
          id: 'event-1',
          syncEvent: {
            type: 'session.next.text.ended.1',
            id: 'event-2',
            seq: 42,
            aggregateID: 'session-1',
            data: {
              timestamp: 1_234,
              sessionID: 'session-1',
              assistantMessageID: 'message-1',
              textID: 'text-1',
              text: 'done',
            },
          },
        },
      })
    ).toEqual({
      type: 'session.next.text.ended',
      seq: 42,
      properties: {
        timestamp: 1_234,
        sessionID: 'session-1',
        assistantMessageID: 'message-1',
        textID: 'text-1',
        text: 'done',
      },
    });
  });

  it('parses direct OpenCode sync events', () => {
    expect(
      parseServerEvent({
        type: 'sync',
        name: 'message.updated.1',
        id: 'event-1',
        seq: 42,
        aggregateID: 'sessionID',
        data: {
          sessionID: 'session-1',
          info: {
            id: 'message-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
          },
        },
      })
    ).toEqual({
      type: 'message.updated',
      seq: 42,
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
      },
    });
  });

  it('parses direct OpenCode events with data payloads', () => {
    expect(
      parseServerEvent({
        type: 'session.updated',
        data: {
          sessionID: 'session-1',
          info: {
            id: 'session-1',
            title: 'Fix chat titles',
          },
        },
      })
    ).toEqual({
      type: 'session.updated',
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'session-1',
          title: 'Fix chat titles',
        },
      },
    });
  });

  it('preserves seq when present on direct event payloads', () => {
    expect(
      parseServerEvent({
        id: 'evt_1',
        type: 'session.next.text.ended',
        version: 1,
        seq: 7,
        data: {
          sessionID: 'session-1',
          assistantMessageID: 'message-1',
          textID: 'text-1',
          text: 'done',
        },
      })
    ).toEqual({
      type: 'session.next.text.ended',
      seq: 7,
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'message-1',
        textID: 'text-1',
        text: 'done',
      },
    });
  });

  it('preserves durable seq from current OpenCode event payloads', () => {
    expect(
      parseServerEvent({
        id: 'evt_1',
        type: 'session.next.text.ended',
        durable: { aggregateID: 'session-1', seq: 8, version: 1 },
        data: {
          sessionID: 'session-1',
          assistantMessageID: 'message-1',
          textID: 'text-1',
          text: 'done',
        },
      })
    ).toEqual({
      type: 'session.next.text.ended',
      seq: 8,
      properties: {
        sessionID: 'session-1',
        assistantMessageID: 'message-1',
        textID: 'text-1',
        text: 'done',
      },
    });
  });

  it('parses direct v2 lifecycle events', () => {
    expect(
      parseServerEvent({
        id: 'evt_1',
        type: 'server.connected',
        properties: {},
      })
    ).toEqual({
      type: 'server.connected',
      properties: {},
    });
  });

  it('parses latest OpenCode event names', () => {
    expect(
      parseServerEvent({
        id: 'evt_1',
        type: 'session.next.revert.staged',
        data: {
          timestamp: 1_234,
          sessionID: 'session-1',
          revert: { messageID: 'message-1' },
        },
      })
    ).toEqual({
      type: 'session.next.revert.staged',
      properties: {
        timestamp: 1_234,
        sessionID: 'session-1',
        revert: { messageID: 'message-1' },
      },
    });

    expect(
      parseServerEvent({
        id: 'evt_2',
        type: 'lsp.client.diagnostics',
        properties: {
          serverID: 'tsserver',
          path: '/repo/src/app.ts',
        },
      })
    ).toEqual({
      type: 'lsp.client.diagnostics',
      properties: {
        serverID: 'tsserver',
        path: '/repo/src/app.ts',
      },
    });
  });

  it('parses OpenCode session.error events', () => {
    expect(
      parseServerEvent({
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: { name: 'UnknownError', data: { message: 'Command failed' } },
        },
      })
    ).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'UnknownError', data: { message: 'Command failed' } },
      },
    });
  });
});
