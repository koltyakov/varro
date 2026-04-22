import { describe, expect, it } from 'vitest';
import { getMatchingVariant, getPreferredVariant } from './model-variants';
import type { Provider } from '../types';

function providerWithVariants(
  variants: NonNullable<Provider['models'][string]['variants']>
): Provider {
  return {
    id: 'provider',
    name: 'Provider',
    source: 'config',
    models: {
      model: {
        id: 'model',
        name: 'Model',
        capabilities: { toolcall: true, reasoning: true },
        cost: { input: 0, output: 0 },
        variants,
      },
    },
  };
}

describe('getPreferredVariant', () => {
  it('picks the option before the last one by default', () => {
    const providers = [
      providerWithVariants({
        low: {},
        medium: {},
        high: {},
      }),
    ];

    expect(getPreferredVariant('provider', 'model', providers)).toBe('medium');
  });

  it('prefers high when it is available before the last option', () => {
    const providers = [
      providerWithVariants({
        low: {},
        high: {},
        max: {},
      }),
    ];

    expect(getPreferredVariant('provider', 'model', providers)).toBe('high');
  });

  it('skips the penultimate option when it is the lowest reasoning tier', () => {
    const providers = [
      providerWithVariants({
        low_reasoning: {},
        high_reasoning: {},
      }),
    ];

    expect(getPreferredVariant('provider', 'model', providers)).toBe('high_reasoning');
  });

  it('falls back to the penultimate option when names have no reasoning signal', () => {
    const providers = [
      providerWithVariants({
        alpha: {},
        beta: {},
        gamma: {},
      }),
    ];

    expect(getPreferredVariant('provider', 'model', providers)).toBe('beta');
  });

  it('returns the only variant when there is just one option', () => {
    const providers = [
      providerWithVariants({
        high: {},
      }),
    ];

    expect(getPreferredVariant('provider', 'model', providers)).toBe('high');
  });
});

describe('getMatchingVariant', () => {
  it('preserves an exact variant name when the new model has it', () => {
    const providers = [
      {
        ...providerWithVariants({ low: {}, medium: {}, high: {} }),
        models: {
          source: {
            id: 'source',
            name: 'Source',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
          target: {
            id: 'target',
            name: 'Target',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
        },
      },
    ];

    expect(
      getMatchingVariant(
        { providerID: 'provider', modelID: 'source', variant: 'high' },
        { providerID: 'provider', modelID: 'target' },
        providers
      )
    ).toBe('high');
  });

  it('maps to the same reasoning tier by name when exact names differ', () => {
    const providers = [
      {
        ...providerWithVariants({}),
        models: {
          source: {
            id: 'source',
            name: 'Source',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
          target: {
            id: 'target',
            name: 'Target',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { minimal: {}, balanced: {}, deep: {} },
          },
        },
      },
    ];

    expect(
      getMatchingVariant(
        { providerID: 'provider', modelID: 'source', variant: 'medium' },
        { providerID: 'provider', modelID: 'target' },
        providers
      )
    ).toBe('balanced');
  });

  it('falls back to relative order when names do not expose reasoning levels', () => {
    const providers = [
      {
        ...providerWithVariants({}),
        models: {
          source: {
            id: 'source',
            name: 'Source',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
          target: {
            id: 'target',
            name: 'Target',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { alpha: {}, beta: {}, gamma: {}, delta: {} },
          },
        },
      },
    ];

    expect(
      getMatchingVariant(
        { providerID: 'provider', modelID: 'source', variant: 'medium' },
        { providerID: 'provider', modelID: 'target' },
        providers
      )
    ).toBe('gamma');
  });
});
