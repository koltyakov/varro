import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createHeaderProbeAdapter, supportsHeaderProbeProvider } from './header-probe';

const openAiAdapter = createHeaderProbeAdapter('openai');
const copilotAdapter = createHeaderProbeAdapter('github-copilot');

const openAiApiKeyProvider: ProviderMetadata = {
  id: 'openai',
  options: { apiKey: 'sk-openai-api-key' },
  models: {},
};

const openAiOAuthProvider: ProviderMetadata = {
  id: 'openai',
  options: { apiKey: 'opencode-oauth-dummy-key' },
  models: {},
};

const copilotProvider: ProviderMetadata = {
  id: 'github-copilot',
  models: {},
};

describe('createHeaderProbeAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches only supported providers with probeable auth', () => {
    expect(openAiAdapter.matches(openAiApiKeyProvider, {})).toBe(true);
    expect(
      openAiAdapter.matches(openAiOAuthProvider, {
        openai: { type: 'oauth', access: 'openai-oauth-token' },
      })
    ).toBe(true);
    expect(openAiAdapter.matches(openAiOAuthProvider, {})).toBe(false);
    expect(
      copilotAdapter.matches(copilotProvider, {
        'github-copilot': { type: 'oauth', access: 'copilot-oauth-token' },
      })
    ).toBe(true);

    expect(
      supportsHeaderProbeProvider('github-copilot', copilotProvider, {
        'github-copilot': { type: 'oauth', access: 'copilot-oauth-token' },
      })
    ).toBe(true);
    expect(
      supportsHeaderProbeProvider('openai', copilotProvider, {
        'github-copilot': { type: 'oauth', access: 'copilot-oauth-token' },
      })
    ).toBe(false);
  });

  it('parses request and token headers for OpenAI probes', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('', {
        status: 200,
        headers: {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '42',
          'x-ratelimit-reset-requests': '30s',
          'x-ratelimit-limit-tokens': '90000',
          'x-ratelimit-remaining-tokens': '12000',
          'x-ratelimit-reset-tokens': '90s',
        },
      })
    );

    const status = await openAiAdapter.fetch({
      provider: openAiApiKeyProvider,
      authStore: {},
      modelID: 'gpt-5.4',
      checkedAt: 5_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer sk-openai-api-key',
        },
      })
    );
    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: 5_000,
      note: 'Polled provider metadata headers',
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests',
          remaining: 42,
          limit: 100,
          resetAt: 35_000,
        },
        {
          id: 'tokens',
          label: 'Tokens',
          unit: 'tokens',
          remaining: 12_000,
          limit: 90_000,
          resetAt: 95_000,
        },
      ],
    });
  });

  it('uses Copilot metadata headers and generic rate-limit fields', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('', {
        status: 200,
        headers: {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '1234',
          'x-ratelimit-reset': '2026-05-02T12:00:00.000Z',
        },
      })
    );

    const status = await copilotAdapter.fetch({
      provider: copilotProvider,
      authStore: {
        'github-copilot': { type: 'oauth', access: 'copilot-oauth-token' },
      },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.githubcopilot.com/models',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer copilot-oauth-token',
          'User-Agent': 'Varro/0.1.0',
          'Editor-Version': 'vscode/1.91.0',
          'Editor-Plugin-Version': 'varro/0.1.0',
        },
      })
    );
    expect(status).toEqual({
      providerID: 'github-copilot',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled provider metadata headers',
      windows: [
        {
          id: 'limit',
          label: 'Limit',
          unit: 'unknown',
          remaining: 1234,
          limit: 5000,
          resetAt: Date.parse('2026-05-02T12:00:00.000Z'),
        },
      ],
    });
  });

  it('returns unsupported when no known zero-cost probe exists', async () => {
    const status = await openAiAdapter.fetch({
      provider: openAiOAuthProvider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'No zero-cost provider quota endpoint is known for this provider',
    });
  });

  it('returns unsupported when the metadata endpoint exposes no remaining limits', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const status = await openAiAdapter.fetch({
      provider: openAiApiKeyProvider,
      authStore: {},
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Provider metadata endpoint did not expose remaining limits',
    });
  });

  it('returns unsupported when the metadata endpoint fails without quota headers', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 429 }));

    const status = await openAiAdapter.fetch({
      provider: openAiApiKeyProvider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Provider metadata endpoint returned 429',
    });
  });

  it('returns an error status when probing throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const status = await openAiAdapter.fetch({
      provider: openAiApiKeyProvider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Failed to poll the provider metadata endpoint',
    });
  });
});
