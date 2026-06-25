import type { SelectedModel } from '../../lib/app-state-types';
import type { SessionStatusSnapshotOptions } from '../../lib/stores/session-store';
import {
  latestAssistantFinished,
  latestAssistantFinishedBeforeLoading,
} from '../../lib/message-metrics';
import type { Message, Part, Session, SessionStatus } from '../../types';

type SessionEntry = { info: Message; parts: Part[] };

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
  setMessagesIncremental(
    messages: SessionEntry[],
    options?: { preserveExtraParts?: boolean }
  ): void;
  syncFailedSessionsFromMessages(messages: SessionEntry[]): void;
  requestMessageListScrollToBottom(): void;
  deriveSelectedAgentFromMessages(messages: SessionEntry[]): string | null;
  deriveSelectedModelFromMessages(messages: SessionEntry[]): SelectedModel | null;
  syncTodosForSession(sessionId: string, messages: SessionEntry[]): Promise<void>;
  loadQuestions(): Promise<void>;
  loadSessionStatuses(): Promise<Record<string, SessionStatus>>;
  mergeSessionStatuses(
    statuses: Record<string, SessionStatus>,
    options?: SessionStatusSnapshotOptions
  ): void;
  updateUsageLimitState(
    sessionId: string,
    status: SessionStatus | null | undefined,
    messages: SessionEntry[]
  ): void;
  startLoading(): void;
  stopLoading(): void;
  setError(message: string): void;
};

export async function selectSessionWithDependencies(
  deps: SessionSelectionDeps,
  generationRef: { next(): number },
  id: string,
  options?: { markSeen?: boolean }
) {
  const generation = generationRef.next();
  deps.clearDraftCurrentDocumentState();
  deps.resetToolCallExpansionState();
  deps.setActiveSessionId(id);
  deps.clearPendingAbort(id);

  const { persistedAgent, fallbackAgent } = deps.resolvePersistedAgent(id);
  if (persistedAgent) {
    deps.applySelectedAgent(persistedAgent, id);
  } else if (fallbackAgent) {
    deps.applySelectedAgent(fallbackAgent, id);
  }

  const persistedModel = deps.resolvePersistedModel(id);
  if (persistedModel) {
    deps.applySelectedModel(persistedModel, id);
  } else {
    const fallbackModel = deps.resolveFallbackModel();
    if (fallbackModel) {
      deps.applySelectedModel(fallbackModel, id);
    }
  }

  deps.resetTodoSync();
  deps.clearMessages();
  await deps.syncSessionMcps(id);

  let loaded: { session: Session; messages: SessionEntry[] };
  try {
    loaded = await deps.loadSession(id);
  } catch {
    if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;
    deps.setError('Failed to load messages');
    return;
  }

  if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;

  const { session, messages } = loaded;
  deps.upsertSession(session);
  deps.persistActiveSessionId(id);
  if (options?.markSeen ?? true) {
    deps.markSessionSeen(id);
  }
  deps.setMessagesIncremental(messages);
  deps.syncFailedSessionsFromMessages(messages);
  deps.requestMessageListScrollToBottom();

  if (!persistedAgent) {
    const inferredAgent = deps.deriveSelectedAgentFromMessages(messages);
    if (inferredAgent) {
      deps.applySelectedAgent(inferredAgent, id);
    }
  }

  const inferredModel = deps.deriveSelectedModelFromMessages(messages);
  if (inferredModel) {
    deps.applySelectedModel(inferredModel, id);
  }

  await deps.syncTodosForSession(id, messages).catch(() => {});
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
    loadSessionMessages(sessionId: string): Promise<SessionEntry[]>;
    updateUsageLimitState(
      sessionId: string,
      status: SessionStatus | null | undefined,
      messages: SessionEntry[]
    ): void;
    setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
    setMessagesIncremental(
      messages: SessionEntry[],
      options?: { preserveExtraParts?: boolean }
    ): void;
    stopLoading(): void;
    syncFailedSessionsFromMessages(messages: SessionEntry[]): void;
    handoffTodosToMessages(messages: SessionEntry[]): void;
  },
  generationRef: { next(): number; isCurrent(generation: number): boolean },
  sessionId: string
) {
  const generation = generationRef.next();
  const messages = await deps.loadSessionMessages(sessionId);
  if (!generationRef.isCurrent(generation)) return;

  deps.updateUsageLimitState(sessionId, deps.getSessionStatus(sessionId), messages);
  if (sessionId === deps.getActiveSessionId()) {
    const latestFinished = latestAssistantFinishedBeforeLoading(messages, deps.loadingStartedAt());
    deps.setMessagesIncremental(messages, { preserveExtraParts: !latestFinished });
    if (latestFinished) deps.stopLoading();
    deps.syncFailedSessionsFromMessages(messages);
    deps.handoffTodosToMessages(messages);
  } else if (latestAssistantFinished(messages)) {
    const status = deps.getSessionStatus(sessionId);
    if (status?.type === 'busy' || status?.type === 'retry') {
      deps.syncFailedSessionsFromMessages(messages);
      deps.setSessionStatusEntry(sessionId, { type: 'idle' });
    }
  }
}

export async function syncSessionWithDependencies(
  deps: { loadSession(sessionId: string): Promise<Session>; upsertSession(session: Session): void },
  sessionId: string
) {
  const session = await deps.loadSession(sessionId);
  deps.upsertSession(session);
}
