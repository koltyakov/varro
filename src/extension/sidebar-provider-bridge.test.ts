import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialWebviewState } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  renderWebviewHtml: vi.fn(() => '<html />'),
  joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({
    fsPath: [base.fsPath, ...parts].join('/'),
  })),
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: mocks.joinPath,
  },
}));

vi.mock('./webview-html', () => ({
  renderWebviewHtml: mocks.renderWebviewHtml,
}));

import { SidebarProviderBridge } from './sidebar-provider-bridge';

function createInitialState(): InitialWebviewState {
  return {
    theme: 'dark',
    serverStatus: { state: 'running', url: 'http://127.0.0.1:4096' },
    editorContext: {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    },
    terminalSelection: null,
    droppedFiles: [],
    emptyStateLogoUri: 'logo://icon',
  };
}

function createView(options?: { visible?: boolean; cspSource?: string }) {
  return {
    visible: options?.visible ?? true,
    webview: {
      cspSource: options?.cspSource ?? 'vscode-webview-resource:',
      postMessage: vi.fn(),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      })),
    },
  };
}

describe('SidebarProviderBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.renderWebviewHtml.mockReturnValue('<html />');
  });

  it('tracks the current view and routes outbound webview messages', () => {
    const extensionUri = { fsPath: '/extension' };
    const bridge = new SidebarProviderBridge(extensionUri as never);

    expect(bridge.getView()).toBeUndefined();
    expect(bridge.isVisible()).toBe(false);
    expect(bridge.emptyStateLogoUri()).toBeUndefined();

    bridge.post({ type: 'server.status', status: { state: 'stopped' } } as never);

    const hiddenView = createView({ visible: false });
    bridge.setView(hiddenView as never);
    expect(bridge.isVisible()).toBe(false);

    const visibleView = createView({ visible: true });
    bridge.setView(visibleView as never);

    const message = { type: 'server.status', status: { state: 'stopped' } } as never;
    bridge.post(message);

    expect(bridge.getView()).toBe(visibleView);
    expect(bridge.isVisible()).toBe(true);
    expect(visibleView.webview.postMessage).toHaveBeenCalledWith(message);
    expect(bridge.emptyStateLogoUri()).toBe('webview:/extension/assets/icon.png');
    expect(mocks.joinPath).toHaveBeenCalledWith(extensionUri, 'assets', 'icon.png');
    expect(visibleView.webview.asWebviewUri).toHaveBeenCalledWith({
      fsPath: '/extension/assets/icon.png',
    });
  });

  it('returns the expected webview options', () => {
    const extensionUri = { fsPath: '/extension' };
    const bridge = new SidebarProviderBridge(extensionUri as never);

    expect(bridge.webviewOptions()).toEqual({
      enableScripts: true,
      localResourceRoots: [extensionUri],
    });
  });

  it('renders with cacheable webview asset URIs', async () => {
    const extensionUri = { fsPath: '/extension' };
    const bridge = new SidebarProviderBridge(extensionUri as never);
    const view = createView({ cspSource: 'csp-source' });
    const initialState = createInitialState();
    const nextState = { ...initialState, theme: 'light' } satisfies InitialWebviewState;

    bridge.setView(view as never);
    mocks.renderWebviewHtml
      .mockReturnValueOnce('<html>first</html>')
      .mockReturnValueOnce('<html>second</html>');

    await expect(bridge.renderHtml(initialState)).resolves.toBe('<html>first</html>');
    await expect(bridge.renderHtml(nextState)).resolves.toBe('<html>second</html>');

    expect(mocks.renderWebviewHtml).toHaveBeenNthCalledWith(1, 'csp-source', initialState, {
      scriptUri: 'webview:/extension/dist/webview/webview.js',
      cssUri: 'webview:/extension/dist/webview/webview.css',
    });
    expect(mocks.renderWebviewHtml).toHaveBeenNthCalledWith(2, 'csp-source', nextState, {
      scriptUri: 'webview:/extension/dist/webview/webview.js',
      cssUri: 'webview:/extension/dist/webview/webview.css',
    });
    expect(view.webview.asWebviewUri).toHaveBeenCalledTimes(4);
    expect(mocks.joinPath).toHaveBeenCalledWith(extensionUri, 'dist', 'webview');
  });

  it('rejects rendering before a view is available', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);

    await expect(bridge.renderHtml(createInitialState())).rejects.toThrow(
      'Cannot render webview assets before the view is available'
    );
  });
});
