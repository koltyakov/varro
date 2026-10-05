/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Tests feed server events into the real provider-owned state manager without starting a server. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionStateManager } from './session-state-manager';
import type { TrayProject, TraySession } from './macos-tray';
import type { WebviewSession } from './webview-session';
import { AUTO_APPROVE_JUDGE_TIMEOUT_MS } from '../shared/protocol';
import type { ServerEvent } from '../shared/protocol';
import {
  attachTestView,
  createSidebarProviderInstance,
  createWorkspaceState,
  getVscodeMock,
} from './sidebar-provider.test-support';

async function createHarness(enabled = true) {
  const { NativeNotifications } = await import('./native-notifications');
  const show = vi.spyOn(NativeNotifications.prototype, 'show').mockResolvedValue();
  const sound = vi.spyOn(NativeNotifications.prototype, 'playSound').mockResolvedValue();
  const editorVisible = vi
    .spyOn(NativeNotifications.prototype, 'isEditorVisible')
    .mockResolvedValue(false);
  const vscode = getVscodeMock();
  vscode.window.state.focused = false;
  const config = vscode.workspace.getConfiguration('varro.notifications');
  await config.update('native', enabled);
  await config.update('sound', enabled);
  const values = new Map<string, unknown>();
  const globalState = createWorkspaceState();
  globalState.get.mockImplementation((key, fallback) => values.get(key) ?? fallback);
  globalState.update.mockImplementation(async (key, value) => {
    values.set(key, value);
  });
  const { provider, contextProvider } = await createSidebarProviderInstance({ globalState });
  const { view } = attachTestView(provider);
  await provider.handleMessage({ type: 'ready' });
  await provider.handleMessage({
    type: 'commands/state',
    payload: { canAbort: false, canSwitchSessions: false, model: null, sessionId: 'root' },
  });
  const state = (provider as unknown as { sessionState: SessionStateManager }).sessionState;
  state.handleServerEvent({
    type: 'session.updated',
    properties: { info: { id: 'root', title: 'Root conversation', directory: '/repo' } },
  });
  state.handleServerEvent({
    type: 'session.updated',
    properties: { info: { id: 'child', parentID: 'root', directory: '/repo' } },
  });
  vi.useFakeTimers();
  const traySnapshot = () =>
    (provider as unknown as { traySessions(): TraySession[] }).traySessions();
  const trayProjects = () =>
    (provider as unknown as { trayProjects(): TrayProject[] }).trayProjects();
  return {
    provider,
    contextProvider,
    state,
    view,
    show,
    sound,
    editorVisible,
    vscode,
    traySnapshot,
    trayProjects,
    globalState,
  };
}

describe('SidebarProvider desktop notifications', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    getVscodeMock().env.remoteName = undefined;
    getVscodeMock().workspace.workspaceFile = undefined;
  });

  it.each(['completed', 'plan-ready'] as const)(
    'removes %s tray rows when the webview marks the chat read',
    async (kind) => {
      const test = await createHarness();
      try {
        const payload = { sessionId: 'root', directory: '/repo', kind, markerAt: Date.now() };
        await test.provider.handleMessage({
          type: 'session-unread-state/update',
          payload: { ...payload, unread: true },
        });
        expect(test.traySnapshot()).toEqual([expect.objectContaining({ status: kind })]);
        await test.provider.handleMessage({
          type: 'session-unread-state/update',
          payload: { ...payload, unread: false },
        });
        expect(test.traySnapshot()).toEqual([]);
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it('keeps unread tray rows when a large session catalog evicts unrelated metadata', async () => {
    const test = await createHarness();
    try {
      const markerAt = Date.now();
      test.state.handleServerEvent({
        type: 'session.updated',
        properties: { info: { id: 'unread-plan', title: 'Unread plan', directory: '/repo' } },
      });
      test.state.setSessionUnreadState('root', 'completed', true, '/repo', markerAt);
      test.state.setSessionUnreadState('unread-plan', 'plan-ready', true, '/repo', markerAt);
      const unread = test.traySnapshot();
      expect(unread).toHaveLength(2);

      const loadCatalog = (prefix: string) => {
        for (let index = 0; index < 300; index += 1) {
          test.state.handleServerEvent({
            type: 'session.updated',
            properties: {
              info: { id: `${prefix}-${index}`, title: `Old chat ${index}`, directory: '/repo' },
            },
          });
        }
      };
      loadCatalog('history');
      expect(test.state.completed.size).toBe(2);
      expect(test.traySnapshot()).toEqual(unread);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(test.traySnapshot()).toEqual(unread);

      for (const sessionId of ['root', 'unread-plan']) {
        await test.provider.handleMessage({
          type: 'session-read-state/update',
          payload: { sessionId, seenAt: markerAt },
        });
      }
      expect(test.traySnapshot()).toEqual([]);
      loadCatalog('later');
      expect(test.state.directoryFor('root')).toBeUndefined();
      expect(test.state.directoryFor('unread-plan')).toBeUndefined();
    } finally {
      await test.provider.dispose();
    }
  });

  it.each(['completed', 'plan-ready'] as const)(
    'keeps unread %s in the tray through focus, visibility, and completed-list navigation',
    async (kind) => {
      const test = await createHarness();
      try {
        const markerAt = Date.now();
        const payload = { sessionId: 'root', directory: '/repo', kind, markerAt, unread: true };
        await test.provider.handleMessage({ type: 'session-unread-state/update', payload });
        const unread = test.traySnapshot();
        expect(unread).toEqual([expect.objectContaining({ status: kind })]);

        // The window can show a different chat or the session picker when it gains focus.
        await test.provider.handleMessage({
          type: 'commands/state',
          payload: { canAbort: false, canSwitchSessions: true, model: null, sessionId: 'other' },
        });
        test.vscode.window.state.focused = true;
        await test.provider.handleMessage({ type: 'webview/focus', payload: { focused: true } });
        const webviewSession = (test.provider as unknown as { webviewSession: WebviewSession })
          .webviewSession;
        webviewSession.handleVisible();
        await vi.advanceTimersByTimeAsync(300);
        expect(test.traySnapshot()).toEqual(unread);

        test.provider.openCompletedSessions();
        expect(test.traySnapshot()).toEqual(unread);
        // Repeated boot/unread events must agree with the existing indicator.
        webviewSession.handleVisible();
        await test.provider.handleMessage({ type: 'session-unread-state/update', payload });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(test.traySnapshot()).toEqual(unread);

        await test.provider.handleMessage({
          type: 'session-read-state/update',
          payload: { sessionId: 'other', seenAt: markerAt },
        });
        expect(test.traySnapshot()).toEqual(unread);
        await test.provider.handleMessage({
          type: 'session-read-state/update',
          payload: { sessionId: 'root', seenAt: markerAt },
        });
        expect(test.traySnapshot()).toEqual([]);
        await test.provider.handleMessage({ type: 'session-unread-state/update', payload });
        expect(test.traySnapshot()).toEqual([]);
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it.each(['completed', 'plan-ready'] as const)(
    'acknowledges %s directly from VS Code read timestamps and preserves newer turns',
    async (kind) => {
      const test = await createHarness();
      try {
        const markerAt = Date.now();
        test.state.setSessionUnreadState('root', kind, true, '/repo', markerAt);
        expect(test.traySnapshot()).toHaveLength(1);
        await test.provider.handleMessage({
          type: 'session-read-state/update',
          payload: { sessionId: 'root', seenAt: markerAt },
        });
        expect(test.traySnapshot()).toEqual([]);
        // A hidden or stale webview must not restore the same response.
        test.state.setSessionUnreadState('root', kind, true, '/repo', markerAt);
        expect(test.traySnapshot()).toEqual([]);
        test.state.setSessionUnreadState('root', kind, true, '/repo', markerAt + 1);
        expect(test.traySnapshot()).toHaveLength(1);
        await test.provider.handleMessage({
          type: 'session-read-state/update',
          payload: { sessionId: 'root', seenAt: markerAt },
        });
        expect(test.traySnapshot()).toHaveLength(1);
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it.each(['completed', 'plan-ready'] as const)(
    'excludes already-read %s history when the tray connects after VS Code restored its read state',
    async (kind) => {
      const test = await createHarness();
      try {
        const markerAt = Date.now();
        await test.globalState.update('varro.sessionReadState', { root: markerAt });
        // Session state can hydrate from events before a webview publishes unread indicators.
        test.state.setSessionUnreadState('root', kind, true, '/repo', markerAt);
        expect(test.state.completed.has('root')).toBe(true);
        expect(test.traySnapshot()).toEqual([]);
        test.state.setSessionUnreadState('root', kind, true, '/repo', markerAt + 1);
        expect(test.traySnapshot()).toHaveLength(1);
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it('uses the workspace folder display name as the project name', async () => {
    const test = await createHarness();
    try {
      test.contextProvider.context.workspaceFolders = [{ name: 'Friendly project', path: '/repo' }];
      test.vscode.workspace.workspaceFolders = [
        { name: 'Friendly project', uri: { fsPath: '/repo' }, index: 0 },
      ];
      test.state.markSessionBusy('root');
      test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID: 'root' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(test.show).toHaveBeenCalledWith({
        projectName: 'Project: Friendly project',
        chatTitle: 'Root conversation',
        message: 'Response ready',
        sessionID: 'root',
      });
    } finally {
      await test.provider.dispose();
    }
  });

  it('lists all open roots with stable folder identities even when a saved workspace has no activity', async () => {
    const test = await createHarness();
    try {
      expect(test.trayProjects()).toEqual([
        { id: '/repo', name: 'repo', url: 'vscode://file/repo' },
      ]);
      test.vscode.workspace.workspaceFile = {
        scheme: 'file',
        path: '/work/Projects.code-workspace',
      };
      test.contextProvider.context.workspaceFolders = [
        { name: 'Repo', path: '/repo' },
        { name: 'Idle project', path: '/other' },
      ];
      test.vscode.workspace.workspaceFolders = [
        { name: 'Repo', uri: { fsPath: '/repo' }, index: 0 },
        { name: 'Idle project', uri: { fsPath: '/other' }, index: 1 },
      ];
      expect(test.traySnapshot()).toEqual([]);
      expect(test.trayProjects()).toEqual([
        { id: '/repo', name: 'Repo', url: 'vscode://file/work/Projects.code-workspace' },
        { id: '/other', name: 'Idle project', url: 'vscode://file/work/Projects.code-workspace' },
      ]);
      test.state.markSessionBusy('root');
      expect(test.traySnapshot()[0]).toMatchObject({
        projectID: '/repo',
        project: 'Repo',
        projectUrl: 'vscode://file/work/Projects.code-workspace',
      });
      test.contextProvider.context.workspaceFolders = [{ name: 'Renamed project', path: '/other' }];
      test.vscode.workspace.workspaceFolders = [
        { name: 'Renamed project', uri: { fsPath: '/other' }, index: 0 },
      ];
      expect(test.trayProjects()).toEqual([
        {
          id: '/other',
          name: 'Renamed project',
          url: 'vscode://file/work/Projects.code-workspace',
        },
      ]);
    } finally {
      await test.provider.dispose();
    }
  });

  it('keeps a restored chat running in the tray when the webview is working but host busy events are missing', async () => {
    const test = await createHarness();
    try {
      expect(test.state.busy.size).toBe(0);
      await test.provider.handleMessage({
        type: 'commands/state',
        payload: { canAbort: true, canSwitchSessions: true, model: null, sessionId: 'root' },
      });
      expect(test.traySnapshot()).toEqual([expect.objectContaining({ status: 'running' })]);
      const markerAt = Date.now();
      test.state.setSessionUnreadState('root', 'completed', true, '/repo', markerAt);
      expect(test.traySnapshot()).toEqual([expect.objectContaining({ status: 'running' })]);
      await test.provider.handleMessage({
        type: 'commands/state',
        payload: { canAbort: false, canSwitchSessions: true, model: null, sessionId: 'root' },
      });
      expect(test.traySnapshot()).toEqual([expect.objectContaining({ status: 'completed' })]);
      await test.provider.handleMessage({
        type: 'session-read-state/update',
        payload: { sessionId: 'root', seenAt: markerAt },
      });
      expect(test.traySnapshot()).toEqual([]);
    } finally {
      await test.provider.dispose();
    }
  });

  it('does not let a delayed timestamp-free seen event clear a newer unread completion', async () => {
    const test = await createHarness();
    try {
      const markerAt = Date.now();
      await test.provider.handleMessage({
        type: 'session-read-state/update',
        payload: { sessionId: 'root', seenAt: markerAt - 1 },
      });
      test.state.setSessionUnreadState('root', 'completed', true, '/repo', markerAt);
      await test.provider.handleMessage({ type: 'session/seen', payload: { sessionId: 'root' } });
      expect(test.traySnapshot()).toEqual([
        expect.objectContaining({ status: 'completed', updatedAt: markerAt }),
      ]);
      await test.provider.handleMessage({
        type: 'session-read-state/update',
        payload: { sessionId: 'root', seenAt: markerAt },
      });
      expect(test.traySnapshot()).toEqual([]);
    } finally {
      await test.provider.dispose();
    }
  });

  it('refreshes projects from VS Code while the chat context still contains an older folder list', async () => {
    const test = await createHarness();
    try {
      test.vscode.workspace.workspaceFolders = [
        { name: 'Repo', uri: { fsPath: '/repo' }, index: 0 },
        { name: 'Added', uri: { fsPath: '/added' }, index: 1 },
      ];
      expect(test.trayProjects().map((project) => project.id)).toEqual(['/repo', '/added']);
      test.vscode.workspace.workspaceFolders = [];
      expect(test.trayProjects()).toEqual([]);
    } finally {
      await test.provider.dispose();
    }
  });

  it('keeps unread attention in a focused editor and clears errors only when seen', async () => {
    const test = await createHarness();
    try {
      test.vscode.window.state.focused = true;
      const failedAt = Date.now();
      const fail = (completed: number) =>
        test.state.handleServerEvent({
          type: 'message.updated',
          properties: {
            info: {
              id: `failed-${completed}`,
              sessionID: 'root',
              role: 'assistant',
              time: { created: completed - 1, completed },
              error: { name: 'UnknownError', data: { message: 'Failure' } },
            },
          },
        });
      fail(failedAt);
      expect(test.traySnapshot()).toEqual([
        expect.objectContaining({ status: 'error', updatedAt: failedAt }),
      ]);
      await test.provider.handleMessage({
        type: 'session-read-state/update',
        payload: { sessionId: 'root', seenAt: failedAt },
      });
      expect(test.traySnapshot()).toEqual([]);
      fail(failedAt);
      expect(test.traySnapshot()).toEqual([]);
      fail(failedAt + 1);
      expect(test.traySnapshot()).toEqual([
        expect.objectContaining({ status: 'error', updatedAt: failedAt + 1 }),
      ]);
      test.state.handleServerEvent({
        type: 'permission.asked',
        properties: { id: 'pending', sessionID: 'child', permission: 'edit', patterns: ['*'] },
      });
      test.state.revealPermission('pending');
      await test.provider.handleMessage({
        type: 'session-read-state/update',
        payload: { sessionId: 'root', seenAt: failedAt + 2 },
      });
      expect(test.traySnapshot()[0]?.status).toBe('permission');
      test.state.handleServerEvent({
        type: 'permission.replied',
        properties: { requestID: 'pending', sessionID: 'child' },
      });
      expect(test.traySnapshot()).toEqual([]);
      test.state.setSessionUnreadState('root', 'plan-ready', true, '/repo', failedAt + 3);
      expect(test.traySnapshot()[0]?.status).toBe('plan-ready');
    } finally {
      await test.provider.dispose();
    }
  });

  it('targets the project window through the built-in file route', async () => {
    const test = await createHarness();
    try {
      const provider = test.provider as unknown as {
        notificationWindowUrl(): Promise<string>;
      };
      const url = new URL(await provider.notificationWindowUrl());
      expect(url.protocol).toBe('vscode:');
      expect(url.hostname).toBe('file');
      expect(url.pathname).toBe('/repo');
      expect(url.search).toBe('');
      expect(test.vscode.env.asExternalUri).not.toHaveBeenCalled();
    } finally {
      await test.provider.dispose();
    }
  });

  it('targets the saved multi-root workspace instead of a session folder', async () => {
    const test = await createHarness();
    try {
      test.vscode.workspace.workspaceFile = {
        scheme: 'file',
        path: '/work/Projects.code-workspace',
      };
      const provider = test.provider as unknown as { notificationWindowUrl(): Promise<string> };
      expect(await provider.notificationWindowUrl()).toBe(
        'vscode://file/work/Projects.code-workspace'
      );
    } finally {
      await test.provider.dispose();
    }
  });

  it('opens a notification chat in the sidebar and ignores unrelated or out-of-workspace links', async () => {
    const test = await createHarness();
    try {
      const open = vi.spyOn(test.provider, 'openSessionInSidebar').mockResolvedValue();
      const handler = test.vscode.window.registerUriHandler.mock.calls.at(-1)?.[0];
      if (!handler) throw new Error('Missing notification URI handler');
      const uri = {
        authority: 'koltyakov.varro',
        path: '/notification',
        query: 'session=child&root=root&directory=%2Frepo',
      };
      await handler.handleUri(uri as never);
      expect(open).toHaveBeenCalledExactlyOnceWith('child', '/repo');
      await handler.handleUri({ ...uri, path: '/another-action' } as never);
      await handler.handleUri({ ...uri, query: 'session=%00bad' } as never);
      expect(open).toHaveBeenCalledOnce();
      test.contextProvider.getOpenWorkspaceRoot.mockReturnValue(null);
      await handler.handleUri(uri as never);
      expect(open).toHaveBeenCalledOnce();
      expect(test.vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('workspace folder is not open')
      );
    } finally {
      await test.provider.dispose();
    }
  });

  it.each([
    { windowFocused: true, chatFocused: true, visible: true, editorVisible: true, notify: false },
    { windowFocused: true, chatFocused: false, visible: true, editorVisible: true, notify: false },
    { windowFocused: false, chatFocused: true, visible: true, editorVisible: false, notify: true },
    {
      windowFocused: false,
      chatFocused: false,
      visible: false,
      editorVisible: false,
      notify: true,
    },
    { windowFocused: true, chatFocused: true, visible: false, editorVisible: false, notify: false },
    { windowFocused: false, chatFocused: false, visible: true, editorVisible: true, notify: false },
    {
      windowFocused: false,
      chatFocused: false,
      visible: false,
      editorVisible: true,
      notify: false,
    },
  ])('uses editor visibility independently of chat focus: %o', async (scenario) => {
    const test = await createHarness();
    try {
      test.vscode.window.state.focused = scenario.windowFocused;
      test.editorVisible.mockResolvedValue(scenario.editorVisible);
      test.view.visible = scenario.visible;
      await test.provider.handleMessage({
        type: 'webview/focus',
        payload: { focused: scenario.chatFocused },
      });
      test.state.handleServerEvent({
        type: 'question.asked',
        properties: { id: 'question', sessionID: 'child', questions: [] },
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(test.show).toHaveBeenCalledTimes(Number(scenario.notify));
      expect(test.sound).toHaveBeenCalledTimes(Number(scenario.notify));
    } finally {
      await test.provider.dispose();
    }
  });

  it('keeps other sessions quiet while the VS Code window is focused', async () => {
    const test = await createHarness();
    try {
      test.vscode.window.state.focused = true;
      await test.provider.handleMessage({ type: 'webview/focus', payload: { focused: true } });
      test.state.handleServerEvent({
        type: 'question.asked',
        properties: { id: 'question', sessionID: 'other', questions: [] },
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(test.show).not.toHaveBeenCalled();
    } finally {
      await test.provider.dispose();
    }
  });

  it.each([
    { setting: 'permission', kind: 'permission' },
    { setting: 'question', kind: 'question' },
    { setting: 'completed', kind: 'completed' },
    { setting: 'planReady', kind: 'plan-ready' },
  ] as const)(
    'applies the $setting checkbox independently of OS banners',
    async ({ setting, kind }) => {
      const test = await createHarness();
      try {
        const sound = { permission: true, question: true, completed: true, planReady: true };
        sound[setting] = false;
        await test.vscode.workspace.getConfiguration('varro.notifications').update('sound', sound);
        if (kind === 'permission') {
          test.state.handleServerEvent({
            type: 'permission.asked',
            properties: { id: 'permission', sessionID: 'child', permission: 'bash' },
          });
          test.state.revealPermission('permission');
        } else if (kind === 'question') {
          test.state.handleServerEvent({
            type: 'question.asked',
            properties: { id: 'question', sessionID: 'child', questions: [] },
          });
        } else {
          if (kind === 'plan-ready') test.state.setSessionAgent('root', 'plan');
          test.state.markSessionBusy('root');
          test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID: 'root' } });
        }
        await vi.advanceTimersByTimeAsync(300);
        expect(test.sound).not.toHaveBeenCalled();
        expect(test.show).toHaveBeenCalledOnce();
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it('shows native delivery failures once while keeping sound working', async () => {
    const test = await createHarness();
    try {
      test.show.mockRejectedValue(new Error('Notification service unavailable.'));
      test.vscode.window.showWarningMessage.mockClear();
      for (const id of ['first', 'second']) {
        test.state.handleServerEvent({
          type: 'question.asked',
          properties: { id, sessionID: 'child', questions: [] },
        });
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(test.sound).toHaveBeenCalledTimes(2);
      expect(test.vscode.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(
        'Varro could not show a system notification: Notification service unavailable.',
        'Show Output'
      );
    } finally {
      await test.provider.dispose();
    }
  });

  it.each([
    { value: { question: true }, plays: true },
    { value: { permission: true }, plays: false },
    { value: {}, plays: false },
    { value: true, plays: true },
    { value: false, plays: false },
  ])('reads the single sound setting $value', async ({ value, plays }) => {
    const test = await createHarness();
    try {
      await test.vscode.workspace.getConfiguration('varro.notifications').update('sound', value);
      test.state.handleServerEvent({
        type: 'question.asked',
        properties: { id: 'question', sessionID: 'child', questions: [] },
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(test.sound).toHaveBeenCalledTimes(Number(plays));
      expect(test.show).toHaveBeenCalledOnce();
    } finally {
      await test.provider.dispose();
    }
  });

  it.each(['message.updated', 'session.next.step.ended'] as const)(
    'notifies for a completed reply through %s once the server is idle',
    async (type) => {
      const test = await createHarness();
      try {
        test.vscode.window.state.focused = false;
        await test.provider.handleMessage({ type: 'webview/focus', payload: { focused: true } });
        test.state.handleServerEvent({
          type: 'session.status',
          properties: { sessionID: 'root', status: { type: 'busy' } },
        });
        const terminal: ServerEvent =
          type === 'message.updated'
            ? {
                type,
                properties: {
                  info: {
                    id: 'reply',
                    sessionID: 'root',
                    role: 'assistant',
                    finish: 'stop',
                    time: { created: 1, completed: Date.now() },
                  },
                },
              }
            : {
                type,
                properties: {
                  sessionID: 'root',
                  assistantMessageID: 'reply',
                  finish: 'stop',
                  timestamp: Date.now(),
                },
              };
        test.state.handleServerEvent(terminal);
        await vi.advanceTimersByTimeAsync(300);
        expect(test.show).not.toHaveBeenCalled();
        test.state.handleServerEvent({
          type: 'session.status',
          properties: { sessionID: 'root', status: { type: 'idle' } },
        });
        test.state.handleServerEvent(terminal);
        test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID: 'root' } });
        await vi.advanceTimersByTimeAsync(300);
        expect(test.show).toHaveBeenCalledExactlyOnceWith({
          projectName: 'Project: repo',
          chatTitle: 'Root conversation',
          message: 'Response ready',
          sessionID: 'root',
        });
        expect(test.sound).toHaveBeenCalledOnce();

        // A second user turn must have its own completion notification.
        test.state.markSessionBusy('root');
        test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID: 'root' } });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(test.show).toHaveBeenCalledTimes(2);
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it('reports a completed plan as ready for review', async () => {
    const test = await createHarness();
    try {
      test.state.setSessionAgent('root', 'plan');
      test.state.markSessionBusy('root');
      test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID: 'root' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(test.show).toHaveBeenCalledExactlyOnceWith({
        projectName: 'Project: repo',
        chatTitle: 'Root conversation',
        message: 'Plan ready for review',
        sessionID: 'root',
      });
      expect(test.sound).toHaveBeenCalledOnce();
    } finally {
      await test.provider.dispose();
    }
  });

  it.each([
    'focused',
    'child',
    'cancelled',
    'failed',
    'continuing',
    'history',
    'disabled',
  ] as const)('does not emit a completion notification for %s', async (reason) => {
    const test = await createHarness(reason !== 'disabled');
    try {
      const sessionID = reason === 'child' ? 'child' : 'root';
      if (reason === 'focused') test.vscode.window.state.focused = true;
      if (reason === 'focused')
        await test.provider.handleMessage({ type: 'webview/focus', payload: { focused: true } });
      if (reason !== 'history') test.state.markSessionBusy(sessionID);
      if (reason === 'cancelled' || reason === 'failed') {
        test.state.handleServerEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: {
              name: reason === 'cancelled' ? 'MessageAbortedError' : 'UnknownError',
              data: { message: 'Stopped' },
            },
          },
        });
      } else if (reason === 'continuing') {
        test.state.handleServerEvent({
          type: 'session.next.step.ended',
          properties: { sessionID, finish: 'stop', executionContinues: true },
        });
      } else {
        test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID } });
      }
      if (reason === 'history')
        test.state.setSessionUnreadState(sessionID, 'completed', true, '/repo', 2);
      await vi.advanceTimersByTimeAsync(300);
      expect(test.show).not.toHaveBeenCalled();
      expect(test.sound).not.toHaveBeenCalled();
    } finally {
      await test.provider.dispose();
    }
  });

  it.each(['new-turn', 'pending-child', 'seen-in-background'] as const)(
    'rechecks completion after %s without relying on unread markers',
    async (change) => {
      const test = await createHarness();
      try {
        test.vscode.window.state.focused = false;
        test.state.markSessionBusy('root');
        test.state.handleServerEvent({ type: 'session.idle', properties: { sessionID: 'root' } });
        if (change === 'new-turn') test.state.markSessionBusy('root');
        if (change === 'pending-child')
          test.state.handleServerEvent({
            type: 'permission.asked',
            properties: { id: 'late-permission', sessionID: 'child', permission: 'bash' },
          });
        if (change === 'seen-in-background') test.state.acknowledgeCompletedSession('root');
        await vi.advanceTimersByTimeAsync(300);
        expect(test.show).toHaveBeenCalledTimes(change === 'seen-in-background' ? 1 : 0);
        expect(test.sound).toHaveBeenCalledTimes(change === 'seen-in-background' ? 1 : 0);
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it.each(['permission.asked', 'permission.v2.asked'] as const)(
    'keeps automatic %s quiet and notifies only after manual reveal',
    async (type) => {
      const test = await createHarness();
      const ask = (id: string): ServerEvent =>
        type === 'permission.asked'
          ? { type, properties: { id, sessionID: 'child', permission: 'bash' } }
          : { type, properties: { id, sessionID: 'child', action: 'bash', resources: ['*'] } };
      try {
        test.state.handleServerEvent(ask('auto'));
        await vi.advanceTimersByTimeAsync(300);
        expect(test.show).not.toHaveBeenCalled();
        test.state.handleServerEvent(
          type === 'permission.asked'
            ? { type: 'permission.replied', properties: { requestID: 'auto', sessionID: 'child' } }
            : {
                type: 'permission.v2.replied',
                properties: { requestID: 'auto', sessionID: 'child', reply: { type: 'once' } },
              }
        );
        await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS);
        expect(test.sound).not.toHaveBeenCalled();
        test.state.handleServerEvent(ask('manual'));
        test.state.revealPermission('manual');
        await vi.advanceTimersByTimeAsync(300);
        expect(test.show).toHaveBeenCalledOnce();
        expect(test.sound).toHaveBeenCalledOnce();
      } finally {
        await test.provider.dispose();
      }
    }
  );

  it('notifies after the judge timeout without any webview reveal', async () => {
    const test = await createHarness();
    try {
      test.view.visible = false;
      test.state.handleServerEvent({
        type: 'permission.asked',
        properties: { id: 'timeout', sessionID: 'child', permission: 'bash' },
      });
      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS + 300);
      expect(test.sound).toHaveBeenCalledOnce();
    } finally {
      await test.provider.dispose();
    }
  });

  it.each(['disabled', 'remote', 'other-workspace'] as const)(
    'does not deliver when %s',
    async (reason) => {
      const test = await createHarness(reason !== 'disabled');
      try {
        if (reason === 'remote') test.vscode.env.remoteName = 'ssh-remote';
        test.state.handleServerEvent({
          type: 'question.asked',
          workspaceDirectory: reason === 'other-workspace' ? '/other' : '/repo',
          properties: { id: 'question', sessionID: 'other', questions: [] },
        });
        await vi.advanceTimersByTimeAsync(300);
        expect(test.show).not.toHaveBeenCalled();
        expect(test.sound).not.toHaveBeenCalled();
      } finally {
        await test.provider.dispose();
      }
    }
  );
});
