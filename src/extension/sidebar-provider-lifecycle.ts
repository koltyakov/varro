import type * as vscode from 'vscode';
import { logger } from './logger';

export interface SidebarProviderLifecycleDeps {
  getView(): vscode.WebviewView | undefined;
  setView(view: vscode.WebviewView | undefined): void;
  resetWebviewReady(): void;
  resetWebviewFocus(): void;
  incrementWebviewLoadGeneration(): number;
  getWebviewLoadGeneration(): number;
  parseAndHandleMessage(raw: unknown): void;
  renderHtml(): Promise<string>;
  postVisibleState(): void;
  onHidden(): void;
  updateStatusBarItem(): void;
  postThemeUpdate(): void;
  disposeThemeListener(): void;
  createThemeListener(): vscode.Disposable;
}

export class SidebarProviderLifecycle {
  constructor(private readonly deps: SidebarProviderLifecycleDeps) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    resetDisposables: () => void,
    pushDisposable: (disposable: vscode.Disposable) => void,
    webviewOptions: vscode.WebviewOptions
  ) {
    this.deps.setView(webviewView);
    this.deps.resetWebviewReady();
    const webviewLoadGeneration = this.deps.incrementWebviewLoadGeneration();

    webviewView.webview.options = webviewOptions;

    resetDisposables();

    pushDisposable(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        this.deps.parseAndHandleMessage(raw);
      })
    );

    pushDisposable(
      webviewView.onDidDispose(() => {
        if (this.deps.getView() === webviewView) {
          this.deps.setView(undefined);
          this.deps.resetWebviewReady();
          this.deps.resetWebviewFocus();
          this.deps.updateStatusBarItem();
        }
      })
    );

    void this.deps
      .renderHtml()
      .then((html) => {
        if (
          this.deps.getView() !== webviewView ||
          webviewLoadGeneration !== this.deps.getWebviewLoadGeneration()
        ) {
          return;
        }
        webviewView.webview.html = html;
      })
      .catch((err) => {
        if (
          this.deps.getView() !== webviewView ||
          webviewLoadGeneration !== this.deps.getWebviewLoadGeneration()
        ) {
          return;
        }
        logger.error(`getHtml failed: ${err instanceof Error ? err.message : String(err)}`);
        webviewView.webview.html = '<p>Failed to load Varro webview. Please reload.</p>';
      });

    pushDisposable(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.deps.postVisibleState();
        } else {
          this.deps.onHidden();
        }
        this.deps.updateStatusBarItem();
      })
    );

    this.deps.disposeThemeListener();
    pushDisposable(this.deps.createThemeListener());
  }
}
