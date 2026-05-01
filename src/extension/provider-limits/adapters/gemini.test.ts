import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

import { createGeminiAdapter } from './gemini';
import type { ProviderMetadata } from '../../util/provider-limit';

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  default: {
    readFile: readFileMock,
  },
}));

import { readFile } from 'fs/promises';

const adapter = createGeminiAdapter();

const geminiProvider: ProviderMetadata = {
  id: 'gemini',
  models: {},
};

describe('createGeminiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(readFile).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('matches Gemini and Google provider aliases', () => {
    expect(adapter.matches(geminiProvider, {})).toBe(true);
    expect(
      adapter.matches(
        {
          id: 'google',
          models: {},
        },
        {}
      )
    ).toBe(true);
  });

  it('falls back to ~/.gemini/oauth_creds.json and normalizes per-model quotas', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        access_token: 'gemini-file-token',
      })
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            {
              remainingFraction: 1,
              resetTime: '2026-03-18T10:00:00Z',
              modelId: 'gemini-2.5-pro',
            },
            {
              remainingFraction: 0.993,
              resetTime: '2026-03-18T10:00:00Z',
              modelId: 'gemini-2.5-flash',
            },
            {
              remainingFraction: 0.999,
              resetTime: '2026-03-18T10:00:00Z',
              modelId: 'gemini-2.5-flash-lite',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider: geminiProvider,
      authStore: {},
      modelID: 'gemini-2.5-pro',
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({
          Authorization: 'Bearer gemini-file-token',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'gemini',
      modelID: 'gemini-2.5-pro',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Gemini quota endpoint',
      windows: [
        {
          id: 'gemini-2.5-pro',
          label: 'Gemini 2.5 Pro',
          unit: 'unknown',
          remaining: 100,
          limit: 100,
          resetAt: Date.parse('2026-03-18T10:00:00Z'),
          percent: 0,
        },
        {
          id: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
          unit: 'unknown',
          remaining: 99.3,
          limit: 100,
          resetAt: Date.parse('2026-03-18T10:00:00Z'),
          percent: 0.7,
        },
        {
          id: 'gemini-2.5-flash-lite',
          label: 'Gemini 2.5 Flash Lite',
          unit: 'unknown',
          remaining: 99.9,
          limit: 100,
          resetAt: Date.parse('2026-03-18T10:00:00Z'),
          percent: 0.1,
        },
      ],
    });
  });

  it('uses an OAuth token from either Gemini provider alias in the auth store', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            {
              remainingFraction: 0.5,
              resetTime: '2026-03-18T10:00:00Z',
              modelId: 'gemini-3-pro-preview',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await adapter.fetch({
      provider: {
        id: 'google',
        models: {},
      },
      authStore: { gemini: { type: 'oauth', access: 'gemini-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer gemini-auth-store-token',
        }),
      })
    );
  });

  it('falls back to GEMINI_ACCESS_TOKEN when file and auth-store credentials are absent', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('missing oauth_creds.json'));
    vi.stubEnv('GEMINI_ACCESS_TOKEN', 'gemini-env-token');
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            {
              remainingFraction: 0.75,
              resetTime: '2026-03-18T10:00:00Z',
              modelId: 'gemini-2.5-flash',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider: geminiProvider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer gemini-env-token',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'gemini',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Gemini quota endpoint',
      windows: [
        {
          id: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
          unit: 'unknown',
          remaining: 75,
          limit: 100,
          resetAt: Date.parse('2026-03-18T10:00:00Z'),
          percent: 25,
        },
      ],
    });
  });

  it('treats auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider: geminiProvider,
      authStore: { gemini: { type: 'oauth', access: 'gemini-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'gemini',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Gemini quota endpoint rejected credentials (401)',
    });
  });
});
