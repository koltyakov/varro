import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import * as vscode from 'vscode';
import type { ExtensionMessage, InitialWebviewState } from '../shared/protocol';
import { renderWebviewHtml, type WebviewAssetContent } from './webview-html';

export class SidebarProviderBridge {
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setView(view: vscode.WebviewView | undefined) {
    this.view = view;
  }

  getView() {
    return this.view;
  }

  isVisible() {
    return Boolean(this.view?.visible);
  }

  post(msg: ExtensionMessage) {
    // oxlint-disable-next-line require-post-message-target-origin
    this.view?.webview.postMessage(msg);
  }

  async renderHtml(initialState: InitialWebviewState) {
    const assets = await this.loadWebviewAssets();
    return renderWebviewHtml(this.view?.webview.cspSource || '', initialState, assets);
  }

  webviewOptions() {
    return {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    } satisfies vscode.WebviewOptions;
  }

  emptyStateLogoUri() {
    return this.view?.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'icon.png'))
      ?.toString();
  }

  private async loadWebviewAssets(): Promise<WebviewAssetContent> {
    const distDir = resolve(this.extensionUri.fsPath, 'dist', 'webview');
    let scriptContent: string;
    let cssContent: string;
    try {
      [scriptContent, cssContent] = await Promise.all([
        readFile(join(distDir, 'webview.js'), 'utf-8'),
        readFile(join(distDir, 'webview.css'), 'utf-8'),
      ]);
    } catch (err) {
      throw new Error(
        `Failed to load built webview assets: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    if (!scriptContent.trim()) throw new Error('Built webview.js is empty');
    if (!cssContent.trim()) throw new Error('Built webview.css is empty');

    return { scriptContent, cssContent };
  }
}
