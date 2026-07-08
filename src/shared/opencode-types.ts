export type OutputFormatText = {
  type: 'text';
};

export type JsonSchema = {
  [key: string]: unknown;
};

export type OutputFormatJsonSchema = {
  type: 'json_schema';
  schema: JsonSchema;
  retryCount?: number;
};

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;

export type UserMessage = {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  format?: OutputFormat;
  summary?: { title?: string; body?: string; diffs: FileDiff[] };
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
  system?: string;
  tools?: { [key: string]: boolean };
};

export type OpenCodeModelRoute = {
  providerID: string;
  modelID: string;
};

export type OpenCodeModelRouting = {
  smallModel: OpenCodeModelRoute | null;
  agentModels: Record<string, OpenCodeModelRoute>;
};

export type ProviderAuthError = {
  name: 'ProviderAuthError';
  data: { providerID: string; message: string };
};

export type UnknownError = {
  name: 'UnknownError';
  data: { message: string; ref?: string };
};

export type MessageOutputLengthError = {
  name: 'MessageOutputLengthError';
  data: { message?: string; [key: string]: unknown };
};

export type MessageAbortedError = {
  name: 'MessageAbortedError';
  data: { message: string };
};

export type StructuredOutputError = {
  name: 'StructuredOutputError';
  data: { message: string; retries: number };
};

export type ContextOverflowError = {
  name: 'ContextOverflowError';
  data: { message: string; responseBody?: string };
};

export type ContentFilterError = {
  name: 'ContentFilterError';
  data: { message: string };
};

export type ApiError = {
  name: 'APIError';
  data: {
    message: string;
    statusCode?: number;
    isRetryable?: boolean;
    responseHeaders?: { [key: string]: string };
    responseBody?: string;
    metadata?: { [key: string]: string };
  };
};

export type LegacyAssistantError = {
  name: string;
  data?: { message?: string; [key: string]: unknown };
};

export type AssistantMessageError =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | StructuredOutputError
  | ContextOverflowError
  | ContentFilterError
  | ApiError
  | LegacyAssistantError;

export type AssistantMessage = {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  error?: AssistantMessageError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent?: string;
  path: { cwd: string; root: string };
  summary?: boolean;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  structured?: unknown;
  variant?: string;
  finish?: string;
};

export type Message = UserMessage | AssistantMessage;

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
};

export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end?: number };
};

export type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
  source?: {
    text: { value: string; start: number; end: number };
    type: 'file' | 'symbol' | 'resource';
    path?: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    name?: string;
    kind?: number;
    clientName?: string;
    uri?: string;
  };
};

export type ToolStatePending = {
  status: 'pending';
  input: { [key: string]: unknown };
  raw: string;
};

export type ToolStateRunning = {
  status: 'running';
  input: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  time: { start: number };
};

export type ToolStateCompleted = {
  status: 'completed';
  input: { [key: string]: unknown };
  output: string;
  title: string;
  metadata: { [key: string]: unknown };
  time: { start: number; end: number; compacted?: number };
  attachments?: FilePart[];
};

export type ToolStateError = {
  status: 'error';
  input: { [key: string]: unknown };
  error: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end: number };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: { [key: string]: unknown };
};

export type StepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'step-start';
  snapshot?: string;
};

export type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

export type SnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'snapshot';
  snapshot: string;
};

export type PatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'patch';
  hash: string;
  files: string[];
};

export type AgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'agent';
  name: string;
  source?: { value: string; start: number; end: number };
};

export type SubtaskPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  model?: { providerID: string; modelID: string };
  command?: string;
};

export type RetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'retry';
  attempt: number;
  error: ApiError | { name: string; data: { message: string; [key: string]: unknown } };
  time: { created: number };
};

export type CompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
};

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart;

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
};

export type Session = {
  id: string;
  slug?: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  path?: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: FileDiff[];
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  share?: {
    url: string;
  };
  title: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  version: string;
  metadata?: { [key: string]: unknown };
  time: { created: number; updated: number; compacting?: number; archived?: number };
  permission?: PermissionRule[];
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
};

export type Command = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  template: string;
  subtask?: boolean;
  hints?: string[];
};

export type SessionStatus =
  | { type: 'idle' }
  | {
      type: 'retry';
      attempt: number;
      message: string;
      action?: {
        reason: string;
        provider: string;
        title: string;
        message: string;
        label: string;
        link?: string;
      };
      next: number;
    }
  | { type: 'busy' };

export type FileDiff = {
  file?: string;
  before?: string;
  after?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
};

export type RepoFileStatus = {
  path: string;
  added: number;
  removed: number;
  status: 'added' | 'deleted' | 'modified';
};

export type PermissionGroupMember = {
  id: string;
  sessionID: string;
  messageID: string;
  callID?: string;
};

export type Permission = {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: { [key: string]: unknown };
  time: { created: number };
  duplicateIDs?: string[];
  groupMembers?: PermissionGroupMember[];
};

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionTool = {
  messageID: string;
  callID: string;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: QuestionTool;
};

export type Todo = {
  content: string;
  status: string;
  priority: string;
};

export type NormalizedTodo = Todo & { id: string };

export type ModelCapabilitiesModality = 'text' | 'audio' | 'image' | 'video' | 'pdf';

type ModelCapabilitiesModalityMap = {
  text: boolean;
  audio: boolean;
  image: boolean;
  video: boolean;
  pdf: boolean;
};

type ModelCapabilitiesModalityList = Array<ModelCapabilitiesModality | string>;

export type ModelCapabilities = {
  temperature?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  attachment?: boolean;
  toolcall?: boolean;
  tool_call?: boolean;
  tools?: boolean;
  input?: ModelCapabilitiesModalityMap | ModelCapabilitiesModalityList;
  output?: ModelCapabilitiesModalityMap | ModelCapabilitiesModalityList;
  interleaved?: boolean | { field: 'reasoning_content' | 'reasoning_details' };
};

export type ModelCost = {
  input: number;
  output: number;
  cache?: { read: number; write: number };
  tiers?: Array<{
    input: number;
    output: number;
    cache: { read: number; write: number };
    tier: { type: 'context'; size: number };
  }>;
  experimentalOver200K?: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
};

export type Agent = {
  name: string;
  description?: string;
  mode: 'subagent' | 'primary' | 'all';
  builtIn?: boolean;
  native?: boolean;
  hidden?: boolean;
  color?: string;
  permission: AgentLegacyPermission | PermissionRule[];
  model?: { modelID: string; providerID: string; variant?: string };
  variant?: string;
  prompt?: string;
  tools?: { [key: string]: boolean };
  options?: { [key: string]: unknown };
  steps?: number;
  maxSteps?: number;
  topP?: number;
  temperature?: number;
};

export type Provider = {
  id: string;
  name: string;
  source: 'env' | 'config' | 'custom' | 'api';
  env?: string[];
  key?: string;
  options?: { [key: string]: unknown };
  models: {
    [key: string]: {
      id: string;
      providerID?: string;
      api?: { id: string; url: string; npm: string };
      name: string;
      family?: string;
      capabilities: ModelCapabilities;
      cost: ModelCost;
      limit?: {
        context: number;
        input?: number;
        output: number;
      };
      status?: 'alpha' | 'beta' | 'deprecated' | 'active';
      options?: { [key: string]: unknown };
      headers?: { [key: string]: string };
      release_date?: string;
      variants?: {
        [key: string]: { [key: string]: unknown };
      };
    };
  };
};

export type Model = {
  id: string;
  providerID: string;
  name: string;
};

export type SessionEventInfo = Partial<Session> & { id?: string | null; agent?: string | null };

export type MessageEventInfo =
  | Message
  | {
      id?: string;
      sessionID: string;
      role?: Message['role'];
      agent?: string;
      error?: AssistantMessage['error'];
      time?: Message['time'];
    };

export type PartEventInfo =
  | Part
  | {
      id?: string;
      sessionID: string;
      messageID?: string;
      type?: Part['type'];
    };

export type PermissionEventProperties =
  | Permission
  | {
      id?: string;
      permissionID?: string;
      requestID?: string;
      permission?: string;
      patterns?: string | string[];
      sessionID: string;
      messageID?: string;
      callID?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      time?: { created: number };
      tool?: { messageID?: string; callID?: string };
      type?: string;
    };

export type PermissionReplyProperties = {
  id?: string;
  permissionID?: string;
  requestID?: string;
  sessionID?: string;
};

export type PermissionV2AskedProperties = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: 'tool'; messageID: string; callID: string };
};

export type PermissionV2ReplyProperties = {
  sessionID: string;
  requestID: string;
  reply: unknown;
};

export type QuestionReplyProperties = {
  id?: string;
  requestID: string;
  sessionID?: string;
};

export type QuestionV2AskedProperties = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: QuestionTool;
};

export type QuestionV2ReplyProperties = {
  id?: string;
  sessionID: string;
  requestID: string;
  answers?: unknown[];
};

export type MessagePartUpdatedProperties = {
  sessionID?: string;
  info?: { id?: string; sessionID?: string };
  part: PartEventInfo;
};

export type MessagePartDeltaProperties = {
  sessionID: string;
  messageID: string;
  partID: string;
  delta: string;
  field: string;
};

export type MessagePartRemovedProperties = {
  sessionID: string;
  messageID: string;
  partID: string;
};

export type MessageRemovedProperties = {
  sessionID: string;
  messageID: string;
};

export type SessionDiffProperties = {
  sessionID: string;
  diff: FileDiff[];
};

export type SessionErrorProperties = {
  sessionID?: string;
  error?: AssistantMessage['error'];
};

export type TodoUpdatedProperties = {
  sessionID: string;
  todos: unknown;
};

export type WorkspaceConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

export type WorkspaceStatusEntry = {
  workspaceID: string;
  status: WorkspaceConnectionState;
};

export type ServerLifecycleEventProperties = Record<string, unknown>;

export type ProjectUpdatedProperties = {
  id: string;
  worktree?: string;
  name?: string;
  vcs?: string;
  icon?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  time?: Record<string, unknown>;
  sandboxes?: string[];
};

export type AgentPermissionAction = 'ask' | 'allow' | 'deny';

export type AgentLegacyPermission = {
  edit?: AgentPermissionAction;
  bash?: { [key: string]: AgentPermissionAction };
  webfetch?: AgentPermissionAction;
  doom_loop?: AgentPermissionAction;
  external_directory?: AgentPermissionAction;
};

export type ToolOutputContent =
  | { type: 'text'; text: string }
  | { type: 'file'; uri: string; mime: string; name?: string };

export type SessionNextProviderResult = {
  executed: boolean;
  metadata?: { [key: string]: unknown };
};

export type SessionNextUnknownError = {
  type?: string;
  message?: string;
};

export type SessionNextRetryError = {
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
  responseHeaders?: { [key: string]: string };
  responseBody?: string;
  metadata?: { [key: string]: string };
};

export type ProviderAuthPromptText = {
  type: 'text';
  key: string;
  message: string;
  placeholder?: string;
  when?: {
    key: string;
    op: 'eq' | 'neq';
    value: string;
  };
};

export type ProviderAuthPromptSelect = {
  type: 'select';
  key: string;
  message: string;
  options: Array<{
    label: string;
    value: string;
    hint?: string;
  }>;
  when?: {
    key: string;
    op: 'eq' | 'neq';
    value: string;
  };
};

export type ProviderAuthMethod = {
  type: 'oauth' | 'api';
  label: string;
  prompts?: Array<ProviderAuthPromptText | ProviderAuthPromptSelect>;
};

export type ProviderAuthMethodsByProvider = Record<string, ProviderAuthMethod[]>;

export type ProviderAuthAuthorization = {
  url: string;
  method: 'auto' | 'code';
  instructions: string;
};

export type ServerEventPropertiesByName = {
  'server.connected': ServerLifecycleEventProperties;
  'server.heartbeat': ServerLifecycleEventProperties;
  'server.instance.disposed': ServerLifecycleEventProperties;
  'global.disposed': Record<string, unknown>;
  'catalog.updated': Record<string, unknown>;
  'models-dev.refreshed': Record<string, unknown>;
  'installation.updated': Record<string, unknown>;
  'installation.update-available': Record<string, unknown>;
  'integration.updated': Record<string, unknown>;
  'integration.connection.updated': Record<string, unknown>;
  'file.edited': Record<string, unknown>;
  'file.watcher.updated': Record<string, unknown>;
  'reference.updated': Record<string, unknown>;
  'plugin.added': Record<string, unknown>;
  'project.directories.updated': Record<string, unknown>;
  'project.updated': ProjectUpdatedProperties;
  'session.created': { sessionID?: string; info: SessionEventInfo };
  'session.updated': { sessionID?: string; info: SessionEventInfo };
  'session.deleted': { sessionID?: string; info: { id: string } };
  'session.status': { sessionID: string; status: SessionStatus };
  'session.error': SessionErrorProperties;
  'session.idle': { sessionID: string };
  'session.compacted': { sessionID: string };
  'session.diff': SessionDiffProperties;
  'message.updated': { info: MessageEventInfo };
  'message.part.updated': MessagePartUpdatedProperties;
  'message.part.delta': MessagePartDeltaProperties;
  'message.part.removed': MessagePartRemovedProperties;
  'message.removed': MessageRemovedProperties;
  'permission.updated': PermissionEventProperties;
  'permission.asked': PermissionEventProperties;
  'permission.replied': PermissionReplyProperties;
  'permission.v2.asked': PermissionV2AskedProperties;
  'permission.v2.replied': PermissionV2ReplyProperties;
  'question.asked': QuestionRequest;
  'question.replied': QuestionReplyProperties;
  'question.rejected': QuestionReplyProperties;
  'question.v2.asked': QuestionV2AskedProperties;
  'question.v2.replied': QuestionV2ReplyProperties;
  'question.v2.rejected': QuestionV2ReplyProperties;
  'todo.updated': TodoUpdatedProperties;
  'command.executed': Record<string, unknown>;
  'lsp.client.diagnostics': Record<string, unknown>;
  'lsp.updated': Record<string, unknown>;
  'vcs.branch.updated': { branch?: string };
  'mcp.tools.changed': Record<string, unknown>;
  'mcp.browser.open.failed': Record<string, unknown>;
  'pty.created': Record<string, unknown>;
  'pty.updated': Record<string, unknown>;
  'pty.exited': Record<string, unknown>;
  'pty.deleted': Record<string, unknown>;
  'tui.prompt.append': Record<string, unknown>;
  'tui.command.execute': Record<string, unknown>;
  'tui.toast.show': Record<string, unknown>;
  'tui.session.select': Record<string, unknown>;
  'workspace.ready': { name?: string };
  'workspace.failed': { message?: string };
  'workspace.status': WorkspaceStatusEntry;
  'worktree.ready': Record<string, unknown>;
  'worktree.failed': Record<string, unknown>;
  'session.next.agent.switched': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    agent: string;
  };
  'session.next.model.switched': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    model: { id?: string; providerID?: string; variant?: string };
  };
  'session.next.moved': {
    timestamp?: number;
    sessionID: string;
    location?: Record<string, unknown>;
    subdirectory?: string;
  };
  'session.next.prompted': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    prompt?: Record<string, unknown>;
    delivery?: 'steer' | 'queue';
  };
  'session.next.prompt.admitted': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    prompt?: Record<string, unknown>;
    delivery?: 'steer' | 'queue';
  };
  'session.next.context.updated': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    text?: string;
  };
  'session.next.synthetic': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    text?: string;
  };
  'session.next.shell.started': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    callID?: string;
    command?: string;
  };
  'session.next.shell.ended': {
    timestamp?: number;
    sessionID: string;
    callID?: string;
    output?: string;
  };
  'session.next.step.started': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    agent?: string;
    model?: { id?: string; providerID?: string; variant?: string };
    snapshot?: string;
  };
  'session.next.step.ended': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    finish?: string;
    cost?: number;
    tokens?: Record<string, unknown>;
    snapshot?: string;
    files?: string[];
  };
  'session.next.step.failed': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    error?: { type?: string; message?: string };
  };
  'session.next.text.started': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    textID?: string;
  };
  'session.next.text.delta': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    textID?: string;
    delta?: string;
    text?: string;
  };
  'session.next.text.ended': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    textID?: string;
    text?: string;
  };
  'session.next.reasoning.started': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    reasoningID?: string;
    providerMetadata?: Record<string, unknown>;
  };
  'session.next.reasoning.delta': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    reasoningID?: string;
    delta?: string;
    text?: string;
  };
  'session.next.reasoning.ended': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    reasoningID?: string;
    text?: string;
    providerMetadata?: Record<string, unknown>;
  };
  'session.next.tool.input.started': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    name?: string;
  };
  'session.next.tool.input.delta': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    delta?: string;
    input?: string;
  };
  'session.next.tool.input.ended': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    text?: string;
  };
  'session.next.tool.called': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    tool?: string;
    title?: string;
    input?: Record<string, unknown>;
    provider?: SessionNextProviderResult;
  };
  'session.next.tool.progress': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    progress?: string;
    structured?: Record<string, unknown>;
    content?: ToolOutputContent[];
  };
  'session.next.tool.success': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    output?: string;
    structured?: Record<string, unknown>;
    content?: ToolOutputContent[];
    outputPaths?: string[];
    result?: unknown;
    provider?: SessionNextProviderResult;
  };
  'session.next.tool.failed': {
    timestamp?: number;
    sessionID: string;
    assistantMessageID?: string;
    callID?: string;
    error?: string | SessionNextUnknownError;
    result?: unknown;
    provider?: SessionNextProviderResult;
  };
  'session.next.retried': {
    timestamp?: number;
    sessionID: string;
    attempt?: number;
    error?: SessionNextRetryError;
  };
  'session.next.compaction.started': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    reason?: 'auto' | 'manual';
  };
  'session.next.compaction.delta': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    text?: string;
  };
  'session.next.compaction.ended': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
    reason?: 'auto' | 'manual';
    text?: string;
    recent?: string;
    include?: string;
  };
  'session.next.revert.staged': {
    timestamp?: number;
    sessionID: string;
    revert?: Record<string, unknown>;
  };
  'session.next.revert.cleared': {
    timestamp?: number;
    sessionID: string;
  };
  'session.next.revert.committed': {
    timestamp?: number;
    sessionID: string;
    messageID?: string;
  };
};
