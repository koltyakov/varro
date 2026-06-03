import { describe, expect, it, vi } from 'vitest';
import type { RecycleBinEntry } from '../../shared/protocol';
import type { Session } from '../types';
import {
  SessionManagementOperations,
  createSessionWithDependencies,
  deleteSessionPermanentlyWithDependencies,
  deleteSessionWithDependencies,
  emptyRecycleBinWithDependencies,
  restoreSessionWithDependencies,
} from './session/session-management';

function session(id = 'session-1', overrides?: Partial<Session>): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
    ...overrides,
  };
}

describe('session management helpers', () => {
  it('creates a session and restores the preferred model and build agent', async () => {
    const setSelectedModel = vi.fn();
    const setSelectedAgent = vi.fn();
    const setSelectedMcpsForSession = vi.fn();

    const result = await createSessionWithDependencies(
      {
        getActiveSessionId: () => null,
        createRemoteSession: vi.fn(async () => session('session-2')),
        buildCreatePermission: () => [{ permission: 'read', action: 'allow' }],
        upsertSession: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        setActiveSessionId: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        adoptDraftCurrentDocumentState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionUsageLimit: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        getDefaultSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
        setSelectedModel,
        resolveDefaultAgent: () => 'build',
        setSelectedAgent,
        getConnectedMcpNames: () => ['docs'],
        setSelectedMcpsForSession,
        setPermissionModeForSession: vi.fn(),
        resetDraftPermissionMode: vi.fn(),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      undefined,
      'default'
    );

    expect(result).toBe('session-2');
    expect(setSelectedModel).toHaveBeenCalledWith(
      { providerID: 'openai', modelID: 'gpt-5' },
      { sessionId: 'session-2', persistGlobal: false }
    );
    expect(setSelectedAgent).toHaveBeenCalledWith('build', {
      sessionId: 'session-2',
      persistGlobal: false,
    });
    expect(setSelectedMcpsForSession).toHaveBeenCalledWith('session-2', ['docs']);
  });

  it('persists non-default permission mode for new sessions', async () => {
    const setPermissionModeForSession = vi.fn();

    const result = await createSessionWithDependencies(
      {
        getActiveSessionId: () => null,
        createRemoteSession: vi.fn(async () => session('session-auto')),
        buildCreatePermission: () => [{ permission: 'bash', pattern: '*', action: 'ask' }],
        upsertSession: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        setActiveSessionId: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        adoptDraftCurrentDocumentState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionUsageLimit: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        getDefaultSelectedModel: () => null,
        setSelectedModel: vi.fn(),
        resolveDefaultAgent: () => null,
        setSelectedAgent: vi.fn(),
        getConnectedMcpNames: () => [],
        setSelectedMcpsForSession: vi.fn(),
        setPermissionModeForSession,
        resetDraftPermissionMode: vi.fn(),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      undefined,
      'auto'
    );

    expect(result).toBe('session-auto');
    expect(setPermissionModeForSession).toHaveBeenCalledWith('session-auto', 'auto');
  });

  it('deletes a session and selects the next visible session when needed', async () => {
    const selectSession = vi.fn(async () => {});

    await deleteSessionWithDependencies(
      {
        getSessions: () => [session('session-1'), session('session-2')],
        getActiveSessionId: () => 'session-1',
        getDeletedSessionTreeIds: () => new Set(['session-1']),
        getNextSessionIdAfterDeletion: () => 'session-2',
        deleteRemoteSession: vi.fn(async () => true),
        hideDeletedSessionTree: vi.fn(),
        loadRecycleBin: vi.fn(async () => {}),
        selectSession,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(selectSession).toHaveBeenCalledWith('session-2', { markSeen: false });
  });

  it('restores recycle-bin entries by refreshing sessions, recycle bin, and statuses', async () => {
    const loadSessions = vi.fn(async () => {});
    const loadRecycleBin = vi.fn(async () => {});
    const hydrateSessionStatuses = vi.fn(async () => {});

    await restoreSessionWithDependencies(
      {
        restoreRecycleBinEntry: vi.fn(async () => true),
        loadSessions,
        loadRecycleBin,
        hydrateSessionStatuses,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadRecycleBin).toHaveBeenCalledTimes(1);
    expect(hydrateSessionStatuses).toHaveBeenCalledTimes(1);
  });

  it('deletes recycle-bin entries permanently and clears deleted session state', async () => {
    const clearDeletedSessionState = vi.fn();
    const entries: RecycleBinEntry[] = [
      {
        rootID: 'session-1',
        deletedAt: 1,
        expiresAt: 2,
        root: session('session-1'),
        sessions: [session('child-1')],
      },
    ];

    await deleteSessionPermanentlyWithDependencies(
      {
        getRecycleBinEntries: () => entries,
        deleteRecycleBinEntry: vi.fn(async () => true),
        loadRecycleBin: vi.fn(async () => {}),
        clearDeletedSessionState,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(clearDeletedSessionState).toHaveBeenCalledWith('child-1');
  });

  it('empties the recycle bin and clears state for every deleted session', async () => {
    const clearDeletedSessionState = vi.fn();
    const entries: RecycleBinEntry[] = [
      {
        rootID: 'session-1',
        deletedAt: 1,
        expiresAt: 2,
        root: session('session-1'),
        sessions: [session('session-1'), session('child-1')],
      },
    ];

    await emptyRecycleBinWithDependencies({
      getRecycleBinEntries: () => entries,
      emptyRecycleBin: vi.fn(async () => true),
      loadRecycleBin: vi.fn(async () => {}),
      clearDeletedSessionState,
      logError: vi.fn(),
    });

    expect(clearDeletedSessionState).toHaveBeenCalledWith('session-1');
    expect(clearDeletedSessionState).toHaveBeenCalledWith('child-1');
  });

  it('returns null and reports a create error', async () => {
    const setError = vi.fn();

    const result = await createSessionWithDependencies(
      {
        getActiveSessionId: () => null,
        createRemoteSession: vi.fn(async () => {
          throw new Error('create failed');
        }),
        buildCreatePermission: () => [],
        upsertSession: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        setActiveSessionId: vi.fn(),
        clearDraftCurrentDocumentState: vi.fn(),
        adoptDraftCurrentDocumentState: vi.fn(),
        setSessionStatusEntry: vi.fn(),
        setSessionUsageLimit: vi.fn(),
        persistActiveSessionId: vi.fn(),
        markSessionSeen: vi.fn(),
        getDefaultSelectedModel: () => null,
        setSelectedModel: vi.fn(),
        resolveDefaultAgent: () => null,
        setSelectedAgent: vi.fn(),
        getConnectedMcpNames: () => [],
        setSelectedMcpsForSession: vi.fn(),
        setPermissionModeForSession: vi.fn(),
        resetDraftPermissionMode: vi.fn(),
        resetTodoSync: vi.fn(),
        clearMessages: vi.fn(),
        stopLoading: vi.fn(),
        setError,
      },
      undefined,
      'default'
    );

    expect(result).toBeNull();
    expect(setError).toHaveBeenCalledWith('create failed');
  });

  it('creates bound session-management operations from one dependency bag', async () => {
    const deps = {
      getActiveSessionId: () => null,
      createRemoteSession: vi.fn(async () => session('session-2')),
      buildCreatePermission: () => [],
      upsertSession: vi.fn(),
      resetToolCallExpansionState: vi.fn(),
      setActiveSessionId: vi.fn(),
      clearDraftCurrentDocumentState: vi.fn(),
      adoptDraftCurrentDocumentState: vi.fn(),
      setSessionStatusEntry: vi.fn(),
      setSessionUsageLimit: vi.fn(),
      persistActiveSessionId: vi.fn(),
      markSessionSeen: vi.fn(),
      getDefaultSelectedModel: () => null,
      setSelectedModel: vi.fn(),
      resolveDefaultAgent: () => null,
      setSelectedAgent: vi.fn(),
      getConnectedMcpNames: () => [],
      setSelectedMcpsForSession: vi.fn(),
      setPermissionModeForSession: vi.fn(),
      resetDraftPermissionMode: vi.fn(),
      resetTodoSync: vi.fn(),
      clearMessages: vi.fn(),
      stopLoading: vi.fn(),
      setError: vi.fn(),
      getSessions: () => [session('session-1'), session('session-2')],
      getDeletedSessionTreeIds: () => new Set(['session-1']),
      getNextSessionIdAfterDeletion: () => 'session-2',
      deleteRemoteSession: vi.fn(async () => true),
      hideDeletedSessionTree: vi.fn(),
      loadRecycleBin: vi.fn(async () => {}),
      selectSession: vi.fn(async () => {}),
      logError: vi.fn(),
      restoreRecycleBinEntry: vi.fn(async () => true),
      loadSessions: vi.fn(async () => {}),
      hydrateSessionStatuses: vi.fn(async () => {}),
      getRecycleBinEntries: () => [],
      deleteRecycleBinEntry: vi.fn(async () => true),
      clearDeletedSessionState: vi.fn(),
      emptyRecycleBin: vi.fn(async () => true),
    };

    const operations = new SessionManagementOperations(deps);

    await operations.createSession();
    await operations.deleteSession('session-1');
    await operations.restoreSession('session-1');
    await operations.deleteSessionPermanently('session-1');
    await operations.emptyRecycleBin();

    expect(deps.createRemoteSession).toHaveBeenCalledTimes(1);
    expect(deps.deleteRemoteSession).toHaveBeenCalledWith('session-1');
    expect(deps.restoreRecycleBinEntry).toHaveBeenCalledWith('session-1');
    expect(deps.deleteRecycleBinEntry).toHaveBeenCalledWith('session-1');
    expect(deps.emptyRecycleBin).toHaveBeenCalledTimes(1);
  });
});
