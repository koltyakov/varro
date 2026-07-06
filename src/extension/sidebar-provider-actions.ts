import * as vscode from 'vscode';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import type { MessageRouterCallbacks } from './message-router';
import type { RestProxy } from './rest-proxy';
import type { SessionExportService } from './session-export-service';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';

type ConfigPayload = Extract<
  Parameters<MessageRouterCallbacks['updateConfig']>[0],
  Record<string, unknown>
>;

type OpenPathPayload = Parameters<MessageRouterCallbacks['openPath']>[0];

export interface SidebarProviderActionDeps {
  contextProvider: ContextProvider;
  extensionId: string;
  webviewSession: {
    setFocus(focused: boolean): void;
  };
  setProviderWatchActive(active: boolean): void;
  contextFilesState: SidebarProviderContextFiles;
  sessionExportService: SessionExportService;
  restProxy: RestProxy;
  postContext(): void;
  postTerminalSelection(selection: { text: string; terminalName: string } | null): void;
  postConfigState(): void;
  handleReadyMessage(): Promise<void>;
  handleDroppedPaths(paths: string[]): Promise<void>;
  handleDroppedContent(
    files: Array<{ name: string; content: string; size: number }>
  ): Promise<void>;
  removeContextFile(path: string): void;
  clearContextFiles(): void;
  pickFiles(): Promise<void>;
  searchFiles(requestId: number, query: string, limit?: number): void;
  runInTerminal(command: string, title?: string): void;
  handleRalphMessage: MessageRouterCallbacks['handleRalphMessage'];
}

export function createSidebarProviderActions(
  deps: SidebarProviderActionDeps
): MessageRouterCallbacks {
  return {
    ready: () => deps.handleReadyMessage(),
    setWebviewFocus: (focused) => {
      deps.webviewSession.setFocus(focused);
    },
    setProviderWatchActive: (active) => {
      deps.setProviderWatchActive(active);
    },
    requestContext: () => {
      deps.postContext();
      deps.postTerminalSelection(deps.contextProvider.terminalSelection);
    },
    refreshProviders: () => {
      deps.postConfigState();
    },
    clearTerminalSelection: () => {
      deps.contextProvider.clearTerminalSelection();
      deps.postTerminalSelection(deps.contextProvider.terminalSelection);
    },
    runInTerminal: (command, title) => deps.runInTerminal(command, title),
    handleRalphMessage: (msg) => deps.handleRalphMessage(msg),
    exportSession: (sessionId) => deps.sessionExportService.exportSession(sessionId),
    openSettings: async (query) => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        query ?? `@ext:${deps.extensionId}`
      );
    },
    handleDroppedPaths: (paths) => deps.handleDroppedPaths(paths),
    handleDroppedContent: (files) => deps.handleDroppedContent(files),
    removeContextFile: (path) => deps.removeContextFile(path),
    clearContextFiles: () => deps.clearContextFiles(),
    notifyContextFilesChanged: () => deps.contextFilesState.notifyContextFilesChanged(),
    pickFiles: () => deps.pickFiles(),
    searchFiles: (requestId, query, limit) => deps.searchFiles(requestId, query, limit),
    readContextFile: async (path) => {
      await deps.contextProvider.readFile(path);
      deps.postContext();
    },
    openPath: (payload: OpenPathPayload) =>
      deps.contextProvider.openPath(payload.path, {
        line: payload.line,
        kind: payload.kind,
      }),
    openExternal: async (url) => {
      if (!url.startsWith('https://')) {
        throw new Error('Unsupported external URL');
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    updateConfig: async (payload: ConfigPayload) => {
      await vscode.workspace
        .getConfiguration('varro')
        .update(
          'chat.expandThinkingByDefault',
          payload.expandThinkingByDefault as boolean,
          vscode.ConfigurationTarget.Global
        );
      await vscode.workspace
        .getConfiguration('varro')
        .update(
          'chat.showStickyUserPrompt',
          payload.showStickyUserPrompt as boolean,
          vscode.ConfigurationTarget.Global
        );
      await vscode.workspace
        .getConfiguration('varro')
        .update(
          'chat.desktopSessionPaneSide',
          payload.desktopSessionPaneSide as 'left' | 'right',
          vscode.ConfigurationTarget.Global
        );
      await vscode.workspace
        .getConfiguration('varro')
        .update(
          'chat.defaultPermissionMode',
          payload.defaultPermissionMode,
          vscode.ConfigurationTarget.Global
        );
      deps.postConfigState();
    },
    handleApiRequest: (payload) => deps.restProxy.handleRequest(payload),
    log: (payload) => {
      const level = payload.level || 'info';
      const line = `[webview] ${payload.msg} ${payload.data || ''} ${payload.error || ''}`.trim();
      if (level === 'error') logger.error(line);
      else if (level === 'warn') logger.warn(line);
      else logger.info(line);
    },
  };
}
