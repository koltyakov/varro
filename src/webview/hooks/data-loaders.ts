import type { SelectedModel } from '../lib/state';
import type { McpStatus, ProviderLimitStatus, RecycleBinEntry } from '../../shared/protocol';
import type { Agent, Command, Provider, QuestionRequest, Session, SessionStatus } from '../types';
import { reconcileLoadedAgents, reconcileLoadedProviders } from './routing-state';

type Logger = (context: string, err: unknown) => void;

export function createDataLoaderOperations(deps: {
  listMcpStatus(): Promise<Record<string, McpStatus> | null | undefined>;
  setMcpStatus(status: Record<string, McpStatus>): void;
  getActiveSessionId(): string | null;
  getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  listQuestions(): Promise<QuestionRequest[]>;
  setQuestions(questions: QuestionRequest[]): void;
  listAgents(): Promise<Agent[]>;
  getSelectedAgent(): string | null;
  getSelectedAgentForSession(sessionId: string): string | null;
  getPersistedSelectedAgent(): string | null;
  setAllAgents(agents: Agent[]): void;
  setPrimaryAgents(agents: Agent[]): void;
  setSelectedAgent(
    agent: string | null,
    options: { sessionId?: string | null; persistGlobal: boolean }
  ): void;
  listCommands(): Promise<Command[] | null | undefined>;
  setCommands(commands: Command[]): void;
  listProviders(): Promise<{ providers: Provider[]; default?: Record<string, string> }>;
  setProvidersLoaded(value: boolean): void;
  setProviders(providers: Provider[]): void;
  setProviderDefaults(defaults: Record<string, string>): void;
  getSelectedModel(): SelectedModel | null;
  setSelectedModel(model: SelectedModel | null): void;
  loadProviderLimit(providerID: string, modelID?: string | null): Promise<ProviderLimitStatus>;
  setProviderLimit(
    providerID: string,
    modelID: string | null | undefined,
    limit: ProviderLimitStatus
  ): void;
  listSessions(): Promise<Session[]>;
  applySessions(sessions: Session[]): void;
  listRecycleBin(): Promise<RecycleBinEntry[] | null | undefined>;
  setRecycleBinEntries(entries: RecycleBinEntry[]): void;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  setSessionStatuses(statuses: Record<string, SessionStatus>): void;
  getSessions(): Session[];
  updateUsageLimitState(
    sessionId: string,
    status: SessionStatus | null | undefined,
    messages?: Array<unknown>
  ): void;
  logError: Logger;
}) {
  const loadMcps = async () => {
    await loadMcpsWithDependencies(
      {
        listMcpStatus: deps.listMcpStatus,
        setMcpStatus: deps.setMcpStatus,
        getActiveSessionId: deps.getActiveSessionId,
        getSelectedMcpsForSession: deps.getSelectedMcpsForSession,
        setSelectedMcpsForSession: deps.setSelectedMcpsForSession,
      },
      deps.logError
    );
  };

  const loadQuestions = async () => {
    await loadQuestionsWithDependencies(
      {
        listQuestions: deps.listQuestions,
        setQuestions: deps.setQuestions,
      },
      deps.logError
    );
  };

  const loadAgents = async () => {
    await loadAgentsWithDependencies(
      {
        listAgents: deps.listAgents,
        getActiveSessionId: deps.getActiveSessionId,
        getSelectedAgent: deps.getSelectedAgent,
        getSelectedAgentForSession: deps.getSelectedAgentForSession,
        getPersistedSelectedAgent: deps.getPersistedSelectedAgent,
        setAllAgents: deps.setAllAgents,
        setPrimaryAgents: deps.setPrimaryAgents,
        setSelectedAgent: deps.setSelectedAgent,
      },
      deps.logError
    );
  };

  const loadCommands = async () => {
    await loadCommandsWithDependencies(
      {
        listCommands: deps.listCommands,
        setCommands: deps.setCommands,
      },
      deps.logError
    );
  };

  const loadProviders = async () => {
    await loadProvidersWithDependencies(
      {
        listProviders: deps.listProviders,
        setProvidersLoaded: deps.setProvidersLoaded,
        setProviders: deps.setProviders,
        setProviderDefaults: deps.setProviderDefaults,
        getSelectedModel: deps.getSelectedModel,
        setSelectedModel: deps.setSelectedModel,
      },
      deps.logError
    );
  };

  const refreshRoutingState = async () => {
    await Promise.all([loadAgents(), loadProviders()]);
  };

  const refreshProviderLimit = async (providerID: string, modelID?: string | null) => {
    await refreshProviderLimitWithDependencies(
      {
        loadProviderLimit: deps.loadProviderLimit,
        setProviderLimit: deps.setProviderLimit,
      },
      providerID,
      modelID,
      deps.logError
    );
  };

  const loadSessions = async () => {
    await loadSessionsWithDependencies(
      {
        listSessions: deps.listSessions,
        applySessions: deps.applySessions,
      },
      deps.logError
    );
  };

  const loadRecycleBin = async () => {
    await loadRecycleBinWithDependencies(
      {
        listRecycleBin: deps.listRecycleBin,
        setRecycleBinEntries: deps.setRecycleBinEntries,
      },
      deps.logError
    );
  };

  const hydrateSessionStatuses = async () => {
    await hydrateSessionStatusesWithDependencies(
      {
        loadSessionStatuses: deps.loadSessionStatuses,
        setSessionStatuses: deps.setSessionStatuses,
        getSessions: deps.getSessions,
        updateUsageLimitState: deps.updateUsageLimitState,
      },
      deps.logError
    );
  };

  return {
    loadMcps,
    loadQuestions,
    loadAgents,
    loadCommands,
    loadProviders,
    refreshRoutingState,
    refreshProviderLimit,
    loadSessions,
    loadRecycleBin,
    hydrateSessionStatuses,
  };
}

export async function loadMcpsWithDependencies(
  deps: {
    listMcpStatus(): Promise<Record<string, McpStatus> | null | undefined>;
    setMcpStatus(status: Record<string, McpStatus>): void;
    getActiveSessionId(): string | null;
    getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  },
  logError: Logger
) {
  try {
    const status = await deps.listMcpStatus();
    const nextStatus = status || {};
    deps.setMcpStatus(nextStatus);
    const activeSessionId = deps.getActiveSessionId();
    if (activeSessionId && !deps.getSelectedMcpsForSession(activeSessionId)) {
      deps.setSelectedMcpsForSession(
        activeSessionId,
        Object.entries(nextStatus)
          .filter(([, value]) => value?.status === 'connected')
          .map(([name]) => name)
      );
    }
  } catch (err) {
    logError('loadMcps', err);
  }
}

export async function loadQuestionsWithDependencies(
  deps: {
    listQuestions(): Promise<QuestionRequest[]>;
    setQuestions(questions: QuestionRequest[]): void;
  },
  logError: Logger
) {
  try {
    const questions = await deps.listQuestions();
    deps.setQuestions(questions);
  } catch (err) {
    logError('loadQuestions', err);
  }
}

export async function loadAgentsWithDependencies(
  deps: {
    listAgents(): Promise<Agent[]>;
    getActiveSessionId(): string | null;
    getSelectedAgent(): string | null;
    getSelectedAgentForSession(sessionId: string): string | null;
    getPersistedSelectedAgent(): string | null;
    setAllAgents(agents: Agent[]): void;
    setPrimaryAgents(agents: Agent[]): void;
    setSelectedAgent(
      agent: string | null,
      options: { sessionId?: string | null; persistGlobal: boolean }
    ): void;
  },
  logError: Logger
) {
  try {
    const loadedAgents = await deps.listAgents();
    const activeSessionId = deps.getActiveSessionId();
    const routingState = reconcileLoadedAgents({
      loadedAgents,
      activeSessionId,
      selectedAgent: deps.getSelectedAgent(),
      sessionSelectedAgent: activeSessionId
        ? deps.getSelectedAgentForSession(activeSessionId)
        : null,
      persistedSelectedAgent: deps.getPersistedSelectedAgent(),
    });

    deps.setAllAgents(routingState.visibleAgents);
    deps.setPrimaryAgents(routingState.primaryAgents);
    if (routingState.nextSelectedAgent) {
      deps.setSelectedAgent(
        routingState.nextSelectedAgent.value,
        routingState.nextSelectedAgent.options
      );
    }
  } catch (err) {
    logError('loadAgents', err);
  }
}

export async function loadCommandsWithDependencies(
  deps: {
    listCommands(): Promise<Command[] | null | undefined>;
    setCommands(commands: Command[]): void;
  },
  logError: Logger
) {
  try {
    const commands = await deps.listCommands();
    deps.setCommands(commands || []);
  } catch (err) {
    logError('loadCommands', err);
  }
}

export async function loadProvidersWithDependencies(
  deps: {
    listProviders(): Promise<{ providers: Provider[]; default?: Record<string, string> }>;
    setProvidersLoaded(value: boolean): void;
    setProviders(providers: Provider[]): void;
    setProviderDefaults(defaults: Record<string, string>): void;
    getSelectedModel(): SelectedModel | null;
    setSelectedModel(model: SelectedModel | null): void;
  },
  logError: Logger
) {
  deps.setProvidersLoaded(false);
  try {
    const res = await deps.listProviders();
    const providerDefaults = res.default || {};
    deps.setProviders(res.providers);
    deps.setProviderDefaults(providerDefaults);
    deps.setProvidersLoaded(true);

    const routingState = reconcileLoadedProviders({
      selectedModel: deps.getSelectedModel(),
      providers: res.providers,
      providerDefaults,
    });
    if (routingState.nextSelectedModel !== undefined) {
      deps.setSelectedModel(routingState.nextSelectedModel);
    }
  } catch (err) {
    logError('loadProviders', err);
  }
}

export async function refreshProviderLimitWithDependencies(
  deps: {
    loadProviderLimit(providerID: string, modelID?: string | null): Promise<ProviderLimitStatus>;
    setProviderLimit(
      providerID: string,
      modelID: string | null | undefined,
      limit: ProviderLimitStatus
    ): void;
  },
  providerID: string,
  modelID: string | null | undefined,
  logError: Logger
) {
  try {
    const limit = await deps.loadProviderLimit(providerID, modelID);
    deps.setProviderLimit(providerID, modelID, limit);
  } catch (err) {
    logError('loadProviderLimit', err);
  }
}

export async function loadSessionsWithDependencies(
  deps: {
    listSessions(): Promise<Session[]>;
    applySessions(sessions: Session[]): void;
  },
  logError: Logger
) {
  try {
    const sessions = await deps.listSessions();
    deps.applySessions(sessions);
  } catch (err) {
    logError('loadSessions', err);
  }
}

export async function loadRecycleBinWithDependencies(
  deps: {
    listRecycleBin(): Promise<RecycleBinEntry[] | null | undefined>;
    setRecycleBinEntries(entries: RecycleBinEntry[]): void;
  },
  logError: Logger
) {
  try {
    const entries = await deps.listRecycleBin();
    deps.setRecycleBinEntries(entries || []);
  } catch (err) {
    logError('loadRecycleBin', err);
  }
}

export async function hydrateSessionStatusesWithDependencies(
  deps: {
    loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
    setSessionStatuses(statuses: Record<string, SessionStatus>): void;
    getSessions(): Session[];
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages?: Array<unknown>
    ): void;
  },
  logError: Logger
) {
  try {
    const statuses = await deps.loadSessionStatuses();
    deps.setSessionStatuses(statuses);
    for (const session of deps.getSessions()) {
      deps.updateUsageLimitState(session.id, statuses[session.id], []);
    }
  } catch (err) {
    logError('session.status', err);
  }
}
