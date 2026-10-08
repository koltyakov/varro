import { describe, expect, it } from 'vitest';
import type { Agent, Provider } from '../types';
import { canDelegateVision } from './vision-delegation';

const providers: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    models: {
      'gpt-4.1-mini': {
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        capabilities: { vision: true, toolcall: true },
        cost: { input: 0, output: 0 },
      },
    },
  },
];

function visionAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: 'vision',
    mode: 'subagent',
    permission: [],
    model: { providerID: 'openai', modelID: 'gpt-4.1-mini' },
    ...overrides,
  };
}

describe('canDelegateVision', () => {
  it('automatically enables a configured vision subagent', () => {
    expect(canDelegateVision([visionAgent()], providers)).toBe(true);
  });

  it('accepts an agent with all mode', () => {
    expect(canDelegateVision([visionAgent({ mode: 'all' })], providers)).toBe(true);
  });

  it.each<Partial<Agent>>([
    { name: 'visionary' },
    { model: undefined },
    { hidden: true },
    { mode: 'primary' },
    { model: { providerID: 'missing', modelID: 'gpt-4.1-mini' } },
    { model: { providerID: 'openai', modelID: 'missing' } },
  ])('rejects an unavailable vision subagent: %j', (overrides) => {
    expect(canDelegateVision([visionAgent(overrides)], providers)).toBe(false);
  });

  it('rejects missing agents and a model without image input', () => {
    expect(canDelegateVision([], providers)).toBe(false);
    const textProviders = providers.map((provider) => ({
      ...provider,
      models: {
        'gpt-4.1-mini': {
          id: 'gpt-4.1-mini',
          name: 'GPT-4.1 mini',
          cost: { input: 0, output: 0 },
          capabilities: { vision: false, toolcall: true },
        },
      },
    }));
    expect(canDelegateVision([visionAgent()], textProviders)).toBe(false);
  });
});
