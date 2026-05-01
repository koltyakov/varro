import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterAdapter } from './openrouter';
import type { ProviderMetadata } from '../../util/provider-limit';

const adapter = createOpenRouterAdapter();

const provider: ProviderMetadata = {
  id: 'openrouter',
  options: { apiKey: 'sk-or-v1-test' },
  models: {},
};

describe('createOpenRouterAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches OpenRouter when auth is available', () => {
    expect(
      adapter.matches(provider, {
        openrouter: { type: 'api', key: 'sk-or-v1-test' },
      })
    ).toBe(true);
  });

  it('parses a bounded spend window from the auth key endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            label: 'Personal key',
            usage: 17.5,
            limit: 25,
            limit_remaining: 7.5,
            usage_daily: 1.25,
            usage_weekly: 4.5,
            usage_monthly: 17.5,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled OpenRouter auth key endpoint',
      windows: [
        {
          id: 'spend',
          label: 'Spend',
          unit: 'usd',
          remaining: 7.5,
          limit: 25,
          resetAt: null,
          percent: 70,
        },
      ],
    });
  });

  it('derives remaining spend when the endpoint omits limit_remaining', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            usage: 12.25,
            limit: 20,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      modelID: 'qwen3-coder-30b',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: 'qwen3-coder-30b',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled OpenRouter auth key endpoint',
      windows: [
        {
          id: 'spend',
          label: 'Spend',
          unit: 'usd',
          remaining: 7.75,
          limit: 20,
          resetAt: null,
          percent: 61.25,
        },
      ],
    });
  });

  it('treats auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'OpenRouter auth key endpoint rejected credentials (401)',
    });
  });

  it('reports unsupported when OpenRouter does not expose a bounded spend limit', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            usage: 3.5,
            limit: null,
            limit_remaining: null,
            is_free_tier: true,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'OpenRouter auth key endpoint did not expose a bounded spend limit',
    });
  });
});
