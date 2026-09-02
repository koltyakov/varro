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
    const legacyEditSessionIds: string[] = [];
    this.modes = stored
      ? Object.fromEntries(
          Object.entries(stored).flatMap(([sessionId, mode]): Array<[string, PermissionMode]> => {
            if (!isSafePersistedSessionId(sessionId)) return [];
            if (isPermissionMode(mode)) return [[sessionId, mode]];
            if (mode === 'edits') {
              legacyEditSessionIds.push(sessionId);
              return [[sessionId, 'default']];
            }
            return [];
          })
        )
      : {};
    const storedFallbacks = persistence.get<unknown>(SESSION_PERMISSION_MODE_FALLBACKS_KEY);
    this.fallbackSessionIds = new Set([
      ...(Array.isArray(storedFallbacks)
        ? storedFallbacks.filter((value): value is string => isSafePersistedSessionId(value))
        : []),
      ...legacyEditSessionIds,
    ]);
    if (legacyEditSessionIds.length > 0) {
      this.mutationQueue = Promise.resolve()
        .then(async () => {
          await this.persistence.set(SESSION_PERMISSION_MODES_KEY, this.modes);
          await this.persistFallbacks();
        })
        .catch(() => undefined);
    }
  }

  list() {
    const modes = { ...this.modes };
    // Suppress automatic approvals until recovery confirms the remote rules.
    for (const sessionId of this.fallbackSessionIds) modes[sessionId] = 'default';
    return modes;
  }

  pendingSafeFallbackSessionIds(): string[] {
    return [...this.fallbackSessionIds];
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
      if (this.fallbackSessionIds.has(sessionId)) {
        await this.persistFallbacks(
          [...this.fallbackSessionIds].filter(
            (fallbackSessionId) => fallbackSessionId !== sessionId
          )
        );
        this.fallbackSessionIds.delete(sessionId);
      }
      return this.list();
    });
  }

  removeSession(sessionId: string): Promise<void> {
    return this.set(sessionId, null).then(() => undefined);
  }

  stageSafeFallback(sessionId: string): Promise<boolean> {
    if (!isSafePersistedSessionId(sessionId)) {
      return Promise.reject(new Error('Invalid persisted session ID'));
    }
    return this.mutate(async () => {
      if (this.fallbackSessionIds.has(sessionId)) return false;
      this.fallbackSessionIds.add(sessionId);
      await this.persistFallbacks();
      return true;
    });
  }

  clearSafeFallback(sessionId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.fallbackSessionIds.has(sessionId)) return;
      await this.persistFallbacks(
        [...this.fallbackSessionIds].filter((fallbackSessionId) => fallbackSessionId !== sessionId)
      );
      this.fallbackSessionIds.delete(sessionId);
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
        await this.persistence.set(SESSION_PERMISSION_MODES_KEY, next);
        this.modes = next;
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

  private persistFallbacks(sessionIds: readonly string[] = [...this.fallbackSessionIds]) {
    return this.persistence.set(SESSION_PERMISSION_MODE_FALLBACKS_KEY, sessionIds);
  }
}
