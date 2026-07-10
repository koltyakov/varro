import { getChildRunsByParentId } from '../../lib/state';
import { isAssistantMessage, sumAssistantTokens } from '../../lib/message-metrics';
import { resolveTaskSessionId } from '../../lib/task-session';
import type { TaskSessionInfo } from '../../lib/task-session';
import type { AssistantMessage, Message, Part } from '../../types';
import type { AssistantDialogSummaryInfo } from './MessageRows';

type AssistantDialogOptions = {
  sessions?: readonly TaskSessionInfo[];
  suppressTrailingSummary?: boolean;
};

export function getAssistantDialogSummaryMap(
  messages: Array<{ info: Message; parts: Part[] }>,
  targetMessageIds?: ReadonlySet<string>,
  options?: AssistantDialogOptions
) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  let childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>> | null =
    null;
  let currentMessages: AssistantMessage[] = [];
  let currentPrimaryMessageIds: string[] = [];
  let currentSubagentHandoffCount = 0;
  let currentUserRequestCreated: number | null = null;

  const flush = (args?: { nextUserRequestCreated?: number; trailing?: boolean }) => {
    if (currentMessages.length === 0) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    const lastMessage = currentMessages[currentMessages.length - 1];
    if (!lastMessage?.time.completed) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    if (args?.trailing && options?.suppressTrailingSummary) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    if (targetMessageIds && !targetMessageIds.has(lastMessage.id)) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
      return;
    }

    const lastEntry = messages.find((entry) => entry.info.id === lastMessage.id);
    if (lastEntry?.parts.some((part) => part.type === 'tool' && part.state.status === 'running')) {
      currentMessages = [];
      currentPrimaryMessageIds = [];
      currentSubagentHandoffCount = 0;
      currentUserRequestCreated = null;
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
    const end = Math.max(...completedMessages.map((message) => message.time.completed || 0));
    const tokens = sumAssistantDialogTokens(
      aggregateMessages,
      currentMessages,
      currentPrimaryMessageIds,
      messages,
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
    });

    currentMessages = [];
    currentPrimaryMessageIds = [];
    currentSubagentHandoffCount = 0;
    currentUserRequestCreated = null;
  };

  for (const entry of messages) {
    if (!isAssistantMessage(entry.info)) {
      flush({
        nextUserRequestCreated: entry.info.role === 'user' ? entry.info.time.created : undefined,
      });
      if (entry.info.role === 'user') {
        currentUserRequestCreated = entry.info.time.created;
      }
      continue;
    }

    const assistant = entry.info as AssistantMessage;
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
  allMessages: Array<{ info: Message; parts: Part[] }>,
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
    const entry = allMessages.find((candidate) => candidate.info.id === messageId);
    if (!entry) continue;
    for (const part of entry.parts) {
      if (part.type !== 'tool') continue;
      const sessionId = resolveTaskSessionId(part, allMessages, sessions);
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
  childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>,
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
  childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>
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
