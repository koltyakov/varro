import { createServer } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMetadata } from '../../util/provider-limit';
import { createAntigravityAdapter } from './antigravity';

const adapter = createAntigravityAdapter();

const provider: ProviderMetadata = {
  id: 'antigravity',
  models: {
    'claude-4-5-sonnet': { api: { url: 'https://127.0.0.1:42100' } },
    'gemini-3-pro': { api: { url: 'https://127.0.0.1:42100' } },
  },
};

describe('createAntigravityAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes local language-server quotas for the selected model', async () => {
    const resetAt = '2026-05-02T12:00:00.000Z';
    const server = createServer((request, response) => {
      expect(request.headers['connect-protocol-version']).toBe('1');
      expect(request.headers['x-codeium-csrf-token']).toBe('csrf-token');

      if (request.url?.endsWith('/GetUserStatus')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            userStatus: {
              email: 'user@example.test',
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: 'Claude Sonnet',
                    modelOrAlias: { model: 'claude-4-5-sonnet' },
                    quotaInfo: { remainingFraction: 0.75, resetTime: resetAt },
                  },
                  {
                    label: 'Gemini Pro',
                    modelOrAlias: { model: 'gemini-3-pro' },
                    quotaInfo: { remainingFraction: 0.2, resetTime: resetAt },
                  },
                ],
              },
            },
          })
        );
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      vi.stubEnv('ANTIGRAVITY_BASE_URL', `http://127.0.0.1:${port}`);
      vi.stubEnv('ANTIGRAVITY_CSRF_TOKEN', 'csrf-token');

      const status = await adapter.fetch({
        provider,
        authStore: {},
        modelID: 'claude-4-5-sonnet',
        checkedAt: 1_000,
      });

      expect(status).toEqual({
        providerID: 'antigravity',
        modelID: 'claude-4-5-sonnet',
        status: 'available',
        source: 'provider',
        checkedAt: 1_000,
        note: 'Polled local Antigravity language server',
        windows: [
          {
            id: 'claude-4-5-sonnet',
            label: 'Claude Sonnet',
            unit: 'credits',
            remaining: 75,
            limit: 100,
            resetAt: Date.parse(resetAt),
            percent: 25,
          },
        ],
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('reports unauthenticated local sessions as unsupported', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ message: 'User not authenticated', code: 'UNAUTHENTICATED' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      vi.stubEnv('ANTIGRAVITY_BASE_URL', `http://127.0.0.1:${port}`);

      const status = await adapter.fetch({
        provider,
        authStore: {},
        modelID: null,
        checkedAt: 1_000,
      });

      expect(status).toEqual({
        providerID: 'antigravity',
        modelID: null,
        status: 'unsupported',
        source: 'provider',
        checkedAt: 1_000,
        note: 'Antigravity language server is not authenticated',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
