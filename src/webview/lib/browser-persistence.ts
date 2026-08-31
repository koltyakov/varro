import type { Persistence } from '../../shared/persistence';
import { postMessage } from './bridge';
import { logWarn } from './log';
import type { UnknownRecord } from '../../shared/type-utils';
import { asRecord, isObject, isString } from './runtime-values';

export class BrowserPersistence implements Persistence {
  private warnedRemoveFailure = false;
  private warnedSetFailure = false;
  private warnedVsCodeStateRemoveFailure = false;
  private warnedVsCodeStateWriteFailure = false;
  private readonly storage: Storage | undefined;

  constructor(storage?: Storage) {
    this.storage = storage ?? acquireLocalStorage();
  }

  get<T>(key: string): T | undefined {
    if (!shouldUseLocalStorage(key)) return readVsCodeWebviewStateValue<T>(key);

    try {
      const raw = this.storage?.getItem(key);
      if (readLocalStorageFailureMarker(key) === raw) {
        return readVsCodeWebviewStateValue<T>(key);
      }
      if (raw) {
        // SAFETY: Persistence callers own the key's value contract and validate domain values after reading.
        return JSON.parse(raw) as T;
      }
    } catch {
      // Fall back to this webview's state when shared storage is unavailable or malformed.
    }
    return readVsCodeWebviewStateValue<T>(key);
  }

  set<T>(key: string, value: T) {
    if (!shouldUseLocalStorage(key)) {
      const vscodeStateFailure = writeVsCodeWebviewStateValue(key, value);
      if (vscodeStateFailure && !this.warnedVsCodeStateWriteFailure) {
        this.warnedVsCodeStateWriteFailure = true;
        logWarn(`browser-persistence:vscode-state-write:${key}`, vscodeStateFailure.error);
      }
      return;
    }

    try {
      if (!this.storage) throw new Error('localStorage is unavailable');
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new Error('Value could not be serialized for localStorage');
      }
      if (this.storage.getItem(key) !== serialized) this.storage.setItem(key, serialized);
      const cleanupFailure = clearSharedVsCodeWebviewStateValue(key);
      if (cleanupFailure && !this.warnedVsCodeStateRemoveFailure) {
        this.warnedVsCodeStateRemoveFailure = true;
        logWarn(`browser-persistence:vscode-state-remove:${key}`, cleanupFailure.error);
      }
    } catch (err) {
      const vscodeStateFailure = writeVsCodeWebviewStateFallback(
        key,
        value,
        this.readLocalStorageValue(key)
      );
      if (vscodeStateFailure && !this.warnedVsCodeStateWriteFailure) {
        this.warnedVsCodeStateWriteFailure = true;
        logWarn(`browser-persistence:vscode-state-write:${key}`, vscodeStateFailure.error);
      }
      if (!this.warnedSetFailure) {
        this.warnedSetFailure = true;
        postMessage({
          type: 'log',
          payload: {
            msg: `browser-persistence:set:${key}`,
            error: err instanceof Error ? err.message : String(err),
            level: 'warn',
          },
        });
      }
    }
  }

  remove(key: string) {
    if (!shouldUseLocalStorage(key)) {
      const vscodeStateFailure = removeVsCodeWebviewStateValue(key);
      if (vscodeStateFailure && !this.warnedVsCodeStateRemoveFailure) {
        this.warnedVsCodeStateRemoveFailure = true;
        logWarn(`browser-persistence:vscode-state-remove:${key}`, vscodeStateFailure.error);
      }
      return;
    }

    try {
      if (!this.storage) throw new Error('localStorage is unavailable');
      this.storage.removeItem(key);
      const cleanupFailure = clearSharedVsCodeWebviewStateValue(key);
      if (cleanupFailure && !this.warnedVsCodeStateRemoveFailure) {
        this.warnedVsCodeStateRemoveFailure = true;
        logWarn(`browser-persistence:vscode-state-remove:${key}`, cleanupFailure.error);
      }
    } catch (err) {
      const vscodeStateFailure = removeVsCodeWebviewStateFallback(
        key,
        this.readLocalStorageValue(key)
      );
      if (vscodeStateFailure && !this.warnedVsCodeStateRemoveFailure) {
        this.warnedVsCodeStateRemoveFailure = true;
        logWarn(`browser-persistence:vscode-state-remove:${key}`, vscodeStateFailure.error);
      }
      if (!this.warnedRemoveFailure) {
        this.warnedRemoveFailure = true;
        logWarn(`browser-persistence:remove:${key}`, err);
      }
    }
  }

  private readLocalStorageValue(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
}

const LOCAL_STORAGE_FAILURES_STATE_KEY = '__varroLocalStorageFailures';

const EDITOR_INSTANCE_KEYS = new Set([
  'varro.inputDraft',
  'varro.inputDraftFiles',
  'varro.queuedMessageEdit',
  'varro.queuedMessages',
  'varro.editorViewId',
  'varro.workspacePath',
  'varro.manualWorkspaceSelection',
  'varro.lastActiveSessionId',
  'varro.lastOpenedView',
]);

const WEBVIEW_INSTANCE_KEYS = new Set([
  'varro.inputDraft',
  'varro.inputDraftFiles',
  'varro.queuedMessageEdit',
  'varro.queuedMessages',
]);

function shouldUseLocalStorage(key: string): boolean {
  const initialState = asRecord(window)?.__initialWebviewState;
  const webviewContext = asRecord(initialState)?.webviewContext;
  const contextRecord = asRecord(webviewContext);
  if (contextRecord?.surface && WEBVIEW_INSTANCE_KEYS.has(key)) return false;
  return !(contextRecord?.surface === 'editor' && EDITOR_INSTANCE_KEYS.has(key));
}

function acquireLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

type VsCodeWebviewStateApi = {
  getState(): UnknownRecord;
  setState(state: UnknownRecord): void;
};

function getVsCodeWebviewStateApi(): VsCodeWebviewStateApi | undefined {
  const value = asRecord(window)?.__vscodeWebviewState;
  if (!value || !isObject(value)) return undefined;
  // SAFETY: VS Code installs __vscodeWebviewState with the getState/setState API before startup.
  return value as VsCodeWebviewStateApi;
}

function readVsCodeWebviewStateValue<T>(key: string): T | undefined {
  try {
    // SAFETY: The surrounding shape or discriminator check establishes the T contract used below.
    return getVsCodeWebviewStateApi()?.getState()?.[key] as T | undefined;
  } catch {
    return undefined;
  }
}

function writeVsCodeWebviewStateValue<T>(key: string, value: T): { error: unknown } | undefined {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    api.setState({ ...api.getState(), [key]: value });
    return undefined;
  } catch (err) {
    return { error: err };
  }
}

function removeVsCodeWebviewStateValue(key: string): { error: unknown } | undefined {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    const state = api.getState();
    if (!Object.hasOwn(state, key)) return;
    const next = { ...state };
    delete next[key];
    api.setState(next);
    return undefined;
  } catch (err) {
    return { error: err };
  }
}

function readLocalStorageFailureMarker(key: string): string | null | undefined {
  const failures = asRecord(readVsCodeWebviewStateValue<unknown>(LOCAL_STORAGE_FAILURES_STATE_KEY));
  const value = failures?.[key];
  return isString(value) || value === null ? value : undefined;
}

function writeVsCodeWebviewStateFallback<T>(
  key: string,
  value: T,
  staleValue: string | null
): { error: unknown } | undefined {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    const state = api.getState();
    const failures = asRecord(state[LOCAL_STORAGE_FAILURES_STATE_KEY]) ?? {};
    api.setState({
      ...state,
      [key]: value,
      [LOCAL_STORAGE_FAILURES_STATE_KEY]: { ...failures, [key]: staleValue },
    });
    return undefined;
  } catch (err) {
    return { error: err };
  }
}

function removeVsCodeWebviewStateFallback(
  key: string,
  staleValue: string | null
): { error: unknown } | undefined {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    const state = api.getState();
    const failures = asRecord(state[LOCAL_STORAGE_FAILURES_STATE_KEY]) ?? {};
    const next: UnknownRecord = {
      ...state,
      [LOCAL_STORAGE_FAILURES_STATE_KEY]: { ...failures, [key]: staleValue },
    };
    delete next[key];
    api.setState(next);
    return undefined;
  } catch (err) {
    return { error: err };
  }
}

function clearSharedVsCodeWebviewStateValue(key: string): { error: unknown } | undefined {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    const state = api.getState();
    const failures = asRecord(state[LOCAL_STORAGE_FAILURES_STATE_KEY]);
    if (!Object.hasOwn(state, key) && (!failures || !Object.hasOwn(failures, key))) return;

    const next = { ...state };
    delete next[key];
    if (!failures || !Object.hasOwn(failures, key)) {
      api.setState(next);
      return undefined;
    }

    const nextFailures = { ...failures };
    delete nextFailures[key];
    if (Object.keys(nextFailures).length > 0) {
      next[LOCAL_STORAGE_FAILURES_STATE_KEY] = nextFailures;
    } else {
      delete next[LOCAL_STORAGE_FAILURES_STATE_KEY];
    }
    api.setState(next);
    return undefined;
  } catch (err) {
    return { error: err };
  }
}
