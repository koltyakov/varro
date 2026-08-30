import { produce, reconcile } from 'solid-js/store';
import type { PermissionMode } from '../../shared/protocol';
import { isPermissionMode } from '../../shared/protocol';
import { postMessage } from './bridge';
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
import {
  readInitialWebviewState,
  readStoredPermissionModes,
  readWebviewInstanceContext,
} from './state-stored-values';

type PendingSessionPermissionMode = {
  generation: number;
  mode: PermissionMode;
};

const pendingSessionPermissionModes = new Map<string, PendingSessionPermissionMode>();
let nextPendingSessionPermissionModeGeneration = 0;
let confirmedSessionPermissionModes = {
  ...readInitialWebviewState().sessionPermissionModes,
};

export function getPermissionModeForSession(sessionId: string | null | undefined): PermissionMode {
  if (!sessionId) return draftPermissionMode();

  const visited = new Set<string>();
  let currentSessionId: string | undefined = sessionId;
  while (currentSessionId && !visited.has(currentSessionId)) {
    visited.add(currentSessionId);
    const sessionMode = state.sessionPermissionModes[currentSessionId];
    if (sessionMode) return sessionMode;
    currentSessionId = state.sessions.find((session) => session.id === currentSessionId)?.parentID;
  }

  return 'default';
}

export function isPermissionModeRecoveryPending(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const recovering = new Set(state.permissionModeRecoverySessionIds);
  const visited = new Set<string>();
  let currentSessionId: string | undefined = sessionId;
  while (currentSessionId && !visited.has(currentSessionId)) {
    if (recovering.has(currentSessionId)) return true;
    visited.add(currentSessionId);
    currentSessionId = state.sessions.find((session) => session.id === currentSessionId)?.parentID;
  }
  return false;
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
  if (!pendingSessionPermissionModes.has(sessionId)) {
    confirmedSessionPermissionModes[sessionId] = mode;
  }

  const nextModes = { ...state.sessionPermissionModes, [sessionId]: mode };

  setState('sessionPermissionModes', nextModes);
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
}

export function removePermissionModeForSession(sessionId: string) {
  if (!state.sessionPermissionModes[sessionId]) return;
  if (!pendingSessionPermissionModes.has(sessionId)) {
    delete confirmedSessionPermissionModes[sessionId];
  }
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
  postMessage({ type: 'permission-mode/update', payload: { sessionId, mode: null } });
}

export function applySessionPermissionModesSnapshot(
  modes: Record<string, PermissionMode>,
  recoveringSessionIds: string[] = []
) {
  confirmedSessionPermissionModes = { ...modes };
  const effectiveModes = { ...modes };
  for (const [sessionId, pending] of pendingSessionPermissionModes) {
    effectiveModes[sessionId] = pending.mode;
  }
  setState('sessionPermissionModes', reconcile(effectiveModes));
  setState('permissionModeRecoverySessionIds', recoveringSessionIds);
  writeStored(STORAGE_KEYS.sessionPermissionModes, effectiveModes);
}

export function setPendingSessionPermissionMode(
  sessionId: string,
  mode: PermissionMode | null,
  generation?: number
): number | null {
  if (mode !== null) {
    const nextGeneration = ++nextPendingSessionPermissionModeGeneration;
    pendingSessionPermissionModes.set(sessionId, { generation: nextGeneration, mode });
    return nextGeneration;
  }
  const pending = pendingSessionPermissionModes.get(sessionId);
  if (generation !== undefined && pending?.generation !== generation) return null;
  pendingSessionPermissionModes.delete(sessionId);
  const nextModes = { ...state.sessionPermissionModes };
  const confirmedMode = confirmedSessionPermissionModes[sessionId];
  if (confirmedMode) nextModes[sessionId] = confirmedMode;
  else delete nextModes[sessionId];
  setState('sessionPermissionModes', reconcile(nextModes));
  writeStored(STORAGE_KEYS.sessionPermissionModes, nextModes);
  return pending?.generation ?? null;
}

export function isSessionPermissionModePending(sessionId: string): boolean {
  const visited = new Set<string>();
  let currentSessionId: string | undefined = sessionId;
  while (currentSessionId && !visited.has(currentSessionId)) {
    if (pendingSessionPermissionModes.has(currentSessionId)) return true;
    visited.add(currentSessionId);
    currentSessionId = state.sessions.find((session) => session.id === currentSessionId)?.parentID;
  }
  return false;
}

export function syncSessionPermissionModesToHost() {
  if (readWebviewInstanceContext()?.surface !== 'sidebar') return;
  const hostModes = readInitialWebviewState().sessionPermissionModes ?? {};
  const modes = Object.fromEntries(
    Object.entries(readStoredPermissionModes(STORAGE_KEYS.sessionPermissionModes)).filter(
      ([sessionId]) => !Object.hasOwn(hostModes, sessionId)
    )
  );
  if (Object.keys(modes).length > 0) {
    postMessage({ type: 'permission-modes/migrate', payload: { modes } });
  }
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
