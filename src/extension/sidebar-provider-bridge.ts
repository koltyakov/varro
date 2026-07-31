import * as vscode from 'vscode';
import type { ExtensionMessage, InitialWebviewState } from '../shared/protocol';
import { renderWebviewHtml, type WebviewAssetUris } from './webview-html';

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
    const assets = this.getWebviewAssetUris();
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

  private getWebviewAssetUris(): WebviewAssetUris {
    const webview = this.view?.webview;
    if (!webview) throw new Error('Cannot render webview assets before the view is available');
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    return {
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js')).toString(),
      cssUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css')).toString(),
    };
  }
}
