import { describe, expect, it, vi } from 'vitest';
import type { RecycleBinEntry } from '../../shared/protocol';
import type { Session } from '../types';
import {
  SessionManagementOperations,
  createSessionWithDependencies,
  deleteSessionPermanentlyWithDependencies,
  deleteSessionWithDependencies,
  emptyRecycleBinWithDependencies,
  forkSessionWithDependencies,
  renameSessionWithDependencies,
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

  it('forks a session, carries over the permission mode, and selects the fork', async () => {
    const upsertSession = vi.fn();
    const selectSession = vi.fn(async () => {});
    const setPermissionModeForSession = vi.fn();
    const forkRemoteSession = vi.fn(async () =>
      session('session-3', { title: 'Session (fork #1)' })
    );

    const result = await forkSessionWithDependencies(
      {
        forkRemoteSession,
        getPermissionModeForSession: () => 'full',
        setPermissionModeForSession,
        upsertSession,
        selectSession,
        setError: vi.fn(),
      },
      'session-1',
      'message-2'
    );

    expect(result).toBe('session-3');
    expect(forkRemoteSession).toHaveBeenCalledWith('session-1', 'message-2');
    expect(upsertSession).toHaveBeenCalledWith(
      session('session-3', { title: 'Session (fork #1)' })
    );
    expect(setPermissionModeForSession).toHaveBeenCalledWith('session-3', 'full');
    expect(selectSession).toHaveBeenCalledWith('session-3');
  });

  it('does not write a permission mode for forks of default-mode sessions', async () => {
    const setPermissionModeForSession = vi.fn();

    await forkSessionWithDependencies(
      {
        forkRemoteSession: vi.fn(async () => session('session-3')),
        getPermissionModeForSession: () => 'default',
        setPermissionModeForSession,
        upsertSession: vi.fn(),
        selectSession: vi.fn(async () => {}),
        setError: vi.fn(),
      },
      'session-1'
    );

    expect(setPermissionModeForSession).not.toHaveBeenCalled();
  });

  it('returns null and reports a fork error', async () => {
    const setError = vi.fn();

    const result = await forkSessionWithDependencies(
      {
        forkRemoteSession: vi.fn(async () => {
          throw new Error('fork failed');
        }),
        getPermissionModeForSession: () => 'full',
        setPermissionModeForSession: vi.fn(),
        upsertSession: vi.fn(),
        selectSession: vi.fn(async () => {}),
        setError,
      },
      'session-1'
    );

    expect(result).toBeNull();
    expect(setError).toHaveBeenCalledWith('fork failed');
  });

  it('trims and applies a manual session title', async () => {
    const updated = session('session-1', { title: 'Renamed session' });
    const updateRemoteSession = vi.fn(async () => updated);
    const upsertSession = vi.fn();

    const result = await renameSessionWithDependencies(
      { updateRemoteSession, upsertSession, setError: vi.fn() },
      'session-1',
      '  Renamed session  '
    );

    expect(result).toBe(true);
    expect(updateRemoteSession).toHaveBeenCalledWith('session-1', { title: 'Renamed session' });
    expect(upsertSession).toHaveBeenCalledWith(updated);
  });

  it('rejects an empty manual session title without making a request', async () => {
    const updateRemoteSession = vi.fn();
    const result = await renameSessionWithDependencies(
      { updateRemoteSession, upsertSession: vi.fn(), setError: vi.fn() },
      'session-1',
      '   '
    );

    expect(result).toBe(false);
    expect(updateRemoteSession).not.toHaveBeenCalled();
  });

  it('keeps rename editing available after a request error', async () => {
    const setError = vi.fn();
    const result = await renameSessionWithDependencies(
      {
        updateRemoteSession: vi.fn(async () => {
          throw new Error('rename failed');
        }),
        upsertSession: vi.fn(),
        setError,
      },
      'session-1',
      'New name'
    );

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('rename failed');
  });

  it('creates bound session-management operations from one dependency bag', async () => {
    const deps = {
      getActiveSessionId: () => null,
      createRemoteSession: vi.fn(async () => session('session-2')),
      updateRemoteSession: vi.fn(async () => session('session-1', { title: 'Renamed' })),
      forkRemoteSession: vi.fn(async () => session('session-3')),
      getPermissionModeForSession: vi.fn(() => 'default' as const),
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
    await operations.renameSession('session-1', 'Renamed');
    await operations.forkSession('session-1');
    await operations.deleteSession('session-1');
    await operations.restoreSession('session-1');
    await operations.deleteSessionPermanently('session-1');
    await operations.emptyRecycleBin();

    expect(deps.createRemoteSession).toHaveBeenCalledTimes(1);
    expect(deps.updateRemoteSession).toHaveBeenCalledWith('session-1', { title: 'Renamed' });
    expect(deps.forkRemoteSession).toHaveBeenCalledWith('session-1', undefined);
    expect(deps.deleteRemoteSession).toHaveBeenCalledWith('session-1');
    expect(deps.restoreRecycleBinEntry).toHaveBeenCalledWith('session-1');
    expect(deps.deleteRecycleBinEntry).toHaveBeenCalledWith('session-1');
    expect(deps.emptyRecycleBin).toHaveBeenCalledTimes(1);
  });
});
