/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Persisted model selections are decoded at this storage boundary. */
import type { Persistence } from '../shared/persistence';
import type { ChatModelSelection } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const SESSION_SELECTED_MODELS_KEY = 'varro.sessionSelectedModels';

export class SessionModelSelectionStore {
  private models: Record<string, ChatModelSelection>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_SELECTED_MODELS_KEY));
    this.models = stored
      ? Object.fromEntries(
          Object.entries(stored).flatMap(([sessionId, value]) => {
            const model = parseModel(value);
            return model ? [[sessionId, model]] : [];
          })
        )
      : {};
  }

  list() {
    return { ...this.models };
  }

  set(
    sessionId: string,
    model: ChatModelSelection | null
  ): Promise<Record<string, ChatModelSelection>> {
    const next = { ...this.models };
    if (model) next[sessionId] = model;
    else delete next[sessionId];
    this.models = next;
    return this.mutate(async () => {
      await this.persistence.set(SESSION_SELECTED_MODELS_KEY, next);
      return { ...next };
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

function parseModel(value: unknown): ChatModelSelection | null {
  const model = asRecord(value);
  if (typeof model?.providerID !== 'string' || typeof model.modelID !== 'string') return null;
  if (model.variant !== undefined && typeof model.variant !== 'string') return null;
  return model.variant
    ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
    : { providerID: model.providerID, modelID: model.modelID };
}
