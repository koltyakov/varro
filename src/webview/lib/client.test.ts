import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from '../../shared/protocol';
import { fixture } from '../test-fixtures';

interface TestServerEventEnvelope {
  type: 'server/event';
  payload: {
    id?: string;
    type: string;
    seq?: number;
    sequenceOnly?: true;
    properties?: object;
  };
}

type TestInboundMessage = ExtensionMessage | TestServerEventEnvelope;

const bridgeMocks = vi.hoisted(() => {
  const apiCall = vi.fn();
  const postMessage = vi.fn();
  const messageHandlers: Array<(msg: ExtensionMessage) => void> = [];
  const onMessage = vi.fn((handler: (msg: ExtensionMessage) => void) => {
    messageHandlers.push(handler);
    return () => {
      const index = messageHandlers.indexOf(handler);
      if (index >= 0) messageHandlers.splice(index, 1);
    };
  });

  return { apiCall, postMessage, messageHandlers, onMessage };
});

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise client transport integration through the bridge module. */
vi.mock('./bridge', () => ({
  apiCall: bridgeMocks.apiCall,
  onMessage: bridgeMocks.onMessage,
  postMessage: bridgeMocks.postMessage,
}));

async function loadClient() {
  return import('./client');
}

type ClientApi = Awaited<ReturnType<typeof loadClient>>['client'];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emitMessage(message: TestInboundMessage) {
  for (const handler of bridgeMocks.messageHandlers) handler(fixture<ExtensionMessage>(message));
}

beforeEach(() => {
  vi.resetModules();
  bridgeMocks.apiCall.mockReset();
  bridgeMocks.postMessage.mockReset();
  bridgeMocks.onMessage.mockClear();
  bridgeMocks.messageHandlers.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client', () => {
  it('marks only interrupted recovery prompts for host admission checks', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(undefined);

    await client.session.sendAsync(
      'session-1',
      { messageID: 'msg_recovery', parts: [{ type: 'text', text: 'Continue' }] },
      { directory: '/repo', interruptedRecovery: true }
    );

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'POST',
      '/session/session-1/prompt_async?directory=%2Frepo',
      { messageID: 'msg_recovery', parts: [{ type: 'text', text: 'Continue' }] },
      { interruptedRecovery: true }
    );
  });

  it('adds the owning session only to automatic permission reply metadata', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(true);

    await client.session.respondPermission('session-auto', 'permission-auto', 'once', {
      permissionAutomationLease: 7,
    });
    await client.session.respondPermission('session-manual', 'permission-manual', 'reject');

    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      [
        'POST',
        '/permission/permission-auto/reply',
        { reply: 'once' },
        {
          permissionAutomationLease: 7,
          permissionAutomationSessionID: 'session-auto',
        },
      ],
      ['POST', '/permission/permission-manual/reply', { reply: 'reject' }],
    ]);
  });

  it('loads a bounded session page with continuation metadata', async () => {
    const { client } = await loadClient();
    const sessions = [{ id: 'session-1' }];
    bridgeMocks.apiCall.mockResolvedValue({ items: sessions, hasMore: true });

    await expect(client.session.list({ limit: 100 })).resolves.toEqual({
      items: sessions,
      hasMore: true,
    });
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/session?limit=100');
  });

  it('preserves incomplete session-page metadata', async () => {
    const { client } = await loadClient();
    const sessions = [{ id: 'session-1' }];
    bridgeMocks.apiCall.mockResolvedValue({
      items: sessions,
      hasMore: false,
      incomplete: true,
      unavailableDirectories: ['/repo-b'],
    });

    await expect(client.session.list({ limit: 100 })).resolves.toEqual({
      items: sessions,
      hasMore: false,
      incomplete: true,
      unavailableDirectories: ['/repo-b'],
    });
  });

  it('uses OpenCode native session search with encoded query parameters', async () => {
    const { client } = await loadClient();
    const controller = new AbortController();
    const sessions = [{ id: 'session-1' }];
    bridgeMocks.apiCall.mockResolvedValue({ items: sessions, hasMore: false });

    await expect(
      client.session.list({
        limit: 30,
        search: 'dark mode & contrast',
        roots: true,
        signal: controller.signal,
      })
    ).resolves.toEqual({ items: sessions, hasMore: false });
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'GET',
      '/session?limit=30&search=dark+mode+%26+contrast&roots=true',
      undefined,
      { signal: controller.signal }
    );
  });

  it('rejects malformed session page metadata', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ items: [], hasMore: 'yes' });

    await expect(client.session.list({ limit: 100 })).rejects.toThrow(
      'a session page with a boolean hasMore value'
    );

    bridgeMocks.apiCall.mockResolvedValue({ items: [], hasMore: false, incomplete: 'yes' });
    await expect(client.session.list({ limit: 100 })).rejects.toThrow(
      'a session page with a boolean incomplete value'
    );

    bridgeMocks.apiCall.mockResolvedValue({
      items: [],
      hasMore: false,
      unavailableDirectories: [1],
    });
    await expect(client.session.list({ limit: 100 })).rejects.toThrow(
      'a session page with string unavailableDirectories'
    );
  });

  it('forwards health, session, config, agent, and question requests to the api bridge', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockImplementation((_method: string, path: string) => {
      if (path === '/global/health') return Promise.resolve({ healthy: true, version: '1.0.0' });
      if (path === '/session/status') return Promise.resolve({});
      if (path === '/config/providers') return Promise.resolve({ providers: [], default: {} });
      if (path === '/model/default') return Promise.resolve(null);
      if (path === '/provider') return Promise.resolve({ all: [], default: {}, connected: [] });
      if (path === '/provider/auth') return Promise.resolve({});
      if (path === '/mcp/browser%20server/auth') {
        return Promise.resolve({
          authorizationUrl: 'https://mcp.example.com/authorize',
          oauthState: 'state-1',
        });
      }
      return Promise.resolve([]);
    });

    await client.health();
    await client.command.list();
    await client.session.list();
    await client.session.get('session-1');
    await client.session.update('session-1', { title: 'Renamed' });
    await client.session.fork('session-1');
    await client.session.fork('session-1', 'message-1');
    await client.session.delete('session-1');
    await client.session.abort('session-1');
    await client.session.share('session-1');
    await client.session.unshare('session-1');
    await client.session.init('session-1', {
      messageID: 'message-1',
      providerID: 'openai',
      modelID: 'gpt-4.1',
    });
    await client.session.diff('session-1');
    await client.session.diff('session-1', 'message-1');
    await client.session.status();
    await client.session.messages('session-1');
    await client.session.messages('session-1', { limit: 200 });
    await client.session.deleteMessage('session-1', 'message-1');
    await client.session.todos('session-1');
    await client.session.sendAsync('session-1', {
      messageID: 'msg-1',
      parts: [{ type: 'text', text: 'Hello' }],
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
      agent: 'build',
      noReply: true,
      variant: 'high',
    });
    await client.session.sendAsync('session-1', {
      parts: [
        { type: 'text', text: 'Steer now' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'file', url: 'blob:image-1', mime: 'image/png', filename: 'image.png' },
      ],
      delivery: 'steer',
    });
    await client.session.respondPermission('session-1', 'perm-1', 'always');
    await client.session.persistProjectPermissionAllow('session-1', 'perm-1', {
      directory: '/repo',
    });
    await client.session.allowPermissionForSession('session-1', 'perm-1', {
      directory: '/repo',
    });
    await client.session.revert('session-1', 'message-1');
    await client.session.unrevert('session-1');
    await client.session.compact('session-1', { providerID: 'openai', modelID: 'gpt-4.1' });
    await client.session.command('session-1', {
      command: 'test',
      arguments: '--watch',
      agent: 'build',
      model: 'openai/gpt-4.1',
      messageID: 'message-1',
    });
    await client.config.providers();
    await client.config.providerCatalog();
    await client.config.providerAuth();
    await client.config.authorizeProvider({ providerID: 'openai', method: 0 });
    await client.config.completeProviderAuth({ providerID: 'openai', method: 0, code: 'code-1' });
    await client.config.connectApiProvider({ providerID: 'anthropic', key: 'key-1' });
    await client.config.disconnectProvider('openai');
    await client.config.workspaceStatus();
    await client.mcp.authenticate('browser server');
    await client.mcp.startAuth('browser server');
    await client.mcp.completeAuth('browser server', 'oauth-code');
    await client.mcp.removeAuth('browser server');
    await client.agent.list();
    await client.question.list();
    await client.permission.list();
    await client.question.reply('question-1', [['Yes'], ['No']]);
    await client.question.reject('question-1');
    await client.varro.resolveWorkspacePath('package.json');
    await client.varro.pickWorkspaceFile();

    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      ['GET', '/global/health'],
      ['GET', '/command'],
      ['GET', '/session'],
      ['GET', '/session/session-1'],
      ['PATCH', '/session/session-1', { title: 'Renamed' }],
      ['POST', '/session/session-1/fork', undefined],
      ['POST', '/session/session-1/fork', { messageID: 'message-1' }],
      ['DELETE', '/session/session-1'],
      ['POST', '/session/session-1/abort'],
      ['POST', '/session/session-1/share'],
      ['DELETE', '/session/session-1/share'],
      [
        'POST',
        '/session/session-1/init',
        { messageID: 'message-1', providerID: 'openai', modelID: 'gpt-4.1' },
      ],
      ['GET', '/session/session-1/diff'],
      ['GET', '/session/session-1/diff?messageID=message-1'],
      ['GET', '/session/status'],
      ['GET', '/session/session-1/message'],
      ['GET', '/session/session-1/message?limit=200'],
      ['DELETE', '/session/session-1/message/message-1'],
      ['GET', '/session/session-1/todo'],
      [
        'POST',
        '/session/session-1/prompt_async',
        {
          messageID: 'msg-1',
          parts: [{ type: 'text', text: 'Hello' }],
          model: { providerID: 'openai', modelID: 'gpt-4.1' },
          agent: 'build',
          noReply: true,
          variant: 'high',
        },
      ],
      [
        'POST',
        '/session/session-1/prompt_async',
        {
          parts: [
            { type: 'text', text: 'Steer now' },
            { type: 'text', text: '[Working directory: /repo]' },
            { type: 'file', url: 'blob:image-1', mime: 'image/png', filename: 'image.png' },
          ],
        },
      ],
      ['POST', '/permission/perm-1/reply', { reply: 'always' }],
      [
        'POST',
        '/varro/permission/project-allow?directory=%2Frepo',
        { sessionId: 'session-1', permissionId: 'perm-1' },
      ],
      [
        'POST',
        '/varro/permission/session-allow?directory=%2Frepo',
        { sessionId: 'session-1', permissionId: 'perm-1' },
      ],
      ['POST', '/session/session-1/revert', { messageID: 'message-1' }],
      ['POST', '/session/session-1/unrevert'],
      ['POST', '/session/session-1/summarize', { providerID: 'openai', modelID: 'gpt-4.1' }],
      [
        'POST',
        '/session/session-1/command',
        {
          command: 'test',
          arguments: '--watch',
          agent: 'build',
          model: 'openai/gpt-4.1',
          messageID: 'message-1',
        },
      ],
      ['GET', '/config/providers'],
      ['GET', '/model/default'],
      ['GET', '/provider'],
      ['GET', '/provider/auth'],
      ['POST', '/provider/openai/oauth/authorize', { method: 0 }],
      [
        'POST',
        '/provider/openai/oauth/callback',
        { method: 0, code: 'code-1' },
        { timeoutMs: 315_000, retries: 0 },
      ],
      ['PUT', '/auth/anthropic', { type: 'api', key: 'key-1' }],
      ['DELETE', '/auth/openai'],
      ['GET', '/experimental/workspace/status'],
      ['POST', '/mcp/browser%20server/auth/authenticate'],
      ['POST', '/mcp/browser%20server/auth'],
      ['POST', '/mcp/browser%20server/auth/callback', { code: 'oauth-code' }],
      ['DELETE', '/mcp/browser%20server/auth'],
      ['GET', '/agent'],
      ['GET', '/question'],
      ['GET', '/permission'],
      ['POST', '/question/question-1/reply', { answers: [['Yes'], ['No']] }],
      ['POST', '/question/question-1/reject'],
      ['GET', '/varro/workspace-path/resolve?path=package.json'],
      ['GET', '/varro/workspace-file/pick'],
    ]);
  });

  it.each([null, {}, { healthy: 'true', version: '1.0.0' }, { healthy: true, version: 1 }])(
    'rejects malformed health payload %#',
    async (response) => {
      const { client } = await loadClient();
      bridgeMocks.apiCall.mockResolvedValue(response);

      await expect(client.health()).rejects.toThrow('/global/health');
    }
  );

  it('rejects malformed collection payloads with the endpoint in the error', async () => {
    const { client } = await loadClient();
    const requests = [
      { path: '/session', load: () => client.session.list() },
      { path: '/session/status', load: () => client.session.status() },
      { path: '/session/session-1/message', load: () => client.session.messages('session-1') },
      { path: '/config/providers', load: () => client.config.providers() },
      { path: '/agent', load: () => client.agent.list() },
      { path: '/command', load: () => client.command.list() },
      { path: '/mcp', load: () => client.mcp.status() },
      { path: '/lsp', load: () => client.lsp.status() },
      { path: '/question', load: () => client.question.list() },
      { path: '/permission', load: () => client.permission.list() },
      { path: '/vcs/status', load: () => client.file.status() },
    ];

    for (const request of requests) {
      bridgeMocks.apiCall.mockResolvedValueOnce(null);
      if (request.path === '/config/providers') bridgeMocks.apiCall.mockResolvedValueOnce(null);
      await expect(request.load()).rejects.toThrow(request.path);
    }
  });

  it.each([
    { providers: {}, default: {} },
    { providers: [], default: [] },
  ])('rejects malformed provider containers %#', async (response) => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(response);

    await expect(client.config.providers()).rejects.toThrow('/config/providers');
  });

  it('loads the exact server default model with provider metadata', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockImplementation((_method: string, path: string) => {
      if (path === '/config/providers') {
        return Promise.resolve({ providers: [], default: { openai: 'gpt-provider' } });
      }
      return Promise.resolve({ providerID: 'anthropic', modelID: 'claude-current' });
    });

    await expect(client.config.providers()).resolves.toEqual({
      providers: [],
      default: { openai: 'gpt-provider' },
      defaultModel: { providerID: 'anthropic', modelID: 'claude-current' },
    });
    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      ['GET', '/config/providers'],
      ['GET', '/model/default'],
    ]);
  });

  it('preserves explicit null and falls back when the optional default endpoint is unavailable', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockImplementation((_method: string, path: string) => {
      if (path === '/config/providers') return Promise.resolve({ providers: [], default: {} });
      return Promise.resolve(null);
    });
    await expect(client.config.providers()).resolves.toMatchObject({ defaultModel: null });

    bridgeMocks.apiCall.mockImplementation((_method: string, path: string) => {
      if (path === '/config/providers') return Promise.resolve({ providers: [], default: {} });
      return Promise.reject(new Error('404 Not Found'));
    });
    await expect(client.config.providers()).resolves.toMatchObject({ defaultModel: undefined });

    bridgeMocks.apiCall.mockImplementation((_method: string, path: string) => {
      if (path === '/config/providers') return Promise.resolve({ providers: [], default: {} });
      return Promise.reject(new Error('500 Server Error'));
    });
    await expect(client.config.providers()).resolves.toMatchObject({ defaultModel: undefined });

    bridgeMocks.apiCall.mockImplementation((_method: string, path: string) => {
      if (path === '/config/providers') {
        return Promise.resolve({ providers: [{ id: 'openai', models: {} }], default: {} });
      }
      return Promise.resolve('<!doctype html><title>OpenCode</title>');
    });
    await expect(client.config.providers()).resolves.toEqual({
      providers: [{ id: 'openai', models: {} }],
      default: {},
      defaultModel: undefined,
    });
  });

  it.each([
    {
      path: '/provider/auth',
      response: [],
      load: (client: ClientApi) => client.config.providerAuth(),
    },
    {
      path: '/experimental/workspace/status',
      response: {},
      load: (client: ClientApi) => client.config.workspaceStatus(),
    },
  ])('rejects a malformed $path response', async ({ path, response, load }) => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(response);

    await expect(load(client)).rejects.toThrow(path);
  });

  it('unwraps cursor-paginated message responses', async () => {
    const { client } = await loadClient();
    const items = [{ info: { id: 'message-1' }, parts: [] }];
    bridgeMocks.apiCall.mockResolvedValue({ items, nextCursor: 'cursor with spaces' });

    const result = await client.session.messages('session-1', {
      limit: 200,
      before: 'previous/cursor',
    });

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'GET',
      '/session/session-1/message?limit=200&before=previous%2Fcursor'
    );
    expect(result).toBe(items);
    expect(result.nextCursor).toBe('cursor with spaces');
  });

  it('preserves direct message page responses', async () => {
    const { client } = await loadClient();
    const items = [{ info: { id: 'message-1' }, parts: [] }];
    bridgeMocks.apiCall.mockResolvedValue(items);

    const result = await client.session.messages('session-1');

    expect(result).toBe(items);
  });

  it.each([{ items: {} }, { items: [], nextCursor: 42 }])(
    'rejects malformed wrapped message page %#',
    async (response) => {
      const { client } = await loadClient();
      bridgeMocks.apiCall.mockResolvedValue(response);

      await expect(client.session.messages('session-1')).rejects.toThrow(
        '/session/session-1/message'
      );
    }
  );

  it('suppresses OpenCode share URLs after a confirmed local unshare', async () => {
    const { client } = await loadClient();
    const { markSessionShared, markSessionUnshared } = await import('./session-share-overrides');
    const sharedSession = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Shared session',
      version: '1',
      share: { url: 'https://share.test/session-1' },
      time: { created: 1, updated: 2 },
    };
    bridgeMocks.apiCall
      .mockResolvedValueOnce([sharedSession])
      .mockResolvedValueOnce(sharedSession)
      .mockResolvedValueOnce(sharedSession);

    markSessionUnshared('session-1');

    await expect(client.session.list()).resolves.toEqual([{ ...sharedSession, share: undefined }]);
    await expect(client.session.get('session-1')).resolves.toEqual({
      ...sharedSession,
      share: undefined,
    });

    markSessionShared('session-1');
    await expect(client.session.get('session-1')).resolves.toEqual(sharedSession);
  });

  it('creates sessions with an empty body when none is provided', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ id: 'session-1' });

    await client.session.create();

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('POST', '/session', {});
  });

  it('scopes session creation, prompts, and sharing to an explicit workspace directory', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ id: 'session-1' });

    await client.session.create({ title: 'Ralph' }, { directory: '/workspace with spaces' });
    await client.session.sendAsync(
      'session-1',
      { parts: [{ type: 'text', text: 'Anchor' }], noReply: true },
      { directory: '/workspace with spaces' }
    );
    await client.session.share('session-1', { directory: '/workspace with spaces' });
    await client.session.unshare('session-1', { directory: '/workspace with spaces' });

    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/session?directory=%2Fworkspace+with+spaces',
      { title: 'Ralph' }
    );
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/session/session-1/prompt_async?directory=%2Fworkspace+with+spaces',
      { parts: [{ type: 'text', text: 'Anchor' }], noReply: true }
    );
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      3,
      'POST',
      '/session/session-1/share?directory=%2Fworkspace+with+spaces'
    );
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      4,
      'DELETE',
      '/session/session-1/share?directory=%2Fworkspace+with+spaces'
    );
  });

  it.each([
    {
      name: 'session get',
      method: 'GET',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D',
      request: (client: ClientApi, value: string) => client.session.get(value),
    },
    {
      name: 'session update',
      method: 'PATCH',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D',
      request: (client: ClientApi, value: string) => client.session.update(value, {}),
    },
    {
      name: 'session fork',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/fork',
      request: (client: ClientApi, value: string) => client.session.fork(value),
    },
    {
      name: 'session delete',
      method: 'DELETE',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D',
      request: (client: ClientApi, value: string) => client.session.delete(value),
    },
    {
      name: 'session abort',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/abort',
      request: (client: ClientApi, value: string) => client.session.abort(value),
    },
    {
      name: 'session share',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/share',
      request: (client: ClientApi, value: string) => client.session.share(value),
    },
    {
      name: 'session unshare',
      method: 'DELETE',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/share',
      request: (client: ClientApi, value: string) => client.session.unshare(value),
    },
    {
      name: 'session init',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/init',
      request: (client: ClientApi, value: string) =>
        client.session.init(value, {
          messageID: 'message-1',
          providerID: 'openai',
          modelID: 'gpt',
        }),
    },
    {
      name: 'session diff',
      method: 'GET',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/diff',
      request: (client: ClientApi, value: string) => client.session.diff(value),
    },
    {
      name: 'session messages',
      method: 'GET',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/message',
      request: (client: ClientApi, value: string) => client.session.messages(value),
    },
    {
      name: 'session message delete',
      method: 'DELETE',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/message/segment%20%2F%5C%3F%23%25%26%3D',
      request: (client: ClientApi, value: string) => client.session.deleteMessage(value, value),
    },
    {
      name: 'session todos',
      method: 'GET',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/todo',
      request: (client: ClientApi, value: string) => client.session.todos(value),
    },
    {
      name: 'session revert',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/revert',
      request: (client: ClientApi, value: string) => client.session.revert(value, 'message-1'),
    },
    {
      name: 'session unrevert',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/unrevert',
      request: (client: ClientApi, value: string) => client.session.unrevert(value),
    },
    {
      name: 'session compact',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/summarize',
      request: (client: ClientApi, value: string) =>
        client.session.compact(value, { providerID: 'openai', modelID: 'gpt' }),
    },
    {
      name: 'session command',
      method: 'POST',
      path: '/session/segment%20%2F%5C%3F%23%25%26%3D/command',
      request: (client: ClientApi, value: string) =>
        client.session.command(value, { command: 'test', arguments: '' }),
    },
    {
      name: 'permission reply',
      method: 'POST',
      path: '/permission/segment%20%2F%5C%3F%23%25%26%3D/reply',
      request: (client: ClientApi, value: string) =>
        client.session.respondPermission('session-1', value, 'once'),
    },
    {
      name: 'question reply',
      method: 'POST',
      path: '/question/segment%20%2F%5C%3F%23%25%26%3D/reply',
      request: (client: ClientApi, value: string) => client.question.reply(value, []),
    },
    {
      name: 'question reject',
      method: 'POST',
      path: '/question/segment%20%2F%5C%3F%23%25%26%3D/reject',
      request: (client: ClientApi, value: string) => client.question.reject(value),
    },
  ])('encodes reserved characters in the $name path', async ({ method, path, request }) => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue([]);

    await request(client, 'segment /\\?#%&=');

    expect(bridgeMocks.apiCall).toHaveBeenCalledOnce();
    expect(bridgeMocks.apiCall.mock.calls[0]?.slice(0, 2)).toEqual([method, path]);
  });

  it('encodes the session diff message ID as a query parameter', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue([]);

    await client.session.diff('session /\\?#%', 'message /\\?#%&=');

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'GET',
      '/session/session%20%2F%5C%3F%23%25/diff?messageID=message+%2F%5C%3F%23%25%26%3D'
    );
  });

  it('builds provider limit query parameters only when a model is selected', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ status: 'available' });

    await client.config.providerLimit('openai');
    await client.config.providerLimit('openai', 'gpt-4.1');

    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/varro/provider-limit?providerID=openai'
    );
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/varro/provider-limit?providerID=openai&modelID=gpt-4.1'
    );
  });

  it('tracks workspace status event summaries from newer servers', async () => {
    const { getWorkspaceStatusEventSummary } = await loadClient();

    emitMessage({
      type: 'server/event',
      payload: {
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connecting' },
      },
    });
    emitMessage({
      type: 'server/event',
      payload: { type: 'workspace.ready', properties: { name: 'Main workspace' } },
    });

    expect(getWorkspaceStatusEventSummary()).toEqual({
      entries: [{ workspaceID: 'ws-1', status: 'connecting' }],
      latest: { type: 'workspace.ready', message: 'Main workspace' },
    });
  });

  it('treats malformed recycle bin payloads as empty', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue('<!doctype html><html></html>');

    await expect(client.varro.recycleBin.list()).resolves.toEqual([]);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/varro/session-trash');
  });

  it('dedupes concurrent session status requests', async () => {
    const { client } = await loadClient();
    const deferred = Promise.resolve({ 'session-1': { type: 'idle' } });
    bridgeMocks.apiCall.mockReturnValue(deferred);

    const [first, second] = await Promise.all([client.session.status(), client.session.status()]);

    expect(first).toEqual({ 'session-1': { type: 'idle' } });
    expect(second).toEqual({ 'session-1': { type: 'idle' } });
    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/session/status');
  });

  it('dedupes concurrent question list requests', async () => {
    const { client } = await loadClient();
    const deferred = Promise.resolve([{ id: 'q1' }]);
    bridgeMocks.apiCall.mockReturnValue(deferred);

    const [first, second] = await Promise.all([client.question.list(), client.question.list()]);

    expect(first).toEqual([{ id: 'q1' }]);
    expect(second).toEqual([{ id: 'q1' }]);
    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/question');
  });

  it.each([
    {
      name: 'session status',
      path: '/session/status',
      load: (client: ClientApi) => client.session.status(),
      oldValue: { old: { type: 'idle' } },
      newValue: { current: { type: 'busy' } },
    },
    {
      name: 'questions',
      path: '/question',
      load: (client: ClientApi) => client.question.list(),
      oldValue: [{ id: 'old-question' }],
      newValue: [{ id: 'current-question' }],
    },
    {
      name: 'permissions',
      path: '/permission',
      load: (client: ClientApi) => client.permission.list(),
      oldValue: [{ id: 'old-permission' }],
      newValue: [{ id: 'current-permission' }],
    },
  ])(
    'detaches an in-flight $name request when workspace caches are invalidated',
    async ({ path, load, oldValue, newValue }) => {
      const { client, invalidateClientWorkspaceCaches } = await loadClient();
      const oldDeferred = createDeferred<unknown>();
      const currentDeferred = createDeferred<unknown>();
      bridgeMocks.apiCall
        .mockReturnValueOnce(oldDeferred.promise)
        .mockReturnValueOnce(currentDeferred.promise);

      const oldRequest = load(client);
      invalidateClientWorkspaceCaches();
      const currentRequest = load(client);

      expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);
      expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(1, 'GET', path);
      expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(2, 'GET', path);

      oldDeferred.resolve(oldValue);
      await expect(oldRequest).resolves.toBe(oldValue);

      const nextConsumer = load(client);
      expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);

      currentDeferred.resolve(newValue);
      await expect(Promise.all([currentRequest, nextConsumer])).resolves.toEqual([
        newValue,
        newValue,
      ]);
    }
  );

  it('keeps a new file-status request cached when the detached request fails', async () => {
    const { client, invalidateClientWorkspaceCaches } = await loadClient();
    const oldDeferred = createDeferred<unknown>();
    const currentDeferred = createDeferred<unknown>();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    bridgeMocks.apiCall
      .mockReturnValueOnce(oldDeferred.promise)
      .mockReturnValueOnce(currentDeferred.promise);

    const oldRequest = client.file.status();
    const oldRejection = expect(oldRequest).rejects.toThrow('old workspace failed');
    invalidateClientWorkspaceCaches();
    const currentRequest = client.file.status();

    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);

    oldDeferred.reject(new Error('old workspace failed'));
    await oldRejection;

    const nextConsumer = client.file.status();
    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);

    const currentValue = [
      { path: 'src/current.ts', added: 4, removed: 1, status: 'modified' as const },
    ];
    currentDeferred.resolve([
      { file: 'src/current.ts', additions: 4, deletions: 1, status: 'modified' },
    ]);
    await expect(Promise.all([currentRequest, nextConsumer])).resolves.toEqual([
      currentValue,
      currentValue,
    ]);
  });

  it('caches file status requests for two seconds', async () => {
    const { client } = await loadClient();
    const nowSpy = vi.spyOn(Date, 'now');
    const response = [{ file: 'src/app.ts', additions: 2, deletions: 1, status: 'modified' }];
    const expected = [{ path: 'src/app.ts', added: 2, removed: 1, status: 'modified' }];

    nowSpy.mockReturnValueOnce(1_000);
    nowSpy.mockReturnValueOnce(1_500);
    nowSpy.mockReturnValueOnce(3_100);
    bridgeMocks.apiCall.mockResolvedValue(response);

    expect(await client.file.status()).toEqual(expected);
    expect(await client.file.status()).toEqual(expected);
    expect(await client.file.status()).toEqual(expected);

    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(1, 'GET', '/vcs/status');
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(2, 'GET', '/vcs/status');
  });

  it('rejects malformed VCS status entries', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue([
      { file: 'src/app.ts', additions: 2, deletions: '1', status: 'modified' },
    ]);

    await expect(client.file.status()).rejects.toThrow('/vcs/status');
  });

  it('clears the file status cache after a failed request', async () => {
    const { client } = await loadClient();

    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    bridgeMocks.apiCall.mockRejectedValueOnce(new Error('offline'));
    bridgeMocks.apiCall.mockResolvedValueOnce([]);

    await expect(client.file.status()).rejects.toThrow('offline');
    await expect(client.file.status()).resolves.toEqual([]);

    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);
  });

  it('resets the workspace status event summary when workspace caches are invalidated', async () => {
    const { getWorkspaceStatusEventSummary, invalidateClientWorkspaceCaches } = await loadClient();

    emitMessage({
      type: 'server/event',
      payload: {
        type: 'workspace.status',
        properties: { workspaceID: 'old-workspace', status: 'connected' },
      },
    });
    emitMessage({
      type: 'server/event',
      payload: { type: 'workspace.ready', properties: { name: 'Old workspace' } },
    });

    invalidateClientWorkspaceCaches();

    expect(getWorkspaceStatusEventSummary()).toEqual({ entries: [] });
  });

  it('delivers server events to specific and wildcard listeners', async () => {
    const { serverEvents } = await loadClient();
    const specific = vi.fn();
    const wildcard = vi.fn();
    const stopSpecific = serverEvents.on('session.updated', specific);
    serverEvents.on('*', wildcard);

    const message: ExtensionMessage = {
      type: 'server/event',
      payload: { type: 'session.updated' },
    };

    emitMessage(message);
    stopSpecific();
    emitMessage(message);

    expect(specific).toHaveBeenCalledTimes(1);
    expect(specific).toHaveBeenCalledWith(message.payload);
    expect(wildcard).toHaveBeenCalledTimes(2);
    expect(wildcard).toHaveBeenNthCalledWith(1, message.payload);
    expect(wildcard).toHaveBeenNthCalledWith(2, message.payload);
  });

  it.each([
    {
      name: 'delivers a new sequence-only event',
      events: [
        { id: 'sequence-only', type: 'session.updated', seq: 2, sequenceOnly: true },
      ] as const,
      wildcardIndexes: [0],
    },
    {
      name: 'delivers the first sequenced twin as an upgrade',
      events: [
        { id: 'sequence-upgrade', type: 'session.updated' },
        { id: 'sequence-upgrade', type: 'session.updated', seq: 3, sequenceOnly: true },
        { id: 'sequence-upgrade', type: 'session.updated', seq: 2, sequenceOnly: true },
      ] as const,
      wildcardIndexes: [0, 1],
    },
    {
      name: 'suppresses an older duplicate after a sequenced first occurrence',
      events: [
        { id: 'sequenced-first', type: 'session.updated', seq: 3, sequenceOnly: true },
        { id: 'sequenced-first', type: 'session.updated', seq: 2, sequenceOnly: true },
      ] as const,
      wildcardIndexes: [0],
    },
  ])('$name', async ({ events, wildcardIndexes }) => {
    const { serverEvents } = await loadClient();
    const specific = vi.fn();
    const wildcard = vi.fn();
    serverEvents.on('session.updated', specific);
    serverEvents.on('*', wildcard);

    for (const event of events) emitMessage({ type: 'server/event', payload: event });

    expect(specific.mock.calls.map((call) => call[0])).toEqual([events[0]]);
    expect(wildcard.mock.calls.map((call) => call[0])).toEqual(
      wildcardIndexes.map((index) => events[index])
    );
  });

  it('never applies an unseen coalesced sequence range as a mutation', async () => {
    const { serverEvents } = await loadClient();
    const specific = vi.fn();
    const wildcard = vi.fn();
    serverEvents.on('session.next.tool.progress', specific);
    serverEvents.on('*', wildcard);
    const marker = {
      id: 'coalesced-progress',
      type: 'session.next.tool.progress',
      seq: 100,
      sequenceOnly: true,
      sequenceStart: 1,
      properties: { sessionID: 'session-1' },
    } as const;

    emitMessage({ type: 'server/event', payload: marker });

    expect(specific).not.toHaveBeenCalled();
    expect(wildcard).toHaveBeenCalledWith(marker);
  });

  it('reapplies an event after its bounded observation metadata is evicted', async () => {
    const { serverEvents } = await loadClient();
    const specific = vi.fn();
    const wildcard = vi.fn();
    serverEvents.on('session.updated', specific);
    serverEvents.on('*', wildcard);

    emitMessage({
      type: 'server/event',
      payload: { id: 'event-evicted', type: 'session.updated' },
    });
    for (let index = 0; index < 1_024; index += 1) {
      emitMessage({
        type: 'server/event',
        payload: { id: `event-${index}`, type: 'session.updated', seq: index },
      });
    }
    const replay = {
      id: 'event-evicted',
      type: 'session.updated',
      seq: 1_025,
      sequenceOnly: true,
    } as const;
    emitMessage({ type: 'server/event', payload: replay });

    expect(specific).toHaveBeenCalledTimes(1_026);
    expect(specific).toHaveBeenLastCalledWith(replay);
    expect(wildcard).toHaveBeenCalledTimes(1_026);
    expect(wildcard).toHaveBeenLastCalledWith(replay);
  });

  it('logs errors from server event handlers without aborting other listeners', async () => {
    const { serverEvents } = await loadClient();
    const healthy = vi.fn();

    serverEvents.on('session.updated', () => {
      throw new Error('specific boom');
    });
    serverEvents.on('session.updated', healthy);
    serverEvents.on('*', () => {
      throw new Error('wildcard boom');
    });

    emitMessage({
      type: 'server/event',
      payload: { type: 'session.updated' },
    });

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.postMessage).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'log',
      payload: {
        msg: 'wildcard handler error',
        error: 'Error: wildcard boom',
        level: 'error',
      },
    });
    expect(bridgeMocks.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'log',
      payload: {
        msg: 'event handler error',
        error: 'Error: specific boom',
        level: 'error',
      },
    });
  });

  it('runs wildcard sequence observers before typed event handlers', async () => {
    const { serverEvents } = await loadClient();
    const order: string[] = [];
    serverEvents.on('session.deleted', () => order.push('typed'));
    serverEvents.on('*', () => order.push('wildcard'));

    emitMessage({ type: 'server/event', payload: { type: 'session.deleted' } });

    expect(order).toEqual(['wildcard', 'typed']);
  });

  it('ignores non-server messages for event listeners', async () => {
    const { serverEvents } = await loadClient();
    const listener = vi.fn();

    serverEvents.on('*', listener);
    emitMessage({ type: 'command/abort' });

    expect(listener).not.toHaveBeenCalled();
    expect(bridgeMocks.postMessage).not.toHaveBeenCalled();
  });

  it('normalizes recycle bin entries with parentID, summary, and compacting time', async () => {
    const { client } = await loadClient();
    const session = {
      id: 'sess-1',
      projectID: 'proj-1',
      directory: '/tmp',
      parentID: 'parent-1',
      summary: { additions: 10, deletions: 5, files: 3 },
      title: 'Test',
      version: '1',
      time: { created: 100, updated: 200, compacting: 300 },
    };
    bridgeMocks.apiCall.mockResolvedValue([
      {
        rootID: 'sess-1',
        deletedAt: 1000,
        expiresAt: 2000,
        root: session,
        sessions: [session],
      },
    ]);

    const result = await client.varro.recycleBin.list();

    expect(result).toHaveLength(1);
    const entry = result[0];
    if (!entry) throw new Error('Expected one recycle bin entry');
    expect(entry.root.parentID).toBe('parent-1');
    expect(entry.root.summary).toEqual({ additions: 10, deletions: 5, files: 3 });
    expect(entry.root.time.compacting).toBe(300);
  });

  it('normalizes recycle bin entries without optional fields', async () => {
    const { client } = await loadClient();
    const session = {
      id: 'sess-1',
      projectID: 'proj-1',
      directory: '/tmp',
      title: 'Test',
      version: '1',
      time: { created: 100, updated: 200 },
    };
    bridgeMocks.apiCall.mockResolvedValue([
      {
        rootID: 'sess-1',
        deletedAt: 1000,
        expiresAt: 2000,
        root: session,
        sessions: [session],
      },
    ]);

    const result = await client.varro.recycleBin.list();

    expect(result).toHaveLength(1);
    const entry = result[0];
    if (!entry) throw new Error('Expected one recycle bin entry');
    expect(entry.root.parentID).toBeUndefined();
    expect(entry.root.summary).toBeUndefined();
    expect(entry.root.time.compacting).toBeUndefined();
  });

  it('returns null for recycle bin entries with missing required fields', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue([
      { rootID: 'root-1', deletedAt: 1000, expiresAt: 2000, root: null, sessions: [] },
      { rootID: null, deletedAt: 1000, expiresAt: 2000 },
      { deletedAt: 'not-a-number' },
      'not-an-object',
      null,
    ]);

    const result = await client.varro.recycleBin.list();
    expect(result).toEqual([]);
  });

  it('returns null for recycle bin sessions with invalid shapes', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue([
      {
        rootID: 'sess-1',
        deletedAt: 1000,
        expiresAt: 2000,
        root: { id: 'sess-1' }, // missing required fields
        sessions: [{ id: 'sess-1' }],
      },
      {
        rootID: 'root-2',
        deletedAt: 1000,
        expiresAt: 2000,
        root: {
          id: 'sess-2',
          projectID: 'proj',
          directory: '/tmp',
          title: 'T',
          version: '1',
          time: { created: 'not-a-number', updated: 200 },
        },
        sessions: [],
      },
    ]);

    const result = await client.varro.recycleBin.list();
    expect(result).toEqual([]);
  });

  it('handles workspace.failed event with missing properties.message', async () => {
    const { getWorkspaceStatusEventSummary } = await loadClient();

    emitMessage({
      type: 'server/event',
      payload: { type: 'workspace.failed', properties: {} },
    });

    expect(getWorkspaceStatusEventSummary().latest).toEqual({
      type: 'workspace.failed',
      message: 'Workspace connection failed',
    });
  });

  it('handles workspace.ready event with missing properties.name', async () => {
    const { getWorkspaceStatusEventSummary } = await loadClient();

    emitMessage({
      type: 'server/event',
      payload: { type: 'workspace.ready', properties: {} },
    });

    expect(getWorkspaceStatusEventSummary().latest).toEqual({
      type: 'workspace.ready',
      message: 'Workspace connected',
    });
  });

  it('ignores workspace.status events with invalid properties', async () => {
    const { getWorkspaceStatusEventSummary } = await loadClient();

    emitMessage({
      type: 'server/event',
      payload: {
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'unknown-status' },
      },
    });

    expect(getWorkspaceStatusEventSummary().entries).toEqual([]);
  });

  it('ignores workspace.status events with missing workspaceID', async () => {
    const { getWorkspaceStatusEventSummary } = await loadClient();

    emitMessage({
      type: 'server/event',
      payload: {
        type: 'workspace.status',
        properties: { status: 'connected' },
      },
    });

    expect(getWorkspaceStatusEventSummary().entries).toEqual([]);
  });

  it('forwards authorizeProvider with inputs', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({});

    await client.config.authorizeProvider({
      providerID: 'openai',
      method: 1,
      inputs: { apiKey: 'sk-test' },
    });

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('POST', '/provider/openai/oauth/authorize', {
      method: 1,
      inputs: { apiKey: 'sk-test' },
    });
  });

  it('loads the full provider catalog', async () => {
    const { client } = await loadClient();
    const response = {
      all: [{ id: 'anthropic', name: 'Anthropic' }],
      default: { anthropic: 'claude' },
      connected: ['anthropic'],
    };
    bridgeMocks.apiCall.mockResolvedValue(response);

    await expect(client.config.providerCatalog()).resolves.toEqual(response);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/provider');
  });

  it('forwards API provider credentials and metadata', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(true);

    await client.config.connectApiProvider({
      providerID: 'openai',
      key: 'sk-test',
      metadata: { organization: 'org-1' },
    });

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('PUT', '/auth/openai', {
      type: 'api',
      key: 'sk-test',
      metadata: { organization: 'org-1' },
    });
  });

  it('removes encoded provider credentials', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(true);

    await expect(client.config.disconnectProvider('custom provider')).resolves.toBe(true);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('DELETE', '/auth/custom%20provider');
  });

  it('does not include modelID param when providerLimit is called with null modelID', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ status: 'available' });

    await client.config.providerLimit('openai', null);

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'GET',
      '/varro/provider-limit?providerID=openai'
    );
  });

  it('forwards recycleBin restore, delete, and empty calls', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(true);

    await client.varro.recycleBin.restore('root-1');
    await client.varro.recycleBin.delete('root-2');
    await client.varro.recycleBin.empty();

    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      ['POST', '/varro/session-trash/root-1/restore'],
      ['DELETE', '/varro/session-trash/root-2/delete'],
      ['DELETE', '/varro/session-trash'],
    ]);
  });

  it('forwards workspace, model routing, and judge calls', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({});

    await client.varro.readWorkspaceFile('src/app.ts');
    await client.varro.saveModelRouting({
      target: 'small_model',
      providerID: 'openai',
      modelID: 'gpt-4.1',
    });
    await client.varro.openCodeConfig();
    await client.varro.judgePermission({
      permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
    });
    await client.varro.resolveJudgeModel({
      providerID: 'openai',
      modelID: 'gpt-4.1',
      variant: 'low',
    });

    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      ['GET', '/varro/workspace-file?path=src%2Fapp.ts'],
      [
        'POST',
        '/varro/opencode-config/model-routing',
        {
          target: 'small_model',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      ],
      ['GET', '/varro/opencode-config'],
      [
        'POST',
        '/varro/permission/judge',
        {
          permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1' },
          model: { providerID: 'openai', modelID: 'gpt-4.1' },
        },
      ],
      ['GET', '/varro/permission/judge/model?providerID=openai&modelID=gpt-4.1&variant=low'],
    ]);
  });

  it('forwards mcp connect and disconnect calls', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(true);

    await client.mcp.connect('my-server');
    await client.mcp.disconnect('my-server');

    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      ['POST', '/mcp/my-server/connect'],
      ['POST', '/mcp/my-server/disconnect'],
    ]);
  });

  it('forwards varro.session.deleteImmediately call', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(true);

    await client.varro.session.deleteImmediately('sess-1');

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('DELETE', '/varro/session/sess-1/delete');
  });

  it('requests the aggregate session diff summary through the canonical encoded route', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      durationMs: 65_000,
      activeStartedAt: null,
    });

    await expect(client.varro.session.diffSummary('session with space')).resolves.toEqual({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      durationMs: 65_000,
      activeStartedAt: null,
    });
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'GET',
      '/varro/session/session%20with%20space/diff-summary'
    );
  });

  it('updates a session pin through the canonical encoded route', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(['session with space']);

    await expect(client.varro.session.setPinned('session with space', true)).resolves.toEqual([
      'session with space',
    ]);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'POST',
      '/varro/session/session%20with%20space/pin',
      { pinned: true }
    );
  });

  it('reorders pinned sessions through the canonical encoded route', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(['target', 'session with space']);

    await expect(
      client.varro.session.reorderPinned('session with space', 'target', {
        directory: '/repo',
        targetDirectory: '/other-repo',
      })
    ).resolves.toEqual(['target', 'session with space']);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith(
      'POST',
      '/varro/session/session%20with%20space/reorder-pin?directory=%2Frepo',
      { targetSessionID: 'target', targetDirectory: '/other-repo' }
    );
  });

  it('rejects entries with a malformed partial summary', async () => {
    const { client } = await loadClient();
    const session = {
      id: 'sess-1',
      projectID: 'proj-1',
      directory: '/tmp',
      summary: { additions: 10, deletions: 'not-a-number', files: 3 },
      title: 'Test',
      version: '1',
      time: { created: 100, updated: 200 },
    };
    bridgeMocks.apiCall.mockResolvedValue([
      {
        rootID: 'sess-1',
        deletedAt: 1000,
        expiresAt: 2000,
        root: session,
        sessions: [session],
      },
    ]);

    const result = await client.varro.recycleBin.list();

    expect(result).toEqual([]);
  });
});
