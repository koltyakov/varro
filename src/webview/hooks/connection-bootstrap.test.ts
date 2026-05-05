import { describe, expect, it, vi } from 'vitest';
import type { Message, SessionStatus } from '../types';
import {
  buildInterruptedSessionContinueBody,
  continueInterruptedSessionWithDependencies,
  createConnectionBootstrapOperations,
  ensureConnectionInitializedWithDependencies,
  initConnectionWithDependencies,
  INTERRUPTED_SESSION_CONTINUE_PROMPT,
  recoverInterruptedSessionsWithDependencies,
  shouldContinueInterruptedSession,
} from './connection-bootstrap';

function userMessage(id: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

function assistantMessage(
  id: string,
  overrides?: Partial<Extract<Message, { role: 'assistant' }>>
): Message {
  return {
    id,
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
    ...overrides,
  };
}

describe('connection-bootstrap helpers', () => {
  it('builds the interrupted-session continue body with agent and variant', () => {
    expect(
      buildInterruptedSessionContinueBody({
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5', variant: 'high' },
      })
    ).toEqual({
      parts: [{ type: 'text', text: INTERRUPTED_SESSION_CONTINUE_PROMPT }],
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      variant: 'high',
    });
  });

  it('detects whether an interrupted session should continue', () => {
    expect(shouldContinueInterruptedSession([{ info: userMessage('user-1'), parts: [] }])).toBe(
      true
    );
    expect(
      shouldContinueInterruptedSession([
        {
          info: assistantMessage('assistant-1', { time: { created: 1, completed: 2 } }),
          parts: [],
        },
      ])
    ).toBe(false);
    expect(
      shouldContinueInterruptedSession([{ info: assistantMessage('assistant-2'), parts: [] }])
    ).toBe(true);
  });

  it('continues interrupted sessions and swallows sync follow-up failures', async () => {
    const syncSessionMcps = vi.fn(async () => {});
    const sendAsync = vi.fn(async () => {});
    const syncSession = vi.fn(async () => {
      throw new Error('sync failed');
    });
    const recheckSessionStatus = vi.fn(async () => {});

    await continueInterruptedSessionWithDependencies(
      {
        syncSessionMcps,
        resolveModel: () => ({ providerID: 'openai', modelID: 'gpt-5', variant: 'high' }),
        resolveAgent: () => 'build',
        sendAsync,
        syncSession,
        recheckSessionStatus,
      },
      'session-1'
    );

    expect(syncSessionMcps).toHaveBeenCalledWith('session-1');
    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      parts: [{ type: 'text', text: INTERRUPTED_SESSION_CONTINUE_PROMPT }],
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      variant: 'high',
    });
    expect(syncSession).toHaveBeenCalledWith('session-1');
    expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');
  });

  it('recovers only resumable interrupted sessions', async () => {
    const continueInterruptedSession = vi.fn(async () => {});
    const logError = vi.fn();
    const statuses: Record<string, SessionStatus> = {
      'session-busy': { type: 'busy' },
      'session-retry': { type: 'retry', attempt: 2, message: 'retry', next: 3 },
      'session-idle': { type: 'idle' },
    };

    await recoverInterruptedSessionsWithDependencies(
      {
        consumeInterruptedSessionIds: () => [
          'session-idle',
          'session-idle',
          'session-busy',
          'session-retry',
          'session-missing',
          'session-question',
          'session-permission',
        ],
        isCurrentGeneration: () => true,
        hasSession: (sessionId) => sessionId !== 'session-missing',
        getSessionStatus: (sessionId) => statuses[sessionId],
        hasPendingQuestion: (sessionId) => sessionId === 'session-question',
        hasPendingPermission: (sessionId) => sessionId === 'session-permission',
        loadSessionMessages: async (sessionId) => {
          if (sessionId === 'session-idle') {
            return [{ info: userMessage('user-1'), parts: [] }];
          }
          return [
            {
              info: assistantMessage('assistant-1', { time: { created: 1, completed: 2 } }),
              parts: [],
            },
          ];
        },
        continueInterruptedSession,
        logError,
      },
      1
    );

    expect(continueInterruptedSession).toHaveBeenCalledTimes(1);
    expect(continueInterruptedSession).toHaveBeenCalledWith('session-idle');
    expect(logError).not.toHaveBeenCalled();
  });

  it('initializes connection data, opens new chat when no recent view exists, and recovers interruptions', async () => {
    const callOrder: string[] = [];
    const setInitialized = vi.fn();
    const setError = vi.fn();
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: async () => {
          callOrder.push('health');
        },
        loadInitialData: async () => {
          callOrder.push('loadInitialData');
        },
        hydrateSessionStatuses: async () => {
          callOrder.push('hydrateSessionStatuses');
        },
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => null,
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => null,
        selectSession,
        hasSession: () => true,
        setShowSessionPicker,
        recoverInterruptedSessions: async (generation) => {
          callOrder.push(`recover:${generation}`);
        },
        setInitialized,
        setError,
      },
      {
        next: () => 3,
        isCurrent: () => true,
      }
    );

    expect(callOrder).toEqual(['health', 'loadInitialData', 'hydrateSessionStatuses', 'recover:3']);
    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).not.toHaveBeenCalled();
    expect(setInitialized).toHaveBeenCalledWith(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('leaves the new chat view open when no sessions exist on startup', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => null,
        getSessionCount: () => 0,
        getOnlyPrimarySessionId: () => null,
        selectSession,
        hasSession: () => false,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('restores the only session when it matches the persisted active session on startup', async () => {
    const callOrder: string[] = [];
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async (sessionId: string) => {
      callOrder.push(`select:${sessionId}`);
    });

    await initConnectionWithDependencies(
      {
        health: async () => {
          callOrder.push('health');
        },
        loadInitialData: async () => {
          callOrder.push('loadInitialData');
        },
        hydrateSessionStatuses: async () => {
          callOrder.push('hydrateSessionStatuses');
        },
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getSessionCount: () => 1,
        getOnlyPrimarySessionId: () => 'session-1',
        selectSession,
        hasSession: () => true,
        setShowSessionPicker,
        recoverInterruptedSessions: async (generation) => {
          callOrder.push(`recover:${generation}`);
        },
        setInitialized: vi.fn(),
        setError: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(callOrder).toEqual([
      'health',
      'loadInitialData',
      'hydrateSessionStatuses',
      'select:session-1',
      'recover:1',
    ]);
    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
  });

  it('does not restore legacy active session when a stale view marker exists', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getPersistedLastOpenedView: () => ({
          type: 'session',
          sessionId: 'session-1',
          timestamp: 1_000_000,
        }),
        getSessionCount: () => 1,
        getOnlyPrimarySessionId: () => 'session-1',
        hasSession: () => true,
        selectSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000 + 5 * 60 * 1000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('restores a recent active session on startup', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getPersistedLastOpenedView: () => ({
          type: 'session',
          sessionId: 'session-1',
          timestamp: 1_000_000,
        }),
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => null,
        hasSession: (sessionId) => sessionId === 'session-1',
        selectSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).toHaveBeenCalledWith('session-1');
  });

  it('restores a recent sessions list view on startup', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getPersistedLastOpenedView: () => ({ type: 'sessions-list', timestamp: 1_000_000 }),
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => null,
        hasSession: () => true,
        selectSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens a new chat when the last opened view is stale', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getPersistedLastOpenedView: () => ({
          type: 'session',
          sessionId: 'session-1',
          timestamp: 1_000_000,
        }),
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => 'session-1',
        hasSession: () => true,
        selectSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000 + 5 * 60 * 1000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('restores the only primary session when child sessions also exist', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => 'session-1',
        selectSession,
        hasSession: () => true,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).toHaveBeenCalledWith('session-1');
  });

  it('opens a new chat when the only primary session was not the persisted active session', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'other-session',
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => 'session-1',
        selectSession,
        hasSession: () => true,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('does not change the current view when a session is already active', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => {}),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => 'session-1',
        getPersistedActiveSessionId: () => 'session-1',
        getSessionCount: () => 3,
        getOnlyPrimarySessionId: () => null,
        selectSession,
        hasSession: () => true,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).not.toHaveBeenCalled();
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('reports startup failure when bootstrap throws', async () => {
    const setInitialized = vi.fn();
    const setError = vi.fn();

    await initConnectionWithDependencies(
      {
        health: async () => {
          throw new Error('offline');
        },
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => null,
        getSessionCount: () => 0,
        getOnlyPrimarySessionId: () => null,
        selectSession: vi.fn(async () => {}),
        hasSession: () => false,
        setShowSessionPicker: vi.fn(),
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized,
        setError,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setInitialized).toHaveBeenCalledWith(false);
    expect(setError).toHaveBeenCalledWith('Failed to connect to OpenCode server');
  });

  it('starts connection initialization only once at a time', async () => {
    let initializing = false;
    let resolveInit: (() => void) | null = null;
    const initConnection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        })
    );

    ensureConnectionInitializedWithDependencies({
      isInitialized: () => false,
      isInitializing: () => initializing,
      initConnection,
      setInitializing: (value) => {
        initializing = value;
      },
    });

    ensureConnectionInitializedWithDependencies({
      isInitialized: () => false,
      isInitializing: () => initializing,
      initConnection,
      setInitializing: (value) => {
        initializing = value;
      },
    });

    expect(initConnection).toHaveBeenCalledTimes(1);

    resolveInit?.();
    await Promise.resolve();
    expect(initializing).toBe(false);
  });

  it('creates bound bootstrap operations from one dependency bag', async () => {
    const callOrder: string[] = [];

    const operations = createConnectionBootstrapOperations({
      health: async () => {
        callOrder.push('health');
      },
      loadInitialData: async () => {
        callOrder.push('load');
      },
      hydrateSessionStatuses: async () => {
        callOrder.push('hydrate');
      },
      getActiveSessionId: () => null,
      getPersistedActiveSessionId: () => null,
      getSessionCount: () => 1,
      getOnlyPrimarySessionId: () => 'session-1',
      hasSession: () => true,
      selectSession: vi.fn(async () => {}),
      setShowSessionPicker: (value) => {
        callOrder.push(`picker:${value}`);
      },
      setInitialized: vi.fn(),
      setError: vi.fn(),
      nextConnectionGeneration: () => 1,
      isCurrentConnectionGeneration: () => true,
      consumeInterruptedSessionIds: () => [],
      getSessionStatus: () => ({ type: 'idle' }),
      hasPendingQuestion: () => false,
      hasPendingPermission: () => false,
      loadSessionMessages: async () => [],
      logError: vi.fn(),
      syncSessionMcps: vi.fn(async () => {}),
      resolveModel: () => null,
      resolveAgent: () => null,
      sendAsync: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      recheckSessionStatus: vi.fn(async () => {}),
    });

    await operations.initConnection();

    expect(callOrder).toEqual(['health', 'load', 'hydrate', 'picker:false']);
  });
});
