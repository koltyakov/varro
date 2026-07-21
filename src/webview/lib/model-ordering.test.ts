import { describe, expect, it } from 'vitest';
import type { Provider } from '../types';
import { getSupersededModelIds, sortProviderModels } from './model-ordering';

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
  it('orders models by newest release without prioritizing the provider default', () => {
    const models = [
      createModel('older', 'Older', { release_date: '2025-01-01' }),
      createModel('default', 'Default', { release_date: '2024-01-01' }),
      createModel('newer', 'Newer', { release_date: '2026-01-01' }),
    ];

    expect(sortProviderModels(models).map((model) => model.id)).toEqual([
      'newer',
      'older',
      'default',
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

describe('getSupersededModelIds', () => {
  it('finds older releases in the same family and role lane', () => {
    const models = [
      createModel('claude-opus-4-1', 'Claude Opus 4.1', {
        family: 'claude-opus',
        release_date: '2025-08-05',
      }),
      createModel('claude-opus-4-8', 'Claude Opus 4.8', {
        family: 'claude-opus',
        release_date: '2026-05-28',
      }),
      createModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', {
        family: 'claude-sonnet',
        release_date: '2026-02-17',
      }),
    ];

    expect([...getSupersededModelIds(models)]).toEqual(['claude-opus-4-1']);
  });

  it('keeps model roles and output modalities in separate lanes', () => {
    const models = [
      createModel('gpt-4o', 'GPT-4o', {
        family: 'gpt',
        release_date: '2024-05-13',
      }),
      createModel('gpt-5', 'GPT-5', { family: 'gpt', release_date: '2025-08-07' }),
      createModel('gpt-4o-mini', 'GPT-4o Mini', {
        family: 'gpt',
        release_date: '2024-07-18',
      }),
      createModel('gpt-5-codex', 'GPT-5 Codex', {
        family: 'gpt',
        release_date: '2025-09-15',
      }),
      createModel('gpt-5-image', 'GPT-5 Image', {
        family: 'gpt',
        release_date: '2025-10-01',
        capabilities: { output: ['image'] },
      }),
    ];

    expect([...getSupersededModelIds(models)]).toEqual(['gpt-4o']);
  });

  it('does not let previews or undated models supersede stable releases', () => {
    const models = [
      createModel('gemini-2.5-flash', 'Gemini 2.5 Flash', {
        family: 'gemini-flash',
        release_date: '2025-05-20',
      }),
      createModel('gemini-3-flash', 'Gemini 3 Flash', {
        family: 'gemini-flash',
        release_date: '2026-01-01',
        status: 'beta',
      }),
      createModel('gemini-flash-latest', 'Gemini Flash Latest', {
        family: 'gemini-flash',
      }),
    ];

    expect([...getSupersededModelIds(models)]).toEqual([]);
  });

  it('supersedes deprecated siblings when a stable alternative exists', () => {
    const models = [
      createModel('mistral-medium-2505', 'Mistral Medium 2505', {
        family: 'mistral-medium',
        status: 'deprecated',
      }),
      createModel('mistral-medium-2604', 'Mistral Medium 2604', {
        family: 'mistral-medium',
      }),
    ];

    expect([...getSupersededModelIds(models)]).toEqual(['mistral-medium-2505']);
  });
});
