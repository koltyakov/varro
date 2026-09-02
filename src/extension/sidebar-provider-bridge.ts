/* oxlint-disable anti-slop/no-unknown-parameters -- Webview messages are untrusted until parsed by the bridge. */
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionMessage, InitialWebviewState } from '../shared/protocol';
import { logger } from './logger';
import { renderWebviewHtml, type WebviewAssetUris } from './webview-html';

const MAX_PENDING_WEBVIEW_DELIVERIES = 512;

type DeliveryState = {
  epoch: number;
  pending: number;
  failed: boolean;
};

export class SidebarProviderBridge {
  private view?: vscode.WebviewView | vscode.WebviewPanel;
  private viewGeneration = 0;
  private deliveryFailureHandler?: () => void;
  private deliveryState: DeliveryState = { epoch: 0, pending: 0, failed: false };

  constructor(private readonly extensionUri: vscode.Uri) {}

  setView(view: vscode.WebviewView | vscode.WebviewPanel | undefined) {
    const replacingView = view !== this.view;
    this.view = view;
    this.viewGeneration += 1;
    if (replacingView) {
      this.deliveryState = { epoch: this.viewGeneration, pending: 0, failed: false };
    } else {
      this.deliveryState.epoch = this.viewGeneration;
    }
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

  invalidatePendingDeliveries() {
    this.viewGeneration += 1;
    this.deliveryState.epoch = this.viewGeneration;
  }

  markViewReady() {
    this.viewGeneration += 1;
    this.deliveryState = { epoch: this.viewGeneration, pending: 0, failed: false };
  }

  post(msg: ExtensionMessage) {
    const delivery = this.startDelivery(msg, true);
    void Promise.resolve(delivery).catch((error: unknown) => {
      logger.warn(
        `Webview delivery observer failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  deliver(msg: ExtensionMessage): Promise<boolean> {
    return Promise.resolve(this.startDelivery(msg, false));
  }

  private startDelivery(
    msg: ExtensionMessage,
    acceptVoidDelivery: boolean
  ): boolean | PromiseLike<boolean> {
    const view = this.view;
    const state = this.deliveryState;
    const epoch = state.epoch;
    if (!view || state.failed) return false;
    if (state.pending >= MAX_PENDING_WEBVIEW_DELIVERIES) {
      logger.warn('Webview delivery backlog exceeded its limit; reloading the webview');
      this.failDeliveryState(state, epoch);
      return false;
    }

    state.pending += 1;
    const messageType = msg.type;
    let delivery: unknown;
    try {
      // oxlint-disable-next-line require-post-message-target-origin
      delivery = view.webview.postMessage(msg);
    } catch (error: unknown) {
      state.pending -= 1;
      logger.warn(
        `Webview message delivery failed (${messageType}): ${error instanceof Error ? error.message : String(error)}`
      );
      this.failDeliveryState(state, epoch);
      return false;
    }

    // Several tests and host shims use a void implementation. Preserve its synchronous behavior.
    if (delivery === undefined) {
      state.pending -= 1;
      return acceptVoidDelivery;
    }
    if (delivery === true || delivery === false) {
      state.pending -= 1;
      const delivered = delivery;
      if (!delivered) {
        logger.warn(`Webview message was not delivered: ${messageType}`);
        this.failDeliveryState(state, epoch);
      }
      return delivered;
    }

    // SAFETY: VS Code's Webview.postMessage contract returns Thenable<boolean>.
    return Promise.resolve(delivery as PromiseLike<boolean>).then(
      (delivered) => {
        state.pending -= 1;
        const accepted = delivered === true;
        if (!accepted) logger.warn(`Webview message was not delivered: ${messageType}`);
        if (!accepted) this.failDeliveryState(state, epoch);
        return accepted;
      },
      (error: unknown) => {
        state.pending -= 1;
        logger.warn(
          `Webview message delivery failed (${messageType}): ${error instanceof Error ? error.message : String(error)}`
        );
        this.failDeliveryState(state, epoch);
        return false;
      }
    );
  }

  private failDeliveryState(state: DeliveryState, epoch: number) {
    if (this.deliveryState !== state || state.epoch !== epoch || state.failed) return;
    state.failed = true;
    try {
      this.deliveryFailureHandler?.();
    } catch (error: unknown) {
      logger.warn(
        `Webview delivery failure handler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    const version = this.readWebviewAssetVersion(distUri.fsPath);
    return {
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.mjs')).toString(),
      cssUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css')).toString(),
      version,
    };
  }

  private readWebviewAssetVersion(distPath: string) {
    try {
      const version = readFileSync(join(distPath, 'webview.version'), 'utf8').trim();
      return /^[a-f0-9]{16}$/.test(version) ? version : 'development';
    } catch {
      return 'development';
    }
  }
}
