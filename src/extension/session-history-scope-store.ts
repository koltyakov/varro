/* oxlint-disable anti-slop/no-runtime-typeof -- Persisted aliases are decoded at this storage boundary. */
import type { Persistence } from '../shared/persistence';
import { isSessionHistoryScope, type SessionHistoryScope } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const SESSION_HISTORY_SCOPES_KEY = 'varro.sessionHistoryScopes';
const SESSION_HISTORY_SCOPE_PROJECTS_KEY = 'varro.sessionHistoryScopeProjects';

export class SessionHistoryScopeStore {
  private scopes: Record<string, SessionHistoryScope>;
  private projects: Record<string, string>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_HISTORY_SCOPES_KEY));
    this.scopes = stored
      ? Object.fromEntries(
          Object.entries(stored).filter(
            (entry): entry is [string, SessionHistoryScope] =>
              entry[0].length > 0 && isSessionHistoryScope(entry[1])
          )
        )
      : {};
    const projects = asRecord(persistence.get<unknown>(SESSION_HISTORY_SCOPE_PROJECTS_KEY));
    this.projects = projects
      ? Object.fromEntries(
          Object.entries(projects).filter(
            (entry): entry is [string, string] =>
              entry[0].length > 0 && typeof entry[1] === 'string'
          )
        )
      : {};
  }

  get(key: string): SessionHistoryScope {
    return this.scopes[key] ?? 'directory';
  }

  getForRoot(root: string): SessionHistoryScope {
    const key = this.projects[root];
    return key ? this.get(key) : 'directory';
  }

  associate(root: string, key: string): Promise<void> {
    if (this.projects[root] === key) return this.mutationQueue;
    const update = this.mutationQueue.then(async () => {
      const next = { ...this.projects, [root]: key };
      this.projects = next;
      await this.persistence.set(SESSION_HISTORY_SCOPE_PROJECTS_KEY, next);
    });
    this.mutationQueue = update.catch(() => undefined);
    return update;
  }

  set(key: string, scope: SessionHistoryScope): Promise<void> {
    const update = this.mutationQueue.then(async () => {
      const next = { ...this.scopes, [key]: scope };
      this.scopes = next;
      await this.persistence.set(SESSION_HISTORY_SCOPES_KEY, next);
    });
    this.mutationQueue = update.catch(() => undefined);
    return update;
  }
}
