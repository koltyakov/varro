/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Persisted model selections are decoded at this storage boundary. */
import type { Persistence } from '../shared/persistence';
import { isSafePersistedSessionId, type ChatModelSelection } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const SESSION_SELECTED_MODELS_KEY = 'varro.sessionSelectedModels';
const SESSION_SELECTED_MODELS_MIGRATION_KEY = 'varro.sessionSelectedModels.hostMigration.v1';

export class SessionModelSelectionStore {
  private models: Record<string, ChatModelSelection>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private migrationComplete: boolean;

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_SELECTED_MODELS_KEY));
    this.models = stored
      ? Object.fromEntries(
          Object.entries(stored).flatMap(([sessionId, value]) => {
            if (!isSafePersistedSessionId(sessionId)) return [];
            const model = parseModel(value);
            return model ? [[sessionId, model]] : [];
          })
        )
      : {};
    this.migrationComplete =
      persistence.get<boolean>(SESSION_SELECTED_MODELS_MIGRATION_KEY) === true;
  }

  list() {
    return { ...this.models };
  }

  set(
    sessionId: string,
    model: ChatModelSelection | null
  ): Promise<Record<string, ChatModelSelection>> {
    if (!isSafePersistedSessionId(sessionId)) {
      return Promise.reject(new Error('Invalid persisted session ID'));
    }
    const next = { ...this.models };
    if (model) next[sessionId] = model;
    else delete next[sessionId];
    this.models = next;
    return this.mutate(async () => {
      const current = this.list();
      await this.persistence.set(SESSION_SELECTED_MODELS_KEY, current);
      return this.list();
    });
  }

  removeSession(sessionId: string): Promise<void> {
    return this.set(sessionId, null).then(() => undefined);
  }

  needsMigration() {
    return !this.migrationComplete;
  }

  setIfAbsent(
    sessionId: string,
    model: ChatModelSelection
  ): Promise<Record<string, ChatModelSelection>> {
    if (!isSafePersistedSessionId(sessionId)) {
      return Promise.reject(new Error('Invalid persisted session ID'));
    }
    return this.mutate(async () => {
      if (Object.hasOwn(this.models, sessionId)) return this.list();
      this.models = { ...this.models, [sessionId]: model };
      await this.persistence.set(SESSION_SELECTED_MODELS_KEY, this.models);
      return this.list();
    });
  }

  migrateLegacy(
    models: Record<string, ChatModelSelection>
  ): Promise<Record<string, ChatModelSelection>> {
    return this.mutate(async () => {
      if (this.migrationComplete) return this.list();
      const next = { ...this.models };
      for (const [sessionId, model] of Object.entries(models)) {
        if (!isSafePersistedSessionId(sessionId)) continue;
        if (!Object.hasOwn(next, sessionId)) next[sessionId] = model;
      }
      this.models = next;
      await this.persistence.set(SESSION_SELECTED_MODELS_KEY, next);
      await this.persistence.set(SESSION_SELECTED_MODELS_MIGRATION_KEY, true);
      this.migrationComplete = true;
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

function parseModel(value: unknown): ChatModelSelection | null {
  const model = asRecord(value);
  if (typeof model?.providerID !== 'string' || typeof model.modelID !== 'string') return null;
  if (model.variant !== undefined && typeof model.variant !== 'string') return null;
  return model.variant
    ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
    : { providerID: model.providerID, modelID: model.modelID };
}
