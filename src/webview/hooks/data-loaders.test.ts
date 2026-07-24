import { describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus, RecycleBinEntry } from '../../shared/protocol';
import type { Agent, QuestionRequest, Session, SessionStatus } from '../types';
import { provider, session } from './useOpenCode.test-support';
import {
  createDataLoaderOperations,
  hydrateSessionStatusesWithDependencies,
  loadAgentsWithDependencies,
  loadCommandsWithDependencies,
  loadMcpsWithDependencies,
  loadProviderAuthMethodsWithDependencies,
  loadProvidersWithDependencies,
  loadQuestionsWithDependencies,
  loadRecycleBinWithDependencies,
  loadSessionsWithDependencies,
  loadWorkspaceStatusesWithDependencies,
  refreshProviderLimitWithDependencies,
} from './data-loaders';

const buildAgent = (name: string): Agent => ({
  name,
  mode: 'primary',
  builtIn: true,
  permission: { edit: 'ask', bash: {} },
  tools: {},
});

type DataLoaderDependencies = Parameters<typeof createDataLoaderOperations>[0];

function createLoaderDeps(overrides: Partial<DataLoaderDependencies> = {}): DataLoaderDependencies {
  return {
    listMcpStatus: async () => ({}),
    setMcpStatus: vi.fn(),
    getActiveSessionId: () => null,
    getSelectedMcpsForSession: () => null,
    setSelectedMcpsForSession: vi.fn(),
    listQuestions: async () => [],
    setQuestions: vi.fn(),
    getQuestions: () => [],
    listAgents: async () => [],
    getSelectedAgent: () => null,
    getSelectedAgentForSession: () => null,
    getPersistedSelectedAgent: () => null,
    setAllAgents: vi.fn(),
    setPrimaryAgents: vi.fn(),
    setSelectedAgent: vi.fn(),
    listCommands: async () => [],
    setCommands: vi.fn(),
    listProviders: async () => ({ providers: [], default: {} }),
    setProvidersLoaded: vi.fn(),
    setProviders: vi.fn(),
    setProviderDefaults: vi.fn(),
    getSelectedModel: () => null,
    setSelectedModel: vi.fn(),
    loadProviderLimit: async () => ({
      providerID: 'openai',
      modelID: 'gpt-5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'Unsupported',
    }),
    setProviderLimit: vi.fn(),
    listSessions: async () => [],
    applySessions: vi.fn(),
    listRecycleBin: async () => [],
    setRecycleBinEntries: vi.fn(),
    loadSessionStatuses: async () => ({}),
    setSessionStatuses: vi.fn(),
    getSessions: () => [],
    clearQueuedMessagesForSession: vi.fn(),
    updateUsageLimitState: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('data loaders', () => {
  it('defaults the toolbar agent to build when no session is active', async () => {
    const setAllAgents = vi.fn();
    const setPrimaryAgents = vi.fn();
    const setSelectedAgent = vi.fn();
    const logError = vi.fn();

    await loadAgentsWithDependencies(
      {
        listAgents: async () => [buildAgent('plan'), buildAgent('build')],
        getActiveSessionId: () => null,
        getSelectedAgent: () => 'plan',
        getSelectedAgentForSession: () => null,
        getPersistedSelectedAgent: () => 'plan',
        setAllAgents,
        setPrimaryAgents,
        setSelectedAgent,
      },
      logError
    );

    expect(setAllAgents).toHaveBeenCalledTimes(1);
    expect(setPrimaryAgents).toHaveBeenCalledTimes(1);
    expect(setSelectedAgent).toHaveBeenCalledWith('build', { persistGlobal: false });
    expect(logError).not.toHaveBeenCalled();
  });

  it('hydrates connected mcps into the active session when none are selected', async () => {
    const setMcpStatus = vi.fn();
    const setSelectedMcpsForSession = vi.fn();
    const logError = vi.fn();

    await loadMcpsWithDependencies(
      {
        listMcpStatus: async () => ({
          alpha: { status: 'connected' },
          beta: { status: 'disabled' },
          gamma: { status: 'connected' },
        }),
        setMcpStatus,
        getActiveSessionId: () => 'session-1',
        getSelectedMcpsForSession: () => null,
        setSelectedMcpsForSession,
      },
      logError
    );

    expect(setMcpStatus).toHaveBeenCalledWith({
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
      gamma: { status: 'connected' },
    });
    expect(setSelectedMcpsForSession).toHaveBeenCalledWith('session-1', ['alpha', 'gamma']);
    expect(logError).not.toHaveBeenCalled();
  });

  it('does not overwrite an explicitly empty MCP selection during status hydration', async () => {
    const setSelectedMcpsForSession = vi.fn();

    await loadMcpsWithDependencies(
      {
        listMcpStatus: async () => ({
          alpha: { status: 'connected' },
        }),
        setMcpStatus: vi.fn(),
        getActiveSessionId: () => 'session-1',
        getSelectedMcpsForSession: () => [],
        setSelectedMcpsForSession,
      },
      vi.fn()
    );

    expect(setSelectedMcpsForSession).not.toHaveBeenCalled();
  });

  it('applies only the latest overlapping MCP status response', async () => {
    const responseA = deferred<Record<string, { status: 'connected' }>>();
    const responseB = deferred<Record<string, { status: 'connected' }>>();
    const activeSession = { value: 'session-a' };
    const setMcpStatus = vi.fn();
    const listMcpStatus = vi
      .fn<() => Promise<Record<string, { status: 'connected' }>>>()
      .mockReturnValueOnce(responseA.promise)
      .mockReturnValueOnce(responseB.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listMcpStatus,
        setMcpStatus,
        getActiveSessionId: () => activeSession.value,
        getSelectedMcpsForSession: () => [],
      })
    );

    const loadA = operations.loadMcps();
    activeSession.value = 'session-b';
    const loadB = operations.loadMcps();
    responseB.resolve({ beta: { status: 'connected' } });
    await loadB;
    responseA.resolve({ alpha: { status: 'connected' } });
    await loadA;

    expect(setMcpStatus).toHaveBeenCalledTimes(1);
    expect(setMcpStatus).toHaveBeenCalledWith({ beta: { status: 'connected' } });
  });

  it('deduplicates concurrent MCP status loads for the same active session', async () => {
    const response = deferred<Record<string, { status: 'connected' }>>();
    const listMcpStatus = vi.fn(() => response.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listMcpStatus,
        getActiveSessionId: () => 'session-1',
        getSelectedMcpsForSession: () => [],
      })
    );

    const first = operations.loadMcps();
    const second = operations.loadMcps();
    expect(listMcpStatus).toHaveBeenCalledTimes(1);

    response.resolve({ alpha: { status: 'connected' } });
    await Promise.all([first, second]);
  });

  it('does not initialize MCP selection for a session activated while status was loading', async () => {
    const response = deferred<Record<string, { status: 'connected' }>>();
    const activeSession = { value: 'session-a' };
    const setSelectedMcpsForSession = vi.fn();

    const load = loadMcpsWithDependencies(
      {
        listMcpStatus: () => response.promise,
        setMcpStatus: vi.fn(),
        getActiveSessionId: () => activeSession.value,
        getSelectedMcpsForSession: () => null,
        setSelectedMcpsForSession,
      },
      vi.fn()
    );
    activeSession.value = 'session-b';
    response.resolve({ alpha: { status: 'connected' } });
    await load;

    expect(setSelectedMcpsForSession).not.toHaveBeenCalled();
  });

  it('reconciles invalid selected models when providers load', async () => {
    const setProvidersLoaded = vi.fn();
    const setProviders = vi.fn();
    const setProviderDefaults = vi.fn();
    const setSelectedModel = vi.fn();
    const logError = vi.fn();

    await loadProvidersWithDependencies(
      {
        listProviders: async () => ({
          providers: [
            provider('openai', {
              'gpt-5': {
                id: 'gpt-5',
                name: 'GPT-5',
                capabilities: { toolcall: true },
                cost: { input: 0, output: 0 },
              },
            }),
          ],
          default: { openai: 'gpt-5' },
        }),
        setProvidersLoaded,
        setProviders,
        setProviderDefaults,
        getSelectedModel: () => ({ providerID: 'missing', modelID: 'none' }),
        setSelectedModel,
      },
      logError
    );

    expect(setProvidersLoaded).toHaveBeenNthCalledWith(1, false);
    expect(setProvidersLoaded).toHaveBeenNthCalledWith(2, true);
    expect(setSelectedModel).toHaveBeenCalledWith(null);
    expect(logError).not.toHaveBeenCalled();
  });

  it('initializes model visibility only for providers connected after the initial load', async () => {
    let providers = [provider('existing', {})];
    const setProviders = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listProviders: async () => ({ providers }),
        setProviders,
      })
    );

    await operations.loadProviders();
    expect(setProviders).toHaveBeenLastCalledWith(providers, {}, []);

    providers = [...providers, provider('newly-connected', {})];
    await operations.loadProviders();
    expect(setProviders).toHaveBeenLastCalledWith(providers, {}, ['newly-connected']);

    providers = providers.filter((item) => item.id !== 'newly-connected');
    await operations.loadProviders();
    providers = [...providers, provider('newly-connected', {})];
    await operations.loadProviders();
    expect(setProviders).toHaveBeenLastCalledWith(providers, {}, []);
  });

  it('excludes unavailable models from OpenAI', async () => {
    const openAi = provider('openai', {
      'gpt-5.6-pro': {
        id: 'gpt-5.6-pro',
        name: 'GPT-5.6 Pro',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-5.6': {
        id: 'gpt-5.6',
        name: 'GPT-5.6',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-5.6-fast': {
        id: 'gpt-5.6-fast',
        name: 'GPT-5.6 Fast',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    });
    const other = provider('other', {
      pro: {
        id: 'pro',
        name: 'Other Pro',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    });
    const setProviders = vi.fn();
    const setProviderDefaults = vi.fn();
    const setSelectedModel = vi.fn();

    await loadProvidersWithDependencies(
      {
        listProviders: async () => ({
          providers: [openAi, other],
          default: { openai: 'gpt-5.6-fast', other: 'pro' },
        }),
        setProvidersLoaded: vi.fn(),
        setProviders,
        setProviderDefaults,
        getSelectedModel: () => null,
        setSelectedModel,
      },
      vi.fn()
    );

    const loadedProviders = setProviders.mock.calls[0]?.[0];
    expect(Object.keys(loadedProviders[0].models)).toEqual(['gpt-5.5']);
    expect(Object.keys(loadedProviders[1].models)).toEqual(['pro']);
    expect(setProviders).toHaveBeenCalledWith(loadedProviders, { other: 'pro' });
    expect(setProviderDefaults).toHaveBeenCalledWith({ other: 'pro' });
    expect(setSelectedModel).toHaveBeenCalledWith({
      providerID: 'openai',
      modelID: 'gpt-5.5',
    });
  });

  it('hydrates session statuses and usage-limit state for loaded sessions', async () => {
    const setSessionStatuses = vi.fn();
    const updateUsageLimitState = vi.fn();
    const logError = vi.fn();
    const statuses: Record<string, SessionStatus> = {
      'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
      'session-2': { type: 'idle' },
    };
    const sessions: Session[] = [session('session-1'), session('session-2')];

    await hydrateSessionStatusesWithDependencies(
      {
        loadSessionStatuses: async () => statuses,
        setSessionStatuses,
        getSessions: () => sessions,
        updateUsageLimitState,
      },
      logError
    );

    expect(setSessionStatuses).toHaveBeenCalledWith(statuses, {
      snapshotStartedAt: expect.any(Number),
    });
    expect(updateUsageLimitState).toHaveBeenNthCalledWith(
      1,
      'session-1',
      statuses['session-1'],
      []
    );
    expect(updateUsageLimitState).toHaveBeenNthCalledWith(
      2,
      'session-2',
      statuses['session-2'],
      []
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('loads commands, questions, sessions, recycle bin entries, and provider limits', async () => {
    const setCommands = vi.fn();
    const setQuestions = vi.fn();
    const applySessions = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const setProviderLimit = vi.fn();
    const logError = vi.fn();
    const question: QuestionRequest = {
      id: 'question-1',
      sessionID: 'session-1',
      questions: [],
    };
    const limit: ProviderLimitStatus = {
      providerID: 'openai',
      modelID: 'gpt-5',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'Unsupported',
    };
    const sessions: Session[] = [session('session-1')];
    const recycleBinEntries: RecycleBinEntry[] = [
      {
        rootID: 'session-1',
        deletedAt: 1,
        expiresAt: 2,
        root: {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Session',
          version: '1',
          time: { created: 0, updated: 0 },
        },
        sessions: [],
      },
    ];

    await loadCommandsWithDependencies(
      {
        listCommands: async () => [{ name: 'review', template: '/review' }],
        setCommands,
      },
      logError
    );
    await loadQuestionsWithDependencies(
      {
        listQuestions: async () => [question],
        setQuestions,
      },
      logError
    );
    await loadSessionsWithDependencies(
      {
        listSessions: async () => sessions,
        applySessions,
      },
      logError
    );
    await loadRecycleBinWithDependencies(
      {
        listRecycleBin: async () => recycleBinEntries,
        setRecycleBinEntries,
      },
      logError
    );
    await refreshProviderLimitWithDependencies(
      {
        loadProviderLimit: async () => limit,
        setProviderLimit,
      },
      'openai',
      'gpt-5',
      logError
    );

    expect(setCommands).toHaveBeenCalledWith([{ name: 'review', template: '/review' }]);
    expect(setQuestions).toHaveBeenCalledWith([question]);
    expect(applySessions).toHaveBeenCalled();
    expect(setRecycleBinEntries).toHaveBeenCalled();
    expect(setProviderLimit).toHaveBeenCalledWith('openai', 'gpt-5', limit);
    expect(logError).not.toHaveBeenCalled();
  });

  it('loads provider auth methods and workspace statuses', async () => {
    const setProviderAuthMethods = vi.fn();
    const setWorkspaceStatuses = vi.fn();
    const logError = vi.fn();

    await loadProviderAuthMethodsWithDependencies(
      {
        listProviderAuthMethods: async () => ({
          openai: [{ type: 'oauth', label: 'Browser login' }],
        }),
        setProviderAuthMethods,
      },
      logError
    );

    await loadWorkspaceStatusesWithDependencies(
      {
        listWorkspaceStatuses: async () => [{ workspaceID: 'ws-1', status: 'connected' }],
        setWorkspaceStatuses,
      },
      logError
    );

    expect(setProviderAuthMethods).toHaveBeenCalledWith({
      openai: [{ type: 'oauth', label: 'Browser login' }],
    });
    expect(setWorkspaceStatuses).toHaveBeenCalledWith([
      { workspaceID: 'ws-1', status: 'connected' },
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('preserves a session created while an older session snapshot is in flight', async () => {
    const response = deferred<Session[]>();
    let currentSessions = [session('existing')];
    const applySessions = vi.fn((sessions: Session[]) => {
      currentSessions = sessions;
    });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: () => response.promise,
        getSessions: () => currentSessions,
        applySessions,
      })
    );

    const load = operations.loadSessions();
    currentSessions = [...currentSessions, session('new-session')];
    response.resolve([session('existing')]);
    await load;

    expect(applySessions).toHaveBeenCalledWith([session('existing'), session('new-session')]);
  });

  it('allows a locally removed session to reappear in a later snapshot', async () => {
    const first = deferred<Session[]>();
    const removed = session('removed');
    let currentSessions = [removed];
    const applySessions = vi.fn((sessions: Session[]) => {
      currentSessions = sessions;
    });
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([removed]);
    const operations = createDataLoaderOperations(
      createLoaderDeps({ listSessions, getSessions: () => currentSessions, applySessions })
    );

    const staleLoad = operations.loadSessions();
    currentSessions = [];
    first.resolve([removed]);
    await staleLoad;
    expect(currentSessions).toEqual([]);

    await operations.loadSessions();
    expect(currentSessions).toEqual([removed]);
  });

  it('clears queued messages for sessions removed by a confirmed snapshot', async () => {
    const removed = session('removed');
    const retained = session('retained');
    let currentSessions = [removed, retained];
    const clearQueuedMessagesForSession = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [retained],
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
      })
    );

    await operations.loadSessions();

    expect(currentSessions).toEqual([retained]);
    expect(clearQueuedMessagesForSession).toHaveBeenCalledOnce();
    expect(clearQueuedMessagesForSession).toHaveBeenCalledWith('removed');
  });

  it('applies only the latest overlapping session snapshot', async () => {
    const first = deferred<Session[]>();
    const second = deferred<Session[]>();
    let currentSessions = [session('existing')];
    const applySessions = vi.fn((sessions: Session[]) => {
      currentSessions = sessions;
    });
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({ listSessions, getSessions: () => currentSessions, applySessions })
    );

    const staleLoad = operations.loadSessions();
    const latestLoad = operations.loadSessions();
    second.resolve([session('latest')]);
    await latestLoad;
    first.resolve([session('stale')]);
    await staleLoad;

    expect(currentSessions).toEqual([session('latest')]);
    expect(applySessions).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a question answered while its snapshot is in flight', async () => {
    const response = deferred<QuestionRequest[]>();
    const answered: QuestionRequest = {
      id: 'answered',
      sessionID: 'session-1',
      questions: [],
    };
    const current: QuestionRequest = {
      id: 'current',
      sessionID: 'session-1',
      questions: [],
    };
    let questions = [answered];
    const setQuestions = vi.fn((next: QuestionRequest[]) => {
      questions = next;
    });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listQuestions: () => response.promise,
        getQuestions: () => questions,
        setQuestions,
      })
    );

    const load = operations.loadQuestions();
    questions = [];
    response.resolve([answered, current]);
    await load;

    expect(questions).toEqual([current]);
    expect(setQuestions).toHaveBeenCalledWith([current]);
  });

  it('allows an answered question to reappear in a later snapshot', async () => {
    const first = deferred<QuestionRequest[]>();
    const answered: QuestionRequest = {
      id: 'answered',
      sessionID: 'session-1',
      questions: [],
    };
    let questions = [answered];
    const setQuestions = vi.fn((next: QuestionRequest[]) => {
      questions = next;
    });
    const listQuestions = vi
      .fn<() => Promise<QuestionRequest[]>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([answered]);
    const operations = createDataLoaderOperations(
      createLoaderDeps({ listQuestions, getQuestions: () => questions, setQuestions })
    );

    const staleLoad = operations.loadQuestions();
    questions = [];
    first.resolve([answered]);
    await staleLoad;
    expect(questions).toEqual([]);

    await operations.loadQuestions();
    expect(questions).toEqual([answered]);
  });

  it('requires confirmation before applying an empty session snapshot over existing sessions', async () => {
    const applySessions = vi.fn();
    const logError = vi.fn();
    const currentSessions = [session('session-1')];

    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [],
        applySessions,
        getSessions: () => currentSessions,
        logError,
      })
    );

    await operations.loadSessions();
    expect(applySessions).not.toHaveBeenCalled();

    await operations.loadSessions();
    expect(applySessions).toHaveBeenCalledWith([]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('resets empty session snapshot confirmation after a non-empty snapshot', async () => {
    const applySessions = vi.fn();
    const logError = vi.fn();
    const currentSessions = [session('session-1')];
    const listedSessions = [session('session-1')];
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(listedSessions)
      .mockResolvedValueOnce([]);

    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions,
        applySessions,
        getSessions: () => currentSessions,
        logError,
      })
    );

    await operations.loadSessions();
    await operations.loadSessions();
    await operations.loadSessions();

    expect(applySessions).toHaveBeenCalledTimes(1);
    expect(applySessions).toHaveBeenCalledWith(listedSessions);
    expect(logError).not.toHaveBeenCalled();
  });
});
