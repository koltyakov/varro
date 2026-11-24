import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLimitStatus, WebviewMessage } from '../../../shared/protocol';
import { ModelPreferencesStore } from '../../../extension/model-preferences-store';
import type { Agent, Command, Provider } from '../../types';
import { registerHostExtension } from '../../host/extensions';
import { STORAGE_KEYS, writeStored } from '../state-storage';
import { routingStore } from './routing-store';
import {
  applyModelPreferencesSnapshot,
  getModelPreferencesSnapshot,
  resetDefaultAppState,
  setState,
  state,
} from '../state';

function createAgent(name: string): Agent {
  return {
    name,
    mode: 'primary',
    builtIn: false,
    permission: {
      edit: 'ask',
      bash: {},
    },
    tools: {},
  };
}

function createProvider(id: string): Provider {
  return {
    id,
    name: id,
    source: 'config',
    models: {
      'model-1': {
        id: 'model-1',
        name: 'Model 1',
        capabilities: {
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 1,
          output: 1,
        },
      },
      'model-2': {
        id: 'model-2',
        name: 'Model 2',
        capabilities: {
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 1,
          output: 1,
        },
      },
    },
  };
}

describe('routingStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
  });

  it('updates routing state and exposes helper queries', () => {
    const agents = [createAgent('planner'), createAgent('reviewer')];
    const command: Command = {
      name: '/review',
      template: 'Review the change',
    };
    const limit: ProviderLimitStatus = {
      providerID: 'provider-1',
      modelID: 'model-1',
      status: 'available',
      source: 'provider',
      checkedAt: 123,
      windows: [],
    };

    routingStore.setAllAgents(agents);
    flushSolid();
    routingStore.setPrimaryAgents([agents[0]!]);
    flushSolid();
    routingStore.setProvidersLoaded(true);
    flushSolid();
    routingStore.setProviders([createProvider('provider-1')]);
    flushSolid();
    routingStore.setProviderDefaults({ 'provider-1': 'model-1' });
    flushSolid();
    routingStore.setCommands([command]);
    flushSolid();
    routingStore.setMcpStatus({
      zebra: { status: 'connected' },
      alpha: { status: 'connected' },
      beta: { status: 'failed' },
    });
    flushSolid();
    routingStore.setProviderLimitStatus('provider-1', 'model-1', limit);
    flushSolid();

    expect(state.allAgents).toEqual(agents);
    expect(state.agents).toEqual([agents[0]]);
    expect(state.providersLoaded).toBe(true);
    expect(state.providerDefaults).toEqual({ 'provider-1': 'model-1' });
    expect(routingStore.hasCommand('/review')).toBe(true);
    expect(routingStore.getConnectedMcpNames()).toEqual(['alpha', 'zebra']);
    expect(routingStore.getProviderLimit('provider-1', 'model-1')).toEqual(limit);
  });

  it('releases a workspace reload lock only after every send catalog loads', () => {
    setState(storePath('workspaceCatalogReloadPending', true));
    flushSolid();

    routingStore.setProvidersLoaded(true);
    flushSolid();
    expect(state.workspaceCatalogReloadPending).toBe(true);
    routingStore.setPrimaryAgents([]);
    flushSolid();
    expect(state.workspaceCatalogReloadPending).toBe(true);
    routingStore.setCommands([]);
    flushSolid();

    expect(state.workspaceCatalogReloadPending).toBe(false);
  });

  it('can release a workspace reload lock with empty replacement catalogs', () => {
    setState(storePath('workspaceCatalogReloadPending', true));
    flushSolid();
    setState(storePath('providers', []));
    flushSolid();
    setState(storePath('agents', []));
    flushSolid();
    setState(storePath('commands', []));
    flushSolid();

    routingStore.finishWorkspaceCatalogReload();
    flushSolid();

    expect(state.workspaceCatalogReloadPending).toBe(false);
    expect(state.providers).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.commands).toEqual([]);
  });

  it('updates provider and model visibility', () => {
    const provider = createProvider('provider-1');

    routingStore.setProviders([provider]);
    flushSolid();
    routingStore.setSelectedModel({ providerID: 'provider-1', modelID: 'model-1' });
    flushSolid();
    routingStore.setModelVisible('provider-1', 'model-1', false);
    flushSolid();

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(false);
    expect(Object.keys(routingStore.getVisibleProviders(state.providers)[0]?.models ?? {})).toEqual(
      ['model-2']
    );
    expect(state.selectedModel).toBeNull();

    routingStore.setProviderVisible('provider-1', false);
    flushSolid();

    expect(routingStore.isProviderVisible('provider-1')).toBe(false);
    expect(routingStore.getVisibleProviders(state.providers)).toEqual([]);
  });

  it('shows published models while preserving explicit catalog removals and visibility choices', () => {
    const provider = createProvider('provider-1');
    routingStore.setProviders([provider]);
    flushSolid();
    routingStore.setModelsAdded(provider.id, ['model-2']);
    flushSolid();
    routingStore.setModelVisible(provider.id, 'model-2', false);
    flushSolid();
    const refreshed = {
      ...provider,
      models: { ...provider.models, 'model-3': { ...provider.models['model-2']!, id: 'model-3' } },
    };
    routingStore.setProviders([refreshed]);
    flushSolid();
    expect(routingStore.isModelVisible(provider.id, 'model-1')).toBe(false);
    expect(routingStore.isModelVisible(provider.id, 'model-2')).toBe(false);
    expect(routingStore.isModelVisible(provider.id, 'model-3')).toBe(true);
    expect(state.removedModels).toEqual(['provider-1:model-1']);
    expect(JSON.parse(window.localStorage.getItem('varro.removedModels')!)).toEqual(
      state.removedModels
    );
    routingStore.setModelsAdded(provider.id, ['model-2', 'model-3']);
    flushSolid();
    expect(routingStore.isModelVisible(provider.id, 'model-2')).toBe(false);
    routingStore.setModelAdded(provider.id, 'model-1', true);
    flushSolid();
    expect(routingStore.isModelVisible(provider.id, 'model-1')).toBe(true);
    expect(routingStore.isModelVisible(provider.id, 'model-3')).toBe(true);
  });

  it('hides superseded models when a provider is first connected', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1']!,
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2']!,
      family: 'model',
      release_date: '2026-01-01',
    };

    routingStore.setProviders([connected], {}, ['provider-1']);
    flushSolid();

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(false);
    expect(routingStore.isModelVisible('provider-1', 'model-2')).toBe(true);

    routingStore.setModelVisible('provider-1', 'model-1', true);
    flushSolid();
    routingStore.setProviders([connected]);
    flushSolid();

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
  });

  it('hides newly superseded models when persisted visibility contains duplicates', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1']!,
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2']!,
      family: 'model',
      release_date: '2026-01-01',
    };
    setState(storePath('hiddenModels', ['provider-1:existing', 'provider-1:existing']));
    flushSolid();

    routingStore.setProviders([connected], {}, ['provider-1']);
    flushSolid();

    expect(state.hiddenModels).toEqual(['provider-1:existing', 'provider-1:model-1']);
    expect(JSON.parse(window.localStorage.getItem('varro.hiddenModels') ?? 'null')).toEqual(
      state.hiddenModels
    );
  });

  it.each([false, true])(
    'keeps automatically hidden models unchecked after another model changes, synced before toggle=%s',
    async (syncBeforeToggle) => {
      const host = new ModelPreferencesStore({ get: vi.fn(), set: vi.fn(), remove: vi.fn() });
      await host.migrateLegacy(getModelPreferencesSnapshot());
      flushSolid();
      const sent: WebviewMessage[] = [];
      const disposeHost = registerHostExtension({
        apiVersion: 1,
        id: 'test.model-preferences',
        services: { send: (message) => sent.push(message) },
      });
      const syncPreferences = async () => {
        for (const message of sent.splice(0)) {
          if (message.type !== 'model-preferences/update') continue;
          applyModelPreferencesSnapshot(
            await host.update(message.payload.base, message.payload.preferences)
          );
        }
      };

      try {
        const connected = createProvider('provider-1');
        connected.models['model-1'] = {
          ...connected.models['model-1']!,
          family: 'model',
          release_date: '2025-01-01',
        };
        connected.models['model-2'] = {
          ...connected.models['model-2']!,
          family: 'model',
          release_date: '2026-01-01',
        };
        routingStore.setProviders([connected], {}, ['provider-1']);
        flushSolid();
        expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(false);
        if (syncBeforeToggle) await syncPreferences();
        flushSolid();

        routingStore.setModelVisible('provider-1', 'model-2', false);
        flushSolid();
        await syncPreferences();
        flushSolid();

        expect(state.hiddenModels).toEqual(['provider-1:model-1', 'provider-1:model-2']);
        expect(host.get().hiddenModels).toEqual(state.hiddenModels);
        expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(false);

        routingStore.setModelVisible('provider-1', 'model-1', true);
        flushSolid();
        await syncPreferences();
        flushSolid();
        routingStore.setProviders([connected]);
        flushSolid();
        expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
        expect(routingStore.isModelVisible('provider-1', 'model-2')).toBe(false);
        expect(sent).toEqual([]);
      } finally {
        disposeHost();
        flushSolid();
      }
    }
  );

  it('keeps the provider default enabled on first connection', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1']!,
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2']!,
      family: 'model',
      release_date: '2026-01-01',
    };

    routingStore.setProviders([connected], { 'provider-1': 'model-1' }, ['provider-1']);
    flushSolid();

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
  });

  it('does not change checkbox choices when newer models appear', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1']!,
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2']!,
      family: 'model',
      release_date: '2026-01-01',
    };
    routingStore.setProviders([connected], {}, ['provider-1']);
    flushSolid();
    routingStore.setModelVisible('provider-1', 'model-1', true);
    flushSolid();
    routingStore.setModelVisible('provider-1', 'model-2', false);
    flushSolid();

    const refreshed = createProvider('provider-1');
    refreshed.models = {
      ...connected.models,
      'model-3': {
        ...connected.models['model-2']!,
        id: 'model-3',
        name: 'Model 3',
        release_date: '2027-01-01',
      },
    };
    routingStore.setProviders([refreshed]);
    flushSolid();

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
    expect(routingStore.isModelVisible('provider-1', 'model-2')).toBe(false);
    expect(routingStore.isModelVisible('provider-1', 'model-3')).toBe(true);
  });
});

describe('routingStore provider history', () => {
  afterEach(() => {
    writeStored(STORAGE_KEYS.providersConnected, null);
    resetDefaultAppState();
    flushSolid();
  });

  it('remembers that providers were connected, even after an empty catalog', () => {
    writeStored(STORAGE_KEYS.providersConnected, null);
    expect(routingStore.hadConnectedProviders()).toBe(false);

    routingStore.setProviders([]);
    flushSolid();
    expect(routingStore.hadConnectedProviders()).toBe(false);

    routingStore.setProviders([createProvider('openai')]);
    flushSolid();
    routingStore.setProviders([]);
    flushSolid();
    expect(routingStore.hadConnectedProviders()).toBe(true);
  });
});
