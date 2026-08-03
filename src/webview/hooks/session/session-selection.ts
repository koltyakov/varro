import { batch } from 'solid-js';
import type { SelectedModel, SessionSelectionOptions } from '../../lib/app-state-types';
import type { SessionStatusSnapshotOptions } from '../../lib/stores/session-store';
import {
  latestAssistantFinished,
  latestAssistantFinishedBeforeLoading,
} from '../../lib/message-metrics';
import type { MessageEntry, Session, SessionStatus } from '../../types';

type SessionSelectionDeps = {
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
  getSession(id: string): Session | undefined;
  resolveSessionModel(session: Session): SelectedModel | null;
  resolvePersistedModel(id: string): SelectedModel | null;
  resolveFallbackModel(): SelectedModel | null;
  applySelectedModel(model: SelectedModel, id: string): void;
  getConnectedMcpNames(): string[];
  hasSelectedMcps(sessionId: string): boolean;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  syncSessionMcps(sessionId: string): Promise<void>;
  resetTodoSync(): void;
  clearMessages(): void;
  setMessagesLoading?(loading: boolean): void;
  loadSession(
    id: string,
    isCurrent?: () => boolean
  ): Promise<{ session: Session; messages: MessageEntry[] }>;
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
};

export async function selectSessionWithDependencies(
  deps: SessionSelectionDeps,
  generationRef: { next(): number },
  id: string,
  options?: SessionSelectionOptions
) {
  const generation = generationRef.next();
  let persistedAgent: string | null = null;
  let persistedModel: SelectedModel | null = null;
  batch(() => {
    deps.clearDraftCurrentDocumentState();
    deps.resetToolCallExpansionState();
    deps.setActiveSessionId(id);
    deps.clearPendingAbort(id);

    const resolvedAgent = deps.resolvePersistedAgent(id);
    persistedAgent = resolvedAgent.persistedAgent;
    if (resolvedAgent.persistedAgent) {
      deps.applySelectedAgent(resolvedAgent.persistedAgent, id);
    } else if (resolvedAgent.fallbackAgent) {
      deps.applySelectedAgent(resolvedAgent.fallbackAgent, id);
    }

    persistedModel = deps.resolvePersistedModel(id);
    const knownSession = deps.getSession(id);
    const sessionModel =
      persistedModel ??
      options?.selectedModel ??
      (knownSession ? deps.resolveSessionModel(knownSession) : null);
    if (sessionModel) {
      deps.applySelectedModel(sessionModel, id);
    } else {
      const fallbackModel = deps.resolveFallbackModel();
      if (fallbackModel) {
        deps.applySelectedModel(fallbackModel, id);
      }
    }

    deps.resetTodoSync();
    deps.clearMessages();
  });

  const mcpSync = deps.syncSessionMcps(id).catch(() => {});

  const isCurrentSelection = () =>
    deps.isCurrentSelectionGeneration(generation) && deps.getActiveSessionId() === id;
  const clearMessagesLoadingIfOwned = () => {
    if (deps.isCurrentSelectionGeneration(generation)) {
      deps.setMessagesLoading?.(false);
    }
  };

  deps.setMessagesLoading?.(true);
  let loaded: { session: Session; messages: MessageEntry[] };
  try {
    loaded = await deps.loadSession(id, isCurrentSelection);
  } catch {
    if (!isCurrentSelection()) {
      clearMessagesLoadingIfOwned();
      return;
    }
    clearMessagesLoadingIfOwned();
    deps.setError('Failed to load messages');
    return;
  }

  if (!isCurrentSelection()) {
    clearMessagesLoadingIfOwned();
    return;
  }

  const { session, messages } = loaded;
  deps.upsertSession(session);
  deps.persistActiveSessionId(id);
  if (options?.markSeen ?? true) {
    deps.markSessionSeen(id);
  }
  const todoSync = batch(() => {
    deps.setMessagesIncremental(messages);
    return deps.syncTodosForSession(id, messages).catch(() => {});
  });
  clearMessagesLoadingIfOwned();
  deps.syncFailedSessionsFromMessages(messages);
  deps.requestMessageListScrollToBottom();

  if (!persistedAgent) {
    const inferredAgent = deps.deriveSelectedAgentFromMessages(messages);
    if (inferredAgent) {
      deps.applySelectedAgent(inferredAgent, id);
    }
  }

  const loadedModel = persistedModel ?? options?.selectedModel ?? deps.resolveSessionModel(session);
  if (loadedModel) {
    deps.applySelectedModel(loadedModel, id);
  } else {
    const inferredModel = deps.deriveSelectedModelFromMessages(messages);
    if (inferredModel) {
      deps.applySelectedModel(inferredModel, id);
    }
  }

  await mcpSync;
  if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;
  await todoSync;
  if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;
  await deps.loadQuestions().catch(() => {});
  if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;

  const snapshotStartedAt = Date.now();
  const statuses = await deps.loadSessionStatuses().catch(() => null);
  if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;
  if (!statuses) return;

  deps.mergeSessionStatuses(statuses, { snapshotStartedAt });
  deps.updateUsageLimitState(id, statuses[id], messages);
  const statusType = statuses[id]?.type;
  if (statusType === 'retry') {
    deps.startLoading();
  } else if (latestAssistantFinished(messages)) {
    deps.stopLoading();
  } else if (statusType === 'busy') {
    deps.startLoading();
  } else {
    deps.stopLoading();
  }
}

export async function syncSessionMessagesWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getSessionStatus(sessionId: string): SessionStatus | null | undefined;
    loadingStartedAt(): number | null;
    loadSessionMessages(sessionId: string, isCurrent?: () => boolean): Promise<MessageEntry[]>;
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
  const generation = generationRef.next();
  const messages = await deps.loadSessionMessages(sessionId, () =>
    generationRef.isCurrent(generation)
  );
  if (!generationRef.isCurrent(generation)) return;

  const status = deps.getSessionStatus(sessionId);
  deps.updateUsageLimitState(sessionId, status, messages);
  if (sessionId === deps.getActiveSessionId()) {
    const latestFinished = latestAssistantFinishedBeforeLoading(messages, deps.loadingStartedAt());
    deps.setMessagesIncremental(messages, { preserveExtraParts: !latestFinished });
    if (latestFinished && status?.type !== 'busy' && status?.type !== 'retry') deps.stopLoading();
    deps.syncFailedSessionsFromMessages(messages);
    deps.handoffTodosToMessages(messages);
  } else if (latestAssistantFinished(messages)) {
    deps.syncFailedSessionsFromMessages(messages);
  }
}

export async function syncSessionWithDependencies(
  deps: { loadSession(sessionId: string): Promise<Session>; upsertSession(session: Session): void },
  sessionId: string,
  options?: { shouldApply(): boolean }
) {
  const session = await deps.loadSession(sessionId);
  if (options && !options.shouldApply()) return;
  deps.upsertSession(session);
}
