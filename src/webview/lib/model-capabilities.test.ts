import { describe, expect, it } from 'vitest';
import type { Provider } from '../types';
import {
  modelSupportsReasoning,
  modelSupportsTools,
  modelSupportsVariants,
  modelSupportsVision,
} from './model-capabilities';

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

  it('detects tool support from capability metadata', () => {
    const providers: Provider[] = [
      provider('openai', {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
        'text-only': {
          id: 'text-only',
          name: 'Text Only',
          capabilities: { toolcall: false },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(modelSupportsTools('openai', 'gpt-5', providers)).toBe(true);
    expect(modelSupportsTools('openai', 'text-only', providers)).toBe(false);
  });

  it('supports tool support from legacy and alternate keys', () => {
    const providers: Provider[] = [
      provider('openai', {
        'v2-style': {
          id: 'v2-style',
          name: 'V2 Style',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
          cost: { input: 0, output: 0 },
        },
        'legacy-tool-field': {
          id: 'legacy-tool-field',
          name: 'Legacy Tool Field',
          capabilities: { tool_call: true, input: ['text'], output: ['text'] },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(modelSupportsTools('openai', 'v2-style', providers)).toBe(true);
    expect(modelSupportsTools('openai', 'legacy-tool-field', providers)).toBe(true);
  });

  it('reads image support from capability modality arrays', () => {
    const providers: Provider[] = [
      provider('openai', {
        'vision-list': {
          id: 'vision-list',
          name: 'Vision List',
          capabilities: {
            toolcall: true,
            input: ['text', 'image'],
            output: ['text'],
          },
          cost: { input: 0, output: 0 },
        },
      }),
      provider('openai', {
        'text-only-list': {
          id: 'text-only-list',
          name: 'Text Only List',
          capabilities: {
            toolcall: true,
            input: ['text'],
            output: ['text'],
          },
          cost: { input: 0, output: 0 },
        },
      }),
    ];

    expect(modelSupportsVision('openai', 'vision-list', providers)).toBe(true);
    expect(modelSupportsVision('openai', 'text-only-list', providers)).toBe(false);
  });

  it('detects variants while ignoring the none placeholder', () => {
    const providers: Provider[] = [
      provider('openai', {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: { none: {}, high: {} },
        },
        'plain-model': {
          id: 'plain-model',
          name: 'Plain Model',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: { none: {} },
        },
      }),
    ];

    expect(modelSupportsVariants('openai', 'gpt-5', providers)).toBe(true);
    expect(modelSupportsVariants('openai', 'plain-model', providers)).toBe(false);
  });
});
