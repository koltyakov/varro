import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './extension-message';
import {
  createSessionWorkspaceMetadata,
  getSessionWorkspaceScopeFromMetadata,
  isPermissionMode,
  isSafePersistedSessionId,
  isSessionWorkspaceScope,
  parseServerEvent,
  type ExtensionMessage,
  type WebviewMessage,
} from './protocol';

describe('protocol parsers', () => {
  it('recognizes only supported permission modes', () => {
    expect(['default', 'auto', 'full'].every(isPermissionMode)).toBe(true);
    expect(['', 'Default', 'edits', 'ask', null, undefined].some(isPermissionMode)).toBe(false);
  });

  it('accepts only bounded control-free prototype-safe persisted session IDs', () => {
    expect(isSafePersistedSessionId('session-1')).toBe(true);
    expect(isSafePersistedSessionId('x'.repeat(512))).toBe(true);
    expect(
      [
        '',
        '__proto__',
        'constructor',
        'prototype',
        'x'.repeat(513),
        'session\0other',
        'session\nother',
        'session\rother',
        'session\tother',
        'session\u007fother',
      ].some(isSafePersistedSessionId)
    ).toBe(false);
  });

  it('keeps permission automation session ownership outside the OpenCode body', () => {
    const message: WebviewMessage = {
      type: 'api/request',
      payload: {
        id: 1,
        method: 'POST',
        path: '/permission/permission-1/reply',
        body: { reply: 'once' },
        permissionAutomationLease: 4,
        permissionAutomationSessionID: 'session-1',
      },
    };

    expect(message.payload).toMatchObject({
      permissionAutomationLease: 4,
      permissionAutomationSessionID: 'session-1',
      body: { reply: 'once' },
    });
  });

  it('recognizes only supported session workspace scopes', () => {
    expect(['workspace', 'folder'].every(isSessionWorkspaceScope)).toBe(true);
    expect(['', 'Workspace', 'all', null, undefined].some(isSessionWorkspaceScope)).toBe(false);
  });

  it('round-trips namespaced session workspace metadata', () => {
    const metadata = createSessionWorkspaceMetadata('workspace');
    expect(metadata).toEqual({
      varro: { workspaceScope: 'workspace', schemaVersion: 1 },
    });
    expect(getSessionWorkspaceScopeFromMetadata(metadata)).toBe('workspace');
    expect(getSessionWorkspaceScopeFromMetadata({ varro: { workspaceScope: 'other' } })).toBeNull();
    expect(getSessionWorkspaceScopeFromMetadata(null)).toBeNull();
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
      id: 'event-1',
      type: 'session.updated',
      workspaceDirectory: '/repo',
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'session-1',
          title: 'Implement parser fix',
        },
      },
    });
  });

  it('drops oversized server event IDs before they enter dedupe caches', () => {
    expect(
      parseServerEvent({
        id: 'x'.repeat(513),
        type: 'server.connected',
        properties: {},
      })
    ).toEqual({ type: 'server.connected', properties: {} });
  });

  it('preserves the workspace from direct event locations', () => {
    expect(
      parseServerEvent({
        type: 'catalog.updated',
        location: { directory: '/repo-b' },
        properties: {},
      })
    ).toEqual({
      type: 'catalog.updated',
      workspaceDirectory: '/repo-b',
      properties: {},
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
      id: 'event-1',
      type: 'session.updated',
      workspaceDirectory: '/repo',
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
      id: 'event-2',
      type: 'session.next.text.ended',
      workspaceDirectory: '/repo',
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
      id: 'event-1',
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

  it('parses legacy durable compaction deltas', () => {
    expect(
      parseServerEvent({
        type: 'sync',
        name: 'session.next.compaction.delta.1',
        id: 'event-1',
        seq: 9,
        aggregateID: 'session-1',
        data: {
          sessionID: 'session-1',
          messageID: 'message-1',
          text: 'summary',
        },
      })
    ).toEqual({
      id: 'event-1',
      type: 'session.next.compaction.delta',
      seq: 9,
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        text: 'summary',
      },
    });
  });

  it('preserves Varro sequence-only event upgrades', () => {
    expect(
      parseServerEvent({
        id: 'event-1',
        type: 'session.updated',
        seq: 2,
        sequenceOnly: true,
        sequenceStart: 1,
        properties: { sessionID: 'session-1', info: { id: 'session-1' } },
      })
    ).toEqual({
      id: 'event-1',
      type: 'session.updated',
      seq: 2,
      sequenceOnly: true,
      sequenceStart: 1,
      properties: { sessionID: 'session-1', info: { id: 'session-1' } },
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
      id: 'evt_1',
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
      id: 'evt_1',
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
      id: 'evt_1',
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
      id: 'evt_1',
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
      id: 'evt_2',
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
