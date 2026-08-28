import type { Persistence } from '../shared/persistence';
import {
  isSafePersistedSessionId,
  isSessionWorkspaceScope,
  type SessionWorkspaceScope,
} from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const SESSION_WORKSPACE_SCOPES_KEY = 'varro.sessionWorkspaceScopes';

export class SessionWorkspaceScopeStore {
  private scopes: Record<string, SessionWorkspaceScope>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_WORKSPACE_SCOPES_KEY));
    this.scopes = stored
      ? Object.fromEntries(
          Object.entries(stored).filter(
            (entry): entry is [string, SessionWorkspaceScope] =>
              isSafePersistedSessionId(entry[0]) && isSessionWorkspaceScope(entry[1])
          )
        )
      : {};
  }

  get(sessionId: string): SessionWorkspaceScope {
    return this.scopes[sessionId] ?? 'folder';
  }

  set(sessionId: string, scope: SessionWorkspaceScope | null): Promise<void> {
    if (!isSafePersistedSessionId(sessionId)) {
      return Promise.reject(new Error('Invalid persisted session ID'));
    }
    return this.mutate(async () => {
      const next = { ...this.scopes };
      if (scope === null) delete next[sessionId];
      else next[sessionId] = scope;
      this.scopes = next;
      await this.persistence.set(SESSION_WORKSPACE_SCOPES_KEY, next);
    });
  }

  dispose(): Promise<void> {
    return this.mutationQueue;
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
