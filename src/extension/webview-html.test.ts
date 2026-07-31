import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialWebviewState } from '../shared/protocol';

const randomBytesMock = vi.hoisted(() => vi.fn(() => Buffer.from('fixed-nonce')));

vi.mock('crypto', () => ({
  default: { randomBytes: randomBytesMock },
  randomBytes: randomBytesMock,
}));

import { renderWebviewHtml, renderWebviewLoadingHtml } from './webview-html';

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
      scriptUri: 'webview://assets/webview.js',
      cssUri: 'webview://assets/webview.css',
    });

    expect(html).toContain('<link rel="stylesheet" href="webview://assets/webview.css" />');
    expect(html).toContain('role="status" aria-label="Loading workspace"');
    expect(html).toContain('Loading workspace...');
    expect(html).toContain('src="webview://assets/webview.js"');
    expect(html).toContain('window.__initialTheme = window.__initialWebviewState.theme;');
    expect(html).toContain(
      'window.__sendToExtension = function(msg) { vscode.postMessage(msg); };'
    );
    expect(html).toContain('window.__vscodeWebviewState = {');
    expect(html).toContain('getState: function() { return vscode.getState() || {}; }');
    expect(html).toContain('setState: function(state) { vscode.setState(state); }');
    expect(html).toContain('"emptyStateLogoUri":"\\u003C/script\\u003E\\u0026\\u2028\\u2029"');
    expect(html).toContain("window.addEventListener('error', handleFailure);");
    expect(html).toContain("window.addEventListener('unhandledrejection', handleFailure);");
    expect(html).toContain('window.__clearVarroBootstrapFailureHandlers = clearHandlers;');
    expect(html).toContain("typeof window.__cleanupVarroBridge === 'function'");
    expect(html.indexOf('window.__clearVarroBootstrapFailureHandlers')).toBeLessThan(
      html.indexOf('src="webview://assets/webview.js"')
    );
    expect(html.indexOf('Loading workspace...')).toBeLessThan(
      html.indexOf('src="webview://assets/webview.js"')
    );
  });

  it('renders a standalone loading screen before the webview assets are available', () => {
    const html = renderWebviewLoadingHtml();

    expect(html).toContain('role="status" aria-label="Loading workspace"');
    expect(html).toContain('Loading workspace...');
    expect(html).toContain('Restoring your recent view');
    expect(html).toContain('html > body { padding: 0; }');
    expect(html).not.toContain('<script');
  });

  it('restricts image sources to the webview and data URIs', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptUri: 'webview.js',
      cssUri: 'webview.css',
    });
    const imgSrc = html.match(/img-src ([^;]+);/)?.[1];

    expect(imgSrc).toBe('vscode-webview-resource: data:');
  });

  it('reuses the same nonce in the CSP and both inline script tags', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptUri: 'webview.js',
      cssUri: 'webview.css',
    });
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];

    expect(randomBytesMock).toHaveBeenCalledWith(24);
    expect(nonce).toBe('Zml4ZWQtbm9uY2U');
    expect(html.split(`nonce="${nonce}"`).length - 1).toBe(2);
  });

  it('escapes webview asset URIs used in attributes', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptUri: 'webview.js?value="<unsafe>&',
      cssUri: 'webview.css?value="<unsafe>&',
    });

    expect(html).toContain('src="webview.js?value=&quot;&lt;unsafe>&amp;"');
    expect(html).toContain('href="webview.css?value=&quot;&lt;unsafe>&amp;"');
  });
});
