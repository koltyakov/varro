import type { Permission, QuestionRequest } from '../types';
import { getPermissionGroupMembers, getSessionTreeRootId } from './state';

export type ToolCallPermissionMatch = {
  permission: Permission;
  isPrimaryOwner: boolean;
};

export function getToolCallLookupKey(
  scopeId: string | null | undefined,
  messageId: string | null | undefined,
  callId: string | null | undefined
) {
  if (!scopeId || !messageId || !callId) return null;
  return `${scopeId}\u0000${messageId}\u0000${callId}`;
}

export function buildQuestionRequestLookup(
  questions: QuestionRequest[],
  sessionRootId: string | null | undefined
) {
  const result = new Map<string, QuestionRequest>();
  if (!sessionRootId) return result;

  for (const question of questions) {
    const questionRootId = getSessionTreeRootId(question.sessionID) || question.sessionID;
    if (questionRootId !== sessionRootId) continue;

    const key = getToolCallLookupKey(
      sessionRootId,
      question.tool?.messageID,
      question.tool?.callID
    );
    if (key && !result.has(key)) {
      result.set(key, question);
    }
  }

  return result;
}

export function buildPermissionRequestLookup(
  permissions: Permission[],
  sessionRootId: string | null | undefined
) {
  const result = new Map<string, ToolCallPermissionMatch>();
  if (!sessionRootId) return result;

  for (const permission of permissions) {
    const members = getPermissionGroupMembers(permission);
    for (const [index, member] of members.entries()) {
      const memberRootId = getSessionTreeRootId(member.sessionID) || member.sessionID;
      if (memberRootId !== sessionRootId) continue;

      const key = getToolCallLookupKey(sessionRootId, member.messageID, member.callID);
      if (key && !result.has(key)) {
        result.set(key, {
          permission,
          isPrimaryOwner: index === 0,
        });
      }
    }
  }

  return result;
}
