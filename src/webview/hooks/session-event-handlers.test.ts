import { describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';

const {
  serverEventsOn,
  addPermission,
  removePermission,
  setState,
  getPermissionModeForSession,
  state,
} = vi.hoisted(() => ({
  serverEventsOn: vi.fn(),
  addPermission: vi.fn(),
  removePermission: vi.fn(),
  setState: vi.fn(),
  getPermissionModeForSession: vi.fn(),
  state: {
    activeSessionId: null,
    messages: [],
  },
}));

vi.mock('../lib/client', () => ({
  serverEvents: {
    on: serverEventsOn,
  },
}));

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    state,
    addPermission,
    getPermissionModeForSession,
    removePermission,
    setState,
  };
});

import {
  registerSessionEventHandlers,
  SessionEventHandlerOperations,
} from './session/session-event-handlers';

describe('registerSessionEventHandlers', () => {
  it('restores the permission prompt when auto-approval fails', async () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const respondPermission = vi
      .fn()
      .mockRejectedValue(new Error('Permission backend unavailable'));

    registerSessionEventHandlers({
      getActiveSessionId: () => null,
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => true,
      respondPermission,
      setDiffs: vi.fn(),
    });

    handlers.get('permission.asked')?.({
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        title: 'Run Bash command',
      },
    });

    await vi.waitFor(() => {
      expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-1', 'always', {
        rethrow: true,
      });
      expect(addPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'perm-1',
          sessionID: 'session-1',
          title: 'bash',
        })
      );
    });
  });

  it('removes permissions when a reply only includes id', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    registerSessionEventHandlers({
      getActiveSessionId: () => null,
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('permission.replied')?.({
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
      },
    });

    expect(removePermission).toHaveBeenCalledWith('perm-1');
  });

  it('binds event handlers to shared state-backed dependencies', async () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    getPermissionModeForSession.mockReturnValue('full');
    state.activeSessionId = 'session-1';
    state.messages = [];
    const respondPermission = vi.fn().mockResolvedValue(undefined);
    const handoffTodosToMessages = vi.fn().mockReturnValue(true);
    const syncTodosFromMessages = vi.fn();

    const operations = new SessionEventHandlerOperations({
      todoSyncOperations: {
        handoffTodosToMessages,
        syncTodosFromMessages,
      },
      sessionLifecycleOperations: {
        upsertSession: vi.fn(),
        removeDeletedSessionTree: vi.fn(),
      },
      sessionStatusOperations: {
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        clearPendingAbort: vi.fn(),
        clearUsageLimitOnResumedProgress: vi.fn(),
        updateUsageLimitState: vi.fn(),
        applyUsageLimitNotice: vi.fn(),
      },
      sessionSyncOperations: {
        syncSession: vi.fn().mockResolvedValue(undefined),
        syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      },
      sessionApprovalOperations: {
        respondPermission,
      },
    });

    operations.registerSessionEventHandlers();

    handlers.get('permission.asked')?.({
      properties: {
        id: 'perm-2',
        sessionID: 'session-1',
        permission: 'edit',
        title: 'Edit file',
      },
    });
    handlers.get('session.status')?.({
      properties: {
        sessionID: 'session-1',
        status: { type: 'busy' },
      },
    });

    await vi.waitFor(() => {
      expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-2', 'always', {
        rethrow: true,
      });
    });
    expect(setState).toHaveBeenCalledWith('sessionStatus', expect.any(Function));
  });

  it('ignores partial message.updated payloads for message state', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const handoffTodosToMessages = vi.fn().mockReturnValue(true);
    const applyUsageLimitNotice = vi.fn();
    const clearUsageLimitOnResumedProgress = vi.fn();
    const updateUsageLimitState = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages,
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress,
      updateUsageLimitState,
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice,
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    setState.mockClear();

    handlers.get('message.updated')?.({
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          error: { name: 'rate_limit_exceeded', data: { message: '429 usage limit reached' } },
        },
      },
    });

    expect(handoffTodosToMessages).not.toHaveBeenCalled();
    expect(applyUsageLimitNotice).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        source: 'message',
        sessionID: 'session-1',
        message: '429 usage limit reached',
      })
    );
    expect(clearUsageLimitOnResumedProgress).not.toHaveBeenCalled();
  });

  it('rejects malformed user message.updated payloads with parent ids', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('message.updated')?.({
      properties: {
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4o' },
          parentID: 'assistant-1',
        },
      },
    });

    expect(setState).not.toHaveBeenCalledWith('messages', expect.any(Function));
  });

  it('ignores partial message.part.updated payloads for message state', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncTodosFromMessages = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages,
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('message.part.updated')?.({
      properties: {
        part: {
          sessionID: 'session-1',
          type: 'tool',
        },
      },
    });

    expect(syncTodosFromMessages).not.toHaveBeenCalled();
  });

  it('re-syncs todos from messages when todo.updated arrives for an active reply', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncTodosFromMessages = vi.fn();

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 0 },
            parentID: 'user-1',
            modelID: 'model-1',
            providerID: 'provider-1',
            mode: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages,
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('todo.updated')?.({
      properties: {
        sessionID: 'session-1',
        todos: [{ id: 'todo-1', content: 'sync me', status: 'pending', priority: 'medium' }],
      },
    });

    expect(syncTodosFromMessages).toHaveBeenCalledTimes(1);
  });

  it('marks the session idle and resyncs messages when the active reply still looks unfinished', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const setSessionStatusEntry = vi.fn();
    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);
    const handoffTodosToMessages = vi.fn().mockReturnValue(true);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'user-1',
            modelID: 'gpt-4o',
            providerID: 'openai',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages,
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry,
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => true,
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(setSessionStatusEntry).toHaveBeenCalledWith('session-1', { type: 'idle' });
    expect(handoffTodosToMessages).toHaveBeenCalledTimes(1);
    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });

  it('does not resync messages on idle when the active session already looks settled', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
            parentID: 'user-1',
            modelID: 'gpt-4o',
            providerID: 'openai',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => true,
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(syncSessionMessages).not.toHaveBeenCalled();
  });

  it('resyncs messages on idle when todo handoff cannot reconcile local state', () => {
    const handlers = new Map<string, (data: { properties?: Record<string, unknown> }) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(
        event as string,
        handler as (data: { properties?: Record<string, unknown> }) => void
      );
      return () => {
        handlers.delete(event as string);
      };
    });

    const syncSessionMessages = vi.fn().mockResolvedValue(undefined);

    registerSessionEventHandlers({
      getActiveSessionId: () => 'session-1',
      getMessages: () => [
        {
          info: {
            id: 'user-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-4o' },
          },
          parts: [],
        },
      ],
      handoffTodosToMessages: vi.fn().mockReturnValue(false),
      upsertSession: vi.fn(),
      setSessionCompacting: vi.fn(),
      removeDeletedSessionTree: vi.fn(),
      shouldIgnorePendingAbortStatus: () => false,
      hasPendingAbort: () => false,
      clearPendingAbort: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      clearUsageLimitOnResumedProgress: vi.fn(),
      updateUsageLimitState: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => true,
      syncSessionMessages,
      applyUsageLimitNotice: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      shouldAutoApprovePermissions: () => false,
      respondPermission: vi.fn().mockResolvedValue(undefined),
      setDiffs: vi.fn(),
    });

    handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

    expect(syncSessionMessages).toHaveBeenCalledWith('session-1');
  });
});
