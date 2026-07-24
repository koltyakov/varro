import { describe, expect, it } from 'vitest';
import { findProviderLimitAdapter } from './index';
import type { ProviderMetadata } from '../util/provider-limit';

describe('provider limit adapters', () => {
  it('prefers the Codex adapter for OAuth-backed OpenAI providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'openai',
        options: { apiKey: 'opencode-oauth-dummy-key' },
        models: { 'gpt-5.4': { api: { url: 'https://api.openai.com/v1' } } },
      },
      { openai: { type: 'oauth', access: 'token-1' } }
    );

    expect(adapter?.id).toBe('openai');
  });

  it('matches the existing OpenAI adapter path for API-key OpenAI providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'openai',
        options: { apiKey: 'sk-openai-api-key' },
        models: { 'gpt-5.4': { api: { url: 'https://api.openai.com/v1' } } },
      },
      { openai: { type: 'api', key: 'sk-openai-api-key' } }
    );

    expect(adapter?.id).toBe('openai');
  });

  it('matches the Anthropic adapter for Anthropic providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'anthropic',
        options: { apiKey: 'opencode-oauth-dummy-key' },
        models: { 'claude-sonnet-4': { api: { url: 'https://api.anthropic.com/v1' } } },
      },
      { anthropic: { type: 'oauth', access: 'token-1' } }
    );

    expect(adapter?.id).toBe('anthropic');
  });

  it('prefers the rich GitHub Copilot adapter over the header probe', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'github-copilot',
        options: { apiKey: 'opencode-oauth-dummy-key' },
        models: { 'gpt-4.1': { api: { url: 'https://api.githubcopilot.com' } } },
      },
      { 'github-copilot': { type: 'oauth', access: 'token-1' } }
    );

    expect(adapter?.id).toBe('github-copilot');
  });

  it('matches the OpenRouter adapter for OpenRouter providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'openrouter',
        options: { apiKey: 'sk-or-v1-test' },
        models: { 'qwen3-coder-30b': { api: { url: 'https://openrouter.ai/api/v1' } } },
      },
      { openrouter: { type: 'api', key: 'sk-or-v1-test' } }
    );

    expect(adapter?.id).toBe('openrouter');
  });

  it('matches the Gemini adapter for Gemini provider aliases', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'google',
        models: { 'gemini-2.5-pro': { api: { url: 'https://cloudcode-pa.googleapis.com' } } },
      },
      { gemini: { type: 'oauth', access: 'token-1' } },
      { enabledAdapterIDs: new Set(['gemini']) }
    );

    expect(adapter?.id).toBe('gemini');
  });

  it('matches the Z.ai adapter for Z.ai provider aliases', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'zai-coding-plan',
        options: { apiKey: 'zai_test_key_12345' },
        models: { 'glm-4.5': { api: { url: 'https://api.z.ai/api' } } },
      },
      { 'zai-coding-plan': { type: 'api', key: 'zai_test_key_12345' } }
    );

    expect(adapter?.id).toBe('zai');
  });

  it('matches the MiniMax adapter for MiniMax providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'minimax',
        options: { apiKey: 'minimax_test_key_12345' },
        models: { 'MiniMax-M2': { api: { url: 'https://api.minimax.io/v1' } } },
      },
      { minimax: { type: 'api', key: 'minimax_test_key_12345' } }
    );

    expect(adapter?.id).toBe('minimax');
  });

  it('matches the Kimi adapter for Kimi For Coding providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'kimi-for-coding',
        options: { apiKey: 'kimi_test_key_12345' },
        models: { 'kimi-for-coding': { api: { url: 'https://api.kimi.com/coding/v1' } } },
      },
      { 'kimi-for-coding': { type: 'api', key: 'kimi_test_key_12345' } }
    );

    expect(adapter?.id).toBe('kimi');
  });

  it('matches the Antigravity adapter only when explicitly enabled', () => {
    const provider: ProviderMetadata = {
      id: 'antigravity',
      models: { 'claude-4-5-sonnet': { api: { url: 'https://127.0.0.1:42100' } } },
    };

    expect(
      findProviderLimitAdapter(provider, {}, { enabledAdapterIDs: new Set(['openai']) })
    ).toBeNull();
    expect(
      findProviderLimitAdapter(provider, {}, { enabledAdapterIDs: new Set(['antigravity']) })?.id
    ).toBe('antigravity');
  });

  it('does not match unknown providers', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'custom',
        models: { model: { api: { url: 'https://provider.example.test/v1' } } },
      } as ProviderMetadata,
      { custom: { type: 'api', key: 'secret-token' } }
    );

    expect(adapter).toBeNull();
  });

  it('skips adapters disabled by configuration', () => {
    const adapter = findProviderLimitAdapter(
      {
        id: 'openrouter',
        options: { apiKey: 'sk-or-v1-test' },
        models: { 'qwen3-coder-30b': { api: { url: 'https://openrouter.ai/api/v1' } } },
      },
      { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      { enabledAdapterIDs: new Set(['openai']) }
    );

    expect(adapter).toBeNull();
  });
});
