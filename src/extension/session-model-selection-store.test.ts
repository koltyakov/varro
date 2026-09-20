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

  it('removes the persisted selection for a deleted session', async () => {
    const persistence: Persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const store = new SessionModelSelectionStore(persistence);
    await store.set('session-1', { providerID: 'openai', modelID: 'gpt-5.6-sol' });

    await store.removeSession('session-1');

    expect(store.list()).toEqual({});
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

  it('retries an initial model selection after persistence fails', async () => {
    const saved = new Map<string, unknown>();
    const persistence: Persistence = {
      get<T>(key: string) {
        return saved.get(key) as T | undefined;
      },
      set: vi.fn<Persistence['set']>(async (key, value) => {
        saved.set(key, value);
      }),
      remove: vi.fn(),
    };
    const store = new SessionModelSelectionStore(persistence);
    const model = { providerID: 'openai', modelID: 'fixture-model', variant: 'high' };
    vi.mocked(persistence.set).mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(store.setIfAbsent('session-1', model)).rejects.toThrow('Storage unavailable');
    await store.setIfAbsent('session-1', model);

    expect(new SessionModelSelectionStore(persistence).list()).toEqual({ 'session-1': model });
  });

  it.each(['session-1', 'session-2'])(
    'preserves a newer selection for %s when initialization fails',
    async (sessionId) => {
      const saved = new Map<string, unknown>();
      let fail!: (error: Error) => void;
      let begin!: () => void;
      const pending = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const persistence: Persistence = {
        get<T>(key: string) {
          return saved.get(key) as T | undefined;
        },
        set: vi.fn<Persistence['set']>(async (key, value) => {
          saved.set(key, value);
        }),
        remove: vi.fn(),
      };
      vi.mocked(persistence.set).mockImplementationOnce(() => {
        begin();
        return pending;
      });
      const store = new SessionModelSelectionStore(persistence);
      const model = { providerID: 'openai', modelID: 'fixture-model' };
      const initialization = store.setIfAbsent('session-1', model);
      await started;
      // Reuse the same input object to distinguish a newer write from initialization.
      const selection = store.set(sessionId, model);
      fail(new Error('Storage unavailable'));
      await expect(initialization).rejects.toThrow('Storage unavailable');
      await selection;

      expect(store.list()).toEqual({ [sessionId]: model });
      expect(new SessionModelSelectionStore(persistence).list()).toEqual({ [sessionId]: model });
    }
  );

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
