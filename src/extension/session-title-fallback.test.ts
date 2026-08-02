import { describe, expect, it, vi } from 'vitest';

import type { PermissionRule } from '../shared/opencode-types';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { HiddenSessionManager } from './hidden-session-manager';
import { SessionTitleFallback } from './session-title-fallback';

type HiddenSessionActions = Pick<
  HiddenSessionManager,
  'registerPendingTitle' | 'forgetPendingTitle' | 'hide' | 'unhide' | 'retainUntilDeleted'
>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHiddenSessions() {
  const actions = {
    registerPendingTitle: vi.fn<HiddenSessionActions['registerPendingTitle']>(),
    forgetPendingTitle: vi.fn<HiddenSessionActions['forgetPendingTitle']>(),
    hide: vi.fn<HiddenSessionActions['hide']>(),
    unhide: vi.fn<HiddenSessionActions['unhide']>(),
    retainUntilDeleted: vi.fn<HiddenSessionActions['retainUntilDeleted']>(),
  } satisfies HiddenSessionActions;
  return Object.assign(new HiddenSessionManager(), actions);
}

function resolveToolAction(rules: PermissionRule[], tool: string) {
  return rules.findLast((rule) => rule.permission === '*' || rule.permission === tool)?.action;
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

    const hiddenSessions = new HiddenSessionManager();
    const fallback = new SessionTitleFallback({ request }, hiddenSessions, () => true);

    await expect(fallback.renameIfUntitled('session-1')).resolves.toEqual({
      id: 'session-1',
      title: 'Fix Failing Build',
    });
    expect(hiddenSessions.isHidden('hidden-1')).toBe(true);
    hiddenSessions.observeEvent({
      type: 'session.updated',
      properties: { info: { id: 'hidden-1', title: 'Queued helper update' } },
    });
    expect(hiddenSessions.isHidden('hidden-1')).toBe(true);
    hiddenSessions.observeEvent({
      type: 'session.deleted',
      properties: { info: { id: 'hidden-1' } },
    });
    expect(hiddenSessions.isHidden('hidden-1')).toBe(false);
    expect(request).toHaveBeenCalledWith('DELETE', '/session/hidden-1');
  });

  it.each(['false response', 'rejected request'] as const)(
    'keeps a title helper session hidden after a %s deletion',
    async (failure) => {
      const request = vi.fn(async (method: string, path: string) => {
        if (method === 'GET' && path === '/session/session-1') {
          return { id: 'session-1', title: 'New session' };
        }
        if (method === 'GET' && path === '/session/session-1/message?limit=20') {
          return [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'Keep failed cleanup hidden' }],
            },
          ];
        }
        if (method === 'POST' && path === '/session') return { id: 'hidden-failed-delete' };
        if (method === 'GET' && path === '/config') return {};
        if (method === 'POST' && path === '/session/hidden-failed-delete/message') {
          return { info: { structured: { title: 'Keep Failed Cleanup Hidden' } } };
        }
        if (method === 'DELETE' && path === '/session/hidden-failed-delete') {
          if (failure === 'rejected request') throw new Error('delete failed');
          return false;
        }
        if (method === 'PATCH' && path === '/session/session-1') {
          return { id: 'session-1', title: 'Keep Failed Cleanup Hidden' };
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      });
      const hiddenSessions = createHiddenSessions();
      const fallback = new SessionTitleFallback({ request }, hiddenSessions, () => true);

      await fallback.renameIfUntitled('session-1');

      expect(hiddenSessions.hide).toHaveBeenCalledWith('hidden-failed-delete');
      expect(hiddenSessions.unhide).not.toHaveBeenCalled();
      expect(hiddenSessions.retainUntilDeleted).not.toHaveBeenCalled();
    }
  );

  it('allows only the StructuredOutput synthetic tool in deny-all title sessions', async () => {
    let permissionRules: PermissionRule[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/session/session-1') {
        return { id: 'session-1', title: 'New session' };
      }
      if (method === 'GET' && path === '/session/session-1/message?limit=20') {
        return [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'Fix helper tool permissions' }],
          },
        ];
      }
      if (method === 'POST' && path === '/session') {
        permissionRules = (body as { permission: PermissionRule[] }).permission;
        return { id: 'hidden-1' };
      }
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path === '/session/hidden-1/message') {
        return { info: { structured: { title: 'Fix Helper Permissions' } } };
      }
      if (method === 'PATCH' && path === '/session/session-1') {
        return { id: 'session-1', title: 'Fix Helper Permissions' };
      }
      if (method === 'DELETE' && path === '/session/hidden-1') return true;
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const fallback = new SessionTitleFallback({ request }, createHiddenSessions(), () => true);

    await fallback.renameIfUntitled('session-1');

    expect([
      resolveToolAction(permissionRules, 'StructuredOutput'),
      resolveToolAction(permissionRules, 'unknown_custom_tool'),
      resolveToolAction(permissionRules, 'mcp_database_query'),
    ]).toEqual(['allow', 'deny', 'deny']);
    expect(permissionRules.slice(-2)).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'StructuredOutput', pattern: '*', action: 'allow' },
    ]);
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

  it('does not let a timed-out title generation PATCH over a retry', async () => {
    vi.useFakeTimers();
    try {
      const firstTitle = deferred<unknown>();
      let hiddenSessionCount = 0;
      const request = vi.fn(async (method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/session/session-1') {
          return { id: 'session-1', title: 'New session' };
        }
        if (method === 'GET' && path === '/session/session-1/message?limit=20') {
          return [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'Fix timeout races' }],
            },
          ];
        }
        if (method === 'POST' && path === '/session') {
          hiddenSessionCount += 1;
          return { id: `hidden-${hiddenSessionCount}` };
        }
        if (method === 'GET' && path === '/config') return {};
        if (method === 'POST' && path === '/session/hidden-1/message') {
          return firstTitle.promise;
        }
        if (method === 'POST' && path === '/session/hidden-2/message') {
          return { info: { structured: { title: 'Retry Title' } } };
        }
        if (method === 'DELETE') return true;
        if (method === 'PATCH' && path === '/session/session-1') {
          return { id: 'session-1', title: (body as { title: string }).title };
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      });
      const fallback = new SessionTitleFallback({ request }, createHiddenSessions(), () => true);

      const timedOut = fallback.renameIfUntitled('session-1');
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(request).toHaveBeenCalledWith('POST', '/session/hidden-1/message', expect.anything());
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(timedOut).resolves.toBeNull();

      await expect(fallback.renameIfUntitled('session-1')).resolves.toEqual({
        id: 'session-1',
        title: 'Retry Title',
      });
      firstTitle.resolve({ info: { structured: { title: 'Late Title' } } });
      for (let index = 0; index < 5; index += 1) await Promise.resolve();

      expect(request).toHaveBeenCalledWith('DELETE', '/session/hidden-1');
      expect(request).toHaveBeenCalledWith('DELETE', '/session/hidden-2');
      expect(request.mock.calls.filter(([method]) => method === 'PATCH')).toEqual([
        ['PATCH', '/session/session-1', { title: 'Retry Title' }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a hidden title session created after the attempt times out', async () => {
    vi.useFakeTimers();
    try {
      const hiddenSession = deferred<unknown>();
      const hiddenSessions = createHiddenSessions();
      const request = vi.fn(async (method: string, path: string) => {
        if (method === 'GET' && path === '/session/session-1') {
          return { id: 'session-1', title: 'New session' };
        }
        if (method === 'GET' && path === '/session/session-1/message?limit=20') {
          return [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'Clean up hidden sessions' }],
            },
          ];
        }
        if (method === 'POST' && path === '/session') return hiddenSession.promise;
        if (method === 'DELETE' && path === '/session/hidden-late') return true;
        throw new Error(`Unexpected request ${method} ${path}`);
      });
      const fallback = new SessionTitleFallback({ request }, hiddenSessions, () => true);

      const timedOut = fallback.renameIfUntitled('session-1');
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(timedOut).resolves.toBeNull();
      expect(hiddenSessions.forgetPendingTitle).toHaveBeenCalledWith(
        'Varro session title fallback: session-1'
      );

      hiddenSession.resolve({ id: 'hidden-late' });
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(hiddenSessions.hide).toHaveBeenCalledWith('hidden-late');
      expect(request).toHaveBeenCalledWith('DELETE', '/session/hidden-late');
      expect(request.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
