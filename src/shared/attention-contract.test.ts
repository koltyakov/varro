/**
 * Contract test: the extension host (SessionStateManager) and the webview
 * (registerSessionEventHandlers -> permissionsStore) independently derive
 * "this session needs attention" from the same raw server events. If the two
 * derivations disagree, the status bar and the sidebar tell the user
 * different stories. This suite feeds identical permission/question event
 * streams to both real implementations and asserts they agree on the set of
 * pending attention requests.
 *
 * Scope: permission/question ask/reply events only. Session lifecycle
 * cleanup (session.deleted) flows through different webview machinery and is
 * covered by each side's own tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { Persistence } from './persistence';
import type { ServerEvent, ServerEventName } from './protocol';
import type { Permission, QuestionRequest } from './opencode-types';
import { registerSessionEventHandlers } from '../webview/hooks/session/session-event-handlers';
import { serverEvents } from '../webview/lib/client';
import { permissionsStore } from '../webview/lib/stores/permissions-store';

Reflect.defineProperty(vscode.window, 'createOutputChannel', {
  configurable: true,
  value: () => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() }),
});

const { SessionStateManager } = await import('../extension/session-state-manager');

type AttentionEntry = { sessionID: string; kind: 'permission' | 'question' };
type EventHandler = (event: ServerEvent) => void;
type RuntimeEventFixture<Properties> = {
  type: ServerEventName;
  properties: Properties;
};

const webviewAttention = new Map<string, AttentionEntry>();

function createWebviewSide() {
  webviewAttention.clear();
  const handlers = new Map<ServerEventName | '*', EventHandler>();
  vi.spyOn(permissionsStore, 'addPermission').mockImplementation((permission: Permission) => {
    webviewAttention.set(permission.id, {
      sessionID: permission.sessionID,
      kind: 'permission',
    });
  });
  vi.spyOn(permissionsStore, 'removePermission').mockImplementation((id: string) => {
    webviewAttention.delete(id);
  });
  vi.spyOn(permissionsStore, 'upsertQuestion').mockImplementation((question: QuestionRequest) => {
    webviewAttention.set(question.id, { sessionID: question.sessionID, kind: 'question' });
  });
  vi.spyOn(permissionsStore, 'removeResolvedQuestion').mockImplementation((id: string) => {
    webviewAttention.delete(id);
    return true;
  });
  vi.spyOn(serverEvents, 'on').mockImplementation((event, handler) => {
    // SAFETY: Each captured handler is invoked only with an event carrying its registered name.
    handlers.set(event, handler as EventHandler);
    return () => {
      handlers.delete(event);
    };
  });
  registerSessionEventHandlers({
    getActiveSessionId: () => null,
    getSessionStatus: () => undefined,
    isSessionTreeStatusWorking: () => false,
    getMessages: () => [],
    handoffTodosToMessages: vi.fn().mockReturnValue(true),
    upsertSession: vi.fn(),
    setSessionCompacting: vi.fn(),
    removeDeletedSessionTree: vi.fn(),
    shouldIgnorePendingAbortStatus: () => false,
    hasPendingAbort: () => false,
    markPendingAbort: vi.fn(),
    clearPendingAbort: vi.fn(),
    setSessionStatusEntry: vi.fn(),
    clearUsageLimitOnResumedProgress: vi.fn(),
    updateUsageLimitState: vi.fn(),
    syncSession: vi.fn().mockResolvedValue(undefined),
    shouldResyncSessionAfterIdle: () => false,
    syncSessionMessages: vi.fn().mockResolvedValue(undefined),
    recheckSessionStatus: vi.fn().mockResolvedValue(undefined),
    applyUsageLimitNotice: vi.fn(),
    syncTodosFromMessages: vi.fn(),
    shouldAutoApprovePermissions: () => false,
    respondPermission: vi.fn().mockResolvedValue(undefined),
    setDiffs: vi.fn(),
    abortRemoteSession: vi.fn().mockResolvedValue(true),
    logError: vi.fn(),
  });
  return handlers;
}

function createHostSide() {
  const storage = new Map<string, unknown>();
  const persistence: Persistence = {
    // SAFETY: This in-memory fixture returns values previously stored under the same typed key.
    get: <T>(key: string) => storage.get(key) as T | undefined,
    set: (key, value) => {
      storage.set(key, value);
    },
    remove: (key) => {
      storage.delete(key);
    },
  };
  return new SessionStateManager(
    persistence,
    { onStatusChange: vi.fn() },
    {
      shouldShow: () => false,
    }
  );
}

function attentionSnapshot(entries: Iterable<[string, AttentionEntry]>) {
  return new Set([...entries].map(([id, entry]) => `${entry.kind}:${id}:${entry.sessionID}`));
}

function runContract(events: ServerEvent[]) {
  const handlers = createWebviewSide();
  const manager = createHostSide();
  for (const event of events) {
    handlers.get(event.type)?.(event);
    manager.handleServerEvent(event);
  }
  return {
    webview: attentionSnapshot(webviewAttention.entries()),
    host: attentionSnapshot(manager.pending.entries()),
  };
}

function expectAgreement(events: ServerEvent[], expected: string[]) {
  const { webview, host } = runContract(events);
  expect(webview).toEqual(host);
  expect(host).toEqual(new Set(expected));
}

function permissionAsked(
  id: string,
  sessionID: string
): Extract<ServerEvent, { type: 'permission.asked' }> {
  return {
    type: 'permission.asked',
    properties: { id, sessionID, permission: 'bash', title: `Run command: build ${id}` },
  };
}

function questionAsked(id: string): Extract<ServerEvent, { type: 'question.asked' }> {
  return {
    type: 'question.asked',
    properties: {
      id,
      sessionID: 'session-1',
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [] }],
    },
  };
}

function runtimeEvent<Properties>(value: RuntimeEventFixture<Properties>): ServerEvent {
  // SAFETY: These fixtures deliberately model accepted legacy server shapes outside the SDK type.
  return value as ServerEvent;
}

describe('attention contract: host vs webview', () => {
  beforeEach(() => {
    webviewAttention.clear();
  });

  it('agrees on a plain permission ask/reply cycle', () => {
    expectAgreement(
      [
        permissionAsked('perm-1', 'session-1'),
        { type: 'permission.replied', properties: { id: 'perm-1', sessionID: 'session-1' } },
      ],
      []
    );
  });

  it('agrees on v2 permission events with an info wrapper', () => {
    expectAgreement(
      [
        runtimeEvent({
          type: 'permission.v2.asked',
          properties: {
            info: { id: 'perm-2', sessionID: 'session-1', permission: 'edit', title: 'edit a.ts' },
          },
        }),
        runtimeEvent({
          type: 'permission.v2.replied',
          properties: { info: { id: 'perm-2', sessionID: 'session-1' } },
        }),
      ],
      []
    );
  });

  it('agrees that legacy permission.updated events create attention', () => {
    expectAgreement(
      [
        {
          type: 'permission.updated',
          properties: { id: 'perm-3', sessionID: 'session-2', permission: 'bash', title: 'run x' },
        },
      ],
      ['permission:perm-3:session-2']
    );
  });

  it('agrees on question ask/reply cycles keyed by requestID or id', () => {
    expectAgreement(
      [questionAsked('q-1'), { type: 'question.replied', properties: { requestID: 'q-1' } }],
      []
    );
    expectAgreement(
      [questionAsked('q-2'), runtimeEvent({ type: 'question.replied', properties: { id: 'q-2' } })],
      []
    );
    expectAgreement(
      [
        questionAsked('q-3'),
        runtimeEvent({ type: 'question.rejected', properties: { id: 'q-3' } }),
      ],
      []
    );
  });

  it('agrees on an interleaved multi-session stream', () => {
    expectAgreement(
      [
        permissionAsked('perm-a', 'session-1'),
        permissionAsked('perm-b', 'session-2'),
        {
          type: 'question.asked',
          properties: {
            id: 'q-a',
            sessionID: 'session-3',
            questions: [{ question: 'Which one?', header: 'Pick', options: [] }],
          },
        },
        runtimeEvent({ type: 'permission.replied', properties: { permissionID: 'perm-a' } }),
        permissionAsked('perm-c', 'session-1'),
        runtimeEvent({ type: 'question.v2.replied', properties: { requestID: 'q-missing' } }),
      ],
      ['permission:perm-b:session-2', 'question:q-a:session-3', 'permission:perm-c:session-1']
    );
  });

  it('agrees that duplicate asks for the same request do not multiply attention', () => {
    expectAgreement(
      [permissionAsked('perm-dup', 'session-1'), permissionAsked('perm-dup', 'session-1')],
      ['permission:perm-dup:session-1']
    );
  });
});
