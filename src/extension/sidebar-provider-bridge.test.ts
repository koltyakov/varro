/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- These bridge tests verify module wiring and inspect controlled provider internals. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialWebviewState } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  logger: { warn: vi.fn() },
  renderWebviewHtml: vi.fn(() => '<html />'),
  readFileSync: vi.fn(() => '0123456789abcdef'),
  joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({
    fsPath: [base.fsPath, ...parts].join('/'),
  })),
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));
vi.mock('node:fs', () => ({
  default: { readFileSync: mocks.readFileSync },
  readFileSync: mocks.readFileSync,
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
    chatFontSize: 13,
    chatEditorFontSize: 12,
    chatFontFamily: 'default',
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

  it('reports failed webview deliveries', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockResolvedValue(false);
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(view as never);

    bridge.post({ type: 'command/focus-input' });
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Webview message was not delivered: command/focus-input'
    );
  });

  it('ignores a held delivery failure from a replaced view', async () => {
    let finishDelivery!: (delivered: boolean) => void;
    const delivery = new Promise<boolean>((resolve) => {
      finishDelivery = resolve;
    });
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const first = createView();
    const replacement = createView();
    first.webview.postMessage.mockReturnValue(delivery);
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(first as never);

    bridge.post({ type: 'command/focus-input' });
    bridge.setView(replacement as never);
    finishDelivery(false);
    await delivery;
    await Promise.resolve();

    expect(bridge.getView()).toBe(replacement);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('ignores a held delivery failure after the current view is suspended', async () => {
    let finishDelivery!: (delivered: boolean) => void;
    const delivery = new Promise<boolean>((resolve) => {
      finishDelivery = resolve;
    });
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockReturnValue(delivery);
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(view as never);

    bridge.post({ type: 'command/focus-input' });
    bridge.invalidatePendingDeliveries();
    finishDelivery(false);
    await delivery;
    await Promise.resolve();

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('bounds pending deliveries when the webview stops acknowledging messages', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockReturnValue(new Promise(() => {}));
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(view as never);

    for (let index = 0; index < 1_000; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }

    expect(view.webview.postMessage).toHaveBeenCalledTimes(512);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('keeps an overflowed document closed until a fresh document reports ready', async () => {
    const delivery = createDeferred<boolean>();
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockReturnValue(delivery.promise);
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(view as never);

    for (let index = 0; index < 513; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }
    delivery.resolve(true);
    await delivery.promise;
    await Promise.resolve();

    bridge.post({ type: 'command/focus-input' });
    expect(view.webview.postMessage).toHaveBeenCalledTimes(512);

    bridge.markViewReady();
    view.webview.postMessage.mockReturnValue(Promise.resolve(true));
    bridge.post({ type: 'command/focus-input' });
    expect(view.webview.postMessage).toHaveBeenCalledTimes(513);
  });

  it('does not count synchronous or void deliveries as pending', () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(view as never);

    for (let index = 0; index < 1_000; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }
    view.webview.postMessage.mockReturnValue(true);
    for (let index = 0; index < 1_000; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }

    expect(view.webview.postMessage).toHaveBeenCalledTimes(2_000);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('keeps the same view poisoned across invalidation and reassignment', () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockReturnValue(new Promise(() => {}));
    bridge.setView(view as never);

    for (let index = 0; index < 513; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }
    bridge.invalidatePendingDeliveries();
    bridge.setView(view as never);
    bridge.post({ type: 'command/focus-input' });

    expect(view.webview.postMessage).toHaveBeenCalledTimes(512);
  });

  it('counts reliable deliveries against the same bound', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockReturnValue(new Promise(() => {}));
    bridge.setView(view as never);

    for (let index = 0; index < 512; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }

    await expect(bridge.deliver({ type: 'command/focus-input' })).resolves.toBe(false);
    expect(view.webview.postMessage).toHaveBeenCalledTimes(512);
  });

  it('does not treat a void host shim as a reliable acknowledgement', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    bridge.setView(view as never);

    await expect(bridge.deliver({ type: 'command/focus-input' })).resolves.toBe(false);
  });

  it('contains errors thrown by the delivery failure handler', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockResolvedValue(false);
    bridge.onDeliveryFailure(() => {
      throw new Error('recovery failed');
    });
    bridge.setView(view as never);

    bridge.post({ type: 'command/focus-input' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Webview delivery failure handler failed: recovery failed'
    );
  });

  it('delivers a healthy same-turn burst without forcing recovery', async () => {
    const bridge = new SidebarProviderBridge({ fsPath: '/extension' } as never);
    const view = createView();
    view.webview.postMessage.mockResolvedValue(true);
    const onFailure = vi.fn();
    bridge.onDeliveryFailure(onFailure);
    bridge.setView(view as never);

    for (let index = 0; index < 256; index += 1) {
      bridge.post({ type: 'command/focus-input' });
    }

    await vi.waitFor(() => expect(view.webview.postMessage).toHaveBeenCalledTimes(256));
    expect(onFailure).not.toHaveBeenCalled();
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
      scriptUri: 'webview:/extension/dist/webview/webview.mjs',
      cssUri: 'webview:/extension/dist/webview/webview.css',
      version: '0123456789abcdef',
    });
    expect(mocks.renderWebviewHtml).toHaveBeenNthCalledWith(2, 'csp-source', nextState, {
      scriptUri: 'webview:/extension/dist/webview/webview.mjs',
      cssUri: 'webview:/extension/dist/webview/webview.css',
      version: '0123456789abcdef',
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
