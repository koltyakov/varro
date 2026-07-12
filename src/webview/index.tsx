import { render } from 'solid-js/web';
import { AppRoot } from './App';
import { cleanupBridge } from './lib/bridge';
// oxlint-disable-next-line no-unassigned-import
import './index.css';

const STARTUP_HANDLERS_KEY = '__clearVarroBootstrapFailureHandlers';

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
  button.addEventListener('click', () => window.location.reload());
  fallback.append(title, message, button);
  root.replaceChildren(fallback);
}

export function bootstrap(root: HTMLElement) {
  let dispose: (() => void) | undefined;
  let failed = false;
  const bootstrapWindow = window as unknown as Record<string, unknown>;
  const clearStartupHandlers = () => {
    const clear = bootstrapWindow[STARTUP_HANDLERS_KEY];
    if (typeof clear === 'function') clear();
    if (bootstrapWindow[STARTUP_HANDLERS_KEY] === clear) {
      delete bootstrapWindow[STARTUP_HANDLERS_KEY];
    }
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    clearStartupHandlers();
    try {
      dispose?.();
    } catch {}
    dispose = undefined;
    cleanupBridge();
    showBootstrapFailure(root);
  };

  try {
    root.replaceChildren();
    dispose = render(() => <AppRoot />, root);
    clearStartupHandlers();
  } catch {
    fail();
  }

  return () => {
    clearStartupHandlers();
    try {
      dispose?.();
    } finally {
      dispose = undefined;
      cleanupBridge();
    }
  };
}

const root = document.getElementById('root');
if (root) bootstrap(root);
