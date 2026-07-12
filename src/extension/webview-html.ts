import { randomBytes } from 'crypto';
import type { InitialWebviewState } from '../shared/protocol';

export type WebviewAssetContent = {
  scriptContent: string;
  cssContent: string;
};

const LOADING_STYLES = `
html, body, #root { width: 100%; height: 100%; margin: 0; }
body { background: var(--vscode-sideBar-background, #181818); }
.varro-startup-loading {
  box-sizing: border-box;
  display: flex;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px 32px;
  text-align: center;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  color: var(--vscode-foreground, #cccccc);
}
.varro-startup-dots { display: flex; gap: 8px; }
.varro-startup-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: var(--vscode-focusBorder, #007fd4);
  animation: varro-startup-pulse 1.5s ease-in-out infinite;
}
.varro-startup-dot:nth-child(2) { animation-delay: 0.3s; }
.varro-startup-dot:nth-child(3) { animation-delay: 0.6s; }
.varro-startup-title { margin: 0; font-size: 13px; font-weight: 500; }
.varro-startup-detail {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #999999);
  opacity: 0.7;
}
@keyframes varro-startup-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}`;

const LOADING_MARKUP = `<div class="varro-startup-loading" role="status" aria-label="Loading workspace">
    <div class="varro-startup-dots" aria-hidden="true">
      <span class="varro-startup-dot"></span>
      <span class="varro-startup-dot"></span>
      <span class="varro-startup-dot"></span>
    </div>
    <div>
      <p class="varro-startup-title">Loading workspace...</p>
      <p class="varro-startup-detail">Restoring your recent view</p>
    </div>
  </div>`;

export function renderWebviewLoadingHtml() {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>Varro</title>
  <style>${LOADING_STYLES}</style>
</head>
<body>
  <div id="root">${LOADING_MARKUP}</div>
</body>
</html>`;
}

export function renderWebviewHtml(
  cspSource: string,
  initialState: InitialWebviewState,
  assets: WebviewAssetContent
) {
  const nonce = randomNonce();
  const serializedInitialState = serializeForInlineScript(initialState);

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:;" />
  <title>Varro</title>
  <style>${LOADING_STYLES}\n${assets.cssContent}</style>
</head>
<body>
  <div id="root">${LOADING_MARKUP}</div>
  <script nonce="${nonce}">
    (function() {
      var active = true;
      var handleFailure = function(event) {
        if (!active) return;
        event.preventDefault();
        clearHandlers();
        try {
          if (typeof window.__cleanupVarroBridge === 'function') {
            window.__cleanupVarroBridge();
          }
        } catch {}
        var root = document.getElementById('root');
        if (!root) return;
        root.replaceChildren();
        var fallback = document.createElement('div');
        fallback.setAttribute('role', 'alert');
        fallback.style.cssText = 'box-sizing:border-box;display:flex;min-height:100vh;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font-family:system-ui,sans-serif;color:var(--vscode-errorForeground,#f48771);background:var(--vscode-sideBar-background,#181818)';
        var title = document.createElement('strong');
        title.textContent = 'Something went wrong';
        var message = document.createElement('span');
        message.textContent = 'Varro could not start. Reload the sidebar to try again.';
        fallback.append(title, message);
        root.append(fallback);
      };
      var clearHandlers = function() {
        if (!active) return;
        active = false;
        window.removeEventListener('error', handleFailure);
        window.removeEventListener('unhandledrejection', handleFailure);
        if (window.__clearVarroBootstrapFailureHandlers === clearHandlers) {
          delete window.__clearVarroBootstrapFailureHandlers;
        }
      };
      window.addEventListener('error', handleFailure);
      window.addEventListener('unhandledrejection', handleFailure);
      window.__clearVarroBootstrapFailureHandlers = clearHandlers;
    })();
    const vscode = acquireVsCodeApi();
    window.__initialWebviewState = ${serializedInitialState};
    window.__initialTheme = window.__initialWebviewState.theme;
    window.__sendToExtension = function(msg) { vscode.postMessage(msg); };
    window.__vscodeWebviewState = {
      getState: function() { return vscode.getState() || {}; },
      setState: function(state) { vscode.setState(state); },
    };
  </script>
  <script nonce="${nonce}">${assets.scriptContent}</script>
</body>
</html>`;
}

function randomNonce(): string {
  const bytes = randomBytes(24);
  return bytes.toString('base64url');
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003C';
      case '>':
        return '\\u003E';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
}
