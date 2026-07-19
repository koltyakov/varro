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

export function setQuestions(questions: QuestionRequest[]) {
  setState('questions', reconcile(questions, { key: 'id' }));
}

export function upsertQuestion(question: QuestionRequest) {
  setState(
    'questions',
    produce((questions) => {
      const idx = questions.findIndex((item) => item.id === question.id);
      if (idx !== -1) questions[idx] = question;
      else questions.push(question);
    })
  );
}

export function removeQuestion(requestID: string) {
  setState(
    'questions',
    produce((questions) => {
      const idx = questions.findIndex((item) => item.id === requestID);
      if (idx !== -1) questions.splice(idx, 1);
    })
  );
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

export function removePermission(permissionId: string, options?: { removeGroup?: boolean }) {
  const matchedPermission = state.permissions.find(
    (item) =>
      item.id === permissionId ||
      item.duplicateIDs?.includes(permissionId) ||
      item.groupMembers?.some((member) => member.id === permissionId)
  );
  markPermissionMutations(
    options?.removeGroup && matchedPermission
      ? getPermissionGroupMembers(matchedPermission).map((member) => member.id)
      : [permissionId]
  );
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
      if (options?.removeGroup) {
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
