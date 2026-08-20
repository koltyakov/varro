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
import type { TaskSessionInfo } from '../../lib/task-session';
import type { AssistantMessage, MessageEntry } from '../../types';

export type AssistantDialogSummaryInfo = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  agentCount: number;
  interrupted?: boolean;
  permissionRejected?: boolean;
  questionSkipped?: boolean;
  collectingStats?: boolean;
};

type AssistantDialogOptions = {
  sessions?: readonly TaskSessionInfo[];
  primarySessionId?: string;
  suppressTrailingSummary?: boolean;
  collectLeadingSummaryStats?: boolean;
};

export function getAssistantDialogSummaryMap(
  messages: MessageEntry[],
  targetMessageIds?: ReadonlySet<string>,
  options?: AssistantDialogOptions
) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  const entriesById = new Map<string, MessageEntry>();
  for (const entry of messages) {
    // Preserve Array.find's first-match behavior if malformed history contains duplicate IDs.
    if (!entriesById.has(entry.info.id)) entriesById.set(entry.info.id, entry);
  }
  let childRunsByParentId: Map<string, Array<MessageEntry<AssistantMessage>>> | null = null;
  let currentMessages: AssistantMessage[] = [];
  let currentPrimaryMessageIds: string[] = [];
  let currentSubagentHandoffCount = 0;
  let currentUserRequestCreated: number | null = null;
  const resetCurrentDialog = () => {
    currentMessages = [];
    currentPrimaryMessageIds = [];
    currentSubagentHandoffCount = 0;
    currentUserRequestCreated = null;
  };

  const flush = (args?: { nextUserRequestCreated?: number; trailing?: boolean }) => {
    if (currentMessages.length === 0) {
      resetCurrentDialog();
      return;
    }

    const lastMessage = currentMessages[currentMessages.length - 1];
    const interrupted = isAbortedAssistantError(lastMessage?.error);
    if (!lastMessage || (!lastMessage.time.completed && !interrupted)) {
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

    if (targetMessageIds && !targetMessageIds.has(lastMessage.id)) {
      resetCurrentDialog();
      return;
    }

    if (lastEntry?.parts.some((part) => part.type === 'tool' && part.state.status === 'running')) {
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
    const end =
      completedMessages.length > 0
        ? Math.max(...completedMessages.map((message) => message.time.completed || 0))
        : lastMessage.time.created;
    const tokens = sumAssistantDialogTokens(
      aggregateMessages,
      currentMessages,
      currentPrimaryMessageIds,
      messages,
      entriesById,
      options?.sessions || [],
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
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      agentCount,
      interrupted: interrupted ? true : undefined,
      permissionRejected: permissionRejected ? true : undefined,
      questionSkipped: questionSkipped ? true : undefined,
      collectingStats: options?.collectLeadingSummaryStats && currentUserRequestCreated === null,
    });

    resetCurrentDialog();
  };

  for (const entry of messages) {
    if (!isAssistantMessage(entry.info)) {
      if (options?.primarySessionId && entry.info.sessionID !== options.primarySessionId) {
        continue;
      }
      flush({
        nextUserRequestCreated: entry.info.role === 'user' ? entry.info.time.created : undefined,
      });
      if (entry.info.role === 'user') {
        currentUserRequestCreated = entry.info.time.created;
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
  }

  flush({ trailing: true });
  return result;
}

function sumAssistantDialogTokens(
  aggregateMessages: AssistantMessage[],
  primaryMessages: AssistantMessage[],
  primaryMessageIds: string[],
  allMessages: MessageEntry[],
  entriesById: ReadonlyMap<string, MessageEntry>,
  sessions: readonly TaskSessionInfo[],
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
  for (const session of sessions) {
    if (!session.parentID || !directSessionParents.has(session.parentID)) continue;
    if (session.time.created < dialogStartedAt) continue;
    if (nextUserRequestCreated !== undefined && session.time.created >= nextUserRequestCreated) {
      continue;
    }
    childSessionIds.add(session.id);
  }

  for (const messageId of primaryMessageIds) {
    const entry = entriesById.get(messageId);
    if (!entry) continue;
    for (const part of entry.parts) {
      if (part.type !== 'tool') continue;
      const sessionId = resolveTaskSessionId(part, allMessages, sessions, nextUserRequestCreated);
      if (sessionId) childSessionIds.add(sessionId);
    }
  }

  const sessionsByParentId = new Map<string, TaskSessionInfo[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = sessionsByParentId.get(session.parentID);
    if (children) children.push(session);
    else sessionsByParentId.set(session.parentID, [session]);
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

  const snapshotSessionIds = new Set(
    sessions
      .filter((session) => childSessionIds.has(session.id) && session.tokens)
      .map((session) => session.id)
  );
  const tokens = sumAssistantTokens(
    aggregateMessages.filter((message) => !snapshotSessionIds.has(message.sessionID))
  );
  for (const session of sessions) {
    if (!snapshotSessionIds.has(session.id) || !session.tokens) continue;
    tokens.input += session.tokens.input || 0;
    tokens.output += session.tokens.output || 0;
  }
  return tokens;
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
