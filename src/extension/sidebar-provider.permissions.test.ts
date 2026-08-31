/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These tests deliberately model malformed permission events and inspect controlled provider internals. */
import { describe, expect, it, vi } from 'vitest';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import {
  attachTestView,
  createContextProvider,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

describe('SidebarProvider permission replay', () => {
  it('replays pending permission requests after the webview becomes ready', async () => {
    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        request: undefined as never,
      }),
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
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    ];

    providerState.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', directory: '/repo' } },
    });
    providerState.sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        title: 'Run Bash command',
        tool: { messageID: 'msg-1', callID: 'call-1' },
      },
    });

    await provider.handleMessage({ type: 'ready' });

    expect(posted).toContainEqual({
      type: 'server/event',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    });
  });

  it('clears resolved embedded permission requests before replay on ready', async () => {
    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        request: undefined as never,
      }),
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
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      },
    ];

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
        properties: {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          title: 'Run Bash command',
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
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
    expect(openCodeStatusBarItem.text).toBe(
      `$(robot) OpenCode ${readMaximumTestedOpenCodeVersion()}`
    );
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

  it('accepts an automatic reply with a known session when host pending state is missing', async () => {
    const server = createServer({ request: vi.fn(() => Promise.resolve(true)) });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const lease = posted
      .filter(
        (
          message
        ): message is { type: 'permission-automation/update'; payload: { lease: number } } =>
          (message as { type?: string }).type === 'permission-automation/update'
      )
      .at(-1)?.payload.lease;
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
    const lease = posted
      .filter(
        (
          message
        ): message is { type: 'permission-automation/update'; payload: { lease: number } } =>
          (message as { type?: string }).type === 'permission-automation/update'
      )
      .at(-1)?.payload.lease;
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
    const lease = posted
      .filter(
        (
          message
        ): message is { type: 'permission-automation/update'; payload: { lease: number } } =>
          (message as { type?: string }).type === 'permission-automation/update'
      )
      .at(-1)?.payload.lease;
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
    const lease = posted
      .filter(
        (
          message
        ): message is { type: 'permission-automation/update'; payload: { lease: number } } =>
          (message as { type?: string }).type === 'permission-automation/update'
      )
      .at(-1)?.payload.lease;
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
      `OpenCode CLI: ${readMaximumTestedOpenCodeVersion()}\nOpenCode Server: 1.16.0\n\nCLI updated to OpenCode ${readMaximumTestedOpenCodeVersion()}; server 1.16.0 is stale.\n\nVarro extension: 0.26.4\nVerified w/ OpenCode ${readMaximumTestedOpenCodeVersion()}`
    );
  });

  it('refreshes the displayed OpenCode version after a background update restart', async () => {
    const updatedVersion = readMaximumTestedOpenCodeVersion();
    const [major, minor, patch] = updatedVersion.split('.').map(Number);
    const previousVersion = `${major}.${minor}.${Math.max(0, (patch ?? 1) - 1)}`;
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
  });

  it('describes an uninstalled patch update without repeating the verified version', async () => {
    await getVscodeMock().workspace.getConfiguration().update('server.autoUpdate', false);
    const maximumTestedVersion = readMaximumTestedOpenCodeVersion();
    const [major, minor, patch] = maximumTestedVersion.split('.').map(Number);
    const installedVersion = `${major}.${minor}.${Math.max(0, (patch ?? 1) - 1)}`;
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
      `OpenCode CLI: ${installedVersion}\nOpenCode Server: ${installedVersion}\n\nNew CLI version: OpenCode ${maximumTestedVersion} is not installed yet.\nAuto-updates are off.\n\nVarro extension: 0.26.4`
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
