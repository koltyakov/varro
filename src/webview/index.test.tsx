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
vi.mock('@solidjs/web', () => ({ render: mocks.render }));
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

  it('leaves root sizing to CSS instead of pinning it to resize-event pixels', () => {
    vi.useFakeTimers();
    let width = 360;
    const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    root.style.maxWidth = '90%';
    try {
      cleanup = bootstrap(root);
      expect(root.style.maxWidth).toBe('90%');
      width = 486;
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('90%');
      vi.advanceTimersToNextFrame();
      expect(root.style.maxWidth).toBe('90%');
      width = 720;
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('90%');
      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();
      expect(root.style.maxWidth).toBe('90%');
      width = 360;
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('90%');
      width = 486;
      window.dispatchEvent(new Event('resize'));
      cleanup();
      cleanup = undefined;
      vi.runAllTimers();
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('90%');
    } finally {
      cleanup?.();
      cleanup = undefined;
      widthSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['sidebar', 'editor'] as const)(
    'does not introduce a pixel width cap across %s layout breakpoints',
    (surface) => {
      vi.useFakeTimers();
      let width = 486;
      const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
      bootstrapWindow.__initialWebviewState = {
        webviewContext: { viewId: `${surface}-1`, surface },
      };
      try {
        cleanup = bootstrap(root);
        for (const expandedWidth of [1280, 1670]) {
          // Ordinary drags and breakpoint changes must both use the current host width.
          width = 600;
          window.dispatchEvent(new Event('resize'));
          expect(root.style.maxWidth).toBe('');
          width = expandedWidth;
          window.dispatchEvent(new Event('resize'));
          expect(root.style.maxWidth).toBe('');
          width = 486;
          window.dispatchEvent(new Event('resize'));
          expect(root.style.maxWidth).toBe('');
          vi.runAllTimers();
          expect(root.style.maxWidth).toBe('');
        }
        width = 1280;
        window.dispatchEvent(new Event('resize'));
        width = 1670;
        window.dispatchEvent(new Event('resize'));
        expect(root.style.maxWidth).toBe('');
      } finally {
        cleanup?.();
        cleanup = undefined;
        widthSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it.each(['sidebar', 'editor'] as const)(
    'does not pin %s CSS sizing to hidden viewport widths',
    (surface) => {
      vi.useFakeTimers();
      let width = 420;
      let visibilityState: DocumentVisibilityState = 'visible';
      const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
      const visibilityStateSpy = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockImplementation(() => visibilityState);
      bootstrapWindow.__initialWebviewState = {
        webviewContext: { viewId: `${surface}-1`, surface },
      };
      root.style.maxWidth = '90%';
      try {
        cleanup = bootstrap(root);
        visibilityState = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        for (const hiddenWidth of [270, 0]) {
          width = hiddenWidth;
          window.dispatchEvent(new Event('resize'));
          expect(root.style.maxWidth).toBe('90%');
        }

        width = 486;
        window.dispatchEvent(new Event('resize'));
        visibilityState = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        expect(root.style.maxWidth).toBe('90%');
        window.dispatchEvent(new Event('resize'));
        expect(root.style.maxWidth).toBe('90%');
        vi.runAllTimers();
        expect(root.style.maxWidth).toBe('90%');

        cleanup();
        cleanup = undefined;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(root.style.maxWidth).toBe('90%');
      } finally {
        cleanup?.();
        cleanup = undefined;
        widthSpy.mockRestore();
        visibilityStateSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it('keeps CSS sizing on reveal without requiring a resize event', () => {
    vi.useFakeTimers();
    let width = 270;
    let visibilityState: DocumentVisibilityState = 'visible';
    const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    const visibilityStateSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    try {
      cleanup = bootstrap(root);
      width = 420;
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersToNextFrame();
      expect(root.style.maxWidth).toBe('');

      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      width = 0;
      vi.runAllTimers();
      expect(root.style.maxWidth).toBe('');

      width = 420;
      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(root.style.maxWidth).toBe('');
    } finally {
      cleanup?.();
      cleanup = undefined;
      widthSpy.mockRestore();
      visibilityStateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([420, 486])(
    'does not retain an unsized iframe width when reattached at %i without a visibility event',
    (restoredWidth) => {
      vi.useFakeTimers();
      let width = 420;
      let height = 794;
      const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
      const heightSpy = vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
      const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      try {
        cleanup = bootstrap(root);
        width = 300;
        height = 150;
        window.dispatchEvent(new Event('resize'));
        expect(root.style.maxWidth).toBe('');

        width = restoredWidth;
        height = 794;
        window.dispatchEvent(new Event('resize'));
        expect(root.style.maxWidth).toBe('');
        vi.runAllTimers();
        expect(root.style.maxWidth).toBe('');

        // A real narrow sidebar is not the browser's unsized iframe viewport.
        width = 300;
        window.dispatchEvent(new Event('resize'));
        expect(root.style.maxWidth).toBe('');
        width = 420;
        window.dispatchEvent(new Event('resize'));
        expect(root.style.maxWidth).toBe('');
        vi.runAllTimers();
        expect(root.style.maxWidth).toBe('');
      } finally {
        cleanup?.();
        cleanup = undefined;
        widthSpy.mockRestore();
        heightSpy.mockRestore();
        visibilitySpy.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it('never pins expansion or initial attachment to the unsized iframe width', () => {
    vi.useFakeTimers();
    let width = 300;
    let height = 150;
    const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    const heightSpy = vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
    try {
      cleanup = bootstrap(root);
      width = 420;
      height = 794;
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('');

      width = 486;
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersToNextFrame();
      expect(root.style.maxWidth).toBe('');
      width = 300;
      height = 150;
      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('visibilitychange'));
      vi.runAllTimers();
      expect(root.style.maxWidth).toBe('');

      width = 486;
      height = 794;
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('');
    } finally {
      cleanup?.();
      cleanup = undefined;
      widthSpy.mockRestore();
      heightSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not pin CSS sizing during zoom after expansion', () => {
    vi.useFakeTimers();
    let width = 360;
    let ratio = 1;
    const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    const ratioSpy = vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => ratio);
    try {
      cleanup = bootstrap(root);
      width = 486;
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersToNextFrame();
      ratio = 0.8;
      width = 607;
      window.dispatchEvent(new Event('resize'));
      expect(root.style.maxWidth).toBe('');
      vi.runAllTimers();
      expect(root.style.maxWidth).toBe('');
    } finally {
      cleanup?.();
      cleanup = undefined;
      widthSpy.mockRestore();
      ratioSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['startup', 'reveal'] as const)(
    'bounds editor layout hiding during continuous resizing on %s',
    (phase) => {
      vi.useFakeTimers();
      let visibilityState: DocumentVisibilityState = 'visible';
      let width = 486;
      const visibilitySpy = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockImplementation(() => visibilityState);
      const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
      bootstrapWindow.__initialWebviewState = {
        webviewContext: { viewId: 'editor-1', surface: 'editor' },
      };
      const isPending = () =>
        document.documentElement.classList.contains('varro-editor-layout-pending');
      try {
        cleanup = bootstrap(root);
        if (phase === 'reveal') {
          vi.advanceTimersByTime(100);
          expect(isPending()).toBe(false);
          visibilityState = 'hidden';
          document.dispatchEvent(new Event('visibilitychange'));
          visibilityState = 'visible';
          document.dispatchEvent(new Event('visibilitychange'));
        }
        for (let step = 0; step < 12; step++) {
          width -= 2;
          window.dispatchEvent(new Event('resize'));
          vi.advanceTimersByTime(20);
          expect(isPending()).toBe(true);
          expect(root.style.maxWidth).toBe('');
        }
        vi.advanceTimersByTime(10);
        expect(isPending()).toBe(false);
        // Later resize events must neither hide the editor again nor stop width tracking.
        for (let step = 0; step < 100; step++) {
          width -= 1;
          window.dispatchEvent(new Event('resize'));
          vi.advanceTimersByTime(20);
          expect(isPending()).toBe(false);
          expect(root.style.maxWidth).toBe('');
        }
      } finally {
        cleanup?.();
        cleanup = undefined;
        visibilitySpy.mockRestore();
        widthSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it('cancels the editor reveal deadline while hidden and starts a fresh deadline on return', () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = 'visible';
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    bootstrapWindow.__initialWebviewState = {
      webviewContext: { viewId: 'editor-1', surface: 'editor' },
    };
    const isPending = () =>
      document.documentElement.classList.contains('varro-editor-layout-pending');
    try {
      cleanup = bootstrap(root);
      vi.advanceTimersByTime(40);
      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(1000);
      expect(isPending()).toBe(true);

      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      for (let step = 0; step < 12; step++) {
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(20);
        expect(isPending()).toBe(true);
      }
      vi.advanceTimersByTime(10);
      expect(isPending()).toBe(false);

      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(isPending()).toBe(true);
      cleanup();
      cleanup = undefined;
      const removeSpy = vi.spyOn(document.documentElement.classList, 'remove');
      try {
        window.dispatchEvent(new Event('resize'));
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(1000);
        expect(isPending()).toBe(false);
        expect(removeSpy).not.toHaveBeenCalled();
      } finally {
        removeSpy.mockRestore();
      }
    } finally {
      cleanup?.();
      cleanup = undefined;
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
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
