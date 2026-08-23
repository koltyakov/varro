import { describe, expect, it, vi } from 'vitest';
import type { Message, SessionStatus } from '../types';
import {
  buildInterruptedSessionContinueBody,
  continueInterruptedSessionWithDependencies,
  ensureConnectionInitializedWithDependencies,
  initConnectionWithDependencies,
  INTERRUPTED_SESSION_CONTINUE_PROMPT,
  recoverInterruptedSessionsWithDependencies,
  shouldContinueInterruptedSession,
} from './connection-bootstrap';

const HEALTHY_RESPONSE = { healthy: true, version: '1.0.0' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
    const statuses = new Map<string, SessionStatus>([
      ['session-busy', { type: 'busy' }],
      ['session-retry', { type: 'retry', attempt: 2, message: 'retry', next: 3 }],
      ['session-idle', { type: 'idle' }],
    ]);

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
        getSessionStatus: (sessionId) => statuses.get(sessionId),
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

  it('initializes connection data, opens the sessions list when sessions exist, and recovers interruptions', async () => {
    const callOrder: string[] = [];
    const setInitialized = vi.fn();
    const setError = vi.fn();
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: async () => {
          callOrder.push('health');
          return HEALTHY_RESPONSE;
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
    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
    expect(setInitialized).toHaveBeenCalledWith(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('leaves the new chat view open when no sessions exist on startup', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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

  it('restores the only primary session on startup', async () => {
    const callOrder: string[] = [];
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async (sessionId: string) => {
      callOrder.push(`select:${sessionId}`);
    });

    await initConnectionWithDependencies(
      {
        health: async () => {
          callOrder.push('health');
          return HEALTHY_RESPONSE;
        },
        loadInitialData: async () => {
          callOrder.push('loadInitialData');
        },
        hydrateSessionStatuses: async () => {
          callOrder.push('hydrateSessionStatuses');
        },
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => null,
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

  it('restores the only primary session when the last active session marker is stale', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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
        now: () => 1_000_000 + 10 * 60 * 1000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).toHaveBeenCalledWith('session-1');
  });

  it('lets an editor session route override the recent startup view', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => 'session-1',
        getPersistedLastOpenedView: () => ({
          type: 'session',
          sessionId: 'session-1',
          timestamp: 1_000_000,
        }),
        getInitialRoute: () => ({ type: 'session', sessionId: 'session-2' }),
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

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(selectSession).toHaveBeenCalledWith('session-2');
  });

  it('loads an editor session route outside the initial session page', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => null,
        getPersistedLastOpenedView: () => null,
        getInitialRoute: () => ({ type: 'session', sessionId: 'session-outside-page' }),
        getSessionCount: () => 100,
        getOnlyPrimarySessionId: () => null,
        hasSession: () => false,
        selectSession,
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
    expect(selectSession).toHaveBeenCalledWith('session-outside-page');
  });

  it('lets an editor new-session route override a persisted session', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});
    const startNewSession = vi.fn();

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => 'session-1',
        getPersistedActiveSessionId: () => null,
        getPersistedLastOpenedView: () => ({
          type: 'session',
          sessionId: 'session-1',
          timestamp: 1_000_000,
        }),
        getInitialRoute: () => ({ type: 'new-session' }),
        getSessionCount: () => 1,
        getOnlyPrimarySessionId: () => 'session-1',
        hasSession: () => true,
        selectSession,
        startNewSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000 + 1_000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(false);
    expect(startNewSession).toHaveBeenCalledOnce();
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens the sessions list when that was the recent startup fallback', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
        loadInitialData: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        getActiveSessionId: () => null,
        getPersistedActiveSessionId: () => null,
        getPersistedLastOpenedView: () => ({ type: 'sessions-list', timestamp: 1_000_000 }),
        getSessionCount: () => 2,
        getOnlyPrimarySessionId: () => null,
        hasSession: () => true,
        selectSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000 + 1_000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens the sessions list when the last active session is stale and multiple sessions exist', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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
        now: () => 1_000_000 + 10 * 60 * 1000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens the sessions list when child sessions exist alongside the only primary session', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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

    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens the sessions list when child sessions exist even if another session was active previously', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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

    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens the sessions list when multiple primary sessions exist and the recent session is stale', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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
        hasSession: () => true,
        selectSession,
        setShowSessionPicker,
        recoverInterruptedSessions: vi.fn(async () => {}),
        setInitialized: vi.fn(),
        setError: vi.fn(),
        now: () => 1_000_000 + 10 * 60 * 1000,
      },
      {
        next: () => 1,
        isCurrent: () => true,
      }
    );

    expect(setShowSessionPicker).toHaveBeenCalledWith(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('does not change the current view when a session is already active', async () => {
    const setShowSessionPicker = vi.fn();
    const selectSession = vi.fn(async () => {});

    await initConnectionWithDependencies(
      {
        health: vi.fn(async () => HEALTHY_RESPONSE),
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
    expect(setError).toHaveBeenCalledWith('Failed to connect to OpenCode server: offline');
  });

  it('does not load startup data until the server reports healthy', async () => {
    const loadInitialData = vi.fn(async () => {});
    const setInitialized = vi.fn();
    const setError = vi.fn();

    await initConnectionWithDependencies(
      {
        health: async () => ({ healthy: false, version: '1.0.0' }),
        loadInitialData,
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

    expect(loadInitialData).not.toHaveBeenCalled();
    expect(setInitialized).toHaveBeenCalledWith(false);
    expect(setError).toHaveBeenCalledWith(
      'Failed to connect to OpenCode server: OpenCode server is not healthy'
    );
  });

  it('ignores errors from a stale connection generation', async () => {
    let current = true;
    const setInitialized = vi.fn();
    const setError = vi.fn();

    await initConnectionWithDependencies(
      {
        health: async () => HEALTHY_RESPONSE,
        loadInitialData: async () => {
          current = false;
          throw new Error('stale failure');
        },
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
        isCurrent: () => current,
      }
    );

    expect(setInitialized).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it('starts connection initialization only once at a time', async () => {
    let nextAttempt = 0;
    let activeAttempt: number | null = null;
    const init = deferred<void>();
    const initConnection = vi.fn(() => init.promise);

    ensureConnectionInitializedWithDependencies({
      isInitialized: () => false,
      isInitializing: () => activeAttempt !== null,
      initConnection,
      beginInitializing: () => {
        activeAttempt = ++nextAttempt;
        return activeAttempt;
      },
      finishInitializing: (attempt) => {
        if (activeAttempt === attempt) activeAttempt = null;
      },
    });

    ensureConnectionInitializedWithDependencies({
      isInitialized: () => false,
      isInitializing: () => activeAttempt !== null,
      initConnection,
      beginInitializing: () => {
        activeAttempt = ++nextAttempt;
        return activeAttempt;
      },
      finishInitializing: (attempt) => {
        if (activeAttempt === attempt) activeAttempt = null;
      },
    });

    expect(initConnection).toHaveBeenCalledTimes(1);

    init.resolve();
    await Promise.resolve();
    expect(activeAttempt).toBeNull();
  });

  it('does not let an invalidated initialization attempt clear a replacement attempt', async () => {
    let nextAttempt = 0;
    let activeAttempt: number | null = null;
    const first = deferred<void>();
    const second = deferred<void>();
    const initConnection = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ensure = () =>
      ensureConnectionInitializedWithDependencies({
        isInitialized: () => false,
        isInitializing: () => activeAttempt !== null,
        initConnection,
        beginInitializing: () => {
          activeAttempt = ++nextAttempt;
          return activeAttempt;
        },
        finishInitializing: (attempt) => {
          if (activeAttempt === attempt) activeAttempt = null;
        },
      });

    ensure();
    const firstAttempt = activeAttempt;
    activeAttempt = null;
    ensure();
    const secondAttempt = activeAttempt;

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(firstAttempt).not.toBe(secondAttempt);
    expect(activeAttempt).toBe(secondAttempt);

    second.resolve();
    await second.promise;
    await Promise.resolve();
    expect(activeAttempt).toBeNull();
  });

  it('ignores a deferred initialization invalidated by a workspace change', async () => {
    let generation = 0;
    const firstHealth = deferred<typeof HEALTHY_RESPONSE>();
    const setInitialized = vi.fn();
    const deps = {
      health: () => firstHealth.promise,
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
      setError: vi.fn(),
    };
    const generationRef = {
      next: () => ++generation,
      isCurrent: (candidate: number) => candidate === generation,
    };

    const staleInitialization = initConnectionWithDependencies(deps, generationRef);
    generation += 1;
    firstHealth.resolve(HEALTHY_RESPONSE);
    await staleInitialization;

    expect(deps.loadInitialData).not.toHaveBeenCalled();
    expect(setInitialized).not.toHaveBeenCalled();
  });

  it('allows a fresh initialization after a deferred attempt is stopped', async () => {
    let generation = 0;
    const staleData = deferred<void>();
    const setInitialized = vi.fn();
    const loadInitialData = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(staleData.promise)
      .mockResolvedValueOnce();
    const deps = {
      health: vi.fn(async () => HEALTHY_RESPONSE),
      loadInitialData,
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
      setError: vi.fn(),
    };
    const generationRef = {
      next: () => ++generation,
      isCurrent: (candidate: number) => candidate === generation,
    };

    const stoppedInitialization = initConnectionWithDependencies(deps, generationRef);
    await Promise.resolve();
    generation += 1;
    const restartedInitialization = initConnectionWithDependencies(deps, generationRef);
    await restartedInitialization;
    staleData.resolve();
    await stoppedInitialization;

    expect(loadInitialData).toHaveBeenCalledTimes(2);
    expect(setInitialized).toHaveBeenCalledOnce();
    expect(setInitialized).toHaveBeenCalledWith(true);
  });
});
