import { describe, expect, it } from 'vitest';
import { getVariantsForModel } from './model-variants';
import type { Provider } from '../types';

function providerWithVariants(
  variants: NonNullable<Provider['models'][string]['variants']>,
  modelID = 'model'
): Provider {
  return {
    id: 'provider',
    name: 'Provider',
    source: 'config',
    models: {
      [modelID]: {
        id: modelID,
        name: 'Model',
        capabilities: { toolcall: true, reasoning: true },
        cost: { input: 0, output: 0 },
        variants,
      },
    },
  };
}

describe('getVariantsForModel', () => {
  it('preserves every Sol reasoning option in provider order', () => {
    const providers = [
      providerWithVariants({ none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} }, 'sol'),
    ];

    expect(getVariantsForModel('provider', 'sol', providers)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});
