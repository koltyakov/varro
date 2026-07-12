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
import type { BlockingRequestSnapshot, RecoverySnapshot } from './session-state-manager';
import { WebviewSession } from './webview-session';

const RUNNING_STATUS: ServerStatus = { state: 'running', url: 'http://127.0.0.1:4096' };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function createSession(options?: { renderHtml?: (state: InitialWebviewState) => Promise<string> }) {
  let currentView: ReturnType<typeof createWebviewView> | undefined;

  const bridge = {
    setView: vi.fn((view: ReturnType<typeof createWebviewView> | undefined) => {
      currentView = view;
    }),
    getView: vi.fn(() => currentView),
    isVisible: vi.fn(() => Boolean(currentView?.visible)),
    post: vi.fn(),
    webviewOptions: vi.fn(() => ({ enableScripts: true, localResourceRoots: [] })),
    renderHtml: vi.fn(
      options?.renderHtml ?? (() => Promise.resolve('<html><body>Varro</body></html>'))
    ),
    emptyStateLogoUri: vi.fn(() => ''),
  };

  const sessionState = {
    clearCompleted: vi.fn(),
    consumeRecoverySnapshot: vi.fn(() =>
      Promise.resolve({
        interruptedSessions: [],
        blockingRequests: [],
      } satisfies RecoverySnapshot)
    ),
    replayBlockingRequests: vi.fn(),
  };

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
      expandThinkingByDefault: false,
      showStickyUserPrompt: true,
      desktopSessionPaneSide: 'left' as const,
      defaultPermissionMode: 'default' as const,
      providerLimitPollIntervalSeconds: 120,
      providerLimitThresholdPercent: 40,
      providerLimitsDisabled: false,
    })),
    currentTheme: vi.fn(() => 'dark' as const),
    renderStatus: vi.fn(() => RUNNING_STATUS),
    handleReadySideEffects: vi.fn(() => Promise.resolve()),
    handleVisibleSideEffects: vi.fn(() => Promise.resolve()),
    updateStatusBarItem: vi.fn(),
    postThemeUpdate: vi.fn(),
    onHidden: vi.fn(),
    resetStatusBarCache: vi.fn(),
  };

  const session = new WebviewSession(
    bridge as never,
    sessionState as never,
    sessionTrash as never,
    pinnedSessions,
    hiddenSessions as never,
    contextProvider as never,
    contextFilesState as never,
    deps
  );

  return { session, bridge, sessionState, sessionTrash, hiddenSessions, contextFilesState, deps };
}

describe('WebviewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.env.remoteName = undefined;
  });

  it('queues focus, search, and attention commands until the webview is visible and ready', async () => {
    const { session, bridge, sessionState, deps } = createSession();
    const view = createWebviewView(false);

    session.requestInputFocus();
    session.searchSessions();
    session.openAttentionSessions();

    await session.resolve(view as never);
    await session.handleReady();

    const typesAfterReady = bridge.post.mock.calls.map(
      ([message]) => (message as { type: string }).type
    );
    expect(typesAfterReady).not.toContain('command/focus-input');
    expect(typesAfterReady).not.toContain('command/search-sessions');
    expect(typesAfterReady).not.toContain('command/open-attention-sessions');

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
    expect(sessionState.clearCompleted).toHaveBeenCalledOnce();
    expect(deps.handleVisibleSideEffects).toHaveBeenCalledOnce();
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
    expect(view.webview.html).toContain('Loading workspace...');

    secondHtml.resolve('<html>fresh</html>');
    await flushMicrotasks();
    expect(view.webview.html).toBe('<html>fresh</html>');
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
    expect(firstView.webview.html).toContain('Loading workspace...');
    expect(secondView.webview.html).toBe('<html><body>Varro</body></html>');
    expect(session.interruptedSessionsForWebview).toEqual([
      { id: 'session-1', title: 'Interrupted' },
    ]);
    expect(session.blockingRequestsForWebview).toHaveLength(1);
  });

  it('includes provider-limit poll interval in the initial webview state', async () => {
    const { session, bridge } = createSession();
    const view = createWebviewView(true);

    await session.resolve(view as never);
    await flushMicrotasks();

    expect(bridge.renderHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        providerLimitPollIntervalSeconds: 120,
        providerLimitThresholdPercent: 40,
        providerLimitsDisabled: false,
        pinnedSessionIds: ['pinned-session'],
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
});
