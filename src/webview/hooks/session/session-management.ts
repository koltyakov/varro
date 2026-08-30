import type { PermissionMode, RecycleBinEntry } from '../../../shared/protocol';
import type { SelectedModel } from '../../lib/app-state-types';
import type { PermissionRule, Session, SessionStatus } from '../../types';

type SessionManagementDependencies = {
  getActiveSessionId(): string | null;
  getWorkspaceGeneration?(): number;
  getSessionSelectionGeneration?(): number;
  getNewChatDraftGeneration(): number;
  createRemoteSession(body: { title?: string; permission?: PermissionRule[] }): Promise<Session>;
  updateRemoteSession(sessionId: string, body: { title: string }): Promise<Session>;
  forkRemoteSession(sessionId: string, messageID?: string): Promise<Session>;
  getPermissionModeForSession(sessionId: string): PermissionMode;
  isPermissionModeStable?(sessionId: string): boolean;
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
  getEffectiveSessionModel(sessionId: string): SelectedModel | null;
  setSelectedModel(
    model: SelectedModel | null,
    options?: { sessionId?: string | null; persistGlobal?: boolean }
  ): void;
  publishSessionModel(sessionId: string, model: SelectedModel | null): void;
  resolveDefaultAgent(): string | null;
  setSelectedAgent(
    agent: string | null,
    options?: { sessionId?: string | null; persistGlobal?: boolean }
  ): void;
  getInitialMcpNames(): string[];
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  resetDraftSelectedMcps(): void;
  setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;
  persistConfirmedPermissionModeForSession?(sessionId: string, mode: PermissionMode): void;
  resetDraftPermissionMode(): void;
  resetTodoSync(): void;
  clearMessages(): void;
  stopLoading(): void;
  setError(message: string): void;
  getSessions(): Session[];
  getDeletedSessionTreeIds(rootId: string, sessions: Session[]): Set<string>;
  getNextSessionIdAfterDeletion(sessions: Session[]): string | null;
  deleteRemoteSession(sessionId: string): Promise<void | boolean | object>;
  hideDeletedSessionTree(sessionId: string): void;
  loadRecycleBin(): Promise<void | boolean | object>;
  selectSession(
    sessionId: string,
    options?: { markSeen?: boolean }
  ): Promise<void | boolean | object>;
  logError(context: string, cause: unknown): void;
  restoreRecycleBinEntry(rootID: string): Promise<void | boolean | object>;
  loadSessions(): Promise<void | boolean | object>;
  hydrateSessionStatuses(): Promise<void | boolean | object>;
  getRecycleBinEntries(): RecycleBinEntry[];
  deleteRecycleBinEntry(rootID: string): Promise<void | boolean | object>;
  clearDeletedSessionState(sessionId: string): void;
  emptyRecycleBin(): Promise<void | boolean | object>;
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
        getWorkspaceGeneration: this.deps.getWorkspaceGeneration,
        getNewChatDraftGeneration: this.deps.getNewChatDraftGeneration,
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
        publishSessionModel: this.deps.publishSessionModel,
        resolveDefaultAgent: this.deps.resolveDefaultAgent,
        setSelectedAgent: this.deps.setSelectedAgent,
        getInitialMcpNames: this.deps.getInitialMcpNames,
        setSelectedMcpsForSession: this.deps.setSelectedMcpsForSession,
        resetDraftSelectedMcps: this.deps.resetDraftSelectedMcps,
        setPermissionModeForSession: this.deps.setPermissionModeForSession,
        persistConfirmedPermissionModeForSession:
          this.deps.persistConfirmedPermissionModeForSession,
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

  readonly forkSession = async (id: string, messageID?: string) => {
    return forkSessionWithDependencies(
      {
        getActiveSessionId: this.deps.getActiveSessionId,
        getWorkspaceGeneration: this.deps.getWorkspaceGeneration,
        getSessionSelectionGeneration: this.deps.getSessionSelectionGeneration,
        getNewChatDraftGeneration: this.deps.getNewChatDraftGeneration,
        forkRemoteSession: this.deps.forkRemoteSession,
        getEffectiveSessionModel: this.deps.getEffectiveSessionModel,
        setSelectedModel: this.deps.setSelectedModel,
        publishSessionModel: this.deps.publishSessionModel,
        getPermissionModeForSession: this.deps.getPermissionModeForSession,
        isPermissionModeStable: this.deps.isPermissionModeStable,
        setPermissionModeForSession: this.deps.setPermissionModeForSession,
        persistConfirmedPermissionModeForSession:
          this.deps.persistConfirmedPermissionModeForSession,
        upsertSession: this.deps.upsertSession,
        selectSession: this.deps.selectSession,
        setError: this.deps.setError,
      },
      id,
      messageID
    );
  };

  readonly renameSession = async (id: string, title: string) => {
    return renameSessionWithDependencies(
      {
        updateRemoteSession: this.deps.updateRemoteSession,
        getSessions: this.deps.getSessions,
        upsertSession: this.deps.upsertSession,
        setError: this.deps.setError,
      },
      id,
      title
    );
  };

  readonly deleteSession = async (id: string) => {
    await deleteSessionWithDependencies(
      {
        getSessions: this.deps.getSessions,
        getActiveSessionId: this.deps.getActiveSessionId,
        getWorkspaceGeneration: this.deps.getWorkspaceGeneration,
        getSessionSelectionGeneration: this.deps.getSessionSelectionGeneration,
        getNewChatDraftGeneration: this.deps.getNewChatDraftGeneration,
        getDeletedSessionTreeIds: this.deps.getDeletedSessionTreeIds,
        getNextSessionIdAfterDeletion: this.deps.getNextSessionIdAfterDeletion,
        deleteRemoteSession: this.deps.deleteRemoteSession,
        hideDeletedSessionTree: this.deps.hideDeletedSessionTree,
        loadRecycleBin: this.deps.loadRecycleBin,
        selectSession: this.deps.selectSession,
        setError: this.deps.setError,
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
        setError: this.deps.setError,
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
        setError: this.deps.setError,
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
      setError: this.deps.setError,
      logError: this.deps.logError,
    });
  };
}

export async function createSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getWorkspaceGeneration?(): number;
    getNewChatDraftGeneration(): number;
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
    publishSessionModel(sessionId: string, model: SelectedModel | null): void;
    resolveDefaultAgent(): string | null;
    setSelectedAgent(
      agent: string | null,
      options?: { sessionId?: string | null; persistGlobal?: boolean }
    ): void;
    getInitialMcpNames(): string[];
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
    resetDraftSelectedMcps(): void;
    setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;
    persistConfirmedPermissionModeForSession?(sessionId: string, mode: PermissionMode): void;
    resetDraftPermissionMode(): void;
    resetTodoSync(): void;
    clearMessages(): void;
    stopLoading(): void;
    setError(message: string): void;
  },
  title?: string,
  initialPermissionMode: PermissionMode = 'default'
): Promise<string | null> {
  const previousActiveSessionId = deps.getActiveSessionId();
  const workspaceGeneration = deps.getWorkspaceGeneration?.() ?? 0;
  const draftGeneration = deps.getNewChatDraftGeneration();
  try {
    const defaultModel = deps.getDefaultSelectedModel();
    const defaultAgent = deps.resolveDefaultAgent();
    const initialMcpNames = [...deps.getInitialMcpNames()];
    const permission = deps.buildCreatePermission(initialPermissionMode);
    const session = await deps.createRemoteSession({
      title: title || undefined,
      permission: permission.length > 0 ? permission : undefined,
    });

    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) return null;

    deps.upsertSession(session);
    deps.setSessionStatusEntry(session.id, { type: 'idle' });
    deps.setSessionUsageLimit(session.id, null);
    deps.setSelectedMcpsForSession(session.id, initialMcpNames);
    if (initialPermissionMode !== 'default') {
      deps.persistConfirmedPermissionModeForSession?.(session.id, initialPermissionMode);
    }
    deps.publishSessionModel(session.id, defaultModel);

    if (
      deps.getActiveSessionId() !== previousActiveSessionId ||
      deps.getNewChatDraftGeneration() !== draftGeneration
    ) {
      return session.id;
    }

    deps.resetToolCallExpansionState();
    deps.setActiveSessionId(session.id);
    if (previousActiveSessionId) {
      deps.clearDraftCurrentDocumentState();
    } else {
      deps.adoptDraftCurrentDocumentState(session.id);
    }
    deps.persistActiveSessionId(session.id);
    deps.markSessionSeen(session.id);

    if (defaultModel) {
      deps.setSelectedModel(defaultModel, { sessionId: session.id, persistGlobal: false });
    }

    if (defaultAgent) {
      deps.setSelectedAgent(defaultAgent, { sessionId: session.id, persistGlobal: false });
    }

    deps.resetDraftSelectedMcps();

    deps.resetDraftPermissionMode();
    deps.resetTodoSync();
    deps.clearMessages();
    deps.stopLoading();
    return session.id;
  } catch (err) {
    if (
      (deps.getWorkspaceGeneration?.() ?? 0) === workspaceGeneration &&
      deps.getActiveSessionId() === previousActiveSessionId &&
      deps.getNewChatDraftGeneration() === draftGeneration
    ) {
      deps.setError(err instanceof Error ? err.message : 'Failed to create session');
    }
    return null;
  }
}

export async function forkSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getWorkspaceGeneration?(): number;
    getSessionSelectionGeneration?(): number;
    getNewChatDraftGeneration(): number;
    forkRemoteSession(sessionId: string, messageID?: string): Promise<Session>;
    getEffectiveSessionModel(sessionId: string): SelectedModel | null;
    setSelectedModel(
      model: SelectedModel | null,
      options?: { sessionId?: string | null; persistGlobal?: boolean }
    ): void;
    publishSessionModel(sessionId: string, model: SelectedModel | null): void;
    getPermissionModeForSession(sessionId: string): PermissionMode;
    isPermissionModeStable?(sessionId: string): boolean;
    setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;
    persistConfirmedPermissionModeForSession?(sessionId: string, mode: PermissionMode): void;
    upsertSession(session: Session): void;
    selectSession(
      sessionId: string,
      options?: { markSeen?: boolean }
    ): Promise<void | boolean | object>;
    setError(message: string): void;
  },
  id: string,
  messageID?: string
): Promise<string | null> {
  const previousActiveSessionId = deps.getActiveSessionId();
  const workspaceGeneration = deps.getWorkspaceGeneration?.() ?? 0;
  const selectionGeneration = deps.getSessionSelectionGeneration?.() ?? 0;
  const draftGeneration = deps.getNewChatDraftGeneration();
  if (deps.isPermissionModeStable?.(id) === false) {
    deps.setError('Wait for the permission mode update to finish before forking');
    return null;
  }
  try {
    // Forks are independent roots, so the source session's permission mode
    // must be copied over explicitly or the fork silently resets to default.
    const permissionMode = deps.getPermissionModeForSession(id);
    const sourceModel = deps.getEffectiveSessionModel(id);
    const session = await deps.forkRemoteSession(id, messageID);
    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) return null;
    deps.upsertSession(session);
    if (permissionMode !== 'default') {
      deps.persistConfirmedPermissionModeForSession?.(session.id, permissionMode);
    }
    if (sourceModel) {
      deps.setSelectedModel(sourceModel, { sessionId: session.id, persistGlobal: false });
    }
    deps.publishSessionModel(session.id, sourceModel);
    if (
      deps.getActiveSessionId() === previousActiveSessionId &&
      (deps.getSessionSelectionGeneration?.() ?? 0) === selectionGeneration &&
      deps.getNewChatDraftGeneration() === draftGeneration
    ) {
      await deps.selectSession(session.id);
    }
    return session.id;
  } catch (err) {
    if ((deps.getWorkspaceGeneration?.() ?? 0) === workspaceGeneration) {
      deps.setError(err instanceof Error ? err.message : 'Failed to fork session');
    }
    return null;
  }
}

export async function renameSessionWithDependencies(
  deps: {
    updateRemoteSession(sessionId: string, body: { title: string }): Promise<Session>;
    getSessions(): Session[];
    upsertSession(session: Session): void;
    setError(message: string): void;
  },
  id: string,
  title: string
): Promise<boolean> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return false;

  try {
    const session = await deps.updateRemoteSession(id, { title: normalizedTitle });
    const current = deps.getSessions().find((item) => item.id === id);
    deps.upsertSession(current ? { ...current, title: session.title } : session);
    return true;
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to rename session');
    return false;
  }
}

export async function deleteSessionWithDependencies(
  deps: {
    getSessions(): Session[];
    getActiveSessionId(): string | null;
    getWorkspaceGeneration?(): number;
    getSessionSelectionGeneration?(): number;
    getNewChatDraftGeneration?(): number;
    getDeletedSessionTreeIds(rootId: string, sessions: Session[]): Set<string>;
    getNextSessionIdAfterDeletion(sessions: Session[]): string | null;
    deleteRemoteSession(sessionId: string): Promise<void | boolean | object>;
    hideDeletedSessionTree(sessionId: string): void;
    loadRecycleBin(): Promise<void | boolean | object>;
    selectSession(
      sessionId: string,
      options?: { markSeen?: boolean }
    ): Promise<void | boolean | object>;
    setError?(message: string): void;
    logError(context: string, cause: unknown): void;
  },
  id: string
) {
  const workspaceGeneration = deps.getWorkspaceGeneration?.() ?? 0;
  const selectionGeneration = deps.getSessionSelectionGeneration?.() ?? 0;
  const draftGeneration = deps.getNewChatDraftGeneration?.() ?? 0;
  try {
    const deletedIds = deps.getDeletedSessionTreeIds(id, deps.getSessions());
    const activeSessionId = deps.getActiveSessionId();
    const wasActive = activeSessionId ? deletedIds.has(activeSessionId) : false;

    await deps.deleteRemoteSession(id);
    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) return;
    deps.hideDeletedSessionTree(id);
    await deps.loadRecycleBin();
    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) return;

    const currentActiveSessionId = deps.getActiveSessionId();
    const remainingSessions = deps.getSessions().filter((session) => !deletedIds.has(session.id));
    const nextActiveId = wasActive ? deps.getNextSessionIdAfterDeletion(remainingSessions) : null;
    if (
      nextActiveId &&
      (deps.getSessionSelectionGeneration?.() ?? 0) === selectionGeneration &&
      (deps.getNewChatDraftGeneration?.() ?? 0) === draftGeneration &&
      (currentActiveSessionId === null || deletedIds.has(currentActiveSessionId))
    ) {
      await deps.selectSession(nextActiveId, { markSeen: false });
    }
  } catch (err) {
    if ((deps.getWorkspaceGeneration?.() ?? 0) === workspaceGeneration) {
      deps.setError?.(err instanceof Error ? err.message : 'Failed to delete session');
      deps.logError('deleteSession', err);
    }
  }
}

export async function restoreSessionWithDependencies(
  deps: {
    restoreRecycleBinEntry(rootID: string): Promise<void | boolean | object>;
    loadSessions(): Promise<void | boolean | object>;
    loadRecycleBin(): Promise<void | boolean | object>;
    hydrateSessionStatuses(): Promise<void | boolean | object>;
    setError?(message: string): void;
    logError(context: string, cause: unknown): void;
  },
  rootID: string
) {
  try {
    await deps.restoreRecycleBinEntry(rootID);
    await Promise.all([deps.loadSessions(), deps.loadRecycleBin(), deps.hydrateSessionStatuses()]);
  } catch (err) {
    deps.setError?.(err instanceof Error ? err.message : 'Failed to restore session');
    deps.logError('restoreSession', err);
  }
}

export async function deleteSessionPermanentlyWithDependencies(
  deps: {
    getRecycleBinEntries(): RecycleBinEntry[];
    deleteRecycleBinEntry(rootID: string): Promise<void | boolean | object>;
    loadRecycleBin(): Promise<void | boolean | object>;
    clearDeletedSessionState(sessionId: string): void;
    setError?(message: string): void;
    logError(context: string, cause: unknown): void;
  },
  rootID: string
) {
  try {
    const entry = deps.getRecycleBinEntries().find((item) => item.rootID === rootID);
    await deps.deleteRecycleBinEntry(rootID);
    await deps.loadRecycleBin();

    // SAFETY: The surrounding shape or discriminator check establishes the Session contract used below.
    const deletedSessions = entry?.sessions?.length
      ? entry.sessions
      : entry?.root
        ? [entry.root]
        : [{ id: rootID } as Session];
    for (const session of deletedSessions) {
      deps.clearDeletedSessionState(session.id);
    }
  } catch (err) {
    deps.setError?.(err instanceof Error ? err.message : 'Failed to delete session permanently');
    deps.logError('deleteSessionPermanently', err);
  }
}

export async function emptyRecycleBinWithDependencies(deps: {
  getRecycleBinEntries(): RecycleBinEntry[];
  emptyRecycleBin(): Promise<void | boolean | object>;
  loadRecycleBin(): Promise<void | boolean | object>;
  clearDeletedSessionState(sessionId: string): void;
  setError?(message: string): void;
  logError(context: string, cause: unknown): void;
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
    deps.setError?.(err instanceof Error ? err.message : 'Failed to empty the recycle bin');
    deps.logError('emptyRecycleBin', err);
  }
}
