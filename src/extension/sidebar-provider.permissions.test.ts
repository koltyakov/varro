/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These tests deliberately model malformed permission events and inspect controlled provider internals. */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import {
  attachTestView,
  createContextProvider,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

const PROJECT_ROOT = '/repo';
const PROJECT_SESSION_DIRECTORY = '/worktrees/feature';
const projectAttentionCases = [
  {
    kind: 'permission',
    event: {
      type: 'permission.asked',
      properties: {
        id: 'project-permission',
        sessionID: 'project-session',
        permission: 'bash',
        title: 'Run command',
        always: [],
      },
    },
    replyPath: '/permission/project-permission/reply',
    replyBody: { reply: 'once' },
  },
  {
    kind: 'question',
    event: {
      type: 'question.asked',
      properties: {
        id: 'project-question',
        sessionID: 'project-session',
        questions: [],
      },
    },
    replyPath: '/question/project-question/reply',
    replyBody: { answers: [['Yes']] },
  },
] as const;

function embeddedPermission() {
  return {
    id: 'perm-1',
    sessionID: 'session-1',
    permission: 'bash',
    title: 'Run Bash command',
    tool: { messageID: 'msg-1', callID: 'call-1' },
  };
}

async function createProviderWithEmbeddedPermission() {
  const { provider } = await createSidebarProviderInstance({
    server: createServer({ request: undefined as never }),
  });
  const { posted, view } = attachTestView(provider);
  const providerState = provider as unknown as {
    view: typeof view;
    blockingRequestsForWebview: Array<{
      id: string;
      sessionID: string;
      kind: 'permission' | 'question';
      props: Record<string, unknown>;
    }>;
    sessionState: { handleServerEvent(event: unknown): void };
  };
  providerState.blockingRequestsForWebview = [
    { id: 'perm-1', sessionID: 'session-1', kind: 'permission', props: embeddedPermission() },
  ];
  // These tests start from a view whose HTML already embedded the recovered request.
  (
    provider as unknown as { webviewSession: { embeddedBlockingRequests: unknown[] } }
  ).webviewSession.embeddedBlockingRequests = providerState.blockingRequestsForWebview;
  return { provider, posted, providerState };
}

function lastPermissionAutomationLease(posted: unknown[]) {
  return posted
    .filter(
      (message): message is { type: 'permission-automation/update'; payload: { lease: number } } =>
        (message as { type?: string }).type === 'permission-automation/update'
    )
    .at(-1)?.payload.lease;
}

async function createProjectAttentionHarness() {
  const values = new Map<string, unknown>([
    ['varro.sessionHistoryScopes', { 'project:project-1': 'project' }],
    ['varro.sessionHistoryScopeProjects', { [PROJECT_ROOT]: 'project:project-1' }],
  ]);
  const workspaceState = {
    get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
    update: vi.fn(() => Promise.resolve()),
  };
  const contextProvider = createContextProvider();
  contextProvider.getOpenWorkspaceRoot = vi.fn((path: string) =>
    path === PROJECT_ROOT ? PROJECT_ROOT : null
  );
  const server = createServer({
    request: vi.fn(async (method: string, path: string, _body?: unknown, options?: unknown) => {
      if (path === '/project/current') {
        return { id: 'project-1', worktree: PROJECT_ROOT, vcs: 'git' };
      }
      if (method === 'GET' && (path === '/permission' || path === '/question')) {
        const directory = (options as { directory?: string } | undefined)?.directory;
        const kind = path === '/permission' ? 'permission' : 'question';
        const pending = projectAttentionCases.find((entry) => entry.kind === kind)!;
        return directory === PROJECT_SESSION_DIRECTORY ? [pending.event.properties] : [];
      }
      const url = new URL(path, 'http://localhost');
      if (
        url.pathname === '/session' &&
        url.searchParams.get('limit') === '1000000' &&
        url.searchParams.get('scope') === 'project'
      ) {
        return [
          {
            id: 'project-session',
            projectID: 'project-1',
            directory: PROJECT_SESSION_DIRECTORY,
            title: 'Project session',
          },
        ];
      }
      if (
        method === 'POST' &&
        (path === '/permission/project-permission/reply' ||
          path === '/question/project-question/reply')
      ) {
        return true;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  });
  const { provider } = await createSidebarProviderInstance({
    contextProvider,
    server,
    workspaceState: workspaceState as never,
  });
  const { posted } = attachTestView(provider);
  await provider.handleMessage({ type: 'ready' });
  await provider.handleMessage({
    type: 'api/request',
    payload: { id: 300, method: 'GET', path: '/session' },
  });
  const eventHandler = server.on.mock.calls.find(([event]) => event === 'event')?.[1] as
    | ((event: unknown) => void)
    | undefined;
  if (!eventHandler) throw new Error('Expected the server event bridge to be attached');
  return { eventHandler, posted, provider, server };
}

/** Opens `/repo` and moves `moved-session` (plus `laterMoves`) into worktrees under it. */
async function createMovedConversationHarness(
  options: {
    laterMoves?: readonly string[];
    roots?: readonly string[];
    workspacePath?: string;
  } = {}
) {
  let canonicalLookupError: Error | undefined;
  const worktreeFor = (sessionID: string) => `/repo/.worktrees/${sessionID}`;
  const worktree = worktreeFor('moved-session');
  const permission = {
    id: 'moved-permission',
    sessionID: 'moved-session',
    permission: 'external_directory',
    title: 'Access external directory',
    always: [],
  };
  let pending: unknown[] = [permission];
  const roots = options.roots ?? ['/repo'];
  const contextProvider = createContextProvider();
  contextProvider.context.workspaceFolders = roots.map((path) => ({ name: path, path }));
  if (options.workspacePath) contextProvider.context.workspacePath = options.workspacePath;
  contextProvider.getOpenWorkspaceRoot = vi.fn((path: string) =>
    roots.includes(path) ? path : null
  );
  const server = createServer({
    request: vi.fn(
      async (method: string, path: string, _body?: unknown, requestOptions?: unknown) => {
        const directory = (requestOptions as { directory?: string } | undefined)?.directory;
        const sessionMatch = path.match(/^\/session\/([^/?]+)$/);
        if (method === 'GET' && sessionMatch) {
          if (canonicalLookupError) throw canonicalLookupError;
          const sessionID = decodeURIComponent(sessionMatch[1]!);
          return {
            id: sessionID,
            directory: worktreeFor(sessionID),
            projectID: 'project-1',
            title: 'Moved chat',
            version: '2',
            time: { created: 1, updated: 2 },
          };
        }
        if (method === 'GET' && path === '/permission')
          return directory === worktree ? pending : [];
        return [];
      }
    ),
  });
  const { provider } = await createSidebarProviderInstance({ contextProvider, server });
  const { posted } = attachTestView(provider);
  await provider.handleMessage({ type: 'ready' });
  const lease = lastPermissionAutomationLease(posted);
  if (lease === undefined) throw new Error('Expected a permission automation lease');
  const providerState = provider as unknown as {
    sessionState: { handleServerEvent(event: unknown): void };
  };
  for (const sessionID of ['moved-session', ...(options.laterMoves ?? [])]) {
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: sessionID, directory: '/repo', projectID: 'project-1' } },
    });
    provider.post({
      type: 'server/event',
      payload: {
        type: 'session.next.moved',
        workspaceDirectory: '/repo',
        properties: { sessionID, location: { directory: worktreeFor(sessionID) } },
      },
    });
    await vi.waitFor(() =>
      expect(posted).toContainEqual({
        type: 'session/transferred',
        payload: { sessionId: sessionID, directory: worktreeFor(sessionID), available: true },
      })
    );
  }
  const eventHandler = server.on.mock.calls.find(([event]) => event === 'event')?.[1] as
    | ((event: unknown) => void)
    | undefined;
  if (!eventHandler) throw new Error('Expected the server event bridge to be attached');
  return {
    eventHandler,
    lease,
    permission,
    posted,
    provider,
    server,
    worktree,
    setPending: (requests: unknown[]) => {
      pending = requests;
    },
    failCanonicalLookups: (error: Error | undefined) => {
      canonicalLookupError = error;
    },
    invalidateCatalogs: () => {
      const { endpoints } = provider as unknown as {
        endpoints: Set<{ restProxy: { invalidateSessionCatalog(): void } }>;
      };
      for (const endpoint of endpoints) endpoint.restProxy.invalidateSessionCatalog();
    },
  };
}
describe('SidebarProvider permission replay', () => {
  it.each(projectAttentionCases)(
    'forwards nested project-catalog $kind events to the owning endpoint',
    async ({ event }) => {
      const { eventHandler, posted } = await createProjectAttentionHarness();
      posted.length = 0;

      eventHandler({ directory: PROJECT_SESSION_DIRECTORY, payload: event });

      expect(posted).toContainEqual({
        type: 'server/event',
        payload: { ...event, workspaceDirectory: PROJECT_SESSION_DIRECTORY },
      });
    }
  );

  it.each(projectAttentionCases)(
    'sends nested project-catalog $kind replies to the exact session instance',
    async ({ event, replyBody, replyPath }) => {
      const { eventHandler, provider, server } = await createProjectAttentionHarness();
      eventHandler({ directory: PROJECT_SESSION_DIRECTORY, payload: event });
      server.request.mockClear();

      await provider.handleMessage({
        type: 'api/request',
        payload: { id: 301, method: 'POST', path: replyPath, body: replyBody },
      });

      expect(server.request).toHaveBeenCalledWith(
        'POST',
        replyPath,
        replyBody,
        expect.objectContaining({
          directory: PROJECT_SESSION_DIRECTORY,
          signal: expect.any(AbortSignal),
        })
      );
    }
  );

  it.each(projectAttentionCases)(
    'keeps nested project-catalog $kind requests in the pending snapshot',
    async ({ event, kind }) => {
      const { eventHandler, posted, provider } = await createProjectAttentionHarness();
      eventHandler({ directory: PROJECT_SESSION_DIRECTORY, payload: event });
      posted.length = 0;

      await provider.handleMessage({
        type: 'api/request',
        payload: {
          id: 302,
          method: 'GET',
          path: kind === 'permission' ? '/permission' : '/question',
        },
      });

      expect(posted).toContainEqual({
        type: 'api/response',
        payload: { id: 302, data: [expect.objectContaining({ id: event.properties.id })] },
      });
    }
  );

  it('routes a project worktree permission outside the folder to the catalog root owner', async () => {
    const { eventHandler, posted, provider } = await createProjectAttentionHarness();
    eventHandler({ directory: PROJECT_SESSION_DIRECTORY, payload: projectAttentionCases[0].event });
    posted.length = 0;

    await provider.handleMessage({
      type: 'permission/reveal',
      payload: { permissionId: 'project-permission' },
    });

    expect(posted).toContainEqual({
      type: 'permission/actionable',
      payload: { permissionId: 'project-permission' },
    });
  });

  it.each([
    ['alone', [], false, true],
    ['after another conversation moves', ['second-session'], false, true],
    ['after the session catalog is invalidated', [], true, true],
    ['after its verification is dropped with no new ask', [], true, false],
  ] as const)(
    'keeps a moved conversation permission actionable %s',
    async (_label, laterMoves, invalidate, askAgain) => {
      const harness = await createMovedConversationHarness({ laterMoves });
      const { eventHandler, lease, permission, posted, provider, server, worktree } = harness;
      eventHandler({
        directory: worktree,
        payload: { type: 'permission.asked', properties: permission },
      });
      // A reload drops in-memory catalog and transfer verification but keeps the retained link.
      if (invalidate) harness.invalidateCatalogs();
      posted.length = 0;

      if (askAgain) {
        eventHandler({
          directory: worktree,
          payload: { type: 'permission.asked', properties: permission },
        });
        await vi.waitFor(() =>
          expect(posted).toContainEqual({
            type: 'server/event',
            payload: {
              type: 'permission.asked',
              properties: permission,
              workspaceDirectory: worktree,
            },
          })
        );
      }
      await provider.handleMessage({
        type: 'api/request',
        payload: { id: 303, method: 'GET', path: '/permission' },
      });

      expect(posted).toContainEqual({
        type: 'api/response',
        payload: { id: 303, data: [expect.objectContaining({ id: 'moved-permission' })] },
      });

      posted.length = 0;
      await provider.handleMessage({
        type: 'permission/reveal',
        payload: { permissionId: 'moved-permission' },
      });
      expect(posted).toContainEqual({
        type: 'permission/actionable',
        payload: { permissionId: 'moved-permission' },
      });
      // The visible sidebar suppresses the status item itself, so check the computed attention.
      const attention = provider as unknown as { getCurrentStatusBarState(): { text?: string } };
      expect(attention.getCurrentStatusBarState().text).toBe('$(bell-dot) Varro: 1 waiting');

      server.request.mockClear();
      await provider.handleMessage({
        type: 'api/request',
        payload: {
          id: 304,
          method: 'POST',
          path: '/permission/moved-permission/reply',
          body: { reply: 'once' },
          permissionAutomationLease: lease,
          permissionAutomationSessionID: 'moved-session',
        },
      });
      expect(server.request).toHaveBeenCalledWith(
        'POST',
        '/permission/moved-permission/reply',
        { reply: 'once' },
        expect.objectContaining({ directory: worktree })
      );
    }
  );

  it('verifies a moved conversation through the folder it moved out of', async () => {
    const harness = await createMovedConversationHarness({ roots: ['/other', '/repo'] });

    const { endpoints } = harness.provider as unknown as {
      endpoints: Set<{
        restProxy: { getAuthorizedSessionOwningRoot(id: string): string | undefined };
      }>;
    };
    for (const endpoint of endpoints) {
      expect(endpoint.restProxy.getAuthorizedSessionOwningRoot('moved-session')).toBe('/repo');
    }
  });

  it('clears host attention for a moved conversation once its snapshot omits the request', async () => {
    const harness = await createMovedConversationHarness();
    const { eventHandler, permission, provider, worktree } = harness;
    eventHandler({
      directory: worktree,
      payload: { type: 'permission.asked', properties: permission },
    });
    const { sessionState } = provider as unknown as {
      sessionState: { pending: ReadonlyMap<string, unknown> };
    };
    expect(sessionState.pending.has('moved-permission')).toBe(true);

    // The reply event was missed; the destination no longer lists the request.
    harness.setPending([]);
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 305, method: 'GET', path: '/permission' },
    });

    expect(sessionState.pending.has('moved-permission')).toBe(false);
  });

  it('does not deliver a late moved-conversation ask after its reply', async () => {
    const harness = await createMovedConversationHarness();
    const { eventHandler, permission, posted, worktree } = harness;
    harness.invalidateCatalogs();
    posted.length = 0;

    eventHandler({
      directory: worktree,
      payload: { type: 'permission.asked', properties: permission },
    });
    eventHandler({
      directory: worktree,
      payload: {
        type: 'permission.replied',
        properties: { sessionID: 'moved-session', requestID: 'moved-permission', reply: 'once' },
      },
    });

    await vi.waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({
          type: 'server/event',
          payload: expect.objectContaining({ type: 'permission.replied' }),
        })
      )
    );
    expect(posted).not.toContainEqual(
      expect.objectContaining({
        type: 'server/event',
        payload: expect.objectContaining({ type: 'permission.asked' }),
      })
    );
  });

  it('rejects a cold snapshot only while a moved conversation cannot be verified', async () => {
    const harness = await createMovedConversationHarness();
    const { posted, provider } = harness;
    harness.invalidateCatalogs();
    harness.failCanonicalLookups(new Error('503 Service Unavailable'));

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 306, method: 'GET', path: '/permission' },
    });
    // An unverified conversation must not look resolved to the webview.
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 306, error: expect.stringContaining('503') },
    });

    // A missing origin location says nothing about the destination conversation.
    harness.failCanonicalLookups(new Error('404 Location not found'));
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 309, method: 'GET', path: '/permission' },
    });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 309, error: expect.stringContaining('Location not found') },
    });

    harness.failCanonicalLookups(new Error('404 Session not found'));
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 307, method: 'GET', path: '/permission' },
    });
    expect(posted).toContainEqual({ type: 'api/response', payload: { id: 307, data: [] } });
  });

  it('keeps moved-conversation attention when the selected folder changes', async () => {
    const harness = await createMovedConversationHarness({ roots: ['/repo', '/other'] });
    const { eventHandler, permission, provider, worktree } = harness;
    eventHandler({
      directory: worktree,
      payload: { type: 'permission.asked', properties: permission },
    });
    const access = provider as unknown as {
      sessionState: { pending: ReadonlyMap<string, unknown> };
      reconcileWorkspaceMembership(context: unknown): void;
    };

    access.reconcileWorkspaceMembership({
      workspacePath: '/other',
      workspaceFolders: [
        { name: 'repo', path: '/repo' },
        { name: 'other', path: '/other' },
      ],
    });

    expect(access.sessionState.pending.has('moved-permission')).toBe(true);
  });

  it('routes moved-conversation attention only to the view of its catalog root', async () => {
    const harness = await createMovedConversationHarness({
      roots: ['/repo', '/other'],
      workspacePath: '/other',
    });
    const { eventHandler, permission, posted, provider, worktree } = harness;
    posted.length = 0;

    eventHandler({
      directory: worktree,
      payload: { type: 'permission.asked', properties: permission },
    });
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 308, method: 'GET', path: '/permission' },
    });

    // The `/other` view neither shows the prompt nor lists it, so it cannot flash there.
    expect(posted).not.toContainEqual(
      expect.objectContaining({
        type: 'server/event',
        payload: expect.objectContaining({ type: 'permission.asked' }),
      })
    );
    expect(posted).toContainEqual({ type: 'api/response', payload: { id: 308, data: [] } });
  });

  it('replays pending permission requests after the webview becomes ready', async () => {
    const { provider, posted, providerState } = await createProviderWithEmbeddedPermission();

    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', directory: '/repo' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: embeddedPermission(),
    });

    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: embeddedPermission(),
      },
    });
  });

  it('clears resolved embedded permission requests before replay on ready', async () => {
    const { provider, posted, providerState } = await createProviderWithEmbeddedPermission();

    providerState.sessionState.handleServerEvent({
      type: 'permission.replied',
      properties: {
        permissionID: 'perm-1',
        sessionID: 'session-1',
      },
    });

    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.replied',
        properties: {
          id: 'perm-1',
          permissionID: 'perm-1',
          requestID: 'perm-1',
          sessionID: 'session-1',
        },
      },
    });
    expect(posted).not.toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: embeddedPermission(),
      },
    });
  });

  it('only shows waiting status for permission requests in the current workspace', async () => {
    const { provider } = await createSidebarProviderInstance();
    const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
    const statusBarItem = createStatusBarItem.mock.results.at(-1)?.value;
    const openCodeItemIndex = createStatusBarItem.mock.calls.findIndex(
      ([id]) => id === 'varro.opencode-version'
    );
    const openCodeStatusBarItem = createStatusBarItem.mock.results[openCodeItemIndex]?.value;
    if (!statusBarItem) throw new Error('Expected status bar item to exist');
    if (!openCodeStatusBarItem) throw new Error('Expected OpenCode status bar item to exist');
    expect(statusBarItem.hide).not.toHaveBeenCalled();
    expect(openCodeStatusBarItem.show).toHaveBeenCalled();

    statusBarItem.show.mockClear();
    statusBarItem.hide.mockClear();

    const providerState = provider as unknown as {
      sessionState: {
        handleServerEvent(event: unknown): void;
        revealPermission(permissionId: string): void;
      };
    };

    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-other', title: 'Other repo', directory: '/other' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-other',
        sessionID: 'session-other',
        permission: 'bash',
        title: 'Run Bash command',
      },
    });

    expect(statusBarItem.show).not.toHaveBeenCalled();
    expect(openCodeStatusBarItem.text).toBe('$(robot) OpenCode');
    expect(provider.getStatusBarClickAction()).toBe('focus');

    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-local', title: 'Current repo', directory: '/repo' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-local',
        sessionID: 'session-local',
        permission: 'bash',
        title: 'Run Bash command',
      },
    });

    expect(statusBarItem.show).not.toHaveBeenCalled();
    providerState.sessionState.revealPermission('perm-local');

    expect(statusBarItem.show).toHaveBeenCalled();
    expect(statusBarItem.text).toBe('$(bell-dot) Varro: 1 waiting');
    expect(statusBarItem.tooltip).toContain('Current repo: Run Bash command');
    expect(provider.getStatusBarClickAction()).toBe('attention');
  });

  it('badges the sidebar view with waiting requests until they are answered', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { view } = attachTestView(provider);
    const badgedView = Object.assign(view, {
      visible: false,
      badge: undefined as { value: number; tooltip: string } | undefined,
    });
    const providerState = provider as unknown as {
      sessionState: {
        handleServerEvent(event: unknown): void;
        revealPermission(permissionId: string): void;
      };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-local', title: 'Current repo', directory: '/repo' } },
    });
    for (const id of ['perm-one', 'perm-two']) {
      providerState.sessionState.handleServerEvent({
        type: 'permission.asked',
        properties: { id, sessionID: 'session-local', permission: 'bash', title: 'Run' },
      });
    }
    expect(badgedView.badge).toBeUndefined();

    providerState.sessionState.revealPermission('perm-one');
    expect(badgedView.badge).toEqual({
      value: 1,
      tooltip: '1 request waiting for your input',
    });
    providerState.sessionState.revealPermission('perm-two');
    expect(badgedView.badge?.value).toBe(2);

    for (const requestID of ['perm-one', 'perm-two']) {
      providerState.sessionState.handleServerEvent({
        type: 'permission.replied',
        properties: { sessionID: 'session-local', requestID, reply: 'once' },
      });
    }
    expect(badgedView.badge).toBeUndefined();
  });

  it('accepts an automatic reply with a known session when host pending state is missing', async () => {
    const server = createServer({ request: vi.fn(() => Promise.resolve(true)) });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const lease = lastPermissionAutomationLease(posted);
    expect(lease).toBeTypeOf('number');
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'restored-session', directory: '/repo' } },
    });
    server.request.mockClear();

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 199,
        method: 'POST',
        path: '/permission/restored-permission/reply',
        body: { reply: 'once' },
        permissionAutomationLease: lease!,
        permissionAutomationSessionID: 'restored-session',
      },
    });

    expect(server.request).toHaveBeenCalledWith(
      'POST',
      '/permission/restored-permission/reply',
      { reply: 'once' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 199, data: true },
    });
  });

  it('adds an authoritative allow rule only to the permission-owning session', async () => {
    const server = createServer({
      request: vi.fn((method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/permission') {
          return Promise.resolve([
            {
              id: 'permission-1',
              sessionID: 'session-1',
              permission: 'bash',
              always: ['npm test *'],
            },
          ]);
        }
        if (method === 'GET' && path === '/session/session-1') {
          return Promise.resolve({
            id: 'session-1',
            permission: [{ permission: '*', pattern: '*', action: 'ask' }],
          });
        }
        if (method === 'PATCH' && path === '/session/session-1') {
          return Promise.resolve({ id: 'session-1', ...(body as object) });
        }
        return Promise.resolve(undefined);
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', directory: '/repo' } },
    });
    server.request.mockClear();

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 203,
        method: 'POST',
        path: '/varro/permission/session-allow?directory=%2Frepo',
        body: { sessionId: 'session-1', permissionId: 'permission-1' },
      },
    });

    expect(server.request).toHaveBeenCalledWith(
      'PATCH',
      '/session/session-1',
      {
        permission: [
          { permission: '*', pattern: '*', action: 'ask' },
          { permission: 'bash', pattern: 'npm test *', action: 'allow' },
        ],
      },
      { directory: '/repo' }
    );
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 203, data: undefined },
    });
  });

  it('accepts a project-catalog permission reply through the catalog root workspace', async () => {
    const values = new Map<string, unknown>([
      ['varro.sessionHistoryScopes', { 'project:project-1': 'project' }],
      ['varro.sessionHistoryScopeProjects', { '/repo': 'project:project-1' }],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
      update: vi.fn(() => Promise.resolve()),
    };
    const contextProvider = createContextProvider();
    contextProvider.getOpenWorkspaceRoot = vi.fn((path: string) =>
      path === '/repo' ? '/repo' : null
    );
    const server = createServer({
      request: vi.fn(async (method: string, path: string) => {
        if (path === '/project/current') {
          return { id: 'project-1', worktree: '/repo', vcs: 'git' };
        }
        const url = new URL(path, 'http://localhost');
        if (
          url.pathname === '/session' &&
          url.searchParams.get('limit') === '1000000' &&
          url.searchParams.get('scope') === 'project'
        ) {
          return [
            {
              id: 'project-session',
              projectID: 'project-1',
              directory: '/worktrees/feature',
            },
          ];
        }
        if (method === 'POST' && path === '/permission/project-permission/reply') return true;
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    });
    const { provider } = await createSidebarProviderInstance({
      contextProvider,
      server,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const lease = lastPermissionAutomationLease(posted);
    expect(lease).toBeTypeOf('number');
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 198, method: 'GET', path: '/session' },
    });
    server.request.mockClear();

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 197,
        method: 'POST',
        path: '/permission/project-permission/reply',
        body: { reply: 'once' },
        permissionAutomationLease: lease!,
        permissionAutomationSessionID: 'project-session',
      },
    });

    expect(server.request).toHaveBeenCalledWith(
      'POST',
      '/permission/project-permission/reply',
      { reply: 'once' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 197, data: true },
    });
  });

  it('rejects automatic reply metadata that conflicts with host pending ownership', async () => {
    const server = createServer({ request: vi.fn(() => Promise.resolve(true)) });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const lease = lastPermissionAutomationLease(posted);
    expect(lease).toBeTypeOf('number');
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    for (const sessionID of ['session-a', 'session-b']) {
      providerState.sessionState.handleServerEvent({
        type: 'session.updated',
        properties: { info: { id: sessionID, directory: '/repo' } },
      });
    }
    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: { id: 'permission-a', sessionID: 'session-a', permission: 'bash' },
    });
    server.request.mockClear();

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 200,
        method: 'POST',
        path: '/permission/permission-a/reply',
        body: { reply: 'once' },
        permissionAutomationLease: lease!,
        permissionAutomationSessionID: 'session-b',
      },
    });

    expect(server.request).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 200, error: 'Permission automation ownership changed' },
    });
  });

  it('rejects automatic judge and reply requests for another workspace before OpenCode', async () => {
    const server = createServer({ request: vi.fn() });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const lease = lastPermissionAutomationLease(posted);
    expect(lease).toBeTypeOf('number');
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-b', directory: '/repo-b' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'permission-b',
        sessionID: 'session-b',
        permission: 'bash',
        title: 'Run command',
      },
    });
    server.request.mockClear();

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 201,
        method: 'POST',
        path: '/varro/permission/judge',
        body: {
          permission: { id: 'permission-b', sessionID: 'session-b', type: 'bash' },
        },
        permissionAutomationLease: lease!,
      },
    });
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 202,
        method: 'POST',
        path: '/permission/permission-b/reply',
        body: { reply: 'once' },
        permissionAutomationLease: lease!,
        permissionAutomationSessionID: 'session-b',
      },
    });

    expect(server.request).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 201, error: 'Permission automation ownership changed' },
    });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 202, error: 'Permission automation ownership changed' },
    });
  });

  it.each([1, 2] as const)(
    'shows the external v%s server address before versions without local CLI details',
    async (apiVersion) => {
      const version = readMaximumTestedOpenCodeVersion(undefined, apiVersion);
      const server = createServer({
        isAttachOnly: true,
        apiVersion,
        url: 'http://127.0.0.1:4097',
        status: { state: 'stopped' },
        readServerInfo: vi.fn(async () => ({
          managedProcess: false,
          cliVersion: '0.0.1',
          health: { healthy: true, version },
        })),
      });
      await createSidebarProviderInstance({ server });
      const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
      const itemIndex = createStatusBarItem.mock.calls.findIndex(
        ([id]) => id === 'varro.opencode-version'
      );
      const item = createStatusBarItem.mock.results[itemIndex]?.value;
      const address = 'Server address: http://127.0.0.1:4097\nServer IP: 127.0.0.1';
      expect(item.tooltip).toBe(
        `${address}\nOpenCode Server: unknown\nServer port: 4097\n\nVarro extension: 0.26.4`
      );

      const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
      statusHandler?.({ state: 'running', url: server.url });

      await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${version}`));
      expect(item.tooltip).toBe(
        `${address}\nOpenCode Server: ${version}\nServer port: 4097\n\nVarro extension: 0.26.4`
      );
    }
  );

  it.each([
    { isAttachOnly: false, url: 'http://127.0.0.1:54321', port: '54321' },
    { isAttachOnly: true, url: 'http://opencode.example', port: '80' },
    { isAttachOnly: true, url: 'https://opencode.example', port: '443' },
  ])(
    'shows the effective server port for $url and refreshes it after restart',
    async (testCase) => {
      const version = readMaximumTestedOpenCodeVersion(undefined, 2);
      const server = createServer({
        isAttachOnly: testCase.isAttachOnly,
        url: testCase.url,
        apiVersion: 2,
        readServerInfo: vi.fn(async () => ({
          managedProcess: !testCase.isAttachOnly,
          cliVersion: version,
          health: { healthy: true, version },
        })),
      });
      await createSidebarProviderInstance({ server });
      const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
      const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
      const itemIndex = createStatusBarItem.mock.calls.findIndex(
        ([id]) => id === 'varro.opencode-version'
      );
      const item = createStatusBarItem.mock.results[itemIndex]?.value;
      statusHandler?.({ state: 'running', url: server.url });
      await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${version}`));
      expect(item.tooltip).toContain(`OpenCode Server: ${version}\nServer port: ${testCase.port}`);

      statusHandler?.({ state: 'starting' });
      server.url = 'http://127.0.0.1:54322';
      statusHandler?.({ state: 'running', url: server.url });
      await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${version}`));
      expect(item.tooltip).toContain('Server port: 54322');
      expect(item.tooltip).not.toContain(`Server port: ${testCase.port}\n`);
    }
  );

  it('marks the OpenCode version when the running server trails the installed CLI', async () => {
    const server = createServer({
      readServerInfo: vi.fn(async () => ({
        managedProcess: true,
        cliVersion: readMaximumTestedOpenCodeVersion(),
        health: { healthy: true, version: '1.16.0' },
      })),
    });
    await createSidebarProviderInstance({ server });
    const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
    statusHandler?.({ state: 'running', url: 'http://127.0.0.1:4096' });

    const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
    const itemIndex = createStatusBarItem.mock.calls.findIndex(
      ([id]) => id === 'varro.opencode-version'
    );
    const item = createStatusBarItem.mock.results[itemIndex]?.value;
    await vi.waitFor(() => expect(item.text).toBe('$(robot) OpenCode 1.16.0*'));
    expect(item.tooltip).toBe(
      `OpenCode CLI: ${readMaximumTestedOpenCodeVersion()}\nOpenCode Server: 1.16.0\nServer port: 4096\n\nCLI updated to OpenCode ${readMaximumTestedOpenCodeVersion()}; server 1.16.0 is stale.\n\nVarro extension: 0.26.4\nVerified w/ OpenCode ${readMaximumTestedOpenCodeVersion()}`
    );
  });

  it.each([
    { previousVersion: '1.18.31', updatedVersion: '1.19.0' },
    { previousVersion: '1.19.0', updatedVersion: '1.19.1' },
  ])(
    'refreshes the displayed OpenCode version after a background update restart to $updatedVersion',
    async ({ previousVersion, updatedVersion }) => {
      const extensionManifest = await import('./extension-manifest');
      const testedVersion = vi
        .spyOn(extensionManifest, 'readMaximumTestedOpenCodeVersion')
        .mockReturnValue(updatedVersion);
      onTestFinished(() => testedVersion.mockRestore());
      const readServerInfo = vi
        .fn()
        .mockResolvedValueOnce({
          managedProcess: true,
          cliVersion: previousVersion,
          health: { healthy: true, version: previousVersion },
        })
        .mockResolvedValueOnce({
          managedProcess: true,
          cliVersion: updatedVersion,
          health: { healthy: true, version: updatedVersion },
        });
      const server = createServer({ readServerInfo });
      await createSidebarProviderInstance({ server });
      const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
      const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
      const itemIndex = createStatusBarItem.mock.calls.findIndex(
        ([id]) => id === 'varro.opencode-version'
      );
      const item = createStatusBarItem.mock.results[itemIndex]?.value;

      statusHandler?.({ state: 'running', url: 'http://127.0.0.1:4096' });
      await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${previousVersion}*`));

      statusHandler?.({ state: 'starting' });
      statusHandler?.({ state: 'running', url: 'http://127.0.0.1:4096' });
      await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${updatedVersion}`));
      expect(readServerInfo).toHaveBeenCalledTimes(2);
    }
  );

  it('shows no guessed version during startup and ignores version reads from before a restart', async () => {
    const v2Version = readMaximumTestedOpenCodeVersion(undefined, 2);
    let resolveOldInfo!: (info: {
      cliVersion: string;
      health: { healthy: boolean; version: string };
    }) => void;
    const oldInfo = new Promise<{
      cliVersion: string;
      health: { healthy: boolean; version: string };
    }>((resolve) => {
      resolveOldInfo = resolve;
    });
    const readServerInfo = vi
      .fn()
      .mockReturnValueOnce(oldInfo)
      .mockResolvedValueOnce({
        cliVersion: v2Version,
        health: { healthy: true, version: v2Version },
      });
    const server = createServer({ readServerInfo });
    await createSidebarProviderInstance({ server });
    const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
    const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
    const itemIndex = createStatusBarItem.mock.calls.findIndex(
      ([id]) => id === 'varro.opencode-version'
    );
    const item = createStatusBarItem.mock.results[itemIndex]?.value;
    expect(item.text).toBe('$(robot) OpenCode');
    statusHandler?.({ state: 'running', url: 'http://127.0.0.1:4096' });
    statusHandler?.({ state: 'stopped' });
    expect(item.text).toBe('$(robot) OpenCode');
    statusHandler?.({ state: 'running', url: 'http://127.0.0.1:4096' });
    await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${v2Version}`));
    resolveOldInfo({ cliVersion: '1.18.31', health: { healthy: true, version: '1.18.31' } });
    await oldInfo;
    await Promise.resolve();
    expect(item.text).toBe(`$(robot) OpenCode ${v2Version}`);
    expect(item.tooltip).not.toContain('1.18.31');
  });

  it('describes an uninstalled patch update without repeating the verified version', async () => {
    await getVscodeMock().workspace.getConfiguration().update('server.autoUpdate', false);
    const maximumTestedVersion = '1.19.1';
    const installedVersion = '1.19.0';
    const extensionManifest = await import('./extension-manifest');
    const testedVersion = vi
      .spyOn(extensionManifest, 'readMaximumTestedOpenCodeVersion')
      .mockReturnValue(maximumTestedVersion);
    onTestFinished(() => testedVersion.mockRestore());
    const server = createServer({
      readServerInfo: vi.fn(async () => ({
        managedProcess: true,
        cliVersion: installedVersion,
        health: { healthy: true, version: installedVersion },
      })),
    });
    await createSidebarProviderInstance({ server });
    const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
    statusHandler?.({ state: 'running', url: 'http://127.0.0.1:4096' });

    const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
    const itemIndex = createStatusBarItem.mock.calls.findIndex(
      ([id]) => id === 'varro.opencode-version'
    );
    const item = createStatusBarItem.mock.results[itemIndex]?.value;
    await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${installedVersion}*`));
    expect(item.tooltip).toBe(
      `OpenCode CLI: ${installedVersion}\nOpenCode Server: ${installedVersion}\nServer port: 4096\n\nNew CLI version: OpenCode ${maximumTestedVersion} is not installed yet.\nAuto-updates are off.\n\nVarro extension: 0.26.4`
    );
  });

  it('does not show a status item for an ordinary completion', async () => {
    const { provider } = await createSidebarProviderInstance();
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Completed work', directory: '/repo' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    expect(provider.getStatusBarClickAction()).toBe('focus');
  });

  it('shows plan-ready sessions as actionable status items', async () => {
    const { provider } = await createSidebarProviderInstance();
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: {
        info: { id: 'session-1', title: 'Review plan', directory: '/repo', agent: 'plan' },
      },
    });
    providerState.sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    expect(provider.getStatusBarClickAction()).toBe('attention');
    const statusItem = getVscodeMock().window.createStatusBarItem.mock.results.find(
      (result) => result.value.name === 'Varro Attention'
    )?.value;
    expect(statusItem?.text).toBe('$(bell-dot) Varro: 1 needs attention');
    expect(statusItem?.tooltip).toContain('Review plan: Plan ready');
  });

  it('shows failed sessions as actionable status items', async () => {
    const { provider } = await createSidebarProviderInstance();
    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
    };
    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Failed work', directory: '/repo' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'session.error',
      properties: { sessionID: 'session-1', error: { name: 'UnknownError' } },
    });

    expect(provider.getStatusBarClickAction()).toBe('attention');
    const statusItem = getVscodeMock().window.createStatusBarItem.mock.results.find(
      (result) => result.value.name === 'Varro Attention'
    )?.value;
    expect(statusItem?.tooltip).toContain('Failed work: Error');
  });
});
