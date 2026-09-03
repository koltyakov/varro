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

  update(base: ModelPreferences, preferences: ModelPreferences): Promise<ModelPreferences> {
    return this.mutate(async () => {
      this.preferences = mergeModelPreferences(this.preferences, base, preferences);
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

function mergeModelPreferences(
  current: ModelPreferences,
  base: ModelPreferences,
  next: ModelPreferences
): ModelPreferences {
  return {
    modelVariantSelections: mergeRecord(
      current.modelVariantSelections,
      base.modelVariantSelections,
      next.modelVariantSelections
    ),
    providerOrder: mergeOrder(current.providerOrder, base.providerOrder, next.providerOrder),
    modelOrder: mergeOrder(current.modelOrder, base.modelOrder, next.modelOrder),
    hiddenProviders: mergeArray(
      current.hiddenProviders,
      base.hiddenProviders,
      next.hiddenProviders
    ),
    hiddenModels: mergeArray(current.hiddenModels, base.hiddenModels, next.hiddenModels),
    addedModels: mergeArray(current.addedModels, base.addedModels, next.addedModels),
    pinnedModels: mergeArray(current.pinnedModels, base.pinnedModels, next.pinnedModels),
    modelDisplayNames: mergeRecord(
      current.modelDisplayNames,
      base.modelDisplayNames,
      next.modelDisplayNames
    ),
  };
}

function mergeOrder(current: string[], base: string[], next: string[]) {
  if (base.length === next.length && base.every((item, index) => item === next[index])) {
    return [...current];
  }
  return [...next];
}

function mergeArray(current: string[], base: string[], next: string[]) {
  const nextSet = new Set(next);
  const baseSet = new Set(base);
  const removed = new Set(base.filter((item) => !nextSet.has(item)));
  const merged = current.filter((item) => !removed.has(item));
  const mergedSet = new Set(merged);
  for (const item of next) {
    if (!baseSet.has(item) && !mergedSet.has(item)) {
      merged.push(item);
      mergedSet.add(item);
    }
  }
  return merged;
}

function mergeRecord<T extends string | null>(
  current: Record<string, T>,
  base: Record<string, T>,
  next: Record<string, T>
) {
  const merged = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (base[key] === next[key] && Object.hasOwn(base, key) === Object.hasOwn(next, key)) continue;
    if (Object.hasOwn(next, key)) merged[key] = next[key]!;
    else delete merged[key];
  }
  return merged;
}

function cloneModelPreferences(preferences: ModelPreferences): ModelPreferences {
  return {
    modelVariantSelections: { ...preferences.modelVariantSelections },
    providerOrder: [...preferences.providerOrder],
    modelOrder: [...preferences.modelOrder],
    hiddenProviders: [...preferences.hiddenProviders],
    hiddenModels: [...preferences.hiddenModels],
    addedModels: [...preferences.addedModels],
    pinnedModels: [...preferences.pinnedModels],
    modelDisplayNames: { ...preferences.modelDisplayNames },
  };
}
