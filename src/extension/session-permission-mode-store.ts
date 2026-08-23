import type { Persistence } from '../shared/persistence';
import { isPermissionMode, type PermissionMode } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const SESSION_PERMISSION_MODES_KEY = 'varro.sessionPermissionModes';

export class SessionPermissionModeStore {
  private modes: Record<string, PermissionMode>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_PERMISSION_MODES_KEY));
    this.modes = stored
      ? Object.fromEntries(
          Object.entries(stored).filter((entry): entry is [string, PermissionMode] =>
            isPermissionMode(entry[1])
          )
        )
      : {};
  }

  list() {
    return { ...this.modes };
  }

  set(sessionId: string, mode: PermissionMode | null): Promise<Record<string, PermissionMode>> {
    return this.mutate(async () => {
      const next = { ...this.modes };
      if (mode === null) delete next[sessionId];
      else next[sessionId] = mode;
      await this.persistence.set(SESSION_PERMISSION_MODES_KEY, next);
      this.modes = next;
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
}
