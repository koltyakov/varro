/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These proxy tests deliberately exercise malformed HTTP payloads and partial VS Code and service boundaries. */
import { describe, expect, it, vi, type Mock } from 'vitest';

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
import { OpenCodeResponseTooLargeError } from './open-code-transport';
import { HiddenSessionManager } from './hidden-session-manager';
import { QueuedMessageStore } from './queued-message-store';
import { SessionStateManager } from './session-state-manager';
import type { Persistence } from '../shared/persistence';
import type { RecycleBinEntry } from '../shared/protocol';

type SanitizedMessageResponse = {
  id: number;
  data: SanitizedMessageEntry[];
};

type SanitizedMessageEntry = {
  info: { id: string; [key: string]: unknown };
  parts: Array<{ id: string }>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const allViewsEligible = () => true;

function withSignal(options: Record<string, unknown> = {}) {
  return { ...options, signal: expect.any(AbortSignal) };
}

function createCallbacks(overrides: Partial<RestProxyCallbacks> = {}): RestProxyCallbacks {
  return {
    server: {
      getWorkspaceCwd: vi.fn(() => '/repo'),
      request: vi.fn(() => Promise.resolve(undefined)),
    },
    contextProvider: {
      context: {
        workspacePath: '/repo',
        workspaceFolders: [{ name: 'repo', path: '/repo' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      getOpenWorkspaceRoot: vi.fn((path: string) => path),
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
    activateSession: vi.fn(() => Promise.resolve()),
    sessionState: {
      handleServerEvent: vi.fn(),
      getSessionWorkspaceMatch: vi.fn(() => true),
      isSessionInWorkspace: vi.fn(() => true),
      markSessionBusy: vi.fn((sessionID: string) => ({ sessionID, id: 1 })),
      beginPendingAttentionReconciliation: vi.fn((kind: 'permission' | 'question') => ({
        kind,
        mutationRevision: 0,
        requestGeneration: 1,
      })),
      finishPendingAttentionReconciliation: vi.fn(),
      deferPromptFailure: vi.fn(),
      reconcilePromptFailure: vi.fn(),
      reconcilePendingAttention: vi.fn(),
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
      observeSessionList: vi.fn(() => []),
      retainUntilDeleted: vi.fn(),
    },
    autoApproveJudge: {
      judge: vi.fn(() => Promise.resolve({ decision: 'ask' as const, reason: 'test' })),
      resolveModel: vi.fn(() => Promise.resolve(null)),
    },
    sessionTitleFallback: {
      renameIfUntitled: vi.fn(() => Promise.resolve(null)),
    },
    simulateNoProviders: false,
    getRequestGeneration: vi.fn(() => 1),
    getStatus: vi.fn(() => ({ state: 'running' as const, url: 'http://127.0.0.1:4096' })),
    ensureServerStarted: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
    confirmPromptAdmission: vi.fn(() => Promise.resolve(true)),
    isPermissionAutomationLeaseCurrent: vi.fn(() => true),
    beginQueuedMessageDispatchClaim: vi.fn(() => Promise.resolve(true)),
    isQueuedMessageDispatchClaimCurrent: vi.fn(() => true),
    completeQueuedMessageDispatchClaim: vi.fn(() => Promise.resolve(true)),
    releaseQueuedMessageDispatchClaim: vi.fn(),
    updatePermissionMode: vi.fn(() => Promise.resolve(undefined)),
    cleanupExpiredRecycleBin: vi.fn(() => Promise.resolve()),
    removeSessionImages: vi.fn(() => Promise.resolve()),
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

function recycleBinEntry(
  rootID: string,
  directory: string,
  sessionIDs: string[] = [rootID]
): RecycleBinEntry {
  const session = (id: string) => ({
    id,
    projectID: 'project-1',
    directory,
    title: id,
    version: '1',
    time: { created: 1, updated: 2 },
  });
  return {
    rootID,
    deletedAt: 1,
    expiresAt: 2,
    root: session(rootID),
    sessions: sessionIDs.map(session),
  };
}

function makeSessionMessage(messageID: string, partID: string, sessionID = 's1') {
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'user',
      time: { created: 1234567890 },
    },
    parts: [{ id: partID, messageID, sessionID, type: 'text', text: messageID }],
  };
}

async function requestSanitizedMessagePage(messages: unknown[]) {
  const serverRequest = vi.fn(() => Promise.resolve({ data: messages }));
  const { proxy, callbacks } = createProxy({
    server: { ...createCallbacks().server, request: serverRequest } as never,
  });

  await proxy.handleRequest(makePayload(118, 'GET', '/session/s1/message?limit=50'));

  const response = (callbacks.postApiResponse as Mock<RestProxyCallbacks['postApiResponse']>).mock
    .calls[0]![1] as { id: number; data: { items: SanitizedMessageEntry[] } };
  return response.data.items;
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
  it('persists workspace scope in OpenCode session metadata', async () => {
    const { proxy, callbacks } = createProxy();
    const metadata = {
      varro: { workspaceScope: 'workspace', schemaVersion: 1 },
    };
    vi.mocked(callbacks.server.request).mockResolvedValue({
      id: 'session-workspace',
      directory: '/repo',
      title: 'Workspace session',
      metadata,
    });

    await proxy.handleRequest(makePayload(1, 'POST', '/session?directory=%2Frepo', { metadata }));

    expect(callbacks.server.request).toHaveBeenCalledWith(
      'POST',
      '/session?directory=%2Frepo',
      { metadata },
      expect.anything()
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 1,
      data: expect.objectContaining({ metadata, workspaceScope: 'workspace' }),
    });
  });

  it('injects different system context for workspace and folder sessions', async () => {
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        context: {
          workspacePath: '/repo-a',
          workspaceDirectory: '/workspace',
          workspaceFolders: [
            { name: 'a', path: '/repo-a' },
            { name: 'b', path: '/repo-b' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        getOpenWorkspaceRoot: vi.fn((path: string) => path),
        readFile: vi.fn(() => Promise.resolve(null)),
        resolvePath: vi.fn(() => Promise.resolve(null)),
      },
    });

    const workspaceMetadata = {
      varro: { workspaceScope: 'workspace', schemaVersion: 1 },
    };
    vi.mocked(callbacks.server.request).mockResolvedValueOnce({
      id: 'workspace-session',
      directory: '/workspace',
      title: 'Workspace session',
      metadata: workspaceMetadata,
    });
    await proxy.handleRequest(
      makePayload(0, 'POST', '/session?directory=%2Fworkspace', {
        metadata: workspaceMetadata,
      })
    );
    vi.mocked(callbacks.server.request).mockClear();

    await proxy.handleRequest(
      makePayload(1, 'POST', '/session/workspace-session/prompt_async?directory=%2Fworkspace', {
        parts: [{ type: 'text', text: 'hello' }],
      })
    );
    await proxy.handleRequest(
      makePayload(2, 'POST', '/session/folder-session/prompt_async?directory=%2Frepo-a', {
        system: 'Existing instruction',
        parts: [{ type: 'text', text: 'hello' }],
      })
    );

    const workspaceBody = vi.mocked(callbacks.server.request).mock.calls[0]?.[2];
    const folderBody = vi.mocked(callbacks.server.request).mock.calls[1]?.[2];
    expect(workspaceBody).toEqual(
      expect.objectContaining({
        system: expect.stringContaining('Treat these folders as one logical workspace'),
      })
    );
    expect(workspaceBody).toEqual(
      expect.objectContaining({ system: expect.stringContaining('/repo-b') })
    );
    expect(folderBody).toEqual(
      expect.objectContaining({
        system: expect.stringContaining('Existing instruction\n\nVS Code workspace context:'),
      })
    );
    expect(folderBody).toEqual(
      expect.objectContaining({ system: expect.stringContaining('/repo-a') })
    );
    expect(folderBody).toEqual(
      expect.objectContaining({ system: expect.stringContaining('/repo-b') })
    );
  });

  it('persists inherited workspace metadata when OpenCode omits it from a fork', async () => {
    const { proxy, callbacks } = createProxy();
    const metadata = {
      varro: { workspaceScope: 'workspace', schemaVersion: 1 },
    };
    vi.mocked(callbacks.server.request)
      .mockResolvedValueOnce({
        id: 'parent',
        directory: '/repo',
        title: 'Parent',
        metadata,
      })
      .mockResolvedValueOnce({ id: 'child', directory: '/repo', title: 'Child' })
      .mockResolvedValueOnce({
        id: 'child',
        directory: '/repo',
        title: 'Child',
        metadata,
      });

    await proxy.handleRequest(makePayload(1, 'POST', '/session', { metadata }));
    vi.mocked(callbacks.server.request).mockClear();
    await proxy.handleRequest(makePayload(2, 'POST', '/session/parent/fork', {}));

    expect(callbacks.server.request).toHaveBeenNthCalledWith(
      2,
      'PATCH',
      '/session/child?directory=%2Frepo',
      { metadata }
    );
    expect(callbacks.postApiResponse).toHaveBeenLastCalledWith(1, {
      id: 2,
      data: expect.objectContaining({ metadata, workspaceScope: 'workspace' }),
    });
  });
  it('aborts only the request matching an opaque cancellation key', async () => {
    let requestSignal: AbortSignal | undefined;
    const serverRequest = vi.fn(
      (_method: string, _path: string, _body: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<unknown>((_resolve, reject) => {
          requestSignal = options?.signal;
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        })
    );
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    const operation = proxy.handleRequest({
      id: 41,
      cancelKey: 'request-token-1',
      method: 'GET',
      path: '/session',
    });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    proxy.cancelRequest({ id: 42, cancelKey: 'request-token-1' });
    expect(requestSignal?.aborted).toBe(false);
    proxy.cancelRequest({ id: 41, cancelKey: 'request-token-1' });
    await operation;

    expect(requestSignal?.aborted).toBe(true);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 41,
      error: 'API call aborted',
    });
  });

  it('aborts only requests owned by earlier webview generations', async () => {
    const signals = new Map<string, AbortSignal>();
    const serverRequest = vi.fn(
      (_method: string, path: string, _body: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<unknown>((_resolve, reject) => {
          if (options?.signal) signals.set(path, options.signal);
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        })
    );
    let generation = 1;
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      getRequestGeneration: () => generation,
    });

    const oldRequest = proxy.handleRequest({
      id: 41,
      cancelKey: 'old-request',
      method: 'GET',
      path: '/session/old',
    });
    generation = 2;
    const currentRequest = proxy.handleRequest({
      id: 42,
      cancelKey: 'current-request',
      method: 'GET',
      path: '/session/current',
    });
    await vi.waitFor(() => expect(signals.size).toBe(2));

    proxy.cancelRequestsBeforeGeneration(2);

    expect(signals.get('/session/old')?.aborted).toBe(true);
    expect(signals.get('/session/current')?.aborted).toBe(false);
    proxy.dispose();
    await Promise.all([oldRequest, currentRequest]);
    expect(signals.get('/session/current')?.aborted).toBe(true);
  });

  it('rejects requests received after disposal without contacting the server', async () => {
    const { proxy, callbacks } = createProxy();

    proxy.dispose();
    proxy.dispose();
    await proxy.handleRequest({
      id: 43,
      cancelKey: 'disposed-request',
      method: 'GET',
      path: '/session',
    });

    expect(callbacks.server.request).not.toHaveBeenCalled();
    expect(callbacks.ensureServerStarted).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 43,
      error: 'REST proxy disposed',
    });
  });

  it('keeps the request-scoped workspace directory through asynchronous preparation', async () => {
    const cleanup = deferred<void>();
    const serverRequest = vi.fn(() => Promise.resolve([]));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      cleanupExpiredRecycleBin: vi.fn(() => cleanup.promise),
    });

    const request = proxy.handleRequest(makePayload(44, 'GET', '/config/providers'), '/repo-a');
    await vi.waitFor(() => expect(callbacks.cleanupExpiredRecycleBin).toHaveBeenCalled());
    cleanup.resolve();
    await request;

    expect(serverRequest).toHaveBeenCalledWith(
      'GET',
      '/config/providers',
      undefined,
      withSignal({ directory: '/repo-a' })
    );
  });

  it('returns error for disallowed API request', async () => {
    const { proxy, callbacks } = createProxy();
    await proxy.handleRequest(makePayload(1, 'DELETE', '/global/health'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 1,
      error: 'Unsupported API request',
    });
  });

  it('returns an error for malformed prompt session encoding', async () => {
    const { proxy, callbacks } = createProxy();

    await proxy.handleRequest(makePayload(2, 'POST', '/session/%/prompt_async'));

    expect(callbacks.server.request).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 2,
      error: 'URI malformed',
    });
  });

  it('returns an error for malformed queued-history session encoding', async () => {
    const { proxy, callbacks } = createProxy();

    await proxy.handleRequest({
      ...makePayload(3, 'GET', '/session/%/message', { messageID: 'message-3' }),
      queuedMessageDispatch: { itemId: 'queue-3', lease: 1 },
    });

    expect(callbacks.server.request).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 3,
      error: 'URI malformed',
    });
  });

  it('forwards session unshare requests to OpenCode', async () => {
    const response = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Session one',
      version: '1',
      time: { created: 1, updated: 2 },
    };
    const serverRequest = vi.fn(() => Promise.resolve(response));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest },
    });

    await proxy.handleRequest(
      makePayload(7, 'DELETE', '/session/session-1/share?directory=%2Frepo')
    );

    expect(serverRequest).toHaveBeenCalledWith(
      'DELETE',
      '/session/session-1/share?directory=%2Frepo',
      undefined,
      withSignal({ directory: '/repo' })
    );
    expect(callbacks.sessionTrash.moveToTrash).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 7, data: response });
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
      if (method === 'GET' && path === '/session/foreign?directory=%2Frepo') {
        return { id: 'foreign', directory: '/other' };
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
      if (
        method === 'GET' &&
        path === '/session/session%20one?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro'
      ) {
        return { id: 'session one', directory: 'c:/users/andrew/projects/VARRO/' };
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
      ['GET', '/session/session%20one?directory=C%3A%5CUsers%5CAndrew%5CProjects%5CVarro'],
      ['GET', '/session/session%20one/message', undefined, withSignal()],
    ]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 93, data: [] });
  });

  it('uses the endpoint workspace when validating an explicitly scoped session request', async () => {
    const serverRequest = vi.fn(() => Promise.resolve([]));
    const { proxy, callbacks } = createProxy({
      getWorkspacePath: () => '/repo-b',
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: '/repo-a',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      makePayload(931, 'POST', '/session/session-b/prompt_async?directory=%2Frepo-b', {
        parts: [],
      })
    );

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 931, data: [] });
    expect(serverRequest).toHaveBeenCalledWith(
      'POST',
      '/session/session-b/prompt_async?directory=%2Frepo-b',
      {
        parts: [],
        system: expect.stringContaining('folder selected for this session'),
      },
      withSignal({ directory: '/repo-b' })
    );
  });

  it('allows a leased queued prompt to target another open workspace', async () => {
    const serverRequest = vi.fn(() => Promise.resolve({ ok: true }));
    const { proxy, callbacks } = createProxy({
      getWorkspacePath: () => '/repo-b',
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: '/repo-b',
          workspaceFolders: [
            { name: 'repo-a', path: '/repo-a' },
            { name: 'repo-b', path: '/repo-b' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        getOpenWorkspaceRoot: vi.fn((path: string) =>
          path === '/repo-a' || path === '/repo-b' ? path : null
        ),
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      {
        ...makePayload(932, 'POST', '/session/session-a/prompt_async?directory=%2Frepo-a', {
          messageID: 'message-932',
          parts: [],
        }),
        queuedMessageDispatch: { itemId: 'queue-1', lease: 4 },
      },
      '/repo-b'
    );

    expect(serverRequest).toHaveBeenCalledWith(
      'POST',
      '/session/session-a/prompt_async?directory=%2Frepo-a',
      {
        messageID: 'message-932',
        parts: [],
        system: expect.stringContaining('folder selected for this session'),
      },
      withSignal({ directory: '/repo-a' })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 932,
      data: { ok: true },
    });
  });

  it('cancels a sibling-root request when that workspace folder closes', async () => {
    const promptStarted = deferred<void>();
    const serverRequest = vi.fn(
      (_method: string, path: string, _body: unknown, options?: { signal?: AbortSignal }) => {
        if (path !== '/session/session-b/prompt_async?directory=%2Frepo-b') {
          throw new Error(`Unexpected path: ${path}`);
        }
        promptStarted.resolve();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      }
    );
    const { proxy, callbacks } = createProxy({
      getWorkspacePath: () => '/repo-a',
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: '/repo-a',
          workspaceFolders: [
            { name: 'repo-a', path: '/repo-a' },
            { name: 'repo-b', path: '/repo-b' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        getOpenWorkspaceRoot: vi.fn((path: string) =>
          path === '/repo-a' || path === '/repo-b' ? path : null
        ),
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    const request = proxy.handleRequest(
      makePayload(933, 'POST', '/session/session-b/prompt_async?directory=%2Frepo-b', {
        parts: [],
      })
    );
    await promptStarted.promise;
    proxy.cancelRequestsOutsideDirectories(['/repo-a']);
    await request;

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 933,
      error: 'Workspace folder was removed',
    });
  });

  it('rejects sibling-root overrides for non-session snapshots before forwarding', async () => {
    const serverRequest = vi.fn();
    const { proxy, callbacks } = createProxy({
      getWorkspacePath: () => '/repo-a',
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: '/repo-a',
          workspaceFolders: [
            { name: 'repo-a', path: '/repo-a' },
            { name: 'repo-b', path: '/repo-b' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        getOpenWorkspaceRoot: vi.fn((path: string) =>
          path === '/repo-a' || path === '/repo-b' ? path : null
        ),
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      makePayload(934, 'GET', '/varro/workspace-file?path=README.md&directory=%2Frepo-b')
    );

    expect(serverRequest).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 934,
      error: 'Unsupported API request',
    });
  });

  it('rejects an explicit directory outside open roots before server startup', async () => {
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        getOpenWorkspaceRoot: vi.fn(() => null),
      } as never,
      getStatus: vi.fn(() => ({ state: 'stopped' as const })),
    });

    await proxy.handleRequest(makePayload(94, 'POST', '/session?directory=%2Foutside', {}));

    expect(callbacks.ensureServerStarted).not.toHaveBeenCalled();
    expect(callbacks.server.request).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 94,
      error: 'Workspace directory is not an open workspace folder',
    });
  });

  it('forwards the canonical matched root instead of explicit renderer spelling', async () => {
    const serverRequest = vi.fn(() => Promise.resolve({ id: 'created' }));
    const { proxy, callbacks } = createProxy({
      contextProvider: {
        ...createCallbacks().contextProvider,
        getOpenWorkspaceRoot: vi.fn(() => 'C:\\Projects\\Varro'),
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      makePayload(941, 'POST', '/session?directory=c%3A%2Fprojects%2FVARRO%2F', {})
    );

    expect(serverRequest).toHaveBeenCalledWith(
      'POST',
      '/session?directory=C%3A%5CProjects%5CVarro',
      {},
      withSignal({ directory: 'C:\\Projects\\Varro' })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 941,
      data: { id: 'created' },
    });
  });

  it('accepts a direct session when its explicit directory matches the selected root', async () => {
    const serverRequest = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-a?directory=%2Frepo') {
        return { id: 'session-a', directory: '/repo' };
      }
      if (method === 'POST' && path === '/session/session-a/prompt_async?directory=%2Frepo') {
        return { ok: true };
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

    await proxy.handleRequest(
      makePayload(95, 'POST', '/session/session-a/prompt_async?directory=%2Frepo', { parts: [] })
    );

    expect(serverRequest.mock.calls).toEqual([
      ['GET', '/session/session-a?directory=%2Frepo', undefined, { directory: '/repo' }],
      [
        'POST',
        '/session/session-a/prompt_async?directory=%2Frepo',
        {
          parts: [],
          system: expect.stringContaining('folder selected for this session'),
        },
        withSignal({ directory: '/repo' }),
      ],
    ]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 95,
      data: { ok: true },
    });
  });

  it.each(['prompt_async', 'share'])(
    'rejects a direct %s request when the session does not belong to its explicit open root',
    async (route) => {
      const serverRequest = vi.fn(() => Promise.resolve({ id: 'session-a', directory: '/repo-a' }));
      const { proxy, callbacks } = createProxy({
        server: { ...createCallbacks().server, request: serverRequest } as never,
        sessionState: {
          ...createCallbacks().sessionState,
          isSessionInWorkspace: vi.fn(() => false),
        } as never,
      });

      await proxy.handleRequest(
        makePayload(96, 'POST', `/session/session-a/${route}?directory=%2Frepo-b`)
      );

      expect(serverRequest).toHaveBeenCalledWith(
        'GET',
        '/session/session-a?directory=%2Frepo-b',
        undefined,
        { directory: '/repo-b' }
      );
      expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
        id: 96,
        error: '404 Session not found',
      });
    }
  );

  it('activates a session in another open root before changing endpoint scope', async () => {
    const activateSession = vi.fn(() => Promise.resolve({ id: 'session-b', directory: '/repo-b' }));
    const { proxy, callbacks } = createProxy({ activateSession });

    await proxy.handleRequest(
      makePayload(97, 'POST', '/varro/session/session-b/activate', {
        directory: '/repo-b',
      })
    );

    expect(activateSession).toHaveBeenCalledWith('session-b', '/repo-b', expect.any(AbortSignal));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 97,
      data: { id: 'session-b', directory: '/repo-b' },
    });
  });

  it('remembers workspace scope from an activated session', async () => {
    const metadata = { varro: { workspaceScope: 'workspace', schemaVersion: 1 } };
    const activateSession = vi.fn(() =>
      Promise.resolve({ id: 'session-workspace', directory: '/workspace', metadata })
    );
    const callbacks = createCallbacks({ activateSession });
    callbacks.contextProvider.context.workspaceDirectory = '/workspace';
    callbacks.contextProvider.getOpenWorkspaceRoot = vi.fn(() => null);
    const { proxy } = createProxy(callbacks);

    await proxy.handleRequest(
      makePayload(98, 'POST', '/varro/session/session-workspace/activate', {
        directory: '/workspace',
      })
    );

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 98,
      data: {
        id: 'session-workspace',
        directory: '/workspace',
        metadata,
        workspaceScope: 'workspace',
      },
    });
  });

  it('routes recycle bin list request', async () => {
    const trashList = [recycleBinEntry('abc', '/repo')];
    const { proxy, callbacks } = createProxy({
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        list: vi.fn(() => trashList),
      } as never,
    });
    await proxy.handleRequest(makePayload(2, 'GET', '/varro/session-trash'));
    expect(callbacks.sessionTrash.list).toHaveBeenCalledWith();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 2, data: trashList });
  });

  it('routes recycle bin empty request', async () => {
    const empty = vi.fn(
      async (
        deleteSession: (session: { id: string; directory?: string }) => Promise<unknown>,
        directory: string
      ) => {
        const id = directory === '/repo/a' ? 's1' : 's2';
        await deleteSession({ id, directory });
        return [{ sessions: [{ id }] } as never];
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
        list: vi.fn(() => [recycleBinEntry('s1', '/repo/a'), recycleBinEntry('s2', '/repo/b')]),
      } as never,
    });
    await proxy.handleRequest(makePayload(3, 'DELETE', '/varro/session-trash'));
    expect(callbacks.sessionTrash.empty).toHaveBeenCalledWith(expect.any(Function), '/repo/a');
    expect(callbacks.sessionTrash.empty).toHaveBeenCalledWith(expect.any(Function), '/repo/b');
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
        list: vi.fn(() => [recycleBinEntry('abc', '/repo')]),
      } as never,
    });
    await proxy.handleRequest(makePayload(4, 'POST', '/varro/session-trash/abc/restore'));
    expect(callbacks.sessionTrash.restore).toHaveBeenCalledWith('abc', '/repo');
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
        list: vi.fn(() => [recycleBinEntry('abc', '/repo', ['s1', 's2'])]),
      } as never,
    });
    await proxy.handleRequest(makePayload(5, 'DELETE', '/varro/session-trash/abc/delete'));
    expect(callbacks.sessionTrash.deletePermanently).toHaveBeenCalledWith(
      'abc',
      expect.any(Function),
      '/repo'
    );
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
      return Promise.reject(new Error('404 Session not found'));
    });
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        deletePermanently,
        list: vi.fn(() => [recycleBinEntry('legacy-1', '/repo')]),
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
        list: vi.fn(() => [recycleBinEntry('busy-1', '/repo')]),
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
    expect(callbacks.contextProvider.readFile).toHaveBeenCalledWith('src/foo.ts', {
      restrictToWorkspace: true,
      workspaceDirectory: '/repo',
    });
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

    expect(callbacks.contextProvider.resolvePath).toHaveBeenCalledWith('src/foo.ts', {
      allowSiblingWorkspaceFolders: true,
      restrictToWorkspace: true,
      workspaceDirectory: '/repo',
    });
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 61, data: resolved });
  });

  it('returns the selected plan path with its multi-root workspace directory', async () => {
    const selected = { fsPath: '/repo-b/docs/RALPH.md' };
    const workspaceFolder = { name: 'repo-b', uri: { fsPath: '/repo-b' } };
    mocks.vscode.window.showOpenDialog.mockResolvedValueOnce([selected] as never);
    mocks.vscode.workspace.getWorkspaceFolder.mockReturnValueOnce(workspaceFolder as never);
    mocks.vscode.workspace.asRelativePath.mockReturnValueOnce('docs/RALPH.md');
    const { proxy, callbacks } = createProxy();

    await proxy.handleRequest(makePayload(62, 'GET', '/varro/workspace-file/pick'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 62,
      data: { path: 'docs/RALPH.md', workspaceDirectory: '/repo-b' },
    });
  });

  it('rejects a selected plan outside all open workspace roots', async () => {
    const selected = { fsPath: '/outside/RALPH.md' };
    mocks.vscode.window.showOpenDialog.mockResolvedValueOnce([selected] as never);
    mocks.vscode.workspace.getWorkspaceFolder.mockReturnValueOnce(undefined);
    const { proxy, callbacks } = createProxy();

    await proxy.handleRequest(makePayload(63, 'GET', '/varro/workspace-file/pick'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 63,
      error: 'Selected file is outside the open workspace folders',
    });
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
    const serverRequest = vi.fn((method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-1?directory=%2Frepo') {
        return Promise.resolve({ id: 'session-1', directory: '/repo' });
      }
      return Promise.resolve(undefined);
    });
    const { proxy, callbacks } = createProxy({
      getStatus: vi.fn(() => ({ state: 'stopped' as const })),
      server: { ...createCallbacks().server, request: serverRequest } as never,
      autoApproveJudge: {
        judge: vi.fn(() => Promise.resolve(judgeResult)),
        resolveModel: vi.fn(() => Promise.resolve(null)),
      },
    });

    await proxy.handleRequest(
      makePayload(81, 'POST', '/varro/permission/judge', {
        permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
        approvedReferences: [{ type: 'bash', title: 'bash npm publish', response: 'reject' }],
      })
    );

    expect(callbacks.ensureServerStarted).toHaveBeenCalledOnce();
    expect(callbacks.autoApproveJudge.judge).toHaveBeenCalledWith(
      {
        permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
        approvedReferences: [{ type: 'bash', title: 'bash npm publish', response: 'reject' }],
      },
      '/repo'
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 81, data: judgeResult });
  });

  it('rejects automatic requests after their ownership lease changes', async () => {
    const { proxy, callbacks } = createProxy({
      isPermissionAutomationLeaseCurrent: vi.fn(() => false),
    });

    await proxy.handleRequest({
      ...makePayload(84, 'POST', '/varro/permission/judge', {
        permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
      }),
      permissionAutomationLease: 7,
    });

    expect(callbacks.autoApproveJudge.judge).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 84,
      error: 'Permission automation ownership changed',
    });
  });

  it('revalidates the automation lease after judge workspace resolution', async () => {
    const sessionLookup = deferred<unknown>();
    let leaseCurrent = true;
    const serverRequest = vi.fn((method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-1?directory=%2Frepo') {
        return sessionLookup.promise;
      }
      return Promise.resolve(undefined);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      isPermissionAutomationLeaseCurrent: vi.fn(() => leaseCurrent),
    });

    const request = proxy.handleRequest({
      ...makePayload(86, 'POST', '/varro/permission/judge', {
        permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
      }),
      permissionAutomationLease: 7,
    });
    await vi.waitFor(() =>
      expect(serverRequest).toHaveBeenCalledWith('GET', '/session/session-1?directory=%2Frepo')
    );
    leaseCurrent = false;
    sessionLookup.resolve({ id: 'session-1', directory: '/repo' });
    await request;

    expect(callbacks.autoApproveJudge.judge).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 86,
      error: 'Permission automation ownership changed',
    });
  });

  it('revalidates the automation lease after reply preparation', async () => {
    const cleanup = deferred<void>();
    let leaseCurrent = true;
    const serverRequest = vi.fn(() => Promise.resolve(true));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      cleanupExpiredRecycleBin: vi.fn(() => cleanup.promise),
      isPermissionAutomationLeaseCurrent: vi.fn(() => leaseCurrent),
    });

    const request = proxy.handleRequest({
      ...makePayload(87, 'POST', '/permission/perm-1/reply', { reply: 'once' }),
      permissionAutomationLease: 7,
    });
    await vi.waitFor(() => expect(callbacks.cleanupExpiredRecycleBin).toHaveBeenCalledOnce());
    leaseCurrent = false;
    cleanup.resolve();
    await request;

    expect(serverRequest).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 87,
      error: 'Permission automation ownership changed',
    });
  });

  it('does not apply permission leases to unrelated API requests', async () => {
    const serverRequest = vi.fn((_method: string, path: string) =>
      Promise.resolve(
        path === '/session/status'
          ? { 'session-1': { type: 'idle' } }
          : [{ id: 'session-1', directory: '/repo' }]
      )
    );
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      isPermissionAutomationLeaseCurrent: vi.fn(() => false),
    });

    await proxy.handleRequest({
      ...makePayload(88, 'GET', '/session/status'),
      permissionAutomationLease: 7,
    });

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session/status', undefined, {
      directory: '/repo',
    });
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 88,
      data: { 'session-1': { type: 'idle' } },
    });
  });

  it('routes permission mode updates through the host callback', async () => {
    const session = {
      id: 'session-1',
      permission: [{ permission: '*', pattern: '*', action: 'ask' }],
    };
    const { proxy, callbacks } = createProxy({
      updatePermissionMode: vi.fn(() => Promise.resolve(session)),
    });

    await proxy.handleRequest(
      makePayload(85, 'POST', '/varro/session/session-1/permission-mode', { mode: 'edits' })
    );

    expect(callbacks.updatePermissionMode).toHaveBeenCalledWith('session-1', 'edits', '/repo');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 85, data: session });
  });

  it('does not judge a permission whose owning session belongs to another workspace', async () => {
    const serverRequest = vi.fn((method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-foreign?directory=%2Frepo') {
        return Promise.resolve({ id: 'session-foreign', directory: '/other' });
      }
      return Promise.resolve(undefined);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      makePayload(83, 'POST', '/varro/permission/judge', {
        permission: { id: 'perm-foreign', type: 'edit', sessionID: 'session-foreign' },
      })
    );

    expect(callbacks.autoApproveJudge.judge).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 83,
      error: '404 Session not found',
    });
  });

  it('resolves the auto-approve judge model', async () => {
    const model = { providerID: 'openai', modelID: 'gpt-5.6', variant: 'low' };
    const { proxy, callbacks } = createProxy({
      autoApproveJudge: {
        judge: vi.fn(() => Promise.resolve({ decision: 'ask' as const })),
        resolveModel: vi.fn(() => Promise.resolve(model)),
      },
    });

    await proxy.handleRequest(
      makePayload(
        82,
        'GET',
        '/varro/permission/judge/model?providerID=openai&modelID=gpt-4.1&variant=low'
      )
    );

    expect(callbacks.autoApproveJudge.resolveModel).toHaveBeenCalledWith(
      {
        providerID: 'openai',
        modelID: 'gpt-4.1',
        variant: 'low',
      },
      '/repo'
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 82, data: model });
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

    expect(callbacks.sessionTitleFallback.renameIfUntitled).toHaveBeenCalledWith(
      'session-1',
      '/repo'
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 1,
      data: { id: 'session-1', title: 'Fix build' },
    });
  });

  it('returns only aggregate session edit and token data to the webview', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=1000000') {
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
                info: {
                  role: 'assistant',
                  providerID: 'openai',
                  modelID: 'gpt-5.6-sol',
                  variant: 'high',
                  time: { created: 14_000 },
                  tokens: {},
                },
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
      ['GET', '/session/session-1/diff', undefined, { directory: '/repo' }],
      [
        'GET',
        '/session/session-1/message',
        undefined,
        {
          maxResponseBytes: 256 * 1024 * 1024,
          maxProjectedResponseBytes: 16 * 1024 * 1024,
          stripSummaryDiffs: true,
          directory: '/repo',
        },
      ],
      ['GET', '/session?limit=1000000', undefined, { directory: '/repo' }],
      ['GET', '/session/child-1/message', undefined, { directory: '/repo' }],
      ['GET', '/session/grandchild-1/message', undefined, { directory: '/repo' }],
    ]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 82,
      data: {
        files: 2,
        additions: 6,
        deletions: 4,
        tokens: 4_025,
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
        tokenBreakdown: {
          session: {
            total: 3_475,
            input: 2_900,
            output: 500,
            reasoning: 150,
            cacheRead: 150,
            cacheWrite: 50,
          },
          subagents: {
            total: 700,
            input: 400,
            output: 100,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          subagentCount: 2,
        },
        nestedContextBreakdown: [
          { key: 'assistant', tokens: 10, percent: 0.3 },
          { key: 'other', tokens: 3_990, percent: 99.8 },
        ],
        durationMs: 10_000,
        activeStartedAt: 13_000,
      },
    });
    const response = (callbacks.postApiResponse as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(response)).not.toContain('FULL_');
    expect(JSON.stringify(response)).not.toContain('OTHER_');
  });

  it('excludes generated dependency files from the session diff summary', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=1000000') {
        return Promise.resolve([{ id: 'session-1', directory: '/repo' }]);
      }
      if (path === '/session/session-1/diff') {
        return Promise.resolve([
          { file: 'node_modules/dep/index.js', additions: 40, deletions: 10 },
          { file: 'src/a.ts', additions: 4, deletions: 1 },
        ]);
      }
      return Promise.resolve([]);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(88, 'GET', '/varro/session/session-1/diff-summary'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 88,
      data: expect.objectContaining({ files: 1, additions: 4, deletions: 1 }),
    });
  });

  it('includes a descendant beyond OpenCode default session-list page in token totals', async () => {
    const fullSessionList = [
      { id: 'session-1', directory: '/repo' },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `unrelated-${index}`,
        directory: '/repo',
      })),
      {
        id: 'late-descendant',
        parentID: 'session-1',
        directory: '/repo',
        tokens: { total: 9 },
      },
    ];
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/session') return fullSessionList.slice(0, 100);
      if (path === '/session?limit=1000000') return fullSessionList;
      if (path === '/session/session-1/message') {
        return [{ info: { role: 'assistant', tokens: { total: 1 } } }];
      }
      return [];
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(821, 'GET', '/varro/session/session-1/diff-summary'));

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session?limit=1000000', undefined, {
      directory: '/repo',
    });
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 821,
      data: expect.objectContaining({
        tokens: 10,
        tokenBreakdown: expect.objectContaining({
          subagents: expect.objectContaining({ total: 9 }),
          subagentCount: 1,
        }),
      }),
    });
  });

  it('falls back to message tool metadata when the session diff is empty', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=1000000') return Promise.resolve([]);
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
        tokenBreakdown: {
          session: {
            total: 500,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          subagents: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          subagentCount: 0,
        },
        durationMs: 3_000,
        activeStartedAt: null,
      },
    });
  });

  it('marks file totals unknown without rereading oversized message histories', async () => {
    let messageAttempts = 0;
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=1000000' || path.endsWith('/diff')) {
        return Promise.resolve([]);
      }
      if (path === '/session/session-1/message') {
        messageAttempts += 1;
        return Promise.reject(new OpenCodeResponseTooLargeError(16 * 1024 * 1024));
      }
      return Promise.resolve([]);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(831, 'GET', '/varro/session/session-1/diff-summary'));

    expect(messageAttempts).toBe(1);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 831,
      data: expect.objectContaining({
        files: 0,
        filesTruncated: true,
        historyStatsUnavailable: true,
        additions: 0,
        deletions: 0,
      }),
    });
  });

  it('recovers explicit file edits from an oversized message history', async () => {
    let messageAttempts = 0;
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=1000000') {
        return Promise.resolve([{ id: 'session-1' }]);
      }
      if (path.endsWith('/diff')) return Promise.resolve([]);
      if (path === '/session/session-1/message') {
        messageAttempts += 1;
        return Promise.resolve([
          {
            info: {
              role: 'user',
              time: { created: 1 },
              summary: { diffs: [], diffsOmitted: true, diffsTruncated: true },
            },
            parts: [
              {
                type: 'tool',
                tool: 'apply_patch',
                state: {
                  metadata: {
                    files: [
                      { relativePath: 'src/a.ts', additions: 4, deletions: 1 },
                      { relativePath: 'src/b.ts', additions: 2, deletions: 0 },
                      {
                        relativePath: 'node_modules/pkg/index.js',
                        additions: 100,
                        deletions: 0,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(832, 'GET', '/varro/session/session-1/diff-summary'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 832,
      data: expect.objectContaining({
        files: 2,
        additions: 6,
        deletions: 1,
      }),
    });
    const response = (callbacks.postApiResponse as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      data: Record<string, unknown>;
    };
    expect(response.data.filesTruncated).toBeUndefined();
    expect(messageAttempts).toBe(1);
  });

  it('shares the session list across concurrent diff summaries', async () => {
    const sessionList = deferred<unknown>();
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=1000000') return sessionList.promise;
      return Promise.resolve([]);
    });
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    const requests = [
      proxy.handleRequest(makePayload(84, 'GET', '/varro/session/session-1/diff-summary')),
      proxy.handleRequest(makePayload(85, 'GET', '/varro/session/session-2/diff-summary')),
    ];
    await vi.waitFor(() => {
      expect(
        serverRequest.mock.calls.filter(([, path]) => path === '/session?limit=1000000')
      ).toHaveLength(1);
    });
    sessionList.resolve([{ id: 'session-1' }, { id: 'session-2' }]);

    await Promise.all(requests);

    expect(
      serverRequest.mock.calls.filter(([, path]) => path === '/session?limit=1000000')
    ).toHaveLength(1);
  });

  it('reuses a completed diff summary for the same session revision', async () => {
    const serverRequest = vi.fn<RestProxyCallbacks['server']['request']>(async () => []);
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    const path = '/varro/session/session-1/diff-summary?revision=123';

    await proxy.handleRequest(makePayload(84, 'GET', path));
    await proxy.handleRequest(makePayload(85, 'GET', path));

    expect(
      serverRequest.mock.calls.filter(([, requestPath]) => requestPath === '/session?limit=1000000')
    ).toHaveLength(1);
    expect(
      serverRequest.mock.calls.filter(
        ([, requestPath]) => requestPath === '/session/session-1/diff'
      )
    ).toHaveLength(1);
    expect(
      serverRequest.mock.calls.filter(
        ([, requestPath]) => requestPath === '/session/session-1/message'
      )
    ).toHaveLength(1);
  });

  it('refreshes an unversioned diff summary after the previous request settles', async () => {
    const serverRequest = vi.fn<RestProxyCallbacks['server']['request']>(async () => []);
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    const path = '/varro/session/session-1/diff-summary';

    await proxy.handleRequest(makePayload(84, 'GET', path));
    await proxy.handleRequest(makePayload(85, 'GET', path));

    expect(
      serverRequest.mock.calls.filter(
        ([, requestPath]) => requestPath === '/session/session-1/diff'
      )
    ).toHaveLength(2);
    expect(
      serverRequest.mock.calls.filter(
        ([, requestPath]) => requestPath === '/session/session-1/message'
      )
    ).toHaveLength(2);
  });

  it('globally bounds descendant history requests across concurrent diff summaries', async () => {
    const gate = deferred<void>();
    let activeDescendantRequests = 0;
    let peakDescendantRequests = 0;
    const descendants = ['session-1', 'session-2'].flatMap((parentID) =>
      Array.from({ length: 9 }, (_, index) => ({
        id: `${parentID}-child-${index}`,
        parentID,
      }))
    );
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/session?limit=1000000') {
        return [{ id: 'session-1' }, { id: 'session-2' }, ...descendants];
      }
      if (/^\/session\/session-\d-child-\d+\/message$/.test(path)) {
        activeDescendantRequests += 1;
        peakDescendantRequests = Math.max(peakDescendantRequests, activeDescendantRequests);
        try {
          await gate.promise;
          return [];
        } finally {
          activeDescendantRequests -= 1;
        }
      }
      return [];
    });
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    const requests = [
      proxy.handleRequest(makePayload(86, 'GET', '/varro/session/session-1/diff-summary')),
      proxy.handleRequest(makePayload(87, 'GET', '/varro/session/session-2/diff-summary')),
    ];
    await vi.waitFor(() => expect(activeDescendantRequests).toBe(4));
    expect(
      serverRequest.mock.calls.filter(([, path]) => /\/session-\d-child-\d+\/message$/.test(path))
    ).toHaveLength(4);
    gate.resolve();
    await Promise.all(requests);

    expect(peakDescendantRequests).toBe(4);
    expect(
      serverRequest.mock.calls.filter(([, path]) => /\/session-\d-child-\d+\/message$/.test(path))
    ).toHaveLength(18);
  });

  it('simulates no providers when flag is set', async () => {
    const { proxy, callbacks } = createProxy({ simulateNoProviders: true });
    await proxy.handleRequest(makePayload(9, 'GET', '/config/providers'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 9,
      data: { providers: [], default: {} },
    });
  });

  it('uses the effective OpenCode config when the default model endpoint is unsupported', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/model/default') return Promise.resolve('<!doctype html>');
      if (path === '/config?directory=%2Frepo') {
        return Promise.resolve({
          model: 'openai/gpt-5.6-sol',
          provider: { secret: { options: { apiKey: 'not-for-webview' } } },
        });
      }
      return Promise.resolve(undefined);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(901, 'GET', '/model/default'));

    expect(serverRequest).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/model/default',
      undefined,
      withSignal()
    );
    expect(serverRequest).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/config?directory=%2Frepo',
      undefined,
      withSignal()
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 901,
      data: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
    });
  });

  it('keeps a supported exact default model response without loading config', async () => {
    const serverRequest = vi.fn(() =>
      Promise.resolve({ providerID: 'anthropic', id: 'claude-current' })
    );
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(902, 'GET', '/model/default'));

    expect(serverRequest).toHaveBeenCalledTimes(1);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 902,
      data: { providerID: 'anthropic', modelID: 'claude-current' },
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
    expect(serverRequest).toHaveBeenCalledWith('GET', '/session?limit=1000000', undefined, {
      directory: '/repo',
    });
    expect(callbacks.sessionTrash.moveToTrash).toHaveBeenCalledWith('some-id', []);
    expect(callbacks.removeSessionImages).toHaveBeenCalledWith(['s1']);
    expect(callbacks.sessionState.removeSessions).toHaveBeenCalledWith(['s1']);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 11, data: true });
  });

  it('routes varro permanent delete directly to the server without recycle bin', async () => {
    const serverRequest = vi
      .fn()
      .mockResolvedValueOnce({ id: 'some-id', directory: '/repo' })
      .mockResolvedValueOnce(true);
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
    });

    await proxy.handleRequest(makePayload(111, 'DELETE', '/varro/session/some-id/delete'));

    expect(serverRequest.mock.calls).toEqual([
      ['GET', '/session/some-id'],
      ['DELETE', '/session/some-id?directory=%2Frepo'],
    ]);
    expect(callbacks.sessionTrash.moveToTrash).not.toHaveBeenCalled();
    expect(callbacks.removeSessionImages).toHaveBeenCalledWith(['some-id']);
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

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session?limit=1000000', undefined, {
      directory: 'C:\\Users\\Andrew\\Projects\\Varro',
    });
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
    expect(callbacks.removeSessionImages).not.toHaveBeenCalled();
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

  it('loads the full session catalog for an unpaginated workspace request', async () => {
    const serverData = [{ id: 's1', directory: '/repo' }];
    const serverRequest = vi.fn(() => Promise.resolve(serverData));
    const { proxy, callbacks } = createProxy({
      server: {
        ...createCallbacks().server,
        request: serverRequest,
      } as never,
    });
    await proxy.handleRequest(makePayload(15, 'GET', '/session'));
    expect(serverRequest).toHaveBeenCalledWith(
      'GET',
      '/session?limit=1000000',
      undefined,
      withSignal({ directory: '/repo' })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 15,
      data: serverData,
    });
  });

  it('overfetches paginated session lists to report whether more sessions exist', async () => {
    const sessions = [
      { id: 'newest', directory: '/repo' },
      { id: 'older', directory: '/repo' },
      { id: 'oldest', directory: '/repo' },
    ];
    const serverRequest = vi.fn(() => Promise.resolve(sessions));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(151, 'GET', '/session?limit=2'));

    expect(serverRequest).toHaveBeenCalledWith(
      'GET',
      '/session?limit=3',
      undefined,
      withSignal({ directory: '/repo' })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 151,
      data: {
        items: sessions.slice(0, 2),
        hasMore: true,
      },
    });
  });

  it('bounds diff details in paginated session summaries', async () => {
    const diffs = Array.from({ length: 101 }, (_, index) => ({
      file: `vendor/package-${index}/index.js`,
      additions: 1,
      deletions: 2,
      before: 'large before content',
      after: 'large after content',
      patch: 'large patch content',
    }));
    const serverRequest = vi.fn(() =>
      Promise.resolve([
        {
          id: 'large-session',
          directory: '/repo',
          summary: { files: 101, additions: 101, deletions: 202, diffs },
        },
      ])
    );
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(1512, 'GET', '/session?limit=1'));

    const response = (callbacks.postApiResponse as Mock<RestProxyCallbacks['postApiResponse']>).mock
      .calls[0]![1] as { data: { items: Array<Record<string, unknown>> } };
    const session = response.data.items[0] as {
      summary: {
        diffs: Array<Record<string, unknown>>;
        diffsOmitted: boolean;
        diffsTruncated: boolean;
        diffCount: number;
      };
    };
    expect(session.summary.diffs).toEqual([]);
    expect(session.summary.diffsOmitted).toBe(true);
    expect(session.summary.diffsTruncated).toBe(true);
    expect(session.summary.diffCount).toBe(101);
  });

  it('forwards native session search while preserving its constraints', async () => {
    const sessions = [{ id: 'match', directory: '/repo', title: 'Dark mode' }];
    const serverRequest = vi.fn(() => Promise.resolve(sessions));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      makePayload(1511, 'GET', '/session?limit=30&search=dark%20mode&roots=true')
    );

    expect(serverRequest).toHaveBeenCalledWith(
      'GET',
      '/session?limit=31&search=dark+mode&roots=true',
      undefined,
      withSignal({ directory: '/repo' })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 1511,
      data: { items: sessions, hasMore: false },
    });
  });

  it('does not treat an exhausted native search as an authoritative directory snapshot', async () => {
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=31&search=match&roots=true') {
        return Promise.resolve([{ id: 'match', directory: '/repo' }]);
      }
      if (path === '/session/status') {
        return Promise.resolve({ foreign: { type: 'busy' } });
      }
      if (path === '/session?limit=1000000') {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        getSessionWorkspaceMatch: vi.fn(() => undefined),
      } as never,
    });

    await proxy.handleRequest(
      makePayload(1512, 'GET', '/session?limit=30&search=match&roots=true')
    );
    await proxy.handleRequest(makePayload(1513, 'GET', '/session/status'));

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session?limit=1000000', undefined, {
      directory: '/repo',
    });
    expect(callbacks.postApiResponse).toHaveBeenLastCalledWith(1, {
      id: 1513,
      data: {},
    });
  });

  it('marks an exact paginated session response as exhausted', async () => {
    const sessions = [
      { id: 'newest', directory: '/repo' },
      { id: 'oldest', directory: '/repo' },
    ];
    const serverRequest = vi.fn(() => Promise.resolve(sessions));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(152, 'GET', '/session?limit=2'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 152,
      data: { items: sessions, hasMore: false },
    });
  });

  it('does not treat a partial session page as an authoritative directory snapshot', async () => {
    const partialPage = deferred<Array<{ id: string; directory: string }>>();
    const serverRequest = vi.fn((_method: string, path: string) => {
      if (path === '/session?limit=3') {
        return Promise.resolve([{ id: 'initial', directory: '/repo' }]);
      }
      if (path === '/session?limit=2') {
        return partialPage.promise;
      }
      if (path === '/session/status') {
        return Promise.resolve({ 'foreign-old': { type: 'busy' } });
      }
      if (path === '/session?limit=1000000') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        getSessionWorkspaceMatch: vi.fn(() => undefined),
      } as never,
    });

    await proxy.handleRequest(makePayload(152, 'GET', '/session?limit=2'));
    const partialRequest = proxy.handleRequest(makePayload(153, 'GET', '/session?limit=1'));
    await vi.waitFor(() => {
      expect(serverRequest).toHaveBeenCalledWith(
        'GET',
        '/session?limit=2',
        undefined,
        withSignal({ directory: '/repo' })
      );
    });
    await proxy.handleRequest(makePayload(154, 'GET', '/session/status'));

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session?limit=1000000', undefined, {
      directory: '/repo',
    });
    expect(callbacks.postApiResponse).toHaveBeenLastCalledWith(1, {
      id: 154,
      data: {},
    });
    partialPage.resolve([
      { id: 'recent', directory: '/repo' },
      { id: 'next', directory: '/repo' },
    ]);
    await partialRequest;
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
    expect(filterVisible).toHaveBeenCalledWith([sessions[1], sessions[0]]);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 16, data: filtered });
  });

  it('hides and deletes orphaned permission judges discovered in session lists', async () => {
    const sessions = [
      { id: 'visible', directory: '/repo', title: 'Visible session' },
      {
        id: 'legacy-judge',
        directory: '/repo',
        title: 'Varro permission judge: per_legacy',
        time: { updated: Date.now() - 180_000 },
      },
      {
        id: 'marked-judge',
        directory: '/repo',
        title: 'Internal helper',
        metadata: { varroInternal: 'permission-judge' },
        time: { updated: Date.now() - 180_000 },
      },
    ];
    const serverRequest = vi.fn((method: string) =>
      Promise.resolve(method === 'GET' ? sessions : true)
    );
    const hiddenSessions = new HiddenSessionManager();
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      hiddenSessions,
    });

    await proxy.handleRequest(makePayload(161, 'GET', '/session?limit=3'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 161,
      data: { items: [sessions[0]], hasMore: false },
    });
    await vi.waitFor(() => {
      expect(serverRequest).toHaveBeenCalledWith('DELETE', '/session/legacy-judge', undefined, {
        directory: '/repo',
      });
      expect(serverRequest).toHaveBeenCalledWith('DELETE', '/session/marked-judge', undefined, {
        directory: '/repo',
      });
    });
  });

  it('rejects a session list containing entries outside its requested root', async () => {
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

    expect(callbacks.sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 116,
      error: 'OpenCode returned a session outside workspace root /repo',
    });
  });

  it('filters UNC sessions using case-insensitive Windows identity', async () => {
    const sessions = [{ id: 'same', directory: '//buildserver/PROJECTS/varro/' }];
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
    const response = (callbacks.postApiResponse as Mock<RestProxyCallbacks['postApiResponse']>).mock
      .calls[0]![1] as SanitizedMessageResponse;
    expect(response.id).toBe(17);
    expect(response.data).toHaveLength(1);
    expect(response.data[0]!.info.id).toBe('m1');
    expect(response.data[0]!.parts).toHaveLength(1);
  });

  it('filters generated dependencies from direct session diffs', async () => {
    const sourceDiff = { file: 'src/index.ts', additions: 1, deletions: 0 };
    const serverRequest = vi.fn(() =>
      Promise.resolve([
        sourceDiff,
        { file: 'node_modules/pkg/index.js', additions: 100, deletions: 0 },
      ])
    );
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(171, 'GET', '/session/s1/diff'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 171,
      data: [sourceDiff],
    });
  });

  it('bounds diff details in message summaries', async () => {
    const message = makeSessionMessage('m1', 'p1');
    (message.info as Record<string, unknown>).summary = {
      diffs: Array.from({ length: 101 }, (_, index) => ({
        file: `vendor/package-${index}/index.js`,
        additions: 1,
        deletions: 2,
        before: 'large before content',
        after: 'large after content',
        patch: 'large patch content',
      })),
    };

    const items = await requestSanitizedMessagePage([message]);
    const summary = items[0]!.info.summary as {
      diffs: Array<Record<string, unknown>>;
      diffsOmitted: boolean;
      diffsTruncated: boolean;
      diffCount: number;
    };
    expect(summary.diffs).toEqual([]);
    expect(summary.diffsOmitted).toBe(true);
    expect(summary.diffsTruncated).toBe(true);
    expect(summary.diffCount).toBe(101);
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

    expect(serverRequest).toHaveBeenCalledWith(
      'GET',
      '/session/s1/message?limit=200',
      undefined,
      withSignal({
        captureNextCursor: true,
        maxResponseBytes: 256 * 1024 * 1024,
        maxProjectedResponseBytes: 16 * 1024 * 1024,
        stripSummaryDiffs: true,
      })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 117,
      data: { items: messages, nextCursor: 'cursor-2' },
    });
  });

  it('retries oversized message pages with a smaller history window', async () => {
    const messages = [makeSessionMessage('m1', 'p1')];
    const serverRequest = vi
      .fn()
      .mockRejectedValueOnce(new OpenCodeResponseTooLargeError(16 * 1024 * 1024))
      .mockResolvedValueOnce({ data: messages, nextCursor: 'cursor-2' });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(118, 'GET', '/session/s1/message?limit=200'));

    expect(serverRequest).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/session/s1/message?limit=20',
      undefined,
      withSignal({
        captureNextCursor: true,
        maxResponseBytes: 256 * 1024 * 1024,
        maxProjectedResponseBytes: 16 * 1024 * 1024,
        stripSummaryDiffs: true,
      })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 118,
      data: { items: messages, nextCursor: 'cursor-2' },
    });
  });

  it('fails when the smaller projected message window is still oversized', async () => {
    const serverRequest = vi
      .fn()
      .mockRejectedValueOnce(new OpenCodeResponseTooLargeError(16 * 1024 * 1024))
      .mockRejectedValueOnce(new OpenCodeResponseTooLargeError(16 * 1024 * 1024));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(
      makePayload(119, 'GET', '/session/s1/message?limit=200&before=cursor-3')
    );

    expect(serverRequest).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/session/s1/message?limit=20&before=cursor-3',
      undefined,
      withSignal({
        captureNextCursor: true,
        maxResponseBytes: 256 * 1024 * 1024,
        maxProjectedResponseBytes: 16 * 1024 * 1024,
        stripSummaryDiffs: true,
      })
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 119,
      error: 'OpenCode response exceeded the 16777216-byte safety limit',
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
    const response = (callbacks.postApiResponse as Mock<RestProxyCallbacks['postApiResponse']>).mock
      .calls[0]![1] as SanitizedMessageResponse;
    expect(response.data[0]!.parts).toHaveLength(1);
    expect(response.data[0]!.parts[0]!.id).toBe('p1');
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('filters messages belonging to a different session', async () => {
    const items = await requestSanitizedMessagePage([
      makeSessionMessage('foreign-message', 'foreign-part', 'other-session'),
    ]);

    expect(items).toEqual([]);
  });

  it('filters parts whose session or message identity does not match their owner', async () => {
    const message = makeSessionMessage('m1', 'valid-part');
    message.parts.push(
      { ...message.parts[0]!, id: 'foreign-session-part', sessionID: 'other-session' },
      { ...message.parts[0]!, id: 'foreign-message-part', messageID: 'other-message' }
    );

    const items = await requestSanitizedMessagePage([message]);

    expect(items[0]!.parts.map((part) => part.id)).toEqual(['valid-part']);
  });

  it('filters later messages with a duplicate message ID', async () => {
    const first = makeSessionMessage('duplicate-message', 'first-part');
    const duplicate = makeSessionMessage('duplicate-message', 'duplicate-part');

    const items = await requestSanitizedMessagePage([first, duplicate]);

    expect(items).toEqual([first]);
  });

  it('filters later parts with a duplicate part ID', async () => {
    const first = makeSessionMessage('m1', 'duplicate-part');
    const second = makeSessionMessage('m2', 'duplicate-part');

    const items = await requestSanitizedMessagePage([first, second]);

    expect(items.map((item) => item.parts.map((part) => part.id))).toEqual([
      ['duplicate-part'],
      [],
    ]);
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
    const sessions = [
      { id: 's1', directory: '/repo' },
      { id: 's2', directory: '/repo' },
    ];
    const serverRequest = vi.fn((_method: string, path: string) =>
      Promise.resolve(path === '/session/status' ? statuses : sessions)
    );
    const filterSessions = vi.fn(() => [sessions[0]]);
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionTrash: {
        ...createCallbacks().sessionTrash,
        filterVisibleSessions: filterSessions,
      } as never,
    });
    await proxy.handleRequest(makePayload(22, 'GET', '/session/status'));
    expect(filterSessions).toHaveBeenCalledWith(sessions);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 22, data: filtered });
  });

  it.each(['/question', '/permission'])(
    'filters %s snapshots to sessions in the endpoint directory',
    async (path) => {
      const local = { sessionID: 'local' };
      const foreign = { sessionID: 'foreign' };
      const serverRequest = vi.fn(() => Promise.resolve([local, foreign]));
      const { proxy, callbacks } = createProxy({
        server: { ...createCallbacks().server, request: serverRequest } as never,
        sessionState: {
          ...createCallbacks().sessionState,
          getSessionWorkspaceMatch: vi.fn((sessionID: string) => sessionID === 'local'),
          isSessionInWorkspace: vi.fn((sessionID: string) => sessionID === 'local'),
        } as never,
      });

      await proxy.handleRequest(makePayload(221, 'GET', path));

      expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
        id: 221,
        data: [local],
      });
    }
  );

  it('resolves a pending request missing from the session snapshot before admitting it', async () => {
    const permission = { id: 'permission-1', sessionID: 'early-child' };
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/permission') return [permission];
      if (path === '/session') return [];
      if (path === '/session/early-child?directory=%2Frepo') {
        return { id: 'early-child', directory: '/repo' };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        getSessionWorkspaceMatch: vi.fn(() => undefined),
      } as never,
    });

    await proxy.handleRequest(makePayload(222, 'GET', '/permission'));

    expect(serverRequest).toHaveBeenCalledWith('GET', '/session/early-child?directory=%2Frepo');
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 222,
      data: [permission],
    });
  });

  it('does not admit a pending request whose unknown session cannot be resolved', async () => {
    const permission = { id: 'permission-1', sessionID: 'unknown-child' };
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/permission') return [permission];
      if (path === '/session') return [];
      if (path === '/session/unknown-child?directory=%2Frepo') {
        throw new Error('404 Session not found');
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        getSessionWorkspaceMatch: vi.fn(() => undefined),
      } as never,
    });

    await proxy.handleRequest(makePayload(223, 'GET', '/permission'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 223, data: [] });
  });

  it('uses each root session snapshot to filter aggregate statuses', async () => {
    const manager = new SessionStateManager(
      {
        get: vi.fn(),
        set: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      } as never,
      { onStatusChange: vi.fn() },
      { shouldShow: () => false }
    );
    const sessions = Array.from({ length: 251 }, (_, index) => ({
      id: `local-${index}`,
      directory: '/repo',
    }));
    const statuses = {
      foreign: { type: 'idle' },
      'local-0': { type: 'busy' },
    };
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/session?limit=1000000') return sessions;
      if (path === '/session/status') return statuses;
      throw new Error(`Unexpected path: ${path}`);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        handleServerEvent: (
          event: Parameters<RestProxyCallbacks['sessionState']['handleServerEvent']>[0]
        ) => manager.handleServerEvent(event),
        getSessionWorkspaceMatch: (sessionID: string, workspacePath: string | null | undefined) =>
          manager.getSessionWorkspaceMatch(sessionID, workspacePath),
        isSessionInWorkspace: (sessionID: string, workspacePath: string | null | undefined) =>
          manager.isSessionInWorkspace(sessionID, workspacePath),
      } as never,
    });

    await proxy.handleRequest(makePayload(222, 'GET', '/session'));
    expect(manager.getSessionWorkspaceMatch('local-0', '/repo')).toBeUndefined();
    await proxy.handleRequest(makePayload(223, 'GET', '/session/status'));

    expect(
      serverRequest.mock.calls.filter(([, path]) => path === '/session?limit=1000000')
    ).toHaveLength(2);
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 223,
      data: { 'local-0': { type: 'busy' } },
    });
  });

  it('reuses the validated session catalog across status polls', async () => {
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/session?limit=1000000') return [{ id: 'session-1', directory: '/repo' }];
      if (path === '/session/status') return { 'session-1': { type: 'busy' } };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(226, 'GET', '/session/status'));
    await proxy.handleRequest(makePayload(227, 'GET', '/session/status'));

    expect(
      serverRequest.mock.calls.filter(([, path]) => path === '/session?limit=1000000')
    ).toHaveLength(1);
    expect(serverRequest.mock.calls.filter(([, path]) => path === '/session/status')).toHaveLength(
      2
    );
  });

  it('refreshes a stale status catalog when a new session appears', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let catalogRequestCount = 0;
    let statusRequestCount = 0;
    const serverRequest = vi.fn(async (_method: string, path: string) => {
      if (path === '/session?limit=1000000') {
        catalogRequestCount += 1;
        return catalogRequestCount === 1
          ? [{ id: 'session-1', directory: '/repo' }]
          : [
              { id: 'session-1', directory: '/repo' },
              { id: 'session-2', directory: '/repo' },
            ];
      }
      if (path === '/session/status') {
        statusRequestCount += 1;
        return statusRequestCount === 1
          ? { 'session-1': { type: 'busy' } }
          : { 'session-1': { type: 'busy' }, 'session-2': { type: 'busy' } };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(228, 'GET', '/session/status'));
    now += 5_000;
    await proxy.handleRequest(makePayload(229, 'GET', '/session/status'));

    expect(catalogRequestCount).toBe(2);
    expect(callbacks.postApiResponse).toHaveBeenLastCalledWith(1, {
      id: 229,
      data: {
        'session-1': { type: 'busy' },
        'session-2': { type: 'busy' },
      },
    });
    nowSpy.mockRestore();
  });

  it('keeps healthy session roots when one workspace root fails', async () => {
    const serverRequest = vi.fn(
      async (_method: string, _path: string, _body: unknown, options?: { directory?: string }) => {
        if (options?.directory === '/repo-b') throw new Error('repo-b unavailable');
        return [{ id: 'session-a', directory: '/repo-a' }];
      }
    );
    const callbacks = createCallbacks({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    callbacks.contextProvider.context.workspaceFolders = [
      { name: 'repo-a', path: '/repo-a' },
      { name: 'repo-b', path: '/repo-b' },
    ];
    const { proxy } = createProxy(callbacks);

    await proxy.handleRequest(makePayload(224, 'GET', '/session'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 224,
      data: [{ id: 'session-a', directory: '/repo-a' }],
    });
  });

  it('keeps healthy status roots when one workspace root fails', async () => {
    const serverRequest = vi.fn(
      async (_method: string, path: string, _body: unknown, options?: { directory?: string }) => {
        if (options?.directory === '/repo-b') throw new Error('repo-b unavailable');
        return path === '/session/status'
          ? { 'session-a': { type: 'busy' } }
          : [{ id: 'session-a', directory: '/repo-a' }];
      }
    );
    const callbacks = createCallbacks({
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });
    callbacks.contextProvider.context.workspaceFolders = [
      { name: 'repo-a', path: '/repo-a' },
      { name: 'repo-b', path: '/repo-b' },
    ];
    const { proxy } = createProxy(callbacks);

    await proxy.handleRequest(makePayload(225, 'GET', '/session/status'));

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 225,
      data: { 'session-a': { type: 'busy' } },
    });
  });

  it('sanitizes sibling-root catalog sessions and statuses', async () => {
    const localSession = {
      id: 'local',
      directory: '/repo-a',
      permission: { edit: 'allow' },
      revert: { messageID: 'message-local' },
      metadata: { secret: true },
      path: { cwd: '/repo-a', root: '/repo-a' },
      summary: {
        additions: 1,
        deletions: 2,
        files: 1,
        diffs: [{ file: 'local.ts', before: '', after: 'secret' }],
      },
    };
    const siblingSession = {
      id: 'sibling',
      directory: '/repo-b',
      permission: { edit: 'allow' },
      revert: { messageID: 'message-sibling' },
      metadata: { secret: true },
      path: { cwd: '/repo-b', root: '/repo-b' },
      summary: {
        additions: 3,
        deletions: 4,
        files: 2,
        diffs: [{ file: 'sibling.ts', before: '', after: 'secret' }],
      },
    };
    const localStatus = {
      type: 'busy',
      metadata: { secret: true },
      summary: { diffs: [{ file: 'local.ts', before: '', after: 'secret' }] },
    };
    const siblingStatus = {
      type: 'busy',
      metadata: { secret: true },
      summary: { diffs: [{ file: 'sibling.ts', before: '', after: 'secret' }] },
    };
    const serverRequest = vi.fn(
      async (_method: string, path: string, _body: unknown, options?: { directory?: string }) => {
        if (path === '/session?limit=1000000') {
          return options?.directory === '/repo-b' ? [siblingSession] : [localSession];
        }
        if (path === '/session/status') {
          return options?.directory === '/repo-b'
            ? { sibling: siblingStatus }
            : { local: localStatus };
        }
        throw new Error(`Unexpected path: ${path}`);
      }
    );
    const { proxy, callbacks } = createProxy({
      getWorkspacePath: () => '/repo-a',
      contextProvider: {
        ...createCallbacks().contextProvider,
        context: {
          workspacePath: '/repo-a',
          workspaceFolders: [
            { name: 'repo-a', path: '/repo-a' },
            { name: 'repo-b', path: '/repo-b' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      } as never,
      server: { ...createCallbacks().server, request: serverRequest } as never,
    });

    await proxy.handleRequest(makePayload(224, 'GET', '/session'));
    const sessionResponse = vi
      .mocked(callbacks.postApiResponse)
      .mock.calls.find(([, response]) => response.id === 224)?.[1];
    const sessions = sessionResponse && 'data' in sessionResponse ? sessionResponse.data : null;
    expect(sessions).toEqual(expect.any(Array));
    const [projectedLocal, projectedSibling] = sessions as Array<Record<string, unknown>>;
    expect(projectedLocal).toMatchObject({
      id: 'local',
      permission: { edit: 'allow' },
      metadata: { secret: true },
    });
    expect(projectedLocal?.summary).toMatchObject({
      diffs: [{ file: 'local.ts', additions: 0, deletions: 0 }],
    });
    expect(projectedSibling).toMatchObject({
      id: 'sibling',
      directory: '/repo-b',
      summary: { additions: 3, deletions: 4, files: 2 },
    });
    expect(projectedSibling).not.toHaveProperty('permission');
    expect(projectedSibling).not.toHaveProperty('revert');
    expect(projectedSibling).not.toHaveProperty('metadata');
    expect(projectedSibling).not.toHaveProperty('path');
    expect(projectedSibling?.summary).not.toHaveProperty('diffs');

    await proxy.handleRequest(makePayload(225, 'GET', '/session/status'));
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 225,
      data: {
        local: localStatus,
        sibling: { type: 'busy' },
      },
    });
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

  it.each([
    ['permission', '/permission'],
    ['question', '/question'],
  ] as const)(
    'reconciles each filtered %s snapshot into host attention state',
    async (kind, path) => {
      const visible = { id: `${kind}-visible`, sessionID: 'local' };
      const foreign = { id: `${kind}-foreign`, sessionID: 'foreign' };
      const extensionHidden = { id: `${kind}-extension-hidden`, sessionID: 'hidden' };
      const trashed = { id: `${kind}-trashed`, sessionID: 'trashed' };
      const reconcilePendingAttention = vi.fn();
      const { proxy, callbacks } = createProxy({
        server: {
          ...createCallbacks().server,
          request: vi.fn(() => Promise.resolve([visible, foreign, extensionHidden, trashed])),
        } as never,
        sessionState: {
          ...createCallbacks().sessionState,
          getSessionWorkspaceMatch: vi.fn((sessionID: string) => sessionID !== 'foreign'),
          reconcilePendingAttention,
        } as never,
        hiddenSessions: {
          ...createCallbacks().hiddenSessions,
          filterVisibleSessionRequests: vi.fn(<T extends { sessionID: string }>(items: T[]) =>
            items.filter((item) => item.sessionID !== 'hidden')
          ) as never,
        },
        sessionTrash: {
          ...createCallbacks().sessionTrash,
          filterVisibleSessionRequests: vi.fn(<T extends { sessionID: string }>(items: T[]) =>
            items.filter((item) => item.sessionID !== 'trashed')
          ) as never,
        },
      });

      await proxy.handleRequest(makePayload(231, 'GET', path));

      expect(reconcilePendingAttention).toHaveBeenCalledWith(kind, [visible], {
        kind,
        mutationRevision: 0,
        requestGeneration: 1,
      });
      expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, { id: 231, data: [visible] });
    }
  );

  it.each([
    ['permission', '/permission'],
    ['question', '/question'],
  ] as const)(
    'keeps the newer %s snapshot when concurrent requests complete in reverse order',
    async (kind, path) => {
      const firstResponse = deferred<unknown[]>();
      const secondResponse = deferred<unknown[]>();
      let requestCount = 0;
      const manager = new SessionStateManager(
        {
          get: vi.fn(),
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => Promise.resolve()),
        } as never,
        { onStatusChange: vi.fn() },
        { shouldShow: () => false }
      );
      for (const id of ['session-old', 'session-new']) {
        manager.handleServerEvent({
          type: 'session.updated',
          properties: { info: { id, directory: '/repo' } },
        });
      }
      const { proxy } = createProxy({
        server: {
          ...createCallbacks().server,
          request: vi.fn((_method: string, requestPath: string) => {
            if (requestPath !== path) throw new Error(`Unexpected request: ${requestPath}`);
            requestCount += 1;
            return requestCount === 1 ? firstResponse.promise : secondResponse.promise;
          }),
        } as never,
        sessionState: manager,
      });
      const request = (id: string, sessionID: string) => ({
        id,
        sessionID,
        ...(kind === 'permission' ? { title: id } : { questions: [] }),
      });

      const first = proxy.handleRequest(makePayload(232, 'GET', path));
      const second = proxy.handleRequest(makePayload(233, 'GET', path));
      secondResponse.resolve([request(`${kind}-new`, 'session-new')]);
      await second;
      firstResponse.resolve([request(`${kind}-old`, 'session-old')]);
      await first;

      expect([...manager.pending.keys()]).toEqual([`${kind}-new`]);
    }
  );

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

  it('authorizes a queued history check for its open session workspace', async () => {
    const serverRequest = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-1?directory=%2Frepo-a') {
        return { id: 'session-1', directory: '/repo-a' };
      }
      if (method === 'GET' && path === '/session/session-1/message?limit=200&directory=%2Frepo-a') {
        return { data: [], nextCursor: undefined };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const beginQueuedMessageDispatchClaim = vi.fn(() => Promise.resolve(true));
    const { proxy, callbacks } = createProxy({
      getWorkspacePath: () => '/repo-b',
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: {
        ...createCallbacks().sessionState,
        isSessionInWorkspace: vi.fn(() => false),
      } as never,
      beginQueuedMessageDispatchClaim,
    });

    await proxy.handleRequest({
      ...makePayload(309, 'GET', '/session/session-1/message?limit=200', {
        messageID: 'message-1',
        workspaceDirectory: '/repo-a',
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: 12 },
    });

    expect(beginQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      12,
      309,
      'message-1'
    );
    expect(serverRequest).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/session/session-1/message?limit=200&directory=%2Frepo-a',
      undefined,
      expect.objectContaining({ directory: '/repo-a' })
    );
    expect(callbacks.completeQueuedMessageDispatchClaim).not.toHaveBeenCalled();
    expect(callbacks.releaseQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      12,
      309
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 309,
      data: { items: [], nextCursor: undefined },
    });
  });

  it('rejects a queued prompt whose dispatch lease is stale', async () => {
    const beginQueuedMessageDispatchClaim = vi.fn(() => Promise.resolve(false));
    const { proxy, callbacks } = createProxy({ beginQueuedMessageDispatchClaim });

    await proxy.handleRequest({
      ...makePayload(302, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-302',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: 9 },
    });

    expect(beginQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      9,
      302,
      'message-302'
    );
    expect(callbacks.server.request).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 302,
      error: 'Queued message dispatch lease is no longer current',
    });
  });

  it('revalidates a queued dispatch immediately before the server request', async () => {
    const serverRequest = vi.fn();
    const isQueuedMessageDispatchClaimCurrent = vi.fn(() => false);
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      isQueuedMessageDispatchClaimCurrent,
    });

    await proxy.handleRequest({
      ...makePayload(305, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-305',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: 10 },
    });

    expect(isQueuedMessageDispatchClaimCurrent).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      10,
      305
    );
    expect(serverRequest).not.toHaveBeenCalled();
    expect(callbacks.releaseQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      10,
      305
    );
  });

  it('holds a queued dispatch claim through preparation and server admission', async () => {
    const persistence = {
      get: vi.fn(),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const queue = new QueuedMessageStore(persistence);
    await queue.update([
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'first',
        ownerViewId: 'view-a',
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
      {
        id: 'queue-2',
        sessionId: 'session-1',
        text: 'second',
        ownerViewId: 'view-b',
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);
    const firstClaim = queue.claimDispatch('view-a', 'session-1', 'queue-1', allViewsEligible)!;
    const admission = deferred<boolean>();
    const serverResponse = deferred<unknown>();
    const serverRequest = vi.fn(() => serverResponse.promise);
    const confirmPromptAdmission = vi.fn(() => admission.promise);
    const { proxy } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      confirmPromptAdmission,
      beginQueuedMessageDispatchClaim: (sessionId, itemId, lease, requestId, messageId) =>
        queue.beginDispatchAdmission('view-a', sessionId, itemId, lease, requestId, messageId),
      isQueuedMessageDispatchClaimCurrent: (sessionId, itemId, lease, requestId) =>
        queue.isDispatchAdmissionCurrent('view-a', sessionId, itemId, lease, requestId),
      completeQueuedMessageDispatchClaim: async (sessionId, itemId, lease, requestId) => {
        const persisted = queue.completeDispatchAdmission(
          'view-a',
          sessionId,
          itemId,
          lease,
          requestId
        );
        if (!persisted) return false;
        await persisted;
        return true;
      },
      releaseQueuedMessageDispatchClaim: (sessionId, itemId, lease, requestId) =>
        queue.releaseDispatchAdmission('view-a', sessionId, itemId, lease, requestId),
    });

    const firstDispatch = proxy.handleRequest({
      ...makePayload(303, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-303',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: firstClaim.lease },
    });
    await vi.waitFor(() => expect(confirmPromptAdmission).toHaveBeenCalledOnce());

    expect(queue.claimDispatch('view-b', 'session-1', 'queue-2', allViewsEligible)).toBeNull();
    admission.resolve(true);
    await vi.waitFor(() => expect(serverRequest).toHaveBeenCalledOnce());
    expect(queue.claimDispatch('view-b', 'session-1', 'queue-2', allViewsEligible)).toBeNull();

    serverResponse.resolve({ ok: true });
    await firstDispatch;
    expect(queue.list()?.map((message) => message.id)).toEqual(['queue-2']);
    expect(queue.claimDispatch('view-b', 'session-1', 'queue-2', allViewsEligible)).not.toBeNull();
  });

  it('persists accepted queue completion before restart can admit it again', async () => {
    const storage = new Map<string, unknown>();
    let rejectCompletionWrite = true;
    const persistence: Persistence = {
      get: <T>(key: string) => storage.get(key) as T | undefined,
      set: vi.fn((key: string, value: unknown) => {
        if (rejectCompletionWrite && Array.isArray(value) && value.length === 0) {
          rejectCompletionWrite = false;
          return Promise.reject(new Error('transient completion failure'));
        }
        storage.set(key, value);
        return Promise.resolve();
      }),
      remove: vi.fn(() => Promise.resolve()),
    };
    const queue = new QueuedMessageStore(persistence);
    await queue.update([
      {
        id: 'queue-1',
        messageId: 'message-1',
        sessionId: 'session-1',
        text: 'first',
        ownerViewId: 'view-a',
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);
    const claim = queue.claimDispatch('view-a', 'session-1', 'queue-1', allViewsEligible)!;
    const serverRequest = vi.fn(() => Promise.resolve({ ok: true }));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      beginQueuedMessageDispatchClaim: (sessionId, itemId, lease, requestId, messageId) =>
        queue.beginDispatchAdmission('view-a', sessionId, itemId, lease, requestId, messageId),
      isQueuedMessageDispatchClaimCurrent: (sessionId, itemId, lease, requestId) =>
        queue.isDispatchAdmissionCurrent('view-a', sessionId, itemId, lease, requestId),
      completeQueuedMessageDispatchClaim: async (sessionId, itemId, lease, requestId) => {
        const completion = queue.completeDispatchAdmission(
          'view-a',
          sessionId,
          itemId,
          lease,
          requestId
        );
        if (!completion) return false;
        await completion;
        return true;
      },
      releaseQueuedMessageDispatchClaim: (sessionId, itemId, lease, requestId) =>
        queue.releaseDispatchAdmission('view-a', sessionId, itemId, lease, requestId),
    });

    await proxy.handleRequest({
      ...makePayload(306, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-1',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: claim.lease },
    });

    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 306,
      data: { ok: true },
    });
    const restartedQueue = new QueuedMessageStore(persistence);
    expect(restartedQueue.list()).toEqual([]);
    expect(
      restartedQueue.claimDispatch('view-a', 'session-1', 'queue-1', allViewsEligible)
    ).toBeNull();
    expect(serverRequest).toHaveBeenCalledOnce();
  });

  it('reports exhausted completion persistence without resending accepted work', async () => {
    const serverRequest = vi.fn(() => Promise.resolve({ ok: true }));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      completeQueuedMessageDispatchClaim: vi.fn(() =>
        Promise.reject(new Error('Memento unavailable'))
      ),
    });

    await proxy.handleRequest({
      ...makePayload(307, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-307',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: 11 },
    });

    expect(serverRequest).toHaveBeenCalledOnce();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 307,
      data: { ok: true },
    });
    expect(callbacks.releaseQueuedMessageDispatchClaim).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Accepted queued message could not be durably removed: Memento unavailable'
    );
  });

  it('releases a queued dispatch cancelled during preparation before calling the server', async () => {
    const admission = deferred<boolean>();
    const confirmPromptAdmission = vi.fn(() => admission.promise);
    const serverRequest = vi.fn();
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      confirmPromptAdmission,
    });
    const operation = proxy.handleRequest({
      id: 304,
      cancelKey: 'queued-prompt',
      method: 'POST',
      path: '/session/session-1/prompt_async',
      body: { messageID: 'message-304', parts: [] },
      queuedMessageDispatch: { itemId: 'queue-1', lease: 6 },
    });
    await vi.waitFor(() => expect(confirmPromptAdmission).toHaveBeenCalledOnce());

    proxy.cancelRequest({ id: 304, cancelKey: 'queued-prompt' });
    await operation;

    expect(serverRequest).not.toHaveBeenCalled();
    expect(callbacks.isQueuedMessageDispatchClaimCurrent).not.toHaveBeenCalled();
    expect(callbacks.completeQueuedMessageDispatchClaim).not.toHaveBeenCalled();
    expect(callbacks.releaseQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      6,
      304
    );
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 304,
      error: 'API call aborted',
    });
  });

  it('cancels prompt admission before marking busy when generated dependencies are unignored', async () => {
    const serverRequest = vi.fn();
    const markSessionBusy = vi.fn();
    const confirmPromptAdmission = vi.fn(() => Promise.resolve(false));
    const { proxy, callbacks } = createProxy({
      server: { ...createCallbacks().server, request: serverRequest } as never,
      sessionState: { ...createCallbacks().sessionState, markSessionBusy } as never,
      confirmPromptAdmission,
    });

    await proxy.handleRequest({
      ...makePayload(301, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-301',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: 4 },
    });

    expect(confirmPromptAdmission).toHaveBeenCalledWith('/repo');
    expect(markSessionBusy).not.toHaveBeenCalled();
    expect(serverRequest).not.toHaveBeenCalled();
    expect(callbacks.postApiResponse).toHaveBeenCalledWith(1, {
      id: 301,
      error: 'Prompt cancelled because generated dependencies are not ignored by Git',
    });
    expect(callbacks.releaseQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      4,
      301
    );
  });

  it('does not run generated dependency admission for non-prompt requests', async () => {
    const confirmPromptAdmission = vi.fn(() => Promise.resolve(true));
    const { proxy } = createProxy({ confirmPromptAdmission });

    await proxy.handleRequest(makePayload(302, 'GET', '/session'));

    expect(confirmPromptAdmission).not.toHaveBeenCalled();
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

    await proxy.handleRequest({
      ...makePayload(32, 'POST', '/session/session-1/prompt_async', {
        messageID: 'message-32',
        parts: [],
      }),
      queuedMessageDispatch: { itemId: 'queue-1', lease: 7 },
    });

    expect(serverRequest.mock.calls).toEqual([
      [
        'POST',
        '/session/session-1/prompt_async',
        {
          messageID: 'message-32',
          parts: [],
          system: expect.stringContaining('folder selected for this session'),
        },
        withSignal(),
      ],
      ['GET', '/session/status', undefined, { directory: '/repo' }],
    ]);
    expect(reconcilePromptFailure).toHaveBeenCalledWith(attempt, undefined);
    expect(callbacks.releaseQueuedMessageDispatchClaim).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      7,
      32
    );
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
      ['POST', '/session/session-1/prompt_async', undefined, withSignal()],
      ['GET', '/session/status', undefined, { directory: '/repo' }],
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
