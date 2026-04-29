import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import * as vscode from 'vscode';
import type { ExtensionMessage, InitialWebviewState } from '../shared/protocol';
import { logger } from './logger';
import { renderWebviewHtml, type WebviewAssetContent } from './webview-html';

export class SidebarProviderBridge {
  private webviewAssets: WebviewAssetContent | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  post(view: vscode.WebviewView | undefined, msg: ExtensionMessage) {
    // oxlint-disable-next-line require-post-message-target-origin
    view?.webview.postMessage(msg);
  }

  async renderHtml(view: vscode.WebviewView | undefined, initialState: InitialWebviewState) {
    const assets = await this.loadWebviewAssets();
    return renderWebviewHtml(view?.webview.cspSource || '', initialState, assets);
  }

  webviewOptions() {
    return {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    } satisfies vscode.WebviewOptions;
  }

  emptyStateLogoUri(view: vscode.WebviewView | undefined) {
    return view?.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'icon.png'))
      ?.toString();
  }

  private async loadWebviewAssets(): Promise<WebviewAssetContent> {
    if (this.webviewAssets) return this.webviewAssets;

    const distDir = resolve(this.extensionUri.fsPath, 'dist', 'webview');
    const [scriptResult, cssResult] = await Promise.allSettled([
      readFile(join(distDir, 'webview.js'), 'utf-8'),
      readFile(join(distDir, 'webview.css'), 'utf-8'),
    ]);

    const scriptContent = scriptResult.status === 'fulfilled' ? scriptResult.value : '';
    const cssContent = cssResult.status === 'fulfilled' ? cssResult.value : '';

    if (scriptResult.status !== 'fulfilled') {
      logger.warn('webview.js not found — run `npm run build:webview` first');
      return { scriptContent, cssContent };
    }

    this.webviewAssets = { scriptContent, cssContent };
    return this.webviewAssets;
  }
}
