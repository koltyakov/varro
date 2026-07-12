import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  vscode: {
    window: {
      showOpenDialog: vi.fn(() => Promise.resolve(undefined)),
      showTextDocument: vi.fn(() => Promise.resolve()),
    },
    workspace: {
      textDocuments: [],
      getWorkspaceFolder: vi.fn(() => undefined),
      asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
      fs: {
        readFile: vi.fn(),
        writeFile: vi.fn(() => Promise.resolve()),
        stat: vi.fn(),
        createDirectory: vi.fn(() => Promise.resolve()),
      },
      openTextDocument: vi.fn(() => Promise.resolve({})),
    },
    Uri: {
      file: vi.fn((fsPath: string) => ({ fsPath, toString: () => fsPath })),
    },
  },
}));

vi.mock('vscode', () => mocks.vscode);
vi.mock('./logger', () => ({ logger: mocks.logger }));

import {
  RestProxy,
  getOpenCodeDirectoryHeaders,
  resolveOpenCodeProjectConfigPaths,
  scopeOpenCodeRequest,
} from './rest-proxy';
import type { RestProxyCallbacks } from './rest-proxy';

function createCallbacks(overrides: Partial<RestProxyCallbacks> = {}): RestProxyCallbacks {
  return {
    server: {
      getWorkspaceCwd: vi.fn(() => '/repo'),
      request: vi.fn(() => Promise.resolve(undefined)),
    },
    contextProvider: {
      context: { workspacePath: '/repo', activeFile: null, selection: null, diagnostics: [] },
      readFile: vi.fn(() => Promise.resolve(null as string | null)),
      resolvePath: vi.fn(() => Promise.resolve(null)),
    },
    providerLimitService: {
      get: vi.fn(() =>
        Promise.resolve({
          providerID: 'test',
          modelID: null,
          status: 'unsupported' as const,
          source: 'opencode' as const,
          checkedAt: 0,
          note: '',
        })
      ),
    },
    sessionState: {
      handleServerEvent: vi.fn(),
      isSessionInWorkspace: vi.fn(() => true),
      markSessionBusy: vi.fn((sessionID: string) => ({ sessionID, id: 1 })),
      deferPromptFailure: vi.fn(),
      reconcilePromptFailure: vi.fn(),
      removeSessions: vi.fn(),
    },
    sessionTrash: {
      cleanupExpired: vi.fn(() => Promise.resolve([] as never[])),
      deletePermanently: vi.fn(() => Promise.resolve(null)),
      empty: vi.fn(() => Promise.resolve([] as never[])),
      filterVisibleSessionRequests: vi.fn(<T>(arr: T[]) => arr) as never,
      filterVisibleSessions: vi.fn(<T>(arr: T[]) => arr) as never,
      filterVisibleSessionStatuses: vi.fn(<T>(obj: Record<string, T>) => obj) as never,
      isHidden: vi.fn(() => false),
      list: vi.fn(() => []),
      moveToTrash: vi.fn(() => Promise.resolve(null)),
      restore: vi.fn(() => Promise.resolve(null)),
    },
    pinnedSessions: {
      setPinned: vi.fn((_sessionID: string, pinned: boolean) =>
        Promise.resolve(pinned ? ['session-1'] : [])
      ),
    },
    hiddenSessions: {
      filterVisibleSessionRequests: vi.fn(<T>(arr: T[]) => arr) as never,
      filterVisibleSessions: vi.fn(<T>(arr: T[]) => arr) as never,
      filterVisibleSessionStatuses: vi.fn(<T>(obj: Record<string, T>) => obj) as never,
      isHidden: vi.fn(() => false),
    },
    autoApproveJudge: {
      judge: vi.fn(() => Promise.resolve({ decision: 'ask' as const, reason: 'test' })),
    },
    sessionTitleFallback: {
      renameIfUntitled: vi.fn(() => Promise.resolve(null)),
    },
    simulateNoProviders: false,
    getRequestGeneration: vi.fn(() => 1),
    getStatus: vi.fn(() => ({ state: 'running' as const, url: 'http://127.0.0.1:4096' })),
    ensureServerStarted: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
    cleanupExpiredRecycleBin: vi.fn(() => Promise.resolve()),
    postApiResponse: vi.fn(),
    ...overrides,
  };
}

function createProxy(overrides: Partial<RestProxyCallbacks> = {}) {
  const callbacks = createCallbacks(overrides);
  return { proxy: new RestProxy(callbacks), callbacks };
}

function makePayload(id: number, method: string, path: string, body?: unknown) {
  return { id, method, path, body };
}

describe('scopeOpenCodeRequest', () => {
  it('returns URL string when path is valid', () => {
    const result = scopeOpenCodeRequest('http://127.0.0.1:4096', '/session');
    expect(result.url).toBe('http://127.0.0.1:4096/session');
  });

  it('appends directory query param when directory is provided and not a global path', () => {
    const result = scopeOpenCodeRequest('http://127.0.0.1:4096', '/session', '/workspace');
    expect(result.url).toContain('directory=%2Fworkspace');
    expect(result.directory).toBe('/workspace');
  });

  it('adds current API location directory query params for /api paths', () => {
    const result = scopeOpenCodeRequest('http://127.0.0.1:4096', '/api/event', '/repo');

    expect(result.url).toBe(
      'http://127.0.0.1:4096/api/event?directory=%2Frepo&location%5Bdirectory%5D=%2Frepo'
    );
    expect(result.directory).toBe('/repo');
  });

  it('normalizes Windows directory scoping for session requests', () => {
    const result = scopeOpenCodeRequest(
      'http://127.0.0.1:4096',
      '/session',
      'C:\\Users\\Andrew\\Projects\\Varro\\'
    );

    expect(result.url).toBe(
      'http://127.0.0.1:4096/session?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro'
    );
    expect(result.directory).toBe('C:\\Users\\Andrew\\Projects\\Varro');
  });

  it('preserves Windows path separators and casing when scoping requests', () => {
    const result = scopeOpenCodeRequest(
      'http://127.0.0.1:4096',
      '/session',
      'C:\\Users\\Andrew\\Projects\\Varro'
    );

    expect(result.url).toContain('directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro');
    expect(result.url).not.toContain('c%3A%2Fusers%2Fandrew%2Fprojects%2Fvarro');
    expect(result.directory).toBe('C:\\Users\\Andrew\\Projects\\Varro');
  });

  it('preserves Windows drive and UNC roots', () => {
    expect(scopeOpenCodeRequest('http://127.0.0.1:4096', '/session', 'C:\\').directory).toBe(
      'C:\\'
    );
    expect(
      scopeOpenCodeRequest('http://127.0.0.1:4096', '/session', '\\\\server\\share\\').directory
    ).toBe('\\\\server\\share\\');
  });

  it('prefers an explicit directory query over the fallback workspace directory', () => {
    const result = scopeOpenCodeRequest(
      'http://127.0.0.1:4096',
      '/session?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro',
      'D:\\Other'
    );

    expect(result.url).toBe(
      'http://127.0.0.1:4096/session?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro'
    );
    expect(result.directory).toBe('C:\\Users\\Andrew\\Projects\\Varro');
  });

  it('normalizes an explicit Windows directory query for session deletes', () => {
    const result = scopeOpenCodeRequest(
      'http://127.0.0.1:4096',
      '/session/some-id?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro%5C'
    );

    expect(result.url).toBe(
      'http://127.0.0.1:4096/session/some-id?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro'
    );
    expect(result.directory).toBe('C:\\Users\\Andrew\\Projects\\Varro');
  });

  it('skips directory param for global paths', () => {
    const result = scopeOpenCodeRequest('http://127.0.0.1:4096', '/global/health', '/workspace');
    expect(result.url).toBe('http://127.0.0.1:4096/global/health');
  });

  it('throws for paths that do not start with /', () => {
    expect(() => scopeOpenCodeRequest('http://127.0.0.1:4096', 'session')).toThrow(
      'Unsupported OpenCode API path'
    );
  });

  it('throws for paths starting with //', () => {
    expect(() => scopeOpenCodeRequest('http://127.0.0.1:4096', '//evil')).toThrow(
      'Unsupported OpenCode API path'
    );
  });

  it('throws when resulting origin does not match baseUrl', () => {
    expect(() => scopeOpenCodeRequest('http://127.0.0.1:4096', 'http://evil.com/session')).toThrow(
      'Unsupported OpenCode API path'
    );
  });
});

describe('resolveOpenCodeProjectConfigPaths', () => {
  it('loads ancestors first, lets JSONC win, and stops at the worktree', () => {
    const existing = new Set([
      '/repo/.git',
      '/repo/opencode.json',
      '/repo/opencode.jsonc',
      '/repo/packages/app/opencode.jsonc',
      '/opencode.json',
    ]);

    expect(
      resolveOpenCodeProjectConfigPaths('/repo/packages/app', (path) => existing.has(path))
    ).toEqual(['/repo/opencode.json', '/repo/opencode.jsonc', '/repo/packages/app/opencode.jsonc']);
  });

  it('resolves Windows workspace paths independently of the host platform', () => {
    const existing = new Set([
      'C:\\repo\\.git',
      'C:\\repo\\opencode.json',
      'C:\\repo\\packages\\app\\opencode.jsonc',
    ]);

    expect(
      resolveOpenCodeProjectConfigPaths('C:\\repo\\packages\\app', (path) => existing.has(path))
    ).toEqual(['C:\\repo\\opencode.json', 'C:\\repo\\packages\\app\\opencode.jsonc']);
  });
});

describe('getOpenCodeDirectoryHeaders', () => {
  it('returns empty object when no directory provided', () => {
    expect(getOpenCodeDirectoryHeaders()).toEqual({});
    expect(getOpenCodeDirectoryHeaders(undefined)).toEqual({});
  });

  it('returns raw directory header', () => {
    expect(getOpenCodeDirectoryHeaders('/some/path')).toEqual({
      'x-opencode-directory': '/some/path',
    });
  });

  it('returns raw normalized Windows directory headers', () => {
    expect(getOpenCodeDirectoryHeaders('C:\\Users\\Andrew\\Projects\\Varro')).toEqual({
      'x-opencode-directory': 'C:\\Users\\Andrew\\Projects\\Varro',
    });
  });
});

describe('RestProxy handleRequest', () => {
  it('returns error for disallowed API request', async () => {
    const { proxy, callbacks } = createProxy();
    await proxy.handleRequest(makePayload(1, 'DELETE', '/global/health'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 1,
      error: 'Unsupported API request',
    });
  });

  it('updates pinned sessions without starting OpenCode', async () => {
    const setPinned = vi.fn(() => Promise.resolve(['session-1']));
    const { proxy, callbacks } = createProxy({ pinnedSessions: { setPinned } });

    await proxy.handleRequest(
      makePayload(8, 'POST', '/varro/session/session-1/pin', { pinned: true })
    );

    expect(setPinned).toHaveBeenCalledWith('session-1', true);
    expect(callbacks.ensureServerStarted).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 8,
      data: ['session-1'],
    });
  });

  it('rejects malformed pin requests', async () => {
    const { proxy, callbacks } = createProxy();

    await proxy.handleRequest(
      makePayload(9, 'POST', '/varro/session/session-1/pin', { pinned: 'yes' })
    );

    expect(callbacks.pinnedSessions.setPinned).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 9,
      error: 'Invalid pin request',
    });
  });

  it('rejects direct session requests owned by another workspace', async () => {
    const serverRequest = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session') {
        return [{ id: 'foreign', directory: '/other' }];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        isSessionInWorkspace: vi.fn(() => false),
      } as never,
    });

    await proxy.handleRequest(makePayload(91, 'GET', '/session/foreign/message'));

    expect(serverRequest).toHaveBeenCalledTimes(1);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 91,
      error: '404 Session not found',
    });
  });

  it('rejects foreign sessions before local Varro actions run', async () => {
    const setPinned = vi.fn(() => Promise.resolve(['foreign']));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: vi.fn(() => Promise.resolve([{ id: 'foreign', directory: '/other' }])),
      } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        isSessionInWorkspace: vi.fn(() => false),
      } as never,
      pinnedSessions: { setPinned },
    });

    await proxy.handleRequest(
      makePayload(92, 'POST', '/varro/session/foreign/pin', { pinned: true })
    );

    expect(setPinned).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 92,
      error: '404 Session not found',
    });
  });

  it('allows normalized Windows workspace matches from an authoritative lookup', async () => {
    const serverRequest = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session') {
        return [{ id: 'session one', directory: 'c:/users/andrew/projects/VARRO/' }];
      }
      if (method === 'GET' && path === '/session/session%20one/message') return [];
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: 'C:\\Users\\Andrew\\Projects\\Varro',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        isSessionInWorkspace: vi.fn(() => false),
      } as never,
    });

    await proxy.handleRequest(makePayload(93, 'GET', '/session/session%20one/message'));

    expect(serverRequest.mock.calls).toEqual([
      ['GET', '/session'],
      ['GET', '/session/session%20one/message', undefined],
    ]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 93, data: [] });
  });

  it('routes recycle bin list request', async () => {
    const trashList = [{ rootID: 'abc' }];
    const { proxy, callbacks } = createProxy({
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        list: vi.fn(() => trashList),
      } as never,
    });
    await proxy.handleRequest(makePayload(2, 'GET', '/varro/session-trash'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 2, data: trashList });
  });

  it('routes recycle bin empty request', async () => {
    const empty = vi.fn(
      async (deleteSession: (session: { id: string; directory?: string }) => Promise<unknown>) => {
        await deleteSession({ id: 's1', directory: '/repo/a' });
        await deleteSession({ id: 's2', directory: '/repo/b' });
        return [{ sessions: [{ id: 's1' }, { id: 's2' }] } as never];
      }
    );
    const serverRequest = vi.fn(() => Promise.resolve(true));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        empty,
      } as never,
    });
    await proxy.handleRequest(makePayload(3, 'DELETE', '/varro/session-trash'));
    expect(callbacks.sessionTrash.empty).toHaveBeenCalled();
    expect(serverRequest.mock.calls).toEqual([
      ['DELETE', '/session/s1?directory=%2Frepo%2Fa'],
      ['DELETE', '/session/s2?directory=%2Frepo%2Fb'],
    ]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 3, data: true });
  });

  it('routes recycle bin restore request', async () => {
    const restored = { rootID: 'abc', sessions: [{ id: 's1' }] };
    const { proxy, callbacks } = createProxy({
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        restore: vi.fn(() => Promise.resolve(restored)),
      } as never,
    });
    await proxy.handleRequest(makePayload(4, 'POST', '/varro/session-trash/abc/restore'));
    expect(callbacks.sessionTrash.restore).toHaveBeenCalledWith('abc');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 4, data: true });
  });

  it('routes recycle bin delete request and removes sessions', async () => {
    const removed = { sessions: [{ id: 's1' }, { id: 's2' }] };
    const deletePermanently = vi.fn(
      async (
        _rootID: string,
        deleteSession: (session: { id: string; directory?: string }) => Promise<unknown>
      ) => {
        await deleteSession({ id: 's1', directory: '/repo/a' });
        await deleteSession({ id: 's2', directory: '/repo/b' });
        return removed;
      }
    );
    const serverRequest = vi.fn(() => Promise.resolve(true));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        deletePermanently,
      } as never,
    });
    await proxy.handleRequest(makePayload(5, 'DELETE', '/varro/session-trash/abc/delete'));
    expect(serverRequest.mock.calls).toEqual([
      ['DELETE', '/session/s1?directory=%2Frepo%2Fa'],
      ['DELETE', '/session/s2?directory=%2Frepo%2Fb'],
    ]);
    expect(callbacks.sessionState.removeSessions).toHaveBeenCalledWith(['s1', 's2']);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 5, data: true });
  });

  it('treats trash session deletes as done when the session is gone from the server', async () => {
    // Legacy-format session IDs make the server DELETE fail with a non-404;
    // the delete must still succeed when the session no longer exists.
    const removed = { sessions: [{ id: 'legacy-1' }] };
    const deletePermanently = vi.fn(
      async (
        _rootID: string,
        deleteSession: (session: { id: string; directory?: string }) => Promise<unknown>
      ) => {
        await deleteSession({ id: 'legacy-1', directory: '/repo' });
        return removed;
      }
    );
    const serverRequest = vi.fn((method: string) => {
      if (method === 'DELETE') return Promise.reject(new Error('500 Unexpected server error'));
      return Promise.resolve([{ id: 'other-session' }]);
    });
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        deletePermanently,
      } as never,
    });
    await proxy.handleRequest(makePayload(6, 'DELETE', '/varro/session-trash/legacy-1/delete'));
    expect(callbacks.sessionState.removeSessions).toHaveBeenCalledWith(['legacy-1']);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 6, data: true });
  });

  it('propagates trash session delete failures when the session still exists', async () => {
    const deletePermanently = vi.fn(
      async (
        _rootID: string,
        deleteSession: (session: { id: string; directory?: string }) => Promise<unknown>
      ) => {
        await deleteSession({ id: 'busy-1', directory: '/repo' });
        return { sessions: [{ id: 'busy-1' }] };
      }
    );
    const serverRequest = vi.fn((method: string) => {
      if (method === 'DELETE') return Promise.reject(new Error('500 Unexpected server error'));
      return Promise.resolve([{ id: 'busy-1' }]);
    });
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        deletePermanently,
      } as never,
    });
    await proxy.handleRequest(makePayload(7, 'DELETE', '/varro/session-trash/busy-1/delete'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 7,
      error: '500 Unexpected server error',
    });
  });

  it('routes workspace file read request', async () => {
    const fileContent = 'file content here';
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        readFile: vi.fn(() => Promise.resolve(fileContent)),
      } as never,
    });
    await proxy.handleRequest(makePayload(6, 'GET', '/varro/workspace-file?path=src/foo.ts'));
    expect(callbacks.contextProvider.readFile).toHaveBeenCalledWith('src/foo.ts');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 6, data: fileContent });
  });

  it('routes workspace path resolve request', async () => {
    const resolved = {
      path: '/repo/src/foo.ts',
      relativePath: 'src/foo.ts',
      type: 'file' as const,
    };
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        resolvePath: vi.fn(() => Promise.resolve(resolved)),
      } as never,
    });

    await proxy.handleRequest(
      makePayload(61, 'GET', '/varro/workspace-path/resolve?path=src/foo.ts')
    );

    expect(callbacks.contextProvider.resolvePath).toHaveBeenCalledWith('src/foo.ts');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 61, data: resolved });
  });

  it('returns error for workspace file request without path', async () => {
    const { proxy, callbacks } = createProxy();
    await proxy.handleRequest(makePayload(7, 'GET', '/varro/workspace-file'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 7,
      error: 'Unsupported API request',
    });
  });

  it('routes provider limit request', async () => {
    const limitStatus = { providerID: 'openai', modelID: 'gpt-4', status: 'available' };
    const { proxy, callbacks } = createProxy({
      providerLimitService: { get: vi.fn(() => Promise.resolve(limitStatus)) } as never,
    });
    await proxy.handleRequest(
      makePayload(8, 'GET', '/varro/provider-limit?providerID=openai&modelID=gpt-4')
    );
    expect(callbacks.providerLimitService.get).toHaveBeenCalledWith('openai', 'gpt-4');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 8, data: limitStatus });
  });

  it('routes auto-approve judge requests after server startup', async () => {
    const judgeResult = { decision: 'allow' as const, reason: 'safe' };
    const { proxy, callbacks } = createProxy({
      getStatus: vi.fn(() => ({ state: 'stopped' as const })),
      autoApproveJudge: {
        judge: vi.fn(() => Promise.resolve(judgeResult)),
      },
    });

    await proxy.handleRequest(
      makePayload(81, 'POST', '/varro/permission/judge', {
        permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
        approvedReferences: [{ type: 'bash', title: 'bash git status', response: 'once' }],
      })
    );

    expect(callbacks.ensureServerStarted).toHaveBeenCalledOnce();
    expect(callbacks.autoApproveJudge.judge).toHaveBeenCalledWith({
      permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
      approvedReferences: [{ type: 'bash', title: 'bash git status', response: 'once' }],
    });
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 81, data: judgeResult });
  });

  it('routes session title fallback requests after server startup', async () => {
    const { proxy, callbacks } = createProxy({
      sessionTitleFallback: {
        renameIfUntitled: vi.fn(() => Promise.resolve({ id: 'session-1', title: 'Fix build' })),
      },
    });

    await proxy.handleRequest(
      makePayload(1, 'POST', '/varro/session/session-1/rename-if-untitled')
    );

    expect(callbacks.sessionTitleFallback.renameIfUntitled).toHaveBeenCalledWith('session-1');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 1,
      data: { id: 'session-1', title: 'Fix build' },
    });
  });

  it('returns only aggregate session edit and token data to the webview', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session') {
        return Promise.resolve([
          { id: 'session-1', directory: '/repo' },
          {
            id: 'child-1',
            parentID: 'session-1',
            directory: '/repo',
            tokens: {
              input: 400,
              output: 100,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          { id: 'grandchild-1', parentID: 'child-1', directory: '/repo' },
        ]);
      }
      if (path === '/session/grandchild-1/message') {
        return Promise.resolve([{ info: { role: 'assistant', tokens: { total: 200 } } }]);
      }
      return Promise.resolve(
        path.endsWith('/diff')
          ? [
              {
                file: 'src/a.ts',
                additions: 4,
                deletions: 1,
                before: 'FULL_BEFORE_TEXT',
                after: 'FULL_AFTER_TEXT',
                patch: 'FULL_PATCH_TEXT',
              },
              {
                file: 'src/b.ts',
                additions: 2,
                deletions: 3,
                before: 'OTHER_BEFORE_TEXT',
                after: 'OTHER_AFTER_TEXT',
              },
            ]
          : [
              { info: { role: 'user', time: { created: 1_000 } }, parts: [] },
              {
                info: {
                  role: 'assistant',
                  time: { created: 2_000, completed: 5_000 },
                  tokens: {
                    total: 1_000,
                    input: 900,
                    output: 200,
                    reasoning: 100,
                    cache: { read: 50, write: 25 },
                  },
                },
                parts: [{ type: 'text', text: 'FULL_ASSISTANT_TEXT' }],
              },
              {
                info: { role: 'user', time: { created: 6_000 } },
                parts: [],
              },
              {
                info: {
                  role: 'assistant',
                  time: { created: 7_000, completed: 12_000 },
                  tokens: {
                    input: 2_000,
                    output: 300,
                    reasoning: 50,
                    cache: { read: 100, write: 25 },
                  },
                },
                parts: [],
              },
              {
                info: {
                  role: 'assistant',
                  mode: 'subagent',
                  time: { created: 7_500, completed: 20_000 },
                },
                parts: [],
              },
              {
                info: { role: 'user', time: { created: 13_000 }, tokens: { total: 99_999 } },
                parts: [],
              },
              {
                info: { role: 'assistant', time: { created: 14_000 }, tokens: {} },
                parts: [],
              },
            ]
      );
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(82, 'GET', '/varro/session/session-1/diff-summary'));

    expect(serverRequest.mock.calls).toEqual([
      ['GET', '/session/session-1/diff'],
      ['GET', '/session/session-1/message'],
      ['GET', '/session'],
      ['GET', '/session/grandchild-1/message'],
    ]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 82,
      data: {
        files: 2,
        additions: 6,
        deletions: 4,
        tokens: 4_175,
        durationMs: 10_000,
        activeStartedAt: 13_000,
      },
    });
    const response = (callbacks.postApiResponse as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(response)).not.toContain('FULL_');
    expect(JSON.stringify(response)).not.toContain('OTHER_');
  });

  it('falls back to message tool metadata when the session diff is empty', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session') return Promise.resolve([]);
      return Promise.resolve(
        path.endsWith('/diff')
          ? []
          : [
              {
                info: {
                  role: 'assistant',
                  time: { created: 1_000, completed: 4_000 },
                  tokens: { total: 500 },
                },
                parts: [
                  {
                    type: 'tool',
                    tool: 'apply_patch',
                    state: {
                      status: 'completed',
                      metadata: {
                        files: [
                          {
                            filePath: '/repo/src/a.ts',
                            relativePath: 'src/a.ts',
                            type: 'update',
                            additions: 4,
                            deletions: 1,
                          },
                          {
                            filePath: '/repo/src/b.ts',
                            relativePath: 'src/b.ts',
                            type: 'add',
                            additions: 2,
                            deletions: 0,
                          },
                        ],
                      },
                    },
                  },
                  { type: 'patch', files: ['/repo/src/a.ts', '/repo/src/b.ts'] },
                ],
              },
            ]
      );
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(83, 'GET', '/varro/session/session-1/diff-summary'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 83,
      data: {
        files: 2,
        additions: 6,
        deletions: 1,
        tokens: 500,
        durationMs: 3_000,
        activeStartedAt: null,
      },
    });
  });

  it('simulates no providers when flag is set', async () => {
    const { proxy, callbacks } = createProxy({ simulateNoProviders: true });
    await proxy.handleRequest(makePayload(9, 'GET', '/config/providers'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 9,
      data: { providers: [], default: {} },
    });
  });

  it('returns 404 error for hidden session', async () => {
    const { proxy, callbacks } = createProxy({
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        isHidden: vi.fn(() => true),
      } as never,
    });
    await proxy.handleRequest(makePayload(10, 'GET', '/session/hidden-id'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 10,
      error: '404 Session not found',
    });
  });

  it('returns 404 error for extension-hidden sessions', async () => {
    const { proxy, callbacks } = createProxy({
      hiddenSessions: {
        ...createCallbacks().hiddenSessions,
        isHidden: vi.fn(() => true),
      } as never,
    });
    await proxy.handleRequest(makePayload(101, 'GET', '/session/hidden-id'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 101,
      error: '404 Session not found',
    });
  });

  it('routes soft delete (DELETE /session/:id) to moveToTrash', async () => {
    const entry = { sessions: [{ id: 's1' }] };
    const serverRequest = vi.fn(() => Promise.resolve([]));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        moveToTrash: vi.fn(() => Promise.resolve(entry)),
      } as never,
    });
    await proxy.handleRequest(makePayload(11, 'DELETE', '/session/some-id'));
    expect(serverRequest).toHaveBeenCalledWith('GET', '/session');
    expect(callbacks.sessionTrash.moveToTrash).toHaveBeenCalledWith('some-id', []);
    expect(callbacks.sessionState.removeSessions).toHaveBeenCalledWith(['s1']);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 11, data: true });
  });

  it('routes varro permanent delete directly to the server without recycle bin', async () => {
    const serverRequest = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'some-id', directory: '/repo/archive' }])
      .mockResolvedValueOnce(true);
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
    });

    await proxy.handleRequest(makePayload(111, 'DELETE', '/varro/session/some-id/delete'));

    expect(serverRequest.mock.calls).toEqual([
      ['GET', '/session'],
      ['DELETE', '/session/some-id?directory=%2Frepo%2Farchive'],
    ]);
    expect(callbacks.sessionTrash.moveToTrash).not.toHaveBeenCalled();
    expect(callbacks.sessionState.removeSessions).toHaveBeenCalledWith(['some-id']);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 111, data: true });
  });

  it('ignores workspace-specific directory scoping when looking up a session tree for soft delete', async () => {
    const entry = { sessions: [{ id: 's1' }] };
    const serverRequest = vi.fn(() => Promise.resolve([]));
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: 'C:\\Users\\Andrew\\Projects\\Varro',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      } as never,
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        moveToTrash: vi.fn(() => Promise.resolve(entry)),
      } as never,
    });

    await proxy.handleRequest(makePayload(12, 'DELETE', '/session/some-id'));

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session');
    expect(callbacks.sessionTrash.moveToTrash).toHaveBeenCalledWith('some-id', []);
  });

  it('returns 404 error when moveToTrash returns null', async () => {
    const serverRequest = vi.fn(() => Promise.resolve([]));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        moveToTrash: vi.fn(() => Promise.resolve(null)),
      } as never,
    });
    await proxy.handleRequest(makePayload(13, 'DELETE', '/session/nonexistent'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 13,
      error: '404 Session not found',
    });
  });

  it('ensures server is started when status is not running', async () => {
    const { proxy, callbacks } = createProxy({
      getStatus: vi.fn(() => ({ state: 'stopped' as const })),
    });
    await proxy.handleRequest(makePayload(13, 'GET', '/session'));
    expect(callbacks.ensureServerStarted).toHaveBeenCalled();
    expect(callbacks.cleanupExpiredRecycleBin).toHaveBeenCalled();
  });

  it('skips server start when already running', async () => {
    const { proxy, callbacks } = createProxy();
    await proxy.handleRequest(makePayload(14, 'GET', '/session'));
    expect(callbacks.ensureServerStarted).not.toHaveBeenCalled();
  });

  it('forwards passthrough requests to server', async () => {
    const serverData = [{ id: 's1', directory: '/repo' }];
    const serverRequest = vi.fn(() => Promise.resolve(serverData));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
    });
    await proxy.handleRequest(makePayload(15, 'GET', '/session'));
    expect(serverRequest).toHaveBeenCalledWith('GET', '/session', undefined);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 15,
      data: serverData,
    });
  });

  it('filters session list through sessionTrash', async () => {
    const sessions = [
      { id: 'visible', directory: '/repo' },
      { id: 'hidden', directory: '/repo' },
    ];
    const filtered = [{ id: 'visible', directory: '/repo' }];
    const serverRequest = vi.fn(() => Promise.resolve(sessions));
    const filterVisible = vi.fn(() => filtered);
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        filterVisibleSessions: filterVisible,
      } as never,
    });
    await proxy.handleRequest(makePayload(16, 'GET', '/session'));
    expect(filterVisible).toHaveBeenCalledWith(sessions);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 16, data: filtered });
  });

  it('filters session list to the exact current workspace directory', async () => {
    const sessions = [
      { id: 'root', directory: '/repo' },
      { id: 'nested', directory: '/repo/project-a' },
      { id: 'other', directory: '/other' },
    ];
    const serverRequest = vi.fn(() => Promise.resolve(sessions));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(116, 'GET', '/session'));

    expect(callbacks.sessionState.handleServerEvent).toHaveBeenCalledTimes(3);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 116,
      data: [{ id: 'root', directory: '/repo' }],
    });
  });

  it('filters UNC sessions using case-insensitive Windows identity', async () => {
    const sessions = [
      { id: 'same', directory: '//buildserver/PROJECTS/varro/' },
      { id: 'other', directory: '//buildserver/Projects/other' },
    ];
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: '\\\\BuildServer\\Projects\\Varro',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      } as never,
      server: {
        ...createCallbacks().server,
        request: vi.fn(() => Promise.resolve(sessions)),
      } as never,
    });

    await proxy.handleRequest(makePayload(117, 'GET', '/session'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 117,
      data: [{ id: 'same', directory: '//buildserver/PROJECTS/varro/' }],
    });
  });

  it('sanitizes session messages', async () => {
    const messages = [
      {
        info: {
          id: 'm1',
          sessionID: 's1',
          role: 'user',
          time: { created: 1234567890 },
        },
        parts: [{ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'hello' }],
      },
      {
        info: { id: '', sessionID: 's1', role: 'user', time: { created: 1 } },
        parts: [],
      },
    ];
    const serverRequest = vi.fn(() => Promise.resolve(messages));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    await proxy.handleRequest(makePayload(17, 'GET', '/session/s1/message'));
    const response = (callbacks.postApiResponse as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(response.id).toBe(17);
    expect(response.data).toHaveLength(1);
    expect(response.data[0].info.id).toBe('m1');
    expect(response.data[0].parts).toHaveLength(1);
  });

  it('preserves pagination cursors while sanitizing session messages', async () => {
    const messages = [
      {
        info: {
          id: 'm1',
          sessionID: 's1',
          role: 'user',
          time: { created: 1234567890 },
        },
        parts: [{ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'hello' }],
      },
    ];
    const serverRequest = vi.fn(() => Promise.resolve({ data: messages, nextCursor: 'cursor-2' }));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(117, 'GET', '/session/s1/message?limit=200'));

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session/s1/message?limit=200', undefined, {
      captureNextCursor: true,
    });
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 117,
      data: { items: messages, nextCursor: 'cursor-2' },
    });
  });

  it('filters malformed parts within valid entries', async () => {
    const messages = [
      {
        info: {
          id: 'm1',
          sessionID: 's1',
          role: 'assistant',
          time: { created: 1234567890 },
        },
        parts: [
          { id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'ok' },
          { id: '', messageID: 'm1', sessionID: 's1', type: 'text' },
          { bad: true },
        ],
      },
    ];
    const serverRequest = vi.fn(() => Promise.resolve(messages));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    await proxy.handleRequest(makePayload(18, 'GET', '/session/s1/message'));
    const response = (callbacks.postApiResponse as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(response.data[0].parts).toHaveLength(1);
    expect(response.data[0].parts[0].id).toBe('p1');
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('catches thrown errors and posts error response', async () => {
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: vi.fn(() => Promise.reject(new Error('server down'))),
      } as never,
    });
    await proxy.handleRequest(makePayload(19, 'GET', '/session'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 19,
      error: 'server down',
    });
  });

  it('catches non-Error throws and converts to string', async () => {
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: vi.fn(() => Promise.reject('string error')),
      } as never,
    });
    await proxy.handleRequest(makePayload(20, 'GET', '/session'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 20,
      error: 'string error',
    });
  });

  it('uses current request generation in response', async () => {
    const { proxy, callbacks } = createProxy({
      getRequestGeneration: vi.fn(() => 42),
    });
    await proxy.handleRequest(makePayload(21, 'GET', '/varro/session-trash'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(42, expect.anything());
  });

  it('filters session status responses through sessionTrash', async () => {
    const statuses = { s1: { state: 'active' }, s2: { state: 'idle' } };
    const filtered = { s1: { state: 'active' } };
    const serverRequest = vi.fn(() => Promise.resolve(statuses));
    const filterStatuses = vi.fn(() => filtered);
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        filterVisibleSessionStatuses: filterStatuses,
      } as never,
    });
    await proxy.handleRequest(makePayload(22, 'GET', '/session/status'));
    expect(filterStatuses).toHaveBeenCalledWith(statuses);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 22, data: filtered });
  });

  it('filters question responses through sessionTrash', async () => {
    const questions = [{ sessionID: 's1' }, { sessionID: 's2' }];
    const filtered = [{ sessionID: 's1' }];
    const serverRequest = vi.fn(() => Promise.resolve(questions));
    const filterQuestions = vi.fn(() => filtered);
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        filterVisibleSessionRequests: filterQuestions,
      } as never,
    });
    await proxy.handleRequest(makePayload(23, 'GET', '/question'));
    expect(filterQuestions).toHaveBeenCalledWith(questions);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 23, data: filtered });
  });

  it('passes through non-session responses without filtering', async () => {
    const configData = { providers: [{ id: 'openai' }] };
    const serverRequest = vi.fn(() => Promise.resolve(configData));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    await proxy.handleRequest(makePayload(24, 'GET', '/config/providers'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 24,
      data: configData,
    });
  });

  it('optimistically marks a session busy before forwarding prompt_async', async () => {
    const order: string[] = [];
    const serverRequest = vi.fn(() => {
      order.push('request');
      return Promise.resolve({ ok: true });
    });
    const markSessionBusy = vi.fn(() => {
      order.push('markBusy');
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: { ...createCallbacks().sessionState, markSessionBusy } as never,
    });

    await proxy.handleRequest(
      makePayload(30, 'POST', '/session/session-1/prompt_async', { parts: [] })
    );

    expect(markSessionBusy).toHaveBeenCalledWith('session-1');
    // The busy marker must be recorded before the request is forwarded so a
    // finish event that lands during admission cannot be dropped.
    expect(order).toEqual(['markBusy', 'request']);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 30,
      data: { ok: true },
    });
  });

  it('extracts the session id from a prompt_async path', async () => {
    const markSessionBusy = vi.fn();
    const { proxy } = createProxy({
      sessionState: { ...createCallbacks().sessionState, markSessionBusy } as never,
    });

    await proxy.handleRequest(
      makePayload(31, 'POST', '/session/01J6XQT8HM2N1V9K6Q3B7Y4C0P/prompt_async')
    );

    expect(markSessionBusy).toHaveBeenCalledWith('01J6XQT8HM2N1V9K6Q3B7Y4C0P');
  });

  it('reconciles a failed prompt against authoritative session status', async () => {
    const attempt = { sessionID: 'session-1', id: 17 };
    const serverRequest = vi.fn((method: string, path: string) => {
      if (method === 'POST') return Promise.reject(new Error('prompt rejected'));
      if (path === '/session/status') return Promise.resolve({});
      return Promise.resolve(undefined);
    });
    const markSessionBusy = vi.fn(() => attempt);
    const reconcilePromptFailure = vi.fn();
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        markSessionBusy,
        reconcilePromptFailure,
      } as never,
    });

    await proxy.handleRequest(
      makePayload(32, 'POST', '/session/session-1/prompt_async', { parts: [] })
    );

    expect(serverRequest.mock.calls).toEqual([
      ['POST', '/session/session-1/prompt_async', { parts: [] }],
      ['GET', '/session/status'],
    ]);
    expect(reconcilePromptFailure).toHaveBeenCalledWith(attempt, undefined);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 32,
      error: 'prompt rejected',
    });
  });

  it('immediately rolls back known pre-admission prompt failures', async () => {
    const attempt = { sessionID: 'session-1', id: 18 };
    const serverRequest = vi.fn(() => Promise.reject(new Error('422 Invalid prompt body')));
    const reconcilePromptFailure = vi.fn();
    const deferPromptFailure = vi.fn();
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        markSessionBusy: vi.fn(() => attempt),
        deferPromptFailure,
        reconcilePromptFailure,
      } as never,
    });

    await proxy.handleRequest(makePayload(33, 'POST', '/session/session-1/prompt_async'));

    expect(serverRequest).toHaveBeenCalledOnce();
    expect(reconcilePromptFailure).toHaveBeenCalledWith(attempt, undefined);
    expect(deferPromptFailure).not.toHaveBeenCalled();
  });

  it('defers rollback when prompt and restart-time status reconciliation both fail', async () => {
    const attempt = { sessionID: 'session-1', id: 19 };
    const serverRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('OpenCode server is restarting'));
    const reconcilePromptFailure = vi.fn();
    const deferPromptFailure = vi.fn();
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        markSessionBusy: vi.fn(() => attempt),
        deferPromptFailure,
        reconcilePromptFailure,
      } as never,
    });

    await proxy.handleRequest(makePayload(34, 'POST', '/session/session-1/prompt_async'));

    expect(serverRequest.mock.calls).toEqual([
      ['POST', '/session/session-1/prompt_async', undefined],
      ['GET', '/session/status'],
    ]);
    expect(deferPromptFailure).toHaveBeenCalledWith(attempt);
    expect(reconcilePromptFailure).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 34,
      error: 'fetch failed',
    });
  });

  it('does not optimistically mark busy for non-prompt requests', async () => {
    const markSessionBusy = vi.fn();
    const { proxy } = createProxy({
      sessionState: { ...createCallbacks().sessionState, markSessionBusy } as never,
    });

    await proxy.handleRequest(makePayload(35, 'POST', '/session/session-1/abort'));

    expect(markSessionBusy).not.toHaveBeenCalled();
  });
});
