import type { Persistence } from '../../shared/persistence';
import { postMessage } from './bridge';

export class BrowserPersistence implements Persistence {
  private warnedSetFailure = false;

  constructor(private readonly storage: Storage = window.localStorage) {}

  get<T>(key: string): T | undefined {
    try {
      const raw = this.storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        this.storage.removeItem(key);
        return;
      }
      if (this.storage.getItem(key) === serialized) return;
      this.storage.setItem(key, serialized);
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
    try {
      this.storage.removeItem(key);
    } catch {}
  }
}
