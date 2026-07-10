import type { Persistence } from '../shared/persistence';

const PINNED_SESSION_IDS_KEY = 'varro.pinnedSessionIds';

export class PinnedSessionManager {
  private ids: string[];
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(PINNED_SESSION_IDS_KEY);
    this.ids = Array.isArray(stored)
      ? [...new Set(stored.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [];
  }

  list() {
    return [...this.ids];
  }

  async setPinned(sessionID: string, pinned: boolean) {
    return this.mutate(async () => {
      const next = this.ids.filter((id) => id !== sessionID);
      if (pinned) next.unshift(sessionID);
      await this.persistence.set(PINNED_SESSION_IDS_KEY, next);
      this.ids = next;
      return this.list();
    });
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
