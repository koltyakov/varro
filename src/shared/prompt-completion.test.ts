import { describe, expect, it } from 'vitest';
import {
  getPromptCompletionVariant,
  normalizePromptSuffix,
  parsePromptCompletionRequest,
  parsePromptCompletionTestRequest,
  recentCompletionPrompts,
} from './prompt-completion';
import type { Provider } from './opencode-types';

function completionProvider(
  variants: NonNullable<Provider['models'][string]['variants']>,
  modelID = 'fast'
): Provider {
  return {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    models: {
      [modelID]: {
        id: modelID,
        name: 'Fast',
        capabilities: {},
        cost: { input: 0, output: 0 },
        variants,
      },
    },
  };
}

describe('prompt completion reasoning', () => {
  it.each([
    [{ high: {}, low: {}, minimal: {}, none: {} }, 'none'],
    [{ high: {}, low: {}, minimal: {} }, 'minimal'],
    [{ high: {}, low: {} }, 'low'],
    [{ xhigh: {}, medium: {}, high: {} }, 'medium'],
    [{ none: { disabled: true }, low: {} }, 'low'],
    [{ custom: { reasoningEffort: 'none' }, low: {} }, 'custom'],
    [{ custom: { options: { reasoning_effort: 'minimal' } }, low: {} }, 'custom'],
    [{ custom: { settings: { reasoningEffort: 'none' } }, low: {} }, 'custom'],
    [{ custom: { settings: { reasoning: { effort: 'minimal' } } }, low: {} }, 'custom'],
    [{ custom: { options: { reasoning: { effort: 'minimal' } } }, low: {} }, 'custom'],
    [{ custom: { reasoning: { effort: 'minimal' } }, low: {} }, 'custom'],
    [{ custom: { settings: { reasoning: { enabled: false } } }, low: {} }, 'custom'],
    [{ custom: { settings: { thinking: { type: 'disabled' } } }, low: {} }, 'custom'],
    [{ custom: { options: { thinking: { type: 'disabled' } } }, low: {} }, 'custom'],
    [{ custom: { body: { thinking: { type: 'disabled' } } }, low: {} }, 'custom'],
    [
      { custom: { settings: { reasoning: { enabled: false, effort: 'high' } } }, low: {} },
      'custom',
    ],
    [{ custom: { body: { reasoning: { effort: 'none' } } }, low: {} }, 'custom'],
    [{ custom: { body: { reasoning_effort: 'minimal' } }, low: {} }, 'custom'],
    [{ low: { reasoningEffort: 'high' }, minimal: {} }, 'minimal'],
    [{ priority: {} }, undefined],
  ])('selects the lowest advertised effort regardless of variant order', (variants, expected) => {
    expect(getPromptCompletionVariant('openai/fast', [completionProvider(variants)])).toBe(
      expected
    );
  });

  it('does not guess variants for unavailable models or providers', () => {
    const providers = [completionProvider({ none: {} })];
    for (const route of ['', 'invalid', 'other/fast', 'openai/missing']) {
      expect(getPromptCompletionVariant(route, providers)).toBeUndefined();
    }
  });

  it('preserves model-specific variant normalization', () => {
    expect(
      getPromptCompletionVariant('openai/gpt-5.5', [completionProvider({ minimal: {} }, 'gpt-5.5')])
    ).toBe('low');
  });
});

describe('prompt completion boundaries', () => {
  it('validates test models while retaining slash-delimited model IDs', () => {
    const model = { providerID: 'openrouter', modelID: 'openai/gpt-6-luna' };
    expect(parsePromptCompletionTestRequest(model)).toEqual(model);
    for (const value of [
      null,
      {},
      { ...model, providerID: '' },
      { ...model, providerID: 'a/b' },
      { ...model, providerID: 'x'.repeat(257) },
      { ...model, modelID: 2 },
      { ...model, modelID: 'x'.repeat(501) },
    ]) {
      expect(() => parsePromptCompletionTestRequest(value)).toThrow(
        'Invalid prompt completion test model'
      );
    }
  });
  it('keeps the last ten prompts in order, preserving repeats and bounding their length', () => {
    const history = [
      'older',
      ...Array.from({ length: 10 }, (_, index) => `prompt ${index}`),
      'prompt 8',
      ' ',
      'x'.repeat(2_000),
    ];
    const result = recentCompletionPrompts(history);
    expect(result).toHaveLength(10);
    expect(result[0]).toBe('prompt 2');
    expect(result.at(-2)).toBe('prompt 8');
    expect(result.at(-1)).toHaveLength(1_000);
    expect(result.filter((text) => text === 'prompt 8')).toHaveLength(2);
  });

  it.each([
    null,
    {},
    { draft: 'ab', history: [] },
    { draft: 'x'.repeat(4_001), history: [] },
    { draft: 'valid', history: [3] },
    { draft: 'valid', history: Array(11).fill('prompt') },
    { draft: 'valid', history: ['x'.repeat(1_001)] },
    { draft: 'valid', history: [], variant: 3 },
    { draft: 'valid', history: [], variant: '' },
    { draft: 'valid', history: [], variant: 'x'.repeat(101) },
    { draft: 'valid', history: [], lastAssistantResponse: null },
    { draft: 'valid', history: [], lastAssistantResponse: 3 },
    { draft: 'valid', history: [], lastAssistantResponse: 'x'.repeat(6_001) },
  ])('rejects malformed or oversized requests', (value) => {
    expect(() => parsePromptCompletionRequest(value)).toThrow('Invalid prompt completion request');
  });

  it('preserves a validated reasoning variant without changing the draft', () => {
    const request = { draft: 'Add a test', history: [], variant: 'none' };
    expect(parsePromptCompletionRequest(request)).toEqual(request);
  });

  it('preserves the optional latest agent reply, including the maximum length', () => {
    const request = {
      draft: 'Please fix',
      history: ['Add tests'],
      lastAssistantResponse: 'x'.repeat(6_000),
    };
    expect(parsePromptCompletionRequest(request)).toEqual(request);
  });

  it('accepts ten historical prompts, including repeated prompts equal to the current draft', () => {
    const history = Array<string>(10).fill('Add a feature');
    expect(recentCompletionPrompts(history)).toEqual(history);
    expect(parsePromptCompletionRequest({ draft: 'Add a feature', history })).toEqual({
      draft: 'Add a feature',
      history,
    });
  });

  it('preserves needed spaces and discards invalid suggestions', () => {
    expect(normalizePromptSuffix(' with tests  ', 'Add a feature')).toBe(' with tests');
    expect(normalizePromptSuffix('Add a feature with tests', 'Add a feature')).toBe(' with tests');
    for (const value of [null, 3, '', '  ', 'x'.repeat(241), '\u0000invalid']) {
      expect(normalizePromptSuffix(value, 'draft')).toBe('');
    }
  });
});
