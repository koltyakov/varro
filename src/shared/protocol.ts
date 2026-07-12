import type { ServerEventPropertiesByName, WorkspaceStatusEntry } from './opencode-types';
import type { WebviewConfigUpdatePayload } from './provider-limit-config';
import type { RalphConfig, RalphRun, RalphSelectedModel } from './ralph';
import { asRecord } from './type-utils';

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
  attachmentSequence?: number;
}

export type PermissionMode = 'default' | 'auto' | 'full';

export type AutoApproveJudgeDecision = 'allow' | 'ask';

export type AutoApproveJudgeReference = {
  type: string;
  title: string;
  response: 'once' | 'always';
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
};

export type AutoApproveJudgeRequest = {
  permission: Record<string, unknown>;
  model?: { providerID: string; modelID: string; variant?: string };
  approvedReferences?: AutoApproveJudgeReference[];
};

export type AutoApproveJudgeResponse = {
  decision: AutoApproveJudgeDecision;
  reason?: string;
};

export type SessionTitleFallbackResponse = {
  id: string;
  title: string;
} | null;

export type SessionTokenUsage = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type SessionTokenBreakdown = {
  session: SessionTokenUsage;
  subagents: SessionTokenUsage;
  subagentCount: number;
};

export type SessionDiffSummary = {
  files: number;
  additions: number;
  deletions: number;
  tokens: number;
  tokenBreakdown?: SessionTokenBreakdown;
  durationMs: number;
  activeStartedAt: number | null;
};

export type ProviderLimitUnit = 'requests' | 'tokens' | 'messages' | 'credits' | 'usd' | 'unknown';

export type ProviderLimitWindow = {
  id: string;
  label: string;
  unit: ProviderLimitUnit;
  remaining: number;
  limit: number | null;
  resetAt: number | null;
  percent?: number | null;
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

export type WorkspaceStatusEventSummary = {
  latest?: {
    type: 'workspace.ready' | 'workspace.failed';
    message: string;
  };
  entries: WorkspaceStatusEntry[];
};

/**
 * `/varro/*` is Varro's extension-host API namespace on the shared `api/request`
 * transport. These paths are resolved locally by the extension and are never
 * forwarded to the OpenCode server.
 */
export const VARRO_API_NAMESPACE = '/varro' as const;

export const VARRO_API_ENDPOINTS = {
  providerLimit: `${VARRO_API_NAMESPACE}/provider-limit`,
  planOpen: `${VARRO_API_NAMESPACE}/plan/open`,
  openCodeConfig: `${VARRO_API_NAMESPACE}/opencode-config`,
  openCodeConfigModelRouting: `${VARRO_API_NAMESPACE}/opencode-config/model-routing`,
  session: `${VARRO_API_NAMESPACE}/session`,
  sessionTrash: `${VARRO_API_NAMESPACE}/session-trash`,
  workspaceFile: `${VARRO_API_NAMESPACE}/workspace-file`,
  workspaceFilePick: `${VARRO_API_NAMESPACE}/workspace-file/pick`,
  workspacePathResolve: `${VARRO_API_NAMESPACE}/workspace-path/resolve`,
  permissionJudge: `${VARRO_API_NAMESPACE}/permission/judge`,
} as const;

export type VarroSessionEndpointAction = 'delete' | 'diff-summary' | 'pin' | 'rename-if-untitled';

export function buildVarroSessionEndpoint(
  sessionID: string,
  action: VarroSessionEndpointAction
): string {
  return `${VARRO_API_ENDPOINTS.session}/${encodeURIComponent(sessionID)}/${action}`;
}

export type { OpenCodeModelRoute, OpenCodeModelRouting } from './opencode-types';

export const SERVER_EVENT_NAMES = [
  'server.connected',
  'server.heartbeat',
  'server.instance.disposed',
  'global.disposed',
  'catalog.updated',
  'models-dev.refreshed',
  'installation.updated',
  'installation.update-available',
  'integration.updated',
  'integration.connection.updated',
  'file.edited',
  'file.watcher.updated',
  'reference.updated',
  'plugin.added',
  'project.directories.updated',
  'project.updated',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.error',
  'session.idle',
  'session.compacted',
  'session.diff',
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'message.removed',
  'permission.updated',
  'permission.asked',
  'permission.replied',
  'permission.v2.asked',
  'permission.v2.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'question.v2.asked',
  'question.v2.replied',
  'question.v2.rejected',
  'todo.updated',
  'command.executed',
  'lsp.client.diagnostics',
  'lsp.updated',
  'vcs.branch.updated',
  'mcp.tools.changed',
  'mcp.browser.open.failed',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'tui.session.select',
  'workspace.ready',
  'workspace.failed',
  'workspace.status',
  'worktree.ready',
  'worktree.failed',
  'session.next.agent.switched',
  'session.next.model.switched',
  'session.next.moved',
  'session.next.prompted',
  'session.next.prompt.admitted',
  'session.next.context.updated',
  'session.next.synthetic',
  'session.next.shell.started',
  'session.next.shell.ended',
  'session.next.step.started',
  'session.next.step.ended',
  'session.next.step.failed',
  'session.next.text.started',
  'session.next.text.delta',
  'session.next.text.ended',
  'session.next.reasoning.started',
  'session.next.reasoning.delta',
  'session.next.reasoning.ended',
  'session.next.tool.input.started',
  'session.next.tool.input.delta',
  'session.next.tool.input.ended',
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.retried',
  'session.next.compaction.started',
  'session.next.compaction.delta',
  'session.next.compaction.ended',
  'session.next.revert.staged',
  'session.next.revert.cleared',
  'session.next.revert.committed',
] as const;

const SERVER_EVENT_NAME_SET = new Set<string>(SERVER_EVENT_NAMES);

export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number];

export type ServerEvent = {
  [Name in ServerEventName]: {
    type: Name;
    properties?: ServerEventPropertiesByName[Name];
    /**
     * Durable per-session sequence number. Present on synchronized events; absent on
     * ephemeral streaming fragments (`*.delta`), which carry no `seq`. Used for gap
     * detection so we resync only when a durable event was actually missed. Consumers
     * must treat `undefined` as "ordering unknown" and skip seq-based decisions.
     */
    seq?: number;
  };
}[ServerEventName];

export function isServerEventName(value: unknown): value is ServerEventName {
  return typeof value === 'string' && SERVER_EVENT_NAME_SET.has(value);
}

export function parseServerEvent(value: unknown): ServerEvent | null {
  const record = asRecord(value);
  if (!record) return null;

  return (
    parseServerEventRecord(record) ||
    parseServerEventRecord(asRecord(record.payload)) ||
    parseServerEventRecord(asRecord(record.data))
  );
}

function parseServerEventRecord(record: Record<string, unknown> | null): ServerEvent | null {
  if (!record) return null;

  const syncEvent = parseSyncEventRecord(asRecord(record.syncEvent));
  if (record.type === 'sync' && syncEvent) return syncEvent;

  const eventType = isServerEventName(record.type)
    ? record.type
    : getSyncServerEventName(record.type, record.name);
  if (!eventType) return null;

  const properties = asRecord(
    isServerEventName(record.type) ? (record.properties ?? record.data) : record.data
  );
  // Current `/api/event` payloads put the durable cursor under `durable.seq`;
  // transitional/legacy sync wrappers may still expose it at the top level.
  const seq = getServerEventSeq(record);
  const base = seq === undefined ? { type: eventType } : { type: eventType, seq };
  return properties ? ({ ...base, properties } as ServerEvent) : (base as ServerEvent);
}

function parseSyncEventRecord(record: Record<string, unknown> | null): ServerEvent | null {
  if (!record) return null;

  const eventType = getVersionedServerEventName(record.type);
  if (!eventType) return null;

  const properties = asRecord(record.data);
  const seq = getServerEventSeq(record);
  const base = seq === undefined ? { type: eventType } : { type: eventType, seq };
  return properties ? ({ ...base, properties } as ServerEvent) : (base as ServerEvent);
}

function getServerEventSeq(record: Record<string, unknown>): number | undefined {
  if (typeof record.seq === 'number' && Number.isFinite(record.seq)) return record.seq;
  const durable = asRecord(record.durable);
  return typeof durable?.seq === 'number' && Number.isFinite(durable.seq) ? durable.seq : undefined;
}

function getSyncServerEventName(type: unknown, name: unknown): ServerEventName | null {
  if (type !== 'sync' || typeof name !== 'string') return null;
  return getVersionedServerEventName(name);
}

function getVersionedServerEventName(value: unknown): ServerEventName | null {
  if (typeof value !== 'string') return null;
  const eventName = value.replace(/\.\d+$/, '');
  return isServerEventName(eventName) ? eventName : null;
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
  remoteExtensionHost?: boolean;
  expandThinkingByDefault?: boolean;
  showStickyUserPrompt?: boolean;
  desktopSessionPaneSide?: DesktopSessionPaneSide;
  defaultPermissionMode?: PermissionMode;
  providerLimitPollIntervalSeconds?: number;
  providerLimitThresholdPercent?: number;
  providerLimitsDisabled?: boolean;
  interruptedSessionIds?: string[];
  pendingPermissions?: Array<Record<string, unknown>>;
  pendingQuestions?: Array<Record<string, unknown>>;
  recycleBinEntries?: RecycleBinEntry[];
  pinnedSessionIds?: string[];
};

/**
 * Full snapshot of Ralph orchestration state owned by the extension host.
 * Broadcast to the webview after every change; the webview's ralph store is
 * a render mirror of this payload.
 */
export type RalphStatePayload = {
  runs: Record<
    string,
    RalphRun & {
      /** Transient host acknowledgement that this legacy run is durably stored. */
      legacyMigrationAcknowledged?: true;
    }
  >;
  /** Manager session ids whose loop is currently executing on the host. */
  activeIds: string[];
};

export type ExtensionMessage =
  | { type: 'server/status'; payload: ServerStatus }
  | { type: 'server/event'; payload: ServerEvent }
  | { type: 'providers/refresh' }
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
      payload: WebviewConfigUpdatePayload & {
        providerLimitsDisabled?: boolean;
        providerLimitPollIntervalSeconds?: number;
        providerLimitThresholdPercent?: number;
      };
    }
  | { type: 'theme/update'; payload: { theme: WebviewThemeKind } }
  | { type: 'api/response'; payload: { id: number; data?: unknown; error?: string } }
  | { type: 'command/new-session' }
  | { type: 'command/focus-input' }
  | { type: 'command/search-sessions' }
  | { type: 'command/open-attention-sessions' }
  | { type: 'command/abort' }
  | { type: 'ralph/state'; payload: RalphStatePayload };

export type WebviewMessage =
  | { type: 'context/request' }
  | { type: 'webview/focus'; payload: { focused: boolean } }
  | { type: 'providers/watch'; payload: { active: boolean } }
  | { type: 'providers/refresh' }
  | { type: 'terminal-selection/clear' }
  | { type: 'terminal/run'; payload: { command: string; title?: string } }
  | { type: 'session/export'; payload: { sessionId: string } }
  | { type: 'vscode/open-settings'; payload: { query?: string } }
  | { type: 'vscode/show-output' }
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
      payload: WebviewConfigUpdatePayload;
    }
  | { type: 'ready' }
  | { type: 'api/request'; payload: { id: number; method: string; path: string; body?: unknown } }
  | { type: 'ralph/start'; payload: { config: RalphConfig } }
  | { type: 'ralph/stop'; payload: { managerSessionId: string } }
  | { type: 'ralph/pause'; payload: { managerSessionId: string } }
  | { type: 'ralph/resume'; payload: { managerSessionId: string } }
  | {
      type: 'ralph/update-model';
      payload: { managerSessionId: string; model: RalphSelectedModel | null };
    }
  | {
      /**
       * Webview requests the current Ralph state. `legacyRuns` carries runs
       * persisted by older builds in webview localStorage so the host can
       * adopt them into its own persistence once.
       */
      type: 'ralph/sync';
      payload: { legacyRuns?: Record<string, RalphRun> };
    }
  | {
      type: 'log';
      payload: { msg: string; data?: string; error?: string; level?: 'info' | 'warn' | 'error' };
    };
