import type { SelectedModel } from '../../lib/app-state-types';
import type { SessionStatusSnapshotOptions } from '../../lib/stores/session-store';
import { routingStore } from '../../lib/stores/routing-store';
import type { MessageEntry, Session, SessionStatus } from '../../types';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
  syncSessionWithDependencies,
} from './session-selection';

export async function selectSessionWithStateDependencies(
  deps: {
    getActiveSessionId(): string | null;
    setActiveSessionId(id: string): void;
    clearPendingAbort(sessionId: string): void;
    persistActiveSessionId(id: string): void;
    markSessionSeen(id: string): void;
    clearDraftCurrentDocumentState(): void;
    resetToolCallExpansionState(): void;
    resolvePersistedAgent(id: string): {
      persistedAgent: string | null;
      fallbackAgent: string | null;
    };
    applySelectedAgent(agent: string, id: string): void;
    resolvePersistedModel(id: string): SelectedModel | null;
    resolveFallbackModel(): SelectedModel | null;
    applySelectedModel(model: SelectedModel, id: string): void;
    getConnectedMcpNames(): string[];
    hasSelectedMcps(sessionId: string): boolean;
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
    syncSessionMcps(sessionId: string): Promise<void>;
    resetTodoSync(): void;
    clearMessages(): void;
    loadSession(id: string): Promise<{ session: Session; messages: MessageEntry[] }>;
    isCurrentSelectionGeneration(generation: number): boolean;
    upsertSession(session: Session): void;
    setMessagesIncremental(
      messages: MessageEntry[],
      options?: { preserveExtraParts?: boolean }
    ): void;
    syncFailedSessionsFromMessages(messages: MessageEntry[]): void;
    requestMessageListScrollToBottom(): void;
    deriveSelectedAgentFromMessages(messages: MessageEntry[]): string | null;
    deriveSelectedModelFromMessages(messages: MessageEntry[]): SelectedModel | null;
    syncTodosForSession(sessionId: string, messages: MessageEntry[]): Promise<void>;
    loadQuestions(): Promise<void>;
    loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
    mergeSessionStatuses(
      statuses: Record<string, SessionStatus>,
      options?: SessionStatusSnapshotOptions
    ): void;
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages: MessageEntry[]
    ): void;
    startLoading(): void;
    stopLoading(): void;
    setError(message: string): void;
  },
  generationRef: { next(): number },
  id: string,
  options?: { markSeen?: boolean }
) {
  await selectSessionWithDependencies(deps, generationRef, id, options);
}

export async function syncSessionMessagesWithStateDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getSessionStatus(sessionId: string): SessionStatus | null | undefined;
    loadingStartedAt(): number | null;
    loadSessionMessages(sessionId: string): Promise<MessageEntry[]>;
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages: MessageEntry[]
    ): void;
    setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
    setMessagesIncremental(
      messages: MessageEntry[],
      options?: { preserveExtraParts?: boolean }
    ): void;
    stopLoading(): void;
    syncFailedSessionsFromMessages(messages: MessageEntry[]): void;
    handoffTodosToMessages(messages: MessageEntry[]): void;
  },
  generationRef: { next(): number; isCurrent(generation: number): boolean },
  sessionId: string
) {
  await syncSessionMessagesWithDependencies(deps, generationRef, sessionId);
}

export async function syncSessionWithStateDependencies(
  deps: {
    loadSession(sessionId: string): Promise<Session>;
    upsertSession(session: Session): void;
  },
  sessionId: string
) {
  await syncSessionWithDependencies(deps, sessionId);
}

type SessionSyncDependencies = {
  getActiveSessionId(): string | null;
  setActiveSessionId(id: string): void;
  clearPendingAbort(sessionId: string): void;
  persistActiveSessionId(id: string): void;
  markSessionSeen(id: string): void;
  clearDraftCurrentDocumentState(): void;
  resetToolCallExpansionState(): void;
  resolvePersistedAgent(id: string): {
    persistedAgent: string | null;
    fallbackAgent: string | null;
  };
  applySelectedAgent(agent: string, id: string): void;
  resolvePersistedModel(id: string): SelectedModel | null;
  resolveFallbackModel(): SelectedModel | null;
  applySelectedModel(model: SelectedModel, id: string): void;
  getConnectedMcpNames(): string[];
  hasSelectedMcps(sessionId: string): boolean;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  syncSessionMcps(sessionId: string): Promise<void>;
  resetTodoSync(): void;
  clearMessages(): void;
  loadSession(id: string): Promise<{ session: Session; messages: MessageEntry[] }>;
  isCurrentSelectionGeneration(generation: number): boolean;
  upsertSession(session: Session): void;
  setMessagesIncremental(
    messages: MessageEntry[],
    options?: { preserveExtraParts?: boolean }
  ): void;
  syncFailedSessionsFromMessages(messages: MessageEntry[]): void;
  requestMessageListScrollToBottom(): void;
  deriveSelectedAgentFromMessages(messages: MessageEntry[]): string | null;
  deriveSelectedModelFromMessages(messages: MessageEntry[]): SelectedModel | null;
  syncTodosForSession(sessionId: string, messages: MessageEntry[]): Promise<void>;
  loadQuestions(): Promise<void>;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  mergeSessionStatuses(
    statuses: Record<string, SessionStatus>,
    options?: SessionStatusSnapshotOptions
  ): void;
  updateUsageLimitState(
    sessionId: string,
    status: SessionStatus | null | undefined,
    messages: MessageEntry[]
  ): void;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  startLoading(): void;
  stopLoading(): void;
  setError(message: string): void;
  getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  loadingStartedAt(): number | null;
  loadSessionMessages(sessionId: string): Promise<MessageEntry[]>;
  handoffTodosToMessages(messages: MessageEntry[]): void;
  loadSessionMetadata(sessionId: string): Promise<Session>;
};

type SessionSyncGenerations = {
  nextSelection(): number;
  isCurrentSync(generation: number): boolean;
};

export class SessionSyncOperations {
  constructor(
    private readonly deps: SessionSyncDependencies,
    private readonly generations: SessionSyncGenerations
  ) {}

  readonly selectSession = async (id: string, options?: { markSeen?: boolean }) => {
    await selectSessionWithStateDependencies(
      {
        getActiveSessionId: this.deps.getActiveSessionId,
        setActiveSessionId: this.deps.setActiveSessionId,
        clearPendingAbort: this.deps.clearPendingAbort,
        persistActiveSessionId: this.deps.persistActiveSessionId,
        markSessionSeen: this.deps.markSessionSeen,
        clearDraftCurrentDocumentState: this.deps.clearDraftCurrentDocumentState,
        resetToolCallExpansionState: this.deps.resetToolCallExpansionState,
        resolvePersistedAgent: this.deps.resolvePersistedAgent,
        applySelectedAgent: this.deps.applySelectedAgent,
        resolvePersistedModel: this.deps.resolvePersistedModel,
        resolveFallbackModel: this.deps.resolveFallbackModel,
        applySelectedModel: this.deps.applySelectedModel,
        getConnectedMcpNames: this.deps.getConnectedMcpNames,
        hasSelectedMcps: this.deps.hasSelectedMcps,
        setSelectedMcpsForSession: this.deps.setSelectedMcpsForSession,
        syncSessionMcps: this.deps.syncSessionMcps,
        resetTodoSync: this.deps.resetTodoSync,
        clearMessages: this.deps.clearMessages,
        loadSession: this.deps.loadSession,
        isCurrentSelectionGeneration: this.deps.isCurrentSelectionGeneration,
        upsertSession: this.deps.upsertSession,
        setMessagesIncremental: this.deps.setMessagesIncremental,
        syncFailedSessionsFromMessages: this.deps.syncFailedSessionsFromMessages,
        requestMessageListScrollToBottom: this.deps.requestMessageListScrollToBottom,
        deriveSelectedAgentFromMessages: this.deps.deriveSelectedAgentFromMessages,
        deriveSelectedModelFromMessages: this.deps.deriveSelectedModelFromMessages,
        syncTodosForSession: this.deps.syncTodosForSession,
        loadQuestions: this.deps.loadQuestions,
        loadSessionStatuses: this.deps.loadSessionStatuses,
        mergeSessionStatuses: this.deps.mergeSessionStatuses,
        updateUsageLimitState: this.deps.updateUsageLimitState,
        startLoading: this.deps.startLoading,
        stopLoading: this.deps.stopLoading,
        setError: this.deps.setError,
      },
      { next: this.generations.nextSelection },
      id,
      options
    );
  };

  readonly syncSessionMessages = async (sessionId: string, generation: number) => {
    await syncSessionMessagesWithStateDependencies(
      {
        getActiveSessionId: this.deps.getActiveSessionId,
        getSessionStatus: this.deps.getSessionStatus,
        loadingStartedAt: this.deps.loadingStartedAt,
        loadSessionMessages: this.deps.loadSessionMessages,
        updateUsageLimitState: this.deps.updateUsageLimitState,
        setSessionStatusEntry: this.deps.setSessionStatusEntry,
        setMessagesIncremental: this.deps.setMessagesIncremental,
        stopLoading: this.deps.stopLoading,
        syncFailedSessionsFromMessages: this.deps.syncFailedSessionsFromMessages,
        handoffTodosToMessages: this.deps.handoffTodosToMessages,
      },
      {
        next: () => generation,
        isCurrent: this.generations.isCurrentSync,
      },
      sessionId
    );
  };

  readonly syncSession = async (sessionId: string) => {
    await syncSessionWithStateDependencies(
      {
        loadSession: this.deps.loadSessionMetadata,
        upsertSession: this.deps.upsertSession,
      },
      sessionId
    );
  };
}

export function resolveMessagesSelectedModel(
  messages: MessageEntry[],
  providers: Array<unknown>,
  providerDefaults: Record<string, string>,
  deriveModelFromMessages: (messages: MessageEntry[]) => SelectedModel | null
) {
  return routingStore.resolveSelectedModel(
    deriveModelFromMessages(messages),
    providers as Parameters<typeof routingStore.resolveSelectedModel>[1],
    providerDefaults
  );
}
