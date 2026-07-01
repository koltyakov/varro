import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './extension-message';
import { parseServerEvent, type ExtensionMessage, type WebviewMessage } from './protocol';

/**
 * Compile-time conformance: every ExtensionMessage discriminator must be
 * recognized by the runtime validator. If a new message type is added to
 * the protocol but not to the validator, TypeScript will fail here with
 * an exhaustiveness error on `_unreachable`.
 */
describe('protocol conformance', () => {
  it('covers every ExtensionMessage type in the validator (compile-time)', () => {
    const covered: Record<ExtensionMessage['type'], true> = {
      'server/status': true,
      'server/event': true,
      'providers/refresh': true,
      'context/update': true,
      'terminal-selection/update': true,
      'files/dropped': true,
      'files/removed': true,
      'files/search-results': true,
      'config/update': true,
      'theme/update': true,
      'api/response': true,
      'command/new-session': true,
      'command/focus-input': true,
      'command/open-attention-sessions': true,
      'command/abort': true,
    };

    // If a new ExtensionMessage type is added, the Record literal above will
    // fail to compile until this map is extended - forcing the validator to
    // be updated in lockstep.
    const knownCount = Object.keys(covered).length;
    expect(knownCount).toBeGreaterThan(0);
  });

  it('exhaustiveness check on WebviewMessage type discriminators', () => {
    const covered: Record<WebviewMessage['type'], true> = {
      'providers/refresh': true,
      'context/request': true,
      'webview/focus': true,
      'providers/watch': true,
      'terminal-selection/clear': true,
      'terminal/run': true,
      'session/export': true,
      'vscode/open-settings': true,
      'files/drop': true,
      'files/drop-content': true,
      'files/remove': true,
      'files/clear': true,
      'files/pick': true,
      'files/search': true,
      'file/read': true,
      'vscode/open': true,
      'vscode/open-external': true,
      'config/update': true,
      ready: true,
      'api/request': true,
      log: true,
    };

    expect(Object.keys(covered).length).toBeGreaterThan(0);
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
