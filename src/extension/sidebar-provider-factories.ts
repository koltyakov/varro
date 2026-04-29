import * as vscode from 'vscode';
import type { ExtensionMessage, ServerStatus, WebviewMessage } from '../shared/protocol';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import type { SidebarProviderCoordinatorDeps } from './sidebar-provider-coordinator';
import type { SidebarProviderLifecycleDeps } from './sidebar-provider-lifecycle';
import type { SidebarProviderCommands } from './sidebar-provider-commands';
import type { SidebarProviderOrchestrator } from './sidebar-provider-orchestrator';
import type { SidebarProviderUiState } from './sidebar-provider-ui-state';
import { parseWebviewMessage } from './util/webview-message';

export function createSidebarProviderLifecycleDeps(options: {
  getView(): vscode.WebviewView | undefined;
  setView(view: vscode.WebviewView | undefined): void;
  uiState: SidebarProviderUiState;
  getWebviewLoadGeneration(): number;
  incrementWebviewLoadGeneration(): number;
  handleMessage(message: WebviewMessage): void;
  renderHtml(): Promise<string>;
  orchestrator: SidebarProviderOrchestrator;
  commands: SidebarProviderCommands;
  contextProvider: ContextProvider;
  post(message: ExtensionMessage): void;
  status(): ServerStatus;
  updateStatusBarItem(): void;
  cleanupExpiredRecycleBin(): Promise<void>;
  ensureServerStarted(): Promise<unknown>;
  disposeThemeListener(): void;
  createThemeListener(): vscode.Disposable;
}): SidebarProviderLifecycleDeps {
  return {
    getView: options.getView,
    setView: options.setView,
    resetWebviewReady: () => {
      options.uiState.webviewReady = false;
    },
    resetWebviewFocus: () => {
      options.uiState.webviewHasFocus = false;
    },
    incrementWebviewLoadGeneration: options.incrementWebviewLoadGeneration,
    getWebviewLoadGeneration: options.getWebviewLoadGeneration,
    parseAndHandleMessage: (raw) => {
      const msg = parseWebviewMessage(raw);
      if (!msg) {
        logger.warn('Ignoring invalid webview message');
        return;
      }
      options.handleMessage(msg);
    },
    renderHtml: options.renderHtml,
    postVisibleState: () =>
      options.orchestrator.postVisibleState(options.post, options.status(), {
        flushPendingInputFocus: () =>
          options.commands.flushPendingInputFocus(options.getView(), options.post),
        flushPendingOpenAttentionSessions: () =>
          options.commands.flushPendingOpenAttentionSessions(options.getView(), options.post),
        cleanupExpiredRecycleBin: options.cleanupExpiredRecycleBin,
        ensureServerStarted: options.ensureServerStarted,
      }),
    onHidden: () => options.orchestrator.onHidden(),
    updateStatusBarItem: options.updateStatusBarItem,
    postThemeUpdate: () => {
      options.post({ type: 'theme/update', payload: { theme: options.uiState.currentTheme() } });
    },
    disposeThemeListener: options.disposeThemeListener,
    createThemeListener: options.createThemeListener,
  };
}

export function createSidebarProviderCoordinatorDeps(options: {
  server: SidebarProviderCoordinatorDeps['server'];
  sessionState: SidebarProviderCoordinatorDeps['sessionState'];
  runtime: SidebarProviderCoordinatorDeps['runtime'];
  providerLimitService: SidebarProviderCoordinatorDeps['providerLimitService'];
  getStatus: SidebarProviderCoordinatorDeps['getStatus'];
  setStatus: SidebarProviderCoordinatorDeps['setStatus'];
  post: SidebarProviderCoordinatorDeps['post'];
  updateStatusBarItem: SidebarProviderCoordinatorDeps['updateStatusBarItem'];
  themeDisposable: () => vscode.Disposable | undefined;
  configDisposable: () => vscode.Disposable | undefined;
  windowStateDisposable: () => vscode.Disposable | undefined;
  disposeWebviewDisposables(): void;
  disposeSearch(): void;
  disposeDroppedFiles(): Promise<void>;
}): SidebarProviderCoordinatorDeps {
  return {
    server: options.server,
    sessionState: options.sessionState,
    runtime: options.runtime,
    providerLimitService: options.providerLimitService,
    getStatus: options.getStatus,
    setStatus: options.setStatus,
    post: options.post,
    updateStatusBarItem: options.updateStatusBarItem,
    createStatusBarItem: () => {
      const item = vscode.window.createStatusBarItem(
        'varro.session-status',
        vscode.StatusBarAlignment.Left,
        1000
      );
      item.name = 'Varro Session Status';
      item.command = 'varro.chat.statusBarClick';
      return item;
    },
    disposeThemeListener: () => {
      options.themeDisposable()?.dispose();
    },
    disposeConfigListener: () => {
      options.configDisposable()?.dispose();
    },
    disposeWindowStateListener: () => {
      options.windowStateDisposable()?.dispose();
    },
    disposeWebviewDisposables: options.disposeWebviewDisposables,
    disposeSearch: options.disposeSearch,
    disposeDroppedFiles: options.disposeDroppedFiles,
  };
}
