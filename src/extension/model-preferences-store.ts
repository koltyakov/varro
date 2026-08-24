import type { Persistence } from '../shared/persistence';
import type { ModelPreferences } from '../shared/protocol';
import { parseModelPreferences } from '../shared/model-preferences';

const MODEL_PREFERENCES_KEY = 'varro.modelPreferences';
const MODEL_PREFERENCES_MIGRATION_KEY = 'varro.modelPreferences.hostMigration.v1';

export class ModelPreferencesStore {
  private preferences: ModelPreferences;
  private migrationComplete: boolean;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    this.preferences = parseModelPreferences(persistence.get<unknown>(MODEL_PREFERENCES_KEY));
    this.migrationComplete = persistence.get<boolean>(MODEL_PREFERENCES_MIGRATION_KEY) === true;
  }

  get() {
    return cloneModelPreferences(this.preferences);
  }

  needsMigration() {
    return !this.migrationComplete;
  }

  set(preferences: ModelPreferences): Promise<ModelPreferences> {
    return this.mutate(async () => {
      this.preferences = cloneModelPreferences(preferences);
      await this.persist();
      return this.get();
    });
  }

  migrateLegacy(preferences: ModelPreferences): Promise<ModelPreferences> {
    return this.mutate(async () => {
      if (this.migrationComplete) return this.get();
      this.preferences = cloneModelPreferences(preferences);
      await this.persist();
      return this.get();
    });
  }

  dispose(): Promise<void> {
    return this.mutationQueue;
  }

  private async persist() {
    await this.persistence.set(MODEL_PREFERENCES_KEY, this.preferences);
    await this.persistence.set(MODEL_PREFERENCES_MIGRATION_KEY, true);
    this.migrationComplete = true;
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

function cloneModelPreferences(preferences: ModelPreferences): ModelPreferences {
  return {
    modelVariantSelections: { ...preferences.modelVariantSelections },
    hiddenProviders: [...preferences.hiddenProviders],
    hiddenModels: [...preferences.hiddenModels],
    addedModels: [...preferences.addedModels],
    pinnedModels: [...preferences.pinnedModels],
    modelDisplayNames: { ...preferences.modelDisplayNames },
  };
}
