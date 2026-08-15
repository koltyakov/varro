import type { Persistence } from '../../shared/persistence';
import { postMessage } from './bridge';
import { logWarn } from './log';

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
    const vscodeValue = readVsCodeWebviewStateValue<T>(key);
    if (vscodeValue !== undefined) return vscodeValue;

    try {
      const raw = this.storage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown) {
    const vscodeStateFailure = writeVsCodeWebviewStateValue(key, value);
    if (vscodeStateFailure && !this.warnedVsCodeStateWriteFailure) {
      this.warnedVsCodeStateWriteFailure = true;
      logWarn(`browser-persistence:vscode-state-write:${key}`, vscodeStateFailure.error);
    }

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

function acquireLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

type VsCodeWebviewStateApi = {
  getState(): Record<string, unknown>;
  setState(state: Record<string, unknown>): void;
};

function getVsCodeWebviewStateApi(): VsCodeWebviewStateApi | undefined {
  return (window as unknown as { __vscodeWebviewState?: VsCodeWebviewStateApi })
    .__vscodeWebviewState;
}

function readVsCodeWebviewStateValue<T>(key: string): T | undefined {
  try {
    return getVsCodeWebviewStateApi()?.getState()?.[key] as T | undefined;
  } catch {
    return undefined;
  }
}

function writeVsCodeWebviewStateValue(key: string, value: unknown): { error: unknown } | undefined {
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
