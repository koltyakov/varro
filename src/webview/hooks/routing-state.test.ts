import { describe, expect, it } from 'vitest';
import type { Provider, Agent } from '../types';
import {
  deriveSelectedAgentFromMessages,
  deriveSelectedModelFromMessages,
  deriveSelectedModelFromSession,
  getActiveProviderSelection,
  getBuildAgentName,
  getDefaultPrimaryAgentName,
  getUsageLimitNoticeContext,
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

  it('preserves the persisted draft agent and cleans up invalid session selections', () => {
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

  it('uses a temporary default when the persisted draft agent is unavailable', () => {
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
    ).toEqual({ value: 'plan', options: { persistGlobal: false } });
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
        defaultModel: { providerID: 'openai', modelID: 'gpt-5' },
      })
    ).toEqual({
      effectiveModel: null,
      nextSelectedModel: { providerID: 'openai', modelID: 'gpt-5' },
    });
  });

  it('uses provider defaults only when the exact default endpoint is unsupported', () => {
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
    ).toBeUndefined();
    expect(
      reconcileLoadedProviders({
        selectedModel: null,
        providers,
        providerDefaults: { openai: 'gpt-provider' },
      }).nextSelectedModel
    ).toEqual({ providerID: 'openai', modelID: 'gpt-provider' });
  });

  it('keeps a valid selected model over the exact server default', () => {
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
