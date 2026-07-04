import { getChildRunsByParentId } from '../../lib/state';
import { isAssistantMessage, sumAssistantTokens } from '../../lib/message-metrics';
import type { AssistantMessage, Message, Part } from '../../types';
import type { AssistantDialogSummaryInfo } from './MessageRows';

export function getAssistantDialogSummaryMap(
  messages: Array<{ info: Message; parts: Part[] }>,
  targetMessageIds?: ReadonlySet<string>,
  options?: { suppressTrailingSummary?: boolean }
) {
  const result = new Map<string, AssistantDialogSummaryInfo>();
  let childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>> | null =
    null;
  let currentMessages: AssistantMessage[] = [];
  let currentPrimaryMessageIds: string[] = [];
  let currentSubagentHandoffCount = 0;
  let currentUserRequestCreated: number | null = null;

  const flush = (args?: { trailing?: boolean }) => {
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

    const aggregateMessages = collectAssistantDialogMessages(
      currentMessages,
      childRunsByParentId,
      new Set(currentMessages.map((message) => message.sessionID))
    );
    const completedMessages = aggregateMessages.filter((message) => !!message.time.completed);
    const end = Math.max(...completedMessages.map((message) => message.time.completed || 0));
    const tokens = sumAssistantTokens(aggregateMessages);
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
      flush();
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

function collectAssistantDialogMessages(
  messages: AssistantMessage[],
  childRunsByParentId: Map<string, Array<{ info: AssistantMessage; parts: Part[] }>>,
  parentSessionIds: ReadonlySet<string>
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
