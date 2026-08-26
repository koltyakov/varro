import { render } from 'solid-js/web';
import { AppRoot } from './App';
import { cleanupBridge, initializeBridge, postMessage } from './lib/bridge';
// oxlint-disable-next-line no-unassigned-import
import './index.css';
import { applyChatFontConfig } from './lib/chat-font-config';
import { isFunction } from './lib/runtime-values';
import { readInitialWebviewState } from './lib/state-stored-values';

const STARTUP_HANDLERS_KEY = '__clearVarroBootstrapFailureHandlers';
const APP_CLEANUP_KEY = '__cleanupVarroApp';
const EDITOR_SURFACE_CLASS = 'varro-editor-surface';
const EDITOR_LAYOUT_PENDING_CLASS = 'varro-editor-layout-pending';
const EDITOR_LAYOUT_SETTLE_MS = 50;
type BootstrapWindow = Window & {
  __clearVarroBootstrapFailureHandlers?: () => void;
  __cleanupVarroApp?: () => void;
};
// SAFETY: The bootstrap script may install this optional cleanup callback on window.
const bootstrapWindow = window as BootstrapWindow;

function logWebviewError<T>(message: string, error: T) {
  // oxlint-disable-next-line no-console
  console.error(message, error);
}

function clearStartupHandlers() {
  const clear = bootstrapWindow[STARTUP_HANDLERS_KEY];
  if (isFunction(clear)) clear();
  if (bootstrapWindow[STARTUP_HANDLERS_KEY] === clear) {
    delete bootstrapWindow[STARTUP_HANDLERS_KEY];
  }
}

function cleanupBridgeSafe() {
  try {
    cleanupBridge();
  } catch (error) {
    logWebviewError('Varro webview bridge cleanup failed', error);
  }
}

function trackEditorLayoutSettling() {
  const html = document.documentElement;
  let settleTimer: number | undefined;
  let settleFrame: number | undefined;

  const cancelSettle = () => {
    if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame);
    settleTimer = undefined;
    settleFrame = undefined;
  };
  const settle = () => {
    cancelSettle();
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined;
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = undefined;
        html.classList.remove(EDITOR_LAYOUT_PENDING_CLASS);
      });
    }, EDITOR_LAYOUT_SETTLE_MS);
  };
  const handleVisibilityChange = () => {
    cancelSettle();
    html.classList.add(EDITOR_LAYOUT_PENDING_CLASS);
    if (document.visibilityState !== 'hidden') settle();
  };
  const handleResize = () => {
    if (html.classList.contains(EDITOR_LAYOUT_PENDING_CLASS)) settle();
  };

  html.classList.add(EDITOR_LAYOUT_PENDING_CLASS);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('resize', handleResize);
  if (document.visibilityState !== 'hidden') settle();

  return () => {
    cancelSettle();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('resize', handleResize);
    html.classList.remove(EDITOR_LAYOUT_PENDING_CLASS);
  };
}

export function showBootstrapFailure(root: HTMLElement) {
  const fallback = document.createElement('div');
  fallback.setAttribute('role', 'alert');
  fallback.style.cssText =
    'box-sizing:border-box;display:flex;min-height:100vh;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font-family:system-ui,sans-serif;color:var(--vscode-errorForeground,#f48771);background:var(--vscode-sideBar-background,#181818)';

  const title = document.createElement('strong');
  title.textContent = 'Something went wrong';
  const message = document.createElement('span');
  message.textContent = 'Varro could not start. Reload the sidebar to try again.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload sidebar';
  button.addEventListener('click', () => postMessage({ type: 'webview/reload' }));
  fallback.append(title, message, button);
  root.replaceChildren(fallback);
}

export function bootstrap(root: HTMLElement) {
  const initialState = readInitialWebviewState();
  const isEditorSurface = initialState.webviewContext?.surface === 'editor';
  if (
    initialState.chatFontSize !== undefined &&
    initialState.chatEditorFontSize !== undefined &&
    initialState.chatFontFamily !== undefined
  ) {
    applyChatFontConfig({
      chatFontSize: initialState.chatFontSize,
      chatEditorFontSize: initialState.chatEditorFontSize,
      chatFontFamily: initialState.chatFontFamily,
    });
  }
  document.documentElement.classList.toggle(EDITOR_SURFACE_CLASS, isEditorSurface);
  const stopTrackingEditorLayout = isEditorSurface ? trackEditorLayoutSettling() : undefined;
  let dispose: (() => void) | undefined;
  let failed = false;
  const disposeWebview = () => {
    try {
      dispose?.();
    } catch (error) {
      logWebviewError('Varro webview disposal failed', error);
    }
    dispose = undefined;
    cleanupBridgeSafe();
  };
  const fail = <T,>(error: T) => {
    if (failed) return;
    failed = true;
    logWebviewError('Varro webview bootstrap failed', error);
    try {
      clearStartupHandlers();
    } catch (cleanupError) {
      logWebviewError('Varro webview startup handler cleanup failed', cleanupError);
    }
    disposeWebview();
    showBootstrapFailure(root);
  };

  try {
    root.replaceChildren();
    dispose = render(() => <AppRoot />, root);
    clearStartupHandlers();
  } catch (error) {
    fail(error);
  }

  return () => {
    try {
      clearStartupHandlers();
    } catch (error) {
      logWebviewError('Varro webview startup handler cleanup failed', error);
    }
    disposeWebview();
    stopTrackingEditorLayout?.();
    document.documentElement.classList.remove(EDITOR_SURFACE_CLASS);
  };
}

export function bootstrapWebview(root: HTMLElement | null) {
  if (root) return bootstrap(root);

  logWebviewError('Varro webview bootstrap failed', new Error('Webview root element not found'));
  try {
    clearStartupHandlers();
  } catch (error) {
    logWebviewError('Varro webview startup handler cleanup failed', error);
  }
  cleanupBridgeSafe();
  return undefined;
}

export function startWebview(root: HTMLElement | null) {
  bootstrapWindow[APP_CLEANUP_KEY]?.();
  initializeBridge();
  const cleanup = bootstrapWebview(root);
  if (!cleanup) {
    delete bootstrapWindow[APP_CLEANUP_KEY];
    return undefined;
  }
  const cleanupCurrentApp = () => {
    cleanup();
    if (bootstrapWindow[APP_CLEANUP_KEY] === cleanupCurrentApp) {
      delete bootstrapWindow[APP_CLEANUP_KEY];
    }
  };
  bootstrapWindow[APP_CLEANUP_KEY] = cleanupCurrentApp;
  return cleanupCurrentApp;
}

startWebview(document.getElementById('root'));
