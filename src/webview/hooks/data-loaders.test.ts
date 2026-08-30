import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus, RecycleBinEntry } from '../../shared/protocol';
import type { Agent, QuestionRequest, Session, SessionStatus } from '../types';
import {
  getPersistedSelectedModel,
  getSelectedModelForSession,
  resetDefaultAppState,
  setPersistentShowSessionPicker,
  setSelectedModel as setStateSelectedModel,
  setState,
  state,
} from '../lib/state';
import { getClientMocks, provider, session } from './useOpenCode.test-support';
import {
  createDataLoaderOperations,
  createStateBoundDataLoaderOperations,
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
const clientMocks = getClientMocks();

function createLoaderDeps(overrides: Partial<DataLoaderDependencies> = {}): DataLoaderDependencies {
  return {
    listMcpStatus: async () => ({}),
    setMcpStatus: vi.fn(),
    getActiveSessionId: () => null,
    getComposerSessionId: () => null,
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
    getSelectedModelForSession: () => null,
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
    listProviderAuthMethods: async () => ({}),
    setProviderAuthMethods: vi.fn(),
    listWorkspaceStatuses: async () => [],
    setWorkspaceStatuses: vi.fn(),
    finishWorkspaceCatalogReload: vi.fn(),
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

function createStateBoundLoader() {
  return createStateBoundDataLoaderOperations({
    applySessions: vi.fn(),
    updateUsageLimitState: vi.fn(),
    logError: (_context, error) => {
      throw error;
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('data loaders', () => {
  it('preserves the selected draft agent when no session is active', async () => {
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
    expect(setSelectedAgent).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('defaults the toolbar agent to build when no draft agent is selected', async () => {
    const setSelectedAgent = vi.fn();

    await loadAgentsWithDependencies(
      {
        listAgents: async () => [buildAgent('plan'), buildAgent('build')],
        getActiveSessionId: () => null,
        getSelectedAgent: () => null,
        getSelectedAgentForSession: () => null,
        getPersistedSelectedAgent: () => null,
        setAllAgents: vi.fn(),
        setPrimaryAgents: vi.fn(),
        setSelectedAgent,
      },
      vi.fn()
    );

    expect(setSelectedAgent).toHaveBeenCalledWith('build', { persistGlobal: false });
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

  it('starts a fresh MCP status load when an in-flight response predates a mutation', async () => {
    const responseA = deferred<Record<string, { status: 'connected' }>>();
    const responseB = deferred<Record<string, { status: 'connected' }>>();
    const setMcpStatus = vi.fn();
    const listMcpStatus = vi
      .fn<() => Promise<Record<string, { status: 'connected' }>>>()
      .mockReturnValueOnce(responseA.promise)
      .mockReturnValueOnce(responseB.promise);
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listMcpStatus,
        setMcpStatus,
        getActiveSessionId: () => 'session-1',
        getSelectedMcpsForSession: () => [],
      })
    );

    const staleLoad = operations.loadMcps();
    const freshLoad = operations.loadMcps({ fresh: true });
    expect(listMcpStatus).toHaveBeenCalledTimes(2);

    responseB.resolve({ beta: { status: 'connected' } });
    await freshLoad;
    responseA.resolve({ alpha: { status: 'connected' } });
    await staleLoad;

    expect(setMcpStatus).toHaveBeenCalledOnce();
    expect(setMcpStatus).toHaveBeenCalledWith({ beta: { status: 'connected' } });
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

  it('applies the exact server default instead of provider-scoped defaults', async () => {
    const setSelectedModel = vi.fn();
    const models = {
      'gpt-provider': {
        id: 'gpt-provider',
        name: 'GPT Provider',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-server': {
        id: 'gpt-server',
        name: 'GPT Server',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    };

    await loadProvidersWithDependencies(
      {
        listProviders: async () => ({
          providers: [provider('openai', models)],
          default: { openai: 'gpt-provider' },
          defaultModel: { providerID: 'openai', modelID: 'gpt-server' },
        }),
        setProvidersLoaded: vi.fn(),
        setProviders: vi.fn(),
        setProviderDefaults: vi.fn(),
        getSelectedModel: () => null,
        setSelectedModel,
      },
      vi.fn()
    );

    expect(setSelectedModel).toHaveBeenCalledWith({
      providerID: 'openai',
      modelID: 'gpt-server',
    });
  });

  it('keeps a hidden selected model while an existing session is active', async () => {
    const setSelectedModel = vi.fn();
    setState('hiddenModels', ['openai:gpt-5']);

    try {
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
          setProvidersLoaded: vi.fn(),
          setProviders: vi.fn(),
          setProviderDefaults: vi.fn(),
          getSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
          getComposerSessionId: () => 'session-1',
          setSelectedModel,
        },
        vi.fn()
      );

      expect(setSelectedModel).not.toHaveBeenCalled();
    } finally {
      setState('hiddenModels', []);
    }
  });

  it('preserves a hidden active-session model through provider operation wiring', async () => {
    const setSelectedModel = vi.fn();
    setState('hiddenModels', ['openai:gpt-5']);

    try {
      const operations = createDataLoaderOperations(
        createLoaderDeps({
          getComposerSessionId: () => 'session-1',
          getSelectedModel: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
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
          setSelectedModel,
        })
      );

      await operations.loadProviders();

      expect(setSelectedModel).not.toHaveBeenCalled();
    } finally {
      setState('hiddenModels', []);
    }
  });

  it('does not persist active-session model reconciliation as the global default', async () => {
    const setSelectedModel = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        getComposerSessionId: () => 'session-1',
        getSelectedModel: () => ({ providerID: 'missing', modelID: 'removed' }),
        listProviders: async () => ({
          providers: [provider('openai', {})],
          default: {},
        }),
        setSelectedModel,
      })
    );

    await operations.loadProviders();

    expect(setSelectedModel).toHaveBeenCalledWith(null, {
      persistGlobal: false,
    });
  });

  it('restores a preserved session model after an incomplete provider snapshot is retried', async () => {
    const persistedModel = { providerID: 'openai', modelID: 'gpt-5' };
    let selectedModel: typeof persistedModel | null = persistedModel;
    let providers = [provider('openai', {})];
    const setSelectedModel = vi.fn(
      (
        model: typeof persistedModel | null,
        options?: { sessionId?: string | null; persistGlobal?: boolean }
      ) => {
        selectedModel = model;
        expect(options?.sessionId).toBeUndefined();
      }
    );
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        getComposerSessionId: () => 'session-1',
        getSelectedModel: () => selectedModel,
        getSelectedModelForSession: () => persistedModel,
        listProviders: async () => ({ providers, default: {} }),
        setSelectedModel,
      })
    );

    await operations.loadProviders();

    expect(selectedModel).toBeNull();
    expect(setSelectedModel).toHaveBeenLastCalledWith(null, { persistGlobal: false });

    providers = [
      provider('openai', {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];
    await operations.loadProviders();

    expect(selectedModel).toEqual(persistedModel);
    expect(setSelectedModel).toHaveBeenLastCalledWith(persistedModel, { persistGlobal: false });
  });

  describe('state-bound provider loading', () => {
    const globalModel = { providerID: 'openai', modelID: 'gpt-global' };
    const sessionModel = { providerID: 'openai', modelID: 'gpt-session' };
    const loadedProvider = provider('openai', {
      'gpt-global': {
        id: 'gpt-global',
        name: 'GPT Global',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      'gpt-session': {
        id: 'gpt-session',
        name: 'GPT Session',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    });

    beforeEach(() => {
      window.localStorage.clear();
      resetDefaultAppState();
      clientMocks.providerList.mockResolvedValue({
        providers: [loadedProvider],
        default: { openai: globalModel.modelID },
      });
    });

    afterEach(() => {
      window.localStorage.clear();
      resetDefaultAppState();
    });

    function selectSessionModel() {
      setStateSelectedModel({ ...globalModel });
      setState('activeSessionId', 'session-1');
      setStateSelectedModel({ ...sessionModel }, { sessionId: 'session-1', persistGlobal: false });
    }

    it('keeps the global draft model when the session picker retains an active session', async () => {
      selectSessionModel();
      setPersistentShowSessionPicker(true);
      expect(state.activeSessionId).toBe('session-1');
      expect(state.selectedModel).toEqual(globalModel);

      await createStateBoundLoader().loadProviders();

      expect(state.selectedModel).toEqual(globalModel);
      expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(globalModel);
    });

    it('restores the scoped model when the active session owns the composer', async () => {
      selectSessionModel();
      setStateSelectedModel(null, { persistGlobal: false });

      await createStateBoundLoader().loadProviders();

      expect(state.selectedModel).toEqual(sessionModel);
      expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(globalModel);
    });

    it('preserves a hidden model owned by the active composer session', async () => {
      selectSessionModel();
      setState('hiddenModels', ['openai:gpt-session']);

      await createStateBoundLoader().loadProviders();

      expect(state.selectedModel).toEqual(sessionModel);
      expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
      expect(getPersistedSelectedModel()).toEqual(globalModel);
    });
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

  it('retries only failed workspace catalogs and releases the reload lock after exhaustion', async () => {
    const listAgents = vi
      .fn<DataLoaderDependencies['listAgents']>()
      .mockRejectedValueOnce(new Error('agents unavailable'))
      .mockResolvedValueOnce([]);
    const listCommands = vi.fn<DataLoaderDependencies['listCommands']>().mockResolvedValue([]);
    const listProviders = vi
      .fn<DataLoaderDependencies['listProviders']>()
      .mockRejectedValue(new Error('providers unavailable'));
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents,
        listCommands,
        listProviders,
        finishWorkspaceCatalogReload,
      })
    );

    await expect(operations.reloadWorkspaceCatalogs()).resolves.toBe(false);

    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(listCommands).toHaveBeenCalledOnce();
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(finishWorkspaceCatalogReload).toHaveBeenCalledOnce();
  });

  it('bounds workspace catalog reloads that do not settle', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const listAgents = vi.fn<DataLoaderDependencies['listAgents']>(() => never);
    const listCommands = vi.fn<DataLoaderDependencies['listCommands']>(() => never);
    const listProviders = vi.fn<DataLoaderDependencies['listProviders']>(() => never);
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents,
        listCommands,
        listProviders,
        finishWorkspaceCatalogReload,
      })
    );

    try {
      const reload = operations.reloadWorkspaceCatalogs();
      await vi.runAllTimersAsync();

      await expect(reload).resolves.toBe(false);
      expect(listAgents).toHaveBeenCalledTimes(2);
      expect(listCommands).toHaveBeenCalledTimes(2);
      expect(listProviders).toHaveBeenCalledTimes(2);
      expect(finishWorkspaceCatalogReload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an invalidated catalog reload release the next workspace lock', async () => {
    const agents = deferred<Agent[]>();
    const commands = deferred<Array<{ name: string; template: string }>>();
    const providers = deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const finishWorkspaceCatalogReload = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents: () => agents.promise,
        listCommands: () => commands.promise,
        listProviders: () => providers.promise,
        finishWorkspaceCatalogReload,
      })
    );

    const reload = operations.reloadWorkspaceCatalogs();
    operations.invalidateWorkspace();
    agents.resolve([buildAgent('old')]);
    commands.resolve([{ name: 'old', template: '/old' }]);
    providers.resolve({ providers: [provider('old', {})], default: {} });

    await expect(reload).resolves.toBe(false);
    expect(finishWorkspaceCatalogReload).not.toHaveBeenCalled();
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
    const statuses = {
      'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
      'session-2': { type: 'idle' },
    } satisfies Record<string, SessionStatus>;
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

  it('reconciles stale selected agents from loaded session metadata', async () => {
    const loaded = { ...session('session-1'), agent: 'build' };
    const setSelectedAgent = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [loaded],
        setSelectedAgent,
      })
    );

    await operations.loadSessions();

    expect(setSelectedAgent).toHaveBeenCalledWith('build', {
      sessionId: 'session-1',
      persistGlobal: false,
      updateSelection: false,
      publishHost: false,
    });
  });

  it('preserves queues omitted from a partial refresh until a complete snapshot confirms removal', async () => {
    const stale = session('stale');
    const newest = session('newest');
    const oldest = session('oldest');
    let currentSessions = [stale];
    const clearQueuedMessagesForSession = vi.fn();
    const setSessionsHasMore = vi.fn();
    const setSessionsLoadingMore = vi.fn();
    const listSessions = vi
      .fn<DataLoaderDependencies['listSessions']>()
      .mockResolvedValueOnce({ items: [newest], hasMore: true })
      .mockResolvedValueOnce({ items: [newest, oldest], hasMore: false });
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions,
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
        setSessionsHasMore,
        setSessionsLoadingMore,
      })
    );

    await operations.loadSessions();

    expect(listSessions).toHaveBeenNthCalledWith(1, 100);
    expect(currentSessions).toEqual([newest, stale]);
    expect(setSessionsHasMore).toHaveBeenLastCalledWith(true);
    expect(clearQueuedMessagesForSession).not.toHaveBeenCalled();

    await operations.loadMoreSessions();

    expect(listSessions).toHaveBeenNthCalledWith(2, 200);
    expect(currentSessions).toEqual([newest, oldest]);
    expect(setSessionsHasMore).toHaveBeenLastCalledWith(false);
    expect(setSessionsLoadingMore.mock.calls).toEqual([[true], [false]]);
    expect(clearQueuedMessagesForSession).toHaveBeenCalledOnce();
    expect(clearQueuedMessagesForSession).toHaveBeenCalledWith('stale');
  });

  it('retains failed-root sessions without requesting a nonexistent continuation page', async () => {
    const failedRootSession = { ...session('failed-root'), directory: '/repo-b' };
    const staleHealthySession = { ...session('stale-healthy'), directory: '/repo-a' };
    const healthy = { ...session('healthy'), directory: '/repo-a' };
    let currentSessions = [failedRootSession, staleHealthySession];
    const clearQueuedMessagesForSession = vi.fn();
    const setSessionsHasMore = vi.fn();
    const setSessionsLoadError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => ({
          items: [healthy],
          hasMore: false,
          incomplete: true,
          unavailableDirectories: ['/repo-b'],
        }),
        getSessions: () => currentSessions,
        applySessions: (sessions) => {
          currentSessions = sessions;
        },
        clearQueuedMessagesForSession,
        setSessionsHasMore,
        setSessionsLoadError,
      })
    );

    await operations.loadSessions();

    expect(currentSessions).toEqual([healthy, failedRootSession]);
    expect(setSessionsHasMore).toHaveBeenLastCalledWith(false);
    expect(clearQueuedMessagesForSession).toHaveBeenCalledWith('stale-healthy');
    expect(setSessionsLoadError).toHaveBeenLastCalledWith('Could not load sessions from: /repo-b');
  });

  it('clears pagination loading state when workspace work is invalidated', async () => {
    const response = deferred<{ items: Session[]; hasMore: boolean }>();
    const setSessionsLoadingMore = vi.fn();
    const setSessionsPaginationError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: () => response.promise,
        setSessionsLoadingMore,
        setSessionsPaginationError,
      })
    );

    const load = operations.loadMoreSessions();
    operations.invalidateWorkspace();

    expect(setSessionsLoadingMore.mock.calls).toEqual([[true], [false]]);
    expect(setSessionsPaginationError).toHaveBeenLastCalledWith(null);

    response.resolve({ items: [], hasMore: false });
    await load;
  });

  it('clears a stale pagination error after a successful session refresh', async () => {
    const setSessionsPaginationError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => ({ items: [], hasMore: false }),
        setSessionsPaginationError,
      })
    );

    await operations.loadSessions();

    expect(setSessionsPaginationError).toHaveBeenLastCalledWith(null);
  });

  it('retries a failed load-more request without skipping a session window', async () => {
    const listSessions = vi
      .fn<DataLoaderDependencies['listSessions']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [], hasMore: false });
    const operations = createDataLoaderOperations(createLoaderDeps({ listSessions }));

    await operations.loadMoreSessions();
    await operations.loadMoreSessions();

    expect(listSessions.mock.calls).toEqual([[200], [200]]);
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

  it('applies only the latest overlapping routing, compatibility, and recycle loads', async () => {
    const firstAgents = deferred<Agent[]>();
    const latestAgents = deferred<Agent[]>();
    const firstCommands = deferred<Array<{ name: string; template: string }>>();
    const latestCommands = deferred<Array<{ name: string; template: string }>>();
    const firstProviders = deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const latestProviders =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviders']>>>();
    const firstAuth =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviderAuthMethods']>>>();
    const latestAuth =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listProviderAuthMethods']>>>();
    const firstWorkspaces =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listWorkspaceStatuses']>>>();
    const latestWorkspaces =
      deferred<Awaited<ReturnType<DataLoaderDependencies['listWorkspaceStatuses']>>>();
    const firstRecycleBin = deferred<RecycleBinEntry[]>();
    const latestRecycleBin = deferred<RecycleBinEntry[]>();
    const setAllAgents = vi.fn();
    const setCommands = vi.fn();
    const setProviders = vi.fn();
    const setProviderAuthMethods = vi.fn();
    const setWorkspaceStatuses = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents: vi
          .fn<DataLoaderDependencies['listAgents']>()
          .mockReturnValueOnce(firstAgents.promise)
          .mockReturnValueOnce(latestAgents.promise),
        setAllAgents,
        listCommands: vi
          .fn<DataLoaderDependencies['listCommands']>()
          .mockReturnValueOnce(firstCommands.promise)
          .mockReturnValueOnce(latestCommands.promise),
        setCommands,
        listProviders: vi
          .fn<DataLoaderDependencies['listProviders']>()
          .mockReturnValueOnce(firstProviders.promise)
          .mockReturnValueOnce(latestProviders.promise),
        setProviders,
        listProviderAuthMethods: vi
          .fn<DataLoaderDependencies['listProviderAuthMethods']>()
          .mockReturnValueOnce(firstAuth.promise)
          .mockReturnValueOnce(latestAuth.promise),
        setProviderAuthMethods,
        listWorkspaceStatuses: vi
          .fn<DataLoaderDependencies['listWorkspaceStatuses']>()
          .mockReturnValueOnce(firstWorkspaces.promise)
          .mockReturnValueOnce(latestWorkspaces.promise),
        setWorkspaceStatuses,
        listRecycleBin: vi
          .fn<DataLoaderDependencies['listRecycleBin']>()
          .mockReturnValueOnce(firstRecycleBin.promise)
          .mockReturnValueOnce(latestRecycleBin.promise),
        setRecycleBinEntries,
      })
    );

    const staleLoads = [
      operations.loadAgents(),
      operations.loadCommands(),
      operations.loadProviders(),
      operations.loadCompatibilityState(),
      operations.loadRecycleBin(),
    ];
    const latestLoads = [
      operations.loadAgents(),
      operations.loadCommands(),
      operations.loadProviders(),
      operations.loadCompatibilityState(),
      operations.loadRecycleBin(),
    ];
    latestAgents.resolve([buildAgent('latest')]);
    latestCommands.resolve([{ name: 'latest', template: '/latest' }]);
    latestProviders.resolve({ providers: [provider('latest', {})], default: {} });
    latestAuth.resolve({ latest: [{ type: 'api', label: 'Latest' }] });
    latestWorkspaces.resolve([{ workspaceID: 'latest', status: 'connected' }]);
    latestRecycleBin.resolve([]);
    await Promise.all(latestLoads);

    firstAgents.resolve([buildAgent('stale')]);
    firstCommands.resolve([{ name: 'stale', template: '/stale' }]);
    firstProviders.resolve({ providers: [provider('stale', {})], default: {} });
    firstAuth.resolve({ stale: [{ type: 'api', label: 'Stale' }] });
    firstWorkspaces.resolve([{ workspaceID: 'stale', status: 'connected' }]);
    firstRecycleBin.resolve([]);
    await Promise.all(staleLoads);

    expect(setAllAgents).toHaveBeenCalledOnce();
    expect(setAllAgents).toHaveBeenCalledWith([buildAgent('latest')]);
    expect(setCommands).toHaveBeenCalledOnce();
    expect(setCommands).toHaveBeenCalledWith([{ name: 'latest', template: '/latest' }]);
    expect(setProviders).toHaveBeenCalledOnce();
    expect(setProviders).toHaveBeenCalledWith([provider('latest', {})], {}, []);
    expect(setProviderAuthMethods).toHaveBeenCalledOnce();
    expect(setProviderAuthMethods).toHaveBeenCalledWith({
      latest: [{ type: 'api', label: 'Latest' }],
    });
    expect(setWorkspaceStatuses).toHaveBeenCalledOnce();
    expect(setWorkspaceStatuses).toHaveBeenCalledWith([
      { workspaceID: 'latest', status: 'connected' },
    ]);
    expect(setRecycleBinEntries).toHaveBeenCalledOnce();
  });

  it('does not apply workspace-sensitive loads invalidated by a workspace change', async () => {
    const agents = deferred<Agent[]>();
    const recycleBin = deferred<RecycleBinEntry[]>();
    const statuses = deferred<Record<string, SessionStatus>>();
    const sessions = deferred<Session[]>();
    const setAllAgents = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const setSessionStatuses = vi.fn();
    const applySessions = vi.fn();
    const setSessionsLoadError = vi.fn();
    const setRecycleBinLoadError = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listAgents: () => agents.promise,
        setAllAgents,
        listRecycleBin: () => recycleBin.promise,
        setRecycleBinEntries,
        loadSessionStatuses: () => statuses.promise,
        setSessionStatuses,
        listSessions: () => sessions.promise,
        applySessions,
        setSessionsLoadError,
        setRecycleBinLoadError,
      })
    );

    const staleLoads = Promise.all([
      operations.loadAgents(),
      operations.loadRecycleBin(),
      operations.hydrateSessionStatuses(),
      operations.loadSessions(),
    ]);
    operations.invalidateWorkspace();
    agents.resolve([buildAgent('build')]);
    recycleBin.resolve([]);
    statuses.resolve({ 'session-old': { type: 'busy' } });
    sessions.resolve([session('session-old')]);
    await staleLoads;

    expect(setAllAgents).not.toHaveBeenCalled();
    expect(setRecycleBinEntries).not.toHaveBeenCalled();
    expect(setSessionStatuses).not.toHaveBeenCalled();
    expect(applySessions).not.toHaveBeenCalled();
    expect(setSessionsLoadError).not.toHaveBeenCalled();
    expect(setRecycleBinLoadError).not.toHaveBeenCalled();
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

  it('resets empty-snapshot confirmation when workspace loads are invalidated', async () => {
    let currentSessions = [session('session-1')];
    const applySessions = vi.fn();
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => [],
        getSessions: () => currentSessions,
        applySessions,
      })
    );

    await operations.loadSessions();
    operations.invalidateWorkspace();
    await operations.loadSessions();
    expect(applySessions).not.toHaveBeenCalled();

    currentSessions = [];
    await operations.loadSessions();
    expect(applySessions).toHaveBeenCalledOnce();
    expect(applySessions).toHaveBeenCalledWith([]);
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

  it('flags session list load failures and clears the flag on the next success', async () => {
    const setSessionsLoadError = vi.fn();
    let fail = true;
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listSessions: async () => {
          if (fail) throw new Error('list failed');
          return [session('session-1')];
        },
        setSessionsLoadError,
      })
    );

    await operations.loadSessions();
    expect(setSessionsLoadError).toHaveBeenLastCalledWith('Failed to load sessions');

    fail = false;
    await operations.loadSessions();
    expect(setSessionsLoadError).toHaveBeenLastCalledWith(null);
  });

  it('flags recycle bin load failures and clears the flag on the next success', async () => {
    const setRecycleBinLoadError = vi.fn();
    let fail = true;
    const operations = createDataLoaderOperations(
      createLoaderDeps({
        listRecycleBin: async () => {
          if (fail) throw new Error('bin failed');
          return [];
        },
        setRecycleBinLoadError,
      })
    );

    await operations.loadRecycleBin();
    expect(setRecycleBinLoadError).toHaveBeenLastCalledWith('Failed to load the recycle bin');

    fail = false;
    await operations.loadRecycleBin();
    expect(setRecycleBinLoadError).toHaveBeenLastCalledWith(null);
  });
});
