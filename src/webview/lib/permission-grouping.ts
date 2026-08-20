import type { Permission, PermissionGroupMember, QuestionRequest } from '../types';
import { normalizePermissionEvent } from './session-event-reducer';
import {
  asRecord,
  isBoolean,
  isNumber,
  isString,
  type UnknownRecord,
  isObject,
} from './runtime-values';

const permissionGroupMemberCache = new WeakMap<Permission, PermissionGroupMember[]>();
export type PermissionReconciliation = {
  readonly changedPermissionIds: Set<string>;
};
export const activePermissionReconciliations = new Set<PermissionReconciliation>();

function normalizeInitialPermission(value: UnknownRecord): Permission | null {
  return normalizePermissionEvent(value);
}

function stableSerializePermissionValue<T>(value: T): string {
  if (value === null || value === undefined) return String(value);
  if (isString(value)) return JSON.stringify(value);
  if (isNumber(value) || isBoolean(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializePermissionValue(item)).join(',')}]`;
  }
  if (isObject(value)) {
    // Code-unit ordering, not collation: `localeCompare` varies with locale and
    // ICU build, and ties for strings that differ only by ignorable characters,
    // so equal permissions could serialize to different grouping signatures.
    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    const entries = Object.entries(value as UnknownRecord).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
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

function normalizeInitialQuestion(value: UnknownRecord): QuestionRequest | null {
  const id = isString(value.id) ? value.id : null;
  const sessionID = isString(value.sessionID) ? value.sessionID : null;
  const questions = Array.isArray(value.questions) ? value.questions : null;
  if (!id || !sessionID || !questions) return null;

  const tool = value.tool;
  return {
    id,
    sessionID,
    // SAFETY: The surrounding shape or discriminator check establishes the QuestionRequest contract used below.
    questions: questions as QuestionRequest['questions'],
    tool:
      isString(asRecord(tool)?.messageID) && isString(asRecord(tool)?.callID)
        ? {
            messageID: String(asRecord(tool)?.messageID),
            callID: String(asRecord(tool)?.callID),
          }
        : undefined,
  };
}

export function normalizeInitialPermissions<T>(values: T): Permission[] {
  if (!Array.isArray(values)) return [];
  return groupPermissions(
    values
      .map((item) =>
        // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
        item && isObject(item) ? normalizeInitialPermission(item as UnknownRecord) : null
      )
      .filter((item): item is Permission => item !== null)
  );
}

export function normalizeInitialQuestions<T>(values: T): QuestionRequest[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) =>
      // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
      item && isObject(item) ? normalizeInitialQuestion(item as UnknownRecord) : null
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
