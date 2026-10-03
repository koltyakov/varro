import { describe, expect, it } from 'vitest';
import { parseModelPreferences, parseRequiredModelPreferences } from './model-preferences';

describe('model preference parsing bounds', () => {
  it('round-trips a last model and rejects malformed or oversized selections', () => {
    const lastSelectedModel = { providerID: 'openai', modelID: 'sol', variant: 'high' };
    const preferences = parseModelPreferences({ lastSelectedModel });
    expect(parseRequiredModelPreferences(preferences)?.lastSelectedModel).toEqual(
      lastSelectedModel
    );
    for (const invalid of [
      { providerID: '', modelID: 'sol' },
      { providerID: 'openai', modelID: 'x'.repeat(4097) },
      { ...lastSelectedModel, variant: 42 },
    ]) {
      expect(
        parseModelPreferences({ lastSelectedModel: invalid }).lastSelectedModel
      ).toBeUndefined();
      expect(
        parseRequiredModelPreferences({ ...preferences, lastSelectedModel: invalid })
      ).toBeNull();
    }
  });
  it('stops inspecting malformed arrays after the input budget', () => {
    const values: unknown[] = Array.from({ length: 20_001 }, () => 42);
    Object.defineProperty(values, 20_000, {
      get() {
        throw new Error('read beyond inspection budget');
      },
    });

    expect(parseModelPreferences({ hiddenModels: values }).hiddenModels).toEqual([]);
  });

  it('rejects required records above the persisted entry limit', () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`model-${index}`, 'value'])
    );
    expect(
      parseRequiredModelPreferences({
        modelVariantSelections: {},
        providerOrder: [],
        modelOrder: [],
        hiddenProviders: [],
        hiddenModels: [],
        addedModels: [],
        pinnedModels: [],
        modelDisplayNames: oversized,
      })
    ).toBeNull();
  });
});
