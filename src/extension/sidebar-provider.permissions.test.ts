/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These tests deliberately model malformed permission events and inspect controlled provider internals. */
import { describe, expect, it, vi } from 'vitest';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import {
  attachTestView,
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
    expect(statusBarItem.hide).toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect(item.text).toBe(`$(robot) OpenCode ${readMaximumTestedOpenCodeVersion()}*`)
    );
    expect(item.tooltip).toBe(
      `OpenCode CLI: ${readMaximumTestedOpenCodeVersion()}\nOpenCode Server: 1.16.0\n\nCLI updated to OpenCode ${readMaximumTestedOpenCodeVersion()}; server 1.16.0 is stale.\n\nVarro extension: 0.26.4\nVerified w/ OpenCode ${readMaximumTestedOpenCodeVersion()}`
    );
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
    await vi.waitFor(() => expect(item.text).toBe(`$(robot) OpenCode ${maximumTestedVersion}*`));
    expect(item.tooltip).toBe(
      `OpenCode CLI: ${installedVersion}\nOpenCode Server: ${installedVersion}\n\nNew CLI version: OpenCode ${maximumTestedVersion} is not installed yet.\nAuto-updates are off.\n\nVarro extension: 0.26.4`
    );
  });

  it('uses completed-session navigation for a completed status item', async () => {
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

    expect(provider.getStatusBarClickAction()).toBe('completed');
  });
});
