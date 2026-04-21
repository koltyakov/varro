export interface EditorContext {
  workspacePath: string | null;
  activeFile: {
    path: string;
    relativePath: string;
    language: string;
  } | null;
  selection: {
    startLine: number;
    endLine: number;
  } | null;
  diagnostics: Array<{
    path: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    line: number;
  }>;
}

export interface DroppedFile {
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
}

export type PermissionMode = 'default' | 'full';

export type ServerStatus =
  | { state: 'starting' }
  | { state: 'running'; url: string }
  | { state: 'stopped' }
  | { state: 'error'; message: string };

export type ServerEventName =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.status'
  | 'session.idle'
  | 'session.diff'
  | 'message.updated'
  | 'message.part.updated'
  | 'message.part.delta'
  | 'message.part.removed'
  | 'message.removed'
  | 'permission.updated'
  | 'permission.asked'
  | 'permission.replied'
  | 'question.asked'
  | 'question.replied'
  | 'question.rejected'
  | 'todo.updated';

export type WebviewThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export type InitialWebviewState = {
  theme: WebviewThemeKind;
  serverStatus: ServerStatus;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
};

export type ExtensionMessage =
  | { type: 'server/status'; payload: ServerStatus }
  | {
      type: 'server/event';
      payload: { type: ServerEventName; properties?: Record<string, unknown> };
    }
  | { type: 'context/update'; payload: EditorContext }
  | { type: 'terminal-selection/update'; payload: { text: string; terminalName: string } | null }
  | { type: 'files/dropped'; payload: DroppedFile[] }
  | { type: 'files/removed'; payload: { path: string } }
  | {
      type: 'files/search-results';
      payload: { requestId: number; query: string; files: DroppedFile[] };
    }
  | { type: 'theme/update'; payload: { theme: WebviewThemeKind } }
  | { type: 'api/response'; payload: { id: number; data?: unknown; error?: string } }
  | { type: 'command/new-session' }
  | { type: 'command/focus-input' }
  | { type: 'command/abort' };

export type WebviewMessage =
  | { type: 'context/request' }
  | { type: 'webview/focus'; payload: { focused: boolean } }
  | { type: 'terminal-selection/clear' }
  | { type: 'files/drop'; payload: { paths: string[] } }
  | { type: 'files/remove'; payload: { path: string } }
  | { type: 'files/clear' }
  | { type: 'files/pick' }
  | { type: 'files/search'; payload: { requestId: number; query: string; limit?: number } }
  | { type: 'file/read'; payload: { path: string } }
  | { type: 'vscode/open'; payload: { path: string; line?: number } }
  | { type: 'vscode/diff'; payload: { path: string } }
  | { type: 'ready' }
  | { type: 'api/request'; payload: { id: number; method: string; path: string; body?: unknown } }
  | {
      type: 'log';
      payload: { msg: string; data?: string; error?: string; level?: 'info' | 'warn' | 'error' };
    };
