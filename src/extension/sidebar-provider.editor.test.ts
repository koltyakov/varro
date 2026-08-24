/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- The panel fixture implements the VS Code host boundary and inspects private lifecycle state used by these tests. */
import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';
import type { DroppedFile, QueuedMessageSnapshot } from '../shared/protocol';

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
    expect(posted).toContainEqual({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: [] },
    });

    editor.panel.webview.html = '<p>visible editor document</p>';

    editor.setVisible(false);
    expect(editor.panel.webview.html).toBe('<p>visible editor document</p>');

    editor.setVisible(true);
    expect(editor.panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(2);

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
      ['varro.interruptedSessions', [{ id: 'session-1', title: 'Interrupted' }]],
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
      { id: 'session-1', title: 'Interrupted' },
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

  it('redelivers an unacknowledged recovery claim after the webview reloads', async () => {
    const storage = new Map<string, unknown>([
      ['varro.interruptedSessions', [{ id: 'session-1', title: 'Interrupted' }]],
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
      { id: 'session-1', title: 'Interrupted' },
    ]);
    await provider.dispose();
  });

  it('retains failed recovery work without retrying until the webview reloads', async () => {
    const storage = new Map<string, unknown>([
      ['varro.interruptedSessions', [{ id: 'session-1', title: 'Interrupted' }]],
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
        { id: 'session-1', title: 'Interrupted' },
      ])
    );
    expect(storage.get('varro.interruptedSessions')).toEqual([
      { id: 'session-1', title: 'Interrupted' },
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
