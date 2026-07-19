import { produce } from 'solid-js/store';
import type { PermissionMode } from '../../shared/protocol';
import { isPermissionMode } from '../../shared/protocol';
import {
  defaultPermissionMode,
  draftPermissionMode,
  getPermissionWorkspaceValue,
  setDefaultPermissionModeSignal,
  setDraftPermissionMode,
  setPermissionWorkspaceValue,
  setState,
  state,
} from './app-state';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { readStoredPermissionModes } from './state-stored-values';

export function getPermissionModeForSession(sessionId: string | null | undefined): PermissionMode {
  if (!sessionId) return draftPermissionMode();

  const sessionMode = state.sessionPermissionModes[sessionId];
  if (sessionMode) return sessionMode;

  const parentId = state.sessions.find((session) => session.id === sessionId)?.parentID;
  if (parentId) return getPermissionModeForSession(parentId);

  return 'default';
}

function resolveProjectDraftModeForCurrentWorkspace(fallbackMode = defaultPermissionMode()) {
  const permissionWorkspace = getPermissionWorkspaceValue();
  if (!permissionWorkspace) return fallbackMode;
  const modes = readStoredPermissionModes(STORAGE_KEYS.projectPermissionModes);
  const projectMode = modes[permissionWorkspace];
  return Object.hasOwn(modes, permissionWorkspace) && isPermissionMode(projectMode)
    ? projectMode
    : fallbackMode;
}

function hasPersistedDraftPermissionMode(permissionWorkspace: string | null): boolean {
  if (permissionWorkspace) {
    const modes = readStoredPermissionModes(STORAGE_KEYS.projectPermissionModes);
    if (Object.hasOwn(modes, permissionWorkspace)) return true;
  }
  return isPermissionMode(readStored<unknown>(STORAGE_KEYS.draftPermissionMode));
}

export function setPermissionModeForSession(
  sessionId: string | null | undefined,
  mode: PermissionMode
) {
  if (!sessionId) {
    setDraftPermissionMode(mode);
    saveProjectPermissionMode(mode);
    writeStored(STORAGE_KEYS.draftPermissionMode, mode);
    return;
  }

  if (state.sessionPermissionModes[sessionId] === mode) return;

  const nextModes = { ...state.sessionPermissionModes, [sessionId]: mode };

  setState('sessionPermissionModes', nextModes);
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function removePermissionModeForSession(sessionId: string) {
  if (!state.sessionPermissionModes[sessionId]) return;
  const nextModes = Object.fromEntries(
    Object.entries(state.sessionPermissionModes).filter(([id]) => id !== sessionId)
  );
  setState(
    'sessionPermissionModes',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function resetDraftPermissionMode() {
  setDraftPermissionMode(resolveProjectDraftModeForCurrentWorkspace());
  writeStored(STORAGE_KEYS.draftPermissionMode, null);
}

export function syncDraftPermissionForWorkspace(workspacePath: string | null) {
  const permissionWorkspace = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
  setPermissionWorkspaceValue(permissionWorkspace);
  setDraftPermissionMode(resolveProjectDraftModeForCurrentWorkspace());
}

export function saveProjectPermissionMode(mode: PermissionMode) {
  const permissionWorkspace = getPermissionWorkspaceValue();
  if (!permissionWorkspace) return;
  const modes = readStoredPermissionModes(STORAGE_KEYS.projectPermissionModes);
  modes[permissionWorkspace] = mode;
  writeStored(STORAGE_KEYS.projectPermissionModes, modes);
}

export function setDefaultPermissionModePreference(mode: PermissionMode) {
  setDefaultPermissionModeSignal(mode);
  if (!hasPersistedDraftPermissionMode(getPermissionWorkspaceValue())) {
    setDraftPermissionMode(mode);
  }
}
