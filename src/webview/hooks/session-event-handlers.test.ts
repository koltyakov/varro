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
  createSessionEventHandlerOperations,
  registerSessionEventHandlers,
} from './session-event-handlers';

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
      setTodoStateAuthority: vi.fn(),
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      setTodos: vi.fn(),
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
      extractTodos: () => null,
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
      setTodoStateAuthority: vi.fn(),
      handoffTodosToMessages: vi.fn().mockReturnValue(true),
      setTodos: vi.fn(),
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
      extractTodos: () => null,
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

    const operations = createSessionEventHandlerOperations({
      setTodoStateAuthority: vi.fn(),
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
      extractTodos: () => null,
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
});
