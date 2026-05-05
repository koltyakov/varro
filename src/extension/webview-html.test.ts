import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialWebviewState } from '../shared/protocol';

const randomBytesMock = vi.hoisted(() => vi.fn(() => Buffer.from('fixed-nonce')));

vi.mock('crypto', () => ({
  default: { randomBytes: randomBytesMock },
  randomBytes: randomBytesMock,
}));

import { renderWebviewHtml } from './webview-html';

const initialState: InitialWebviewState = {
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
  emptyStateLogoUri: '</script>&\u2028\u2029',
};

describe('renderWebviewHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('escapes inline state and injects the webview bootstrap assets', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptContent: 'console.log("ready")',
      cssContent: 'body{color:red;}',
    });

    expect(html).toContain('<style>body{color:red;}</style>');
    expect(html).toContain('console.log("ready")');
    expect(html).toContain('window.__initialTheme = window.__initialWebviewState.theme;');
    expect(html).toContain(
      'window.__sendToExtension = function(msg) { vscode.postMessage(msg); };'
    );
    expect(html).toContain('window.__vscodeWebviewState = {');
    expect(html).toContain('getState: function() { return vscode.getState() || {}; }');
    expect(html).toContain('setState: function(state) { vscode.setState(state); }');
    expect(html).toContain('"emptyStateLogoUri":"\\u003C/script\\u003E\\u0026\\u2028\\u2029"');
  });

  it('reuses the same nonce in the CSP and both inline script tags', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptContent: 'console.log("ready")',
      cssContent: '',
    });
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];

    expect(randomBytesMock).toHaveBeenCalledWith(24);
    expect(nonce).toBe('Zml4ZWQtbm9uY2U');
    expect(html.split(`nonce="${nonce}"`).length - 1).toBe(2);
  });
});
