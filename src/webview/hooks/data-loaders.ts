import type { SelectedModel } from '../lib/app-state-types';
import { client } from '../lib/client';
import { appStore } from '../lib/stores/app-store';
import { permissionsStore } from '../lib/stores/permissions-store';
import { routingStore } from '../lib/stores/routing-store';
import { sessionStore } from '../lib/stores/session-store';
import type { SessionStatusSnapshotOptions } from '../lib/stores/session-store';
import type { McpStatus, ProviderLimitStatus, RecycleBinEntry } from '../../shared/protocol';
import type {
  Agent,
  Command,
  Provider,
  ProviderAuthMethodsByProvider,
  QuestionRequest,
  Session,
  SessionStatus,
  WorkspaceStatusEntry,
} from '../types';
import { reconcileLoadedAgents, reconcileLoadedProviders } from './routing-state';

type Logger = (context: string, err: unknown) => void;
const EMPTY_SESSION_SNAPSHOT_CONFIRMATIONS = 2;

async function runLoad<T>(
  label: string,
  load: () => Promise<T>,
  apply: (value: T) => void,
  logError: Logger
): Promise<void> {
  try {
    apply(await load());
  } catch (err) {
    logError(label, err);
  }
}

export function createStateBoundDataLoaderOperations(deps: {
  applySessions(sessions: Session[]): void;
  updateUsageLimitState(
    sessionId: string,
    status: SessionStatus | null | undefined,
    messages?: Array<unknown>
  ): void;
  logError: Logger;
}) {
  return createDataLoaderOperations({
    listMcpStatus: () => client.mcp.status(),
    setMcpStatus: routingStore.setMcpStatus,
    getActiveSessionId: () => appStore.state.activeSessionId,
    getSelectedMcpsForSession: routingStore.getSelectedMcpsForSession,
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
    listQuestions: () => client.question.list(),
    setQuestions: permissionsStore.setQuestions,
    listAgents: () => client.agent.list(),
    getSelectedAgent: () => appStore.state.selectedAgent,
    getSelectedAgentForSession: routingStore.getSelectedAgentForSession,
    getPersistedSelectedAgent: routingStore.getPersistedSelectedAgent,
    setAllAgents: routingStore.setAllAgents,
    setPrimaryAgents: routingStore.setPrimaryAgents,
    setSelectedAgent: routingStore.setSelectedAgent,
    listCommands: () => client.command.list(),
    setCommands: routingStore.setCommands,
    listProviders: () => client.config.providers(),
    setProvidersLoaded: routingStore.setProvidersLoaded,
    setProviders: routingStore.setProviders,
    setProviderDefaults: routingStore.setProviderDefaults,
    getSelectedModel: () => appStore.state.selectedModel,
    setSelectedModel: routingStore.setSelectedModel,
    loadProviderLimit: (providerID, modelID) => client.config.providerLimit(providerID, modelID),
    setProviderLimit: routingStore.setProviderLimit,
    listProviderAuthMethods: () => client.config.providerAuth(),
    setProviderAuthMethods: routingStore.setProviderAuthMethods,
    listWorkspaceStatuses: () => client.config.workspaceStatus(),
    setWorkspaceStatuses: routingStore.setWorkspaceStatuses,
    listSessions: () => client.session.list(),
    applySessions: deps.applySessions,
    listRecycleBin: () => client.varro.recycleBin.list(),
    setRecycleBinEntries: sessionStore.setRecycleBinEntries,
    loadSessionStatuses: () => client.session.status(),
    setSessionStatuses: sessionStore.setSessionStatuses,
    getSessions: () => appStore.state.sessions,
    updateUsageLimitState: deps.updateUsageLimitState,
    logError: deps.logError,
  });
}

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
  setProviders(
    providers: Provider[],
    defaults?: Record<string, string>,
    newlyConnectedProviderIDs?: readonly string[]
  ): void;
  setProviderDefaults(defaults: Record<string, string>): void;
  getSelectedModel(): SelectedModel | null;
  setSelectedModel(model: SelectedModel | null): void;
  loadProviderLimit(providerID: string, modelID?: string | null): Promise<ProviderLimitStatus>;
  setProviderLimit(
    providerID: string,
    modelID: string | null | undefined,
    limit: ProviderLimitStatus
  ): void;
  listProviderAuthMethods(): Promise<ProviderAuthMethodsByProvider>;
  setProviderAuthMethods(methods: ProviderAuthMethodsByProvider): void;
  listWorkspaceStatuses(): Promise<WorkspaceStatusEntry[]>;
  setWorkspaceStatuses(entries: WorkspaceStatusEntry[]): void;
  listSessions(): Promise<Session[]>;
  applySessions(sessions: Session[]): void;
  listRecycleBin(): Promise<RecycleBinEntry[] | null | undefined>;
  setRecycleBinEntries(entries: RecycleBinEntry[]): void;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  setSessionStatuses(
    statuses: Record<string, SessionStatus>,
    options?: SessionStatusSnapshotOptions
  ): void;
  getSessions(): Session[];
  updateUsageLimitState(
    sessionId: string,
    status: SessionStatus | null | undefined,
    messages?: Array<unknown>
  ): void;
  logError: Logger;
}) {
  let emptySessionSnapshotCount = 0;
  let mcpLoadGeneration = 0;
  let inFlightMcpLoad: { sessionId: string | null; promise: Promise<void> } | null = null;
  let knownProviderIDs: Set<string> | null = null;

  const shouldApplySessionsSnapshot = (sessions: Session[]) => {
    if (sessions.length > 0 || deps.getSessions().length === 0) {
      emptySessionSnapshotCount = 0;
      return true;
    }

    emptySessionSnapshotCount += 1;
    if (emptySessionSnapshotCount < EMPTY_SESSION_SNAPSHOT_CONFIRMATIONS) {
      return false;
    }

    emptySessionSnapshotCount = 0;
    return true;
  };

  const loadMcps = () => {
    const sessionId = deps.getActiveSessionId();
    if (inFlightMcpLoad?.sessionId === sessionId) return inFlightMcpLoad.promise;
    const generation = ++mcpLoadGeneration;
    const request = loadMcpsWithDependencies(
      {
        listMcpStatus: deps.listMcpStatus,
        setMcpStatus: deps.setMcpStatus,
        getActiveSessionId: deps.getActiveSessionId,
        getSelectedMcpsForSession: deps.getSelectedMcpsForSession,
        setSelectedMcpsForSession: deps.setSelectedMcpsForSession,
      },
      deps.logError,
      () => generation === mcpLoadGeneration
    );
    const tracked = request.finally(() => {
      if (inFlightMcpLoad?.promise === tracked) inFlightMcpLoad = null;
    });
    inFlightMcpLoad = { sessionId, promise: tracked };
    return tracked;
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
        setProviders: (providers, defaults) => {
          const knownProviders = knownProviderIDs;
          const newlyConnectedProviderIDs = knownProviders
            ? providers
                .filter((provider) => !knownProviders.has(provider.id))
                .map((provider) => provider.id)
            : [];
          deps.setProviders(providers, defaults, newlyConnectedProviderIDs);
          knownProviderIDs ??= new Set();
          for (const provider of providers) knownProviderIDs.add(provider.id);
        },
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

  const loadCompatibilityState = async () => {
    await Promise.all([
      loadProviderAuthMethodsWithDependencies(
        {
          listProviderAuthMethods: deps.listProviderAuthMethods,
          setProviderAuthMethods: deps.setProviderAuthMethods,
        },
        deps.logError
      ),
      loadWorkspaceStatusesWithDependencies(
        {
          listWorkspaceStatuses: deps.listWorkspaceStatuses,
          setWorkspaceStatuses: deps.setWorkspaceStatuses,
        },
        deps.logError
      ),
    ]);
  };

  const loadSessions = async () => {
    await loadSessionsWithDependencies(
      {
        listSessions: deps.listSessions,
        shouldApplySessionsSnapshot,
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
    loadCompatibilityState,
    loadSessions,
    loadRecycleBin,
    hydrateSessionStatuses,
  };
}

export async function loadProviderAuthMethodsWithDependencies(
  deps: {
    listProviderAuthMethods(): Promise<ProviderAuthMethodsByProvider>;
    setProviderAuthMethods(methods: ProviderAuthMethodsByProvider): void;
  },
  logError: Logger
) {
  await runLoad(
    'loadProviderAuthMethods',
    deps.listProviderAuthMethods,
    (methods) => deps.setProviderAuthMethods(methods || {}),
    logError
  );
}

export async function loadWorkspaceStatusesWithDependencies(
  deps: {
    listWorkspaceStatuses(): Promise<WorkspaceStatusEntry[]>;
    setWorkspaceStatuses(entries: WorkspaceStatusEntry[]): void;
  },
  logError: Logger
) {
  await runLoad(
    'loadWorkspaceStatuses',
    deps.listWorkspaceStatuses,
    (entries) => deps.setWorkspaceStatuses(entries || []),
    logError
  );
}

export async function loadMcpsWithDependencies(
  deps: {
    listMcpStatus(): Promise<Record<string, McpStatus> | null | undefined>;
    setMcpStatus(status: Record<string, McpStatus>): void;
    getActiveSessionId(): string | null;
    getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  const activeSessionId = deps.getActiveSessionId();
  try {
    const status = await deps.listMcpStatus();
    if (!isCurrent()) return;
    const nextStatus = status || {};
    deps.setMcpStatus(nextStatus);
    if (
      activeSessionId &&
      deps.getActiveSessionId() === activeSessionId &&
      deps.getSelectedMcpsForSession(activeSessionId) === null
    ) {
      deps.setSelectedMcpsForSession(
        activeSessionId,
        Object.entries(nextStatus)
          .filter(([, value]) => value?.status === 'connected')
          .map(([name]) => name)
      );
    }
  } catch (err) {
    if (isCurrent()) logError('loadMcps', err);
  }
}

export async function loadQuestionsWithDependencies(
  deps: {
    listQuestions(): Promise<QuestionRequest[]>;
    setQuestions(questions: QuestionRequest[]): void;
  },
  logError: Logger
) {
  await runLoad('loadQuestions', deps.listQuestions, deps.setQuestions, logError);
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
  await runLoad(
    'loadCommands',
    deps.listCommands,
    (commands) => deps.setCommands(commands || []),
    logError
  );
}

export async function loadProvidersWithDependencies(
  deps: {
    listProviders(): Promise<{ providers: Provider[]; default?: Record<string, string> }>;
    setProvidersLoaded(value: boolean): void;
    setProviders(providers: Provider[], defaults?: Record<string, string>): void;
    setProviderDefaults(defaults: Record<string, string>): void;
    getSelectedModel(): SelectedModel | null;
    setSelectedModel(model: SelectedModel | null): void;
  },
  logError: Logger
) {
  deps.setProvidersLoaded(false);
  try {
    const res = await deps.listProviders();
    const providers = res.providers.map((provider) =>
      provider.id === 'openai'
        ? {
            ...provider,
            models: Object.fromEntries(
              Object.entries(provider.models).filter(([, model]) => {
                const name = model.name.trim();
                return !/\bpro$/i.test(name) && !/^gpt-5\.6(?: fast)?$/i.test(name);
              })
            ),
          }
        : provider
    );
    const providerDefaults = { ...res.default };
    const openAiDefault = providerDefaults.openai;
    const openAiProvider = providers.find((provider) => provider.id === 'openai');
    if (openAiDefault && !openAiProvider?.models[openAiDefault]) {
      delete providerDefaults.openai;
    }
    deps.setProviders(providers, providerDefaults);
    deps.setProviderDefaults(providerDefaults);
    deps.setProvidersLoaded(true);

    const routingState = reconcileLoadedProviders({
      selectedModel: deps.getSelectedModel(),
      providers,
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
    shouldApplySessionsSnapshot?(sessions: Session[]): boolean;
    applySessions(sessions: Session[]): void;
  },
  logError: Logger
) {
  try {
    const sessions = await deps.listSessions();
    // Session reads are intentionally broad. Workspace filtering belongs in
    // applySessions(), not the transport/backend layer, to avoid platform-
    // specific path formatting mismatches from hiding valid sessions.
    if (deps.shouldApplySessionsSnapshot?.(sessions) === false) return;
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
  await runLoad(
    'loadRecycleBin',
    deps.listRecycleBin,
    (entries) => deps.setRecycleBinEntries(entries || []),
    logError
  );
}

export async function hydrateSessionStatusesWithDependencies(
  deps: {
    loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
    setSessionStatuses(
      statuses: Record<string, SessionStatus>,
      options?: SessionStatusSnapshotOptions
    ): void;
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
    const snapshotStartedAt = Date.now();
    const statuses = await deps.loadSessionStatuses();
    deps.setSessionStatuses(statuses, { snapshotStartedAt });
    for (const session of deps.getSessions()) {
      deps.updateUsageLimitState(session.id, statuses[session.id], []);
    }
  } catch (err) {
    logError('session.status', err);
  }
}
