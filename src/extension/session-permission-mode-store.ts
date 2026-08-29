import type { Persistence } from '../shared/persistence';
import {
  isPermissionMode,
  isSafePersistedSessionId,
  type PermissionMode,
} from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const SESSION_PERMISSION_MODES_KEY = 'varro.sessionPermissionModes';
const SESSION_PERMISSION_MODE_FALLBACKS_KEY = 'varro.sessionPermissionModeFallbacks';

export class SessionPermissionModeStore {
  private modes: Record<string, PermissionMode>;
  private fallbackSessionIds: Set<string>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_PERMISSION_MODES_KEY));
    this.modes = stored
      ? Object.fromEntries(
          Object.entries(stored).filter(
            (entry): entry is [string, PermissionMode] =>
              isSafePersistedSessionId(entry[0]) && isPermissionMode(entry[1])
          )
        )
      : {};
    const storedFallbacks = persistence.get<unknown>(SESSION_PERMISSION_MODE_FALLBACKS_KEY);
    this.fallbackSessionIds = new Set(
      Array.isArray(storedFallbacks)
        ? storedFallbacks.filter((value): value is string => isSafePersistedSessionId(value))
        : []
    );
    for (const sessionId of this.fallbackSessionIds) this.modes[sessionId] = 'default';
  }

  list() {
    return { ...this.modes };
  }

  set(sessionId: string, mode: PermissionMode | null): Promise<Record<string, PermissionMode>> {
    if (!isSafePersistedSessionId(sessionId)) {
      return Promise.reject(new Error('Invalid persisted session ID'));
    }
    return this.mutate(async () => {
      const next = { ...this.modes };
      if (mode === null) delete next[sessionId];
      else next[sessionId] = mode;
      this.modes = next;
      await this.persistence.set(SESSION_PERMISSION_MODES_KEY, next);
      if (this.fallbackSessionIds.delete(sessionId)) {
        await this.persistFallbacks();
      }
      return this.list();
    });
  }

  removeSession(sessionId: string): Promise<void> {
    return this.set(sessionId, null).then(() => undefined);
  }

  stageSafeFallback(sessionId: string): Promise<void> {
    if (!isSafePersistedSessionId(sessionId)) {
      return Promise.reject(new Error('Invalid persisted session ID'));
    }
    return this.mutate(async () => {
      if (this.fallbackSessionIds.has(sessionId)) return;
      this.fallbackSessionIds.add(sessionId);
      try {
        await this.persistFallbacks();
      } catch (err) {
        this.fallbackSessionIds.delete(sessionId);
        throw err;
      }
    });
  }

  clearSafeFallback(sessionId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.fallbackSessionIds.delete(sessionId)) return;
      try {
        await this.persistFallbacks();
      } catch (err) {
        this.fallbackSessionIds.add(sessionId);
        throw err;
      }
    });
  }

  setIfAbsent(modes: Record<string, PermissionMode>): Promise<Record<string, PermissionMode>> {
    return this.mutate(async () => {
      const next = { ...this.modes };
      let changed = false;
      for (const [sessionId, mode] of Object.entries(modes)) {
        if (!isSafePersistedSessionId(sessionId) || Object.hasOwn(next, sessionId)) continue;
        next[sessionId] = mode;
        changed = true;
      }
      if (changed) {
        this.modes = next;
        await this.persistence.set(SESSION_PERMISSION_MODES_KEY, next);
      }
      return this.list();
    });
  }

  dispose(): Promise<void> {
    return this.mutationQueue;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private persistFallbacks() {
    return this.persistence.set(SESSION_PERMISSION_MODE_FALLBACKS_KEY, [
      ...this.fallbackSessionIds,
    ]);
  }
}
