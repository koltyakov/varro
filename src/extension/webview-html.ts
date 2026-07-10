import { randomBytes } from 'crypto';
import type { InitialWebviewState } from '../shared/protocol';

export type WebviewAssetContent = {
  scriptContent: string;
  cssContent: string;
};

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
  <style>${assets.cssContent}</style>
</head>
<body>
  <div id="root"></div>
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
