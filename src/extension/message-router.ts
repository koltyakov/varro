import type { WebviewMessage } from '../shared/protocol';
import { logger } from './logger';

type ApiRequestPayload = Extract<WebviewMessage, { type: 'api/request' }>['payload'];
type ConfigUpdatePayload = Extract<WebviewMessage, { type: 'config/update' }>['payload'];
type DroppedContentFile = Extract<
  WebviewMessage,
  { type: 'files/drop-content' }
>['payload']['files'][number];
type LogPayload = Extract<WebviewMessage, { type: 'log' }>['payload'];
type OpenPathPayload = Extract<WebviewMessage, { type: 'vscode/open' }>['payload'];
type RalphMessage = Extract<
  WebviewMessage,
  {
    type:
      | 'ralph/start'
      | 'ralph/stop'
      | 'ralph/pause'
      | 'ralph/resume'
      | 'ralph/update-model'
      | 'ralph/sync';
  }
>;

export interface MessageRouterCallbacks {
  ready(): Promise<void>;
  setWebviewFocus(focused: boolean): void;
  setProviderWatchActive(active: boolean): void;
  requestContext(): void;
  refreshProviders(): void;
  clearTerminalSelection(): void;
  runInTerminal(command: string, title?: string): void;
  exportSession(sessionId: string): Promise<void>;
  openSettings(query?: string): Promise<void>;
  handleDroppedPaths(paths: string[]): Promise<void>;
  handleDroppedContent(files: DroppedContentFile[]): Promise<void>;
  removeContextFile(path: string): void;
  clearContextFiles(): void;
  notifyContextFilesChanged(): void;
  pickFiles(): Promise<void>;
  searchFiles(requestId: number, query: string, limit?: number): void;
  readContextFile(path: string): Promise<void>;
  openPath(payload: OpenPathPayload): Promise<void>;
  openExternal(url: string): Promise<void>;
  updateConfig(payload: ConfigUpdatePayload): Promise<void>;
  handleApiRequest(payload: ApiRequestPayload): Promise<void>;
  handleRalphMessage(msg: RalphMessage): void;
  log(payload: LogPayload): void;
}

export class MessageRouter {
  constructor(private readonly callbacks: MessageRouterCallbacks) {}

  async handleMessage(msg: WebviewMessage) {
    try {
      switch (msg.type) {
        case 'ready':
          await this.handleReadyMessage();
          break;
        case 'webview/focus':
          this.handleWebviewFocusMessage(msg);
          break;
        case 'providers/watch':
          this.handleProvidersWatchMessage(msg);
          break;
        case 'context/request':
          this.handleContextRequestMessage();
          break;
        case 'providers/refresh':
          this.handleProvidersRefreshMessage();
          break;
        case 'terminal-selection/clear':
          this.handleTerminalSelectionClearMessage();
          break;
        case 'terminal/run':
          this.handleTerminalRunMessage(msg);
          break;
        case 'session/export':
          await this.handleSessionExportMessage(msg);
          break;
        case 'vscode/open-settings':
          await this.handleOpenSettingsMessage(msg);
          break;
        case 'files/drop':
          await this.handleFilesDropMessage(msg);
          break;
        case 'files/drop-content':
          await this.handleFilesDropContentMessage(msg);
          break;
        case 'files/remove':
          this.handleFilesRemoveMessage(msg);
          break;
        case 'files/clear':
          this.handleFilesClearMessage();
          break;
        case 'files/pick':
          await this.handleFilesPickMessage();
          break;
        case 'files/search':
          this.handleFilesSearchMessage(msg);
          break;
        case 'file/read':
          await this.handleFileReadMessage(msg);
          break;
        case 'vscode/open':
          await this.handleOpenMessage(msg);
          break;
        case 'vscode/open-external':
          await this.handleOpenExternalMessage(msg);
          break;
        case 'config/update':
          await this.handleConfigUpdateMessage(msg);
          break;
        case 'api/request':
          await this.handleApiRequestMessage(msg);
          break;
        case 'ralph/start':
        case 'ralph/stop':
        case 'ralph/pause':
        case 'ralph/resume':
        case 'ralph/update-model':
        case 'ralph/sync':
          this.callbacks.handleRalphMessage(msg);
          break;
        case 'log':
          this.handleLogMessage(msg);
          break;
      }
    } catch (err) {
      logger.error(
        `handleMessage(${msg.type}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async handleReadyMessage() {
    await this.callbacks.ready();
  }

  private handleWebviewFocusMessage(msg: Extract<WebviewMessage, { type: 'webview/focus' }>) {
    this.callbacks.setWebviewFocus(msg.payload.focused);
  }

  private handleProvidersWatchMessage(msg: Extract<WebviewMessage, { type: 'providers/watch' }>) {
    this.callbacks.setProviderWatchActive(msg.payload.active);
  }

  private handleContextRequestMessage() {
    this.callbacks.requestContext();
  }

  private handleProvidersRefreshMessage() {
    this.callbacks.refreshProviders();
  }

  private handleTerminalSelectionClearMessage() {
    this.callbacks.clearTerminalSelection();
  }

  private handleTerminalRunMessage(msg: Extract<WebviewMessage, { type: 'terminal/run' }>) {
    this.callbacks.runInTerminal(msg.payload.command, msg.payload.title);
  }

  private async handleSessionExportMessage(
    msg: Extract<WebviewMessage, { type: 'session/export' }>
  ) {
    await this.callbacks.exportSession(msg.payload.sessionId);
  }

  private async handleOpenSettingsMessage(
    msg: Extract<WebviewMessage, { type: 'vscode/open-settings' }>
  ) {
    await this.callbacks.openSettings(msg.payload.query);
  }

  private async handleFilesDropMessage(msg: Extract<WebviewMessage, { type: 'files/drop' }>) {
    await this.callbacks.handleDroppedPaths(msg.payload.paths);
  }

  private async handleFilesDropContentMessage(
    msg: Extract<WebviewMessage, { type: 'files/drop-content' }>
  ) {
    await this.callbacks.handleDroppedContent(msg.payload.files);
  }

  private handleFilesRemoveMessage(msg: Extract<WebviewMessage, { type: 'files/remove' }>) {
    this.callbacks.removeContextFile(msg.payload.path);
  }

  private handleFilesClearMessage() {
    this.callbacks.clearContextFiles();
    this.callbacks.notifyContextFilesChanged();
  }

  private async handleFilesPickMessage() {
    await this.callbacks.pickFiles();
  }

  private handleFilesSearchMessage(msg: Extract<WebviewMessage, { type: 'files/search' }>) {
    this.callbacks.searchFiles(msg.payload.requestId, msg.payload.query, msg.payload.limit);
  }

  private async handleFileReadMessage(msg: Extract<WebviewMessage, { type: 'file/read' }>) {
    await this.callbacks.readContextFile(msg.payload.path);
  }

  private async handleOpenMessage(msg: Extract<WebviewMessage, { type: 'vscode/open' }>) {
    await this.callbacks.openPath(msg.payload);
  }

  private async handleOpenExternalMessage(
    msg: Extract<WebviewMessage, { type: 'vscode/open-external' }>
  ) {
    await this.callbacks.openExternal(msg.payload.url);
  }

  private async handleConfigUpdateMessage(msg: Extract<WebviewMessage, { type: 'config/update' }>) {
    await this.callbacks.updateConfig(msg.payload);
  }

  private async handleApiRequestMessage(msg: Extract<WebviewMessage, { type: 'api/request' }>) {
    await this.callbacks.handleApiRequest(msg.payload);
  }

  private handleLogMessage(msg: Extract<WebviewMessage, { type: 'log' }>) {
    this.callbacks.log(msg.payload);
  }
}
