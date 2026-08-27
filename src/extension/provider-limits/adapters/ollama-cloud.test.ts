import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createOllamaCloudAdapter } from './ollama-cloud';

const adapter = createOllamaCloudAdapter();
const provider: ProviderMetadata = {
  id: 'ollama-cloud',
  models: {},
};

describe('createOllamaCloudAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches Ollama Cloud providers with auth-store or configured credentials', () => {
    expect(
      adapter.matches(provider, {
        'ollama-cloud': { type: 'api', key: 'ollama-api-key' },
      })
    ).toBe(true);
    expect(adapter.matches({ ...provider, options: { apiKey: 'configured-key' } }, {})).toBe(true);
    expect(adapter.matches(provider, {})).toBe(false);
    expect(
      adapter.matches({ ...provider, id: 'ollama' }, { ollama: { type: 'api', key: 'key' } })
    ).toBe(false);
  });

  it('maps session and weekly usage fractions to percentage windows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        limits: {
          session: { usage: 0.25 },
          weekly: { usage: 0.405 },
        },
      })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'ollama-cloud': { type: 'api', key: 'ollama-api-key' } },
      modelID: 'qwen3-coder:480b',
      checkedAt: 5_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://ollama.com/api/usage',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ollama-api-key',
          'User-Agent': 'Varro/0.1.0',
        },
      })
    );
    expect(status).toEqual({
      providerID: 'ollama-cloud',
      modelID: 'qwen3-coder:480b',
      status: 'available',
      source: 'provider',
      checkedAt: 5_000,
      note: 'Polled Ollama Cloud usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: 'Session (5h)',
          unit: 'unknown',
          remaining: 75,
          limit: 100,
          resetAt: null,
          percent: 25,
        },
        {
          id: 'weekly',
          label: 'Weekly (7d)',
          unit: 'unknown',
          remaining: 59.5,
          limit: 100,
          resetAt: null,
          percent: 40.5,
        },
      ],
    });
  });

  it('keeps valid windows when another usage fraction is invalid', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ limits: { session: { usage: 0 }, weekly: { usage: 1.5 } } })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'ollama-cloud': { type: 'api', key: 'ollama-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'available',
      windows: [
        {
          id: 'five_hour',
          remaining: 100,
          limit: 100,
          percent: 0,
        },
      ],
    });
  });

  it('reports rejected credentials as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { 'ollama-cloud': { type: 'api', key: 'bad-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'ollama-cloud',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Ollama Cloud usage endpoint rejected credentials (401)',
    });
  });

  it('returns unsupported when the response has no valid bounded quotas', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ limits: { session: { usage: -1 }, weekly: { usage: '0.5' } } })
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'ollama-cloud': { type: 'api', key: 'ollama-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toMatchObject({
      status: 'unsupported',
      note: 'Ollama Cloud usage endpoint did not expose any bounded quotas',
    });
  });

  it('returns an error status when polling fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const status = await adapter.fetch({
      provider,
      authStore: { 'ollama-cloud': { type: 'api', key: 'ollama-api-key' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'ollama-cloud',
      modelID: null,
      status: 'error',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Failed to poll the Ollama Cloud usage endpoint',
    });
  });
});
