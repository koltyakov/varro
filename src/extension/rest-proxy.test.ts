import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  vscode: {
    window: {
      showOpenDialog: vi.fn(() => Promise.resolve(undefined)),
      showTextDocument: vi.fn(() => Promise.resolve()),
    },
    workspace: {
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

import { RestProxy, getOpenCodeDirectoryHeaders, scopeOpenCodeRequest } from './rest-proxy';
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
    sessionState: { markSessionBusy: vi.fn(), removeSessions: vi.fn() },
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
    hiddenSessions: {
      filterVisibleSessionRequests: vi.fn(<T>(arr: T[]) => arr) as never,
      filterVisibleSessions: vi.fn(<T>(arr: T[]) => arr) as never,
      filterVisibleSessionStatuses: vi.fn(<T>(obj: Record<string, T>) => obj) as never,
      isHidden: vi.fn(() => false),
    },
    autoApproveJudge: {
      judge: vi.fn(() => Promise.resolve({ decision: 'ask' as const, reason: 'test' })),
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
    const serverData = [{ id: 's1' }];
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
    const sessions = [{ id: 'visible' }, { id: 'hidden' }];
    const filtered = [{ id: 'visible' }];
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

  it('does not optimistically mark busy for non-prompt requests', async () => {
    const markSessionBusy = vi.fn();
    const { proxy } = createProxy({
      sessionState: { ...createCallbacks().sessionState, markSessionBusy } as never,
    });

    await proxy.handleRequest(makePayload(32, 'POST', '/session/session-1/abort'));

    expect(markSessionBusy).not.toHaveBeenCalled();
  });
});
