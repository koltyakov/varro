import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

import { createCodexAdapter } from './codex';
import type { ProviderMetadata } from '../../util/provider-limit';

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  default: {
    readFile: readFileMock,
  },
}));

import { readFile } from 'fs/promises';

const adapter = createCodexAdapter();

const oauthProvider: ProviderMetadata = {
  id: 'openai',
  options: { apiKey: 'opencode-oauth-dummy-key' },
  models: {},
};

describe('createCodexAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(readFile).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('matches OAuth-backed OpenAI providers without shadowing API-key probes', () => {
    expect(adapter.matches(oauthProvider, { openai: { type: 'oauth', access: 'token-1' } })).toBe(
      true
    );
    expect(
      adapter.matches(
        {
          id: 'openai',
          options: { apiKey: 'sk-openai-api-key' },
          models: {},
        },
        { openai: { type: 'api', key: 'sk-openai-api-key' } }
      )
    ).toBe(false);
  });

  it('falls back to the secondary Codex endpoint and parses known quota windows', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: 'codex-file-token',
          account_id: 'acct_123',
        },
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              primary_window: {
                used_percent: 22.5,
                reset_at: 1_766_000_000,
                limit_window_seconds: 18_000,
              },
              secondary_window: {
                used_percent: 41,
                reset_at: 1_766_400_000,
                limit_window_seconds: 604_800,
              },
            },
            code_review_rate_limit: {
              primary_window: {
                used_percent: 38,
                reset_at: 1_766_000_000,
                limit_window_seconds: 18_000,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: {},
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer codex-file-token',
          'ChatClaude-Account-Id': 'acct_123',
          'X-Account-Id': 'acct_123',
        }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://chatgpt.com/api/codex/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer codex-file-token',
        }),
      })
    );
    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'five_hour',
          label: '5-Hour Limit',
          unit: 'unknown',
          remaining: 77.5,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 22.5,
        },
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 59,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 41,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 62,
          limit: 100,
          resetAt: 1_766_000_000_000,
          percent: 38,
        },
      ],
    });
  });

  it('maps free-plan primary usage to the weekly quota', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: 'free',
          rate_limit: {
            primary_window: {
              used_percent: 14,
              reset_at: 1_766_400_000,
              limit_window_seconds: 604_800,
            },
            secondary_window: null,
          },
          code_review_rate_limit: {
            primary_window: {
              used_percent: 0,
              reset_at: 1_766_400_000,
              limit_window_seconds: 604_800,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 86,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 14,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 100,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 0,
        },
      ],
    });
  });

  it('maps a single long primary window to the weekly quota', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              used_percent: 22.5,
              reset_at: 1_766_400_000,
              limit_window_seconds: 604_800,
            },
            secondary_window: null,
          },
          code_review_rate_limit: {
            primary_window: {
              used_percent: 38,
              reset_at: 1_766_400_000,
              limit_window_seconds: 604_800,
            },
          },
          credits: {
            balance: 123.4,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: 'gpt-5.4',
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled Codex OAuth usage endpoint',
      windows: [
        {
          id: 'seven_day',
          label: 'Weekly All-Model',
          unit: 'unknown',
          remaining: 77.5,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 22.5,
        },
        {
          id: 'code_review',
          label: 'Review Requests',
          unit: 'unknown',
          remaining: 62,
          limit: 100,
          resetAt: 1_766_400_000_000,
          percent: 38,
        },
      ],
    });
  });

  it('treats auth failures as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider: oauthProvider,
      authStore: { openai: { type: 'oauth', access: 'codex-auth-store-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'openai',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Codex usage endpoint rejected credentials (401)',
    });
  });
});
