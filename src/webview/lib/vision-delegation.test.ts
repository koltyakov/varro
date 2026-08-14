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
  it('accepts an exact mention of a configured vision subagent', () => {
    expect(
      canDelegateVision('Please ask @vision, then summarize.', [visionAgent()], providers)
    ).toBe(true);
  });

  it('accepts an exact mention from earlier session text', () => {
    expect(
      canDelegateVision(
        ['Inspect this image', 'Earlier I asked @vision for help'],
        [visionAgent()],
        providers
      )
    ).toBe(true);
  });

  it('rejects partial mentions and agents without an explicit vision model', () => {
    expect(canDelegateVision('Ask @visionary', [visionAgent()], providers)).toBe(false);
    expect(canDelegateVision('Ask @vision', [visionAgent({ model: undefined })], providers)).toBe(
      false
    );
  });
});
