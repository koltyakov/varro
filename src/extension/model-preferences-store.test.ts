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
});
