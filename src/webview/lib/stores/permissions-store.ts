import type { PermissionMode } from '../../../shared/protocol';
import {
  addPermission,
  draftPermissionMode,
  getPermissionGroupMembers,
  getPermissionModeForSession,
  getPermissionSignature,
  groupPermissions,
  removePermission,
  removePermissionModeForSession,
  removeQuestion,
  resetDraftPermissionMode,
  saveProjectPermissionMode,
  setDraftPermissionMode,
  setPermissionModeForSession,
  setQuestions,
  syncDraftPermissionForWorkspace,
  upsertQuestion,
} from '../state';

export const permissionsStore = {
  draftPermissionMode,
  setDraftPermissionMode,
  getPermissionModeForSession,
  setPermissionModeForSession,
  removePermissionModeForSession,
  resetDraftPermissionMode,
  syncDraftPermissionForWorkspace,
  saveProjectPermissionMode,
  getPermissionGroupMembers,
  getPermissionSignature,
  groupPermissions,
  setQuestions,
  upsertQuestion,
  removeQuestion,
  addPermission,
  removePermission,
};

export type PermissionsStore = typeof permissionsStore;
export type PermissionModeValue = PermissionMode;
