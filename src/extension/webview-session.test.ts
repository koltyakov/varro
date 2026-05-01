import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  window: {
    onDidChangeActiveColorTheme: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
}));

vi.mock('vscode', () => vscodeMock);

import type { InitialWebviewState, ServerStatus } from '../shared/protocol';
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

function createWebviewView(visible: boolean) {
  return {
    visible,
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-webview-resource:',
      onDidReceiveMessage: vi.fn((_listener?: (value: unknown) => void) => ({ dispose: vi.fn() })),
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(() => ({ toString: () => 'vscode-resource://icon' })),
    },
    onDidDispose: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
    onDidChangeVisibility: vi.fn((_listener?: () => void) => ({ dispose: vi.fn() })),
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
    consumeBlockingRequests: vi.fn(() => Promise.resolve([])),
    consumeInterruptedSessions: vi.fn(() => Promise.resolve([])),
    replayBlockingRequests: vi.fn(),
    restoreBlockingRequests: vi.fn(),
  };

  const sessionTrash = {
    hiddenSessionIds: vi.fn(() => []),
    isHidden: vi.fn(() => false),
    list: vi.fn(),
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

  const deps = {
    handleMessage: vi.fn(() => Promise.resolve()),
    ensureServerStarted: vi.fn(() => Promise.resolve(undefined)),
    readConfig: vi.fn(() => ({
      expandThinkingByDefault: false,
      showStickyUserPrompt: true,
      desktopSessionPaneSide: 'left' as const,
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
    contextProvider as never,
    contextFilesState as never,
    deps
  );

  return { session, bridge, sessionState, deps };
}

describe('WebviewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues focus and attention commands until the webview is visible and ready', async () => {
    const { session, bridge, sessionState, deps } = createSession();
    const view = createWebviewView(false);

    session.requestInputFocus();
    session.openAttentionSessions();

    await session.resolve(view as never);
    await session.handleReady();

    const typesAfterReady = bridge.post.mock.calls.map(
      ([message]) => (message as { type: string }).type
    );
    expect(typesAfterReady).not.toContain('command/focus-input');
    expect(typesAfterReady).not.toContain('command/open-attention-sessions');

    view.visible = true;
    session.handleVisible();

    const postedTypes = bridge.post.mock.calls.map(
      ([message]) => (message as { type: string }).type
    );
    expect(postedTypes.filter((type) => type === 'command/focus-input')).toHaveLength(1);
    expect(postedTypes.filter((type) => type === 'command/open-attention-sessions')).toHaveLength(
      1
    );
    expect(sessionState.clearCompleted).toHaveBeenCalledOnce();
    expect(deps.handleVisibleSideEffects).toHaveBeenCalledOnce();
  });

  it('ignores stale renderHtml results from an earlier resolve generation', async () => {
    const firstHtml = createDeferred<string>();
    const secondHtml = createDeferred<string>();
    const { session, bridge } = createSession({
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

    firstHtml.resolve('<html>stale</html>');
    await flushMicrotasks();
    expect(view.webview.html).toBe('');

    secondHtml.resolve('<html>fresh</html>');
    await flushMicrotasks();
    expect(view.webview.html).toBe('<html>fresh</html>');
  });
});
