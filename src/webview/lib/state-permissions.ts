import { batch } from 'solid-js';
import { produce, reconcile } from 'solid-js/store';
import type { Permission, QuestionRequest } from '../types';
import { setState, state } from './app-state';
import type { PermissionReconciliation } from './permission-grouping';
import {
  activePermissionReconciliations,
  finishPermissionReconciliation,
  getPermissionGroupMembers,
  getPermissionSignature,
  groupPermissions,
  markPermissionMutations,
} from './permission-grouping';
import { captureSessionStateTime } from './session-state-clock';
import { prepareForPermissionRemoval, shouldRemovePermissionGroup } from './message-list-layout';

const resolvedQuestionIds = new Set<string>();
const transitionedQuestionIds = new Set<string>();
const resolvedQuestionSessions = new Map<string, string>();
const questionGenerations = new Map<string, number>();
const questionResponsePendingRequests = new Map<string, { sessionID: string; updatedAt: number }>();

export function setQuestions(questions: QuestionRequest[]) {
  const nextQuestions = questions.filter((question) => !resolvedQuestionIds.has(question.id));
  for (const question of nextQuestions) {
    if (!questionGenerations.has(question.id)) questionGenerations.set(question.id, 1);
  }
  const nextQuestionIds = new Set(nextQuestions.map((question) => question.id));
  batch(() => {
    for (const question of state.questions) {
      if (nextQuestionIds.has(question.id) || resolvedQuestionIds.has(question.id)) continue;
      const wasTransitioned = transitionedQuestionIds.has(question.id);
      rememberResolvedQuestion(question.id, question.sessionID);
      transitionedQuestionIds.add(question.id);
      if (!wasTransitioned) markQuestionResponsePending(question.id, question.sessionID);
    }
    setState('questions', reconcile(nextQuestions, { key: 'id' }));
  });
}

export function upsertQuestion(question: QuestionRequest) {
  const hasCurrentQuestion = state.questions.some((item) => item.id === question.id);
  const reusesResolvedID = resolvedQuestionIds.has(question.id);
  if (!questionGenerations.has(question.id)) questionGenerations.set(question.id, 1);
  else if (reusesResolvedID) {
    questionGenerations.set(question.id, questionGenerations.get(question.id)! + 1);
  }
  batch(() => {
    if (!hasCurrentQuestion || reusesResolvedID) {
      resolvedQuestionIds.delete(question.id);
      transitionedQuestionIds.delete(question.id);
      resolvedQuestionSessions.delete(question.id);
      clearQuestionResponsePendingRequest(question.id);
    }
    setState(
      'questions',
      produce((questions) => {
        const idx = questions.findIndex((item) => item.id === question.id);
        if (idx !== -1) questions[idx] = question;
        else questions.push(question);
      })
    );
  });
}

export function removeQuestion(requestID: string) {
  const sessionID = state.questions.find((question) => question.id === requestID)?.sessionID;
  rememberResolvedQuestion(requestID, sessionID);
  removeQuestionEntry(requestID);
}

function removeQuestionEntry(requestID: string) {
  setState(
    'questions',
    produce((questions) => {
      const idx = questions.findIndex((item) => item.id === requestID);
      if (idx !== -1) questions.splice(idx, 1);
    })
  );
}

export function removeResolvedQuestion(requestID: string, expectedGeneration?: number) {
  if (
    expectedGeneration !== undefined &&
    questionGenerations.get(requestID) !== expectedGeneration
  ) {
    return false;
  }
  const wasTransitioned = transitionedQuestionIds.has(requestID);
  const sessionID =
    state.questions.find((question) => question.id === requestID)?.sessionID ??
    resolvedQuestionSessions.get(requestID);
  batch(() => {
    if (sessionID && !wasTransitioned) markQuestionResponsePending(requestID, sessionID);
    rememberResolvedQuestion(requestID, sessionID);
    transitionedQuestionIds.add(requestID);
    removeQuestionEntry(requestID);
  });
  return true;
}

export function beginQuestionResponse(requestID: string) {
  const sessionID =
    state.questions.find((question) => question.id === requestID)?.sessionID ??
    resolvedQuestionSessions.get(requestID);
  if (!sessionID) return undefined;
  const generation = questionGenerations.get(requestID) ?? 1;
  questionGenerations.set(requestID, generation);
  if (transitionedQuestionIds.has(requestID)) return generation;
  transitionedQuestionIds.add(requestID);
  markQuestionResponsePending(requestID, sessionID);
  return generation;
}

export function cancelQuestionResponse(requestID: string, expectedGeneration?: number) {
  if (
    (expectedGeneration !== undefined &&
      questionGenerations.get(requestID) !== expectedGeneration) ||
    resolvedQuestionIds.has(requestID)
  ) {
    return false;
  }
  transitionedQuestionIds.delete(requestID);
  clearQuestionResponsePendingRequest(requestID);
  return true;
}

export function resetQuestionResolutionState() {
  resolvedQuestionIds.clear();
  transitionedQuestionIds.clear();
  resolvedQuestionSessions.clear();
  questionGenerations.clear();
  questionResponsePendingRequests.clear();
  setState('questionResponsePendingSessionIds', []);
}

function rememberResolvedQuestion(requestID: string, sessionID?: string) {
  resolvedQuestionIds.delete(requestID);
  resolvedQuestionIds.add(requestID);
  if (sessionID) resolvedQuestionSessions.set(requestID, sessionID);
}

function markQuestionResponsePending(requestID: string, sessionID: string) {
  questionResponsePendingRequests.set(requestID, {
    sessionID,
    updatedAt: captureSessionStateTime(),
  });
  syncQuestionResponsePendingSessions();
}

function clearQuestionResponsePendingRequest(requestID: string) {
  if (!questionResponsePendingRequests.delete(requestID)) return;
  syncQuestionResponsePendingSessions();
}

function syncQuestionResponsePendingSessions() {
  const nextSessionIDs = [
    ...new Set([...questionResponsePendingRequests.values()].map((entry) => entry.sessionID)),
  ];
  if (
    nextSessionIDs.length === state.questionResponsePendingSessionIds.length &&
    nextSessionIDs.every(
      (sessionID, index) => state.questionResponsePendingSessionIds[index] === sessionID
    )
  ) {
    return;
  }
  setState('questionResponsePendingSessionIds', nextSessionIDs);
}

export function clearQuestionResponsePending(sessionID: string, authoritativeAt?: number) {
  let changed = false;
  for (const [requestID, pending] of questionResponsePendingRequests) {
    if (pending.sessionID !== sessionID) continue;
    if (authoritativeAt !== undefined && pending.updatedAt > authoritativeAt) continue;
    questionResponsePendingRequests.delete(requestID);
    changed = true;
  }
  if (changed) syncQuestionResponsePendingSessions();
}

export function addPermission(permission: Permission) {
  markPermissionMutations([permission.id]);
  setState(
    'permissions',
    produce((perms) => {
      if (
        perms.find(
          (p) =>
            p.id === permission.id ||
            p.duplicateIDs?.includes(permission.id) ||
            p.groupMembers?.some((member) => member.id === permission.id)
        )
      ) {
        return;
      }

      const signature = getPermissionSignature(permission);
      const existingIndex = perms.findIndex((p) => getPermissionSignature(p) === signature);

      if (existingIndex === -1) {
        perms.push({
          ...permission,
          duplicateIDs: [...new Set(getPermissionGroupMembers(permission).map((m) => m.id))],
          groupMembers: getPermissionGroupMembers(permission),
        });
        return;
      }

      const existing = perms[existingIndex]!;
      const incomingMembers = getPermissionGroupMembers(permission);
      const merged = [
        ...(existing.groupMembers || getPermissionGroupMembers(existing)),
        ...incomingMembers,
      ];
      const mergedIds = [...new Set(merged.map((m) => m.id))];

      if (permission.time.created < existing.time.created) {
        perms[existingIndex] = {
          ...permission,
          groupMembers: merged,
          duplicateIDs: mergedIds,
        };
      } else {
        existing.groupMembers = merged;
        existing.duplicateIDs = mergedIds;
      }
    })
  );
}

export function setPermissionAutoApprovePresentation(
  permissionId: string,
  reason: string | undefined,
  actionSummary?: string
) {
  const matchedPermission = state.permissions.find(
    (item) =>
      item.id === permissionId ||
      item.duplicateIDs?.includes(permissionId) ||
      item.groupMembers?.some((member) => member.id === permissionId)
  );
  if (!matchedPermission) return;

  markPermissionMutations(getPermissionGroupMembers(matchedPermission).map((member) => member.id));
  setState(
    'permissions',
    produce((permissions) => {
      const permission = permissions.find(
        (item) =>
          item.id === permissionId ||
          item.duplicateIDs?.includes(permissionId) ||
          item.groupMembers?.some((member) => member.id === permissionId)
      );
      if (permission) {
        permission.autoApproveReason = reason;
        if (actionSummary) permission.actionSummary = actionSummary;
      }
    })
  );
}

export function removePermission(permissionId: string, options?: { removeGroup?: boolean }) {
  const matchedPermission = state.permissions.find(
    (item) =>
      item.id === permissionId ||
      item.duplicateIDs?.includes(permissionId) ||
      item.groupMembers?.some((member) => member.id === permissionId)
  );
  const removeGroup = shouldRemovePermissionGroup(permissionId, options?.removeGroup === true);
  markPermissionMutations(
    removeGroup && matchedPermission
      ? getPermissionGroupMembers(matchedPermission).map((member) => member.id)
      : [permissionId]
  );
  batch(() => {
    if (matchedPermission) prepareForPermissionRemoval(permissionId, removeGroup);
    setState(
      'permissions',
      produce((perms) => {
        const idx = perms.findIndex(
          (p) =>
            p.id === permissionId ||
            p.duplicateIDs?.includes(permissionId) ||
            p.groupMembers?.some((member) => member.id === permissionId)
        );
        if (idx === -1) return;
        if (removeGroup) {
          perms.splice(idx, 1);
          return;
        }

        const permission = perms[idx]!;
        const groupMembers = getPermissionGroupMembers(permission).filter(
          (member) => member.id !== permissionId
        );
        if (groupMembers.length === 0) {
          perms.splice(idx, 1);
          return;
        }

        const nextLeader = groupMembers[0]!;
        permission.id = nextLeader.id;
        permission.sessionID = nextLeader.sessionID;
        permission.messageID = nextLeader.messageID;
        permission.callID = nextLeader.callID;
        permission.groupMembers = groupMembers.length > 1 ? groupMembers : undefined;
        permission.duplicateIDs =
          groupMembers.length > 1 ? groupMembers.map((member) => member.id) : undefined;
      })
    );
  });
}

export function reconcilePermissions(
  permissions: Permission[],
  reconciliation: PermissionReconciliation
) {
  if (!activePermissionReconciliations.has(reconciliation)) return;

  try {
    const changedIds = reconciliation.changedPermissionIds;
    const nextPermissions = permissions.filter((permission) => !changedIds.has(permission.id));

    for (const current of state.permissions) {
      for (const member of getPermissionGroupMembers(current)) {
        if (!changedIds.has(member.id)) continue;
        nextPermissions.push({
          ...current,
          id: member.id,
          sessionID: member.sessionID,
          messageID: member.messageID,
          callID: member.callID,
          duplicateIDs: undefined,
          groupMembers: undefined,
        });
      }
    }

    setState('permissions', groupPermissions(nextPermissions));
  } finally {
    finishPermissionReconciliation(reconciliation);
  }
}
