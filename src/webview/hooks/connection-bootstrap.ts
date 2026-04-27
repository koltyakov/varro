import type { Message, Part, SessionStatus } from '../types';

type SessionEntry = { info: Message; parts: Part[] };

type ResolvedModel = { providerID: string; modelID: string; variant?: string };

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
      body.variant = args.model.variant;
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
    hasSession(sessionId: string): boolean;
    selectSession(sessionId: string): Promise<void>;
    recoverInterruptedSessions(generation: number): Promise<void>;
    setInitialized(value: boolean): void;
    setError(message: string | null): void;
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
      const lastId = deps.getPersistedActiveSessionId();
      if (lastId && deps.hasSession(lastId)) {
        await deps.selectSession(lastId);
        if (!generationRef.isCurrent(generation)) return;
      }
    }

    await deps.recoverInterruptedSessions(generation);
    if (!generationRef.isCurrent(generation)) return;

    deps.setInitialized(true);
  } catch {
    deps.setInitialized(false);
    deps.setError('Failed to connect to OpenCode server');
  }
}
