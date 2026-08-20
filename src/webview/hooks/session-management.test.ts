import { describe, expect, it, vi } from 'vitest';
import type { RecycleBinEntry } from '../../shared/protocol';
import type { Session } from '../types';
import {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((next, rejectPromise) => {
    resolve = next;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('session management helpers', () => {
  it('creates a session and restores draft routing selections', async () => {
    const setSelectedModel = vi.fn();
    const setSelectedAgent = vi.fn();
    const setSelectedMcpsForSession = vi.fn();
    const resetDraftSelectedMcps = vi.fn();

    const result = await createSessionWithDependencies(
      {
        getActiveSessionId: () => null,
        getNewChatDraftGeneration: () => 0,
        createRemoteSession: vi.fn(async () => session('session-2')),
        buildCreatePermission: () => [{ permission: 'read', pattern: '*', action: 'allow' }],
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
        getInitialMcpNames: () => ['browser-bridge'],
        setSelectedMcpsForSession,
        resetDraftSelectedMcps,
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
    expect(setSelectedMcpsForSession).toHaveBeenCalledWith('session-2', ['browser-bridge']);
    expect(resetDraftSelectedMcps).toHaveBeenCalledTimes(1);
  });

  it('persists non-default permission mode for new sessions', async () => {
    const setPermissionModeForSession = vi.fn();

    const result = await createSessionWithDependencies(
      {
        getActiveSessionId: () => null,
        getNewChatDraftGeneration: () => 0,
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
        getInitialMcpNames: () => [],
        setSelectedMcpsForSession: vi.fn(),
        resetDraftSelectedMcps: vi.fn(),
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

  it('omits session permission overrides in default mode', async () => {
    const createRemoteSession = vi.fn(async () => session('session-default'));

    const result = await createSessionWithDependencies(
      {
        getActiveSessionId: () => null,
        getNewChatDraftGeneration: () => 0,
        createRemoteSession,
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
        getInitialMcpNames: () => [],
        setSelectedMcpsForSession: vi.fn(),
        resetDraftSelectedMcps: vi.fn(),
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

    expect(result).toBe('session-default');
    expect(createRemoteSession).toHaveBeenCalledWith({});
  });

  it('does not replace a session selected while remote creation is pending', async () => {
    let activeSessionId: string | null = null;
    let initialMcpNames = ['draft-mcp'];
    const remoteSession = deferred<Session>();
    const setActiveSessionId = vi.fn((sessionId: string) => {
      activeSessionId = sessionId;
    });
    const setSelectedModel = vi.fn();
    const setSelectedAgent = vi.fn();
    const setSelectedMcpsForSession = vi.fn();
    const adoptDraftCurrentDocumentState = vi.fn();
    const persistActiveSessionId = vi.fn();
    const clearMessages = vi.fn();

    const pending = createSessionWithDependencies(
      {
        getActiveSessionId: () => activeSessionId,
        getNewChatDraftGeneration: () => 0,
        createRemoteSession: vi.fn(() => remoteSession.promise),
        buildCreatePermission: () => [{ permission: 'read', pattern: '*', action: 'allow' }],
        upsertSession: vi.fn(),
        resetToolCallExpansionState: vi.fn(),
        setActiveSessionId,
        clearDraftCurrentDocumentState: vi.fn(),
        adoptDraftCurrentDocumentState,
        setSessionStatusEntry: vi.fn(),
        setSessionUsageLimit: vi.fn(),
        persistActiveSessionId,
        markSessionSeen: vi.fn(),
        getDefaultSelectedModel: () => ({ providerID: 'openai', modelID: 'draft-model' }),
        setSelectedModel,
        resolveDefaultAgent: () => 'plan',
        setSelectedAgent,
        getInitialMcpNames: () => initialMcpNames,
        setSelectedMcpsForSession,
        resetDraftSelectedMcps: vi.fn(),
        setPermissionModeForSession: vi.fn(),
        resetDraftPermissionMode: vi.fn(),
        resetTodoSync: vi.fn(),
        clearMessages,
        stopLoading: vi.fn(),
        setError: vi.fn(),
      },
      undefined,
      'default'
    );

    activeSessionId = 'session-selected';
    initialMcpNames = ['selected-session-mcp'];
    remoteSession.resolve(session('session-created'));

    await expect(pending).resolves.toBe('session-created');
    expect(activeSessionId).toBe('session-selected');
    expect(setActiveSessionId).not.toHaveBeenCalled();
    expect(adoptDraftCurrentDocumentState).not.toHaveBeenCalled();
    expect(persistActiveSessionId).not.toHaveBeenCalled();
    expect(clearMessages).not.toHaveBeenCalled();
    expect(setSelectedModel).not.toHaveBeenCalled();
    expect(setSelectedAgent).not.toHaveBeenCalled();
    expect(setSelectedMcpsForSession).toHaveBeenCalledWith('session-created', ['draft-mcp']);
  });

  it.each(['success', 'failure'] as const)(
    'does not affect the replacement null draft after stale creation %s',
    async (outcome) => {
      let activeSessionId: string | null = null;
      let draftGeneration = 0;
      const remoteSession = deferred<Session>();
      const setActiveSessionId = vi.fn((sessionId: string) => {
        activeSessionId = sessionId;
      });
      const adoptDraftCurrentDocumentState = vi.fn();
      const persistActiveSessionId = vi.fn();
      const clearMessages = vi.fn();
      const setError = vi.fn();

      const pending = createSessionWithDependencies(
        {
          getActiveSessionId: () => activeSessionId,
          getNewChatDraftGeneration: () => draftGeneration,
          createRemoteSession: vi.fn(() => remoteSession.promise),
          buildCreatePermission: () => [{ permission: 'read', pattern: '*', action: 'allow' }],
          upsertSession: vi.fn(),
          resetToolCallExpansionState: vi.fn(),
          setActiveSessionId,
          clearDraftCurrentDocumentState: vi.fn(),
          adoptDraftCurrentDocumentState,
          setSessionStatusEntry: vi.fn(),
          setSessionUsageLimit: vi.fn(),
          persistActiveSessionId,
          markSessionSeen: vi.fn(),
          getDefaultSelectedModel: () => null,
          setSelectedModel: vi.fn(),
          resolveDefaultAgent: () => null,
          setSelectedAgent: vi.fn(),
          getInitialMcpNames: () => [],
          setSelectedMcpsForSession: vi.fn(),
          resetDraftSelectedMcps: vi.fn(),
          setPermissionModeForSession: vi.fn(),
          resetDraftPermissionMode: vi.fn(),
          resetTodoSync: vi.fn(),
          clearMessages,
          stopLoading: vi.fn(),
          setError,
        },
        undefined,
        'default'
      );

      draftGeneration += 1;
      if (outcome === 'success') {
        remoteSession.resolve(session('session-abandoned'));
      } else {
        remoteSession.reject(new Error('stale failure'));
      }

      await expect(pending).resolves.toBe(outcome === 'success' ? 'session-abandoned' : null);
      expect(activeSessionId).toBeNull();
      expect(setActiveSessionId).not.toHaveBeenCalled();
      expect(adoptDraftCurrentDocumentState).not.toHaveBeenCalled();
      expect(persistActiveSessionId).not.toHaveBeenCalled();
      expect(clearMessages).not.toHaveBeenCalled();
      expect(setError).not.toHaveBeenCalled();
    }
  );

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

  it('surfaces an error when permanent delete fails', async () => {
    const setError = vi.fn();
    const entries: RecycleBinEntry[] = [
      {
        rootID: 'session-1',
        deletedAt: 1,
        expiresAt: 2,
        root: session('session-1'),
        sessions: [session('session-1')],
      },
    ];

    await deleteSessionPermanentlyWithDependencies(
      {
        getRecycleBinEntries: () => entries,
        deleteRecycleBinEntry: vi.fn(async () => {
          throw new Error('delete failed');
        }),
        loadRecycleBin: vi.fn(async () => {}),
        clearDeletedSessionState: vi.fn(),
        setError,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(setError).toHaveBeenCalledWith('delete failed');
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
        getNewChatDraftGeneration: () => 0,
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
        getInitialMcpNames: () => [],
        setSelectedMcpsForSession: vi.fn(),
        resetDraftSelectedMcps: vi.fn(),
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
    const current = session('session-1', {
      title: 'Old title',
      time: { created: 0, updated: 10 },
    });
    const updated = session('session-1', {
      title: 'Renamed session',
      time: { created: 0, updated: 5 },
    });
    const updateRemoteSession = vi.fn(async () => updated);
    const upsertSession = vi.fn();

    const result = await renameSessionWithDependencies(
      { updateRemoteSession, getSessions: () => [current], upsertSession, setError: vi.fn() },
      'session-1',
      '  Renamed session  '
    );

    expect(result).toBe(true);
    expect(updateRemoteSession).toHaveBeenCalledWith('session-1', { title: 'Renamed session' });
    expect(upsertSession).toHaveBeenCalledWith({ ...current, title: 'Renamed session' });
  });

  it('rejects an empty manual session title without making a request', async () => {
    const updateRemoteSession = vi.fn();
    const result = await renameSessionWithDependencies(
      {
        updateRemoteSession,
        getSessions: () => [],
        upsertSession: vi.fn(),
        setError: vi.fn(),
      },
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
        getSessions: () => [],
        upsertSession: vi.fn(),
        setError,
      },
      'session-1',
      'New name'
    );

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('rename failed');
  });
});
