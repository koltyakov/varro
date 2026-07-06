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
