import type { Permission, PermissionGroupMember, QuestionRequest } from '../types';
import { normalizePermissionEvent } from './session-event-reducer';

const permissionGroupMemberCache = new WeakMap<Permission, PermissionGroupMember[]>();
export type PermissionReconciliation = {
  readonly changedPermissionIds: Set<string>;
};
export const activePermissionReconciliations = new Set<PermissionReconciliation>();

function normalizeInitialPermission(value: Record<string, unknown>): Permission | null {
  return normalizePermissionEvent(value);
}

function stableSerializePermissionValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializePermissionValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerializePermissionValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function getPermissionGroupMembers(permission: Permission): PermissionGroupMember[] {
  if (permission.groupMembers?.length) {
    return permission.groupMembers;
  }

  const cachedMembers = permissionGroupMemberCache.get(permission);
  const cachedMember = cachedMembers?.[0];
  if (
    cachedMember &&
    cachedMember.id === permission.id &&
    cachedMember.sessionID === permission.sessionID &&
    cachedMember.messageID === permission.messageID &&
    cachedMember.callID === permission.callID
  ) {
    return cachedMembers;
  }

  const members = [
    {
      id: permission.id,
      sessionID: permission.sessionID,
      messageID: permission.messageID,
      callID: permission.callID,
    },
  ];
  permissionGroupMemberCache.set(permission, members);
  return members;
}

export function getPermissionSignature(permission: Permission): string {
  const pattern = Array.isArray(permission.pattern)
    ? [...permission.pattern]
    : (permission.pattern ?? null);
  return stableSerializePermissionValue({
    type: permission.type,
    pattern,
    sessionID: permission.sessionID,
    title: permission.title,
    metadata: permission.metadata,
  });
}

export function groupPermissions(permissions: Permission[]): Permission[] {
  const grouped = new Map<string, Permission>();
  const sortedPermissions = [...permissions].toSorted((a, b) => a.time.created - b.time.created);

  for (const permission of sortedPermissions) {
    const signature = getPermissionSignature(permission);
    const existing = grouped.get(signature);
    if (!existing) {
      grouped.set(signature, {
        ...permission,
        duplicateIDs: [
          ...new Set(getPermissionGroupMembers(permission).map((member) => member.id)),
        ],
        groupMembers: getPermissionGroupMembers(permission),
      });
      continue;
    }

    const existingMembers = getPermissionGroupMembers(existing);
    const incomingMembers = getPermissionGroupMembers(permission);
    existing.groupMembers = [...existingMembers, ...incomingMembers];
    existing.duplicateIDs = [...new Set(existing.groupMembers.map((member) => member.id))];
  }

  return [...grouped.values()];
}

function normalizeInitialQuestion(value: Record<string, unknown>): QuestionRequest | null {
  const id = typeof value.id === 'string' ? value.id : null;
  const sessionID = typeof value.sessionID === 'string' ? value.sessionID : null;
  const questions = Array.isArray(value.questions) ? value.questions : null;
  if (!id || !sessionID || !questions) return null;

  const tool = value.tool;
  return {
    id,
    sessionID,
    questions: questions as QuestionRequest['questions'],
    tool:
      tool &&
      typeof tool === 'object' &&
      typeof (tool as { messageID?: unknown }).messageID === 'string' &&
      typeof (tool as { callID?: unknown }).callID === 'string'
        ? {
            messageID: (tool as { messageID: string }).messageID,
            callID: (tool as { callID: string }).callID,
          }
        : undefined,
  };
}

export function normalizeInitialPermissions(values: unknown): Permission[] {
  if (!Array.isArray(values)) return [];
  return groupPermissions(
    values
      .map((item) =>
        item && typeof item === 'object'
          ? normalizeInitialPermission(item as Record<string, unknown>)
          : null
      )
      .filter((item): item is Permission => item !== null)
  );
}

export function normalizeInitialQuestions(values: unknown): QuestionRequest[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) =>
      item && typeof item === 'object'
        ? normalizeInitialQuestion(item as Record<string, unknown>)
        : null
    )
    .filter((item): item is QuestionRequest => item !== null);
}

export function beginPermissionReconciliation() {
  const reconciliation: PermissionReconciliation = { changedPermissionIds: new Set() };
  activePermissionReconciliations.add(reconciliation);
  return reconciliation;
}

export function finishPermissionReconciliation(reconciliation: PermissionReconciliation) {
  activePermissionReconciliations.delete(reconciliation);
  reconciliation.changedPermissionIds.clear();
}

export function getPermissionReconciliationMetadataSize() {
  return {
    activeReconciliations: activePermissionReconciliations.size,
    retainedPermissionIds: [...activePermissionReconciliations].reduce(
      (total, reconciliation) => total + reconciliation.changedPermissionIds.size,
      0
    ),
  };
}

export function markPermissionMutations(permissionIds: string[]) {
  for (const reconciliation of activePermissionReconciliations) {
    for (const permissionId of permissionIds) {
      reconciliation.changedPermissionIds.add(permissionId);
    }
  }
}
