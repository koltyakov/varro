import type { Message, Part } from '../types';

type SessionEntry = { info: Message; parts: Part[] };

export const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file containing:
1. Build, lint, and test commands - especially the command to run a single test.
2. Code style guidelines including imports, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding agents (such as yourself) that operate in this repository. Make it about 20 lines long.
If there's already an AGENTS.md, improve it. If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), include them.`;

export async function implementPlanWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getBuildAgent(): string | null;
    setError(message: string): void;
    clearSkippedPlanSession(sessionId: string): void;
    applySelectedAgent(agent: string, sessionId: string): void;
    sendMessage(prompt: string): Promise<void>;
  },
  prompt: string,
  sessionId: string | null
) {
  if (!sessionId || sessionId !== deps.getActiveSessionId()) return;

  const buildAgent = deps.getBuildAgent();
  if (!buildAgent) {
    deps.setError('Build agent is unavailable');
    return;
  }

  deps.clearSkippedPlanSession(sessionId);
  deps.applySelectedAgent(buildAgent, sessionId);
  await deps.sendMessage(prompt);
}

export async function openPlanWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    setError(message: string | null): void;
    openPlan(markdown: string): Promise<unknown>;
  },
  markdown: string,
  sessionId: string | null
) {
  if (!sessionId || sessionId !== deps.getActiveSessionId()) return;

  const content = markdown.trim();
  if (!content) {
    deps.setError('Plan content is empty');
    return;
  }

  try {
    deps.setError(null);
    await deps.openPlan(content);
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to open plan');
  }
}

export async function initSessionWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    createSession(): Promise<string | null>;
    getMessageCount(): number;
    setError(message: string): void;
    sendMessage(prompt: string): Promise<void>;
  },
  prompt = INIT_PROMPT
) {
  let sessionId = deps.getActiveSessionId();
  if (!sessionId) {
    const createdId = await deps.createSession();
    if (!createdId) return;
    sessionId = createdId;
  }

  if (sessionId === deps.getActiveSessionId() && deps.getMessageCount() > 0) {
    deps.setError('Init is only available for blank sessions');
    return;
  }

  await deps.sendMessage(prompt);
}

export async function runSlashCommandWithDependencies(
  deps: {
    hasCommand(name: string): boolean;
    getActiveSessionId(): string | null;
    createSession(): Promise<string | null>;
    startLoading(): void;
    runSessionCommand(
      sessionId: string,
      input: { command: string; arguments: string }
    ): Promise<SessionEntry>;
    shouldApplyToActiveSession(sessionId: string): boolean;
    upsertMessageInfo(info: Message): void;
    upsertPart(part: Part): void;
    syncTodosFromMessages(): void;
    requestMessageListScrollToBottom(): void;
    syncSession(sessionId: string): Promise<void>;
    recheckSessionStatus(sessionId: string): Promise<void>;
    stopLoading(): void;
    setError(message: string): void;
  },
  name: string,
  args: string
) {
  if (!deps.hasCommand(name)) {
    deps.setError(`Unknown command: /${name}`);
    return false;
  }

  let sessionId = deps.getActiveSessionId();
  if (!sessionId) {
    const createdId = await deps.createSession();
    if (!createdId) return false;
    sessionId = createdId;
  }

  try {
    deps.startLoading();
    const result = await deps.runSessionCommand(sessionId, {
      command: name,
      arguments: args,
    });
    if (deps.shouldApplyToActiveSession(sessionId)) {
      deps.upsertMessageInfo(result.info);
      for (const part of result.parts) {
        deps.upsertPart(part);
      }
      deps.syncTodosFromMessages();
      deps.requestMessageListScrollToBottom();
    }
    await Promise.all([deps.syncSession(sessionId), deps.recheckSessionStatus(sessionId)]).catch(
      () => {}
    );
    deps.stopLoading();
    return true;
  } catch (err) {
    deps.stopLoading();
    deps.setError(err instanceof Error ? err.message : `Failed to run /${name}`);
    return false;
  }
}
