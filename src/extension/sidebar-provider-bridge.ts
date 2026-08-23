/* oxlint-disable anti-slop/no-unknown-parameters -- Webview messages are untrusted until parsed by the bridge. */
import * as vscode from 'vscode';
import type { ExtensionMessage, InitialWebviewState } from '../shared/protocol';
import { logger } from './logger';
import { renderWebviewHtml, type WebviewAssetUris } from './webview-html';

export class SidebarProviderBridge {
  private view?: vscode.WebviewView | vscode.WebviewPanel;
  private viewGeneration = 0;
  private deliveryFailureHandler?: () => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setView(view: vscode.WebviewView | vscode.WebviewPanel | undefined) {
    this.view = view;
    this.viewGeneration += 1;
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
    const view = this.view;
    if (!view) return;
    const generation = this.viewGeneration;
    void this.deliverToView(view, msg).then((delivered) => {
      if (!delivered && this.view === view && this.viewGeneration === generation) {
        this.deliveryFailureHandler?.();
      }
    });
  }

  deliver(msg: ExtensionMessage): Promise<boolean> {
    const view = this.view;
    if (!view) return Promise.resolve(false);
    return this.deliverToView(view, msg);
  }

  private deliverToView(
    view: vscode.WebviewView | vscode.WebviewPanel,
    msg: ExtensionMessage
  ): Promise<boolean> {
    // oxlint-disable-next-line require-post-message-target-origin
    const delivery = view.webview.postMessage(msg);
    return Promise.resolve(delivery).then(
      (delivered) => {
        if (!delivered) logger.warn(`Webview message was not delivered: ${msg.type}`);
        return delivered;
      },
      (error: unknown) => {
        logger.warn(
          `Webview message delivery failed (${msg.type}): ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
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
