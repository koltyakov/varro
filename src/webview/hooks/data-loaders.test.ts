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

    expect(setSessionStatuses).toHaveBeenCalledWith(statuses);
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

  it('creates loader operations that reuse the same dependency bag', async () => {
    const setCommands = vi.fn();
    const setQuestions = vi.fn();
    const applySessions = vi.fn();
    const setRecycleBinEntries = vi.fn();
    const setProviderLimit = vi.fn();
    const setSessionStatuses = vi.fn();
    const updateUsageLimitState = vi.fn();
    const logError = vi.fn();

    const operations = createDataLoaderOperations({
      listMcpStatus: async () => ({}),
      setMcpStatus: vi.fn(),
      getActiveSessionId: () => null,
      getSelectedMcpsForSession: () => null,
      setSelectedMcpsForSession: vi.fn(),
      listQuestions: async () => [],
      setQuestions,
      listAgents: async () => [buildAgent('build')],
      getSelectedAgent: () => null,
      getSelectedAgentForSession: () => null,
      getPersistedSelectedAgent: () => null,
      setAllAgents: vi.fn(),
      setPrimaryAgents: vi.fn(),
      setSelectedAgent: vi.fn(),
      listCommands: async () => [{ name: 'review', template: '/review' }],
      setCommands,
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
      setProviderLimit,
      listSessions: async () => [session('session-1')],
      applySessions,
      listRecycleBin: async () => [],
      setRecycleBinEntries,
      loadSessionStatuses: async () => ({ 'session-1': { type: 'idle' } }),
      setSessionStatuses,
      getSessions: () => [session('session-1')],
      updateUsageLimitState,
      logError,
    });

    await operations.loadCommands();
    await operations.loadQuestions();
    await operations.loadSessions();
    await operations.loadRecycleBin();
    await operations.refreshProviderLimit('openai', 'gpt-5');
    await operations.hydrateSessionStatuses();

    expect(setCommands).toHaveBeenCalledWith([{ name: 'review', template: '/review' }]);
    expect(setQuestions).toHaveBeenCalledWith([]);
    expect(applySessions).toHaveBeenCalledWith([session('session-1')]);
    expect(setRecycleBinEntries).toHaveBeenCalledWith([]);
    expect(setProviderLimit).toHaveBeenCalledWith(
      'openai',
      'gpt-5',
      expect.objectContaining({ status: 'unsupported' })
    );
    expect(setSessionStatuses).toHaveBeenCalledWith({ 'session-1': { type: 'idle' } });
    expect(updateUsageLimitState).toHaveBeenCalledWith('session-1', { type: 'idle' }, []);
    expect(logError).not.toHaveBeenCalled();
  });
});
