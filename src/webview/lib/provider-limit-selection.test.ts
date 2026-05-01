import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetProviderLimitWindowSelectionsForTests,
  clearSelectedProviderLimitWindowId,
  getSelectedProviderLimitWindowCheckedAt,
  getSelectedProviderLimitWindowId,
  setSelectedProviderLimitWindowId,
} from './provider-limit-selection';

describe('provider-limit-selection', () => {
  beforeEach(() => {
    __resetProviderLimitWindowSelectionsForTests();
    try {
      window.localStorage.clear();
    } catch {}
  });

  it('returns null when nothing is selected', () => {
    expect(getSelectedProviderLimitWindowId('openai')).toBeNull();
    expect(getSelectedProviderLimitWindowId(null)).toBeNull();
    expect(getSelectedProviderLimitWindowId(undefined)).toBeNull();
  });

  it('persists selection per provider and isolates providers', () => {
    setSelectedProviderLimitWindowId('openai', 'seven_day', 123);
    setSelectedProviderLimitWindowId('anthropic', 'monthly_limit');
    expect(getSelectedProviderLimitWindowId('openai')).toBe('seven_day');
    expect(getSelectedProviderLimitWindowCheckedAt('openai')).toBe(123);
    expect(getSelectedProviderLimitWindowId('anthropic')).toBe('monthly_limit');
  });

  it('clears a single provider without affecting others', () => {
    setSelectedProviderLimitWindowId('openai', 'seven_day');
    setSelectedProviderLimitWindowId('anthropic', 'monthly_limit');
    clearSelectedProviderLimitWindowId('openai');
    expect(getSelectedProviderLimitWindowId('openai')).toBeNull();
    expect(getSelectedProviderLimitWindowId('anthropic')).toBe('monthly_limit');
  });
});
