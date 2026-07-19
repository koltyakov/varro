import type { SelectedModel } from './app-state-types';
import { setShowSessionPicker, state } from './app-state';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { readStoredSelectedModel, readStoredString } from './state-stored-values';

export type LastOpenedView =
  | { type: 'new-session'; timestamp: number }
  | { type: 'sessions-list'; timestamp: number }
  | { type: 'session'; sessionId: string; timestamp: number };

type LastOpenedViewInput =
  | { type: 'new-session' }
  | { type: 'sessions-list' }
  | { type: 'session'; sessionId: string };

export function setPersistentShowSessionPicker(value: boolean) {
  setShowSessionPicker(value);
  if (value) {
    persistLastOpenedView({ type: 'sessions-list' });
    return;
  }
  persistLastOpenedView(
    state.activeSessionId
      ? { type: 'session', sessionId: state.activeSessionId }
      : { type: 'new-session' }
  );
}

export function persistActiveSessionId(id: string | null) {
  writeStored(STORAGE_KEYS.lastActiveSessionId, id);
}

function normalizeLastOpenedView(value: unknown): LastOpenedView | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : null;
  if (timestamp === null || !Number.isFinite(timestamp)) return null;

  if (record.type === 'new-session') return { type: 'new-session', timestamp };
  if (record.type === 'sessions-list') return { type: 'sessions-list', timestamp };
  if (record.type === 'session' && typeof record.sessionId === 'string') {
    return { type: 'session', sessionId: record.sessionId, timestamp };
  }
  return null;
}

export function persistLastOpenedView(view: LastOpenedViewInput, now = Date.now()) {
  writeStored(STORAGE_KEYS.lastOpenedView, { ...view, timestamp: now });
}

export function getPersistedLastOpenedView(): LastOpenedView | null {
  return normalizeLastOpenedView(readStored<unknown>(STORAGE_KEYS.lastOpenedView));
}

export function getPersistedSelectedModel(): SelectedModel | null {
  return readStoredSelectedModel(STORAGE_KEYS.selectedModel);
}

export function getPersistedSelectedAgent(): string | null {
  return readStoredString(STORAGE_KEYS.selectedAgent);
}

export function getPersistedActiveSessionId(): string | null {
  return readStoredString(STORAGE_KEYS.lastActiveSessionId);
}
