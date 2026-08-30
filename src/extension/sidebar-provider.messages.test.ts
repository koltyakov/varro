/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These tests call private message handlers with protocol-shaped fixtures and untyped persistence values. */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  attachTestView,
  createContextProvider,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

describe('SidebarProvider session message responses', () => {
  it('blocks automation when a server-confirmed permission mode is not durable', async () => {
    const workspaceState = {
      get: vi.fn(() => undefined),
      update: vi.fn((key: string) =>
        key === 'varro.sessionPermissionModes'
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve()
      ),
    };
    const server = createServer({
      request: vi.fn(async () => ({ id: 'session-1', directory: '/repo' })),
    });
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(provider);

    await expect(
      (
        provider as unknown as {
          updateConfirmedPermissionMode(sessionId: string, mode: 'full'): Promise<void>;
        }
      ).updateConfirmedPermissionMode('session-1', 'full')
    ).rejects.toThrow('Permission mode was not saved');

    expect(posted).toContainEqual({
      type: 'permission-modes/sync',
      payload: {
        modes: { 'session-1': 'default' },
        recoveringSessionIds: ['session-1'],
      },
    });
    expect(server.request).toHaveBeenCalledTimes(2);
  });

  it('resets a staged fallback remotely before publishing default after restart', async () => {
    const values = new Map<string, unknown>([
      ['varro.sessionPermissionModes', { 'session-1': 'full' }],
      ['varro.sessionPermissionModeFallbacks', ['session-1']],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
      update: vi.fn((key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      }),
    };
    let serverMode = 'full';
    let patchAttempts = 0;
    const server = createServer({
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/session?limit=1000000') {
          return [{ id: 'session-1', directory: '/repo' }];
        }
        if (method === 'PATCH' && path === '/session/session-1') {
          patchAttempts += 1;
          expect(serverMode).toBe('full');
          expect(body).toEqual({ permission: [] });
          if (patchAttempts === 1) throw new Error('server unavailable');
          serverMode = 'default';
          return { id: 'session-1', directory: '/repo' };
        }
        return undefined;
      }),
    });
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({
      type: 'permission-modes/sync',
      payload: {
        modes: { 'session-1': 'default' },
        recoveringSessionIds: ['session-1'],
      },
    });
    const internals = provider as unknown as {
      permissionModeFallbackReconciliation: Promise<void> | null;
      recoverPendingPermissionModeFallbacks(): Promise<void>;
    };
    await vi.waitFor(() => {
      expect(patchAttempts).toBe(1);
      expect(internals.permissionModeFallbackReconciliation).toBeNull();
    });

    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual(['session-1']);
    await internals.recoverPendingPermissionModeFallbacks();
    await vi.waitFor(() => expect(serverMode).toBe('default'));

    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual([]);
    expect(posted).toContainEqual({
      type: 'permission-modes/sync',
      payload: { modes: { 'session-1': 'default' } },
    });
  });

  it('persists a preconfigured mode without sending a second OpenCode rule update', async () => {
    const values = new Map<string, unknown>();
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
      update: vi.fn((key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      }),
    };
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(provider);

    await (
      provider as unknown as {
        persistPreconfiguredPermissionMode(
          sessionId: string,
          mode: 'full',
          directory: string
        ): Promise<void>;
      }
    ).persistPreconfiguredPermissionMode('fork-1', 'full', '/repo');

    expect(server.request).not.toHaveBeenCalled();
    expect(values.get('varro.sessionPermissionModes')).toEqual({ 'fork-1': 'full' });
    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual([]);
    expect(posted).toContainEqual({
      type: 'permission-modes/sync',
      payload: { modes: { 'fork-1': 'full' } },
    });
  });

  it('ignores a stale preconfigured acknowledgement behind a newer mode update', async () => {
    const values = new Map<string, unknown>();
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
      update: vi.fn((key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      }),
    };
    let releasePatch!: () => void;
    const patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    const server = createServer({
      request: vi.fn(async (method: string, path: string) => {
        if (method === 'PATCH' && path === '/session/fork-1') {
          await patchPending;
          return { id: 'fork-1', directory: '/repo' };
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    });
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    attachTestView(provider);
    const internals = provider as unknown as {
      updateConfirmedPermissionMode(
        sessionId: string,
        mode: 'auto',
        directory: string
      ): Promise<void>;
      persistPreconfiguredPermissionMode(
        sessionId: string,
        mode: 'full',
        directory: string,
        ifAbsent: boolean
      ): Promise<void>;
    };

    const newerUpdate = internals.updateConfirmedPermissionMode('fork-1', 'auto', '/repo');
    await vi.waitFor(() => expect(server.request).toHaveBeenCalledOnce());
    const staleAcknowledgement = internals.persistPreconfiguredPermissionMode(
      'fork-1',
      'full',
      '/repo',
      true
    );
    releasePatch();
    await Promise.all([newerUpdate, staleAcknowledgement]);

    expect(values.get('varro.sessionPermissionModes')).toEqual({ 'fork-1': 'auto' });
    expect(server.request).toHaveBeenCalledOnce();
  });

  it('clears fallback IDs only after every session catalog is authoritative', async () => {
    const values = new Map<string, unknown>([
      ['varro.sessionPermissionModes', { missing: 'full' }],
      ['varro.sessionPermissionModeFallbacks', ['missing']],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
      update: vi.fn((key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      }),
    };
    let catalogState: 'unavailable' | 'malformed' | 'complete' = 'unavailable';
    const server = createServer({
      request: vi.fn(async (method: string, path: string) => {
        if (method === 'GET' && path === '/session?limit=1000000') {
          if (catalogState === 'unavailable') throw new Error('catalog unavailable');
          if (catalogState === 'malformed') return [{ id: 'possibly-missing' }];
          return [];
        }
        return undefined;
      }),
    });
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    attachTestView(provider);
    const internals = provider as unknown as {
      recoverPendingPermissionModeFallbacks(): Promise<void>;
    };

    await internals.recoverPendingPermissionModeFallbacks();
    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual(['missing']);
    expect(values.get('varro.sessionPermissionModes')).toEqual({ missing: 'full' });

    catalogState = 'malformed';
    await internals.recoverPendingPermissionModeFallbacks();
    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual(['missing']);
    expect(values.get('varro.sessionPermissionModes')).toEqual({ missing: 'full' });

    catalogState = 'complete';
    await internals.recoverPendingPermissionModeFallbacks();

    expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual([]);
    expect(values.get('varro.sessionPermissionModes')).toEqual({});
  });

  it.each([
    {
      name: 'Project',
      scope: 'project',
      scopeKey: 'project:project-1',
      catalogPath: '/session?limit=1000000&scope=project',
      directory: '/worktrees/feature',
    },
    {
      name: 'Nested',
      scope: 'descendants',
      scopeKey: 'directory:/repo',
      catalogPath: '/experimental/session?limit=1000000',
      directory: '/repo/packages/app',
    },
  ] as const)(
    'recovers an extant $name session from its resolved catalog scope',
    async ({ scope, scopeKey, catalogPath, directory }) => {
      const values = new Map<string, unknown>([
        ['varro.sessionPermissionModes', { extant: 'full' }],
        ['varro.sessionPermissionModeFallbacks', ['extant']],
        ['varro.sessionHistoryScopes', { [scopeKey]: scope }],
        ['varro.sessionHistoryScopeProjects', { '/repo': scopeKey }],
      ]);
      const workspaceState = {
        get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
        update: vi.fn((key: string, value: unknown) => {
          values.set(key, value);
          return Promise.resolve();
        }),
      };
      const server = createServer({
        request: vi.fn(async (method: string, path: string, body?: unknown, options?: unknown) => {
          if (path === '/project/current') {
            return { id: 'project-1', worktree: '/repo', vcs: 'git' };
          }
          if (method === 'GET' && path === catalogPath) {
            return [{ id: 'extant', projectID: 'project-1', directory }];
          }
          if (method === 'PATCH' && path === '/session/extant') {
            expect(body).toEqual({ permission: [] });
            expect(options).toEqual({ directory });
            return { id: 'extant', directory };
          }
          throw new Error(`Unexpected request: ${method} ${path}`);
        }),
      });
      const { provider } = await createSidebarProviderInstance({
        server,
        workspaceState: workspaceState as never,
      });
      attachTestView(provider);
      const internals = provider as unknown as {
        recoverPendingPermissionModeFallbacks(): Promise<void>;
      };

      await internals.recoverPendingPermissionModeFallbacks();

      expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual([]);
      expect(values.get('varro.sessionPermissionModes')).toEqual({ extant: 'default' });
      expect(server.request).toHaveBeenCalledWith(
        'PATCH',
        '/session/extant',
        { permission: [] },
        { directory }
      );
    }
  );

  it('backs automatic fallback recovery off exponentially and resets after success', async () => {
    vi.useFakeTimers();
    try {
      const values = new Map<string, unknown>([
        ['varro.sessionPermissionModes', { missing: 'full' }],
        ['varro.sessionPermissionModeFallbacks', ['missing']],
      ]);
      const workspaceState = {
        get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
        update: vi.fn((key: string, value: unknown) => {
          values.set(key, value);
          return Promise.resolve();
        }),
      };
      let catalogAvailable = false;
      const server = createServer({
        request: vi.fn(async (method: string, path: string) => {
          if (method === 'GET' && path === '/session?limit=1000000') {
            if (!catalogAvailable) throw new Error('catalog unavailable');
            return [];
          }
          return undefined;
        }),
      });
      const { provider } = await createSidebarProviderInstance({
        server,
        workspaceState: workspaceState as never,
      });
      const internals = provider as unknown as {
        permissionModeFallbackReconciliation: Promise<void> | null;
        permissionModeFallbackRetryMs: number;
        permissionModeFallbackRetryTimer: ReturnType<typeof setTimeout> | null;
        schedulePermissionModeFallbackRecovery(): void;
      };

      internals.schedulePermissionModeFallbackRecovery();
      expect(internals.permissionModeFallbackRetryMs).toBe(10_000);

      await vi.advanceTimersByTimeAsync(5_000);
      await internals.permissionModeFallbackReconciliation;
      await Promise.resolve();

      expect(internals.permissionModeFallbackRetryMs).toBe(20_000);
      expect(internals.permissionModeFallbackRetryTimer).not.toBeNull();

      catalogAvailable = true;
      await vi.advanceTimersByTimeAsync(10_000);
      await internals.permissionModeFallbackReconciliation;
      await Promise.resolve();

      expect(internals.permissionModeFallbackRetryMs).toBe(5_000);
      expect(internals.permissionModeFallbackRetryTimer).toBeNull();
      expect(values.get('varro.sessionPermissionModeFallbacks')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('migrates sidebar permission modes without overwriting newer host state', async () => {
    const values = new Map<string, unknown>();
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => values.get(key) ?? fallback),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
        return Promise.resolve();
      }),
    };
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({
      server,
      workspaceState: workspaceState as never,
    });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'permission-mode/update',
      payload: { sessionId: 'session-1', mode: 'full' },
    });
    await provider.handleMessage({
      type: 'permission-modes/migrate',
      payload: { modes: { 'session-1': 'auto', 'session-legacy': 'edits' } },
    });

    expect(values.get('varro.sessionPermissionModes')).toEqual({
      'session-1': 'full',
      'session-legacy': 'edits',
    });
    expect(posted).toContainEqual({
      type: 'permission-modes/sync',
      payload: { modes: { 'session-1': 'full', 'session-legacy': 'edits' } },
    });
    expect(server.request).not.toHaveBeenCalled();
  });

  it('posts pending deltas before a canonical message API response', async () => {
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/session-1?directory=%2Frepo'
          ? { id: 'session-1', directory: '/repo' }
          : []
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const eventHandler = server.on.mock.calls.find(([event]) => event === 'event')?.[1];

    eventHandler?.({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'late',
      },
    });
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/session/session-1/message' },
    });

    expect(posted.map((message) => (message as { type: string }).type)).toEqual([
      'server/event',
      'api/response',
    ]);
  });

  it('filters malformed session message entries and parts from API responses', async () => {
    const messages = [
      {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1 },
          parentID: 'user-1',
          modelID: 'gpt-4.1',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: 'part-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'text',
            text: 'Hello',
          },
          {
            id: 'broken-part',
            sessionID: 'session-1',
            type: 'text',
            text: 'missing message id',
          },
        ],
      },
      {
        parts: [],
      },
      {
        info: {
          id: 'message-2',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 2 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4.1' },
        },
        parts: 'invalid-parts',
      },
    ];
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/session-1?directory=%2Frepo'
          ? { id: 'session-1', directory: '/repo' }
          : messages
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/session/session-1/message' },
    });

    expect(server.request.mock.calls).toEqual([
      ['GET', '/session/session-1?directory=%2Frepo', undefined, { directory: '/repo' }],
      [
        'GET',
        '/session/session-1/message',
        undefined,
        { directory: '/repo', signal: expect.any(AbortSignal) },
      ],
    ]);
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 1,
        data: [
          {
            info: expect.objectContaining({ id: 'message-1' }),
            parts: [
              expect.objectContaining({ id: 'part-1', messageID: 'message-1', type: 'text' }),
            ],
          },
          {
            info: expect.objectContaining({ id: 'message-2' }),
            parts: [],
          },
        ],
      },
    });
  });

  it('activates a Project catalog session through its authorized directory', async () => {
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
        if (method === 'GET' && path === '/session/project-session') {
          return { id: 'project-session', directory: '/worktrees/feature' };
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

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 301, method: 'GET', path: '/session' },
    });
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 302,
        method: 'POST',
        path: '/varro/session/project-session/activate',
        body: { directory: '/worktrees/feature' },
      },
    });

    expect(server.request).toHaveBeenCalledWith(
      'GET',
      '/session/project-session',
      undefined,
      expect.objectContaining({
        directory: '/worktrees/feature',
        signal: expect.any(AbortSignal),
      })
    );
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 302,
        data: { id: 'project-session', directory: '/worktrees/feature' },
      },
    });
  });
});

function runInTerminal(provider: object, command: string, title?: string) {
  return (
    provider as unknown as {
      runInTerminal: (command: string, title?: string) => Promise<void>;
    }
  ).runInTerminal(command, title);
}

function openSessionInTerminal(provider: object, sessionId: string) {
  return (
    provider as unknown as {
      openSessionInTerminal: (sessionId: string) => Promise<void>;
    }
  ).openSessionInTerminal(sessionId);
}

function openNewTerminalEditor(provider: object) {
  return (
    provider as unknown as {
      openNewTerminalEditor: () => void;
    }
  ).openNewTerminalEditor();
}

describe('SidebarProvider terminal commands', () => {
  it('opens the default shell in an editor tab at the workspace root', async () => {
    const { provider } = await createSidebarProviderInstance();

    openNewTerminalEditor(provider);

    expect(getVscodeMock().window.createTerminal).toHaveBeenCalledWith({
      cwd: '/repo',
      location: getVscodeMock().TerminalLocation.Editor,
    });
    expect(getVscodeMock().window.createTerminal.mock.results[0]?.value.show).toHaveBeenCalledWith(
      false
    );
  });

  it('launches session handoff with the configured OpenCode executable', async () => {
    const server = createServer({
      resolveCommand: vi.fn(() => '/Applications/OpenCode Tools/opencode'),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await openSessionInTerminal(provider, 'session-1');

    expect(getVscodeMock().window.createTerminal).toHaveBeenCalledWith({
      name: 'OpenCode Session',
      cwd: '/repo',
      shellPath: '/Applications/OpenCode Tools/opencode',
      shellArgs: ['--session', 'session-1'],
    });
    expect(getVscodeMock().window.createTerminal.mock.results[0]?.value.show).toHaveBeenCalledWith(
      false
    );
  });

  it('launches Windows command shims through the command interpreter', async () => {
    const originalPlatform = process.platform;
    const originalComSpec = process.env.ComSpec;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    try {
      const server = createServer({
        resolveCommand: vi.fn(() => 'C:\\Program Files\\OpenCode\\opencode.cmd'),
      });
      const { provider } = await createSidebarProviderInstance({ server });
      attachTestView(provider);

      await openSessionInTerminal(provider, 'session-1');

      expect(getVscodeMock().window.createTerminal).toHaveBeenCalledWith({
        name: 'OpenCode Session',
        cwd: '/repo',
        shellPath: 'C:\\Windows\\System32\\cmd.exe',
        shellArgs: [
          '/d',
          '/s',
          '/c',
          '"C:\\Program Files\\OpenCode\\opencode.cmd" --session session-1',
        ],
      });
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
      if (originalComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
    }
  });

  it('releases the binary before running an install or update command', async () => {
    // Windows cannot overwrite a running opencode.exe, so the one-click update
    // needs the same prerequisite as Varro's own upgrade path.
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await runInTerminal(provider, 'npm install -g opencode-ai@latest', 'OpenCode Update');
    expect(server.prepareForWindowsCliUpgrade).toHaveBeenCalledOnce();

    await runInTerminal(provider, 'npm i -g opencode-ai', 'OpenCode Install');
    expect(server.prepareForWindowsCliUpgrade).toHaveBeenCalledTimes(2);
  });

  it('keeps a Windows update reserved until its terminal closes', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const server = createServer();
      const { provider } = await createSidebarProviderInstance({ server });
      attachTestView(provider);

      await runInTerminal(provider, 'npm install -g opencode-ai@latest', 'OpenCode Update');

      const terminal = getVscodeMock().window.createTerminal.mock.results[0]?.value;
      const onDidCloseTerminal = getVscodeMock().window.onDidCloseTerminal as Mock<
        (listener: (terminal: object) => void) => { dispose(): void }
      >;
      const closeListener = onDidCloseTerminal.mock.calls[0]?.[0];
      expect(closeListener).toBeTypeOf('function');
      expect(server.finishWindowsCliUpgrade).not.toHaveBeenCalled();

      if (terminal) closeListener?.(terminal);

      expect(server.finishWindowsCliUpgrade).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('leaves the server alone for commands that do not touch the binary', async () => {
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await runInTerminal(provider, 'opencode auth login', 'OpenCode Auth');

    expect(server.prepareForWindowsCliUpgrade).not.toHaveBeenCalled();
  });

  it('does not open a terminal when the server cannot be stopped safely', async () => {
    const server = createServer({
      prepareForWindowsCliUpgrade: vi.fn(() => Promise.reject(new Error('active sessions'))),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await expect(
      runInTerminal(provider, 'npm install -g opencode-ai@latest', 'OpenCode Update')
    ).rejects.toThrow('active sessions');

    expect(getVscodeMock().window.createTerminal).not.toHaveBeenCalled();
  });
});
