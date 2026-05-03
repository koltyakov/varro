import { describe, expect, it } from 'vitest';
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
    const statusBarItem = getVscodeMock().window.createStatusBarItem.mock.results.at(-1)?.value;
    if (!statusBarItem) throw new Error('Expected status bar item to exist');

    statusBarItem.show.mockClear();
    statusBarItem.hide.mockClear();

    const providerState = provider as unknown as {
      sessionState: { handleServerEvent(event: unknown): void };
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
    expect(statusBarItem.text).toBe('');

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

    expect(statusBarItem.show).toHaveBeenCalled();
    expect(statusBarItem.text).toBe('$(bell-dot) Varro: 1 waiting');
    expect(statusBarItem.tooltip).toContain('Current repo: Run Bash command');
  });
});
