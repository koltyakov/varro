import { describe, expect, it } from 'vitest';
import {
  buildProviderLimitProbe,
  extractOpenCodeProviderLimit,
  getOpenCodeAuthFilePath,
  parseProviderAuthStore,
  parseProviderLimitHeaders,
  parseRateLimitResetAt,
  type ProviderMetadata,
} from './provider-limit';

describe('provider limit helpers', () => {
  it('resolves the OpenCode auth path from XDG data home', () => {
    expect(
      getOpenCodeAuthFilePath({ XDG_DATA_HOME: '/tmp/data' } as NodeJS.ProcessEnv, '/Users/test')
    ).toBe('/tmp/data/opencode/auth.json');
  });

  it('falls back to the standard local share data dir', () => {
    expect(getOpenCodeAuthFilePath({} as NodeJS.ProcessEnv, '/Users/test')).toBe(
      '/Users/test/.local/share/opencode/auth.json'
    );
  });

  it('parses reset values as durations and timestamps', () => {
    expect(parseRateLimitResetAt('1m30s', 10_000)).toBe(100_000);
    expect(parseRateLimitResetAt('250ms', 10_000)).toBe(10_250);
    expect(parseRateLimitResetAt(120, 10_000)).toBe(130_000);
    expect(parseRateLimitResetAt(1_710_000_000, 0)).toBe(1_710_000_000_000);
  });

  it('extracts request and token windows from rate limit headers', () => {
    const headers = new Headers({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '42',
      'x-ratelimit-reset-requests': '30s',
      'x-ratelimit-limit-tokens': '90000',
      'x-ratelimit-remaining-tokens': '12000',
      'x-ratelimit-reset-tokens': '90s',
    });

    expect(parseProviderLimitHeaders(headers, 5_000)).toEqual([
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
    ]);
  });

  it('reads future direct limit metadata from OpenCode provider payloads', () => {
    const result = extractOpenCodeProviderLimit(
      {
        id: 'github-copilot',
        models: {
          'gpt-5.4': {
            quota: {
              requests: { remaining: 12, limit: 50, resetAt: '2026-04-21T12:00:00.000Z' },
            },
          } as unknown as ProviderMetadata['models'][string],
        },
      } as ProviderMetadata,
      'gpt-5.4',
      0
    );

    expect(result).toEqual({
      providerID: 'github-copilot',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'opencode',
      checkedAt: 0,
      note: 'Read from OpenCode metadata',
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests',
          remaining: 12,
          limit: 50,
          resetAt: Date.parse('2026-04-21T12:00:00.000Z'),
        },
      ],
    });
  });

  it('builds provider probes from auth.json and known provider defaults', () => {
    const authStore = parseProviderAuthStore(
      JSON.stringify({
        openai: { type: 'oauth', access: 'token-1' },
        'github-copilot': { type: 'oauth', access: 'token-2' },
      })
    );

    expect(
      buildProviderLimitProbe(
        {
          id: 'openai',
          options: { apiKey: 'opencode-oauth-dummy-key' },
          models: { 'gpt-5.4': { api: { url: '' } } },
        },
        authStore
      )
    ).toEqual({
      url: 'https://api.openai.com/v1/models',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token-1',
      },
    });

    expect(
      buildProviderLimitProbe(
        {
          id: 'github-copilot',
          models: { 'claude-sonnet-4.6': { api: { url: 'https://api.githubcopilot.com/v1' } } },
        },
        authStore
      )
    ).toEqual({
      url: 'https://api.githubcopilot.com/models',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token-2',
        'User-Agent': 'Varro/0.1.0',
        'Editor-Version': 'vscode/1.91.0',
        'Editor-Plugin-Version': 'varro/0.1.0',
      },
    });
  });

  it('does not send auth tokens to provider metadata URLs for unknown providers', () => {
    const authStore = parseProviderAuthStore(
      JSON.stringify({
        custom: { type: 'api', key: 'secret-token' },
      })
    );

    expect(
      buildProviderLimitProbe(
        {
          id: 'custom',
          models: { model: { api: { url: 'https://provider.example.test/v1' } } },
        },
        authStore
      )
    ).toBeNull();
  });
});
