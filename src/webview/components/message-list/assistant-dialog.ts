import {
  isAbortedAssistantError,
  isPermissionRejectedToolError,
  isQuestionSkippedToolError,
} from '../../../shared/error-classification';
import { getChildRunsByParentId } from '../../lib/state';
import {
  isAssistantMessage,
  isContinuationAssistantFinish,
  sumAssistantTokens,
} from '../../lib/message-metrics';
import { resolveTaskSessionId } from '../../lib/task-session';
import type { TaskSessionInfo, TaskSessionLookup } from '../../lib/task-session';
import type { AssistantMessage, MessageEntry } from '../../types';
import { pauseCompletedAt } from '../../../shared/session-pauses';
import type { SessionPauseBoundary } from '../../../shared/session-pauses';
import { hasUserMessageContent, parseUserMessageContent } from '../message/UserMessageContent';

export type AssistantDialogSummaryInfo = {
  durationMs: number;
  completedAt?: number;
  promptMessageId?: string;
  inputTokens: number;
  outputTokens: number;
  tokensPerSecond?: number;
  cost?: number;
  agentCount: number;
  interrupted?: boolean;
  permissionRejected?: boolean;
  questionSkipped?: boolean;
  collectingStats?: boolean;
};

type AssistantDialogOptions = {
  pauses?: readonly SessionPauseBoundary[];
  sessions?: readonly TaskSessionInfo[];
  primarySessionId?: string;
  suppressTrailingSummary?: boolean;
  collectLeadingSummaryStats?: boolean;
  /**
   * Summarizes only `messages[start..end)`, which must start at a flushing prompt or at 0.
   * Without `nextUserRequestCreated` the range ends the transcript.
   */
  range?: { start: number; end: number; nextUserRequestCreated?: number };
  /** First occurrences of the messages before `range.start`. */
  entriesById?: ReadonlyMap<string, MessageEntry>;
  childRunsByParentId?: Map<string, Array<MessageEntry<AssistantMessage>>>;
};

/** Whether a transcript entry ends the previous dialog in `getAssistantDialogSummaryMap`. */
export function flushesAssistantDialog(entry: MessageEntry, primarySessionId?: string) {
  if (isAssistantMessage(entry.info)) return false;
  if (primarySessionId && entry.info.sessionID !== primarySessionId) return false;
  if (entry.info.role !== 'user') return true;
  const parsed = parseUserMessageContent(entry.parts);
  return !(parsed.automaticActions.length > 0 && !hasUserMessageContent(parsed));
}

export function getAssistantDialogSummaryMap(
  messages: MessageEntry[],
  targetMessageIds?: ReadonlySet<string>,
  options?: AssistantDialogOptions
) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  const pauseTimes = new Map(options?.pauses?.map((pause) => [pause.messageId, pause.pausedAt]));
  const rangeStart = options?.range?.start ?? 0;
  const rangeEnd = options?.range?.end ?? messages.length;
  const entriesById = new Map<string, MessageEntry>(options?.entriesById);
  for (let index = options?.entriesById ? rangeStart : 0; index < messages.length; index += 1) {
    const entry = messages[index]!;
    // Preserve Array.find's first-match behavior if malformed history contains duplicate IDs.
    if (!entriesById.has(entry.info.id)) entriesById.set(entry.info.id, entry);
  }
  const sessions = options?.sessions || [];
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const sessionsByParentId = new Map<string, TaskSessionInfo[]>();
  for (const session of sessions) {
    const parentId = session.parentID;
    if (!parentId) continue;
    const children = sessionsByParentId.get(parentId);
    if (children) children.push(session);
    else sessionsByParentId.set(parentId, [session]);
  }
  const taskSessionLookup: TaskSessionLookup = {
    messagesById: entriesById,
    sessionsById,
    sessionsByParentId,
  };
  let childRunsByParentId = options?.childRunsByParentId ?? null;
  let currentMessages: AssistantMessage[] = [];
  let currentPrimaryMessageIds: string[] = [];
  let currentSubagentHandoffCount = 0;
  let currentUserRequestCreated: number | null = null;
  let currentUserRequestId: string | null = null;
  const resetCurrentDialog = () => {
    currentMessages = [];
    currentPrimaryMessageIds = [];
    currentSubagentHandoffCount = 0;
    currentUserRequestCreated = null;
    currentUserRequestId = null;
  };

  const flush = (args?: {
    nextUserRequestCreated?: number;
    trailing?: boolean;
    pausedAt?: number;
  }) => {
    if (currentMessages.length === 0) {
      resetCurrentDialog();
      return;
    }

    const lastMessage = currentMessages[currentMessages.length - 1];
    const interrupted = isAbortedAssistantError(lastMessage?.error);
    if (
      !lastMessage ||
      (!lastMessage.time.completed && !interrupted && args?.pausedAt === undefined)
    ) {
      resetCurrentDialog();
      return;
    }

    const lastEntry = entriesById.get(lastMessage.id);
    const permissionRejected =
      lastEntry?.parts.some(
        (part) => part.type === 'tool' && isPermissionRejectedToolError(part.state)
      ) ?? false;
    const questionSkipped =
      lastEntry?.parts.some(
        (part) => part.type === 'tool' && isQuestionSkippedToolError(part.state)
      ) ?? false;
    if (
      isContinuationAssistantFinish(lastMessage.finish) &&
      !interrupted &&
      args?.pausedAt === undefined &&
      !permissionRejected &&
      !questionSkipped
    ) {
      resetCurrentDialog();
      return;
    }

    if (args?.trailing && options?.suppressTrailingSummary) {
      resetCurrentDialog();
      return;
    }

    if (
      args?.pausedAt === undefined &&
      lastEntry?.parts.some((part) => part.type === 'tool' && part.state.status === 'running')
    ) {
      resetCurrentDialog();
      return;
    }

    if (targetMessageIds && !targetMessageIds.has(lastMessage.id)) {
      resetCurrentDialog();
      return;
    }

    childRunsByParentId ||= getChildRunsByParentId(messages);

    const dialogStartedAt = currentUserRequestCreated ?? currentMessages[0]!.time.created;
    const aggregateMessages = collectAssistantDialogMessages(
      currentMessages,
      childRunsByParentId,
      new Set(currentMessages.map((message) => message.sessionID)),
      dialogStartedAt,
      args?.nextUserRequestCreated
    );
    const completedMessages = aggregateMessages.filter((message) => !!message.time.completed);
    const completedEnd =
      completedMessages.length > 0
        ? Math.max(...completedMessages.map((message) => message.time.completed || 0))
        : lastMessage.time.created;
    const end =
      args?.pausedAt === undefined
        ? completedEnd
        : pauseCompletedAt(
            dialogStartedAt,
            lastMessage.time.completed ? completedEnd : undefined,
            args.pausedAt
          );
    const tokens = sumAssistantDialogTokens(
      aggregateMessages,
      currentMessages,
      currentPrimaryMessageIds,
      messages,
      entriesById,
      sessions,
      sessionsById,
      sessionsByParentId,
      taskSessionLookup,
      dialogStartedAt,
      args?.nextUserRequestCreated
    );
    const childRunCount = countAssistantDialogChildRuns(
      currentPrimaryMessageIds,
      childRunsByParentId
    );
    const agentCount = Math.max(childRunCount, currentSubagentHandoffCount);
    result.set(lastMessage.id, {
      durationMs: Math.max(
        0,
        end - (currentUserRequestCreated ?? currentMessages[0]!.time.created)
      ),
      completedAt: end,
      promptMessageId: currentUserRequestId ?? undefined,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      tokensPerSecond: getAssistantDialogTokensPerSecond(currentMessages, entriesById),
      cost: tokens.cost,
      agentCount,
      interrupted: interrupted ? true : undefined,
      permissionRejected: permissionRejected ? true : undefined,
      questionSkipped: questionSkipped ? true : undefined,
      collectingStats: options?.collectLeadingSummaryStats && currentUserRequestCreated === null,
    });

    resetCurrentDialog();
  };

  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const entry = messages[index]!;
    if (!isAssistantMessage(entry.info)) {
      if (options?.primarySessionId && entry.info.sessionID !== options.primarySessionId) {
        continue;
      }
      if (entry.info.role === 'user') {
        const parsed = parseUserMessageContent(entry.parts);
        // Recovery and background-work notices continue the existing request.
        if (parsed.automaticActions.length > 0 && !hasUserMessageContent(parsed)) continue;
      }
      flush({
        nextUserRequestCreated: entry.info.role === 'user' ? entry.info.time.created : undefined,
      });
      if (entry.info.role === 'user') {
        currentUserRequestCreated = entry.info.time.created;
        currentUserRequestId = entry.info.id;
      }
      continue;
    }

    // SAFETY: The surrounding shape or discriminator check establishes the AssistantMessage contract used below.
    const assistant = entry.info as AssistantMessage;
    if (options?.primarySessionId && assistant.sessionID !== options.primarySessionId) continue;
    if (assistant.mode === 'subagent') continue;

    currentMessages.push(assistant);
    currentPrimaryMessageIds.push(assistant.id);
    for (const part of entry.parts) {
      if (part.type === 'agent' && part.name.trim()) {
        currentSubagentHandoffCount++;
        continue;
      }

      if (part.type === 'subtask') {
        currentSubagentHandoffCount++;
      }
    }
    const pausedAt = pauseTimes.get(assistant.id);
    if (pausedAt !== undefined) flush({ pausedAt, nextUserRequestCreated: pausedAt });
  }

  const nextUserRequestCreated = options?.range?.nextUserRequestCreated;
  flush(nextUserRequestCreated === undefined ? { trailing: true } : { nextUserRequestCreated });
  return result;
}

/**
 * Estimate generation speed only for primary responses with matching token counts and
 * explicit timing for every generated text/reasoning part. Missing or invalid timing
 * returns no metric; request/response duration includes initial latency and must never
 * be used as a fallback. Tool execution, permission waits, and child-session work are
 * not generation time for these tokens.
 *
 * These checks validate part intervals, not complete token-level measurement. Part or
 * chunk timestamps do not prove when each token was generated, whether events were
 * missed, or whether the interval contains other waits. The result remains an estimate.
 * V2 text snapshots omit timing. The adapter restores matching durable text/reasoning
 * boundaries, including on reload. These are server-observed block intervals, not
 * exact provider token timings; missing boundaries and tool-call responses stay excluded.
 */
function getAssistantDialogTokensPerSecond(
  messages: readonly AssistantMessage[],
  entriesById: ReadonlyMap<string, MessageEntry>
): number | undefined {
  let tokens = 0;
  let durationMs = 0;
  for (const message of messages) {
    if (!message.time.completed || message.error) continue;
    const parts = entriesById.get(message.id)?.parts;
    // Tool-call argument tokens have no matching generation timestamps.
    if (!parts || parts.some((part) => part.type === 'tool')) continue;
    const generatedParts = parts.filter(
      (part) =>
        part.type === 'reasoning' || (part.type === 'text' && !part.synthetic && !part.ignored)
    );
    if (generatedParts.length === 0) continue;
    const intervals = generatedParts.flatMap((part) => {
      if (part.type !== 'text' && part.type !== 'reasoning') return [];
      const time = part.time;
      return time &&
        time.end !== undefined &&
        Number.isFinite(time.start) &&
        Number.isFinite(time.end) &&
        time.end > time.start
        ? [{ start: time.start, end: time.end }]
        : [];
    });
    const count = message.tokens.output + message.tokens.reasoning;
    if (!Number.isFinite(count) || count <= 0) continue;
    const start = Math.min(...intervals.map((interval) => interval.start));
    const end = Math.max(...intervals.map((interval) => interval.end));
    const hasGenerationTiming =
      intervals.length === generatedParts.length &&
      (message.tokens.reasoning === 0 ||
        generatedParts.some((part) => part.type === 'reasoning')) &&
      (message.tokens.output === 0 || generatedParts.some((part) => part.type === 'text')) &&
      start >= message.time.created &&
      end <= message.time.completed;
    // Response duration includes latency and is not a substitute for generation timing.
    if (!hasGenerationTiming) continue;
    const elapsed = end - start;
    if (!Number.isFinite(elapsed) || elapsed <= 0) continue;
    tokens += count;
    durationMs += elapsed;
  }
  return durationMs > 0 ? (tokens * 1000) / durationMs : undefined;
}

function sumAssistantDialogTokens(
  aggregateMessages: AssistantMessage[],
  primaryMessages: AssistantMessage[],
  primaryMessageIds: string[],
  allMessages: MessageEntry[],
  entriesById: ReadonlyMap<string, MessageEntry>,
  sessions: readonly TaskSessionInfo[],
  sessionsById: ReadonlyMap<string, TaskSessionInfo>,
  sessionsByParentId: ReadonlyMap<string, readonly TaskSessionInfo[]>,
  taskSessionLookup: TaskSessionLookup,
  dialogStartedAt: number,
  nextUserRequestCreated?: number
) {
  const primarySessionIds = new Set(primaryMessages.map((message) => message.sessionID));
  const childSessionIds = new Set(
    aggregateMessages
      .filter((message) => !primarySessionIds.has(message.sessionID))
      .map((message) => message.sessionID)
  );

  const directSessionParents = new Set([...primarySessionIds, ...primaryMessageIds]);
  for (const parentId of directSessionParents) {
    for (const session of sessionsByParentId.get(parentId) || []) {
      if (session.time.created < dialogStartedAt) continue;
      if (nextUserRequestCreated !== undefined && session.time.created >= nextUserRequestCreated) {
        continue;
      }
      childSessionIds.add(session.id);
    }
  }

  for (const messageId of primaryMessageIds) {
    const entry = entriesById.get(messageId);
    if (!entry) continue;
    for (const part of entry.parts) {
      if (part.type !== 'tool') continue;
      const sessionId = resolveTaskSessionId(
        part,
        allMessages,
        sessions,
        nextUserRequestCreated,
        taskSessionLookup
      );
      if (sessionId) childSessionIds.add(sessionId);
    }
  }

  const pending = [...childSessionIds];
  while (pending.length > 0) {
    const sessionId = pending.shift();
    if (!sessionId) continue;
    for (const child of sessionsByParentId.get(sessionId) || []) {
      if (childSessionIds.has(child.id)) continue;
      if (nextUserRequestCreated !== undefined && child.time.created >= nextUserRequestCreated) {
        continue;
      }
      childSessionIds.add(child.id);
      pending.push(child.id);
    }
  }

  const snapshotSessions: TaskSessionInfo[] = [];
  for (const sessionId of childSessionIds) {
    const session = sessionsById.get(sessionId);
    if (session?.tokens) snapshotSessions.push(session);
  }
  const snapshotSessionIds = new Set(snapshotSessions.map((session) => session.id));
  const tokens = sumAssistantTokens(
    aggregateMessages.filter((message) => !snapshotSessionIds.has(message.sessionID))
  );
  for (const session of snapshotSessions) {
    if (!session.tokens) continue;
    tokens.input += session.tokens.input || 0;
    tokens.output += session.tokens.output || 0;
    tokens.reasoning += session.tokens.reasoning || 0;
    tokens.cacheRead += session.tokens.cache?.read || 0;
    tokens.cacheWrite += session.tokens.cache?.write || 0;
  }
  const costsBySession = new Map<string, number>();
  for (const message of aggregateMessages) {
    if (!Number.isFinite(message.cost) || message.cost <= 0) continue;
    costsBySession.set(
      message.sessionID,
      (costsBySession.get(message.sessionID) ?? 0) + message.cost
    );
  }
  for (const sessionId of childSessionIds) {
    const cost = sessionsById.get(sessionId)?.cost;
    if (cost === undefined || !Number.isFinite(cost) || cost <= 0) continue;
    costsBySession.set(sessionId, Math.max(costsBySession.get(sessionId) ?? 0, cost));
  }
  const cost = [...costsBySession.values()].reduce((sum, value) => sum + value, 0);
  return {
    ...tokens,
    cost: cost > 0 ? cost : undefined,
    input: tokens.input + tokens.cacheWrite,
    output: tokens.output + tokens.reasoning,
  };
}

function collectAssistantDialogMessages(
  messages: AssistantMessage[],
  childRunsByParentId: Map<string, Array<MessageEntry<AssistantMessage>>>,
  parentSessionIds: ReadonlySet<string>,
  dialogStartedAt: number,
  nextUserRequestCreated?: number
) {
  const result: AssistantMessage[] = [];
  const visited = new Set<string>();
  const pending = [...messages];

  while (pending.length > 0) {
    const message = pending.shift();
    if (!message || visited.has(message.id)) continue;
    visited.add(message.id);
    result.push(message);

    for (const child of childRunsByParentId.get(message.id) || []) {
      if (
        nextUserRequestCreated !== undefined &&
        child.info.time.created >= nextUserRequestCreated
      ) {
        continue;
      }
      pending.push(child.info);
    }

    if (!parentSessionIds.has(message.sessionID)) continue;
    for (const child of childRunsByParentId.get(message.sessionID) || []) {
      if (child.info.time.created < dialogStartedAt) continue;
      if (
        nextUserRequestCreated !== undefined &&
        child.info.time.created >= nextUserRequestCreated
      ) {
        continue;
      }
      pending.push(child.info);
    }
  }

  return result;
}

function countAssistantDialogChildRuns(
  rootMessageIds: string[],
  childRunsByParentId: Map<string, Array<MessageEntry<AssistantMessage>>>
) {
  let count = 0;
  const visited = new Set<string>();
  const pending = [...rootMessageIds];

  while (pending.length > 0) {
    const messageId = pending.shift();
    if (!messageId) continue;

    for (const child of childRunsByParentId.get(messageId) || []) {
      if (visited.has(child.info.id)) continue;
      visited.add(child.info.id);
      count++;
      pending.push(child.info.id);
    }
  }

  return count;
}
