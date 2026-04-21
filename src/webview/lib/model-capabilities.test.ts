import { describe, expect, it } from 'vitest';
import type { Provider } from '../types';
import { modelSupportsReasoning, modelSupportsVision } from './model-capabilities';

function provider(id: string, models: Provider['models']): Provider {
  return {
    id,
    name: id,
    source: 'api',
    models,
  };
}

describe('model capability helpers', () => {
  it('uses explicit vision metadata when present', () => {
    const providers: Provider[] = [
      provider('openai', {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true, vision: false },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(modelSupportsVision('openai', 'gpt-5', providers)).toBe(false);
  });

  it('falls back to common multimodal model identifiers when vision metadata is absent', () => {
    const providers: Provider[] = [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
        'qwen3-coder-30b': {
          id: 'qwen3-coder-30b',
          name: 'Qwen3 Coder 30B',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(modelSupportsVision('openai', 'gpt-4o', providers)).toBe(true);
    expect(modelSupportsVision('openai', 'qwen3-coder-30b', providers)).toBe(false);
  });

  it('keeps reasoning detection based on capabilities or variants', () => {
    const providers: Provider[] = [
      provider('anthropic', {
        'claude-sonnet': {
          id: 'claude-sonnet',
          name: 'Claude Sonnet',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: { high: {} },
        },
      }),
    ];

    expect(modelSupportsReasoning('anthropic', 'claude-sonnet', providers)).toBe(true);
  });
});
