import { describe, expect, it } from 'vitest';
import { getProviderIcon } from './provider-icons';

describe('getProviderIcon', () => {
  it('returns null for null input', () => {
    expect(getProviderIcon(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(getProviderIcon(undefined)).toBeNull();
  });

  it('returns null for empty string input', () => {
    expect(getProviderIcon('')).toBeNull();
  });

  it('returns null for an unknown provider', () => {
    expect(getProviderIcon('unknown-provider')).toBeNull();
  });

  it('returns an icon for openai', () => {
    expect(getProviderIcon('openai')).toBeTruthy();
  });

  it.each([
    'anthropic',
    'openrouter',
    'gemini',
    'google',
    'deepseek',
    'xai',
    'github-copilot',
    'zai',
    'zai-coding-plan',
    'opencode',
    'opencode-go',
    'qwen',
    'kimi',
  ])('returns a truthy icon for known provider "%s"', (provider) => {
    expect(getProviderIcon(provider)).toBeTruthy();
  });

  it('returns the same icon for google and gemini', () => {
    expect(getProviderIcon('google')).toBe(getProviderIcon('gemini'));
  });

  it('returns the same icon for zai and zai-coding-plan', () => {
    expect(getProviderIcon('zai')).toBe(getProviderIcon('zai-coding-plan'));
  });

  it('returns the same icon for opencode and opencode-go', () => {
    expect(getProviderIcon('opencode')).toBe(getProviderIcon('opencode-go'));
  });
});
