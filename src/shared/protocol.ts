import type { OpenCodeInstallMethod } from './opencode-install';
import type { ContextBreakdownSegment } from './context-breakdown';
import type { NativePdfAttachment } from './native-pdf';
import type { ServerEventPropertiesByName, WorkspaceStatusEntry } from './opencode-types';
import type { WebviewConfigUpdatePayload } from './provider-limit-config';
import type { RalphConfig, RalphRun, RalphSelectedModel } from './ralph';
import { asRecord, isNumber, isString } from './type-utils';
import type { UnknownRecord } from './type-utils';

export interface WorkspaceFolderContext {
  name: string;
  path: string;
}

export interface EditorTextContext {
  kind: 'selection' | 'dirty-buffer';
  path: string | null;
  relativePath: string;
  language: string;
  range: ContextLineRange;
  text: string;
  truncated: boolean;
}

export interface EditorDiagnostic {
  path: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
}

export interface EditorContext {
  workspacePath: string | null;
  workspaceFolders?: WorkspaceFolderContext[];
  activeFile: {
    path: string;
    relativePath: string;
    language: string;
  } | null;
  selection: {
    startLine: number;
    endLine: number;
  } | null;
  editorText?: EditorTextContext | null;
  diagnostics: EditorDiagnostic[];
  diagnosticsTotal?: number;
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

export interface WorkspaceFilePick {
  path: string;
  workspaceDirectory: string | null;
}

export type PermissionMode = 'default' | 'edits' | 'auto' | 'full';

export type ChatModelSelection = {
  providerID: string;
  modelID: string;
  variant?: string;
};

export function isPermissionMode<T>(value: T): value is T & PermissionMode {
  return value === 'default' || value === 'edits' || value === 'auto' || value === 'full';
}

export type AutoApproveJudgeDecision = 'allow' | 'reject' | 'ask';
export const AUTO_APPROVE_JUDGE_TIMEOUT_MS = 20_000;

export type AutoApproveJudgeReference = {
  type: string;
  title: string;
  response: 'once' | 'always' | 'reject';
  pattern?: string | string[];
  metadata?: UnknownRecord;
};

export type AutoApproveJudgeRequest = {
  permission: UnknownRecord;
  model?: { providerID: string; modelID: string; variant?: string };
  approvedReferences?: AutoApproveJudgeReference[];
};

export type AutoApproveJudgeResponse = {
  decision: AutoApproveJudgeDecision;
  reason?: string;
  actionSummary?: string;
};

export type AutoApproveActivityStatus =
  | 'reviewing'
  | 'auto-approved'
  | 'approval-required'
  | 'auto-review-failed'
  | 'manually-approved'
  | 'manually-rejected';

export type AutoApproveActivity = {
  permissionId: string;
  status: AutoApproveActivityStatus;
  title: string;
  detail?: string;
  createdAt: number;
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
  filesTruncated?: boolean;
  historyStatsUnavailable?: boolean;
  additions: number;
  deletions: number;
  tokens: number;
  model?: { providerID: string; modelID: string; variant?: string };
  tokenBreakdown?: SessionTokenBreakdown;
  nestedContextBreakdown?: ContextBreakdownSegment[];
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
      planName?: string;
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

/**
 * Why a startup failure happened, in a form the webview can branch on.
 *
 * `message` stays the human-readable summary and remains the only required
 * field: `detail` is optional so older payloads (and the e2e harness scenarios
 * that predate it) keep rendering through the generic states.
 */
export type ServerErrorKind =
  | 'cli-missing'
  | 'cli-path-invalid'
  | 'update-required'
  | 'update-blocked'
  | 'update-failed'
  | 'generic';

export type ServerErrorBlockedBy =
  | 'active-sessions'
  | 'auto-update-disabled'
  | 'auto-start-disabled'
  | 'foreign-owner'
  | 'verify-failed';

export type ServerErrorDetail = {
  kind: ServerErrorKind;
  installMethod?: OpenCodeInstallMethod;
  /** Command that repairs this specific install; never `opencode upgrade` after a failure. */
  suggestedCommand?: string;
  blockedBy?: ServerErrorBlockedBy;
  /** Settings id to deep-link, e.g. `varro.server.autoUpdate`. */
  settingId?: string;
  configuredCommand?: string;
  searchedPaths?: string[];
  observed?: string;
  required?: string;
  cause?: string;
};

export type ServerStatus =
  | { state: 'starting' }
  | { state: 'running'; url: string; eventStream?: 'healthy' | 'degraded' }
  | { state: 'stopped' }
  | { state: 'error'; message: string; detail?: ServerErrorDetail };

export type RestartBlockedDirectory = {
  directory: string | null;
  sessionCount: number;
};

export type RestartBlockedState = {
  totalSessionCount: number;
  directories: RestartBlockedDirectory[];
  checkId?: number;
};

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
  permissionJudgeModel: `${VARRO_API_NAMESPACE}/permission/judge/model`,
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
    /** OpenCode event identity. Sync envelopes use the nested durable event ID. */
    id?: string;
    /** Varro transport marker: advance sequence observers without reapplying the mutation. */
    sequenceOnly?: true;
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

type ParsedServerEvent = {
  type: ServerEventName;
  id?: string;
  sequenceOnly?: true;
  seq?: number;
  properties?: UnknownRecord;
};

export function isServerEventName<T>(value: T): value is T & ServerEventName {
  return isString(value) && SERVER_EVENT_NAME_SET.has(value);
}

export function parseServerEvent<T>(value: T): ServerEvent | null {
  const record = asRecord(value);
  if (!record) return null;

  return (
    parseServerEventRecord(record) ||
    parseServerEventRecord(asRecord(record.payload)) ||
    parseServerEventRecord(asRecord(record.data))
  );
}

function parseServerEventRecord(record: UnknownRecord | null): ServerEvent | null {
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
  const id = getServerEventId(record);
  const sequenceOnly = record.sequenceOnly === true;
  // Current `/api/event` payloads put the durable cursor under `durable.seq`;
  // transitional/legacy sync wrappers may still expose it at the top level.
  const seq = getServerEventSeq(record);
  const event: ParsedServerEvent = { type: eventType };
  if (id !== undefined) event.id = id;
  if (sequenceOnly) event.sequenceOnly = true;
  if (seq !== undefined) event.seq = seq;
  if (properties) event.properties = properties;
  // SAFETY: eventType was normalized against SERVER_EVENT_NAMES; property payloads remain intentionally shallow-validated.
  return event as ServerEvent;
}

function parseSyncEventRecord(record: UnknownRecord | null): ServerEvent | null {
  if (!record) return null;

  const eventType = getVersionedServerEventName(record.type);
  if (!eventType) return null;

  const properties = asRecord(record.data);
  const id = getServerEventId(record);
  const sequenceOnly = record.sequenceOnly === true;
  const seq = getServerEventSeq(record);
  const event: ParsedServerEvent = { type: eventType };
  if (id !== undefined) event.id = id;
  if (sequenceOnly) event.sequenceOnly = true;
  if (seq !== undefined) event.seq = seq;
  if (properties) event.properties = properties;
  // SAFETY: eventType was normalized against SERVER_EVENT_NAMES; property payloads remain intentionally shallow-validated.
  return event as ServerEvent;
}

function getServerEventId(record: UnknownRecord): string | undefined {
  return isString(record.id) && record.id.length > 0 ? record.id : undefined;
}

function getServerEventSeq(record: UnknownRecord): number | undefined {
  if (isNumber(record.seq) && Number.isFinite(record.seq)) return record.seq;
  const durable = asRecord(record.durable);
  return isNumber(durable?.seq) && Number.isFinite(durable.seq) ? durable.seq : undefined;
}

function getSyncServerEventName<Type, Name>(type: Type, name: Name): ServerEventName | null {
  if (type !== 'sync' || !isString(name)) return null;
  return getVersionedServerEventName(name);
}

function getVersionedServerEventName<T>(value: T): ServerEventName | null {
  if (!isString(value)) return null;
  const eventName = value.replace(/\.\d+$/, '');
  return isServerEventName(eventName) ? eventName : null;
}

export type WebviewThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export type DesktopSessionPaneSide = 'left' | 'right';

export type ClipboardImageSnapshot = {
  id: string;
  url: string;
  mime: string;
  filename: string;
  size: number;
  contentKey?: string;
  attachmentSequence?: number;
  contextFile?: Pick<DroppedFile, 'path' | 'relativePath' | 'type'>;
};

export type QueuedMessageSnapshot = {
  id: string;
  sessionId: string;
  text: string;
  agent?: string;
  paused?: boolean;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImageSnapshot[];
  nativePdfs?: NativePdfAttachment[];
  terminalSelection: { text: string; terminalName: string } | null;
  attachedDiagnostics?: { diagnostics: EditorDiagnostic[]; total: number };
};

export type InitialWebviewState = {
  theme: WebviewThemeKind;
  serverStatus: ServerStatus;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
  clipboardImages?: ClipboardImageSnapshot[];
  emptyStateLogoUri: string;
  remoteExtensionHost?: boolean;
  showInlineFileChanges?: boolean;
  showChangedFiles?: boolean;
  desktopSessionPaneSide?: DesktopSessionPaneSide;
  defaultPermissionMode?: PermissionMode;
  interruptedSessionIds?: string[];
  pendingPermissions?: UnknownRecord[];
  pendingQuestions?: UnknownRecord[];
  recycleBinEntries?: RecycleBinEntry[];
  pinnedSessionIds?: string[];
  queuedMessages?: QueuedMessageSnapshot[];
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
  | { type: 'server/restart-blocked'; payload: RestartBlockedState }
  | { type: 'server/event'; payload: ServerEvent }
  | { type: 'providers/refresh'; payload?: { revalidateAuth: true } }
  | { type: 'providers/status'; payload: { pending: boolean } }
  | { type: 'context/update'; payload: EditorContext }
  | { type: 'terminal-selection/update'; payload: { text: string; terminalName: string } | null }
  | { type: 'files/dropped'; payload: DroppedFile[] }
  | { type: 'pdfs/picked'; payload: NativePdfAttachment[] }
  | { type: 'pdfs/stored'; payload: { id: string; contextFile: DroppedFile } }
  | { type: 'images/stored'; payload: { id: string; contextFile: DroppedFile } }
  | { type: 'files/removed'; payload: { path: string } }
  | {
      type: 'files/search-results';
      payload: { requestId: number; query: string; files: DroppedFile[] };
    }
  | {
      type: 'config/update';
      payload: WebviewConfigUpdatePayload;
    }
  | { type: 'theme/update'; payload: { theme: WebviewThemeKind } }
  | {
      type: 'vscode/open-result';
      payload: { requestId: number; status: 'opened' | 'unavailable' };
    }
  | { type: 'api/response'; payload: { id: number; data?: unknown; error?: string } }
  | { type: 'command/new-session'; payload?: { prefill: string } }
  | { type: 'command/focus-input' }
  | { type: 'command/search-sessions' }
  | { type: 'command/open-attention-sessions' }
  | { type: 'command/switch-session'; payload: { direction: 'previous' | 'next' } }
  | { type: 'command/abort' }
  | { type: 'ralph/state'; payload: RalphStatePayload };

export type WebviewMessage =
  | { type: 'context/request' }
  | { type: 'workspace/select'; payload: { path: string } }
  | {
      type: 'commands/state';
      payload: {
        canAbort: boolean;
        canSwitchSessions: boolean;
        model: ChatModelSelection | null;
      };
    }
  | { type: 'webview/focus'; payload: { focused: boolean } }
  | { type: 'permission/reveal'; payload: { permissionId: string } }
  | { type: 'providers/watch'; payload: { active: boolean } }
  | { type: 'providers/refresh' }
  | { type: 'providers/reauthenticated' }
  | { type: 'terminal-selection/clear' }
  | { type: 'terminal/run'; payload: { command: string; title?: string } }
  | { type: 'session/open-in-opencode'; payload: { sessionId: string } }
  | { type: 'session/export'; payload: { sessionId: string } }
  | { type: 'usage/report'; payload: { includeAllTime: boolean } }
  | { type: 'vscode/open-folder' }
  | { type: 'vscode/open-settings'; payload: { query?: string } }
  | { type: 'vscode/show-output' }
  | { type: 'vscode/mermaid-preview'; payload: { open: boolean } }
  | { type: 'server/restart'; payload?: { force: true } }
  | { type: 'server/restart/check'; payload: { checkId: number } }
  | { type: 'files/drop'; payload: { paths: string[] } }
  | {
      type: 'files/drop-content';
      payload: { files: Array<{ name: string; content: string; size: number }> };
    }
  | {
      type: 'pdfs/store';
      payload: { id: string; name: string; content: string; size: number };
    }
  | {
      type: 'images/store';
      payload: { id: string; name: string; content: string; size: number };
    }
  | {
      type: 'images/release';
      payload: { paths: string[]; deferred: boolean; sessionId?: string };
    }
  | { type: 'composer/images-update'; payload: { images: ClipboardImageSnapshot[] } }
  | { type: 'files/remove'; payload: { path: string } }
  | { type: 'files/clear' }
  | { type: 'queued-messages/update'; payload: { messages: QueuedMessageSnapshot[] } }
  | { type: 'files/pick' }
  | { type: 'files/search'; payload: { requestId: number; query: string; limit?: number } }
  | { type: 'file/read'; payload: { path: string } }
  | {
      type: 'vscode/open';
      payload: {
        path: string;
        line?: number;
        kind?: 'auto' | 'file' | 'directory';
        view?: 'diff';
        sessionID?: string;
        requestId?: number;
      };
    }
  | { type: 'vscode/open-external'; payload: { url: string } }
  | {
      /**
       * Open arbitrary tool text (a command's full output, a long input value)
       * in a read-only editor tab. The webview clamps long values instead of
       * scrolling them in place, so this is the escape hatch to the full text.
       * `title` names the tab; `language` picks syntax highlighting.
       */
      type: 'vscode/open-text';
      payload: { content: string; title: string; language?: string };
    }
  | {
      type: 'config/update';
      payload: WebviewConfigUpdatePayload;
    }
  | { type: 'ready' }
  | {
      type: 'api/request';
      payload: { id: number; cancelKey?: string; method: string; path: string; body?: unknown };
    }
  | { type: 'api/cancel'; payload: { id: number; cancelKey: string } }
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
