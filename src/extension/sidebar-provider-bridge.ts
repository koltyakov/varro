/* oxlint-disable anti-slop/no-unknown-parameters -- Webview messages are untrusted until parsed by the bridge. */
import * as vscode from 'vscode';
import type { ExtensionMessage, InitialWebviewState } from '../shared/protocol';
import { logger } from './logger';
import { renderWebviewHtml, type WebviewAssetUris } from './webview-html';

export class SidebarProviderBridge {
  private view?: vscode.WebviewView | vscode.WebviewPanel;
  private deliveryFailureHandler?: () => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setView(view: vscode.WebviewView | vscode.WebviewPanel | undefined) {
    this.view = view;
  }

  getView() {
    return this.view;
  }

  isVisible() {
    return Boolean(this.view?.visible);
  }

  onDeliveryFailure(handler: () => void) {
    this.deliveryFailureHandler = handler;
  }

  post(msg: ExtensionMessage) {
    // oxlint-disable-next-line require-post-message-target-origin
    const delivery = this.view?.webview.postMessage(msg);
    if (delivery === undefined) return;
    void Promise.resolve(delivery).then(
      (delivered) => {
        if (delivered) return;
        logger.warn(`Webview message was not delivered: ${msg.type}`);
        this.deliveryFailureHandler?.();
      },
      (error: unknown) => {
        logger.warn(
          `Webview message delivery failed (${msg.type}): ${error instanceof Error ? error.message : String(error)}`
        );
        this.deliveryFailureHandler?.();
      }
    );
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
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.mjs')).toString(),
      cssUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css')).toString(),
    };
  }
}
