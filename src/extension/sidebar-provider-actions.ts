/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- Action dispatch carries protocol payload records that each handler validates. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Action payloads are parsed by the webview decoder before dispatch. */
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
import { assertSessionInCurrentWorkspace } from './session-workspace';
import type { UsageReportService } from './usage-report-service';
import type {
  ChatModelSelection,
  ExtensionMessage,
  TerminalSelection,
  WebviewRoute,
} from '../shared/protocol';

type ConfigPayload = Extract<
  Parameters<MessageRouterCallbacks['updateConfig']>[0],
  Record<string, unknown>
>;

type OpenPathPayload = Parameters<MessageRouterCallbacks['openPath']>[0];

export interface SidebarProviderActionDeps {
  contextProvider: ContextProvider;
  extensionId: string;
  webviewSession: {
    updateCommandState(canAbort: boolean, canSwitchSessions: boolean): void;
    reload(): Promise<void>;
  };
  setProviderWatchActive(active: boolean): void;
  setActiveChatModel(model: ChatModelSelection | null): void;
  setActiveRoute(sessionId: string | null | undefined): void;
  acknowledgeSessionSeen(sessionId: string): void;
  setWebviewFocus(focused: boolean): void;
  revealPermission(permissionId: string): void;
  contextFilesState: SidebarProviderContextFiles;
  sessionExportService: SessionExportService;
  usageReportService: UsageReportService;
  restProxy: RestProxy;
  getWorkspaceDirectory(): string | undefined;
  sessionDiffProvider: Pick<SessionDiffDocumentProvider, 'open'>;
  toolOutputProvider: ToolOutputDocumentProvider;
  server: OpenCodeServer;
  sessionServer?: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>;
  post(message: ExtensionMessage): void;
  refreshProviders(): Promise<void>;
  providerAuthChanged(): Promise<void>;
  postContext(): void;
  selectWorkspace(path: string): Promise<void>;
  postTerminalSelection(selection: TerminalSelection | null): void;
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
  openSessionInTerminal(sessionId: string): void | Promise<void>;
  openSessionInEditor(
    sessionId: string,
    title?: string,
    model?: ChatModelSelection,
    rootSessionId?: string
  ): void | Promise<void>;
  openSessionInSidebar(sessionId: string): void | Promise<void>;
  openNewEditor(): void | Promise<void>;
  editorRouteChanged(route: WebviewRoute): void;
  handleRalphMessage: MessageRouterCallbacks['handleRalphMessage'];
  updateQueuedMessages: MessageRouterCallbacks['updateQueuedMessages'];
  claimQueuedMessage: MessageRouterCallbacks['claimQueuedMessage'];
  releaseQueuedMessage: MessageRouterCallbacks['releaseQueuedMessage'];
  acknowledgeInterruptedSessions: MessageRouterCallbacks['acknowledgeInterruptedSessions'];
  updatePermissionMode: MessageRouterCallbacks['updatePermissionMode'];
  migratePermissionModes: MessageRouterCallbacks['migratePermissionModes'];
  updateSessionModel: MessageRouterCallbacks['updateSessionModel'];
  migrateSessionModels: MessageRouterCallbacks['migrateSessionModels'];
  updateSessionPlanState: MessageRouterCallbacks['updateSessionPlanState'];
  updateSessionUnreadState: MessageRouterCallbacks['updateSessionUnreadState'];
  updateModelPreferences: MessageRouterCallbacks['updateModelPreferences'];
  migrateModelPreferences: MessageRouterCallbacks['migrateModelPreferences'];
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
    updateCommandState: (canAbort, canSwitchSessions, model, sessionId) => {
      deps.webviewSession.updateCommandState(canAbort, canSwitchSessions);
      deps.setActiveChatModel(model);
      deps.setActiveRoute(sessionId);
    },
    acknowledgeSessionSeen: (sessionId) => deps.acknowledgeSessionSeen(sessionId),
    setWebviewFocus: (focused) => deps.setWebviewFocus(focused),
    revealPermission: (permissionId) => deps.revealPermission(permissionId),
    setMermaidPreviewOpen: (open) => deps.setMermaidPreviewOpen(open),
    setProviderWatchActive: (active) => {
      deps.setProviderWatchActive(active);
    },
    requestContext: () => {
      deps.postContext();
      deps.postTerminalSelection(deps.contextFilesState.getTerminalSelection());
    },
    selectWorkspace: async (path) => {
      await deps.selectWorkspace(path);
    },
    refreshProviders: () => deps.refreshProviders(),
    providerAuthChanged: () => deps.providerAuthChanged(),
    clearTerminalSelection: () => {
      deps.contextFilesState.setTerminalSelection(null);
      deps.postTerminalSelection(null);
    },
    runInTerminal: (command, title) => deps.runInTerminal(command, title),
    openSessionInOpenCode: async (sessionId) => {
      await assertSessionInCurrentWorkspace(deps.sessionServer ?? deps.server, sessionId);
      await deps.openSessionInTerminal(sessionId);
    },
    openSessionInEditor: async (sessionId, title, model, rootSessionId) => {
      await assertSessionInCurrentWorkspace(deps.sessionServer ?? deps.server, sessionId);
      await deps.openSessionInEditor(sessionId, title, model, rootSessionId);
    },
    openSessionInSidebar: async (sessionId) => {
      await assertSessionInCurrentWorkspace(deps.sessionServer ?? deps.server, sessionId);
      await deps.openSessionInSidebar(sessionId);
    },
    openNewEditor: () => deps.openNewEditor(),
    editorRouteChanged: (route) => deps.editorRouteChanged(route),
    handleRalphMessage: (msg) => deps.handleRalphMessage(msg),
    updateQueuedMessages: (payload) => deps.updateQueuedMessages(payload),
    claimQueuedMessage: (payload) => deps.claimQueuedMessage(payload),
    releaseQueuedMessage: (payload) => deps.releaseQueuedMessage(payload),
    acknowledgeInterruptedSessions: (payload) => deps.acknowledgeInterruptedSessions(payload),
    updatePermissionMode: (payload) => deps.updatePermissionMode(payload),
    migratePermissionModes: (payload) => deps.migratePermissionModes(payload),
    updateSessionModel: (payload) => deps.updateSessionModel(payload),
    migrateSessionModels: (payload) => deps.migrateSessionModels(payload),
    updateSessionPlanState: (payload) => deps.updateSessionPlanState(payload),
    updateSessionUnreadState: (payload) => deps.updateSessionUnreadState(payload),
    updateModelPreferences: (payload) => deps.updateModelPreferences(payload),
    migrateModelPreferences: (payload) => deps.migrateModelPreferences(payload),
    updateDraftImages: (payload) => deps.updateDraftImages(payload),
    exportSession: (sessionId) => deps.sessionExportService.exportSession(sessionId),
    generateUsageReport: (includeAllTime) => deps.usageReportService.openReport(includeAllTime),
    reloadWebview: () => deps.webviewSession.reload(),
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
      const workspaceDirectory = deps.getWorkspaceDirectory();
      if (payload.view === 'diff' && payload.sessionID) {
        const result = await deps.sessionDiffProvider.open(payload.sessionID, payload.path);
        if (result !== 'unavailable') {
          if (payload.requestId !== undefined) {
            deps.post({
              type: 'vscode/open-result',
              payload: {
                requestId: payload.requestId,
                status: result === 'opened' ? 'opened' : 'unavailable',
              },
            });
          }
          return;
        }
      }
      const status = await deps.contextProvider.openPath(payload.path, {
        line: payload.line,
        kind: payload.kind,
        view: payload.view,
        workspaceDirectory,
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
    handleApiRequest: (payload) =>
      deps.restProxy.handleRequest(payload, deps.getWorkspaceDirectory()),
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
