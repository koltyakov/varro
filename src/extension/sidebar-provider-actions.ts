import * as vscode from 'vscode';
import type { ContextProvider } from './context-provider';
import { logger } from './logger';
import type { MessageRouterCallbacks } from './message-router';
import type { RestProxy } from './rest-proxy';
import type { SessionExportService } from './session-export-service';
import type { SidebarProviderContextFiles } from './sidebar-provider-context-files';
import type { SessionDiffDocumentProvider } from './session-diff-document-provider';
import type { ToolOutputDocumentProvider } from './tool-output-document-provider';
import type { OpenCodeServer } from './server';
import type { UsageReportService } from './usage-report-service';
import type { ChatModelSelection, ExtensionMessage } from '../shared/protocol';

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
    updateCommandState(canAbort: boolean, canSwitchSessions: boolean): void;
  };
  setProviderWatchActive(active: boolean): void;
  setActiveChatModel(model: ChatModelSelection | null): void;
  revealPermission(permissionId: string): void;
  contextFilesState: SidebarProviderContextFiles;
  sessionExportService: SessionExportService;
  usageReportService: UsageReportService;
  restProxy: RestProxy;
  sessionDiffProvider: SessionDiffDocumentProvider;
  toolOutputProvider: ToolOutputDocumentProvider;
  server: OpenCodeServer;
  post(message: ExtensionMessage): void;
  refreshProviders(): Promise<void>;
  providerReauthenticated(): Promise<void>;
  postContext(): void;
  postTerminalSelection(selection: { text: string; terminalName: string } | null): void;
  postConfigState(): void;
  handleReadyMessage(): Promise<void>;
  handleDroppedPaths(paths: string[]): Promise<void>;
  handleDroppedContent(
    files: Array<{ name: string; content: string; size: number }>
  ): Promise<void>;
  storePdf: MessageRouterCallbacks['storePdf'];
  storeImage: MessageRouterCallbacks['storeImage'];
  releaseImages: MessageRouterCallbacks['releaseImages'];
  removeContextFile(path: string): void;
  clearContextFiles(): void;
  pickFiles(): Promise<void>;
  searchFiles(requestId: number, query: string, limit?: number): void;
  runInTerminal(command: string, title?: string): void | Promise<void>;
  handleRalphMessage: MessageRouterCallbacks['handleRalphMessage'];
  updateQueuedMessages: MessageRouterCallbacks['updateQueuedMessages'];
  updateDraftImages: MessageRouterCallbacks['updateDraftImages'];
  setMermaidPreviewOpen: MessageRouterCallbacks['setMermaidPreviewOpen'];
}

export function createSidebarProviderActions(
  deps: SidebarProviderActionDeps
): MessageRouterCallbacks {
  let restartCheckOperation: Promise<void> | null = null;
  const checkServerRestart = (checkId: number) => {
    if (restartCheckOperation) return restartCheckOperation;
    const operation = (async () => {
      const blockers = await deps.server.readRestartBlockers();
      if (blockers.totalSessionCount > 0) {
        deps.post({ type: 'server/restart-blocked', payload: { ...blockers, checkId } });
        return;
      }
      await vscode.commands.executeCommand('varro.server.restart');
    })();
    restartCheckOperation = operation;
    const finish = () => {
      if (restartCheckOperation === operation) restartCheckOperation = null;
    };
    void operation.then(finish, finish);
    return operation;
  };

  return {
    ready: () => deps.handleReadyMessage(),
    updateCommandState: (canAbort, canSwitchSessions, model) => {
      deps.webviewSession.updateCommandState(canAbort, canSwitchSessions);
      deps.setActiveChatModel(model);
    },
    setWebviewFocus: (focused) => {
      deps.webviewSession.setFocus(focused);
    },
    revealPermission: (permissionId) => deps.revealPermission(permissionId),
    setMermaidPreviewOpen: (open) => deps.setMermaidPreviewOpen(open),
    setProviderWatchActive: (active) => {
      deps.setProviderWatchActive(active);
    },
    requestContext: () => {
      deps.postContext();
      deps.postTerminalSelection(deps.contextProvider.terminalSelection);
    },
    selectWorkspace: async (path) => {
      await deps.contextProvider.selectWorkspace(path);
    },
    refreshProviders: () => deps.refreshProviders(),
    providerReauthenticated: () => deps.providerReauthenticated(),
    clearTerminalSelection: () => {
      deps.contextProvider.clearTerminalSelection();
      deps.postTerminalSelection(deps.contextProvider.terminalSelection);
    },
    runInTerminal: (command, title) => deps.runInTerminal(command, title),
    openSessionInOpenCode: (sessionId) =>
      deps.runInTerminal(`opencode --session ${sessionId}`, 'OpenCode Session'),
    handleRalphMessage: (msg) => deps.handleRalphMessage(msg),
    updateQueuedMessages: (payload) => deps.updateQueuedMessages(payload),
    updateDraftImages: (payload) => deps.updateDraftImages(payload),
    exportSession: (sessionId) => deps.sessionExportService.exportSession(sessionId),
    generateUsageReport: (includeAllTime) => deps.usageReportService.openReport(includeAllTime),
    openFolder: async () => {
      await vscode.commands.executeCommand('workbench.action.files.openFolder');
    },
    openSettings: async (query) => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        query ?? `@ext:${deps.extensionId}`
      );
    },
    showOutput: () => logger.show(),
    restartServer: async (force) => {
      await vscode.commands.executeCommand(
        'varro.server.restart',
        force ? { force: true } : undefined
      );
    },
    checkServerRestart,
    handleDroppedPaths: (paths) => deps.handleDroppedPaths(paths),
    handleDroppedContent: (files) => deps.handleDroppedContent(files),
    storePdf: (payload) => deps.storePdf(payload),
    storeImage: (payload) => deps.storeImage(payload),
    releaseImages: (payload) => deps.releaseImages(payload),
    removeContextFile: (path) => deps.removeContextFile(path),
    clearContextFiles: () => deps.clearContextFiles(),
    notifyContextFilesChanged: () => deps.contextFilesState.notifyContextFilesChanged(),
    pickFiles: () => deps.pickFiles(),
    searchFiles: (requestId, query, limit) => deps.searchFiles(requestId, query, limit),
    readContextFile: async (path) => {
      await deps.contextProvider.readFile(path);
      deps.postContext();
    },
    openPath: async (payload: OpenPathPayload) => {
      if (
        payload.view === 'diff' &&
        payload.sessionID &&
        (await deps.sessionDiffProvider.open(payload.sessionID, payload.path))
      ) {
        if (payload.requestId !== undefined) {
          deps.post({
            type: 'vscode/open-result',
            payload: { requestId: payload.requestId, status: 'opened' },
          });
        }
        return;
      }
      const status = await deps.contextProvider.openPath(payload.path, {
        line: payload.line,
        kind: payload.kind,
        view: payload.view,
      });
      if (payload.requestId !== undefined) {
        deps.post({
          type: 'vscode/open-result',
          payload: { requestId: payload.requestId, status },
        });
      }
    },
    openText: async (payload) => {
      await deps.toolOutputProvider.open(payload);
    },
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
    cancelApiRequest: (payload) => deps.restProxy.cancelRequest(payload),
    log: (payload) => {
      const level = payload.level || 'info';
      const line = `[webview] ${payload.msg} ${payload.data || ''} ${payload.error || ''}`.trim();
      if (level === 'error') logger.error(line);
      else if (level === 'warn') logger.warn(line);
      else logger.info(line);
    },
  };
}
