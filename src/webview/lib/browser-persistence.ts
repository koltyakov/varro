import type { Persistence } from '../../shared/persistence';
import { postMessage } from './bridge';
import { logWarn } from './log';
import type { UnknownRecord } from '../../shared/type-utils';
import { asRecord, isObject } from './runtime-values';

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
    const vscodeStateFailure = writeVsCodeWebviewStateValue(key, value);
    if (vscodeStateFailure && !this.warnedVsCodeStateWriteFailure) {
      this.warnedVsCodeStateWriteFailure = true;
      logWarn(`browser-persistence:vscode-state-write:${key}`, vscodeStateFailure.error);
    }

    if (!shouldUseLocalStorage(key)) return;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        this.storage?.removeItem(key);
        return;
      }
      if (this.storage?.getItem(key) === serialized) return;
      this.storage?.setItem(key, serialized);
    } catch (err) {
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
    const vscodeStateFailure = removeVsCodeWebviewStateValue(key);
    if (vscodeStateFailure && !this.warnedVsCodeStateRemoveFailure) {
      this.warnedVsCodeStateRemoveFailure = true;
      logWarn(`browser-persistence:vscode-state-remove:${key}`, vscodeStateFailure.error);
    }

    if (!shouldUseLocalStorage(key)) return;
    try {
      this.storage?.removeItem(key);
    } catch (err) {
      if (!this.warnedRemoveFailure) {
        this.warnedRemoveFailure = true;
        logWarn(`browser-persistence:remove:${key}`, err);
      }
    }
  }
}

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

const WEBVIEW_INSTANCE_KEYS = new Set(['varro.inputDraftFiles']);

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
    const next = { ...api.getState() };
    delete next[key];
    api.setState(next);
    return undefined;
  } catch (err) {
    return { error: err };
  }
}
