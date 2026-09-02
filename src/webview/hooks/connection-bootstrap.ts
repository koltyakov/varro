import type { HealthResponse } from '../../shared/health';
import { normalizeModelVariant } from '../../shared/model-variant';
import type { WebviewRoute } from '../../shared/protocol';
import type { MessageEntry, SessionStatus } from '../types';

type ResolvedModel = { providerID: string; modelID: string; variant?: string };

type LastOpenedView =
  | { type: 'new-session'; timestamp: number }
  | { type: 'sessions-list'; timestamp: number }
  | { type: 'session'; sessionId: string; directory?: string; timestamp: number };

export const STARTUP_VIEW_RESTORE_WINDOW_MS = 10 * 60 * 1000;
const MAX_SETTLED_RECOVERY_CLAIMS = 100;

export type InterruptedSessionContinueBody = {
  messageID?: string;
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
};

export const INTERRUPTED_SESSION_CONTINUE_PROMPT =
  'Continue from where you were interrupted by the server restart or extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.';

export function buildInterruptedSessionContinueBody(args: {
  agent: string | null;
  model: ResolvedModel | null;
  messageID?: string;
}): InterruptedSessionContinueBody {
  const body: InterruptedSessionContinueBody = {
    parts: [{ type: 'text', text: INTERRUPTED_SESSION_CONTINUE_PROMPT }],
  };

  if (args.messageID) body.messageID = args.messageID;

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

export function shouldContinueInterruptedSession(messages: MessageEntry[]) {
  const lastMessage = messages.at(-1);
  const lastInfo = lastMessage?.info;
  if (!lastInfo) return false;
  if (lastInfo.role === 'user') {
    return !lastMessage.parts.some(
      (part) => part.type === 'text' && part.text === INTERRUPTED_SESSION_CONTINUE_PROMPT
    );
  }
  return !lastInfo.error && !lastInfo.time.completed;
}

export function buildInterruptedSessionMessageID(sessionId: string, message: MessageEntry): string {
  const sourceID = message.info.id;
  const sourceMatch = sourceID.match(/^msg_([0-9a-f]{12})([0-9A-Za-z]{14})$/);
  if (sourceMatch) {
    const encoded = BigInt(`0x${sourceMatch[1]}`) + 1n;
    if (encoded < 1n << 48n) {
      return `msg_${encoded.toString(16).padStart(12, '0')}${sourceMatch[2]}`;
    }
  }

  const timestamp = BigInt(Math.max(0, Math.floor(message.info.time.created))) % (1n << 36n);
  let hash = 0xcbf29ce484222325n;
  for (const character of `${sessionId}:${sourceID}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let index = 0; index < 14; index += 1) {
    suffix += alphabet[Number(hash % 62n)];
    hash = BigInt.asUintN(64, hash / 62n + 0x9e3779b97f4a7c15n);
  }
  return `msg_${(timestamp * 0x1000n + 1n).toString(16).padStart(12, '0')}${suffix}`;
}

export async function continueInterruptedSessionWithDependencies(
  deps: {
    syncSessionMcps(sessionId: string): Promise<void | boolean | object>;
    resolveModel(sessionId: string): ResolvedModel | null;
    resolveAgent(sessionId: string): string | null;
    sendAsync(
      sessionId: string,
      body: InterruptedSessionContinueBody,
      options?: { interruptedRecovery?: true }
    ): Promise<void | boolean | object>;
    syncSession(sessionId: string): Promise<void | boolean | object>;
    recheckSessionStatus(sessionId: string): Promise<void | boolean | object>;
  },
  sessionId: string,
  options?: { messageID?: string; interruptedRecovery?: true }
) {
  await deps.syncSessionMcps(sessionId);
  const body = buildInterruptedSessionContinueBody({
    agent: deps.resolveAgent(sessionId),
    model: deps.resolveModel(sessionId),
    messageID: options?.messageID,
  });
  if (options?.interruptedRecovery) {
    await deps.sendAsync(sessionId, body, { interruptedRecovery: true });
  } else {
    await deps.sendAsync(sessionId, body);
  }
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
    loadSessionMessages(sessionId: string): Promise<MessageEntry[]>;
    continueInterruptedSession(
      sessionId: string,
      sourceMessage: MessageEntry
    ): Promise<void | boolean | object>;
    logError(context: string, cause: unknown): void;
  },
  generation: number,
  deliveredSessionIds?: readonly string[]
) {
  const sessionIds = [...new Set(deliveredSessionIds ?? deps.consumeInterruptedSessionIds())];
  const consumedSessionIds: string[] = [];
  if (sessionIds.length === 0) return consumedSessionIds;

  for (const sessionId of sessionIds) {
    if (!deps.isCurrentGeneration(generation)) break;
    if (!deps.hasSession(sessionId)) {
      consumedSessionIds.push(sessionId);
      continue;
    }

    const status = deps.getSessionStatus(sessionId);
    if (status?.type === 'busy' || status?.type === 'retry') {
      consumedSessionIds.push(sessionId);
      continue;
    }
    if (deps.hasPendingQuestion(sessionId) || deps.hasPendingPermission(sessionId)) {
      consumedSessionIds.push(sessionId);
      continue;
    }

    try {
      const messages = await deps.loadSessionMessages(sessionId);
      if (!deps.isCurrentGeneration(generation)) break;
      if (!shouldContinueInterruptedSession(messages)) {
        consumedSessionIds.push(sessionId);
        continue;
      }
      await deps.continueInterruptedSession(sessionId, messages.at(-1)!);
      consumedSessionIds.push(sessionId);
    } catch (err) {
      if (!deps.isCurrentGeneration(generation)) break;
      deps.logError('recoverInterruptedSession', err);
    }
  }

  return consumedSessionIds;
}

export async function initConnectionWithDependencies(
  deps: {
    health(): Promise<HealthResponse>;
    loadInitialData(): Promise<void | boolean | object>;
    hydrateSessionStatuses(): Promise<void | boolean | object>;
    getActiveSessionId(): string | null;
    getPersistedActiveSessionId(): string | null;
    getPersistedLastOpenedView?(): LastOpenedView | null;
    getInitialRoute?(): WebviewRoute | null;
    markInitialRouteConsumed?(): void;
    getSessionCount?(): number;
    getOnlyPrimarySessionId(): string | null;
    hasSession(sessionId: string): boolean;
    getSessionDirectory?(sessionId: string): string | undefined;
    selectSession(sessionId: string, directory?: string): Promise<void | boolean | object>;
    startNewSession?(): void;
    setShowSessionPicker(value: boolean): void;
    recoverInterruptedSessions(generation: number): Promise<void | boolean | object>;
    setInitialized(value: boolean): void;
    setError(message: string | null): void;
    now?(): number;
  },
  generationRef: { next(): number; isCurrent(generation: number): boolean }
) {
  const generation = generationRef.next();
  try {
    const health = await deps.health();
    if (!generationRef.isCurrent(generation)) return;
    if (!health.healthy) throw new Error('OpenCode server is not healthy');

    await deps.loadInitialData();
    if (!generationRef.isCurrent(generation)) return;

    await deps.hydrateSessionStatuses();
    if (!generationRef.isCurrent(generation)) return;

    const initialRoute = deps.getInitialRoute?.() ?? null;
    if (initialRoute || !deps.getActiveSessionId()) {
      await restoreStartupView(deps, generation, generationRef, initialRoute);
      if (!generationRef.isCurrent(generation)) return;
    }

    await deps.recoverInterruptedSessions(generation);
    if (!generationRef.isCurrent(generation)) return;

    deps.setInitialized(true);
  } catch (err) {
    if (!generationRef.isCurrent(generation)) return;
    deps.setInitialized(false);
    deps.setError(
      `Failed to connect to OpenCode server: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function restoreStartupView(
  deps: {
    getPersistedActiveSessionId(): string | null;
    getPersistedLastOpenedView?(): LastOpenedView | null;
    markInitialRouteConsumed?(): void;
    getSessionCount?(): number;
    getOnlyPrimarySessionId(): string | null;
    hasSession(sessionId: string): boolean;
    getSessionDirectory?(sessionId: string): string | undefined;
    selectSession(sessionId: string, directory?: string): Promise<void | boolean | object>;
    startNewSession?(): void;
    setShowSessionPicker(value: boolean): void;
    now?(): number;
  },
  generation: number,
  generationRef: { isCurrent(generation: number): boolean },
  initialRoute: WebviewRoute | null
) {
  const sessionCount = deps.getSessionCount?.() ?? 0;
  const lastOpenedView = deps.getPersistedLastOpenedView?.() ?? null;

  if (initialRoute) {
    if (initialRoute.type === 'new-session') deps.startNewSession?.();
    deps.setShowSessionPicker(false);
    if (initialRoute.type === 'session') {
      const directory =
        deps.getSessionDirectory?.(initialRoute.sessionId) ?? initialRoute.directory;
      const selected = await (directory
        ? deps.selectSession(initialRoute.sessionId, directory)
        : deps.selectSession(initialRoute.sessionId));
      if (selected === false) deps.setShowSessionPicker(true);
    }
    deps.markInitialRouteConsumed?.();
    return;
  }

  if (
    lastOpenedView?.type === 'session' &&
    (deps.now?.() ?? Date.now()) - lastOpenedView.timestamp < STARTUP_VIEW_RESTORE_WINDOW_MS &&
    deps.hasSession(lastOpenedView.sessionId)
  ) {
    deps.setShowSessionPicker(false);
    const directory =
      deps.getSessionDirectory?.(lastOpenedView.sessionId) ?? lastOpenedView.directory;
    const selected = await (directory
      ? deps.selectSession(lastOpenedView.sessionId, directory)
      : deps.selectSession(lastOpenedView.sessionId));
    if (selected === false) deps.setShowSessionPicker(true);
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
  initConnection(): Promise<void | boolean | object>;
  beginInitializing(): number;
  finishInitializing(attempt: number): void;
}) {
  if (deps.isInitialized() || deps.isInitializing()) return;
  const attempt = deps.beginInitializing();
  void deps.initConnection().finally(() => {
    deps.finishInitializing(attempt);
  });
}

export function createConnectionBootstrapOperations(deps: {
  health(): Promise<HealthResponse>;
  loadInitialData(): Promise<void | boolean | object>;
  hydrateSessionStatuses(): Promise<void | boolean | object>;
  getActiveSessionId(): string | null;
  getPersistedActiveSessionId(): string | null;
  getPersistedLastOpenedView?(): LastOpenedView | null;
  getInitialRoute?(): WebviewRoute | null;
  markInitialRouteConsumed?(): void;
  getSessionCount?(): number;
  getOnlyPrimarySessionId(): string | null;
  hasSession(sessionId: string): boolean;
  getSessionDirectory?(sessionId: string): string | undefined;
  selectSession(sessionId: string, directory?: string): Promise<void | boolean | object>;
  startNewSession?(): void;
  setShowSessionPicker(value: boolean): void;
  setInitialized(value: boolean): void;
  setError(message: string | null): void;
  nextConnectionGeneration(): number;
  isCurrentConnectionGeneration(generation: number): boolean;
  getCurrentConnectionGeneration(): number;
  isInitialized(): boolean;
  consumeInterruptedSessionIds(): string[];
  acknowledgeInterruptedSessionRecovery(claimId: number, consumedSessionIds: string[]): boolean;
  getSessionStatus(sessionId: string): SessionStatus | null | undefined;
  hasPendingQuestion(sessionId: string): boolean;
  hasPendingPermission(sessionId: string): boolean;
  loadSessionMessages(sessionId: string): Promise<MessageEntry[]>;
  logError(context: string, cause: unknown): void;
  syncSessionMcps(sessionId: string): Promise<void | boolean | object>;
  resolveModel(sessionId: string): ResolvedModel | null;
  resolveAgent(sessionId: string): string | null;
  sendAsync(
    sessionId: string,
    body: InterruptedSessionContinueBody,
    options?: { interruptedRecovery?: true }
  ): Promise<void | boolean | object>;
  syncSession(sessionId: string): Promise<void | boolean | object>;
  recheckSessionStatus(sessionId: string): Promise<void | boolean | object>;
  now?(): number;
}) {
  const pendingRecoveryClaims = new Map<number, string[]>();
  const settledRecoveryClaims = new Map<number, string[]>();
  const processingRecoveryClaims = new Set<number>();
  let recoveryDrain: Promise<void> | null = null;

  const recoverSessionIds = (generation: number, sessionIds?: readonly string[]) => {
    return recoverInterruptedSessionsWithDependencies(
      {
        consumeInterruptedSessionIds: deps.consumeInterruptedSessionIds,
        isCurrentGeneration: deps.isCurrentConnectionGeneration,
        hasSession: deps.hasSession,
        getSessionStatus: deps.getSessionStatus,
        hasPendingQuestion: deps.hasPendingQuestion,
        hasPendingPermission: deps.hasPendingPermission,
        loadSessionMessages: deps.loadSessionMessages,
        continueInterruptedSession: (sessionId, sourceMessage) =>
          continueInterruptedSession(sessionId, {
            messageID: buildInterruptedSessionMessageID(sessionId, sourceMessage),
            interruptedRecovery: true,
          }),
        logError: deps.logError,
      },
      generation,
      sessionIds
    );
  };

  const continueInterruptedSession = (
    sessionId: string,
    options?: { messageID?: string; interruptedRecovery?: true }
  ) => {
    return continueInterruptedSessionWithDependencies(
      {
        syncSessionMcps: deps.syncSessionMcps,
        resolveModel: deps.resolveModel,
        resolveAgent: deps.resolveAgent,
        sendAsync: deps.sendAsync,
        syncSession: deps.syncSession,
        recheckSessionStatus: deps.recheckSessionStatus,
      },
      sessionId,
      options
    );
  };

  const acknowledgeRecoveryClaim = (claimId: number, consumedSessionIds: string[]) => {
    deps.acknowledgeInterruptedSessionRecovery(claimId, consumedSessionIds);
  };

  const drainRecoveryClaims = async (generation: number) => {
    if (recoveryDrain) return recoveryDrain;

    const operation = (async () => {
      while (deps.isCurrentConnectionGeneration(generation)) {
        const nextClaim = [...pendingRecoveryClaims].find(
          ([claimId]) => !processingRecoveryClaims.has(claimId)
        );
        if (!nextClaim) return;

        const [claimId, sessionIds] = nextClaim;
        processingRecoveryClaims.add(claimId);
        try {
          const consumedSessionIds = await recoverSessionIds(generation, sessionIds);
          if (!deps.isCurrentConnectionGeneration(generation)) return;
          pendingRecoveryClaims.delete(claimId);
          settledRecoveryClaims.set(claimId, consumedSessionIds);
          while (settledRecoveryClaims.size > MAX_SETTLED_RECOVERY_CLAIMS) {
            const oldestClaimId = settledRecoveryClaims.keys().next().value;
            if (oldestClaimId === undefined) break;
            settledRecoveryClaims.delete(oldestClaimId);
          }
          acknowledgeRecoveryClaim(claimId, consumedSessionIds);
        } finally {
          processingRecoveryClaims.delete(claimId);
        }
      }
    })();
    recoveryDrain = operation;
    try {
      await operation;
    } finally {
      if (recoveryDrain === operation) recoveryDrain = null;
    }
  };

  const queueInterruptedSessionRecovery = (claimId: number, sessionIds: readonly string[]) => {
    const settledSessionIds = settledRecoveryClaims.get(claimId);
    if (settledSessionIds) {
      acknowledgeRecoveryClaim(claimId, settledSessionIds);
      return;
    }

    const current = pendingRecoveryClaims.get(claimId) ?? [];
    pendingRecoveryClaims.set(claimId, [...new Set([...current, ...sessionIds])]);
    if (deps.isInitialized()) {
      void drainRecoveryClaims(deps.getCurrentConnectionGeneration());
    }
  };

  const recoverInterruptedSessions = async (generation: number) => {
    await recoverSessionIds(generation);
    if (!deps.isCurrentConnectionGeneration(generation)) return;
    await drainRecoveryClaims(generation);
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
        getInitialRoute: deps.getInitialRoute,
        markInitialRouteConsumed: deps.markInitialRouteConsumed,
        getSessionCount: deps.getSessionCount,
        getOnlyPrimarySessionId: deps.getOnlyPrimarySessionId,
        hasSession: deps.hasSession,
        selectSession: deps.selectSession,
        startNewSession: deps.startNewSession,
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
    attempts: { begin(): number; finish(attempt: number): void }
  ) => {
    ensureConnectionInitializedWithDependencies({
      isInitialized: () => state.initialized,
      isInitializing: () => state.initializing,
      initConnection,
      beginInitializing: attempts.begin,
      finishInitializing: attempts.finish,
    });
  };

  return {
    recoverInterruptedSessions,
    queueInterruptedSessionRecovery,
    continueInterruptedSession,
    initConnection,
    ensureConnectionInitialized,
  };
}
