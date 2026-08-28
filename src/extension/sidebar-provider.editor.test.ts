/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- The panel fixture implements the VS Code host boundary and inspects private lifecycle state used by these tests. */
import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createContextProvider,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';
import type {
  DroppedFile,
  EditorContext,
  QueuedMessageSnapshot,
  SiblingWorkspaceAlert,
} from '../shared/protocol';
import type { SessionStateManager } from './session-state-manager';

function lastEditorContext(messages: unknown[]) {
  return (messages as Array<{ type?: string; payload?: EditorContext }>)
    .filter((message) => message.type === 'context/update')
    .at(-1)?.payload;
}

function lastSiblingWorkspaceAlerts(messages: unknown[]) {
  return (messages as Array<{ type?: string; payload?: SiblingWorkspaceAlert[] }>)
    .filter((message) => message.type === 'sibling-workspace-alerts/update')
    .at(-1)?.payload;
}

function createPanel() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const viewStateListeners: Array<(event: { webviewPanel: unknown }) => void> = [];
  const registeredDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const registration = () => {
    const disposable = { dispose: vi.fn() };
    registeredDisposables.push(disposable);
    return disposable;
  };
  const panel = {
    title: '',
    iconPath: undefined as unknown,
    visible: true,
    viewColumn: 2,
    reveal: vi.fn(),
    dispose: vi.fn(() => {
      for (const listener of disposeListeners) listener();
    }),
    webview: {
      cspSource: 'vscode-webview-resource:',
      options: {},
      html: '',
      postMessage: vi.fn<(_message: unknown) => boolean | Promise<boolean>>(() => true),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return registration();
      }),
      asWebviewUri: vi.fn((uri: { toString(): string }) => uri),
    },
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return registration();
    }),
    onDidChangeViewState: vi.fn((listener: (event: { webviewPanel: unknown }) => void) => {
      viewStateListeners.push(listener);
      return registration();
    }),
  };
  return {
    panel,
    registeredDisposables,
    receive: (message: unknown) => messageListeners.at(-1)?.(message),
    setVisible: (visible: boolean) => {
      panel.visible = visible;
      for (const listener of viewStateListeners) listener({ webviewPanel: panel });
    },
  };
}

describe('SidebarProvider editor panels', () => {
  it('routes external context to the last focused chat and clears only that workspace draft', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'webview/focus', payload: { focused: true } });
    const targetViewId = provider.captureContextTarget();
    const sidebarFile = {
      path: '/repo-a/sidebar.ts',
      relativePath: 'sidebar.ts',
      type: 'file',
    } as const;
    const editorFile = {
      path: '/repo-a/editor.ts',
      relativePath: 'editor.ts',
      type: 'file',
    } as const;

    provider.postDroppedFiles([sidebarFile]);
    provider.postDroppedFiles([editorFile], targetViewId);
    provider.postTerminalSelection({ text: 'npm test', terminalName: 'Terminal 1' }, targetViewId);

    expect(targetViewId).not.toBe('sidebar');
    expect(posted).toContainEqual({ type: 'files/dropped', payload: [sidebarFile] });
    expect(posted).not.toContainEqual({ type: 'files/dropped', payload: [editorFile] });
    expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'files/dropped',
      payload: [editorFile],
    });
    expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'terminal-selection/update',
      payload: { text: 'npm test', terminalName: 'Terminal 1' },
    });

    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    editor.panel.webview.postMessage.mockClear();
    editor.receive({ type: 'context/request' });

    expect(provider.getContextFiles()).toEqual([sidebarFile]);
    expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'terminal-selection/update',
      payload: null,
    });
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'files/dropped' })
    );
  });

  it('keeps a sibling plan-ready event after the plan session is seen', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    contextProvider.context.workspaceFolders = [
      { name: 'Repo A', path: '/repo-a' },
      { name: 'Repo B', path: '/repo-b' },
    ];
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;

    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'plan-1', agent: 'plan', directory: '/repo-b' } },
    });
    sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'plan-1', status: { type: 'busy' } },
    });
    sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'plan-1', status: { type: 'idle' } },
    });

    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([
      { name: 'Repo B', path: '/repo-b', kinds: ['plan-ready'], count: 1 },
    ]);

    await provider.handleMessage({ type: 'session/seen', payload: { sessionId: 'plan-1' } });

    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([
      { name: 'Repo B', path: '/repo-b', kinds: ['plan-ready'], count: 1 },
    ]);

    await provider.handleMessage({
      type: 'session-plan-state/update',
      payload: { sessionId: 'plan-1', skippedAt: 1 },
    });

    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([]);
  });

  it('alerts only for requested sibling events whose chat is not open', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    contextProvider.context.workspaceFolders = [
      { name: 'Repo A', path: '/repo-a' },
      { name: 'Repo B', path: '/repo-b' },
      { name: 'Repo C', path: '/repo-c' },
    ];
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;

    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'sibling', directory: '/repo-b', title: 'Sibling work' } },
    });
    sessionState.handleServerEvent({
      type: 'question.asked',
      properties: {
        id: 'question-1',
        sessionID: 'sibling',
        questions: [{ header: 'Choice', question: 'Choose', options: [] }],
      },
    });
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'regular', directory: '/repo-b', title: 'Regular work' } },
    });
    sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'regular', status: { type: 'busy' } },
    });
    sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'regular', status: { type: 'idle' } },
    });

    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([
      { name: 'Repo B', path: '/repo-b', kinds: ['attention', 'completed'], count: 2 },
    ]);
    const statusItemIndex = getVscodeMock().window.createStatusBarItem.mock.calls.findIndex(
      ([id]) => id === 'varro.session-status'
    );
    const statusItem =
      getVscodeMock().window.createStatusBarItem.mock.results[statusItemIndex]?.value;
    expect(statusItem?.text).toBe('$(bell-dot) Varro: 2 workspace events');
    expect(statusItem?.tooltip).toContain('Repo B: 2');
    expect(statusItem?.show).toHaveBeenCalled();

    await provider.openSiblingWorkspaceSessions();

    expect(contextProvider.selectWorkspace).toHaveBeenCalledWith('/repo-b');
    expect(posted).toContainEqual({ type: 'command/search-sessions' });

    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openSessionInEditor('sibling');
    await vi.waitFor(() => expect(editor.panel.webview.onDidReceiveMessage).toHaveBeenCalled());
    editor.receive({
      type: 'editor/route-changed',
      payload: { route: { type: 'session', sessionId: 'sibling' } },
    });

    await vi.waitFor(() => expect(lastSiblingWorkspaceAlerts(posted)).toEqual([]));
  });

  it('recomputes sibling alerts when workspace folders change', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    contextProvider.context.workspaceFolders = [{ name: 'Repo A', path: '/repo-a' }];
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'sibling', directory: '/repo-b' } },
    });
    sessionState.handleServerEvent({
      type: 'question.asked',
      properties: {
        id: 'question-1',
        sessionID: 'sibling',
        questions: [{ header: 'Choice', question: 'Choose', options: [] }],
      },
    });
    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([]);

    contextProvider.context.workspaceFolders.push({ name: 'Repo B', path: '/repo-b' });
    provider.post({ type: 'context/update', payload: contextProvider.context });

    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([
      { name: 'Repo B', path: '/repo-b', kinds: ['attention'], count: 1 },
    ]);
  });

  it('alerts when the previously open session needs attention after switching workspaces', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    contextProvider.context.workspaceFolders = [
      { name: 'Repo A', path: '/repo-a' },
      { name: 'Repo B', path: '/repo-b' },
    ];
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-a', directory: '/repo-a' } },
    });
    await provider.handleMessage({
      type: 'commands/state',
      payload: {
        canAbort: false,
        canSwitchSessions: false,
        model: null,
        sessionId: 'session-a',
      },
    });

    await provider.handleMessage({
      type: 'workspace/select',
      payload: { path: '/repo-b' },
    });
    sessionState.handleServerEvent({
      type: 'question.asked',
      properties: {
        id: 'question-a',
        sessionID: 'session-a',
        questions: [{ header: 'Choice', question: 'Choose', options: [] }],
      },
    });

    expect(lastSiblingWorkspaceAlerts(posted)).toEqual([
      { name: 'Repo A', path: '/repo-a', kinds: ['attention'], count: 1 },
    ]);
  });

  it('keeps sidebar and editor workspace selections independent', async () => {
    const contextProvider = createContextProvider();
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();

    await provider.handleMessage({
      type: 'workspace/select',
      payload: { path: '/repo-b' },
    });
    contextProvider.context.activeFile = {
      path: '/repo-b/app.ts',
      relativePath: 'app.ts',
      language: 'typescript',
    };
    contextProvider.context.activeWorkspacePath = '/repo-b';
    provider.post({ type: 'context/update', payload: contextProvider.context });

    expect(lastEditorContext(posted)?.workspacePath).toBe('/repo-b');
    expect(
      lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
    ).toMatchObject({ workspacePath: '/repo', activeFile: null });

    editor.receive({ type: 'workspace/select', payload: { path: '/repo-c' } });
    await vi.waitFor(() =>
      expect(
        lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
          ?.workspacePath
      ).toBe('/repo-c')
    );
    expect(contextProvider.selectWorkspace).not.toHaveBeenCalledWith('/repo-c');
    contextProvider.context.activeFile = null;
    provider.post({ type: 'context/update', payload: contextProvider.context });

    expect(lastEditorContext(posted)?.workspacePath).toBe('/repo-b');
    expect(
      lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
        ?.workspacePath
    ).toBe('/repo-c');

    const secondEditor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(secondEditor.panel);
    await provider.openNewEditor();
    provider.post({ type: 'context/update', payload: contextProvider.context });

    expect(
      lastEditorContext(
        secondEditor.panel.webview.postMessage.mock.calls.map(([message]) => message)
      )?.workspacePath
    ).toBe('/repo-b');
  });

  it('scopes editor API requests to the editor workspace', async () => {
    const { provider, server } = await createSidebarProviderInstance();
    attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();

    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    editor.receive({
      type: 'api/request',
      payload: { id: 41, method: 'GET', path: '/config/providers' },
    });

    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        'GET',
        '/config/providers',
        undefined,
        expect.objectContaining({ directory: '/repo-b' })
      )
    );
  });

  it('keeps an API request in the workspace where dispatch started', async () => {
    const { provider, server } = await createSidebarProviderInstance();
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();

    editor.receive({
      type: 'api/request',
      payload: { id: 42, method: 'GET', path: '/config/providers' },
    });
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });

    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        'GET',
        '/config/providers',
        undefined,
        expect.objectContaining({ directory: '/repo' })
      )
    );
  });

  it('opens relative editor paths from the editor workspace', async () => {
    const contextProvider = createContextProvider();
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });

    editor.receive({ type: 'vscode/open', payload: { path: 'src/app.ts', kind: 'file' } });

    await vi.waitFor(() =>
      expect(contextProvider.openPath).toHaveBeenCalledWith('src/app.ts', {
        line: undefined,
        kind: 'file',
        view: undefined,
        workspaceDirectory: '/repo-b',
      })
    );
  });

  it('rejects workspace selections outside the open workspace folders', async () => {
    const contextProvider = createContextProvider();
    contextProvider.getOpenWorkspaceRoot.mockImplementation((path: string) =>
      path === '/repo' ? path : null
    );
    const { provider, server } = await createSidebarProviderInstance({ contextProvider });
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();

    editor.receive({ type: 'workspace/select', payload: { path: '/outside' } });
    editor.receive({
      type: 'api/request',
      payload: { id: 42, method: 'GET', path: '/config/providers' },
    });

    await vi.waitFor(() => expect(server.request).toHaveBeenCalled());
    expect(server.request).not.toHaveBeenCalledWith(
      'GET',
      '/config/providers',
      undefined,
      expect.objectContaining({ directory: '/outside' })
    );
  });

  it('routes session events only to endpoints in the matching workspace', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    await vi.waitFor(() =>
      expect(
        lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
          ?.workspacePath
      ).toBe('/repo-b')
    );

    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-a', directory: '/repo-a' } },
    });
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-b', directory: '/repo-b' } },
    });
    const eventA = {
      type: 'session.status' as const,
      properties: { sessionID: 'session-a', status: { type: 'busy' as const } },
    };
    const eventB = {
      type: 'session.status' as const,
      properties: { sessionID: 'session-b', status: { type: 'busy' as const } },
    };
    provider.post({ type: 'server/event', payload: eventA });
    provider.post({ type: 'server/event', payload: eventB });

    const sidebarEvents = (posted as Array<{ type?: string; payload?: unknown }>).filter(
      (message) => message.type === 'server/event'
    );
    const editorEvents = editor.panel.webview.postMessage.mock.calls
      .map(([message]) => message as { type?: string; payload?: unknown })
      .filter((message) => message.type === 'server/event');
    expect(sidebarEvents).toEqual([{ type: 'server/event', payload: eventA }]);
    expect(editorEvents).toEqual([{ type: 'server/event', payload: eventB }]);
  });

  it('routes envelope-scoped workspace events only to the matching endpoint', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    await vi.waitFor(() =>
      expect(
        lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
          ?.workspacePath
      ).toBe('/repo-b')
    );
    posted.length = 0;
    editor.panel.webview.postMessage.mockClear();
    const event = { type: 'catalog.updated' as const, workspaceDirectory: '/repo-b' };

    provider.post({ type: 'server/event', payload: event });

    expect(posted).toEqual([]);
    expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'server/event',
      payload: event,
    });
  });

  it('does not defer message updates because their info id is a message id', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-a', directory: '/repo-a' } },
    });
    posted.length = 0;
    const event = {
      type: 'message.updated' as const,
      properties: {
        info: { id: 'message-1', sessionID: 'session-a', role: 'assistant' as const },
      },
    };

    provider.post({ type: 'server/event', payload: event });

    expect(posted).toContainEqual({ type: 'server/event', payload: event });
  });

  it('routes sibling session lifecycle events to the endpoint that owns its queue', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider, server } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const internals = provider as unknown as {
      queuedMessages: { update(messages: QueuedMessageSnapshot[]): Promise<void> };
      runSessionReconcile(): Promise<void>;
    };
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-b', directory: '/repo-b' } },
    });
    await internals.queuedMessages.update([
      {
        id: 'queue-1',
        sessionId: 'session-b',
        text: 'Continue in sibling workspace',
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);
    server.request.mockResolvedValueOnce({});
    await internals.runSessionReconcile();
    expect(posted).toContainEqual({
      type: 'queued-messages/session-status',
      payload: { sessionId: 'session-b', status: 'idle' },
    });
    const busyEvent = {
      type: 'session.status' as const,
      properties: { sessionID: 'session-b', status: { type: 'busy' as const } },
    };
    const idleEvent = {
      type: 'session.idle' as const,
      properties: { sessionID: 'session-b' },
    };
    const completionEvent = {
      type: 'message.updated' as const,
      properties: {
        info: {
          id: 'assistant-1',
          sessionID: 'session-b',
          role: 'assistant' as const,
          time: { created: 1, completed: 2 },
        },
      },
    };

    provider.post({ type: 'server/event', payload: busyEvent });
    provider.post({ type: 'server/event', payload: idleEvent });
    sessionState.handleServerEvent(busyEvent);
    sessionState.handleServerEvent(completionEvent);
    provider.post({ type: 'server/event', payload: completionEvent });

    const lifecycleEvents = (posted as Array<{ type?: string; payload?: unknown }>).filter(
      (message) => message.type === 'server/event'
    );
    expect(lifecycleEvents).toEqual([]);
    expect(posted).toContainEqual({
      type: 'queued-messages/session-status',
      payload: { sessionId: 'session-b', status: 'busy' },
    });
    expect(posted).toContainEqual({
      type: 'queued-messages/session-status',
      payload: { sessionId: 'session-b', status: 'idle' },
    });
    expect(
      (posted as Array<{ type?: string; payload?: unknown }>).filter(
        (message) =>
          message.type === 'queued-messages/session-status' &&
          (message.payload as { status?: string } | undefined)?.status === 'idle'
      )
    ).toHaveLength(3);
  });

  it('does not report queued-message idle while a newer busy attempt remains', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const internals = provider as unknown as {
      queuedMessages: { update(messages: QueuedMessageSnapshot[]): Promise<void> };
      postQueuedSessionStatusFor(sessionId: string, status: 'busy' | 'idle'): void;
      sessionState: SessionStateManager;
    };
    await internals.queuedMessages.update([
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'Follow up',
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);
    internals.sessionState.markSessionBusy('session-1');
    posted.length = 0;

    internals.postQueuedSessionStatusFor('session-1', 'idle');

    expect(posted).toContainEqual({
      type: 'queued-messages/session-status',
      payload: { sessionId: 'session-1', status: 'busy' },
    });
    expect(posted).not.toContainEqual({
      type: 'queued-messages/session-status',
      payload: { sessionId: 'session-1', status: 'idle' },
    });
  });

  it('elects one permission automation owner in each endpoint workspace', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    editor.receive({ type: 'ready' });

    await vi.waitFor(() => {
      const sidebarOwner = (posted as Array<{ type?: string; payload?: { owner?: boolean } }>)
        .filter((message) => message.type === 'permission-automation/update')
        .at(-1)?.payload?.owner;
      const editorOwner = editor.panel.webview.postMessage.mock.calls
        .map(([message]) => message as { type?: string; payload?: { owner?: boolean } })
        .filter((message) => message.type === 'permission-automation/update')
        .at(-1)?.payload?.owner;
      expect(sidebarOwner).toBe(true);
      expect(editorOwner).toBe(true);
    });
  });

  it('advances the permission automation lease when an owner changes workspaces', async () => {
    const { provider } = await createSidebarProviderInstance();
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'permission-automation/update' })
      )
    );
    const updates = () =>
      editor.panel.webview.postMessage.mock.calls
        .map(([message]) => message as { type?: string; payload?: { lease?: number } })
        .filter((message) => message.type === 'permission-automation/update');
    const initialLease = updates().at(-1)?.payload?.lease;

    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });

    await vi.waitFor(() => expect(updates().at(-1)?.payload?.lease).not.toBe(initialLease));
    expect(updates().at(-1)?.payload?.lease).toBeGreaterThan(initialLease ?? -1);
  });

  it("keeps workspace A's permission automation lease when workspace B loses its owner", async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    editor.receive({ type: 'ready' });

    const sidebarUpdates = () =>
      (posted as Array<{ type?: string; payload?: { lease?: number } }>).filter(
        (message) => message.type === 'permission-automation/update'
      );
    await vi.waitFor(() => expect(sidebarUpdates().at(-1)?.payload?.lease).toBeTypeOf('number'));
    const workspaceALease = sidebarUpdates().at(-1)?.payload?.lease;

    editor.setVisible(false);

    await vi.waitFor(() => expect(sidebarUpdates().length).toBeGreaterThan(1));
    expect(sidebarUpdates().at(-1)?.payload?.lease).toBe(workspaceALease);
  });

  it('routes session deletion before removing its workspace metadata', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider, server } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-a', directory: '/repo-a' } },
    });
    posted.length = 0;
    editor.panel.webview.postMessage.mockClear();
    const eventHandler = server.on.mock.calls.find(([type]) => type === 'event')?.[1];

    eventHandler?.({ type: 'session.deleted', properties: { info: { id: 'session-a' } } });

    expect(posted).toContainEqual({
      type: 'server/event',
      payload: { type: 'session.deleted', properties: { info: { id: 'session-a' } } },
    });
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'server/event' })
    );
  });

  it('defers unknown-session events until their workspace is known', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    posted.length = 0;
    editor.panel.webview.postMessage.mockClear();
    const event = {
      type: 'permission.asked' as const,
      properties: { id: 'permission-unknown', sessionID: 'session-unknown', permission: 'bash' },
    };
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent(event);

    provider.post({ type: 'server/event', payload: event });

    expect(posted).toEqual([]);
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalled();

    const created = {
      type: 'session.created' as const,
      properties: { info: { id: 'session-unknown', directory: '/repo-b' } },
    };
    sessionState.handleServerEvent(created);
    provider.post({ type: 'server/event', payload: created });

    expect(posted).toEqual([]);
    expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'server/event',
      payload: created,
    });
    expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'server/event',
      payload: event,
    });
    expect(
      editor.panel.webview.postMessage.mock.calls
        .map(([message]) => message as { type?: string; payload?: unknown })
        .filter((message) => message.type === 'server/event')
        .map((message) => message.payload)
    ).toEqual([event, created]);
  });

  it('flushes deferred events when REST bootstrap learns the session workspace', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider, server } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    posted.length = 0;
    editor.panel.webview.postMessage.mockClear();
    const event = {
      type: 'permission.asked' as const,
      properties: {
        id: 'permission-bootstrap',
        sessionID: 'session-bootstrap',
        permission: 'bash',
      },
    };
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent(event);
    provider.post({ type: 'server/event', payload: event });
    server.request.mockImplementation(async (_method: string, path: string) => {
      if (path === '/session') return [{ id: 'session-bootstrap', directory: '/repo-b' }];
      throw new Error(`Unexpected path: ${path}`);
    });

    editor.receive({
      type: 'api/request',
      payload: { id: 43, method: 'GET', path: '/session' },
    });

    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'server/event',
        payload: event,
      })
    );
    expect(posted).not.toContainEqual({ type: 'server/event', payload: event });
  });

  it('coalesces session-directory reconciliation during bulk bootstrap', async () => {
    const { provider } = await createSidebarProviderInstance();
    const access = provider as unknown as {
      sessionState: SessionStateManager;
      flushDeferredWorkspaceEvents(): void;
      reconcilePermissionAutomationOwners(): void;
    };
    const flushDeferred = vi.spyOn(access, 'flushDeferredWorkspaceEvents');
    const reconcileOwners = vi.spyOn(access, 'reconcilePermissionAutomationOwners');

    access.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-a', directory: '/repo-a' } },
    });
    access.sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-b', directory: '/repo-b' } },
    });

    expect(flushDeferred).not.toHaveBeenCalled();
    expect(reconcileOwners).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(flushDeferred).toHaveBeenCalledOnce();
    expect(reconcileOwners).toHaveBeenCalledOnce();
  });

  it('reassigns an actionable permission after its session workspace is discovered', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({ type: 'ready' });
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    editor.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'permission-automation/update' })
      )
    );
    const sessionState = (provider as unknown as { sessionState: SessionStateManager })
      .sessionState;
    sessionState.handleServerEvent({
      type: 'permission.asked',
      properties: {
        id: 'permission-late-workspace',
        sessionID: 'session-late-workspace',
        permission: 'bash',
      },
    });
    const access = provider as unknown as {
      reconcilePermissionAutomationOwners(resendActionable?: boolean): void;
    };
    access.reconcilePermissionAutomationOwners(true);
    expect(posted).not.toContainEqual({
      type: 'permission/actionable',
      payload: { permissionId: 'permission-late-workspace' },
    });
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalledWith({
      type: 'permission/actionable',
      payload: { permissionId: 'permission-late-workspace' },
    });
    posted.length = 0;
    editor.panel.webview.postMessage.mockClear();

    sessionState.handleServerEvent({
      type: 'session.created',
      properties: { info: { id: 'session-late-workspace', directory: '/repo-b' } },
    });

    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'permission/actionable',
        payload: { permissionId: 'permission-late-workspace' },
      })
    );
    expect(posted).not.toContainEqual({
      type: 'permission/actionable',
      payload: { permissionId: 'permission-late-workspace' },
    });
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'permission-automation/update' })
    );
  });

  it('does not expose an external active file to workspace-scoped endpoints', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    contextProvider.context.activeWorkspacePath = null;
    contextProvider.context.activeFile = {
      path: '/tmp/notes.ts',
      relativePath: '/tmp/notes.ts',
      language: 'typescript',
    };
    provider.post({ type: 'context/update', payload: contextProvider.context });

    expect(lastEditorContext(posted)?.activeFile).toBeNull();
    expect(
      lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
        ?.activeFile
    ).toBeNull();
  });

  it('runs editor terminal commands in the editor workspace', async () => {
    const { provider } = await createSidebarProviderInstance();
    attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    await provider.openNewEditor();
    editor.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });
    await vi.waitFor(() =>
      expect(
        lastEditorContext(editor.panel.webview.postMessage.mock.calls.map(([message]) => message))
          ?.workspacePath
      ).toBe('/repo-b')
    );
    editor.receive({
      type: 'terminal/run',
      payload: { command: 'opencode auth login', title: 'OpenCode' },
    });

    await vi.waitFor(() =>
      expect(getVscodeMock().window.createTerminal).toHaveBeenCalledWith({
        name: 'OpenCode',
        cwd: '/repo-b',
      })
    );
  });

  it('restores an editor workspace from its persisted panel state', async () => {
    const contextProvider = createContextProvider();
    contextProvider.context.workspacePath = '/repo-a';
    const { provider } = await createSidebarProviderInstance({ contextProvider });
    attachTestView(provider);
    const restored = createPanel();

    await provider.deserializeWebviewPanel(restored.panel as never, {
      'varro.editorViewId': 'editor-repo-b',
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-b' },
      'varro.workspacePath': '/repo-b',
    });
    restored.receive({ type: 'ready' });

    await vi.waitFor(() =>
      expect(
        lastEditorContext(restored.panel.webview.postMessage.mock.calls.map(([message]) => message))
          ?.workspacePath
      ).toBe('/repo-b')
    );
  });

  it('lets VS Code release hidden editor content and broadcasts the editor-tab lifecycle', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openNewEditor();

    expect(getVscodeMock().window.createWebviewPanel).toHaveBeenCalledWith(
      'varro.editor',
      'Varro: New Session',
      expect.anything(),
      { enableScripts: true, retainContextWhenHidden: false }
    );
    expect(posted).toContainEqual({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: [] },
    });

    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('varro-editor-surface'));
    const visibleHtml = editor.panel.webview.html;

    editor.setVisible(false);
    expect(editor.panel.webview.html).toBe(visibleHtml);

    editor.setVisible(true);
    expect(editor.panel.webview.html).toBe(visibleHtml);
    expect(editor.panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(2);

    editor.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'server/status',
        payload: expect.anything(),
      })
    );

    editor.panel.dispose();
    expect(posted).toContainEqual({
      type: 'editor-tabs/state',
      payload: { open: false, sessionIds: [] },
    });
  });

  it('broadcasts only visible editor sessions as read', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openSessionInEditor('session-1');
    expect(posted).toContainEqual({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: ['session-1'] },
    });

    const hiddenMessagesStart = posted.length;
    editor.setVisible(false);
    expect(posted.slice(hiddenMessagesStart)).toContainEqual({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: [] },
    });

    const visibleMessagesStart = posted.length;
    editor.setVisible(true);
    expect(posted.slice(visibleMessagesStart)).toContainEqual({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: ['session-1'] },
    });
  });

  it('closes a session editor before opening that session in the sidebar', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openSessionInEditor('session-1');
    await provider.openSessionInSidebar('session-1');

    expect(getVscodeMock().commands.executeCommand).toHaveBeenCalledWith('varro.chat.focus');
    expect(editor.panel.dispose).toHaveBeenCalledOnce();
    await provider.handleMessage({ type: 'ready' });
    await provider.handleMessage({
      type: 'commands/state',
      payload: { canAbort: false, canSwitchSessions: false, model: null },
    });
    expect(posted).toContainEqual({
      type: 'command/open-session',
      payload: { sessionId: 'session-1' },
    });
  });

  it('restores and deduplicates a persisted session panel', async () => {
    const { provider } = await createSidebarProviderInstance();
    const first = createPanel();
    const duplicate = createPanel();
    const state = {
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-1', timestamp: 1 },
    };

    await provider.deserializeWebviewPanel(first.panel as never, state);
    await provider.deserializeWebviewPanel(duplicate.panel as never, state);

    expect(first.panel.title).toBe('Varro: Session');
    expect(first.panel.iconPath).toEqual({ id: 'chat-sparkle' });
    expect(first.panel.reveal).toHaveBeenCalledOnce();
    expect(duplicate.panel.dispose).toHaveBeenCalledOnce();
  });

  it('normalizes a persisted trashed-session route to a new session', async () => {
    const trashedSession = {
      id: 'session-trashed',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Trashed session',
      version: '1',
      time: { created: 1, updated: 2 },
    };
    const storage = new Map<string, unknown>([
      [
        'varro.sessionTrash',
        [
          {
            rootID: trashedSession.id,
            deletedAt: 3,
            expiresAt: 4,
            root: trashedSession,
            sessions: [trashedSession],
          },
        ],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn(() => Promise.resolve()),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const restored = createPanel();

    await provider.deserializeWebviewPanel(restored.panel as never, {
      'varro.lastOpenedView': { type: 'session', sessionId: trashedSession.id, timestamp: 1 },
    });
    restored.receive({
      type: 'editor/route-changed',
      payload: { route: { type: 'new-session' } },
    });
    await Promise.resolve();

    expect(restored.panel.title).toBe('Varro: New Session');
    expect(restored.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command/open-session' })
    );
  });

  it('deduplicates restored panels that share a persisted view identity', async () => {
    const { provider } = await createSidebarProviderInstance();
    const first = createPanel();
    const duplicate = createPanel();

    await provider.deserializeWebviewPanel(first.panel as never, {
      'varro.editorViewId': 'editor-shared',
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-1', timestamp: 1 },
    });
    await provider.deserializeWebviewPanel(duplicate.panel as never, {
      'varro.editorViewId': 'editor-shared',
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-2', timestamp: 2 },
    });

    expect(first.panel.reveal).toHaveBeenCalledOnce();
    expect(duplicate.panel.dispose).toHaveBeenCalledOnce();
  });

  it('rejects a new-chat route until a restored session is confirmed', async () => {
    const { provider } = await createSidebarProviderInstance();
    const restored = createPanel();

    await provider.deserializeWebviewPanel(restored.panel as never, {
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-1', timestamp: 1 },
    });
    restored.receive({
      type: 'editor/route-changed',
      payload: { route: { type: 'new-session' } },
    });
    await Promise.resolve();

    expect(restored.panel.title).toBe('Varro: Session');
    expect(restored.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'command/open-session',
      payload: { sessionId: 'session-1' },
    });

    restored.receive({
      type: 'editor/route-changed',
      payload: { route: { type: 'session', sessionId: 'session-1', title: 'Restored session' } },
    });
    await Promise.resolve();

    expect(restored.panel.title).toBe('Restored session');
  });

  it('releases a restored-session latch after authoritative deletion', async () => {
    const { provider, server } = await createSidebarProviderInstance();
    const restored = createPanel();

    await provider.deserializeWebviewPanel(restored.panel as never, {
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-deleted', timestamp: 1 },
    });
    const eventHandler = server.on.mock.calls.find(([type]) => type === 'event')?.[1];
    eventHandler?.({
      type: 'session.deleted',
      properties: { info: { id: 'session-deleted' } },
    });
    restored.panel.webview.postMessage.mockClear();

    restored.receive({
      type: 'editor/route-changed',
      payload: { route: { type: 'new-session' } },
    });
    await Promise.resolve();

    expect(restored.panel.title).toBe('Varro: New Session');
    expect(restored.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command/open-session' })
    );
  });

  it('rekeys a draft when its editor route changes', async () => {
    const { provider } = await createSidebarProviderInstance();
    const draft = createPanel();

    await provider.deserializeWebviewPanel(draft.panel as never, undefined);
    draft.receive({
      type: 'editor/route-changed',
      payload: {
        route: { type: 'session', sessionId: 'session-2', title: 'Fix editor sessions' },
      },
    });
    await Promise.resolve();
    await provider.openSessionInEditor('session-2');

    expect(draft.panel.title).toBe('Fix editor sessions');
    expect(draft.panel.reveal).toHaveBeenCalledOnce();
  });

  it('reuses an editor for another session in the same conversation tree', async () => {
    const { provider } = await createSidebarProviderInstance();
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openSessionInEditor('root-session', 'Root', undefined, 'root-session');
    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('varro-editor-surface'));
    editor.receive({ type: 'ready' });
    editor.receive({
      type: 'commands/state',
      payload: { canAbort: false, canSwitchSessions: true, model: null },
    });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'permission-automation/update',
        payload: expect.objectContaining({ owner: true }),
      })
    );
    editor.receive({
      type: 'commands/state',
      payload: { canAbort: false, canSwitchSessions: true, model: null },
    });
    await Promise.resolve();
    editor.panel.webview.postMessage.mockClear();
    await provider.openSessionInEditor('child-session', 'Child', undefined, 'root-session');
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'command/open-session',
        payload: { sessionId: 'child-session' },
      })
    );
    editor.panel.webview.postMessage.mockClear();
    await provider.openSessionInEditor('root-session', 'Root', undefined, 'root-session');

    expect(getVscodeMock().window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(editor.panel.reveal).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'command/open-session',
        payload: { sessionId: 'root-session' },
      })
    );
  });

  it('stores and broadcasts the model variant before opening an editor', async () => {
    const { provider, workspaceState } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openSessionInEditor('session-1', 'Session 1', {
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });

    expect(workspaceState.update).toHaveBeenCalledWith('varro.sessionSelectedModels', {
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });
    expect(posted).toContainEqual({
      type: 'session-models/sync',
      payload: {
        models: {
          'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        },
      },
    });
  });

  it('uses authoritative session metadata for an editor title', async () => {
    const { provider } = await createSidebarProviderInstance();
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openSessionInEditor('session-1');
    expect(editor.panel.title).toBe('Varro: Session');

    (
      provider as unknown as {
        sessionState: {
          handleServerEvent(event: {
            type: 'session.updated';
            properties: { info: { id: string; title: string } };
          }): void;
        };
      }
    ).sessionState.handleServerEvent({
      type: 'session.updated',
      properties: { info: { id: 'session-1', title: 'Authoritative title' } },
    });
    provider.post({
      type: 'server/event',
      payload: {
        type: 'session.updated',
        properties: { info: { id: 'session-1', title: 'Authoritative title' } },
      },
    });

    expect(editor.panel.title).toBe('Authoritative title');
  });

  it('treats only the ready sidebar active route as visible attention', async () => {
    const { provider } = await createSidebarProviderInstance();
    const sidebar = createPanel();
    const isVisible = (sessionId: string) =>
      (
        provider as unknown as {
          isSessionAttentionVisible(id: string): boolean;
        }
      ).isSessionAttentionVisible(sessionId);

    expect(isVisible('session-1')).toBe(false);
    await provider.resolveWebviewView(sidebar.panel as never, {} as never, {} as never);
    await vi.waitFor(() => expect(sidebar.panel.webview.html).toContain('__initialWebviewState'));
    expect(isVisible('session-1')).toBe(false);

    sidebar.receive({ type: 'ready' });
    sidebar.receive({
      type: 'commands/state',
      payload: {
        canAbort: false,
        canSwitchSessions: false,
        model: null,
        sessionId: 'session-1',
      },
    });
    await vi.waitFor(() => expect(isVisible('session-1')).toBe(true));
    expect(isVisible('session-2')).toBe(false);

    sidebar.receive({
      type: 'commands/state',
      payload: { canAbort: false, canSwitchSessions: false, model: null, sessionId: null },
    });
    await vi.waitFor(() => expect(isVisible('session-1')).toBe(false));
  });

  it('shows plan notifications only when no Varro chat is visible', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { view } = attachTestView(provider);
    const sessionState = (
      provider as unknown as {
        sessionState: { handleServerEvent(event: unknown): void };
      }
    ).sessionState;
    const completePlan = (sessionId: string, title: string) => {
      sessionState.handleServerEvent({
        type: 'session.updated',
        properties: { info: { id: sessionId, title } },
      });
      sessionState.handleServerEvent({
        type: 'message.updated',
        properties: { info: { sessionID: sessionId, role: 'assistant', agent: 'plan' } },
      });
      sessionState.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'busy' } },
      });
      sessionState.handleServerEvent({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      });
    };

    completePlan('session-visible', 'Visible plan');
    expect(getVscodeMock().window.showInformationMessage).not.toHaveBeenCalled();

    view.visible = false;
    completePlan('session-hidden', 'Hidden plan');
    expect(getVscodeMock().window.showInformationMessage).toHaveBeenCalledWith(
      'Varro has a plan ready for review for "Hidden plan".',
      'Open Chat'
    );
  });

  it('moves a sidebar queue to an editor opened for the same session', async () => {
    const { provider } = await createSidebarProviderInstance();
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);
    const internals = provider as unknown as {
      endpoints: Set<{ ready: boolean; surface: string; viewId: string }>;
      queuedMessages: { update(messages: QueuedMessageSnapshot[]): Promise<void> };
      setEndpointReady(endpoint: unknown, ready: boolean): void;
    };
    const sidebar = [...internals.endpoints].find((endpoint) => endpoint.surface === 'sidebar');
    if (!sidebar) throw new Error('Expected sidebar endpoint');
    internals.setEndpointReady(sidebar, true);
    await internals.queuedMessages.update([
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'Continue in the editor',
        agent: 'build',
        droppedFiles: [{ path: '/repo/file.ts', relativePath: 'file.ts', type: 'file' }],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);

    await provider.openSessionInEditor('session-1');
    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('varro-editor-surface'));
    editor.receive({ type: 'ready' });

    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'queued-messages/sync',
        payload: {
          messages: [
            expect.objectContaining({
              id: 'queue-1',
              sessionId: 'session-1',
              text: 'Continue in the editor',
              agent: 'build',
              ownerViewId: expect.stringMatching(/^editor-/),
              droppedFiles: [{ path: '/repo/file.ts', relativePath: 'file.ts', type: 'file' }],
            }),
          ],
        },
      })
    );
  });

  it('transfers an editor queue to the next ready view when hidden', async () => {
    const { provider } = await createSidebarProviderInstance();
    const first = createPanel();
    const second = createPanel();

    await provider.deserializeWebviewPanel(first.panel as never, {
      'varro.editorViewId': 'editor-first',
    });
    await provider.deserializeWebviewPanel(second.panel as never, {
      'varro.editorViewId': 'editor-second',
    });
    await vi.waitFor(() => expect(first.panel.webview.html).toContain('varro-editor-surface'));
    await vi.waitFor(() => expect(second.panel.webview.html).toContain('varro-editor-surface'));
    first.receive({ type: 'ready' });
    second.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(second.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'permission-automation/update',
        payload: expect.any(Object),
      })
    );
    first.receive({
      type: 'queued-messages/update',
      payload: {
        messages: [
          {
            id: 'queue-1',
            sessionId: 'session-1',
            text: 'Continue',
            droppedFiles: [],
            clipboardImages: [],
            terminalSelection: null,
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(first.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'queued-messages/sync',
        payload: { messages: [expect.objectContaining({ id: 'queue-1' })] },
      })
    );
    second.panel.webview.postMessage.mockClear();

    first.setVisible(false);

    await vi.waitFor(() =>
      expect(second.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'queued-messages/sync',
        payload: {
          messages: [expect.objectContaining({ id: 'queue-1', ownerViewId: 'editor-second' })],
        },
      })
    );
  });

  it('transfers an editor queue when delivery failure makes its endpoint unavailable', async () => {
    const { provider } = await createSidebarProviderInstance();
    const first = createPanel();
    const second = createPanel();
    await provider.deserializeWebviewPanel(first.panel as never, {
      'varro.editorViewId': 'editor-first',
    });
    await provider.deserializeWebviewPanel(second.panel as never, {
      'varro.editorViewId': 'editor-second',
    });
    await vi.waitFor(() => expect(first.panel.webview.html).toContain('varro-editor-surface'));
    await vi.waitFor(() => expect(second.panel.webview.html).toContain('varro-editor-surface'));
    first.receive({ type: 'ready' });
    second.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(first.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'permission-automation/update',
        payload: expect.objectContaining({ owner: true }),
      })
    );
    first.receive({
      type: 'queued-messages/update',
      payload: {
        messages: [
          {
            id: 'queue-1',
            messageId: 'message-1',
            sessionId: 'session-1',
            text: 'Continue',
            droppedFiles: [],
            clipboardImages: [],
            terminalSelection: null,
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(first.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'queued-messages/sync',
        payload: { messages: [expect.objectContaining({ id: 'queue-1' })] },
      })
    );
    second.panel.webview.postMessage.mockClear();
    first.panel.webview.postMessage.mockResolvedValueOnce(false);

    provider.post({ type: 'command/focus-input' });

    await vi.waitFor(() =>
      expect(second.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'queued-messages/sync',
        payload: {
          messages: [expect.objectContaining({ id: 'queue-1', ownerViewId: 'editor-second' })],
        },
      })
    );
  });

  it('keeps interrupted recovery claimable until the elected view acknowledges it', async () => {
    const storage = new Map<string, unknown>([
      [
        'varro.interruptedSessions',
        [{ id: 'session-1', title: 'Interrupted', directory: '/repo' }],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) storage.delete(key);
        else storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const first = createPanel();
    const second = createPanel();
    await provider.deserializeWebviewPanel(first.panel as never, {
      'varro.editorViewId': 'editor-first',
    });
    await provider.deserializeWebviewPanel(second.panel as never, {
      'varro.editorViewId': 'editor-second',
    });
    await vi.waitFor(() => expect(first.panel.webview.html).toContain('varro-editor-surface'));
    await vi.waitFor(() => expect(second.panel.webview.html).toContain('varro-editor-surface'));
    expect(first.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery/interrupted-sessions' })
    );

    first.receive({ type: 'ready' });
    second.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(first.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-1'] },
      })
    );
    expect(second.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery/interrupted-sessions' })
    );

    first.setVisible(false);
    await vi.waitFor(() =>
      expect(second.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 2, sessionIds: ['session-1'] },
      })
    );
    first.receive({
      type: 'recovery/interrupted-sessions-ack',
      payload: { claimId: 1, consumedSessionIds: ['session-1'] },
    });
    await Promise.resolve();
    expect(storage.get('varro.interruptedSessions')).toEqual([
      { id: 'session-1', title: 'Interrupted', directory: '/repo' },
    ]);

    second.receive({
      type: 'recovery/interrupted-sessions-ack',
      payload: { claimId: 2, consumedSessionIds: ['session-1'] },
    });
    await vi.waitFor(() => expect(storage.get('varro.interruptedSessions')).toEqual([]));
    await provider.dispose();

    const restarted = await createSidebarProviderInstance({ workspaceState });
    const third = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(third.panel);
    await restarted.provider.openNewEditor();
    await vi.waitFor(() => expect(third.panel.webview.html).toContain('varro-editor-surface'));
    third.receive({ type: 'ready' });
    await Promise.resolve();
    expect(third.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery/interrupted-sessions' })
    );
  });

  it('partitions interrupted recovery claims by endpoint workspace', async () => {
    const storage = new Map<string, unknown>([
      [
        'varro.interruptedSessions',
        [
          { id: 'session-a', title: 'A', directory: '/repo-a' },
          { id: 'session-b', title: 'B', directory: '/repo-b' },
        ],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) storage.delete(key);
        else storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const first = createPanel();
    const second = createPanel();
    await provider.deserializeWebviewPanel(first.panel as never, {
      'varro.editorViewId': 'editor-first',
      'varro.workspacePath': '/repo-a',
    });
    await provider.deserializeWebviewPanel(second.panel as never, {
      'varro.editorViewId': 'editor-second',
      'varro.workspacePath': '/repo-b',
    });
    await vi.waitFor(() => expect(first.panel.webview.html).toContain('varro-editor-surface'));
    await vi.waitFor(() => expect(second.panel.webview.html).toContain('varro-editor-surface'));

    first.receive({ type: 'ready' });
    second.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(first.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-a'] },
      })
    );
    expect(second.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recovery/interrupted-sessions',
        payload: expect.objectContaining({ sessionIds: expect.arrayContaining(['session-a']) }),
      })
    );

    first.receive({
      type: 'recovery/interrupted-sessions-ack',
      payload: { claimId: 1, consumedSessionIds: ['session-a'] },
    });
    await vi.waitFor(() =>
      expect(second.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 2, sessionIds: ['session-b'] },
      })
    );
    expect(first.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recovery/interrupted-sessions',
        payload: expect.objectContaining({ sessionIds: expect.arrayContaining(['session-b']) }),
      })
    );
  });

  it('reassigns interrupted recovery when the claiming view changes workspace', async () => {
    const storage = new Map<string, unknown>([
      [
        'varro.interruptedSessions',
        [{ id: 'session-a', title: 'Interrupted', directory: '/repo-a' }],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) storage.delete(key);
        else storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const first = createPanel();
    const second = createPanel();
    await provider.deserializeWebviewPanel(first.panel as never, {
      'varro.editorViewId': 'editor-first',
      'varro.workspacePath': '/repo-a',
    });
    await provider.deserializeWebviewPanel(second.panel as never, {
      'varro.editorViewId': 'editor-second',
      'varro.workspacePath': '/repo-a',
    });
    await vi.waitFor(() => expect(first.panel.webview.html).toContain('varro-editor-surface'));
    await vi.waitFor(() => expect(second.panel.webview.html).toContain('varro-editor-surface'));
    first.receive({ type: 'ready' });
    second.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(first.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-a'] },
      })
    );

    first.receive({ type: 'workspace/select', payload: { path: '/repo-b' } });

    await vi.waitFor(() =>
      expect(second.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 2, sessionIds: ['session-a'] },
      })
    );
  });

  it('retains legacy interrupted recovery until bootstrap resolves its workspace', async () => {
    const storage = new Map<string, unknown>([
      ['varro.interruptedSessions', [{ id: 'session-legacy', title: 'Legacy' }]],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) storage.delete(key);
        else storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider, server } = await createSidebarProviderInstance({ workspaceState });
    const editor = createPanel();
    await provider.deserializeWebviewPanel(editor.panel as never, {
      'varro.editorViewId': 'editor-legacy',
      'varro.workspacePath': '/repo-b',
    });
    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('varro-editor-surface'));
    editor.receive({ type: 'ready' });
    await Promise.resolve();
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery/interrupted-sessions' })
    );
    expect(storage.get('varro.interruptedSessions')).toEqual([
      { id: 'session-legacy', title: 'Legacy' },
    ]);
    server.request.mockImplementation(async (_method: string, path: string) => {
      if (path === '/session') return [{ id: 'session-legacy', directory: '/repo-b' }];
      throw new Error(`Unexpected path: ${path}`);
    });

    editor.receive({
      type: 'api/request',
      payload: { id: 44, method: 'GET', path: '/session' },
    });

    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-legacy'] },
      })
    );
  });

  it('redelivers an unacknowledged recovery claim after the webview reloads', async () => {
    const storage = new Map<string, unknown>([
      [
        'varro.interruptedSessions',
        [{ id: 'session-1', title: 'Interrupted', directory: '/repo' }],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) storage.delete(key);
        else storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const editor = createPanel();
    await provider.deserializeWebviewPanel(editor.panel as never, {
      'varro.editorViewId': 'editor-recovery',
    });
    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('varro-editor-surface'));
    editor.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-1'] },
      })
    );

    const endpoint = [
      ...(
        provider as unknown as {
          editorPanels: Map<string, { webviewSession: { reload(): Promise<void> } }>;
        }
      ).editorPanels.values(),
    ][0];
    if (!endpoint) throw new Error('Expected an editor endpoint');
    editor.panel.webview.postMessage.mockClear();
    await endpoint.webviewSession.reload();
    editor.receive({ type: 'ready' });

    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 2, sessionIds: ['session-1'] },
      })
    );
    expect(storage.get('varro.interruptedSessions')).toEqual([
      { id: 'session-1', title: 'Interrupted', directory: '/repo' },
    ]);
    await provider.dispose();
  });

  it('retains failed recovery work without retrying until the webview reloads', async () => {
    const storage = new Map<string, unknown>([
      [
        'varro.interruptedSessions',
        [{ id: 'session-1', title: 'Interrupted', directory: '/repo' }],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) storage.delete(key);
        else storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const editor = createPanel();
    await provider.deserializeWebviewPanel(editor.panel as never, {
      'varro.editorViewId': 'editor-recovery',
    });
    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('varro-editor-surface'));
    editor.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-1'] },
      })
    );

    editor.panel.webview.postMessage.mockClear();
    editor.receive({
      type: 'recovery/interrupted-sessions-ack',
      payload: { claimId: 1, consumedSessionIds: [] },
    });
    await vi.waitFor(() =>
      expect(workspaceState.update).toHaveBeenCalledWith('varro.interruptedSessions', [
        { id: 'session-1', title: 'Interrupted', directory: '/repo' },
      ])
    );
    expect(storage.get('varro.interruptedSessions')).toEqual([
      { id: 'session-1', title: 'Interrupted', directory: '/repo' },
    ]);
    expect(editor.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery/interrupted-sessions' })
    );

    const endpoint = [
      ...(
        provider as unknown as {
          editorPanels: Map<string, { webviewSession: { reload(): Promise<void> } }>;
        }
      ).editorPanels.values(),
    ][0];
    if (!endpoint) throw new Error('Expected an editor endpoint');
    await endpoint.webviewSession.reload();
    editor.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(editor.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 2, sessionIds: ['session-1'] },
      })
    );
    await provider.dispose();
  });

  it('releases failed recovery only when its claimant endpoint becomes unready', async () => {
    const storage = new Map<string, unknown>([
      [
        'varro.interruptedSessions',
        [{ id: 'session-a', title: 'Interrupted', directory: '/repo-a' }],
      ],
    ]);
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      update: vi.fn((key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const claimant = createPanel();
    const unrelated = createPanel();
    await provider.deserializeWebviewPanel(claimant.panel as never, {
      'varro.editorViewId': 'editor-claimant',
      'varro.workspacePath': '/repo-a',
    });
    await provider.deserializeWebviewPanel(unrelated.panel as never, {
      'varro.editorViewId': 'editor-unrelated',
      'varro.workspacePath': '/repo-b',
    });
    await vi.waitFor(() => expect(claimant.panel.webview.html).toContain('varro-editor-surface'));
    await vi.waitFor(() => expect(unrelated.panel.webview.html).toContain('varro-editor-surface'));
    claimant.receive({ type: 'ready' });
    unrelated.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(claimant.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 1, sessionIds: ['session-a'] },
      })
    );
    claimant.receive({
      type: 'recovery/interrupted-sessions-ack',
      payload: { claimId: 1, consumedSessionIds: [] },
    });
    await vi.waitFor(() =>
      expect(workspaceState.update).toHaveBeenCalledWith(
        'varro.interruptedSessions',
        expect.any(Array)
      )
    );
    claimant.panel.webview.postMessage.mockClear();

    unrelated.setVisible(false);
    await Promise.resolve();

    expect(claimant.panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery/interrupted-sessions' })
    );

    const claimantEndpoint = [
      ...(
        provider as unknown as {
          editorPanels: Map<
            string,
            { viewId: string; webviewSession: { reload(): Promise<void> } }
          >;
        }
      ).editorPanels.values(),
    ].find((endpoint) => endpoint.viewId === 'editor-claimant');
    if (!claimantEndpoint) throw new Error('Expected the claimant editor endpoint');
    await claimantEndpoint.webviewSession.reload();
    claimant.receive({ type: 'ready' });

    await vi.waitFor(() =>
      expect(claimant.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 2, sessionIds: ['session-a'] },
      })
    );
    await provider.dispose();
  });

  it('releases decoded editor draft image files when the panel closes', async () => {
    const { provider } = await createSidebarProviderInstance();
    const editor = createPanel();
    await provider.deserializeWebviewPanel(editor.panel as never, {
      'varro.editorViewId': 'editor-draft',
    });
    const internals = provider as unknown as {
      draftImages: {
        list(viewId: string): Array<{ contextFile?: DroppedFile }>;
        update(images: unknown[], viewId: string): Promise<void>;
      };
      droppedFilesService: { removeOwnedFiles(paths: Iterable<string>): Promise<void> };
    };
    const removeOwnedFiles = vi
      .spyOn(internals.droppedFilesService, 'removeOwnedFiles')
      .mockResolvedValue();
    editor.receive({
      type: 'composer/images-update',
      payload: {
        images: [
          {
            id: 'image-1',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'image.png',
            size: 1,
            contextFile: {
              path: '/tmp/varro/image.png',
              relativePath: 'image.png',
              type: 'file',
            },
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(internals.draftImages.list('editor-draft')[0]?.contextFile?.path).toBe(
        '/tmp/varro/image.png'
      )
    );

    editor.panel.dispose();

    await vi.waitFor(() => expect(removeOwnedFiles).toHaveBeenCalledWith(['/tmp/varro/image.png']));
    expect(internals.draftImages.list('editor-draft')).toEqual([]);
  });

  it('keeps editor draft image files still referenced by a transferred queued message', async () => {
    const { provider } = await createSidebarProviderInstance();
    const editor = createPanel();
    await provider.deserializeWebviewPanel(editor.panel as never, {
      'varro.editorViewId': 'editor-draft',
    });
    const contextFile: DroppedFile = {
      path: '/tmp/varro/image.png',
      relativePath: 'image.png',
      type: 'file',
    };
    const image = {
      id: 'image-1',
      url: 'data:image/png;base64,AA==',
      mime: 'image/png',
      filename: 'image.png',
      size: 1,
      contextFile,
    };
    const internals = provider as unknown as {
      draftImages: { update(images: unknown[], viewId: string): Promise<void> };
      queuedMessages: { update(messages: QueuedMessageSnapshot[]): Promise<void> };
      droppedFilesService: { removeOwnedFiles(paths: Iterable<string>): Promise<void> };
    };
    const removeOwnedFiles = vi
      .spyOn(internals.droppedFilesService, 'removeOwnedFiles')
      .mockResolvedValue();
    await internals.draftImages.update([image], 'editor-draft');
    await internals.queuedMessages.update([
      {
        id: 'queue-1',
        ownerViewId: 'editor-draft',
        sessionId: 'session-1',
        text: 'Inspect the image',
        droppedFiles: [],
        clipboardImages: [image],
        terminalSelection: null,
      },
    ]);

    editor.panel.dispose();
    await vi.waitFor(() => expect(removeOwnedFiles).toHaveBeenCalled());

    expect(removeOwnedFiles.mock.calls.flatMap(([paths]) => [...paths])).not.toContain(
      contextFile.path
    );
  });

  it('removes a stored image if its target disappears before storage completes', async () => {
    const { provider } = await createSidebarProviderInstance();
    let finishStore!: (files: DroppedFile[]) => void;
    const stored = new Promise<DroppedFile[]>((resolve) => {
      finishStore = resolve;
    });
    const service = (
      provider as unknown as {
        droppedFilesService: {
          fromContent(...args: unknown[]): Promise<DroppedFile[]>;
          removeOwnedFile(path: string): Promise<void>;
        };
      }
    ).droppedFilesService;
    vi.spyOn(service, 'fromContent').mockReturnValue(stored);
    const removeOwnedFile = vi.spyOn(service, 'removeOwnedFile').mockResolvedValue();
    const post = vi.fn();
    let available = true;
    const operation = (
      provider as unknown as {
        storeImage(
          payload: { id: string; name: string; content: string; size: number },
          postMessage: (message: unknown) => void,
          isAvailable: () => boolean
        ): Promise<void>;
      }
    ).storeImage(
      { id: 'image-1', name: 'image.png', content: 'AA==', size: 1 },
      post,
      () => available
    );
    available = false;
    finishStore([{ path: '/tmp/varro/late.png', relativePath: 'late.png', type: 'file' }]);
    await operation;

    expect(removeOwnedFile).toHaveBeenCalledWith('/tmp/varro/late.png');
    expect(post).not.toHaveBeenCalled();
  });

  it('waits for model persistence so delayed hints reach initial state and existing views', async () => {
    let finishUpdate: (() => void) | undefined;
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishUpdate = resolve;
            })
        )
        .mockResolvedValue(undefined),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const { posted } = attachTestView(provider);
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    const opening = provider.openSessionInEditor('session-1', 'Session 1', {
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledOnce());

    expect(getVscodeMock().window.createWebviewPanel).not.toHaveBeenCalled();
    finishUpdate?.();
    await opening;

    expect(getVscodeMock().window.createWebviewPanel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(editor.panel.webview.html).toContain('gpt-5.6-sol'));
    expect(posted).toContainEqual({
      type: 'session-models/sync',
      payload: {
        models: {
          'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        },
      },
    });
  });

  it('reopens a session editor after its previous panel is closed', async () => {
    const { provider } = await createSidebarProviderInstance();
    const first = createPanel();
    const second = createPanel();
    getVscodeMock()
      .window.createWebviewPanel.mockReturnValueOnce(first.panel)
      .mockReturnValueOnce(second.panel);

    await provider.openSessionInEditor('session-1');
    first.panel.dispose();
    await provider.openSessionInEditor('session-1');

    expect(getVscodeMock().window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(second.panel.title).toBe('Varro: Session');
  });

  it('leaves panels open while the extension deactivates so VS Code can restore them', async () => {
    const { provider } = await createSidebarProviderInstance();
    const panel = createPanel();
    await provider.deserializeWebviewPanel(panel.panel as never, undefined);

    await provider.dispose();

    expect(panel.panel.dispose).not.toHaveBeenCalled();
    expect(panel.registeredDisposables.length).toBeGreaterThan(0);
    expect(panel.registeredDisposables.every((item) => item.dispose.mock.calls.length === 1)).toBe(
      true
    );
  });

  it('does not create or attach editor endpoints after deactivation starts', async () => {
    const { provider } = await createSidebarProviderInstance();
    const restored = createPanel();
    await provider.dispose();

    await provider.openNewEditor();
    await provider.deserializeWebviewPanel(restored.panel as never, undefined);

    expect(getVscodeMock().window.createWebviewPanel).not.toHaveBeenCalled();
    expect(restored.panel.onDidDispose).not.toHaveBeenCalled();
    expect(restored.panel.webview.onDidReceiveMessage).not.toHaveBeenCalled();
  });

  it('prepares a hidden restored editor panel for its first reveal', async () => {
    const { provider } = await createSidebarProviderInstance();
    const panel = createPanel();
    panel.panel.visible = false;

    await provider.deserializeWebviewPanel(panel.panel as never, {
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-1', timestamp: 1 },
    });

    expect(panel.panel.webview.html).toContain('--vscode-editor-background');
    expect(panel.panel.webview.html).not.toContain('webview.mjs');

    panel.setVisible(true);
    await vi.waitFor(() => expect(panel.panel.webview.html).toContain('type="module"'));
    expect(panel.panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(2);
  });
});
