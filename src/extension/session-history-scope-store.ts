/* oxlint-disable anti-slop/no-runtime-typeof -- Persisted aliases are decoded at this storage boundary. */
import type { Persistence } from '../shared/persistence';
import { isSessionHistoryScope, type SessionHistoryScope } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { normalizeWorkspaceIdentity } from '../shared/workspace-path';

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
    this.projects = {};
    const projectEntries = projects
      ? Object.entries(projects)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([root, key]) => ({ identity: normalizeWorkspaceIdentity(root), key, root }))
          .filter(
            (entry): entry is { identity: string; key: string; root: string } =>
              entry.identity !== null
          )
          .toSorted((left, right) => {
            const identityOrder =
              left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;
            if (identityOrder !== 0) return identityOrder;
            const leftCanonical = left.root === left.identity;
            const rightCanonical = right.root === right.identity;
            if (leftCanonical !== rightCanonical) return leftCanonical ? 1 : -1;
            return left.root < right.root ? -1 : left.root > right.root ? 1 : 0;
          })
      : [];
    for (const entry of projectEntries) this.projects[entry.identity] = entry.key;
  }

  get(key: string): SessionHistoryScope {
    return this.scopes[key] ?? 'directory';
  }

  getForRoot(root: string): SessionHistoryScope {
    const identity = normalizeWorkspaceIdentity(root);
    const key = identity ? this.projects[identity] : undefined;
    return key ? this.get(key) : 'directory';
  }

  associate(root: string, key: string): Promise<void> {
    const identity = normalizeWorkspaceIdentity(root);
    if (!identity || this.projects[identity] === key) return this.mutationQueue;
    const update = this.mutationQueue.then(async () => {
      const next = { ...this.projects, [identity]: key };
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
