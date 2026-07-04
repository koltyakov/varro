import {
  getPermissionGroupMembers,
  getSessionTreeIds,
  getSessionTreeRootId,
} from '../../lib/state';
import { shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { Message, Part, Permission, QuestionRequest } from '../../types';

function getLinkedToolCallKey(
  sessionId: string,
  messageId: string | null | undefined,
  callId: string | null | undefined
) {
  if (!messageId || !callId) return null;

  return `${sessionId}\u0000${messageId}\u0000${callId}`;
}

export function getLinkedToolCallKeys(messages: Array<{ info: Message; parts: Part[] }>) {
  const keys = new Set<string>();

  for (const entry of messages) {
    const messageId = entry.info.id;
    const sessionId = entry.info.sessionID;
    for (const part of entry.parts) {
      if (
        part.type !== 'tool' ||
        part.messageID !== messageId ||
        !shouldShowAssistantPartInline(part)
      ) {
        continue;
      }
      const key = getLinkedToolCallKey(sessionId, messageId, part.callID);
      if (key) keys.add(key);
    }
  }

  return keys;
}

function hasLinkedToolCall(
  linkedToolCalls: ReadonlySet<string>,
  sessionId: string,
  messageId: string | null | undefined,
  callId: string | null | undefined
) {
  const key = getLinkedToolCallKey(sessionId, messageId, callId);
  if (!key) return false;

  return linkedToolCalls.has(key);
}

export function getStandalonePermissionPrompts(
  messages: Array<{ info: Message; parts: Part[] }>,
  permissions: Permission[],
  activeSessionId: string | null,
  linkedToolCalls = getLinkedToolCallKeys(messages)
) {
  if (!activeSessionId) return [];

  const rootId = getSessionTreeRootId(activeSessionId) || activeSessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));

  return permissions.filter(
    (permission) =>
      sessionIds.has(permission.sessionID) &&
      !getPermissionGroupMembers(permission).some((member) =>
        hasLinkedToolCall(linkedToolCalls, member.sessionID, member.messageID, member.callID)
      )
  );
}

export function getStandaloneQuestionPrompts(
  messages: Array<{ info: Message; parts: Part[] }>,
  questions: QuestionRequest[],
  activeSessionId: string | null,
  linkedToolCalls = getLinkedToolCallKeys(messages)
) {
  if (!activeSessionId) return [];

  const rootId = getSessionTreeRootId(activeSessionId) || activeSessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));

  return questions.filter(
    (question) =>
      sessionIds.has(question.sessionID) &&
      !hasLinkedToolCall(
        linkedToolCalls,
        question.sessionID,
        question.tool?.messageID,
        question.tool?.callID
      )
  );
}
