import type { Message, Part, SessionStatus } from '../types';
import { normalizeModelVariant } from '../lib/model-variants';

type SessionEntry = { info: Message; parts: Part[] };

type ResolvedModel = { providerID: string; modelID: string; variant?: string };

type LastOpenedView =
  | { type: 'new-session'; timestamp: number }
  | { type: 'sessions-list'; timestamp: number }
  | { type: 'session'; sessionId: string; timestamp: number };

export const STARTUP_VIEW_RESTORE_WINDOW_MS = 10 * 60 * 1000;

export type InterruptedSessionContinueBody = {
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
};

export const INTERRUPTED_SESSION_CONTINUE_PROMPT =
  'Continue from where you were interrupted before the extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.';

export function buildInterruptedSessionContinueBody(args: {
  agent: string | null;
  model: ResolvedModel | null;
}): InterruptedSessionContinueBody {
  const body: InterruptedSessionContinueBody = {
    parts: [{ type: 'text', text: INTERRUPTED_SESSION_CONTINUE_PROMPT }],
  };

  if (args.agent) {
    body.agent = args.agent;
  }

  if (args.model) {
    body.model = {
      providerID: args.model.providerID,
      modelID: args.model.modelID,
    };
    if (args.model.variant) {
      body.variant = normalizeModelVariant(args.model.modelID, args.model.variant) || undefined;
    }
  }

  return body;
}

export function shouldContinueInterruptedSession(messages: SessionEntry[]) {
  const lastInfo = messages.at(-1)?.info;
  if (!lastInfo) return false;
  if (lastInfo.role === 'user') return true;
  return !lastInfo.error && !lastInfo.time.completed;
}

export async function continueInterruptedSessionWithDependencies(
  deps: {
    syncSessionMcps(sessionId: string): Promise<void>;
    resolveModel(sessionId: string): ResolvedModel | null;
    resolveAgent(sessionId: string): string | null;
    sendAsync(sessionId: string, body: InterruptedSessionContinueBody): Promise<void>;
    syncSession(sessionId: string): Promise<void>;
    recheckSessionStatus(sessionId: string): Promise<void>;
  },
  sessionId: string
) {
  await deps.syncSessionMcps(sessionId);
  await deps.sendAsync(
    sessionId,
    buildInterruptedSessionContinueBody({
      agent: deps.resolveAgent(sessionId),
      model: deps.resolveModel(sessionId),
    })
  );
  await Promise.all([deps.syncSession(sessionId), deps.recheckSessionStatus(sessionId)]).catch(
    () => {}
  );
}

export async function recoverInterruptedSessionsWithDependencies(
  deps: {
    consumeInterruptedSessionIds(): string[];
    isCurrentGeneration(generation: number): boolean;
    hasSession(sessionId: string): boolean;
    getSessionStatus(sessionId: string): SessionStatus | null | undefined;
    hasPendingQuestion(sessionId: string): boolean;
    hasPendingPermission(sessionId: string): boolean;
    loadSessionMessages(sessionId: string): Promise<SessionEntry[]>;
    continueInterruptedSession(sessionId: string): Promise<void>;
    logError(context: string, err: unknown): void;
  },
  generation: number
) {
  const sessionIds = deps
    .consumeInterruptedSessionIds()
    .filter((id, index, items) => items.indexOf(id) === index);
  if (sessionIds.length === 0) return;

  for (const sessionId of sessionIds) {
    if (!deps.isCurrentGeneration(generation)) return;
    if (!deps.hasSession(sessionId)) continue;

    const status = deps.getSessionStatus(sessionId);
    if (status?.type === 'busy' || status?.type === 'retry') continue;
    if (deps.hasPendingQuestion(sessionId)) continue;
    if (deps.hasPendingPermission(sessionId)) continue;

    try {
      const messages = await deps.loadSessionMessages(sessionId);
      if (!deps.isCurrentGeneration(generation)) return;
      if (!shouldContinueInterruptedSession(messages)) continue;
      await deps.continueInterruptedSession(sessionId);
    } catch (err) {
      deps.logError('recoverInterruptedSession', err);
    }
  }
}

export async function initConnectionWithDependencies(
  deps: {
    health(): Promise<unknown>;
    loadInitialData(): Promise<void>;
    hydrateSessionStatuses(): Promise<void>;
    getActiveSessionId(): string | null;
    getPersistedActiveSessionId(): string | null;
    getPersistedLastOpenedView?(): LastOpenedView | null;
    getSessionCount?(): number;
    getOnlyPrimarySessionId(): string | null;
    hasSession(sessionId: string): boolean;
    selectSession(sessionId: string): Promise<void>;
    setShowSessionPicker(value: boolean): void;
    recoverInterruptedSessions(generation: number): Promise<void>;
    setInitialized(value: boolean): void;
    setError(message: string | null): void;
    now?(): number;
  },
  generationRef: { next(): number; isCurrent(generation: number): boolean }
) {
  const generation = generationRef.next();
  try {
    await deps.health();
    if (!generationRef.isCurrent(generation)) return;

    await deps.loadInitialData();
    if (!generationRef.isCurrent(generation)) return;

    await deps.hydrateSessionStatuses();
    if (!generationRef.isCurrent(generation)) return;

    if (!deps.getActiveSessionId()) {
      await restoreStartupView(deps, generation, generationRef);
      if (!generationRef.isCurrent(generation)) return;
    }

    await deps.recoverInterruptedSessions(generation);
    if (!generationRef.isCurrent(generation)) return;

    deps.setInitialized(true);
  } catch {
    deps.setInitialized(false);
    deps.setError('Failed to connect to OpenCode server');
  }
}

async function restoreStartupView(
  deps: {
    getPersistedActiveSessionId(): string | null;
    getPersistedLastOpenedView?(): LastOpenedView | null;
    getSessionCount?(): number;
    getOnlyPrimarySessionId(): string | null;
    hasSession(sessionId: string): boolean;
    selectSession(sessionId: string): Promise<void>;
    setShowSessionPicker(value: boolean): void;
    now?(): number;
  },
  generation: number,
  generationRef: { isCurrent(generation: number): boolean }
) {
  const sessionCount = deps.getSessionCount?.() ?? 0;
  const lastOpenedView = deps.getPersistedLastOpenedView?.() ?? null;

  if (
    lastOpenedView?.type === 'session' &&
    (deps.now?.() ?? Date.now()) - lastOpenedView.timestamp < STARTUP_VIEW_RESTORE_WINDOW_MS &&
    deps.hasSession(lastOpenedView.sessionId)
  ) {
    deps.setShowSessionPicker(false);
    await deps.selectSession(lastOpenedView.sessionId);
    return;
  }

  if (
    lastOpenedView?.type === 'sessions-list' &&
    (deps.now?.() ?? Date.now()) - lastOpenedView.timestamp < STARTUP_VIEW_RESTORE_WINDOW_MS
  ) {
    deps.setShowSessionPicker(true);
    return;
  }

  if (
    lastOpenedView?.type === 'new-session' &&
    (deps.now?.() ?? Date.now()) - lastOpenedView.timestamp < STARTUP_VIEW_RESTORE_WINDOW_MS
  ) {
    deps.setShowSessionPicker(false);
    return;
  }

  const onlyPrimarySessionId = deps.getOnlyPrimarySessionId();
  if (sessionCount === 1 && onlyPrimarySessionId && deps.hasSession(onlyPrimarySessionId)) {
    deps.setShowSessionPicker(false);
    await deps.selectSession(onlyPrimarySessionId);
    return;
  }

  if (!generationRef.isCurrent(generation)) return;

  if (sessionCount > 0) {
    deps.setShowSessionPicker(true);
    return;
  }

  deps.setShowSessionPicker(false);
}

export function ensureConnectionInitializedWithDependencies(deps: {
  isInitialized(): boolean;
  isInitializing(): boolean;
  initConnection(): Promise<unknown>;
  setInitializing(value: boolean): void;
}) {
  if (deps.isInitialized() || deps.isInitializing()) return;
  deps.setInitializing(true);
  void deps.initConnection().finally(() => {
    deps.setInitializing(false);
  });
}

export function createConnectionBootstrapOperations(deps: {
  health(): Promise<unknown>;
  loadInitialData(): Promise<void>;
  hydrateSessionStatuses(): Promise<void>;
  getActiveSessionId(): string | null;
  getPersistedActiveSessionId(): string | null;
  getPersistedLastOpenedView?(): LastOpenedView | null;
  getSessionCount?(): number;
  getOnlyPrimarySessionId(): string | null;
  hasSession(sessionId: string): boolean;
  selectSession(sessionId: string): Promise<void>;
  setShowSessionPicker(value: boolean): void;
  setInitialized(value: boolean): void;
  setError(message: string | null): void;
  nextConnectionGeneration(): number;
  isCurrentConnectionGeneration(generation: number): boolean;
  consumeInterruptedSessionIds(): string[];
  getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  hasPendingQuestion(sessionId: string): boolean;
  hasPendingPermission(sessionId: string): boolean;
  loadSessionMessages(sessionId: string): Promise<SessionEntry[]>;
  logError(context: string, err: unknown): void;
  syncSessionMcps(sessionId: string): Promise<void>;
  resolveModel(sessionId: string): ResolvedModel | null;
  resolveAgent(sessionId: string): string | null;
  sendAsync(sessionId: string, body: InterruptedSessionContinueBody): Promise<void>;
  syncSession(sessionId: string): Promise<void>;
  recheckSessionStatus(sessionId: string): Promise<void>;
  now?(): number;
}) {
  const recoverInterruptedSessions = (generation: number) => {
    return recoverInterruptedSessionsWithDependencies(
      {
        consumeInterruptedSessionIds: deps.consumeInterruptedSessionIds,
        isCurrentGeneration: deps.isCurrentConnectionGeneration,
        hasSession: deps.hasSession,
        getSessionStatus: deps.getSessionStatus,
        hasPendingQuestion: deps.hasPendingQuestion,
        hasPendingPermission: deps.hasPendingPermission,
        loadSessionMessages: deps.loadSessionMessages,
        continueInterruptedSession,
        logError: deps.logError,
      },
      generation
    );
  };

  const continueInterruptedSession = (sessionId: string) => {
    return continueInterruptedSessionWithDependencies(
      {
        syncSessionMcps: deps.syncSessionMcps,
        resolveModel: deps.resolveModel,
        resolveAgent: deps.resolveAgent,
        sendAsync: deps.sendAsync,
        syncSession: deps.syncSession,
        recheckSessionStatus: deps.recheckSessionStatus,
      },
      sessionId
    );
  };

  const initConnection = () => {
    return initConnectionWithDependencies(
      {
        health: deps.health,
        loadInitialData: deps.loadInitialData,
        hydrateSessionStatuses: deps.hydrateSessionStatuses,
        getActiveSessionId: deps.getActiveSessionId,
        getPersistedActiveSessionId: deps.getPersistedActiveSessionId,
        getPersistedLastOpenedView: deps.getPersistedLastOpenedView,
        getSessionCount: deps.getSessionCount,
        getOnlyPrimarySessionId: deps.getOnlyPrimarySessionId,
        hasSession: deps.hasSession,
        selectSession: deps.selectSession,
        setShowSessionPicker: deps.setShowSessionPicker,
        recoverInterruptedSessions,
        setInitialized: deps.setInitialized,
        setError: deps.setError,
        now: deps.now || Date.now,
      },
      {
        next: deps.nextConnectionGeneration,
        isCurrent: deps.isCurrentConnectionGeneration,
      }
    );
  };

  const ensureConnectionInitialized = (
    state: { initialized: boolean; initializing: boolean },
    setInitializing: (value: boolean) => void
  ) => {
    ensureConnectionInitializedWithDependencies({
      isInitialized: () => state.initialized,
      isInitializing: () => state.initializing,
      initConnection,
      setInitializing,
    });
  };

  return {
    recoverInterruptedSessions,
    continueInterruptedSession,
    initConnection,
    ensureConnectionInitialized,
  };
}
