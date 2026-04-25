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

export interface ContextLineRange {
  startLine: number;
  endLine: number;
}

export interface DroppedFile {
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  lineRanges?: ContextLineRange[];
}

export type PermissionMode = 'default' | 'full';

export type ProviderLimitUnit = 'requests' | 'tokens' | 'messages' | 'credits' | 'unknown';

export type ProviderLimitWindow = {
  id: string;
  label: string;
  unit: ProviderLimitUnit;
  remaining: number;
  limit: number | null;
  resetAt: number | null;
};

export type ProviderLimitStatus =
  | {
      providerID: string;
      modelID?: string | null;
      status: 'available';
      source: 'opencode' | 'provider';
      checkedAt: number;
      windows: ProviderLimitWindow[];
      note?: string;
    }
  | {
      providerID: string;
      modelID?: string | null;
      status: 'unsupported' | 'error';
      source: 'opencode' | 'provider';
      checkedAt: number;
      note: string;
    };

export type McpStatus = {
  status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration';
  error?: string;
};

export type ServerStatus =
  | { state: 'starting' }
  | { state: 'running'; url: string; eventStream?: 'healthy' | 'degraded' }
  | { state: 'stopped' }
  | { state: 'error'; message: string };

export type RecycleBinSession = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
};

export type RecycleBinEntry = {
  rootID: string;
  deletedAt: number;
  expiresAt: number;
  root: RecycleBinSession;
  sessions: RecycleBinSession[];
};

export const SERVER_EVENT_NAMES = [
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
  'session.diff',
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'message.removed',
  'permission.updated',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'todo.updated',
  'mcp.tools.changed',
  'mcp.browser.open.failed',
] as const;

const SERVER_EVENT_NAME_SET = new Set<string>(SERVER_EVENT_NAMES);

export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number];

export type ServerEvent = {
  [Name in ServerEventName]: {
    type: Name;
    properties?: Record<string, unknown>;
  };
}[ServerEventName];

export function isServerEventName(value: unknown): value is ServerEventName {
  return typeof value === 'string' && SERVER_EVENT_NAME_SET.has(value);
}

export function parseServerEvent(value: unknown): ServerEvent | null {
  const record = asRecord(value);
  if (!record || !isServerEventName(record.type)) return null;

  const properties = asRecord(record.properties);
  return properties ? { type: record.type, properties } : { type: record.type };
}

export type WebviewThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export type DesktopSessionPaneSide = 'left' | 'right';

export type InitialWebviewState = {
  theme: WebviewThemeKind;
  serverStatus: ServerStatus;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
  emptyStateLogoUri: string;
  expandThinkingByDefault?: boolean;
  showStickyUserPrompt?: boolean;
  desktopSessionPaneSide?: DesktopSessionPaneSide;
  interruptedSessionIds?: string[];
  pendingPermissions?: Array<Record<string, unknown>>;
  pendingQuestions?: Array<Record<string, unknown>>;
  recycleBinEntries?: RecycleBinEntry[];
};

export type ExtensionMessage =
  | { type: 'server/status'; payload: ServerStatus }
  | { type: 'server/event'; payload: ServerEvent }
  | { type: 'recycle-bin/update'; payload: { entries: RecycleBinEntry[] } }
  | { type: 'pending-attention/update'; payload: { sessionIds: string[] } }
  | { type: 'context/update'; payload: EditorContext }
  | { type: 'terminal-selection/update'; payload: { text: string; terminalName: string } | null }
  | { type: 'files/dropped'; payload: DroppedFile[] }
  | { type: 'files/removed'; payload: { path: string } }
  | {
      type: 'files/search-results';
      payload: { requestId: number; query: string; files: DroppedFile[] };
    }
  | {
      type: 'config/update';
      payload: {
        expandThinkingByDefault: boolean;
        showStickyUserPrompt: boolean;
        desktopSessionPaneSide: DesktopSessionPaneSide;
      };
    }
  | { type: 'theme/update'; payload: { theme: WebviewThemeKind } }
  | { type: 'api/response'; payload: { id: number; data?: unknown; error?: string } }
  | { type: 'command/new-session' }
  | { type: 'command/focus-input' }
  | { type: 'command/open-attention-sessions' }
  | { type: 'command/abort' };

export type WebviewMessage =
  | { type: 'context/request' }
  | { type: 'webview/focus'; payload: { focused: boolean } }
  | { type: 'terminal-selection/clear' }
  | { type: 'terminal/run'; payload: { command: string; title?: string } }
  | { type: 'vscode/open-settings'; payload: { query?: string } }
  | { type: 'files/drop'; payload: { paths: string[] } }
  | {
      type: 'files/drop-content';
      payload: { files: Array<{ name: string; content: string; size: number }> };
    }
  | { type: 'files/remove'; payload: { path: string } }
  | { type: 'files/clear' }
  | { type: 'files/pick' }
  | { type: 'files/search'; payload: { requestId: number; query: string; limit?: number } }
  | { type: 'file/read'; payload: { path: string } }
  | {
      type: 'vscode/open';
      payload: { path: string; line?: number; kind?: 'auto' | 'file' | 'directory' };
    }
  | { type: 'vscode/open-external'; payload: { url: string } }
  | {
      type: 'config/update';
      payload: {
        expandThinkingByDefault: boolean;
        showStickyUserPrompt: boolean;
        desktopSessionPaneSide: DesktopSessionPaneSide;
      };
    }
  | { type: 'ready' }
  | { type: 'api/request'; payload: { id: number; method: string; path: string; body?: unknown } }
  | {
      type: 'log';
      payload: { msg: string; data?: string; error?: string; level?: 'info' | 'warn' | 'error' };
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
