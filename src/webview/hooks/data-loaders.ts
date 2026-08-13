import type { SelectedModel } from '../lib/app-state-types';
import { client, type SessionListPage } from '../lib/client';
import { appStore } from '../lib/stores/app-store';
import { permissionsStore } from '../lib/stores/permissions-store';
import { routingStore } from '../lib/stores/routing-store';
import { sessionStore } from '../lib/stores/session-store';
import type { SessionStatusSnapshotOptions } from '../lib/stores/session-store';
import { clearQueuedMessagesForSession } from '../lib/state-queued-messages';
import { getEffectiveComposerSessionId } from '../lib/state-view-persistence';
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
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGE_LIMIT = 1_000_000;

async function runLoad<T>(
  label: string,
  load: () => Promise<T>,
  apply: (value: T) => void,
  logError: Logger,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  try {
    const value = await load();
    if (!isCurrent()) return true;
    apply(value);
    return true;
  } catch (err) {
    if (!isCurrent()) return true;
    logError(label, err);
    return false;
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
    getComposerSessionId: getEffectiveComposerSessionId,
    getSelectedMcpsForSession: routingStore.getSelectedMcpsForSession,
    setSelectedMcpsForSession: routingStore.setSelectedMcpsForSession,
    listQuestions: () => client.question.list(),
    setQuestions: permissionsStore.setQuestions,
    getQuestions: () => appStore.state.questions,
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
    getSelectedModelForSession: routingStore.getSelectedModelForSession,
    setSelectedModel: routingStore.setSelectedModel,
    loadProviderLimit: (providerID, modelID) => client.config.providerLimit(providerID, modelID),
    setProviderLimit: routingStore.setProviderLimit,
    listProviderAuthMethods: () => client.config.providerAuth(),
    setProviderAuthMethods: routingStore.setProviderAuthMethods,
    listWorkspaceStatuses: () => client.config.workspaceStatus(),
    setWorkspaceStatuses: routingStore.setWorkspaceStatuses,
    listSessions: (limit) => client.session.list({ limit }),
    applySessions: deps.applySessions,
    setSessionsLoadError: (message) => appStore.setState('sessionsLoadError', message),
    setSessionsHasMore: (value) => appStore.setState('sessionsHasMore', value),
    setSessionsLoadingMore: (value) => appStore.setState('sessionsLoadingMore', value),
    setSessionsPaginationError: (message) => appStore.setState('sessionsPaginationError', message),
    listRecycleBin: () => client.varro.recycleBin.list(),
    setRecycleBinEntries: sessionStore.setRecycleBinEntries,
    setRecycleBinLoadError: (message) => appStore.setState('recycleBinLoadError', message),
    loadSessionStatuses: () => client.session.status(),
    setSessionStatuses: sessionStore.setSessionStatuses,
    getSessions: () => appStore.state.sessions,
    clearQueuedMessagesForSession,
    updateUsageLimitState: deps.updateUsageLimitState,
    logError: deps.logError,
  });
}

export function createDataLoaderOperations(deps: {
  listMcpStatus(): Promise<Record<string, McpStatus> | null | undefined>;
  setMcpStatus(status: Record<string, McpStatus>): void;
  getActiveSessionId(): string | null;
  getComposerSessionId(): string | null;
  getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  listQuestions(): Promise<QuestionRequest[]>;
  setQuestions(questions: QuestionRequest[]): void;
  getQuestions(): QuestionRequest[];
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
  listProviders(): Promise<{
    providers: Provider[];
    default?: Record<string, string>;
    defaultModel?: SelectedModel | null;
  }>;
  setProvidersLoaded(value: boolean): void;
  setProviders(
    providers: Provider[],
    defaults?: Record<string, string>,
    newlyConnectedProviderIDs?: readonly string[]
  ): void;
  setProviderDefaults(defaults: Record<string, string>): void;
  getSelectedModel(): SelectedModel | null;
  getSelectedModelForSession(sessionId: string): SelectedModel | null;
  setSelectedModel(
    model: SelectedModel | null,
    options?: { sessionId?: string | null; persistGlobal?: boolean }
  ): void;
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
  listSessions(limit?: number): Promise<Session[] | SessionListPage>;
  applySessions(sessions: Session[]): void;
  setSessionsLoadError?(message: string | null): void;
  setSessionsHasMore?(value: boolean): void;
  setSessionsLoadingMore?(value: boolean): void;
  setSessionsPaginationError?(message: string | null): void;
  listRecycleBin(): Promise<RecycleBinEntry[] | null | undefined>;
  setRecycleBinEntries(entries: RecycleBinEntry[]): void;
  setRecycleBinLoadError?(message: string | null): void;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  setSessionStatuses(
    statuses: Record<string, SessionStatus>,
    options?: SessionStatusSnapshotOptions
  ): void;
  getSessions(): Session[];
  clearQueuedMessagesForSession(sessionId: string): void;
  updateUsageLimitState(
    sessionId: string,
    status: SessionStatus | null | undefined,
    messages?: Array<unknown>
  ): void;
  logError: Logger;
}) {
  let emptySessionSnapshotCount = 0;
  let requestedSessionLimit = SESSION_PAGE_SIZE;
  let workspaceGeneration = 0;
  let mcpLoadGeneration = 0;
  let questionLoadGeneration = 0;
  let sessionLoadGeneration = 0;
  let agentLoadGeneration = 0;
  let commandLoadGeneration = 0;
  let providerLoadGeneration = 0;
  let compatibilityLoadGeneration = 0;
  let recycleBinLoadGeneration = 0;
  let inFlightMcpLoad: { sessionId: string | null; promise: Promise<void> } | null = null;
  let inFlightSessionPageLoad: Promise<void> | null = null;
  let knownProviderIDs: Set<string> | null = null;
  const questionSnapshots = createMutationAwareSnapshotReconciler(deps.getQuestions);
  const sessionSnapshots = createMutationAwareSnapshotReconciler(deps.getSessions);

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
    const workspace = workspaceGeneration;
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
      () => workspace === workspaceGeneration && generation === mcpLoadGeneration
    );
    const tracked = request.finally(() => {
      if (inFlightMcpLoad?.promise === tracked) inFlightMcpLoad = null;
    });
    inFlightMcpLoad = { sessionId, promise: tracked };
    return tracked;
  };

  const loadQuestions = async () => {
    const workspace = workspaceGeneration;
    const generation = ++questionLoadGeneration;
    const mutationBaseline = questionSnapshots.captureBaseline();
    await loadQuestionsWithDependencies(
      {
        listQuestions: deps.listQuestions,
        setQuestions: (questions) => {
          deps.setQuestions(questionSnapshots.reconcile(questions, mutationBaseline));
        },
      },
      deps.logError,
      () => workspace === workspaceGeneration && generation === questionLoadGeneration
    );
  };

  const loadAgents = async () => {
    const workspace = workspaceGeneration;
    const generation = ++agentLoadGeneration;
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
      deps.logError,
      () => workspace === workspaceGeneration && generation === agentLoadGeneration
    );
  };

  const loadCommands = async () => {
    const workspace = workspaceGeneration;
    const generation = ++commandLoadGeneration;
    await loadCommandsWithDependencies(
      {
        listCommands: deps.listCommands,
        setCommands: deps.setCommands,
      },
      deps.logError,
      () => workspace === workspaceGeneration && generation === commandLoadGeneration
    );
  };

  const loadProviders = async () => {
    const workspace = workspaceGeneration;
    const generation = ++providerLoadGeneration;
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
        getSelectedModelForSession: deps.getSelectedModelForSession,
        getComposerSessionId: deps.getComposerSessionId,
        setSelectedModel: deps.setSelectedModel,
      },
      deps.logError,
      () => workspace === workspaceGeneration && generation === providerLoadGeneration
    );
  };

  const refreshRoutingState = async () => {
    await Promise.all([loadAgents(), loadProviders()]);
  };

  const refreshProviderLimit = async (providerID: string, modelID?: string | null) => {
    const workspace = workspaceGeneration;
    await refreshProviderLimitWithDependencies(
      {
        loadProviderLimit: deps.loadProviderLimit,
        setProviderLimit: deps.setProviderLimit,
      },
      providerID,
      modelID,
      deps.logError,
      () => workspace === workspaceGeneration
    );
  };

  const loadCompatibilityState = async () => {
    const workspace = workspaceGeneration;
    const generation = ++compatibilityLoadGeneration;
    const isCurrent = () =>
      workspace === workspaceGeneration && generation === compatibilityLoadGeneration;
    await Promise.all([
      loadProviderAuthMethodsWithDependencies(
        {
          listProviderAuthMethods: deps.listProviderAuthMethods,
          setProviderAuthMethods: deps.setProviderAuthMethods,
        },
        deps.logError,
        isCurrent
      ),
      loadWorkspaceStatusesWithDependencies(
        {
          listWorkspaceStatuses: deps.listWorkspaceStatuses,
          setWorkspaceStatuses: deps.setWorkspaceStatuses,
        },
        deps.logError,
        isCurrent
      ),
    ]);
  };

  const performSessionLoad = async (pagination: boolean) => {
    const workspace = workspaceGeneration;
    const generation = ++sessionLoadGeneration;
    const mutationBaseline = sessionSnapshots.captureBaseline();
    const loaded = await loadSessionsWithDependencies(
      {
        listSessions: () => deps.listSessions(requestedSessionLimit),
        shouldApplySessionsSnapshot: (sessions, hasMore) =>
          hasMore || shouldApplySessionsSnapshot(sessions),
        applySessions: (sessions, hasMore) => {
          const reconciled = sessionSnapshots.reconcile(sessions, mutationBaseline);
          const retainedIds = new Set(reconciled.map((session) => session.id));
          for (const current of deps.getSessions()) {
            if (!retainedIds.has(current.id)) deps.clearQueuedMessagesForSession(current.id);
          }
          deps.applySessions(reconciled);
          deps.setSessionsHasMore?.(hasMore);
        },
      },
      deps.logError,
      () => workspace === workspaceGeneration && generation === sessionLoadGeneration
    );
    if (workspace !== workspaceGeneration || generation !== sessionLoadGeneration) return;
    if (pagination) {
      deps.setSessionsPaginationError?.(loaded ? null : 'Failed to load more sessions');
    } else {
      deps.setSessionsLoadError?.(loaded ? null : 'Failed to load sessions');
      if (loaded) deps.setSessionsPaginationError?.(null);
    }
    return loaded;
  };

  const loadSessions = async () => {
    await performSessionLoad(false);
  };

  const loadMoreSessions = () => {
    if (inFlightSessionPageLoad) return inFlightSessionPageLoad;
    const previousLimit = requestedSessionLimit;
    const nextLimit = Math.min(previousLimit + SESSION_PAGE_SIZE, MAX_SESSION_PAGE_LIMIT);
    if (nextLimit === previousLimit) {
      deps.setSessionsHasMore?.(false);
      return Promise.resolve();
    }
    requestedSessionLimit = nextLimit;
    deps.setSessionsLoadingMore?.(true);
    deps.setSessionsPaginationError?.(null);
    const request = performSessionLoad(true)
      .then((loaded) => {
        if (loaded === false && requestedSessionLimit === nextLimit) {
          requestedSessionLimit = previousLimit;
        }
      })
      .finally(() => {
        if (inFlightSessionPageLoad !== request) return;
        inFlightSessionPageLoad = null;
        deps.setSessionsLoadingMore?.(false);
      });
    inFlightSessionPageLoad = request;
    return request;
  };

  const loadRecycleBin = async () => {
    const workspace = workspaceGeneration;
    const generation = ++recycleBinLoadGeneration;
    const loaded = await loadRecycleBinWithDependencies(
      {
        listRecycleBin: deps.listRecycleBin,
        setRecycleBinEntries: deps.setRecycleBinEntries,
      },
      deps.logError,
      () => workspace === workspaceGeneration && generation === recycleBinLoadGeneration
    );
    if (workspace !== workspaceGeneration || generation !== recycleBinLoadGeneration) return;
    deps.setRecycleBinLoadError?.(loaded ? null : 'Failed to load the recycle bin');
  };

  const hydrateSessionStatuses = async () => {
    const workspace = workspaceGeneration;
    await hydrateSessionStatusesWithDependencies(
      {
        loadSessionStatuses: deps.loadSessionStatuses,
        setSessionStatuses: deps.setSessionStatuses,
        getSessions: deps.getSessions,
        updateUsageLimitState: deps.updateUsageLimitState,
      },
      deps.logError,
      () => workspace === workspaceGeneration
    );
  };

  const invalidateWorkspace = () => {
    workspaceGeneration += 1;
    mcpLoadGeneration += 1;
    questionLoadGeneration += 1;
    sessionLoadGeneration += 1;
    agentLoadGeneration += 1;
    commandLoadGeneration += 1;
    providerLoadGeneration += 1;
    compatibilityLoadGeneration += 1;
    recycleBinLoadGeneration += 1;
    emptySessionSnapshotCount = 0;
    requestedSessionLimit = SESSION_PAGE_SIZE;
    inFlightMcpLoad = null;
    inFlightSessionPageLoad = null;
    deps.setSessionsLoadingMore?.(false);
    deps.setSessionsPaginationError?.(null);
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
    loadMoreSessions,
    loadRecycleBin,
    hydrateSessionStatuses,
    invalidateWorkspace,
  };
}

function createMutationAwareSnapshotReconciler<T extends { id: string }>(getCurrent: () => T[]) {
  const captureBaseline = () => new Map(getCurrent().map((item) => [item.id, item]));

  const reconcile = (snapshot: T[], baseline: Map<string, T>) => {
    const current = getCurrent();
    const currentById = new Map(current.map((item) => [item.id, item]));
    const locallyRemovedIds = new Set([...baseline.keys()].filter((id) => !currentById.has(id)));
    const locallyAddedOrReplaced = current.filter(
      (item) => !baseline.has(item.id) || baseline.get(item.id) !== item
    );
    const locallyChangedIds = new Set([
      ...locallyRemovedIds,
      ...locallyAddedOrReplaced.map((item) => item.id),
    ]);

    return [
      ...snapshot.filter((item) => !locallyChangedIds.has(item.id)),
      ...locallyAddedOrReplaced,
    ];
  };

  return { captureBaseline, reconcile };
}

export async function loadProviderAuthMethodsWithDependencies(
  deps: {
    listProviderAuthMethods(): Promise<ProviderAuthMethodsByProvider>;
    setProviderAuthMethods(methods: ProviderAuthMethodsByProvider): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  await runLoad(
    'loadProviderAuthMethods',
    deps.listProviderAuthMethods,
    (methods) => deps.setProviderAuthMethods(methods || {}),
    logError,
    isCurrent
  );
}

export async function loadWorkspaceStatusesWithDependencies(
  deps: {
    listWorkspaceStatuses(): Promise<WorkspaceStatusEntry[]>;
    setWorkspaceStatuses(entries: WorkspaceStatusEntry[]): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  await runLoad(
    'loadWorkspaceStatuses',
    deps.listWorkspaceStatuses,
    (entries) => deps.setWorkspaceStatuses(entries || []),
    logError,
    isCurrent
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
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  try {
    const questions = await deps.listQuestions();
    if (isCurrent()) deps.setQuestions(questions);
  } catch (err) {
    if (isCurrent()) logError('loadQuestions', err);
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
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  try {
    const loadedAgents = await deps.listAgents();
    if (!isCurrent()) return;
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
    if (isCurrent()) logError('loadAgents', err);
  }
}

export async function loadCommandsWithDependencies(
  deps: {
    listCommands(): Promise<Command[] | null | undefined>;
    setCommands(commands: Command[]): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  await runLoad(
    'loadCommands',
    deps.listCommands,
    (commands) => deps.setCommands(commands || []),
    logError,
    isCurrent
  );
}

export async function loadProvidersWithDependencies(
  deps: {
    listProviders(): Promise<{
      providers: Provider[];
      default?: Record<string, string>;
      defaultModel?: SelectedModel | null;
    }>;
    setProvidersLoaded(value: boolean): void;
    setProviders(providers: Provider[], defaults?: Record<string, string>): void;
    setProviderDefaults(defaults: Record<string, string>): void;
    getSelectedModel(): SelectedModel | null;
    getSelectedModelForSession?(sessionId: string): SelectedModel | null;
    getComposerSessionId?(): string | null;
    setSelectedModel(
      model: SelectedModel | null,
      options?: { sessionId?: string | null; persistGlobal?: boolean }
    ): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  deps.setProvidersLoaded(false);
  try {
    const res = await deps.listProviders();
    if (!isCurrent()) return;
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

    const composerSessionId = deps.getComposerSessionId?.() ?? null;
    const currentSelectedModel = deps.getSelectedModel();
    const sessionSelectedModel = composerSessionId
      ? (deps.getSelectedModelForSession?.(composerSessionId) ?? null)
      : null;
    const routingState = reconcileLoadedProviders({
      selectedModel: sessionSelectedModel ?? currentSelectedModel,
      providers,
      providerDefaults,
      defaultModel: res.defaultModel,
      allowHiddenSelectedModel: !!composerSessionId,
    });
    if (routingState.nextSelectedModel !== undefined) {
      if (composerSessionId) {
        deps.setSelectedModel(
          routingState.nextSelectedModel,
          routingState.nextSelectedModel
            ? { sessionId: composerSessionId, persistGlobal: false }
            : { persistGlobal: false }
        );
      } else {
        deps.setSelectedModel(routingState.nextSelectedModel);
      }
    } else if (composerSessionId && sessionSelectedModel && routingState.effectiveModel) {
      deps.setSelectedModel(routingState.effectiveModel, { persistGlobal: false });
    }
  } catch (err) {
    if (isCurrent()) logError('loadProviders', err);
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
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  try {
    const limit = await deps.loadProviderLimit(providerID, modelID);
    if (isCurrent()) deps.setProviderLimit(providerID, modelID, limit);
  } catch (err) {
    if (isCurrent()) logError('loadProviderLimit', err);
  }
}

export async function loadSessionsWithDependencies(
  deps: {
    listSessions(): Promise<Session[] | SessionListPage>;
    shouldApplySessionsSnapshot?(sessions: Session[], hasMore: boolean): boolean;
    applySessions(sessions: Session[], hasMore: boolean): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  try {
    const result = await deps.listSessions();
    if (!isCurrent()) return true;
    const sessions = Array.isArray(result) ? result : result.items;
    const hasMore = Array.isArray(result) ? false : result.hasMore;
    // Session reads are intentionally broad. Workspace filtering belongs in
    // applySessions(), not the transport/backend layer, to avoid platform-
    // specific path formatting mismatches from hiding valid sessions.
    if (deps.shouldApplySessionsSnapshot?.(sessions, hasMore) === false) return true;
    deps.applySessions(sessions, hasMore);
    return true;
  } catch (err) {
    if (isCurrent()) logError('loadSessions', err);
    return false;
  }
}

export async function loadRecycleBinWithDependencies(
  deps: {
    listRecycleBin(): Promise<RecycleBinEntry[] | null | undefined>;
    setRecycleBinEntries(entries: RecycleBinEntry[]): void;
  },
  logError: Logger,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  return await runLoad(
    'loadRecycleBin',
    deps.listRecycleBin,
    (entries) => deps.setRecycleBinEntries(entries || []),
    logError,
    isCurrent
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
  logError: Logger,
  isCurrent: () => boolean = () => true
) {
  try {
    const snapshotStartedAt = Date.now();
    const statuses = await deps.loadSessionStatuses();
    if (!isCurrent()) return;
    deps.setSessionStatuses(statuses, { snapshotStartedAt });
    for (const session of deps.getSessions()) {
      deps.updateUsageLimitState(session.id, statuses[session.id], []);
    }
  } catch (err) {
    if (isCurrent()) logError('session.status', err);
  }
}
