import type { Persistence } from '../../shared/persistence';
import { postMessage } from './bridge';

export class BrowserPersistence implements Persistence {
  private warnedSetFailure = false;
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
    writeVsCodeWebviewStateValue(key, value);

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
    removeVsCodeWebviewStateValue(key);

    try {
      this.storage?.removeItem(key);
    } catch {}
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

function writeVsCodeWebviewStateValue(key: string, value: unknown) {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    api.setState({ ...api.getState(), [key]: value });
  } catch {}
}

function removeVsCodeWebviewStateValue(key: string) {
  try {
    const api = getVsCodeWebviewStateApi();
    if (!api) return;
    const next = { ...api.getState() };
    delete next[key];
    api.setState(next);
  } catch {}
}
