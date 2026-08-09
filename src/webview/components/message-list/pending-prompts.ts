import {
  getPermissionGroupMembers,
  getSessionTreeIds,
  getSessionTreeRootId,
  state,
} from '../../lib/state';
import { shouldShowAssistantPartInline } from '../../lib/part-utils';
import { getToolCallLookupKey } from '../../lib/tool-call-matching';
import type { MessageEntry, Permission, QuestionRequest } from '../../types';

type PendingPermissionSequenceEntry = {
  memberIds: string[];
  completed: boolean;
};

export type PendingPermissionSequence = {
  scopeId: string | null;
  entries: PendingPermissionSequenceEntry[];
  activePermission: Permission | null;
  position: number;
  total: number;
};

function emptyPermissionSequence(scopeId: string | null): PendingPermissionSequence {
  return { scopeId, entries: [], activePermission: null, position: 0, total: 0 };
}

function getPermissionMemberIds(permission: Permission) {
  return getPermissionGroupMembers(permission).map((member) => member.id);
}

function hasOverlappingMemberIds(left: readonly string[], right: readonly string[]) {
  const rightIds = new Set(right);
  return left.some((id) => rightIds.has(id));
}

function isPermissionSessionInScope(permissionSessionId: string, sessionIds: ReadonlySet<string>) {
  // Permission events can precede child-session metadata; keep that fallback actionable.
  return (
    sessionIds.has(permissionSessionId) ||
    !state.sessions.some((session) => session.id === permissionSessionId)
  );
}

/**
 * Keeps visible progress stable while the reactive permission list shrinks.
 * The first unresolved entry advances the sequence; later entries that vanish
 * before their turn were resolved elsewhere and are removed from the count.
 */
export function reconcilePendingPermissionSequence(
  previous: PendingPermissionSequence | undefined,
  permissions: Permission[],
  activeSessionId: string | null
): PendingPermissionSequence {
  if (!activeSessionId) return emptyPermissionSequence(null);

  const scopeId = getSessionTreeRootId(activeSessionId) || activeSessionId;
  const sessionIds = new Set(getSessionTreeIds(scopeId));
  const currentPermissions = permissions
    .filter((permission) => isPermissionSessionInScope(permission.sessionID, sessionIds))
    .toSorted((left, right) => left.time.created - right.time.created);
  if (currentPermissions.length === 0) return emptyPermissionSequence(scopeId);

  const currentGroups = currentPermissions.map((permission) => ({
    permission,
    memberIds: getPermissionMemberIds(permission),
  }));
  if (!previous || previous.scopeId !== scopeId || previous.entries.length === 0) {
    const entries = currentGroups.map(({ memberIds }) => ({ memberIds, completed: false }));
    return {
      scopeId,
      entries,
      activePermission: currentPermissions[0] || null,
      position: 1,
      total: entries.length,
    };
  }

  const unmatchedCurrentIndexes = new Set(currentGroups.map((_, index) => index));
  const previousActiveIndex = previous.entries.findIndex((entry) => !entry.completed);
  const entries: PendingPermissionSequenceEntry[] = [];

  for (const [index, entry] of previous.entries.entries()) {
    if (entry.completed) {
      entries.push(entry);
      continue;
    }

    const currentIndex = [...unmatchedCurrentIndexes].find((candidateIndex) =>
      hasOverlappingMemberIds(entry.memberIds, currentGroups[candidateIndex]!.memberIds)
    );
    if (currentIndex !== undefined) {
      unmatchedCurrentIndexes.delete(currentIndex);
      entries.push({
        memberIds: [...new Set([...entry.memberIds, ...currentGroups[currentIndex]!.memberIds])],
        completed: false,
      });
    } else if (index === previousActiveIndex) {
      entries.push({ ...entry, completed: true });
    }
  }

  for (const currentIndex of unmatchedCurrentIndexes) {
    entries.push({ memberIds: currentGroups[currentIndex]!.memberIds, completed: false });
  }

  const activeEntryIndex = entries.findIndex((entry) => !entry.completed);
  const activeEntry = entries[activeEntryIndex];
  const activePermission = activeEntry
    ? (currentGroups.find(({ memberIds }) =>
        hasOverlappingMemberIds(activeEntry.memberIds, memberIds)
      )?.permission ?? null)
    : null;
  if (!activePermission) return emptyPermissionSequence(scopeId);

  return {
    scopeId,
    entries,
    activePermission,
    position: activeEntryIndex + 1,
    total: entries.length,
  };
}

export function getLinkedToolCallKeys(messages: MessageEntry[]) {
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
      const key = getToolCallLookupKey(sessionId, messageId, part.callID);
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
  const key = getToolCallLookupKey(sessionId, messageId, callId);
  if (!key) return false;

  return linkedToolCalls.has(key);
}

export function getStandalonePermissionPrompts(
  messages: MessageEntry[],
  permissions: Permission[],
  activeSessionId: string | null,
  linkedToolCalls = getLinkedToolCallKeys(messages)
) {
  if (!activeSessionId) return [];

  const rootId = getSessionTreeRootId(activeSessionId) || activeSessionId;
  const sessionIds = new Set(getSessionTreeIds(rootId));

  return permissions.filter((permission) => {
    if (!isPermissionSessionInScope(permission.sessionID, sessionIds)) return false;
    const owner = getPermissionGroupMembers(permission)[0];
    return (
      !owner || !hasLinkedToolCall(linkedToolCalls, owner.sessionID, owner.messageID, owner.callID)
    );
  });
}

export function getStandaloneQuestionPrompts(
  messages: MessageEntry[],
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
