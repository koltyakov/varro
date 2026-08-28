import type { SelectedModel } from './app-state-types';
import { setShowSessionPicker, showSessionPicker, state } from './app-state';
import { getSelectedModelForSession, setSelectedModel } from './state-model-selection';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { readStoredSelectedModel, readStoredString } from './state-stored-values';
import { isNumber, isString, type UnknownRecord, isObject } from './runtime-values';

export type LastOpenedView =
  | { type: 'new-session'; timestamp: number }
  | { type: 'sessions-list'; timestamp: number }
  | { type: 'session'; sessionId: string; directory?: string; timestamp: number };

type LastOpenedViewInput =
  | { type: 'new-session' }
  | { type: 'sessions-list' }
  | { type: 'session'; sessionId: string; directory?: string };

export function setPersistentShowSessionPicker(value: boolean) {
  setShowSessionPicker(value);
  if (value) {
    restoreSelectedModelForComposer(null);
    persistLastOpenedView({ type: 'sessions-list' });
    return;
  }
  restoreSelectedModelForComposer(state.activeSessionId);
  persistLastOpenedView(
    state.activeSessionId
      ? {
          type: 'session',
          sessionId: state.activeSessionId,
          directory: state.sessions.find((session) => session.id === state.activeSessionId)
            ?.directory,
        }
      : { type: 'new-session' }
  );
}

export function getEffectiveComposerSessionId(): string | null {
  return showSessionPicker() ? null : state.activeSessionId;
}

export function restoreSelectedModelForComposer(sessionId: string | null) {
  const model =
    (sessionId ? getSelectedModelForSession(sessionId) : null) ?? getPersistedSelectedModel();
  setSelectedModel(model, { persistGlobal: false });
}

export function persistActiveSessionId(id: string | null) {
  writeStored(STORAGE_KEYS.lastActiveSessionId, id);
}

function normalizeLastOpenedView<T>(value: T): LastOpenedView | null {
  if (!value || !isObject(value)) return null;
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const record = value as UnknownRecord;
  const timestamp = isNumber(record.timestamp) ? record.timestamp : null;
  if (timestamp === null || !Number.isFinite(timestamp)) return null;

  if (record.type === 'new-session') return { type: 'new-session', timestamp };
  if (record.type === 'sessions-list') return { type: 'sessions-list', timestamp };
  if (record.type === 'session' && isString(record.sessionId)) {
    return isString(record.directory)
      ? { type: 'session', sessionId: record.sessionId, directory: record.directory, timestamp }
      : { type: 'session', sessionId: record.sessionId, timestamp };
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
