import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

import { createCopilotAdapter } from './copilot';
import type { ProviderMetadata } from '../../util/provider-limit';

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  default: {
    readFile: readFileMock,
  },
}));

import { readFile } from 'fs/promises';

const adapter = createCopilotAdapter();

const provider: ProviderMetadata = {
  id: 'github-copilot',
  options: { apiKey: 'opencode-oauth-dummy-key' },
  models: {},
};

describe('createCopilotAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(readFile).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches GitHub Copilot when OpenCode auth exists', () => {
    expect(adapter.matches(provider, {})).toBe(true);
  });

  it('falls back to gh hosts oauth_token when OpenCode auth is absent', async () => {
    vi.mocked(readFile).mockResolvedValue(`github.com:\n    oauth_token: ghu_copilot_token\n`);
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          quota_snapshots: {
            premium_interactions: {
              entitlement: 100,
              remaining: 40,
              percent_remaining: 40,
              unlimited: false,
            },
          },
          quota_reset_date_utc: '2026-05-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: {},
      modelID: null,
      checkedAt: 1_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/copilot_internal/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghu_copilot_token',
        }),
      })
    );
    expect(status.status).toBe('available');
  });

  it('parses legacy quota snapshots and skips unlimited windows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          login: 'testuser',
          copilot_plan: 'individual_pro',
          quota_reset_date_utc: '2026-03-01T00:00:00.000Z',
          quota_snapshots: {
            premium_interactions: {
              entitlement: 1500,
              remaining: 473,
              percent_remaining: 31.578,
              unlimited: false,
            },
            chat: {
              entitlement: 0,
              remaining: 0,
              percent_remaining: 100,
              unlimited: true,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'github-copilot': { type: 'oauth', access: 'copilot-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'github-copilot',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled GitHub Copilot internal quota endpoint',
      windows: [
        {
          id: 'premium_interactions',
          label: 'Premium Requests',
          unit: 'requests',
          remaining: 473,
          limit: 1500,
          resetAt: Date.parse('2026-03-01T00:00:00.000Z'),
          percent: 68.422,
        },
      ],
    });
  });

  it('normalizes limited-user quotas into bounded windows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          login: 'testuser',
          copilot_plan: 'individual',
          access_type_sku: 'free_limited_copilot',
          limited_user_quotas: { chat: 260, completions: 3327 },
          monthly_quotas: { chat: 500, completions: 4000 },
          limited_user_reset_date: '2026-04-24',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await adapter.fetch({
      provider,
      authStore: { 'github-copilot': { type: 'oauth', access: 'copilot-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'github-copilot',
      modelID: null,
      status: 'available',
      source: 'provider',
      checkedAt: 1_000,
      note: 'Polled GitHub Copilot internal quota endpoint',
      windows: [
        {
          id: 'chat',
          label: 'Chat',
          unit: 'messages',
          remaining: 240,
          limit: 500,
          resetAt: Date.parse('2026-04-24T00:00:00.000Z'),
          percent: 52,
        },
        {
          id: 'completions',
          label: 'Completions',
          unit: 'requests',
          remaining: 673,
          limit: 4000,
          resetAt: Date.parse('2026-04-24T00:00:00.000Z'),
          percent: 83.175,
        },
      ],
    });
  });

  it('treats auth failures as unsupported instead of erroring', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));

    const status = await adapter.fetch({
      provider,
      authStore: { 'github-copilot': { type: 'oauth', access: 'copilot-token' } },
      modelID: null,
      checkedAt: 1_000,
    });

    expect(status).toEqual({
      providerID: 'github-copilot',
      modelID: null,
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1_000,
      note: 'GitHub Copilot quota endpoint rejected credentials (401)',
    });
  });
});
