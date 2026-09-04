/* oxlint-disable anti-slop/no-unknown-parameters -- The persistence fake records opaque values written through the production interface. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { ModelPreferencesStore } from './model-preferences-store';

const preferences = {
  modelVariantSelections: { 'openai:gpt-5.6-sol': 'xhigh' },
  providerOrder: ['openai', 'anthropic'],
  modelOrder: ['openai:gpt-5.6-sol'],
  hiddenProviders: ['anthropic'],
  hiddenModels: ['openai:gpt-5.5'],
  addedModels: ['openai:gpt-5.6-sol'],
  pinnedModels: ['openai:gpt-5.6-sol'],
  modelDisplayNames: { 'openai:gpt-5.6-sol': 'Sol' },
};

function createMemoryPersistence() {
  const storage = new Map<string, unknown>();
  const persistence: Persistence = {
    // SAFETY: The in-memory fixture implements the generic persistence lookup.
    get: vi.fn((key: string) => storage.get(key)) as Persistence['get'],
    set: vi.fn((key: string, value: unknown) => {
      storage.set(key, value);
    }),
    remove: vi.fn((key: string) => {
      storage.delete(key);
    }),
  };
  return { persistence, storage };
}

describe('ModelPreferencesStore', () => {
  it('migrates browser preferences once and persists later updates', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new ModelPreferencesStore(persistence);

    expect(store.needsMigration()).toBe(true);
    await store.migrateLegacy(preferences);
    expect(store.needsMigration()).toBe(false);
    expect(store.get()).toEqual(preferences);

    const updated = { ...preferences, pinnedModels: ['openai:gpt-5.5'] };
    await store.update(preferences, updated);
    expect(persistence.set).toHaveBeenLastCalledWith(
      'varro.modelPreferences.hostMigration.v1',
      true
    );
    expect(store.get()).toEqual(updated);

    await store.update(updated, { ...updated, providerOrder: [], modelOrder: [] });
    expect(store.get()).toEqual({ ...updated, providerOrder: [], modelOrder: [] });
  });

  it('preserves a pre-migration update when stale legacy preferences arrive later', async () => {
    const { persistence } = createMemoryPersistence();
    const store = new ModelPreferencesStore(persistence);
    const updated = {
      ...preferences,
      pinnedModels: [...preferences.pinnedModels, 'anthropic:claude-opus'],
    };

    await store.update(preferences, updated);
    await store.migrateLegacy(preferences);

    const reloaded = new ModelPreferencesStore(persistence);
    expect(reloaded.get()).toEqual(updated);
  });

  it('preserves a pre-migration update when the host restarts before migration', async () => {
    const { persistence } = createMemoryPersistence();
    const updated = {
      ...preferences,
      pinnedModels: [...preferences.pinnedModels, 'anthropic:claude-opus'],
    };
    const store = new ModelPreferencesStore(persistence);

    await store.update(preferences, updated);
    expect(store.needsMigration()).toBe(true);

    const restartedStore = new ModelPreferencesStore(persistence);
    expect(restartedStore.needsMigration()).toBe(true);
    await restartedStore.migrateLegacy(preferences);

    expect(restartedStore.get()).toEqual(updated);
  });

  it('merges two pre-migration updates made from the same stale webview snapshot', async () => {
    const { persistence } = createMemoryPersistence();
    const store = new ModelPreferencesStore(persistence);
    const pinnedUpdate = {
      ...preferences,
      pinnedModels: [...preferences.pinnedModels, 'anthropic:claude-opus'],
    };
    const displayNameUpdate = {
      ...preferences,
      modelDisplayNames: {
        ...preferences.modelDisplayNames,
        'anthropic:claude-opus': 'Opus',
      },
    };

    await Promise.all([
      store.update(preferences, pinnedUpdate),
      store.update(preferences, displayNameUpdate),
    ]);

    expect(store.get()).toMatchObject({
      pinnedModels: ['openai:gpt-5.6-sol', 'anthropic:claude-opus'],
      modelDisplayNames: {
        'openai:gpt-5.6-sol': 'Sol',
        'anthropic:claude-opus': 'Opus',
      },
    });
  });

  it('merges concurrent changes made from stale webview snapshots', async () => {
    const persistence: Persistence = {
      // SAFETY: The fixture handles the two persistence keys read by ModelPreferencesStore.
      get: vi.fn((key: string) =>
        key === 'varro.modelPreferences.hostMigration.v1' ? true : null
      ) as Persistence['get'],
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new ModelPreferencesStore(persistence);
    const base = store.get();

    await store.update(base, {
      ...base,
      providerOrder: ['anthropic', 'openai'],
      modelOrder: ['anthropic:claude-opus', 'anthropic:claude-sonnet'],
      pinnedModels: ['openai:gpt-5.6-sol'],
    });
    await store.update(base, { ...base, hiddenModels: ['anthropic:claude-opus'] });

    expect(store.get()).toMatchObject({
      providerOrder: ['anthropic', 'openai'],
      modelOrder: ['anthropic:claude-opus', 'anthropic:claude-sonnet'],
      pinnedModels: ['openai:gpt-5.6-sol'],
      hiddenModels: ['anthropic:claude-opus'],
    });
  });

  it('restores a sanitized host snapshot', () => {
    const persistence: Persistence = {
      // SAFETY: The fixture implements the generic persistence lookup for these known keys.
      get: vi.fn((key: string) =>
        key === 'varro.modelPreferences'
          ? { ...preferences, pinnedModels: ['openai:gpt-5.6-sol', 42] }
          : true
      ) as Persistence['get'],
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };

    const store = new ModelPreferencesStore(persistence);

    expect(store.needsMigration()).toBe(false);
    expect(store.get().pinnedModels).toEqual(['openai:gpt-5.6-sol']);
  });

  it('seeds global preferences from legacy workspace storage', async () => {
    const { persistence: globalPersistence, storage: globalStorage } = createMemoryPersistence();
    const { persistence: workspacePersistence, storage: workspaceStorage } =
      createMemoryPersistence();
    workspaceStorage.set('varro.modelPreferences', preferences);
    workspaceStorage.set('varro.modelPreferences.hostMigration.v1', true);

    const store = new ModelPreferencesStore(globalPersistence, workspacePersistence);

    expect(store.needsMigration()).toBe(false);
    expect(store.get()).toEqual(preferences);
    await store.dispose();
    expect(globalStorage.get('varro.modelPreferences')).toEqual(preferences);
    expect(globalStorage.get('varro.modelPreferences.hostMigration.v1')).toBe(true);
  });

  it('prefers existing global preferences over legacy workspace storage', () => {
    const { persistence: globalPersistence, storage: globalStorage } = createMemoryPersistence();
    const { persistence: workspacePersistence, storage: workspaceStorage } =
      createMemoryPersistence();
    const globalPreferences = { ...preferences, pinnedModels: ['global/model'] };
    globalStorage.set('varro.modelPreferences', globalPreferences);
    globalStorage.set('varro.modelPreferences.hostMigration.v1', true);
    workspaceStorage.set('varro.modelPreferences', preferences);
    workspaceStorage.set('varro.modelPreferences.hostMigration.v1', true);

    const store = new ModelPreferencesStore(globalPersistence, workspacePersistence);

    expect(store.get()).toEqual(globalPreferences);
    expect(globalPersistence.set).not.toHaveBeenCalled();
  });
});
