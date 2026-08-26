import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const entryRoot = document.createElement('div');
  entryRoot.id = 'root';
  document.body.appendChild(entryRoot);
  return {
    cleanupBridge: vi.fn(),
    initializeBridge: vi.fn(),
    postMessage: vi.fn(() => true),
    clearStartupHandlers: vi.fn(),
    disposeSolid: vi.fn(),
    entryRoot,
    render: vi.fn<() => () => void>(),
  };
});

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise the webview entry module's integration boundaries. */
vi.mock('solid-js/web', () => ({ render: mocks.render }));
vi.mock('./App', () => ({ AppRoot: () => null }));
vi.mock('./lib/bridge', () => ({
  cleanupBridge: mocks.cleanupBridge,
  initializeBridge: mocks.initializeBridge,
  postMessage: mocks.postMessage,
}));

import { bootstrap, bootstrapWebview, startWebview } from './index';
import { fixture } from './test-fixtures';
import type { UnknownRecord } from '../shared/type-utils';

mocks.entryRoot.remove();

let root: HTMLDivElement;
let cleanup: (() => void) | undefined;
let consoleError: ReturnType<typeof vi.spyOn>;
const STARTUP_HANDLERS_KEY = '__clearVarroBootstrapFailureHandlers';
const APP_CLEANUP_KEY = '__cleanupVarroApp';
// SAFETY: The fixture provides the unknown fields read by this statement.
const bootstrapWindow = fixture<
  UnknownRecord & {
    __clearVarroBootstrapFailureHandlers?: () => void;
    __cleanupVarroApp?: () => void;
    __initialWebviewState?: unknown;
  }
>(window);

describe('webview bootstrap', () => {
  beforeEach(() => {
    bootstrapWindow[APP_CLEANUP_KEY]?.();
    delete bootstrapWindow[APP_CLEANUP_KEY];
    delete bootstrapWindow.__initialWebviewState;
    document.documentElement.classList.remove('varro-editor-surface');
    document.documentElement.classList.remove('varro-editor-layout-pending');
    document.documentElement.style.removeProperty('--varro-chat-font-size');
    document.documentElement.style.removeProperty('--varro-chat-editor-font-size');
    document.documentElement.style.removeProperty('--varro-chat-font-family');
    mocks.cleanupBridge.mockReset();
    mocks.initializeBridge.mockReset();
    mocks.postMessage.mockReset().mockReturnValue(true);
    mocks.clearStartupHandlers.mockReset();
    mocks.disposeSolid.mockReset();
    mocks.render.mockReset();
    mocks.render.mockReturnValue(mocks.disposeSolid);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bootstrapWindow[STARTUP_HANDLERS_KEY] = mocks.clearStartupHandlers;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    root.remove();
    delete bootstrapWindow[STARTUP_HANDLERS_KEY];
    delete bootstrapWindow[APP_CLEANUP_KEY];
    delete bootstrapWindow.__initialWebviewState;
    document.documentElement.classList.remove('varro-editor-surface');
    document.documentElement.classList.remove('varro-editor-layout-pending');
    document.documentElement.style.removeProperty('--varro-chat-font-size');
    document.documentElement.style.removeProperty('--varro-chat-editor-font-size');
    document.documentElement.style.removeProperty('--varro-chat-font-family');
    consoleError.mockRestore();
  });

  it('renders a fallback when the initial render throws', () => {
    const error = new Error('boot failed');
    mocks.render.mockImplementationOnce(() => {
      throw error;
    });

    cleanup = bootstrap(root);

    expect(root.textContent).toContain('Something went wrong');
    expect(root.textContent).not.toContain('boot failed');
    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('Varro webview bootstrap failed', error);

    root.querySelector<HTMLButtonElement>('button')?.click();
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: 'webview/reload' });
  });

  it('marks editor webviews before rendering and removes the marker on cleanup', () => {
    bootstrapWindow.__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    };

    cleanup = bootstrap(root);

    expect(document.documentElement.classList.contains('varro-editor-surface')).toBe(true);
    cleanup();
    cleanup = undefined;
    expect(document.documentElement.classList.contains('varro-editor-surface')).toBe(false);
  });

  it('applies initial chat font properties before rendering', () => {
    bootstrapWindow.__initialWebviewState = {
      chatFontSize: 15.5,
      chatEditorFontSize: 14,
      chatFontFamily: 'Iosevka, monospace',
    };

    cleanup = bootstrap(root);

    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe(
      '15.5px'
    );
    expect(document.documentElement.style.getPropertyValue('--varro-chat-editor-font-size')).toBe(
      '14px'
    );
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe(
      'Iosevka, monospace'
    );
  });

  it('hides editor content until a revealed tab finishes resizing', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    const visibilityStateSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    bootstrapWindow.__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    };

    cleanup = bootstrap(root);
    expect(document.documentElement.classList.contains('varro-editor-layout-pending')).toBe(true);
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains('varro-editor-layout-pending')).toBe(
        false
      );
    });

    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.classList.contains('varro-editor-layout-pending')).toBe(true);

    visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains('varro-editor-layout-pending')).toBe(
        false
      );
    });
    visibilityStateSpy.mockRestore();
  });

  it('logs and cleans up safely when the root element is missing', () => {
    const result = bootstrapWebview(null);

    expect(result).toBeUndefined();
    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      'Varro webview bootstrap failed',
      expect.objectContaining({ message: 'Webview root element not found' })
    );
  });

  it('clears startup handlers without cleaning up after a successful render', () => {
    cleanup = bootstrap(root);

    expect(mocks.clearStartupHandlers).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).not.toHaveBeenCalled();
    expect(mocks.disposeSolid).not.toHaveBeenCalled();
  });

  it('does not retain global startup handlers during normal actions', () => {
    cleanup = bootstrap(root);

    window.dispatchEvent(new Event('error', { cancelable: true }));
    window.dispatchEvent(new Event('unhandledrejection', { cancelable: true }));

    expect(root.textContent).not.toContain('Something went wrong');
    expect(mocks.cleanupBridge).not.toHaveBeenCalled();
  });

  it('cleans up Solid and the bridge during normal bootstrap disposal', () => {
    cleanup = bootstrap(root);
    cleanup();
    cleanup = undefined;

    expect(mocks.disposeSolid).toHaveBeenCalledOnce();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
  });

  it('disposes the previous app before bootstrapping again in the same document', () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    mocks.render.mockReturnValueOnce(firstDispose).mockReturnValueOnce(secondDispose);

    startWebview(root);
    cleanup = startWebview(root);

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
    expect(mocks.initializeBridge).toHaveBeenCalledTimes(2);
  });

  it('logs disposal errors and still cleans up the bridge', () => {
    const error = new Error('dispose failed');
    mocks.disposeSolid.mockImplementationOnce(() => {
      throw error;
    });
    cleanup = bootstrap(root);

    cleanup();
    cleanup = undefined;

    expect(consoleError).toHaveBeenCalledWith('Varro webview disposal failed', error);
    expect(mocks.cleanupBridge).toHaveBeenCalledOnce();
  });

  it('logs bridge cleanup errors after rendering the safe fallback', () => {
    const bootError = new Error('boot failed');
    const cleanupError = new Error('bridge cleanup failed');
    mocks.render.mockImplementationOnce(() => {
      throw bootError;
    });
    mocks.cleanupBridge.mockImplementationOnce(() => {
      throw cleanupError;
    });

    cleanup = bootstrap(root);

    expect(root.textContent).toContain('Something went wrong');
    expect(root.textContent).not.toContain('boot failed');
    expect(consoleError).toHaveBeenCalledWith('Varro webview bridge cleanup failed', cleanupError);
  });
});
