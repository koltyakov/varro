import type { Message, Part, Session, SessionStatus } from '../types';
import type { SelectedModel } from '../lib/state';

type SessionEntry = { info: Message; parts: Part[] };

type SessionSelectionDeps = {
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
  deps.persistActiveSessionId(id);
  if (options?.markSeen ?? true) {
    deps.markSessionSeen(id);
  }

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

  if (!deps.hasSelectedMcps(id)) {
    deps.setSelectedMcpsForSession(id, deps.getConnectedMcpNames());
  }

  deps.resetTodoSync();
  deps.clearMessages();
  await deps.syncSessionMcps(id);

  try {
    const { session, messages } = await deps.loadSession(id);
    if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;

    deps.upsertSession(session);
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

    deps.syncTodosFromMessages(messages);
    await deps.loadQuestions();
    if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;

    const statuses = await deps.loadSessionStatuses();
    if (!deps.isCurrentSelectionGeneration(generation) || deps.getActiveSessionId() !== id) return;

    deps.mergeSessionStatuses(statuses);
    deps.updateUsageLimitState(id, statuses[id], messages);
    const statusType = statuses[id]?.type;
    if (statusType === 'busy' || statusType === 'retry') {
      deps.startLoading();
    } else {
      deps.stopLoading();
    }
  } catch {
    deps.setError('Failed to load messages');
  }
}

export async function syncSessionMessagesWithDependencies(
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
  const generation = generationRef.next();
  const messages = await deps.loadSessionMessages(sessionId);
  if (!generationRef.isCurrent(generation)) return;

  deps.updateUsageLimitState(sessionId, deps.getSessionStatus(sessionId), messages);
  if (sessionId === deps.getActiveSessionId()) {
    deps.setMessagesIncremental(messages);
    deps.syncFailedSessionsFromMessages(messages);
    deps.handoffTodosToMessages(messages);
  }
}

export async function syncSessionWithDependencies(
  deps: { loadSession(sessionId: string): Promise<Session>; upsertSession(session: Session): void },
  sessionId: string
) {
  const session = await deps.loadSession(sessionId);
  deps.upsertSession(session);
}
