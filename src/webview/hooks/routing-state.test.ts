import { afterEach, describe, expect, it } from 'vitest';
import { resetDefaultAppState, setState } from '../lib/state';
import type { Provider, Agent } from '../types';
import {
  deriveSelectedAgentFromMessages,
  deriveSelectedModelFromMessages,
  deriveSelectedModelFromSession,
  getActiveProviderSelection,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  getUsageLimitNoticeContext,
  isProviderWorking,
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
  afterEach(() => resetDefaultAppState());
  it('counts busy and retry sessions for the provider regardless of the active tree', () => {
    const statuses = {
      active: { type: 'idle' as const },
      background: { type: 'busy' as const },
      child: { type: 'retry' as const, attempt: 1, message: 'Retrying', next: 1000 },
      unknown: { type: 'busy' as const },
    };
    const providers = new Map([
      ['active', 'openai'],
      ['background', 'openai'],
      ['child', 'anthropic'],
    ]);
    expect(isProviderWorking('openai', statuses, (id) => providers.get(id))).toBe(true);
    expect(isProviderWorking('anthropic', statuses, (id) => providers.get(id))).toBe(true);
    expect(isProviderWorking('other', statuses, (id) => providers.get(id))).toBe(false);
    expect(
      isProviderWorking('openai', { ...statuses, background: { type: 'idle' } }, (id) =>
        providers.get(id)
      )
    ).toBe(false);
  });

  it('prefers the build agent for default primary selection', () => {
    expect(getDefaultPrimaryAgentName([agent('plan'), agent('build')])).toBe('build');
    expect(getBuildAgentName([agent('plan'), agent('build')])).toBe('build');
  });

  it('preserves the selected draft agent and cleans up invalid session selections', () => {
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
      nextSelectedAgent: null,
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

  it('keeps the current draft choice instead of restoring a previous chat agent', () => {
    expect(
      reconcileLoadedAgents({
        loadedAgents: [agent('build')],
        activeSessionId: null,
        selectedAgent: 'plan',
        sessionSelectedAgent: null,
        persistedSelectedAgent: 'plan',
      }).nextSelectedAgent
    ).toEqual({ value: 'build', options: { persistGlobal: false } });

    expect(
      reconcileLoadedAgents({
        loadedAgents: [agent('plan'), agent('build')],
        activeSessionId: null,
        selectedAgent: 'build',
        sessionSelectedAgent: null,
        persistedSelectedAgent: 'plan',
      }).nextSelectedAgent
    ).toBeNull();
  });

  it('defaults fresh drafts to build even when ask was persisted', () => {
    expect(
      reconcileLoadedAgents({
        loadedAgents: [agent('ask'), agent('plan'), agent('build')],
        activeSessionId: null,
        selectedAgent: null,
        sessionSelectedAgent: null,
        persistedSelectedAgent: 'ask',
      }).nextSelectedAgent
    ).toEqual({ value: 'build', options: { persistGlobal: false } });
  });

  it('preserves an explicit ask choice in the current draft', () => {
    expect(
      reconcileLoadedAgents({
        loadedAgents: [agent('ask'), agent('build')],
        activeSessionId: null,
        selectedAgent: 'ask',
        sessionSelectedAgent: null,
        persistedSelectedAgent: 'build',
      }).nextSelectedAgent
    ).toBeNull();
  });

  it('falls back to an available primary agent when build is unavailable', () => {
    expect(getDefaultPrimaryAgentName([agent('plan'), agent('ask')])).toBe('plan');
    expect(getDefaultPrimaryAgentName([])).toBeNull();
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
      nextSelectedModel: undefined,
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
        defaultModel: { providerID: 'openai', modelID: 'gpt-5' },
      })
    ).toEqual({
      effectiveModel: null,
      nextSelectedModel: { providerID: 'openai', modelID: 'gpt-5' },
    });
  });

  it('uses visible provider defaults when the exact default is unavailable', () => {
    const providers = [
      provider('openai', {
        'gpt-provider': {
          id: 'gpt-provider',
          name: 'GPT Provider',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(
      reconcileLoadedProviders({
        selectedModel: null,
        providers,
        providerDefaults: { openai: 'gpt-provider' },
        defaultModel: null,
      }).nextSelectedModel
    ).toEqual({ providerID: 'openai', modelID: 'gpt-provider' });
    expect(
      reconcileLoadedProviders({
        selectedModel: null,
        providers,
        providerDefaults: { openai: 'gpt-provider' },
      }).nextSelectedModel
    ).toEqual({ providerID: 'openai', modelID: 'gpt-provider' });
  });

  it.each(['provider', 'model', 'removed'])('skips a %s-hidden automatic default', (hidden) => {
    const models = {
      hidden: {
        id: 'hidden',
        name: 'Hidden',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
      visible: {
        id: 'visible',
        name: 'Visible',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    };
    const providers = [provider('hidden-provider', models), provider('openai', models)];
    setState('providers', providers);
    if (hidden === 'provider') setState('hiddenProviders', ['hidden-provider']);
    if (hidden === 'model') setState('hiddenModels', ['hidden-provider:hidden']);
    if (hidden === 'removed') setState('removedModels', ['hidden-provider:hidden']);

    for (const selectedModel of [null, { providerID: 'hidden-provider', modelID: 'hidden' }]) {
      expect(
        reconcileLoadedProviders({
          selectedModel,
          providers,
          providerDefaults: { 'hidden-provider': 'hidden', openai: 'visible' },
          defaultModel: { providerID: 'hidden-provider', modelID: 'hidden' },
        }).nextSelectedModel
      ).toEqual({
        providerID: hidden === 'provider' ? 'openai' : 'hidden-provider',
        modelID: 'visible',
      });
    }
  });

  it('does not select anything when all configured models are hidden', () => {
    setState('hiddenProviders', ['openai']);
    expect(
      reconcileLoadedProviders({
        selectedModel: null,
        providers: [
          provider('openai', {
            model: {
              id: 'model',
              name: 'Model',
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
            },
          }),
        ],
        providerDefaults: { openai: 'model' },
      }).nextSelectedModel
    ).toBeUndefined();
  });

  it('replaces a hidden draft provider even when it is no longer connected', () => {
    setState('hiddenProviders', ['disconnected']);
    expect(
      reconcileLoadedProviders({
        selectedModel: { providerID: 'disconnected', modelID: 'old' },
        providers: [
          provider('openai', {
            model: {
              id: 'model',
              name: 'Model',
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
            },
          }),
        ],
        providerDefaults: { openai: 'model' },
      }).nextSelectedModel
    ).toEqual({ providerID: 'openai', modelID: 'model' });
  });

  it('only defaults to added models in a large provider catalog', () => {
    const models = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        `model-${index}`,
        {
          id: `model-${index}`,
          name: `Model ${index}`,
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      ])
    );
    const providers = [provider('catalog', models)];
    setState('providers', providers);
    setState('addedModels', ['catalog:model-59']);
    expect(
      reconcileLoadedProviders({
        selectedModel: null,
        providers,
        providerDefaults: { catalog: 'model-0' },
        defaultModel: { providerID: 'catalog', modelID: 'model-1' },
      }).nextSelectedModel
    ).toEqual({ providerID: 'catalog', modelID: 'model-59' });
  });

  it('prefers the last selected available model over the server default', () => {
    const models = {
      last: {
        id: 'last',
        name: 'Last',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
        variants: { high: {} },
      },
      default: {
        id: 'default',
        name: 'Default',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      },
    };
    const args = {
      selectedModel: null,
      providers: [provider('openai', models)],
      providerDefaults: { openai: 'default' },
      defaultModel: { providerID: 'openai', modelID: 'default' },
      lastSelectedModel: { providerID: 'openai', modelID: 'last', variant: 'high' },
    };
    expect(reconcileLoadedProviders(args).nextSelectedModel).toEqual(args.lastSelectedModel);
    expect(
      reconcileLoadedProviders({
        ...args,
        lastSelectedModel: { providerID: 'missing', modelID: 'last' },
      }).nextSelectedModel
    ).toEqual(args.defaultModel);
    setState('hiddenModels', ['openai:last']);
    expect(reconcileLoadedProviders(args).nextSelectedModel).toEqual(args.defaultModel);
  });

  it('keeps a valid selected model over the exact server default', () => {
    const selectedModel = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' };
    const models = {
      'gpt-6.1-sol': {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
        variants: { high: {} },
      },
    };
    const alternatives = [provider('openrouter', models), provider('github-copilot', models)];
    const providerDefaults = { openrouter: selectedModel.modelID };

    expect(
      reconcileLoadedProviders({
        selectedModel,
        providers: [...alternatives, provider('openai', models)],
        providerDefaults,
        defaultModel: { providerID: 'openrouter', modelID: selectedModel.modelID },
      })
    ).toEqual({ effectiveModel: selectedModel, nextSelectedModel: undefined });
    expect(
      getActiveProviderSelection({
        selectedModel,
        providers: alternatives,
        providerDefaults,
      })
    ).toBeNull();
  });

  it('keeps a valid selected model over a different model in the same provider', () => {
    const providers = [
      provider('openai', {
        selected: {
          id: 'selected',
          name: 'Selected',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
        server: {
          id: 'server',
          name: 'Server',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(
      reconcileLoadedProviders({
        selectedModel: { providerID: 'openai', modelID: 'selected' },
        providers,
        providerDefaults: {},
        defaultModel: { providerID: 'openai', modelID: 'server' },
      })
    ).toEqual({
      effectiveModel: { providerID: 'openai', modelID: 'selected' },
      nextSelectedModel: undefined,
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
        activeSessionId: 'existing-session',
        selectedModel: { providerID: 'anthropic', modelID: 'claude' },
        providers,
        providerDefaults: { openai: 'gpt-4o', anthropic: 'claude' },
      })
    ).toEqual({ providerID: 'anthropic', modelID: 'claude' });

    expect(
      getActiveProviderSelection({
        activeSessionId: null,
        selectedModel: null,
        providers,
        providerDefaults: { openai: 'gpt-4o', anthropic: 'claude' },
      })
    ).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('prefers the active Ralph model when present', () => {
    const providers = [
      provider('openai', {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
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
        activeSessionId: 'ralph-manager-1',
        selectedModel: { providerID: 'anthropic', modelID: 'claude' },
        providers,
        providerDefaults: { openai: 'gpt-5', anthropic: 'claude' },
        getActiveRalphModel: (sessionId) =>
          sessionId === 'ralph-manager-1' ? { providerID: 'openai', modelID: 'gpt-5' } : null,
      })
    ).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  it('derives the latest selected model and agent from messages', () => {
    const messages = [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant' as const,
          time: { created: 1 },
          parentID: 'user-1',
          modelID: 'gpt-4o',
          providerID: 'openai',
          variant: 'high',
          agent: 'build',
          mode: 'default' as const,
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
    ];

    expect(deriveSelectedModelFromMessages(messages)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
      variant: 'high',
    });
    expect(deriveSelectedAgentFromMessages(messages)).toBe('build');
  });

  it('derives the selected model and reasoning variant from session metadata', () => {
    expect(
      deriveSelectedModelFromSession({
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'External session',
        version: '1',
        model: { providerID: 'openai', id: 'gpt-5.6-luna', variant: 'max' },
        time: { created: 0, updated: 1 },
      })
    ).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
      variant: 'max',
    });
  });

  it('resolves usage-limit context from session, message, or fallback model selection', () => {
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
      getUsageLimitNoticeContext({
        sessionId: 'session-1',
        selectedModelForSession: { providerID: 'anthropic', modelID: 'claude' },
        providers,
        providerDefaults: { openai: 'gpt-4o', anthropic: 'claude' },
        fallbackSelectedModel: null,
      })
    ).toEqual({ providerID: 'anthropic', modelID: 'claude' });

    expect(
      getUsageLimitNoticeContext({
        sessionId: 'session-1',
        messages: [
          {
            info: {
              id: 'user-1',
              sessionID: 'session-1',
              role: 'user',
              time: { created: 0 },
              agent: 'build',
              model: { providerID: 'openai', modelID: 'gpt-4o' },
            },
            parts: [],
          },
        ],
        selectedModelForSession: null,
        providers,
        providerDefaults: { openai: 'gpt-4o', anthropic: 'claude' },
        fallbackSelectedModel: null,
      })
    ).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });
});
