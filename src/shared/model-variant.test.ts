import { describe, expect, it } from 'vitest';
import { normalizeModelVariant } from './model-variant';

describe('normalizeModelVariant', () => {
  it('maps the legacy GPT-5.5 minimal variant to low', () => {
    expect(normalizeModelVariant('gpt-5.5', 'minimal')).toBe('low');
  });

  it('preserves other variants and normalizes empty values to null', () => {
    expect(normalizeModelVariant('gpt-5.4', 'minimal')).toBe('minimal');
    expect(normalizeModelVariant('gpt-5.5', '')).toBeNull();
    expect(normalizeModelVariant(null, undefined)).toBeNull();
  });
});
