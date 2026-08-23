/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test persistence returns a fixture through the generic storage boundary. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { SessionModelSelectionStore } from './session-model-selection-store';

describe('SessionModelSelectionStore', () => {
  it('restores valid model variants and persists updates', async () => {
    const persistence: Persistence = {
      get<T>() {
        return {
          valid: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
          invalid: { providerID: 'openai', modelID: 1 },
        } as T;
      },
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);

    expect(store.list()).toEqual({
      valid: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });
    await expect(
      store.set('session-1', {
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
        variant: 'high',
      })
    ).resolves.toMatchObject({
      'session-1': { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high' },
    });
    await store.set('valid', null);
    expect(persistence.set).toHaveBeenLastCalledWith('varro.sessionSelectedModels', {
      'session-1': { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high' },
    });
  });

  it('updates its in-memory snapshot before persistence completes', () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => new Promise<void>(() => undefined)),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);

    void store.set('session-1', {
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });

    expect(store.list()).toEqual({
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });
  });

  it('does not lose updates queued while legacy models migrate', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);

    const migration = store.migrateLegacy({
      legacy: { providerID: 'anthropic', modelID: 'claude-sonnet' },
    });
    const update = store.set('current', { providerID: 'openai', modelID: 'gpt-5.6-sol' });
    await Promise.all([migration, update]);

    expect(store.list()).toEqual({
      legacy: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      current: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
    });
    expect(persistence.set).toHaveBeenLastCalledWith('varro.sessionSelectedModels', store.list());
  });
});
