import type {
  PermissionMode,
  RecycleBinEntry,
  SessionWorkspaceTarget,
} from '../../../shared/protocol';
import type { SelectedModel } from '../../lib/app-state-types';
import type { PermissionRule, Session, SessionStatus } from '../../types';

type SessionManagementDependencies = Parameters<typeof createSessionWithDependencies>[0] &
  Parameters<typeof forkSessionWithDependencies>[0] &
  Omit<Parameters<typeof renameSessionWithDependencies>[0], 'isCurrentRequest'> &
  Parameters<typeof deleteSessionWithDependencies>[0] &
  Parameters<typeof restoreSessionWithDependencies>[0] &
  Parameters<typeof deleteSessionPermanentlyWithDependencies>[0] &
  Parameters<typeof emptyRecycleBinWithDependencies>[0];

export class SessionManagementOperations {
  private readonly renameGenerations = new Map<string, number>();
  private nextRenameGeneration = 0;
  private readonly pendingForks = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: SessionManagementDependencies) {}

  readonly createSession = async (
    title?: string,
    initialPermissionMode: PermissionMode = 'default',
    workspaceTarget?: SessionWorkspaceTarget,
    selectedModel?: SelectedModel | null
  ) => {
    return createSessionWithDependencies(
      {
        ...this.deps,
        getDefaultSelectedModel: () =>
          selectedModel === undefined ? this.deps.getDefaultSelectedModel() : selectedModel,
      },
      title,
      initialPermissionMode,
      workspaceTarget
    );
  };

  readonly forkSession = (
    id: string,
    messageID?: string,
    options?: { select?: boolean }
  ): Promise<string | null> => {
    const key = JSON.stringify([
      this.deps.getWorkspaceGeneration?.() ?? 0,
      id,
      messageID,
      options?.select !== false,
    ]);
    const pending = this.pendingForks.get(key);
    if (pending) return pending;

    const fork = forkSessionWithDependencies(this.deps, id, messageID, options).finally(() => {
      this.pendingForks.delete(key);
    });
    this.pendingForks.set(key, fork);
    return fork;
  };

  readonly renameSession = async (id: string, title: string) => {
    if (!title.trim()) return false;
    const generation = ++this.nextRenameGeneration;
    this.renameGenerations.set(id, generation);
    try {
      return await renameSessionWithDependencies(
        {
          ...this.deps,
          isCurrentRequest: () => this.renameGenerations.get(id) === generation,
        },
        id,
        title
      );
    } finally {
      if (this.renameGenerations.get(id) === generation) this.renameGenerations.delete(id);
    }
  };

  readonly deleteSession = async (id: string) => {
    await deleteSessionWithDependencies(this.deps, id);
  };

  readonly restoreSession = async (rootID: string) => {
    await restoreSessionWithDependencies(this.deps, rootID);
  };

  readonly deleteSessionPermanently = async (rootID: string) => {
    await deleteSessionPermanentlyWithDependencies(this.deps, rootID);
  };

  readonly emptyRecycleBin = async () => {
    await emptyRecycleBinWithDependencies(this.deps);
  };
}

// Keeps a new session's non-default mode pending until the host confirms it. A failed save reports
// an error only while this call still owns the pending mode.
async function applyNewSessionPermissionMode(
  deps: Pick<
    SessionManagementDependencies,
    | 'setPendingSessionPermissionMode'
    | 'setPermissionModeForSession'
    | 'persistConfirmedPermissionModeForSession'
    | 'setError'
  >,
  session: Session,
  mode: PermissionMode
) {
  const pendingGeneration = deps.setPendingSessionPermissionMode?.(session.id, mode);
  deps.setPermissionModeForSession(session.id, mode);
  try {
    await deps.persistConfirmedPermissionModeForSession?.(session.id, mode, session.directory);
    deps.setPendingSessionPermissionMode?.(session.id, null, pendingGeneration ?? undefined);
  } catch (err) {
    const clearedGeneration = deps.setPendingSessionPermissionMode?.(
      session.id,
      null,
      pendingGeneration ?? undefined
    );
    if (pendingGeneration === undefined || clearedGeneration === pendingGeneration) {
      deps.setError(
        err instanceof Error ? err.message : 'Permission mode was not saved; select a mode to retry'
      );
    }
  }
}

export async function createSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getWorkspaceGeneration?(): number;
    getNewChatDraftGeneration(): number;
    createRemoteSession(
      body: { title?: string; permission?: PermissionRule[] },
      workspaceTarget?: SessionWorkspaceTarget
    ): Promise<Session>;
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
    getInitialMcpNames(): string[] | null;
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
    resetDraftSelectedMcps(): void;
    setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;
    setPendingSessionPermissionMode?(
      sessionId: string,
      mode: PermissionMode | null,
      generation?: number
    ): number | null;
    persistConfirmedPermissionModeForSession?(
      sessionId: string,
      mode: PermissionMode,
      directory?: string
    ): Promise<void>;
    resetDraftPermissionMode(): void;
    resetTodoSync(): void;
    clearMessages(): void;
    stopLoading(): void;
    setError(message: string): void;
  },
  title?: string,
  initialPermissionMode: PermissionMode = 'default',
  workspaceTarget?: SessionWorkspaceTarget
): Promise<string | null> {
  const previousActiveSessionId = deps.getActiveSessionId();
  const workspaceGeneration = deps.getWorkspaceGeneration?.() ?? 0;
  const draftGeneration = deps.getNewChatDraftGeneration();
  try {
    const defaultModel = deps.getDefaultSelectedModel();
    const defaultAgent = deps.resolveDefaultAgent();
    const selectedMcps = deps.getInitialMcpNames();
    const initialMcpNames = selectedMcps ? [...selectedMcps] : null;
    const permission = deps.buildCreatePermission(initialPermissionMode);
    const body = {
      title: title || undefined,
      permission: permission.length > 0 ? permission : undefined,
    };
    const session = workspaceTarget
      ? await deps.createRemoteSession(body, workspaceTarget)
      : await deps.createRemoteSession(body);

    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) {
      if (initialPermissionMode !== 'default') {
        await deps.persistConfirmedPermissionModeForSession?.(
          session.id,
          initialPermissionMode,
          session.directory
        );
      }
      return null;
    }

    deps.upsertSession(session);
    deps.setSessionStatusEntry(session.id, { type: 'idle' });
    deps.setSessionUsageLimit(session.id, null);
    if (initialMcpNames) deps.setSelectedMcpsForSession(session.id, initialMcpNames);
    if (initialPermissionMode !== 'default') {
      await applyNewSessionPermissionMode(deps, session, initialPermissionMode);
    }
    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) return null;
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
    setPendingSessionPermissionMode?(
      sessionId: string,
      mode: PermissionMode | null,
      generation?: number
    ): number | null;
    persistConfirmedPermissionModeForSession?(
      sessionId: string,
      mode: PermissionMode,
      directory?: string
    ): Promise<void>;
    upsertSession(session: Session): void;
    selectSession(
      sessionId: string,
      options?: { markSeen?: boolean }
    ): Promise<void | boolean | object>;
    setError(message: string): void;
  },
  id: string,
  messageID?: string,
  options?: { select?: boolean }
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
    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) {
      if (permissionMode !== 'default') {
        await deps.persistConfirmedPermissionModeForSession?.(
          session.id,
          permissionMode,
          session.directory
        );
      }
      return null;
    }
    deps.upsertSession(session);
    if (permissionMode !== 'default') {
      await applyNewSessionPermissionMode(deps, session, permissionMode);
    }
    if ((deps.getWorkspaceGeneration?.() ?? 0) !== workspaceGeneration) return null;
    if (sourceModel) {
      deps.setSelectedModel(sourceModel, { sessionId: session.id, persistGlobal: false });
    }
    deps.publishSessionModel(session.id, sourceModel);
    if (
      options?.select !== false &&
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
    isCurrentRequest?(): boolean;
  },
  id: string,
  title: string
): Promise<boolean> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return false;
  const baseline = deps.getSessions().find((item) => item.id === id);

  try {
    const session = await deps.updateRemoteSession(id, { title: normalizedTitle });
    if (deps.isCurrentRequest?.() === false) return true;
    const current = deps.getSessions().find((item) => item.id === id);
    if (!current || current.title !== baseline?.title) return true;
    deps.upsertSession({ ...current, title: session.title });
    return true;
  } catch (err) {
    if (deps.isCurrentRequest?.() !== false) {
      deps.setError(err instanceof Error ? err.message : 'Failed to rename session');
    }
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
