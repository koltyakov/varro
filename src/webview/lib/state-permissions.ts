import { storePath } from '@solidjs/signals';

import { reconcile } from 'solid-js';
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
import { nativeFormDrafts } from './native-form-drafts';

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
  for (const question of state.questions) {
    if (nextQuestionIds.has(question.id) || resolvedQuestionIds.has(question.id)) continue;
    const wasTransitioned = transitionedQuestionIds.has(question.id);
    nativeFormDrafts.remove(question.id);
    rememberResolvedQuestion(question.id, question.sessionID);
    transitionedQuestionIds.add(question.id);
    if (!wasTransitioned) markQuestionResponsePending(question.id, question.sessionID);
  }
  setState((draft) => {
    const previous = new Map(draft.questions.map((question) => [question.id, question]));
    draft.questions = nextQuestions.map((question) => {
      const retained = previous.get(question.id);
      if (!retained) return question;
      reconcile(question)(retained);
      return retained;
    });
  });
}

export function upsertQuestion(question: QuestionRequest) {
  const hasCurrentQuestion = state.questions.some((item) => item.id === question.id);
  const reusesResolvedID = resolvedQuestionIds.has(question.id);
  if (!questionGenerations.has(question.id)) questionGenerations.set(question.id, 1);
  else if (reusesResolvedID) {
    questionGenerations.set(question.id, questionGenerations.get(question.id)! + 1);
  }
  // An initial/replayed ask can restore a checkpoint before questions hydrate.
  // Only an explicit ask reusing a resolved ID starts a fresh draft.
  if (reusesResolvedID) nativeFormDrafts.remove(question.id);
  if (!hasCurrentQuestion || reusesResolvedID) {
    resolvedQuestionIds.delete(question.id);
    transitionedQuestionIds.delete(question.id);
    resolvedQuestionSessions.delete(question.id);
    clearQuestionResponsePendingRequest(question.id);
  }
  setState(
    storePath('questions', (questions) => {
      const idx = questions.findIndex((item) => item.id === question.id);
      if (idx !== -1) questions[idx] = question;
      else questions.push(question);

      return questions;
    })
  );
}

export function removeQuestion(requestID: string) {
  const sessionID = state.questions.find((question) => question.id === requestID)?.sessionID;
  rememberResolvedQuestion(requestID, sessionID);
  removeQuestionEntry(requestID);
}

function removeQuestionEntry(requestID: string) {
  nativeFormDrafts.remove(requestID);
  setState(
    storePath('questions', (questions) => {
      const idx = questions.findIndex((item) => item.id === requestID);
      if (idx !== -1) questions.splice(idx, 1);

      return questions;
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
  if (sessionID && !wasTransitioned) markQuestionResponsePending(requestID, sessionID);
  rememberResolvedQuestion(requestID, sessionID);
  transitionedQuestionIds.add(requestID);
  removeQuestionEntry(requestID);
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
  setState(storePath('questionResponsePendingSessionIds', []));
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
  setState((draft) => {
    const current = draft.questionResponsePendingSessionIds;
    if (
      nextSessionIDs.length === current.length &&
      nextSessionIDs.every((sessionID, index) => current[index] === sessionID)
    )
      return;
    draft.questionResponsePendingSessionIds = nextSessionIDs;
  });
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
  // Replayed persisted details are not a newer server ask. Let the pending snapshot
  // replace their incomplete approval data, or remove an already-resolved request.
  if (!permission.recoveredIncomplete) markPermissionMutations([permission.id]);
  setState(
    storePath('permissions', (perms) => {
      if (
        perms.find(
          (p) =>
            p.id === permission.id ||
            p.duplicateIDs?.includes(permission.id) ||
            p.groupMembers?.some((member) => member.id === permission.id)
        )
      ) {
        return perms;
      }

      const signature = getPermissionSignature(permission);
      const existingIndex = perms.findIndex((p) => getPermissionSignature(p) === signature);

      if (existingIndex === -1) {
        perms.push({
          ...permission,
          duplicateIDs: [...new Set(getPermissionGroupMembers(permission).map((m) => m.id))],
          groupMembers: getPermissionGroupMembers(permission),
        });
        return perms;
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

      return perms;
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
    storePath('permissions', (permissions) => {
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

      return permissions;
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
  if (matchedPermission) prepareForPermissionRemoval(permissionId, removeGroup);
  setState(
    storePath('permissions', (perms) => {
      const idx = perms.findIndex(
        (p) =>
          p.id === permissionId ||
          p.duplicateIDs?.includes(permissionId) ||
          p.groupMembers?.some((member) => member.id === permissionId)
      );
      if (idx === -1) return perms;
      if (removeGroup) {
        perms.splice(idx, 1);
        return perms;
      }

      const permission = perms[idx]!;
      const groupMembers = getPermissionGroupMembers(permission).filter(
        (member) => member.id !== permissionId
      );
      if (groupMembers.length === 0) {
        perms.splice(idx, 1);
        return perms;
      }

      const nextLeader = groupMembers[0]!;
      permission.id = nextLeader.id;
      permission.sessionID = nextLeader.sessionID;
      permission.messageID = nextLeader.messageID;
      permission.callID = nextLeader.callID;
      permission.groupMembers = groupMembers.length > 1 ? groupMembers : undefined;
      permission.duplicateIDs =
        groupMembers.length > 1 ? groupMembers.map((member) => member.id) : undefined;

      return perms;
    })
  );
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

    setState(storePath('permissions', groupPermissions(nextPermissions)));
  } finally {
    finishPermissionReconciliation(reconciliation);
  }
}
