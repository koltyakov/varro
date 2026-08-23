/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Test persistence accepts and returns fixtures through the generic storage boundary. */
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

  it('does not replace a persisted selection when opening an editor', async () => {
    const persisted = { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high' };
    const persistence: Persistence = {
      get: vi.fn((key: string) =>
        key === 'varro.sessionSelectedModels' ? { 'session-1': persisted } : undefined
      ) as Persistence['get'],
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);

    await store.setIfAbsent('session-1', {
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });

    expect(store.list()['session-1']).toEqual(persisted);
    expect(persistence.set).not.toHaveBeenCalled();
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

  it('does not overwrite an overlapping update while migration persistence is delayed', async () => {
    let releaseMigration!: () => void;
    const migrationWrite = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi
        .fn<(key: string, value: unknown) => Promise<void>>()
        .mockReturnValueOnce(migrationWrite)
        .mockResolvedValue(undefined),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);

    const migration = store.migrateLegacy({
      overlapping: { providerID: 'anthropic', modelID: 'legacy-model' },
    });
    await vi.waitFor(() => expect(persistence.set).toHaveBeenCalledOnce());
    const update = store.set('overlapping', {
      providerID: 'openai',
      modelID: 'current-model',
    });

    releaseMigration();
    await Promise.all([migration, update]);

    expect(store.list().overlapping).toEqual({
      providerID: 'openai',
      modelID: 'current-model',
    });
    expect(persistence.set).toHaveBeenLastCalledWith('varro.sessionSelectedModels', store.list());
  });

  it('drops unsafe persisted session IDs and rejects new ones', async () => {
    const overlong = 'x'.repeat(513);
    const stored = JSON.parse(
      JSON.stringify({
        valid: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        __proto__: { providerID: 'openai', modelID: 'unsafe' },
        constructor: { providerID: 'openai', modelID: 'unsafe' },
        prototype: { providerID: 'openai', modelID: 'unsafe' },
        [overlong]: { providerID: 'openai', modelID: 'unsafe' },
      })
    );
    Object.defineProperty(stored, '__proto__', {
      value: { providerID: 'openai', modelID: 'unsafe' },
      enumerable: true,
    });
    const persistence: Persistence = {
      get: vi.fn((key: string) =>
        key === 'varro.sessionSelectedModels' ? stored : undefined
      ) as Persistence['get'],
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);

    expect(store.list()).toEqual({
      valid: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
    });
    for (const sessionId of ['__proto__', 'constructor', 'prototype', overlong]) {
      await expect(
        store.set(sessionId, { providerID: 'openai', modelID: 'gpt-5.6-sol' })
      ).rejects.toThrow('Invalid persisted session ID');
    }
  });
});
