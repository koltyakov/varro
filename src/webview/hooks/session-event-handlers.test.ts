import { describe, expect, it, vi } from 'vitest';

const { serverEventsOn } = vi.hoisted(() => ({
  serverEventsOn: vi.fn(),
}));

vi.mock('../lib/client', () => ({
  serverEvents: {
    on: serverEventsOn,
  },
}));

import { registerSessionEventHandlers } from './session-event-handlers';

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

    const addPermission = vi.fn();
    const respondPermission = vi
      .fn()
      .mockRejectedValue(new Error('Permission backend unavailable'));

    registerSessionEventHandlers({
      getActiveSessionId: () => null,
      getMessages: () => [],
      setTodoStateAuthority: vi.fn(),
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
      startLoading: vi.fn(),
      stopLoading: vi.fn(),
      markSessionSeen: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      shouldResyncSessionAfterIdle: () => false,
      syncSessionMessages: vi.fn().mockResolvedValue(undefined),
      markLoadingActivity: vi.fn(),
      upsertMessageInfo: vi.fn(),
      setSessionFailed: vi.fn(),
      parseUsageLimitNotice: () => null,
      applyUsageLimitNotice: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      upsertPart: vi.fn(),
      syncTodosFromMessages: vi.fn(),
      applyMessagePartDelta: vi.fn(),
      removeMessagePart: vi.fn(),
      clearStreamingState: vi.fn(),
      replaceMessages: vi.fn(),
      shouldAutoApprovePermissions: () => true,
      respondPermission,
      addPermission,
      removePermission: vi.fn(),
      upsertQuestion: vi.fn(),
      removeQuestion: vi.fn(),
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
});
