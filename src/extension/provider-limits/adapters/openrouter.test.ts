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

    expect(
      adapter.matches(
        {
          ...provider,
          options: { apiKey: 'opencode-oauth-dummy-key' },
        },
        {}
      )
    ).toBe(false);
  });

  it('returns unsupported without usable OpenRouter credentials', async () => {
    const status = await adapter.fetch({
      provider: {
        ...provider,
        options: { apiKey: 'opencode-oauth-dummy-key' },
      },
      authStore: {},
      modelID: 'openrouter/sonoma-sky-alpha',
      checkedAt: 1_000,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: 'openrouter/sonoma-sky-alpha',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'No OpenRouter credentials available',
    });
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

  it('accepts oauth auth and camelCase spend fields', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            usage: '250',
            limit: '1,000',
            limitRemaining: '750',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider: {
        ...provider,
        options: { apiKey: 'opencode-oauth-dummy-key' },
      },
      authStore: { openrouter: { type: 'oauth', access: 'oauth-openrouter-token' } },
      modelID: 'openrouter/quasar-beta',
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/auth/key',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-openrouter-token',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: 'openrouter/quasar-beta',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled OpenRouter auth key endpoint',
      windows: [
        {
          id: 'spend',
          label: 'Spend',
          unit: 'usd',
          remaining: 750,
          limit: 1000,
          resetAt: null,
          percent: 25,
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

  it('reports non-auth endpoint failures as errors', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 429 }));

    const status = await adapter.fetch({
      provider,
      authStore: { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'OpenRouter auth key endpoint returned 429',
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

  it('reports invalid JSON payloads as errors', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{invalid-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { openrouter: { type: 'api', key: 'sk-or-v1-test' } },
      modelID: 'openrouter/sonoma-sky-alpha',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openrouter',
      modelID: 'openrouter/sonoma-sky-alpha',
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Failed to poll the OpenRouter auth key endpoint',
    });
  });
});
