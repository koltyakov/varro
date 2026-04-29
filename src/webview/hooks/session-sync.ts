import type { SelectedModel } from '../lib/app-state-types';
import { resolveSelectedModel } from '../lib/state';
import type { Message, Part, Session, SessionStatus } from '../types';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
  syncSessionWithDependencies,
} from './session-selection';

type SessionEntry = { info: Message; parts: Part[] };

export async function selectSessionWithStateDependencies(
  deps: {
    getActiveSessionId(): string | null;
    setActiveSessionId(id: string): void;
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
    loadSession(id: string): Promise<{ session: Session; messages: SessionEntry[] }>;
    isCurrentSelectionGeneration(generation: number): boolean;
    upsertSession(session: Session): void;
    setMessagesIncremental(messages: SessionEntry[]): void;
    syncFailedSessionsFromMessages(messages: SessionEntry[]): void;
    requestMessageListScrollToBottom(): void;
    deriveSelectedAgentFromMessages(messages: SessionEntry[]): string | null;
    deriveSelectedModelFromMessages(messages: SessionEntry[]): SelectedModel | null;
    syncTodosFromMessages(messages: SessionEntry[]): void;
    loadQuestions(): Promise<void>;
    loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
    mergeSessionStatuses(statuses: Record<string, SessionStatus>): void;
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages: SessionEntry[]
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
    loadSessionMessages(sessionId: string): Promise<SessionEntry[]>;
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages: SessionEntry[]
    ): void;
    setMessagesIncremental(messages: SessionEntry[]): void;
    syncFailedSessionsFromMessages(messages: SessionEntry[]): void;
    handoffTodosToMessages(messages: SessionEntry[]): void;
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

export function createSessionSyncOperations(
  deps: {
    getActiveSessionId(): string | null;
    setActiveSessionId(id: string): void;
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
    loadSession(id: string): Promise<{ session: Session; messages: SessionEntry[] }>;
    isCurrentSelectionGeneration(generation: number): boolean;
    upsertSession(session: Session): void;
    setMessagesIncremental(messages: SessionEntry[]): void;
    syncFailedSessionsFromMessages(messages: SessionEntry[]): void;
    requestMessageListScrollToBottom(): void;
    deriveSelectedAgentFromMessages(messages: SessionEntry[]): string | null;
    deriveSelectedModelFromMessages(messages: SessionEntry[]): SelectedModel | null;
    syncTodosFromMessages(messages: SessionEntry[]): void;
    loadQuestions(): Promise<void>;
    loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
    mergeSessionStatuses(statuses: Record<string, SessionStatus>): void;
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages: SessionEntry[]
    ): void;
    startLoading(): void;
    stopLoading(): void;
    setError(message: string): void;
    getSessionStatus(sessionId: string): SessionStatus | null | undefined;
    loadSessionMessages(sessionId: string): Promise<SessionEntry[]>;
    handoffTodosToMessages(messages: SessionEntry[]): void;
    loadSessionMetadata(sessionId: string): Promise<Session>;
  },
  generations: {
    nextSelection(): number;
    nextSync(): number;
    isCurrentSync(generation: number): boolean;
  }
) {
  const selectSession = async (id: string, options?: { markSeen?: boolean }) => {
    await selectSessionWithStateDependencies(
      {
        getActiveSessionId: deps.getActiveSessionId,
        setActiveSessionId: deps.setActiveSessionId,
        persistActiveSessionId: deps.persistActiveSessionId,
        markSessionSeen: deps.markSessionSeen,
        clearDraftCurrentDocumentState: deps.clearDraftCurrentDocumentState,
        resetToolCallExpansionState: deps.resetToolCallExpansionState,
        resolvePersistedAgent: deps.resolvePersistedAgent,
        applySelectedAgent: deps.applySelectedAgent,
        resolvePersistedModel: deps.resolvePersistedModel,
        resolveFallbackModel: deps.resolveFallbackModel,
        applySelectedModel: deps.applySelectedModel,
        getConnectedMcpNames: deps.getConnectedMcpNames,
        hasSelectedMcps: deps.hasSelectedMcps,
        setSelectedMcpsForSession: deps.setSelectedMcpsForSession,
        syncSessionMcps: deps.syncSessionMcps,
        resetTodoSync: deps.resetTodoSync,
        clearMessages: deps.clearMessages,
        loadSession: deps.loadSession,
        isCurrentSelectionGeneration: deps.isCurrentSelectionGeneration,
        upsertSession: deps.upsertSession,
        setMessagesIncremental: deps.setMessagesIncremental,
        syncFailedSessionsFromMessages: deps.syncFailedSessionsFromMessages,
        requestMessageListScrollToBottom: deps.requestMessageListScrollToBottom,
        deriveSelectedAgentFromMessages: deps.deriveSelectedAgentFromMessages,
        deriveSelectedModelFromMessages: deps.deriveSelectedModelFromMessages,
        syncTodosFromMessages: deps.syncTodosFromMessages,
        loadQuestions: deps.loadQuestions,
        loadSessionStatuses: deps.loadSessionStatuses,
        mergeSessionStatuses: deps.mergeSessionStatuses,
        updateUsageLimitState: deps.updateUsageLimitState,
        startLoading: deps.startLoading,
        stopLoading: deps.stopLoading,
        setError: deps.setError,
      },
      { next: generations.nextSelection },
      id,
      options
    );
  };

  const syncSessionMessages = async (sessionId: string) => {
    await syncSessionMessagesWithStateDependencies(
      {
        getActiveSessionId: deps.getActiveSessionId,
        getSessionStatus: deps.getSessionStatus,
        loadSessionMessages: deps.loadSessionMessages,
        updateUsageLimitState: deps.updateUsageLimitState,
        setMessagesIncremental: deps.setMessagesIncremental,
        syncFailedSessionsFromMessages: deps.syncFailedSessionsFromMessages,
        handoffTodosToMessages: deps.handoffTodosToMessages,
      },
      {
        next: generations.nextSync,
        isCurrent: generations.isCurrentSync,
      },
      sessionId
    );
  };

  const syncSession = async (sessionId: string) => {
    await syncSessionWithStateDependencies(
      {
        loadSession: deps.loadSessionMetadata,
        upsertSession: deps.upsertSession,
      },
      sessionId
    );
  };

  return {
    selectSession,
    syncSessionMessages,
    syncSession,
  };
}

export function resolveMessagesSelectedModel(
  messages: SessionEntry[],
  providers: Array<unknown>,
  providerDefaults: Record<string, string>,
  deriveSelectedModelFromMessages: (messages: SessionEntry[]) => SelectedModel | null
) {
  return resolveSelectedModel(
    deriveSelectedModelFromMessages(messages),
    providers as Parameters<typeof resolveSelectedModel>[1],
    providerDefaults
  );
}
