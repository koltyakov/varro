/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These session tests verify extension-host imports with partial webview, URI, and private-state fixtures. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, vscodeMock } = vi.hoisted(() => ({
  loggerMock: {
    warn: vi.fn(),
    error: vi.fn(),
  },
  vscodeMock: {
    env: {
      remoteName: undefined as string | undefined,
    },
    commands: {
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    },
    window: {
      onDidChangeActiveColorTheme: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      })),
    },
  },
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('./logger', () => ({ logger: loggerMock }));

import type { InitialWebviewState, ServerStatus } from '../shared/protocol';
import type {
  BlockingRequestSnapshot,
  RecoverySnapshot,
  SessionStateManager,
} from './session-state-manager';
import { WebviewSession } from './webview-session';

const RUNNING_STATUS: ServerStatus = { state: 'running', url: 'http://127.0.0.1:4096' };

type WebviewSessionState = Pick<
  SessionStateManager,
  'clearCompleted' | 'consumeRecoverySnapshot' | 'isSessionInWorkspace' | 'replayBlockingRequests'
>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

type Listener<T> = ((value: T) => void) | undefined;

function createWebviewView(visible: boolean) {
  const listeners: {
    message: Listener<unknown>;
    dispose: Listener<void>;
    visibility: Listener<void>;
  } = {
    message: undefined,
    dispose: undefined,
    visibility: undefined,
  };

  return {
    visible,
    listeners,
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-webview-resource:',
      onDidReceiveMessage: vi.fn((listener?: (value: unknown) => void) => {
        listeners.message = listener;
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(() => ({ toString: () => 'vscode-resource://icon' })),
    },
    onDidDispose: vi.fn((listener?: () => void) => {
      listeners.dispose = listener;
      return { dispose: vi.fn() };
    }),
    onDidChangeVisibility: vi.fn((listener?: () => void) => {
      listeners.visibility = listener;
      return { dispose: vi.fn() };
    }),
  };
}

function createSession(options?: {
  renderHtml?: (state: InitialWebviewState) => Promise<string>;
  manageCommandContext?: boolean;
  editorSurface?: boolean;
}) {
  let currentView: ReturnType<typeof createWebviewView> | undefined;

  const bridge = {
    setView: vi.fn((view: ReturnType<typeof createWebviewView> | undefined) => {
      currentView = view;
    }),
    getView: vi.fn(() => currentView),
    isVisible: vi.fn(() => Boolean(currentView?.visible)),
    onDeliveryFailure: vi.fn(),
    invalidatePendingDeliveries: vi.fn(),
    post: vi.fn(),
    deliver: vi.fn(() => Promise.resolve(true)),
    webviewOptions: vi.fn(() => ({ enableScripts: true, localResourceRoots: [] })),
    renderHtml: vi.fn(
      options?.renderHtml ?? (() => Promise.resolve('<html><body>Varro</body></html>'))
    ),
    emptyStateLogoUri: vi.fn(() => ''),
  };

  const sessionState = {
    clearCompleted: vi.fn<WebviewSessionState['clearCompleted']>(),
    consumeRecoverySnapshot: vi.fn<WebviewSessionState['consumeRecoverySnapshot']>(() =>
      Promise.resolve({
        interruptedSessions: [],
        blockingRequests: [],
      } satisfies RecoverySnapshot)
    ),
    isSessionInWorkspace: vi.fn<WebviewSessionState['isSessionInWorkspace']>(() => true),
    replayBlockingRequests: vi.fn<WebviewSessionState['replayBlockingRequests']>(),
  } satisfies WebviewSessionState;

  const sessionTrash = {
    hiddenSessionIds: vi.fn(() => new Set<string>()),
    isHidden: vi.fn((_sessionID?: string | null) => false),
    list: vi.fn(),
  };

  const hiddenSessions = {
    hiddenSessionIds: vi.fn(() => new Set<string>()),
    isHidden: vi.fn((_sessionID?: string | null) => false),
  };

  const contextProvider = {
    context: {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    },
    terminalSelection: null,
  };

  const contextFilesState = {
    getContextFiles: vi.fn(() => []),
    postContextFiles: vi.fn(),
  };
  const pinnedSessions = { list: vi.fn(() => ['pinned-session']) };

  const deps = {
    handleMessage: vi.fn(() => Promise.resolve()),
    ensureServerStarted: vi.fn(() => Promise.resolve(undefined)),
    readConfig: vi.fn(() => ({
      showFileDiffs: true,
      showChangedFiles: true,
      desktopSessionPaneSide: 'left' as const,
      defaultPermissionMode: 'default' as const,
      chatFontSize: 13,
      chatEditorFontSize: 12,
      chatFontFamily: 'default',
    })),
    currentTheme: vi.fn(() => 'dark' as const),
    renderStatus: vi.fn(() => RUNNING_STATUS),
    handleReadySideEffects: vi.fn(() => Promise.resolve()),
    handleVisibleSideEffects: vi.fn(() => Promise.resolve()),
    updateStatusBarItem: vi.fn(),
    postThemeUpdate: vi.fn(),
    onHidden: vi.fn(),
    resetStatusBarCache: vi.fn(),
    queuedMessages: vi.fn<() => InitialWebviewState['queuedMessages']>(() => undefined),
    sessionPermissionModes: vi.fn<() => InitialWebviewState['sessionPermissionModes']>(() => ({})),
    sessionSelectedModels: vi.fn<() => InitialWebviewState['sessionSelectedModels']>(() => ({})),
    sessionPlanState: vi.fn<() => InitialWebviewState['sessionPlanState']>(() => ({})),
    sessionPlanAgents: vi.fn(() => ({})),
    sessionModelMigrationPending: vi.fn(() => false),
    modelPreferences: vi.fn<() => InitialWebviewState['modelPreferences']>(() => ({
      modelVariantSelections: {},
      hiddenProviders: [],
      hiddenModels: [],
      addedModels: [],
      pinnedModels: [],
      modelDisplayNames: {},
    })),
    modelPreferencesMigrationPending: vi.fn(() => false),
    editorTabsOpen: vi.fn(() => false),
    editorSessionIds: vi.fn(() => []),
    permissionAutomation: vi.fn(() => ({ owner: true, lease: 1 })),
    draftImages: vi.fn<() => InitialWebviewState['clipboardImages']>(() => []),
    flushPendingServerEvents: vi.fn(),
    cancelApiRequestsBeforeGeneration: vi.fn(),
    handleUnavailableSideEffects: vi.fn(),
    handleDisposedSideEffects: vi.fn(),
  };

  const session = new WebviewSession(
    bridge as never,
    sessionState,
    sessionTrash as never,
    pinnedSessions,
    hiddenSessions as never,
    contextProvider as never,
    contextFilesState as never,
    deps,
    options?.editorSurface
      ? { viewId: 'editor-1', surface: 'editor', initialRoute: { type: 'new-session' } }
      : undefined,
    options?.manageCommandContext
  );

  return { session, bridge, sessionState, sessionTrash, hiddenSessions, contextFilesState, deps };
}

describe('WebviewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.env.remoteName = undefined;
  });

  it('cancels requests owned by earlier webview generations on every resolve', async () => {
    const { session, deps } = createSession();

    await session.resolve(createWebviewView(true) as never);
    await session.resolve(createWebviewView(true) as never);

    expect(deps.cancelApiRequestsBeforeGeneration.mock.calls).toEqual([[1], [2]]);
  });

  it('cancels requests owned by the disposed current view', async () => {
    const { session, bridge, deps } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);
    view.listeners.dispose?.();

    expect(deps.cancelApiRequestsBeforeGeneration.mock.calls).toEqual([[1], [2]]);
    expect(session.getRequestGeneration()).toBe(2);
    expect(bridge.getView()).toBeUndefined();
  });

  it('does not cancel a replacement generation from a stale view disposal callback', async () => {
    const { session, bridge, deps } = createSession();
    const first = createWebviewView(true);
    const second = createWebviewView(true);

    await session.resolve(first as never);
    const disposeFirst = first.listeners.dispose;
    await session.resolve(second as never);
    disposeFirst?.();

    expect(deps.cancelApiRequestsBeforeGeneration.mock.calls).toEqual([[1], [2]]);
    expect(bridge.getView()).toBe(second);

    second.listeners.dispose?.();
    expect(deps.cancelApiRequestsBeforeGeneration.mock.calls).toEqual([[1], [2], [3]]);
  });

  it('queues focus, search, and status commands until the webview is visible and ready', async () => {
    const { session, bridge, sessionState, deps } = createSession();
    const view = createWebviewView(false);

    session.requestInputFocus();
    session.searchSessions();
    session.openAttentionSessions();
    session.openCompletedSessions();

    await session.resolve(view as never);
    await session.handleReady();

    const typesAfterReady = bridge.post.mock.calls.map(
      ([message]) => (message as { type: string }).type
    );
    expect(typesAfterReady).not.toContain('command/focus-input');
    expect(typesAfterReady).not.toContain('command/search-sessions');
    expect(typesAfterReady).not.toContain('command/open-attention-sessions');
    expect(typesAfterReady).not.toContain('command/open-completed-sessions');

    view.visible = true;
    session.handleVisible();

    const postedTypes = bridge.post.mock.calls.map(
      ([message]) => (message as { type: string }).type
    );
    expect(postedTypes.filter((type) => type === 'command/focus-input')).toHaveLength(1);
    expect(postedTypes.filter((type) => type === 'command/search-sessions')).toHaveLength(1);
    expect(postedTypes.filter((type) => type === 'command/open-attention-sessions')).toHaveLength(
      1
    );
    expect(postedTypes.filter((type) => type === 'command/open-completed-sessions')).toHaveLength(
      1
    );
    expect(sessionState.clearCompleted).toHaveBeenCalledOnce();
    expect(deps.handleVisibleSideEffects).toHaveBeenCalledOnce();
  });

  it('flushes queued action commands in order after command state is ready', async () => {
    const { session, bridge } = createSession();
    const view = createWebviewView(true);

    session.queueCommand({ type: 'command/new-session', payload: { prefill: '/init' } });
    session.queueCommand({
      type: 'command/switch-session',
      payload: { direction: 'next' },
    });
    await session.resolve(view as never);
    await session.handleReady();

    expect(bridge.post).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command/new-session' })
    );

    session.updateCommandState(false, true);

    expect(
      bridge.post.mock.calls
        .map(([message]) => message)
        .filter((message) => (message as { type: string }).type.startsWith('command/'))
    ).toEqual([
      { type: 'command/new-session', payload: { prefill: '/init' } },
      { type: 'command/switch-session', payload: { direction: 'next' } },
    ]);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'varro:canSwitchSessions',
      true
    );
  });

  it('does not let an editor endpoint overwrite global command contexts', () => {
    const { session } = createSession({ manageCommandContext: false });

    session.updateCommandState(true, true);

    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('ignores stale renderHtml results from an earlier resolve generation', async () => {
    const firstHtml = createDeferred<string>();
    const secondHtml = createDeferred<string>();
    const { session, bridge, sessionState } = createSession({
      renderHtml: vi
        .fn()
        .mockImplementationOnce(() => firstHtml.promise)
        .mockImplementationOnce(() => secondHtml.promise),
    });
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledTimes(2);
    expect(sessionState.consumeRecoverySnapshot).toHaveBeenCalledOnce();

    firstHtml.resolve('<html>stale</html>');
    await flushMicrotasks();
    expect(view.webview.html).toContain('aria-label="Loading workspace"');

    secondHtml.resolve('<html>fresh</html>');
    await flushMicrotasks();
    expect(view.webview.html).toBe('<html>fresh</html>');
  });

  it('reloads the current view through a fresh resolve', async () => {
    const { session, bridge } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await flushMicrotasks();
    bridge.renderHtml.mockReturnValueOnce(Promise.resolve('<html>reloaded</html>'));

    await session.reload();
    expect(view.webview.html).toContain('aria-label="Loading workspace"');
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledTimes(2);
    expect(view.webview.html).toBe('<html>reloaded</html>');
  });

  it('revokes readiness when rendering fails after ready', async () => {
    const render = createDeferred<string>();
    const { session, deps } = createSession({ renderHtml: () => render.promise });
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await session.handleReady();
    deps.handleUnavailableSideEffects.mockClear();
    render.reject(new Error('render failed'));
    await flushMicrotasks();

    expect(deps.handleUnavailableSideEffects).toHaveBeenCalled();
    expect(view.webview.html).toContain('Failed to load Varro webview');
  });

  it('retries interrupted-session delivery once before revoking readiness', async () => {
    const { session, bridge, deps } = createSession();
    const view = createWebviewView(true);
    bridge.deliver.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await session.resolve(view as never);
    await flushMicrotasks();
    await session.handleReady();
    deps.handleUnavailableSideEffects.mockClear();

    await expect(
      session.deliverInterruptedSessions(7, [{ id: 'session-1', title: 'Interrupted' }])
    ).resolves.toBe(true);

    expect(bridge.deliver).toHaveBeenCalledTimes(2);
    expect(bridge.deliver).toHaveBeenLastCalledWith({
      type: 'recovery/interrupted-sessions',
      payload: { claimId: 7, sessionIds: ['session-1'] },
    });
    expect(deps.handleUnavailableSideEffects).not.toHaveBeenCalled();
  });

  it('revokes readiness after interrupted-session delivery fails twice', async () => {
    const { session, bridge, deps } = createSession();
    const view = createWebviewView(true);
    bridge.deliver.mockResolvedValue(false);
    await session.resolve(view as never);
    await flushMicrotasks();
    await session.handleReady();
    deps.handleUnavailableSideEffects.mockClear();

    await expect(session.deliverInterruptedSessions(8, [{ id: 'session-1' }])).resolves.toBe(false);

    expect(bridge.deliver).toHaveBeenCalledTimes(2);
    expect(deps.handleUnavailableSideEffects).toHaveBeenCalledOnce();
  });

  it('shares an overlapping recovery load and lets only the current generation commit it', async () => {
    const recovery = createDeferred<RecoverySnapshot>();
    const { session, bridge, sessionState, deps } = createSession();
    sessionState.consumeRecoverySnapshot.mockReturnValue(recovery.promise);
    const firstView = createWebviewView(true);
    const secondView = createWebviewView(true);

    await session.resolve(firstView as never);
    await session.resolve(secondView as never);
    recovery.resolve({
      interruptedSessions: [{ id: 'session-1', title: 'Interrupted' }],
      blockingRequests: [
        {
          id: 'permission-1',
          sessionID: 'session-1',
          kind: 'permission',
          props: { id: 'permission-1', sessionID: 'session-1' },
        },
      ],
    });
    await flushMicrotasks();

    expect(sessionState.consumeRecoverySnapshot).toHaveBeenCalledOnce();
    expect(deps.resetStatusBarCache).toHaveBeenCalledOnce();
    expect(bridge.renderHtml).toHaveBeenCalledOnce();
    expect(firstView.webview.html).toContain('aria-label="Loading workspace"');
    expect(secondView.webview.html).toBe('<html><body>Varro</body></html>');
    expect(session.interruptedSessionsForWebview).toEqual([
      { id: 'session-1', title: 'Interrupted' },
    ]);
    expect(session.blockingRequestsForWebview).toHaveLength(1);
  });

  it('includes pinned sessions in the initial webview state', async () => {
    const { session, bridge } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        pinnedSessionIds: ['pinned-session'],
      })
    );
  });

  it('includes the persisted queued messages in the initial webview state', async () => {
    const { session, bridge, deps } = createSession();
    const view = createWebviewView(true);
    const queuedMessages = [
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'continue after restart',
        droppedFiles: [],
        clipboardImages: [],
        nativePdfs: [],
        terminalSelection: null,
      },
    ];
    deps.queuedMessages.mockReturnValue(queuedMessages);

    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(expect.objectContaining({ queuedMessages }));
  });

  it('includes persisted session permission modes in the initial webview state', async () => {
    const { session, bridge, deps } = createSession();
    deps.sessionPermissionModes.mockReturnValue({ 'session-1': 'full' });

    await session.resolve(createWebviewView(true) as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPermissionModes: { 'session-1': 'full' } })
    );
  });

  it('includes host-owned session model variants in the initial webview state', async () => {
    const { session, bridge, deps } = createSession();
    deps.sessionSelectedModels.mockReturnValue({
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });

    await session.resolve(createWebviewView(true) as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSelectedModels: {
          'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        },
      })
    );
  });

  it('marks the initial state when the extension host is remote', async () => {
    vscodeMock.env.remoteName = 'ssh-remote';
    const { session, bridge } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({ remoteExtensionHost: true })
    );
  });

  it('omits hidden judge blocking requests from the initial webview state', async () => {
    const { session, bridge, sessionState, hiddenSessions } = createSession();
    const view = createWebviewView(true);
    hiddenSessions.isHidden.mockImplementation((sessionID) => sessionID === 'hidden-session');
    sessionState.consumeRecoverySnapshot.mockResolvedValue({
      interruptedSessions: [],
      blockingRequests: [
        {
          id: 'perm-hidden',
          sessionID: 'hidden-session',
          kind: 'permission',
          props: { id: 'perm-hidden', sessionID: 'hidden-session' },
        },
        {
          id: 'question-hidden',
          sessionID: 'hidden-session',
          kind: 'question',
          props: { id: 'question-hidden', sessionID: 'hidden-session' },
        },
        {
          id: 'perm-visible',
          sessionID: 'visible-session',
          kind: 'permission',
          props: { id: 'perm-visible', sessionID: 'visible-session' },
        },
      ] satisfies BlockingRequestSnapshot[],
    });

    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPermissions: [{ id: 'perm-visible', sessionID: 'visible-session' }],
        pendingQuestions: [],
      })
    );
  });

  it('omits recovered prompts from other workspace roots in the initial state', async () => {
    const { session, bridge, sessionState } = createSession();
    const view = createWebviewView(true);
    sessionState.isSessionInWorkspace.mockImplementation(
      (sessionID: string) => sessionID !== 'foreign-session'
    );
    sessionState.consumeRecoverySnapshot.mockResolvedValue({
      interruptedSessions: [],
      blockingRequests: [
        {
          id: 'local-permission',
          sessionID: 'local-session',
          kind: 'permission',
          props: { id: 'local-permission', sessionID: 'local-session' },
        },
        {
          id: 'foreign-question',
          sessionID: 'foreign-session',
          kind: 'question',
          props: { id: 'foreign-question', sessionID: 'foreign-session' },
        },
      ] satisfies BlockingRequestSnapshot[],
    });

    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPermissions: [{ id: 'local-permission', sessionID: 'local-session' }],
        pendingQuestions: [],
      })
    );
    expect(sessionState.isSessionInWorkspace).toHaveBeenCalledWith('foreign-session', '/repo');
  });

  it('forwards valid webview messages and logs invalid ones', async () => {
    const { session, deps } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);

    view.listeners.message?.({ type: 'ready' });
    view.listeners.message?.({ type: 'invalid/message' });

    expect(deps.handleMessage).toHaveBeenCalledOnce();
    expect(deps.handleMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(loggerMock.warn).toHaveBeenCalledWith('Ignoring invalid webview message');
  });

  it('forwards a parsed Ralph start message to the message handler', async () => {
    const { session, deps } = createSession();
    const view = createWebviewView(true);
    const message = {
      type: 'ralph/start',
      payload: {
        config: {
          managerSessionId: 'manager-1',
          workspaceDirectory: '/workspace',
          planDocPath: 'RALPH.md',
          iterations: 5,
          promptTemplate: 'Follow the plan',
          permissionMode: 'full',
          model: { providerID: 'openai', modelID: 'gpt-5' },
          agent: null,
          createdAt: 100,
        },
      },
    };

    await session.resolve(view as never);
    view.listeners.message?.(message);

    expect(deps.handleMessage).toHaveBeenCalledWith(message);
  });

  it('replays boot state and clears interrupted sessions when the webview becomes ready', async () => {
    const { session, bridge, sessionState, sessionTrash, hiddenSessions, contextFilesState } =
      createSession();
    const view = createWebviewView(true);
    const hiddenSessionIds = new Set(['session-hidden']);
    const hiddenJudgeSessionIds = new Set(['session-judge']);

    contextFilesState.postContextFiles.mockImplementation((post) => {
      post({ type: 'files/update', payload: [] });
    });
    sessionTrash.hiddenSessionIds.mockReturnValue(hiddenSessionIds);
    hiddenSessions.hiddenSessionIds.mockReturnValue(hiddenJudgeSessionIds);

    await session.resolve(view as never);
    await flushMicrotasks();

    session.interruptedSessionsForWebview = [{ id: 'session-1', title: 'Needs attention' }];
    session.blockingRequestsForWebview = [
      {
        id: 'perm-1',
        sessionID: 'session-1',
        kind: 'permission',
        props: { id: 'perm-1', sessionID: 'session-1' },
      },
    ];

    await session.handleReady();

    expect(session.interruptedSessionsForWebview).toEqual([]);
    expect(contextFilesState.postContextFiles).toHaveBeenCalledOnce();
    expect(sessionState.replayBlockingRequests).toHaveBeenCalledWith(
      expect.any(Function),
      new Set(['session-hidden', 'session-judge']),
      {
        previousRequests: session.blockingRequestsForWebview,
        clearResolvedEmbedded: true,
        workspacePath: '/repo',
      }
    );

    const postedTypes = bridge.post.mock.calls.map(
      ([message]) => (message as { type: string }).type
    );
    expect(postedTypes).toContain('context/update');
    expect(postedTypes).toContain('terminal-selection/update');
    expect(postedTypes).toContain('files/update');
    expect(postedTypes).toContain('config/update');
    expect(postedTypes).toContain('server/status');
    expect(postedTypes).toContain('theme/update');
  });

  it('reacts to visibility and dispose events from the webview view', async () => {
    const { session, bridge, sessionState, deps } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await flushMicrotasks();

    bridge.post.mockClear();
    sessionState.clearCompleted.mockClear();
    deps.handleVisibleSideEffects.mockClear();
    deps.ensureServerStarted.mockClear();
    deps.onHidden.mockClear();
    deps.updateStatusBarItem.mockClear();

    view.visible = false;
    view.listeners.visibility?.();

    expect(deps.onHidden).toHaveBeenCalledOnce();
    expect(deps.updateStatusBarItem).toHaveBeenCalledOnce();

    bridge.post.mockClear();
    sessionState.clearCompleted.mockClear();
    deps.handleVisibleSideEffects.mockClear();
    deps.ensureServerStarted.mockClear();
    deps.updateStatusBarItem.mockClear();

    view.visible = true;
    view.listeners.visibility?.();

    expect(sessionState.clearCompleted).toHaveBeenCalledOnce();
    expect(deps.handleVisibleSideEffects).toHaveBeenCalledOnce();
    expect(deps.ensureServerStarted).toHaveBeenCalledOnce();
    expect(deps.updateStatusBarItem).toHaveBeenCalledOnce();
    expect(bridge.post).toHaveBeenCalledWith({ type: 'server/status', payload: RUNNING_STATUS });

    deps.updateStatusBarItem.mockClear();

    view.listeners.dispose?.();

    expect(bridge.getView()).toBeUndefined();
    expect(deps.updateStatusBarItem).toHaveBeenCalledOnce();
  });

  it('rotates only the message listener while an editor webview is suspended', async () => {
    const { session, bridge, deps } = createSession({ editorSurface: true });
    const view = createWebviewView(true);
    await session.resolve(view as never);
    const messageDisposable = view.webview.onDidReceiveMessage.mock.results[0]?.value;
    const disposeDisposable = view.onDidDispose.mock.results[0]?.value;
    const visibilityDisposable = view.onDidChangeVisibility.mock.results[0]?.value;
    const generation = session.getRequestGeneration();

    session.suspend();

    expect(session.getRequestGeneration()).toBe(generation + 1);
    expect(deps.cancelApiRequestsBeforeGeneration).toHaveBeenLastCalledWith(generation + 1);
    expect(bridge.invalidatePendingDeliveries).toHaveBeenCalledOnce();
    expect(messageDisposable.dispose).toHaveBeenCalledOnce();
    expect(disposeDisposable.dispose).not.toHaveBeenCalled();
    expect(visibilityDisposable.dispose).not.toHaveBeenCalled();

    session.resume();
    expect(view.webview.onDidReceiveMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores a message queued by an editor document before suspension', async () => {
    const { session, deps } = createSession({ editorSurface: true });
    const view = createWebviewView(true);
    await session.resolve(view as never);
    const staleListener = view.listeners.message;

    session.suspend();
    staleListener?.({ type: 'ready' });
    expect(deps.handleMessage).not.toHaveBeenCalled();

    session.resume();
    view.listeners.message?.({ type: 'ready' });
    expect(deps.handleMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('finishes preparing editor HTML when the panel is suspended during rendering', async () => {
    const html = createDeferred<string>();
    const { session } = createSession({
      editorSurface: true,
      renderHtml: () => html.promise,
    });
    const view = createWebviewView(true);
    await session.resolve(view as never);
    await flushMicrotasks();

    session.suspend();
    html.resolve('<html>prepared while hidden</html>');
    await flushMicrotasks();

    expect(view.webview.html).toBe('<html>prepared while hidden</html>');
  });

  it('logs ready and visible side-effect failures without duplicating server-start reporting', async () => {
    const { session, deps } = createSession();
    deps.handleReadySideEffects.mockRejectedValueOnce(new Error('ready cleanup failed'));
    deps.handleVisibleSideEffects.mockRejectedValueOnce('visible cleanup failed');
    deps.ensureServerStarted.mockRejectedValue(new Error('startup already reported'));

    await session.handleReady();
    session.handleVisible();
    await flushMicrotasks();

    expect(loggerMock.error.mock.calls).toEqual([
      ['Webview ready side effects failed: ready cleanup failed'],
      ['Webview visible side effects failed: visible cleanup failed'],
    ]);
    expect(deps.ensureServerStarted).toHaveBeenCalledTimes(2);
  });

  it('posts theme updates from VS Code theme changes', async () => {
    const { session, deps } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);

    const listener = vscodeMock.window.onDidChangeActiveColorTheme.mock.calls.at(-1)?.[0] as
      | (() => void)
      | undefined;

    listener?.();

    expect(deps.postThemeUpdate).toHaveBeenCalledOnce();
  });

  it('renders a fallback page when html generation fails', async () => {
    const { session } = createSession({
      renderHtml: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await vi.waitFor(() => {
      expect(view.webview.html).toBe('<p>Failed to load Varro webview. Please reload.</p>');
    });
    expect(loggerMock.error).toHaveBeenCalledWith('getHtml failed: boom');
  });

  it('posts API responses only for the current active generation', async () => {
    const { session, bridge } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);

    const generation = session.getRequestGeneration();
    bridge.post.mockClear();

    session.postApiResponse({ id: 1, data: { ok: false } }, generation - 1);
    session.postApiResponse({ id: 2, data: { ok: true } }, generation);

    expect(bridge.post).toHaveBeenCalledOnce();
    expect(bridge.post).toHaveBeenCalledWith({
      type: 'api/response',
      payload: { id: 2, data: { ok: true } },
    });

    await session.dispose();
    bridge.post.mockClear();

    session.postApiResponse({ id: 3 }, generation);

    expect(bridge.post).not.toHaveBeenCalled();
  });

  it('flushes pending server events before posting an API response', async () => {
    const { session, bridge, deps } = createSession();
    const view = createWebviewView(true);
    const order: string[] = [];
    deps.flushPendingServerEvents.mockImplementation(() => order.push('flush'));
    bridge.post.mockImplementation(() => {
      order.push('post');
    });
    await session.resolve(view as never);
    bridge.post.mockClear();
    order.length = 0;

    session.postApiResponse({ id: 1, data: [] }, session.getRequestGeneration());

    expect(order).toEqual(['flush', 'post']);
  });

  it('re-posts boot messages before the next API response after a delivery failure', async () => {
    const { session, bridge } = createSession();
    const view = createWebviewView(true);
    await session.resolve(view as never);
    await flushMicrotasks();
    await session.handleReady();
    bridge.post.mockClear();

    const postedTypes = () =>
      bridge.post.mock.calls.map(([message]) => (message as { type: string }).type);

    const onDeliveryFailure = bridge.onDeliveryFailure.mock.calls[0]?.[0] as () => void;
    expect(onDeliveryFailure).toBeInstanceOf(Function);
    onDeliveryFailure();

    session.postApiResponse({ id: 1, data: [] }, session.getRequestGeneration());

    const firstResponseIndex = postedTypes().indexOf('api/response');
    expect(firstResponseIndex).toBeGreaterThan(-1);
    expect(postedTypes().slice(0, firstResponseIndex)).toContain('server/status');
    expect(postedTypes().slice(0, firstResponseIndex)).toContain('config/update');

    bridge.post.mockClear();
    session.postApiResponse({ id: 2, data: [] }, session.getRequestGeneration());

    expect(postedTypes()).toEqual(['api/response']);
  });
});
