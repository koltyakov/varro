import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { SessionTitleFallback } from './session-title-fallback';

function createHiddenSessions() {
  return {
    registerPendingTitle: vi.fn(),
    forgetPendingTitle: vi.fn(),
    hide: vi.fn(),
  };
}

describe('SessionTitleFallback', () => {
  it('renames placeholder sessions from a hidden generated title', async () => {
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/session/session-1') {
        return { id: 'session-1', title: 'New session' };
      }
      if (method === 'GET' && path === '/session/session-1/message?limit=20') {
        return [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'Fix the failing build command' }],
          },
        ];
      }
      if (method === 'POST' && path === '/session') {
        expect(body).toMatchObject({ title: 'Varro session title fallback: session-1' });
        return { id: 'hidden-1' };
      }
      if (method === 'GET' && path === '/config') {
        return { small_model: 'openai/gpt-4o-mini' };
      }
      if (method === 'POST' && path === '/session/hidden-1/message') {
        expect(body).toMatchObject({ model: { providerID: 'openai', modelID: 'gpt-4o-mini' } });
        return { info: { structured: { title: 'Fix Failing Build' } } };
      }
      if (method === 'PATCH' && path === '/session/session-1') {
        expect(body).toEqual({ title: 'Fix Failing Build' });
        return { id: 'session-1', title: 'Fix Failing Build' };
      }
      if (method === 'DELETE' && path === '/session/hidden-1') return true;
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    const hiddenSessions = createHiddenSessions();
    const fallback = new SessionTitleFallback({ request }, hiddenSessions, () => true);

    await expect(fallback.renameIfUntitled('session-1')).resolves.toEqual({
      id: 'session-1',
      title: 'Fix Failing Build',
    });
    expect(hiddenSessions.hide).toHaveBeenCalledWith('hidden-1');
    expect(request).toHaveBeenCalledWith('DELETE', '/session/hidden-1');
  });

  it('does not overwrite a session OpenCode renamed while the fallback was generating', async () => {
    let realSessionReads = 0;
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-1') {
        realSessionReads += 1;
        return {
          id: 'session-1',
          title: realSessionReads === 1 ? 'New session' : 'OpenCode Title',
        };
      }
      if (method === 'GET' && path === '/session/session-1/message?limit=20') {
        return [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'Add dark mode' }],
          },
        ];
      }
      if (method === 'POST' && path === '/session') return { id: 'hidden-1' };
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path === '/session/hidden-1/message') {
        return { info: { structured: { title: 'Add Dark Mode' } } };
      }
      if (method === 'DELETE' && path === '/session/hidden-1') return true;
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    const fallback = new SessionTitleFallback({ request }, createHiddenSessions(), () => true);

    await expect(fallback.renameIfUntitled('session-1')).resolves.toBeNull();
    expect(request).not.toHaveBeenCalledWith('PATCH', '/session/session-1', expect.anything());
  });

  it('uses the current session model without reasoning when no small model is configured', async () => {
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/session/session-1') {
        return { id: 'session-1', title: 'New session' };
      }
      if (method === 'GET' && path === '/session/session-1/message?limit=20') {
        return [
          {
            info: {
              role: 'user',
              model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
            },
            parts: [{ type: 'text', text: 'Fix current model routing' }],
          },
        ];
      }
      if (method === 'POST' && path === '/session') return { id: 'hidden-1' };
      if (method === 'GET' && path === '/config') return {};
      if (method === 'GET' && path === '/config/providers') {
        return {
          providers: [
            {
              id: 'openai',
              models: {
                'gpt-5.6-sol': {
                  variants: {
                    none: { reasoningEffort: 'none' },
                    low: { reasoningEffort: 'low' },
                    high: { reasoningEffort: 'high' },
                  },
                },
              },
            },
          ],
        };
      }
      if (method === 'POST' && path === '/session/hidden-1/message') {
        expect(body).toMatchObject({
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
          variant: 'none',
        });
        return { info: { structured: { title: 'Fix Current Model Routing' } } };
      }
      if (method === 'PATCH' && path === '/session/session-1') {
        return { id: 'session-1', title: 'Fix Current Model Routing' };
      }
      if (method === 'DELETE' && path === '/session/hidden-1') return true;
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    const fallback = new SessionTitleFallback({ request }, createHiddenSessions(), () => true);

    await expect(fallback.renameIfUntitled('session-1')).resolves.toEqual({
      id: 'session-1',
      title: 'Fix Current Model Routing',
    });
  });

  it('does nothing when fallback renaming is disabled', async () => {
    const request = vi.fn();
    const hiddenSessions = createHiddenSessions();
    const fallback = new SessionTitleFallback({ request }, hiddenSessions, () => false);

    await expect(fallback.renameIfUntitled('session-1')).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(hiddenSessions.registerPendingTitle).not.toHaveBeenCalled();
  });
});
