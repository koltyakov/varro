import type { PermissionMode, RecycleBinEntry } from '../../../shared/protocol';
import type { SelectedModel } from '../../lib/app-state-types';
import type { PermissionRule, Session, SessionStatus } from '../../types';

type SessionManagementDependencies = {
  getActiveSessionId(): string | null;
  createRemoteSession(body: { title?: string; permission?: PermissionRule[] }): Promise<Session>;
  buildCreatePermission(mode: PermissionMode): PermissionRule[];
  upsertSession(session: Session): void;
  resetToolCallExpansionState(): void;
  setActiveSessionId(sessionId: string): void;
  clearDraftCurrentDocumentState(): void;
  adoptDraftCurrentDocumentState(sessionId: string): void;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  setSessionUsageLimit(sessionId: string, notice: null): void;
  persistActiveSessionId(sessionId: string): void;
  markSessionSeen(sessionId: string): void;
  getDefaultSelectedModel(): SelectedModel | null;
  setSelectedModel(
    model: SelectedModel | null,
    options?: { sessionId?: string | null; persistGlobal?: boolean }
  ): void;
  resolveDefaultAgent(): string | null;
  setSelectedAgent(
    agent: string | null,
    options?: { sessionId?: string | null; persistGlobal?: boolean }
  ): void;
  getConnectedMcpNames(): string[];
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;
  resetDraftPermissionMode(): void;
  resetTodoSync(): void;
  clearMessages(): void;
  stopLoading(): void;
  setError(message: string): void;
  getSessions(): Session[];
  getDeletedSessionTreeIds(rootId: string, sessions: Session[]): Set<string>;
  getNextSessionIdAfterDeletion(sessions: Session[]): string | null;
  deleteRemoteSession(sessionId: string): Promise<unknown>;
  hideDeletedSessionTree(sessionId: string): void;
  loadRecycleBin(): Promise<void>;
  selectSession(sessionId: string, options?: { markSeen?: boolean }): Promise<void>;
  logError(context: string, err: unknown): void;
  restoreRecycleBinEntry(rootID: string): Promise<unknown>;
  loadSessions(): Promise<void>;
  hydrateSessionStatuses(): Promise<void>;
  getRecycleBinEntries(): RecycleBinEntry[];
  deleteRecycleBinEntry(rootID: string): Promise<unknown>;
  clearDeletedSessionState(sessionId: string): void;
  emptyRecycleBin(): Promise<unknown>;
};

export class SessionManagementOperations {
  constructor(private readonly deps: SessionManagementDependencies) {}

  readonly createSession = async (
    title?: string,
    initialPermissionMode: PermissionMode = 'default'
  ) => {
    return createSessionWithDependencies(
      {
        getActiveSessionId: this.deps.getActiveSessionId,
        createRemoteSession: this.deps.createRemoteSession,
        buildCreatePermission: this.deps.buildCreatePermission,
        upsertSession: this.deps.upsertSession,
        resetToolCallExpansionState: this.deps.resetToolCallExpansionState,
        setActiveSessionId: this.deps.setActiveSessionId,
        clearDraftCurrentDocumentState: this.deps.clearDraftCurrentDocumentState,
        adoptDraftCurrentDocumentState: this.deps.adoptDraftCurrentDocumentState,
        setSessionStatusEntry: this.deps.setSessionStatusEntry,
        setSessionUsageLimit: this.deps.setSessionUsageLimit,
        persistActiveSessionId: this.deps.persistActiveSessionId,
        markSessionSeen: this.deps.markSessionSeen,
        getDefaultSelectedModel: this.deps.getDefaultSelectedModel,
        setSelectedModel: this.deps.setSelectedModel,
        resolveDefaultAgent: this.deps.resolveDefaultAgent,
        setSelectedAgent: this.deps.setSelectedAgent,
        getConnectedMcpNames: this.deps.getConnectedMcpNames,
        setSelectedMcpsForSession: this.deps.setSelectedMcpsForSession,
        setPermissionModeForSession: this.deps.setPermissionModeForSession,
        resetDraftPermissionMode: this.deps.resetDraftPermissionMode,
        resetTodoSync: this.deps.resetTodoSync,
        clearMessages: this.deps.clearMessages,
        stopLoading: this.deps.stopLoading,
        setError: this.deps.setError,
      },
      title,
      initialPermissionMode
    );
  };

  readonly deleteSession = async (id: string) => {
    await deleteSessionWithDependencies(
      {
        getSessions: this.deps.getSessions,
        getActiveSessionId: this.deps.getActiveSessionId,
        getDeletedSessionTreeIds: this.deps.getDeletedSessionTreeIds,
        getNextSessionIdAfterDeletion: this.deps.getNextSessionIdAfterDeletion,
        deleteRemoteSession: this.deps.deleteRemoteSession,
        hideDeletedSessionTree: this.deps.hideDeletedSessionTree,
        loadRecycleBin: this.deps.loadRecycleBin,
        selectSession: this.deps.selectSession,
        logError: this.deps.logError,
      },
      id
    );
  };

  readonly restoreSession = async (rootID: string) => {
    await restoreSessionWithDependencies(
      {
        restoreRecycleBinEntry: this.deps.restoreRecycleBinEntry,
        loadSessions: this.deps.loadSessions,
        loadRecycleBin: this.deps.loadRecycleBin,
        hydrateSessionStatuses: this.deps.hydrateSessionStatuses,
        logError: this.deps.logError,
      },
      rootID
    );
  };

  readonly deleteSessionPermanently = async (rootID: string) => {
    await deleteSessionPermanentlyWithDependencies(
      {
        getRecycleBinEntries: this.deps.getRecycleBinEntries,
        deleteRecycleBinEntry: this.deps.deleteRecycleBinEntry,
        loadRecycleBin: this.deps.loadRecycleBin,
        clearDeletedSessionState: this.deps.clearDeletedSessionState,
        logError: this.deps.logError,
      },
      rootID
    );
  };

  readonly emptyRecycleBin = async () => {
    await emptyRecycleBinWithDependencies({
      getRecycleBinEntries: this.deps.getRecycleBinEntries,
      emptyRecycleBin: this.deps.emptyRecycleBin,
      loadRecycleBin: this.deps.loadRecycleBin,
      clearDeletedSessionState: this.deps.clearDeletedSessionState,
      logError: this.deps.logError,
    });
  };
}

export async function createSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    createRemoteSession(body: { title?: string; permission?: PermissionRule[] }): Promise<Session>;
    buildCreatePermission(mode: PermissionMode): PermissionRule[];
    upsertSession(session: Session): void;
    resetToolCallExpansionState(): void;
    setActiveSessionId(sessionId: string): void;
    clearDraftCurrentDocumentState(): void;
    adoptDraftCurrentDocumentState(sessionId: string): void;
    setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
    setSessionUsageLimit(sessionId: string, notice: null): void;
    persistActiveSessionId(sessionId: string): void;
    markSessionSeen(sessionId: string): void;
    getDefaultSelectedModel(): SelectedModel | null;
    setSelectedModel(
      model: SelectedModel | null,
      options?: { sessionId?: string | null; persistGlobal?: boolean }
    ): void;
    resolveDefaultAgent(): string | null;
    setSelectedAgent(
      agent: string | null,
      options?: { sessionId?: string | null; persistGlobal?: boolean }
    ): void;
    getConnectedMcpNames(): string[];
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
    setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;
    resetDraftPermissionMode(): void;
    resetTodoSync(): void;
    clearMessages(): void;
    stopLoading(): void;
    setError(message: string): void;
  },
  title?: string,
  initialPermissionMode: PermissionMode = 'default'
): Promise<string | null> {
  try {
    const previousActiveSessionId = deps.getActiveSessionId();
    const session = await deps.createRemoteSession({
      ...(title ? { title } : {}),
      permission: deps.buildCreatePermission(initialPermissionMode),
    });

    deps.upsertSession(session);
    deps.resetToolCallExpansionState();
    deps.setActiveSessionId(session.id);
    if (previousActiveSessionId) {
      deps.clearDraftCurrentDocumentState();
    } else {
      deps.adoptDraftCurrentDocumentState(session.id);
    }

    deps.setSessionStatusEntry(session.id, { type: 'idle' });
    deps.setSessionUsageLimit(session.id, null);
    deps.persistActiveSessionId(session.id);
    deps.markSessionSeen(session.id);

    const defaultModel = deps.getDefaultSelectedModel();
    if (defaultModel) {
      deps.setSelectedModel(defaultModel, { sessionId: session.id, persistGlobal: false });
    }

    const defaultAgent = deps.resolveDefaultAgent();
    if (defaultAgent) {
      deps.setSelectedAgent(defaultAgent, { sessionId: session.id, persistGlobal: false });
    }

    deps.setSelectedMcpsForSession(session.id, deps.getConnectedMcpNames());
    if (initialPermissionMode !== 'default') {
      deps.setPermissionModeForSession(session.id, initialPermissionMode);
    }

    deps.resetDraftPermissionMode();
    deps.resetTodoSync();
    deps.clearMessages();
    deps.stopLoading();
    return session.id;
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to create session');
    return null;
  }
}

export async function deleteSessionWithDependencies(
  deps: {
    getSessions(): Session[];
    getActiveSessionId(): string | null;
    getDeletedSessionTreeIds(rootId: string, sessions: Session[]): Set<string>;
    getNextSessionIdAfterDeletion(sessions: Session[]): string | null;
    deleteRemoteSession(sessionId: string): Promise<unknown>;
    hideDeletedSessionTree(sessionId: string): void;
    loadRecycleBin(): Promise<void>;
    selectSession(sessionId: string, options?: { markSeen?: boolean }): Promise<void>;
    logError(context: string, err: unknown): void;
  },
  id: string
) {
  try {
    const deletedIds = deps.getDeletedSessionTreeIds(id, deps.getSessions());
    const remainingSessions = deps.getSessions().filter((session) => !deletedIds.has(session.id));
    const activeSessionId = deps.getActiveSessionId();
    const wasActive = activeSessionId ? deletedIds.has(activeSessionId) : false;
    const nextActiveId = wasActive ? deps.getNextSessionIdAfterDeletion(remainingSessions) : null;

    await deps.deleteRemoteSession(id);
    deps.hideDeletedSessionTree(id);
    await deps.loadRecycleBin();

    if (nextActiveId) {
      await deps.selectSession(nextActiveId, { markSeen: false });
    }
  } catch (err) {
    deps.logError('deleteSession', err);
  }
}

export async function restoreSessionWithDependencies(
  deps: {
    restoreRecycleBinEntry(rootID: string): Promise<unknown>;
    loadSessions(): Promise<void>;
    loadRecycleBin(): Promise<void>;
    hydrateSessionStatuses(): Promise<void>;
    logError(context: string, err: unknown): void;
  },
  rootID: string
) {
  try {
    await deps.restoreRecycleBinEntry(rootID);
    await Promise.all([deps.loadSessions(), deps.loadRecycleBin(), deps.hydrateSessionStatuses()]);
  } catch (err) {
    deps.logError('restoreSession', err);
  }
}

export async function deleteSessionPermanentlyWithDependencies(
  deps: {
    getRecycleBinEntries(): RecycleBinEntry[];
    deleteRecycleBinEntry(rootID: string): Promise<unknown>;
    loadRecycleBin(): Promise<void>;
    clearDeletedSessionState(sessionId: string): void;
    logError(context: string, err: unknown): void;
  },
  rootID: string
) {
  try {
    const entry = deps.getRecycleBinEntries().find((item) => item.rootID === rootID);
    await deps.deleteRecycleBinEntry(rootID);
    await deps.loadRecycleBin();

    const deletedSessions = entry?.sessions?.length
      ? entry.sessions
      : entry?.root
        ? [entry.root]
        : [{ id: rootID } as Session];
    for (const session of deletedSessions) {
      deps.clearDeletedSessionState(session.id);
    }
  } catch (err) {
    deps.logError('deleteSessionPermanently', err);
  }
}

export async function emptyRecycleBinWithDependencies(deps: {
  getRecycleBinEntries(): RecycleBinEntry[];
  emptyRecycleBin(): Promise<unknown>;
  loadRecycleBin(): Promise<void>;
  clearDeletedSessionState(sessionId: string): void;
  logError(context: string, err: unknown): void;
}) {
  try {
    const entries = [...deps.getRecycleBinEntries()];
    await deps.emptyRecycleBin();
    await deps.loadRecycleBin();
    for (const entry of entries) {
      for (const session of entry.sessions) {
        deps.clearDeletedSessionState(session.id);
      }
    }
  } catch (err) {
    deps.logError('emptyRecycleBin', err);
  }
}
