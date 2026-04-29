import * as vscode from 'vscode';
import type {
  DesktopSessionPaneSide,
  ExtensionMessage,
  WebviewThemeKind,
} from '../shared/protocol';
import type {
  PermissionEventProperties,
  PermissionReplyProperties,
  QuestionReplyProperties,
  QuestionRequest,
} from '../shared/opencode-types';
import type {
  BlockingRequestSnapshot,
  InterruptedSessionSnapshot,
  SessionStateManager,
} from './session-state-manager';
import type { SessionTrashManager } from './session-trash-manager';

type StatusBarState =
  | { visible: false }
  | { visible: true; text: string; tooltip: string; backgroundColor?: vscode.ThemeColor };

export class SidebarProviderUiState {
  public webviewHasFocus = false;
  public webviewReady = false;
  public pendingInputFocus = false;
  public pendingOpenAttentionSessions = false;
  public lastStatusBarStateKey = '';
  public interruptedSessionsForWebview: InterruptedSessionSnapshot[] = [];
  public blockingRequestsForWebview: BlockingRequestSnapshot[] = [];

  constructor(
    private readonly sessionState: SessionStateManager,
    private readonly sessionTrash: SessionTrashManager
  ) {}

  shouldShowNotification(view?: vscode.WebviewView) {
    return !view?.visible;
  }

  showInterruptedSessionNotification() {
    if (this.interruptedSessionsForWebview.length === 0) return;
    this.interruptedSessionsForWebview = [];
  }

  replayBlockingRequests(
    post: (message: ExtensionMessage) => void,
    options?: { clearResolvedEmbedded?: boolean }
  ) {
    const currentRequests = [...this.sessionState.pending.entries()]
      .map(([id, request]) => ({
        id,
        sessionID: request.sessionID,
        kind: request.kind,
        props: request.props,
      }))
      .filter((item) => !this.sessionTrash.isHidden(item.sessionID));
    const currentRequestIds = new Set(currentRequests.map((item) => item.id));

    if (options?.clearResolvedEmbedded) {
      for (const item of this.blockingRequestsForWebview) {
        if (currentRequestIds.has(item.id)) continue;
        if (item.kind === 'question') {
          post({
            type: 'server/event',
            payload: {
              type: 'question.replied',
              properties: {
                id: item.id,
                requestID: item.id,
                sessionID: item.sessionID,
              } satisfies QuestionReplyProperties,
            },
          });
          continue;
        }

        post({
          type: 'server/event',
          payload: {
            type: 'permission.replied',
            properties: {
              id: item.id,
              permissionID: item.id,
              requestID: item.id,
              sessionID: item.sessionID,
            } satisfies PermissionReplyProperties,
          },
        });
      }
    }

    for (const item of currentRequests) {
      if (item.kind === 'question') {
        post({
          type: 'server/event',
          payload: {
            type: 'question.asked',
            properties: item.props as QuestionRequest,
          },
        });
        continue;
      }

      post({
        type: 'server/event',
        payload: {
          type: 'permission.asked',
          properties: item.props as PermissionEventProperties,
        },
      });
    }
  }

  updateStatusBarItem(statusBarItem: vscode.StatusBarItem, view?: vscode.WebviewView) {
    const next = this.getStatusBarState(view);
    const nextKey = JSON.stringify(next);
    if (nextKey === this.lastStatusBarStateKey) return;
    this.lastStatusBarStateKey = nextKey;

    if (!next.visible) {
      statusBarItem.hide();
      return;
    }

    statusBarItem.text = next.text;
    statusBarItem.backgroundColor = next.backgroundColor;
    statusBarItem.tooltip = next.tooltip;
    statusBarItem.show();
  }

  currentTheme(): WebviewThemeKind {
    const k = vscode.window.activeColorTheme.kind;
    switch (k) {
      case vscode.ColorThemeKind.Light:
        return 'light';
      case vscode.ColorThemeKind.Dark:
        return 'dark';
      case vscode.ColorThemeKind.HighContrast:
        return 'high-contrast';
      case vscode.ColorThemeKind.HighContrastLight:
        return 'high-contrast-light';
      default:
        return 'dark';
    }
  }

  readConfig() {
    const config = vscode.workspace.getConfiguration('varro');
    return {
      expandThinkingByDefault: config.get<boolean>('chat.expandThinkingByDefault') ?? false,
      showStickyUserPrompt: config.get<boolean>('chat.showStickyUserPrompt', true),
      desktopSessionPaneSide: config.get<DesktopSessionPaneSide>(
        'chat.desktopSessionPaneSide',
        'left'
      ),
    };
  }

  flushPendingInputFocus(
    view: vscode.WebviewView | undefined,
    post: (message: ExtensionMessage) => void
  ) {
    if (!this.pendingInputFocus || !view?.visible || !this.webviewReady) return;
    this.pendingInputFocus = false;
    post({ type: 'command/focus-input' });
  }

  flushPendingOpenAttentionSessions(
    view: vscode.WebviewView | undefined,
    post: (message: ExtensionMessage) => void
  ) {
    if (!this.pendingOpenAttentionSessions || !view?.visible || !this.webviewReady) return;
    this.pendingOpenAttentionSessions = false;
    post({ type: 'command/open-attention-sessions' });
  }

  private getStatusBarState(view?: vscode.WebviewView): StatusBarState {
    if (view?.visible) {
      return { visible: false };
    }

    const pendingRequests = [...this.sessionState.pending.values()].filter(
      (request) => !this.sessionTrash.isHidden(request.sessionID)
    );
    if (pendingRequests.length > 0) {
      return {
        visible: true,
        text: `$(bell-dot) Varro: ${pendingRequests.length} waiting`,
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
        tooltip: [
          'Varro is waiting for your input.',
          ...pendingRequests.slice(0, 3).map((request) => {
            const title = this.sessionState.titleFor(request.sessionID);
            return title ? `${title}: ${request.label}` : request.label;
          }),
          ...(pendingRequests.length > 3 ? [`+${pendingRequests.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    const completedSessions = [...this.sessionState.completed].filter(
      (sessionID) => !this.sessionTrash.isHidden(sessionID)
    );
    if (completedSessions.length > 0) {
      return {
        visible: true,
        text: `$(check-all) Varro: ${completedSessions.length} completed`,
        tooltip: [
          'Varro finished background work.',
          ...completedSessions
            .slice(0, 3)
            .map((sessionID) => this.sessionState.titleFor(sessionID) || sessionID),
          ...(completedSessions.length > 3 ? [`+${completedSessions.length - 3} more`] : []),
          '',
          'Click to open chat.',
        ].join('\n'),
      };
    }

    return { visible: false };
  }
}
