import { describe, expect, it } from 'vitest';
import type { Provider, Agent } from '../types';
import {
  getActiveProviderSelection,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  reconcileLoadedAgents,
  reconcileLoadedProviders,
} from './routing-state';

function provider(id: string, models: Provider['models']): Provider {
  return {
    id,
    name: id,
    source: 'api',
    models,
  };
}

function agent(name: string, overrides?: Partial<Agent>): Agent {
  return {
    name,
    mode: 'primary',
    builtIn: true,
    permission: { edit: 'ask', bash: {} },
    tools: {},
    ...overrides,
  };
}

describe('routing-state helpers', () => {
  it('prefers the build agent for default primary selection', () => {
    expect(getDefaultPrimaryAgentName([agent('plan'), agent('build')])).toBe('build');
    expect(getBuildAgentName([agent('plan'), agent('build')])).toBe('build');
  });

  it('reconciles loaded agents for startup and invalid selection cleanup', () => {
    const loadedAgents = [agent('plan'), agent('build'), agent('review', { hidden: true })];

    expect(
      reconcileLoadedAgents({
        loadedAgents,
        activeSessionId: null,
        selectedAgent: 'plan',
        sessionSelectedAgent: null,
        persistedSelectedAgent: 'plan',
      })
    ).toMatchObject({
      visibleAgents: [agent('plan'), agent('build')],
      primaryAgents: [agent('plan'), agent('build')],
      nextSelectedAgent: {
        value: 'build',
        options: { persistGlobal: false },
      },
    });

    expect(
      reconcileLoadedAgents({
        loadedAgents: [agent('plan')],
        activeSessionId: 'session-1',
        selectedAgent: 'build',
        sessionSelectedAgent: 'build',
        persistedSelectedAgent: 'build',
      })
    ).toMatchObject({
      nextSelectedAgent: {
        value: null,
        options: { sessionId: 'session-1', persistGlobal: false },
      },
    });
  });

  it('restores the best available session agent for active sessions', () => {
    const result = reconcileLoadedAgents({
      loadedAgents: [agent('build'), agent('plan')],
      activeSessionId: 'session-1',
      selectedAgent: null,
      sessionSelectedAgent: 'plan',
      persistedSelectedAgent: 'build',
    });

    expect(result.nextSelectedAgent).toEqual({
      value: 'plan',
      options: { sessionId: 'session-1', persistGlobal: false },
    });
  });

  it('reconciles loaded providers for invalid, variant, and empty selections', () => {
    const providers = [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
          variants: { low: {}, high: {} },
        },
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(
      reconcileLoadedProviders({
        selectedModel: { providerID: 'missing', modelID: 'none' },
        providers,
        providerDefaults: { openai: 'gpt-4o' },
      })
    ).toEqual({
      effectiveModel: null,
      nextSelectedModel: null,
    });

    expect(
      reconcileLoadedProviders({
        selectedModel: { providerID: 'openai', modelID: 'gpt-5', variant: 'high' },
        providers,
        providerDefaults: { openai: 'gpt-4o' },
      })
    ).toEqual({
      effectiveModel: { providerID: 'openai', modelID: 'gpt-5' },
      nextSelectedModel: { providerID: 'openai', modelID: 'gpt-5' },
    });

    expect(
      reconcileLoadedProviders({
        selectedModel: null,
        providers,
        providerDefaults: { openai: 'gpt-4o' },
      })
    ).toEqual({
      effectiveModel: null,
      nextSelectedModel: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('returns the active provider selection from selected or fallback models', () => {
    const providers = [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
      provider('anthropic', {
        claude: {
          id: 'claude',
          name: 'Claude',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(
      getActiveProviderSelection({
        selectedModel: { providerID: 'anthropic', modelID: 'claude' },
        providers,
        providerDefaults: { openai: 'gpt-4o', anthropic: 'claude' },
      })
    ).toEqual({ providerID: 'anthropic', modelID: 'claude' });

    expect(
      getActiveProviderSelection({
        selectedModel: null,
        providers,
        providerDefaults: { openai: 'gpt-4o', anthropic: 'claude' },
      })
    ).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });
});
