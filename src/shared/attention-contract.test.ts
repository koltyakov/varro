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

const { serverEventsOn } = vi.hoisted(() => ({
  serverEventsOn: vi.fn(),
}));

const webviewAttention = vi.hoisted(
  () => new Map<string, { sessionID: string; kind: 'permission' | 'question' }>()
);

vi.mock('../webview/lib/client', () => ({
  serverEvents: {
    on: serverEventsOn,
  },
}));

vi.mock('../extension/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../webview/lib/stores/permissions-store', () => ({
  permissionsStore: {
    addPermission: (permission: { id: string; sessionID: string }) => {
      webviewAttention.set(permission.id, {
        sessionID: permission.sessionID,
        kind: 'permission',
      });
    },
    removePermission: (id: string) => {
      webviewAttention.delete(id);
    },
    upsertQuestion: (question: { id: string; sessionID: string }) => {
      webviewAttention.set(question.id, { sessionID: question.sessionID, kind: 'question' });
    },
    removeQuestion: (id: string) => {
      webviewAttention.delete(id);
    },
  },
}));

import type { ServerEvent } from './protocol';
import type { Persistence } from './persistence';
import { SessionStateManager } from '../extension/session-state-manager';
import { registerSessionEventHandlers } from '../webview/hooks/session/session-event-handlers';

type EventData = { properties?: Record<string, unknown>; seq?: number };

function createWebviewSide() {
  webviewAttention.clear();
  const handlers = new Map<string, (data: EventData) => void>();
  serverEventsOn.mockReset();
  serverEventsOn.mockImplementation((event, handler) => {
    handlers.set(event as string, handler as (data: EventData) => void);
    return () => {
      handlers.delete(event as string);
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

function attentionSnapshot(
  entries: Iterable<[string, { sessionID: string; kind: 'permission' | 'question' }]>
) {
  return new Set([...entries].map(([id, entry]) => `${entry.kind}:${id}:${entry.sessionID}`));
}

function runContract(events: ServerEvent[]) {
  const handlers = createWebviewSide();
  const manager = createHostSide();
  for (const event of events) {
    handlers.get(event.type)?.({ properties: event.properties as Record<string, unknown> });
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

const permissionAsked = (id: string, sessionID: string): ServerEvent =>
  ({
    type: 'permission.asked',
    properties: { id, sessionID, permission: 'bash', title: `Run command: build ${id}` },
  }) as ServerEvent;

const questionAsked = (id: string): ServerEvent =>
  ({
    type: 'question.asked',
    properties: {
      id,
      sessionID: 'session-1',
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [] }],
    },
  }) as ServerEvent;

describe('attention contract: host vs webview', () => {
  beforeEach(() => {
    webviewAttention.clear();
  });

  it('agrees on a plain permission ask/reply cycle', () => {
    expectAgreement(
      [
        permissionAsked('perm-1', 'session-1'),
        { type: 'permission.replied', properties: { id: 'perm-1', sessionID: 'session-1' } },
      ] as ServerEvent[],
      []
    );
  });

  it('agrees on v2 permission events with an info wrapper', () => {
    expectAgreement(
      [
        {
          type: 'permission.v2.asked',
          properties: {
            info: { id: 'perm-2', sessionID: 'session-1', permission: 'edit', title: 'edit a.ts' },
          },
        },
        {
          type: 'permission.v2.replied',
          properties: { info: { id: 'perm-2', sessionID: 'session-1' } },
        },
      ] as unknown as ServerEvent[],
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
      ] as ServerEvent[],
      ['permission:perm-3:session-2']
    );
  });

  it('agrees on question ask/reply cycles keyed by requestID or id', () => {
    expectAgreement(
      [
        questionAsked('q-1'),
        { type: 'question.replied', properties: { requestID: 'q-1' } },
      ] as ServerEvent[],
      []
    );
    expectAgreement(
      [
        questionAsked('q-2'),
        { type: 'question.replied', properties: { id: 'q-2' } },
      ] as ServerEvent[],
      []
    );
    expectAgreement(
      [
        questionAsked('q-3'),
        { type: 'question.rejected', properties: { id: 'q-3' } },
      ] as ServerEvent[],
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
        { type: 'permission.replied', properties: { permissionID: 'perm-a' } },
        permissionAsked('perm-c', 'session-1'),
        { type: 'question.v2.replied', properties: { requestID: 'q-missing' } },
      ] as ServerEvent[],
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
