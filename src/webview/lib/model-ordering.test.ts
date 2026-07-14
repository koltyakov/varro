import { describe, expect, it } from 'vitest';
import type { Provider } from '../types';
import { sortProviderModels } from './model-ordering';

function createModel(
  id: string,
  name: string,
  overrides: Partial<Provider['models'][string]> = {}
) {
  return {
    id,
    name,
    capabilities: {},
    cost: { input: 1, output: 1 },
    ...overrides,
  } satisfies Provider['models'][string];
}

describe('sortProviderModels', () => {
  it('puts the provider default first, then orders models by newest release', () => {
    const models = [
      createModel('older', 'Older', { release_date: '2025-01-01' }),
      createModel('default', 'Default', { release_date: '2024-01-01' }),
      createModel('newer', 'Newer', { release_date: '2026-01-01' }),
    ];

    expect(sortProviderModels(models, 'default').map((model) => model.id)).toEqual([
      'default',
      'newer',
      'older',
    ]);
    expect(models.map((model) => model.id)).toEqual(['older', 'default', 'newer']);
  });

  it('puts deprecated models last and falls back to name for missing or invalid dates', () => {
    const models = [
      createModel('zebra', 'Zebra'),
      createModel('deprecated', 'Deprecated', {
        release_date: '2027-01-01',
        status: 'deprecated',
      }),
      createModel('alpha', 'Alpha', { release_date: 'not-a-date' }),
      createModel('dated', 'Dated', { release_date: '2025-01-01', status: 'active' }),
    ];

    expect(sortProviderModels(models).map((model) => model.id)).toEqual([
      'dated',
      'alpha',
      'zebra',
      'deprecated',
    ]);
  });

  it('orders GPT model tiers as Sol, Terra, then Luna', () => {
    const models = [
      createModel('gpt-5-luna', 'GPT-5 Luna', { release_date: '2027-01-01' }),
      createModel('gpt-5-sol', 'GPT-5 Sol', { release_date: '2024-01-01' }),
      createModel('gpt-5-standard', 'GPT-5 Standard', { release_date: '2028-01-01' }),
      createModel('gpt-5-terra', 'GPT-5 Terra', { release_date: '2025-01-01' }),
    ];

    expect(sortProviderModels(models).map((model) => model.id)).toEqual([
      'gpt-5-sol',
      'gpt-5-terra',
      'gpt-5-luna',
      'gpt-5-standard',
    ]);
  });

  it('does not apply GPT tier names to other model families', () => {
    const models = [
      createModel('other-sol', 'Other Sol', { release_date: '2024-01-01' }),
      createModel('other-standard', 'Other Standard', { release_date: '2025-01-01' }),
    ];

    expect(sortProviderModels(models).map((model) => model.id)).toEqual([
      'other-standard',
      'other-sol',
    ]);
  });
});
