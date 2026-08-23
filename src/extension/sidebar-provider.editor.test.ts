/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- The panel fixture implements the VS Code host boundary used by these tests. */
import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

function createPanel() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const viewStateListeners: Array<(event: { webviewPanel: unknown }) => void> = [];
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
      postMessage: vi.fn(() => true),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      asWebviewUri: vi.fn((uri: { toString(): string }) => uri),
    },
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidChangeViewState: vi.fn((listener: (event: { webviewPanel: unknown }) => void) => {
      viewStateListeners.push(listener);
      return { dispose: vi.fn() };
    }),
  };
  return {
    panel,
    receive: (message: unknown) => messageListeners[0]?.(message),
    setVisible: (visible: boolean) => {
      panel.visible = visible;
      for (const listener of viewStateListeners) listener({ webviewPanel: panel });
    },
  };
}

describe('SidebarProvider editor panels', () => {
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
    expect(posted).toContainEqual({ type: 'editor-tabs/state', payload: { open: true } });

    editor.panel.webview.html = '<p>visible editor document</p>';

    editor.setVisible(false);
    expect(editor.panel.webview.html).toBe('<p>visible editor document</p>');

    editor.setVisible(true);
    expect(editor.panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(2);

    editor.panel.dispose();
    expect(posted).toContainEqual({ type: 'editor-tabs/state', payload: { open: false } });
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

  it('stores the sidebar model variant without broadcasting it into other composers', async () => {
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
    expect(posted).not.toContainEqual(expect.objectContaining({ type: 'session-models/sync' }));
  });

  it('opens the editor without waiting for model persistence', async () => {
    let finishUpdate: (() => void) | undefined;
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishUpdate = resolve;
          })
      ),
    };
    const { provider } = await createSidebarProviderInstance({ workspaceState });
    const editor = createPanel();
    getVscodeMock().window.createWebviewPanel.mockReturnValue(editor.panel);

    await provider.openSessionInEditor('session-1', 'Session 1', {
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });

    expect(getVscodeMock().window.createWebviewPanel).toHaveBeenCalledOnce();
    finishUpdate?.();
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
  });

  it('does not render a restored editor panel until it becomes visible', async () => {
    const { provider } = await createSidebarProviderInstance();
    const panel = createPanel();
    panel.panel.visible = false;

    await provider.deserializeWebviewPanel(panel.panel as never, {
      'varro.lastOpenedView': { type: 'session', sessionId: 'session-1', timestamp: 1 },
    });

    expect(panel.panel.webview.html).toContain('--vscode-editor-background');
    expect(panel.panel.webview.html).not.toContain('webview.mjs');
  });
});
