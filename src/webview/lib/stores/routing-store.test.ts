import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import type { Agent, Command, Provider } from '../../types';
import { routingStore } from './routing-store';
import { resetDefaultAppState, state } from '../state';

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
    resetDefaultAppState();
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
    routingStore.setPrimaryAgents([agents[0]]);
    routingStore.setProvidersLoaded(true);
    routingStore.setProviders([createProvider('provider-1')]);
    routingStore.setProviderDefaults({ 'provider-1': 'model-1' });
    routingStore.setCommands([command]);
    routingStore.setMcpStatus({
      zebra: { status: 'connected' },
      alpha: { status: 'connected' },
      beta: { status: 'failed' },
    });
    routingStore.setProviderLimitStatus('provider-1', 'model-1', limit);

    expect(state.allAgents).toEqual(agents);
    expect(state.agents).toEqual([agents[0]]);
    expect(state.providersLoaded).toBe(true);
    expect(state.providerDefaults).toEqual({ 'provider-1': 'model-1' });
    expect(routingStore.hasCommand('/review')).toBe(true);
    expect(routingStore.getConnectedMcpNames()).toEqual(['alpha', 'zebra']);
    expect(routingStore.getProviderLimit('provider-1', 'model-1')).toEqual(limit);
  });

  it('updates provider and model visibility', () => {
    const provider = createProvider('provider-1');

    routingStore.setProviders([provider]);
    routingStore.setSelectedModel({ providerID: 'provider-1', modelID: 'model-1' });
    routingStore.setModelVisible('provider-1', 'model-1', false);

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(false);
    expect(Object.keys(routingStore.getVisibleProviders(state.providers)[0]?.models ?? {})).toEqual(
      ['model-2']
    );
    expect(state.selectedModel).toBeNull();

    routingStore.setProviderVisible('provider-1', false);

    expect(routingStore.isProviderVisible('provider-1')).toBe(false);
    expect(routingStore.getVisibleProviders(state.providers)).toEqual([]);
  });

  it('hides superseded models when a provider is first connected', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1'],
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2'],
      family: 'model',
      release_date: '2026-01-01',
    };

    routingStore.setProviders([connected], {}, ['provider-1']);

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(false);
    expect(routingStore.isModelVisible('provider-1', 'model-2')).toBe(true);

    routingStore.setModelVisible('provider-1', 'model-1', true);
    routingStore.setProviders([connected]);

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
  });

  it('keeps the provider default enabled on first connection', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1'],
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2'],
      family: 'model',
      release_date: '2026-01-01',
    };

    routingStore.setProviders([connected], { 'provider-1': 'model-1' }, ['provider-1']);

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
  });

  it('does not change checkbox choices when newer models appear', () => {
    const connected = createProvider('provider-1');
    connected.models['model-1'] = {
      ...connected.models['model-1'],
      family: 'model',
      release_date: '2025-01-01',
    };
    connected.models['model-2'] = {
      ...connected.models['model-2'],
      family: 'model',
      release_date: '2026-01-01',
    };
    routingStore.setProviders([connected], {}, ['provider-1']);
    routingStore.setModelVisible('provider-1', 'model-1', true);
    routingStore.setModelVisible('provider-1', 'model-2', false);

    const refreshed = createProvider('provider-1');
    refreshed.models = {
      ...connected.models,
      'model-3': {
        ...connected.models['model-2'],
        id: 'model-3',
        name: 'Model 3',
        release_date: '2027-01-01',
      },
    };
    routingStore.setProviders([refreshed]);

    expect(routingStore.isModelVisible('provider-1', 'model-1')).toBe(true);
    expect(routingStore.isModelVisible('provider-1', 'model-2')).toBe(false);
    expect(routingStore.isModelVisible('provider-1', 'model-3')).toBe(true);
  });
});
