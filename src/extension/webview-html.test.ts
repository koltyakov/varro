/* oxlint-disable anti-slop/no-module-mocking -- These tests verify generated HTML against the imported VS Code URI and nonce boundaries. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialWebviewState } from '../shared/protocol';

const randomBytesMock = vi.hoisted(() => vi.fn(() => Buffer.from('fixed-nonce')));

vi.mock('crypto', () => ({
  default: { randomBytes: randomBytesMock },
  randomBytes: randomBytesMock,
}));

import {
  renderEditorWebviewPlaceholderHtml,
  renderWebviewHtml,
  renderWebviewLoadingHtml,
} from './webview-html';

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
  chatFontSize: 13,
  chatEditorFontSize: 12,
  chatFontFamily: 'default',
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

    expect(html).toContain(
      '<link rel="stylesheet" href="webview://assets/webview.css?v=Zml4ZWQtbm9uY2U" />'
    );
    expect(html).toContain('role="status" aria-label="Loading workspace"');
    expect(html).not.toContain('Loading workspace...');
    expect(html).toContain(
      '<script type="module" nonce="Zml4ZWQtbm9uY2U" src="webview://assets/webview.js?v=Zml4ZWQtbm9uY2U"></script>'
    );
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
    expect(html).toContain("if (event && 'reason' in event) failure = event.reason;");
    expect(html).toContain("console.error('Varro webview bootstrap failed', failure);");
    expect(html).toContain("console.error('Varro webview bridge cleanup failed', error);");
    expect(html).toContain('window.__clearVarroBootstrapFailureHandlers = clearHandlers;');
    expect(html).toContain("typeof window.__cleanupVarroBridge === 'function'");
    expect(html.indexOf('window.__clearVarroBootstrapFailureHandlers')).toBeLessThan(
      html.indexOf('src="webview://assets/webview.js?v=Zml4ZWQtbm9uY2U"')
    );
    expect(html.indexOf('role="status" aria-label="Loading workspace"')).toBeLessThan(
      html.indexOf('src="webview://assets/webview.js?v=Zml4ZWQtbm9uY2U"')
    );
  });

  it('marks editor webviews before their stylesheet loads', () => {
    const html = renderWebviewHtml(
      'vscode-webview-resource:',
      {
        ...initialState,
        webviewContext: {
          viewId: 'editor-1',
          surface: 'editor',
          initialRoute: { type: 'new-session' },
        },
      },
      { scriptUri: 'webview.js', cssUri: 'webview.css' }
    );

    expect(html).toContain(
      '<html lang="en" class="varro-editor-surface varro-editor-layout-pending">'
    );
  });

  it('does not mark sidebar webviews as editor surfaces', () => {
    const html = renderWebviewHtml(
      'vscode-webview-resource:',
      {
        ...initialState,
        webviewContext: {
          viewId: 'sidebar',
          surface: 'sidebar',
          initialRoute: { type: 'new-session' },
        },
      },
      { scriptUri: 'webview.js', cssUri: 'webview.css' }
    );

    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('class="varro-editor-surface"');
  });

  it('renders a standalone loading screen before the webview assets are available', () => {
    const html = renderWebviewLoadingHtml();

    expect(html).toContain('role="status" aria-label="Loading workspace"');
    expect(html).not.toContain('Loading workspace...');
    expect(html).not.toContain('Restoring your recent view');
    expect(html).toContain('html > body { padding: 0; }');
    expect(html).not.toContain('<script');
  });

  it('renders a script-free dots-only editor placeholder', () => {
    const html = renderEditorWebviewPlaceholderHtml();

    expect(html).toContain('--vscode-editor-background');
    expect(html).toContain('role="status" aria-label="Loading workspace"');
    expect(html).not.toContain('Loading workspace...');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('acquireVsCodeApi');
  });

  it('allows remote HTTPS images without broadening other resource directives', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptUri: 'webview.js',
      cssUri: 'webview.css',
    });
    const imgSrc = html.match(/img-src ([^;]+);/)?.[1];

    expect(imgSrc).toBe('vscode-webview-resource: data: https:');
  });

  it('allows module chunks only from the webview resource source', () => {
    const html = renderWebviewHtml('vscode-webview-resource:', initialState, {
      scriptUri: 'webview.js',
      cssUri: 'webview.css',
    });
    const scriptSrc = html.match(/script-src ([^;]+);/)?.[1];

    expect(scriptSrc).toBe("'nonce-Zml4ZWQtbm9uY2U' vscode-webview-resource:");
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

    expect(html).toContain('src="webview.js?value=&quot;&lt;unsafe>&amp;&amp;v=Zml4ZWQtbm9uY2U"');
    expect(html).toContain('href="webview.css?value=&quot;&lt;unsafe>&amp;&amp;v=Zml4ZWQtbm9uY2U"');
  });
});
