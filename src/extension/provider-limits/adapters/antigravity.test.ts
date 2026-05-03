import { createServer } from 'http';
import type { RequestListener } from 'http';
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

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

async function close(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withLanguageServer(
  handler: RequestListener,
  run: (baseURL: string) => Promise<void>
) {
  const server = createServer(handler);
  await listen(server);

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
}

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

    await listen(server);

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
      await close(server);
    }
  });

  it('reports unauthenticated local sessions as unsupported', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ message: 'User not authenticated', code: 'UNAUTHENTICATED' })
        );
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

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
      }
    );
  });

  it('treats rejected local sessions as unsupported', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.statusCode = 403;
        response.end(JSON.stringify({ message: 'forbidden' }));
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

        const status = await adapter.fetch({
          provider,
          authStore: {},
          modelID: 'claude-4-5-sonnet',
          checkedAt: 1_000,
        });

        expect(status).toEqual({
          providerID: 'antigravity',
          modelID: 'claude-4-5-sonnet',
          status: 'unsupported',
          source: 'provider',
          checkedAt: 1_000,
          note: 'Antigravity language server rejected the local session (403)',
        });
      }
    );
  });

  it('reports non-200 language server responses as errors', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.statusCode = 429;
        response.end(JSON.stringify({ message: 'too many requests' }));
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

        const status = await adapter.fetch({
          provider,
          authStore: {},
          modelID: null,
          checkedAt: 1_000,
        });

        expect(status).toEqual({
          providerID: 'antigravity',
          modelID: null,
          status: 'error',
          source: 'provider',
          checkedAt: 1_000,
          note: 'Antigravity language server returned 429',
        });
      }
    );
  });

  it('reports invalid JSON payloads as errors', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end('{invalid-json');
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

        const status = await adapter.fetch({
          provider,
          authStore: {},
          modelID: null,
          checkedAt: 1_000,
        });

        expect(status).toEqual({
          providerID: 'antigravity',
          modelID: null,
          status: 'error',
          source: 'provider',
          checkedAt: 1_000,
          note: 'Antigravity language server returned an invalid response',
        });
      }
    );
  });

  it('reports unsupported when a requested model quota is missing', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: 'Gemini Pro',
                    modelOrAlias: { model: 'gemini-3-pro' },
                    quotaInfo: { remainingFraction: 0.5, resetTime: '2026-05-02T12:00:00.000Z' },
                  },
                ],
              },
            },
          })
        );
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

        const status = await adapter.fetch({
          provider,
          authStore: {},
          modelID: 'claude-4-5-sonnet',
          checkedAt: 1_000,
        });

        expect(status).toEqual({
          providerID: 'antigravity',
          modelID: 'claude-4-5-sonnet',
          status: 'unsupported',
          source: 'provider',
          checkedAt: 1_000,
          note: 'Antigravity language server did not report quota for claude-4-5-sonnet',
        });
      }
    );
  });

  it('filters invalid quota entries and normalizes bounded windows', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: 'Claude Sonnet (thinking)',
                    modelOrAlias: { model: 'claude-4-5-sonnet' },
                    quotaInfo: { remainingFraction: '1.2', resetTime: 'not-a-date' },
                  },
                  {
                    label: 'Gemini Pro',
                    modelOrAlias: { model: 'gemini-3-pro' },
                    quotaInfo: { remainingFraction: '-0.1', resetTime: '' },
                  },
                  {
                    label: 'Ignored',
                    modelOrAlias: { model: 'missing-fraction' },
                    quotaInfo: { resetTime: '2026-05-02T12:00:00.000Z' },
                  },
                ],
              },
            },
          })
        );
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

        const status = await adapter.fetch({
          provider,
          authStore: {},
          modelID: null,
          checkedAt: 1_000,
        });

        expect(status).toEqual({
          providerID: 'antigravity',
          modelID: null,
          status: 'available',
          source: 'provider',
          checkedAt: 1_000,
          note: 'Polled local Antigravity language server',
          windows: [
            {
              id: 'claude-4-5-sonnet',
              label: 'Claude Sonnet',
              unit: 'credits',
              remaining: 100,
              limit: 100,
              resetAt: 1_000,
              percent: 0,
            },
            {
              id: 'gemini-3-pro',
              label: 'Gemini Pro',
              unit: 'credits',
              remaining: 0,
              limit: 100,
              resetAt: null,
              percent: 100,
            },
          ],
        });
      }
    );
  });

  it('reports unsupported when no bounded quotas are exposed', async () => {
    await withLanguageServer(
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: 'Invalid',
                    modelOrAlias: { model: 'claude-4-5-sonnet' },
                    quotaInfo: { remainingFraction: '' },
                  },
                ],
              },
            },
          })
        );
      },
      async (baseURL) => {
        vi.stubEnv('ANTIGRAVITY_BASE_URL', baseURL);

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
          note: 'Antigravity language server did not expose any bounded quotas',
        });
      }
    );
  });
});
