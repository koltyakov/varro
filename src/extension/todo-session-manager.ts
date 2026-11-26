/* oxlint-disable anti-slop/no-runtime-typeof -- Persisted todo values are checked before restoring manager state. */
import type { Persistence } from '../shared/persistence';

const TODO_SESSIONS_KEY = 'varro.todoSessions';

/**
 * Sessions the user marked to come back to. Each marker remembers when it was
 * set so that only prompts sent afterwards clear it.
 */
export class TodoSessionManager {
  private markedAt: Map<string, number>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: Persistence,
    private readonly onChanged?: (sessionIds: string[]) => void,
    private readonly now: () => number = Date.now
  ) {
    const stored = persistence.get<unknown>(TODO_SESSIONS_KEY);
    this.markedAt = new Map(
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? Object.entries(stored).filter(
            (entry): entry is [string, number] =>
              entry[0].length > 0 && typeof entry[1] === 'number' && Number.isFinite(entry[1])
          )
        : []
    );
  }

  list() {
    return [...this.markedAt.keys()];
  }

  async setTodo(sessionID: string, todo: boolean) {
    return this.mutate(() => {
      const next = new Map(this.markedAt);
      if (todo) next.set(sessionID, this.now());
      else next.delete(sessionID);
      return next;
    });
  }

  /** Clears the marker when a prompt created after it was set reaches the session. */
  async clearForPrompt(sessionID: string, createdAt: number) {
    const markedAt = this.markedAt.get(sessionID);
    if (markedAt === undefined || createdAt < markedAt) return this.list();
    return this.mutate(() => {
      const current = this.markedAt.get(sessionID);
      if (current === undefined || createdAt < current) return null;
      const next = new Map(this.markedAt);
      next.delete(sessionID);
      return next;
    });
  }

  async remove(sessionID: string) {
    if (!this.markedAt.has(sessionID)) return this.list();
    return this.mutate(() => {
      if (!this.markedAt.has(sessionID)) return null;
      const next = new Map(this.markedAt);
      next.delete(sessionID);
      return next;
    });
  }

  private mutate(update: () => Map<string, number> | null): Promise<string[]> {
    const result = this.mutationQueue.then(async () => {
      const next = update();
      if (!next) return this.list();
      await this.persistence.set(TODO_SESSIONS_KEY, Object.fromEntries(next));
      this.markedAt = next;
      this.onChanged?.(this.list());
      return this.list();
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
