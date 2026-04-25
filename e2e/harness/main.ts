import type {
  InitialWebviewState,
  RecycleBinEntry,
  ServerStatus,
  WebviewMessage,
} from '../../src/shared/protocol';
import type {
  Agent,
  AssistantMessage,
  Message,
  Part,
  Provider,
  QuestionRequest,
  Session,
  SessionStatus,
} from '../../src/webview/types';

type MessageEntry<TMessage extends Message = Message> = { info: TMessage; parts: Part[] };
type PermissionResponse = {
  sessionId: string;
  permissionId: string;
  response: 'once' | 'always' | 'reject';
};
type RequestLog = { method: string; path: string; body?: unknown };
type ScenarioName =
  | 'blank'
  | 'pending-permission'
  | 'restored-session'
  | 'plan-ready'
  | 'sticky-preview'
  | 'todo-queue'
  | 'status-filters'
  | 'file-search'
  | 'transport-degraded'
  | 'usage-limit'
  | 'mcp-pickers'
  | 'slash-commands'
  | 'command-events'
  | 'no-providers'
  | 'busy-stop-send'
  | 'new-session-command'
  | 'session-search'
  | 'model-search'
  | 'mcp-search'
  | 'full-access'
  | 'abort-command'
  | 'server-error-missing-cli'
  | 'server-error-generic'
  | 'question-prompt'
  | 'archive-overflow'
  | 'context-compact'
  | 'review-slash'
  | 'undo-session'
  | 'linked-tool-question'
  | 'tool-cards'
  | 'subagent-sessions'
  | 'row-archive'
  | 'tool-card-errors'
  | 'grouped-permissions'
  | 'tool-open-actions';
type WorkspaceFile = {
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
};
type ScenarioState = {
  workspacePath: string;
  sessions: Session[];
  sessionStatuses: Record<string, SessionStatus>;
  messagesBySessionId: Record<string, MessageEntry[]>;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  agents: Agent[];
  questions: QuestionRequest[];
  pendingPermissions: Array<Record<string, unknown>>;
  recycleBinEntries: RecycleBinEntry[];
  persistedActiveSessionId: string | null;
  requests: RequestLog[];
  permissionResponses: PermissionResponse[];
  externalUrls: string[];
  planOpenRequests: string[];
  workspaceFiles: WorkspaceFile[];
  mcpStatus: Record<string, { status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration'; error?: string }>;
  storedState: {
    sessionSelectedAgents?: Record<string, string>;
    sessionSelectedMcps?: Record<string, string[]>;
    sessionPermissionModes?: Record<string, 'default' | 'full'>;
    lastSeenSessions?: Record<string, number>;
  };
  postReadyMessages: unknown[];
  readyStatus?: ServerStatus;
  nextSequence: number;
};

type HarnessWindow = Window & {
  __initialTheme?: string;
  __initialWebviewState?: InitialWebviewState;
  __sendToExtension?: (message: WebviewMessage) => void | Promise<void>;
  __varroE2E?: {
    requests: RequestLog[];
    permissionResponses: PermissionResponse[];
    externalUrls: string[];
    planOpenRequests: string[];
    terminalCommands?: Array<{ command: string; title?: string }>;
    settingsQueries?: string[];
    filePickCount?: number;
    openTargets?: Array<{ path: string; line?: number; kind?: string }>;
  };
};

type TerminalCommandLog = { command: string; title?: string };

const WORKSPACE_PATH = '/workspace/varro';
const TMP_WORKSPACE_PATH = '/workspace/varro/tmp/e2e-workspace';
const BASE_TIME = Date.UTC(2026, 3, 25, 12, 0, 0);
const THEME = 'dark';
const DEFAULT_PROVIDER_ID = 'copilot';
const DEFAULT_MODEL_ID = 'gpt-5-mini';
const DEFAULT_PERMISSION_RULES = [
  { permission: 'read', pattern: '*', action: 'allow' },
  { permission: 'glob', pattern: '*', action: 'allow' },
  { permission: 'grep', pattern: '*', action: 'allow' },
  { permission: 'bash', pattern: '*', action: 'ask' },
  { permission: 'edit', pattern: '*', action: 'ask' },
] as const satisfies Session['permission'];
const TMP_WORKSPACE_FILES: WorkspaceFile[] = [
  {
    path: `${TMP_WORKSPACE_PATH}/src/components/StickyHeader.tsx`,
    relativePath: 'src/components/StickyHeader.tsx',
    type: 'file',
  },
  {
    path: `${TMP_WORKSPACE_PATH}/src/components/PlanActions.tsx`,
    relativePath: 'src/components/PlanActions.tsx',
    type: 'file',
  },
  {
    path: `${TMP_WORKSPACE_PATH}/src/lib/session-filter.ts`,
    relativePath: 'src/lib/session-filter.ts',
    type: 'file',
  },
  {
    path: `${TMP_WORKSPACE_PATH}/tests/e2e/queue.spec.ts`,
    relativePath: 'tests/e2e/queue.spec.ts',
    type: 'file',
  },
  {
    path: `${TMP_WORKSPACE_PATH}/README.md`,
    relativePath: 'README.md',
    type: 'file',
  },
];

const providers: Provider[] = [
  {
    id: DEFAULT_PROVIDER_ID,
    name: 'GitHub Copilot',
    source: 'api',
    models: {
      [DEFAULT_MODEL_ID]: {
        id: DEFAULT_MODEL_ID,
        name: 'GPT-5 mini',
        capabilities: {
          reasoning: true,
          vision: false,
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 128000,
          output: 8192,
        },
        variants: {
          low: {
            reasoningEffort: 'low',
          },
          balanced: {
            reasoningEffort: 'medium',
          },
          high: {
            reasoningEffort: 'high',
          },
        },
      },
    },
  },
  {
    id: 'z-ai',
    name: 'Z.ai',
    source: 'api',
    models: {
      'glm-5.1': {
        id: 'glm-5.1',
        name: 'GLM 5.1',
        capabilities: {
          reasoning: true,
          vision: false,
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
        variants: {
          balanced: {
            reasoningEffort: 'medium',
          },
        },
      },
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    models: {
      'gpt-4.1': {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        capabilities: {
          reasoning: true,
          vision: true,
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 1000000,
          output: 32768,
        },
        variants: {
          low: { reasoningEffort: 'low' },
          balanced: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      'gpt-4.1-mini': {
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        capabilities: {
          reasoning: true,
          vision: true,
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
        variants: {
          balanced: { reasoningEffort: 'medium' },
        },
      },
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode Go',
    source: 'api',
    models: {
      'go-plan': {
        id: 'go-plan',
        name: 'Go Plan',
        capabilities: {
          reasoning: true,
          vision: false,
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 256000,
          output: 16384,
        },
        variants: {
          balanced: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      'go-build': {
        id: 'go-build',
        name: 'Go Build',
        capabilities: {
          reasoning: true,
          vision: false,
          toolcall: true,
        },
        cost: {
          input: 0,
          output: 0,
        },
        limit: {
          context: 256000,
          output: 16384,
        },
        variants: {
          balanced: { reasoningEffort: 'medium' },
        },
      },
    },
  },
];

const agents: Agent[] = [
  {
    name: 'build',
    description: 'Write and update code',
    mode: 'primary',
    builtIn: true,
    permission: {
      edit: 'ask',
      bash: {},
      webfetch: 'ask',
    },
    tools: {
      bash: true,
      read: true,
      grep: true,
    },
  },
  {
    name: 'plan',
    description: 'Draft implementation plans',
    mode: 'primary',
    builtIn: true,
    permission: {
      edit: 'ask',
      bash: {},
      webfetch: 'ask',
    },
    tools: {
      read: true,
    },
  },
];

function nextTimestamp(state: ScenarioState) {
  state.nextSequence += 1;
  return BASE_TIME + state.nextSequence * 1000;
}

function makeSession(id: string, title: string, updatedAt: number): Session {
  return {
    id,
    projectID: 'project-varro',
    directory: WORKSPACE_PATH,
    title,
    version: '1',
    time: {
      created: updatedAt - 30_000,
      updated: updatedAt,
    },
  };
}

function makeSessionWithPermission(
  id: string,
  title: string,
  updatedAt: number,
  permission: Session['permission']
): Session {
  return {
    ...makeSession(id, title, updatedAt),
    permission: permission ? [...permission] : undefined,
  };
}

function makeUserMessage(
  sessionId: string,
  id: string,
  textParts: string[],
  createdAt: number
): MessageEntry {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: 'user',
      time: { created: createdAt },
      agent: 'build',
      model: { providerID: DEFAULT_PROVIDER_ID, modelID: DEFAULT_MODEL_ID },
    },
    parts: textParts.map((text, index) => ({
      id: `${id}-part-${index + 1}`,
      sessionID: sessionId,
      messageID: id,
      type: 'text',
      text,
    })),
  };
}

function makeAssistantMessage(
  sessionId: string,
  id: string,
  parentId: string,
  text: string,
  createdAt: number
): MessageEntry<AssistantMessage> {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: 'assistant',
      time: { created: createdAt, completed: createdAt + 1 },
      parentID: parentId,
      modelID: DEFAULT_MODEL_ID,
      providerID: DEFAULT_PROVIDER_ID,
      mode: 'primary',
      agent: 'build',
      path: { cwd: WORKSPACE_PATH, root: WORKSPACE_PATH },
      summary: false,
      cost: 0,
      tokens: {
        input: 32,
        output: 64,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: 'stop',
    },
    parts: [
      {
        id: `${id}-part-1`,
        sessionID: sessionId,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

function makeReasoningPart(
  sessionId: string,
  messageId: string,
  id: string,
  text: string,
  startedAt: number,
  endedAt?: number
): Extract<Part, { type: 'reasoning' }> {
  return {
    id,
    sessionID: sessionId,
    messageID: messageId,
    type: 'reasoning',
    text,
    time: {
      start: startedAt,
      ...(endedAt ? { end: endedAt } : {}),
    },
  };
}

function makeTextPart(
  sessionId: string,
  messageId: string,
  id: string,
  text: string
): Extract<Part, { type: 'text' }> {
  return {
    id,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  };
}

function makePlanAssistantMessage(
  sessionId: string,
  id: string,
  parentId: string,
  createdAt: number,
  text: string
): MessageEntry<AssistantMessage> {
  const message = makeAssistantMessage(sessionId, id, parentId, text, createdAt);
  message.info.agent = 'plan';
  message.info.providerID = 'z-ai';
  message.info.modelID = 'glm-5.1';
  message.info.variant = 'balanced';
  message.parts = [
    makeReasoningPart(
      sessionId,
      id,
      `${id}-reasoning-1`,
      'Planning the implementation steps before writing the final plan.',
      createdAt,
      createdAt + 1
    ),
    makeTextPart(sessionId, id, `${id}-text-1`, text),
  ];
  message.info.tokens = {
    input: 188,
    output: 472,
    reasoning: 96,
    cache: { read: 0, write: 0 },
  };
  return message;
}

function makeTodoToolPart(
  sessionId: string,
  messageId: string,
  id: string,
  todos: Array<{ id: string; content: string; status: string; priority: string }>
): Extract<Part, { type: 'tool' }> {
  return {
    id,
    sessionID: sessionId,
    messageID: messageId,
    type: 'tool',
    callID: `${id}-call`,
    tool: 'todowrite',
    state: {
      status: 'completed',
      input: { todos },
      output: JSON.stringify(todos),
      title: 'Track implementation tasks',
      metadata: {},
      time: { start: BASE_TIME, end: BASE_TIME + 1 },
    },
  };
}

function makeCompletedAssistantMessageWithParts(
  sessionId: string,
  id: string,
  parentId: string,
  createdAt: number,
  text: string,
  extraParts: Part[] = []
): MessageEntry<AssistantMessage> {
  const message = makeAssistantMessage(sessionId, id, parentId, text, createdAt);
  message.parts = [makeTextPart(sessionId, id, `${id}-text-1`, text), ...extraParts];
  return message;
}

function makeQuestionRequest(
  sessionId: string,
  id: string,
  question: string,
  header: string
): QuestionRequest {
  return {
    id,
    sessionID: sessionId,
    questions: [
      {
        question,
        header,
        options: [
          { label: 'Yes', description: 'Approve it' },
          { label: 'No', description: 'Reject it' },
        ],
      },
    ],
  };
}

function getWorkspaceFilesForScenario(name: ScenarioName): WorkspaceFile[] {
  return name === 'file-search' ? structuredClone(TMP_WORKSPACE_FILES) : [];
}

function addDenseSearchModels(state: ScenarioState) {
  const openai = state.providers.find((provider) => provider.id === 'openai');
  if (openai) {
    openai.models['gpt-4o'] = {
      id: 'gpt-4o',
      name: 'GPT-4o',
      capabilities: { reasoning: true, vision: true, toolcall: true },
      cost: { input: 0, output: 0 },
      limit: { context: 128000, output: 16384 },
      variants: { balanced: { reasoningEffort: 'medium' } },
    };
    openai.models['gpt-4o-mini'] = {
      id: 'gpt-4o-mini',
      name: 'GPT-4o mini',
      capabilities: { reasoning: true, vision: true, toolcall: true },
      cost: { input: 0, output: 0 },
      limit: { context: 128000, output: 16384 },
      variants: { balanced: { reasoningEffort: 'medium' } },
    };
  }

  const opencode = state.providers.find((provider) => provider.id === 'opencode');
  if (opencode) {
    opencode.models['go-fast'] = {
      id: 'go-fast',
      name: 'Go Fast',
      capabilities: { reasoning: true, vision: false, toolcall: true },
      cost: { input: 0, output: 0 },
      limit: { context: 256000, output: 16384 },
      variants: { balanced: { reasoningEffort: 'medium' } },
    };
    opencode.models['go-review'] = {
      id: 'go-review',
      name: 'Go Review',
      capabilities: { reasoning: true, vision: false, toolcall: true },
      cost: { input: 0, output: 0 },
      limit: { context: 256000, output: 16384 },
      variants: { balanced: { reasoningEffort: 'medium' } },
    };
  }

  const zAi = state.providers.find((provider) => provider.id === 'z-ai');
  if (zAi) {
    zAi.models['glm-5.1-fast'] = {
      id: 'glm-5.1-fast',
      name: 'GLM 5.1 Fast',
      capabilities: { reasoning: true, vision: false, toolcall: true },
      cost: { input: 0, output: 0 },
      limit: { context: 128000, output: 16384 },
      variants: { balanced: { reasoningEffort: 'medium' } },
    };
  }
}

function createDenseMcpStatus() {
  return {
    chrome: { status: 'connected' as const },
    figma: { status: 'needs_auth' as const, error: 'Login required' },
    github: { status: 'failed' as const, error: 'CLI not authenticated' },
    playwright: { status: 'disabled' as const },
    linear: { status: 'connected' as const },
    notion: { status: 'disabled' as const },
    slack: { status: 'connected' as const },
    jira: { status: 'needs_client_registration' as const, error: 'Register client first' },
    sentry: { status: 'failed' as const, error: 'Token expired' },
  };
}

function createScenarioState(name: ScenarioName): ScenarioState {
  const state: ScenarioState = {
    workspacePath: name === 'file-search' ? TMP_WORKSPACE_PATH : WORKSPACE_PATH,
    sessions: [],
    sessionStatuses: {},
    messagesBySessionId: {},
    providers: structuredClone(providers),
    providerDefaults: { [DEFAULT_PROVIDER_ID]: DEFAULT_MODEL_ID },
    agents: structuredClone(agents),
    questions: [],
    pendingPermissions: [],
    recycleBinEntries: [],
    persistedActiveSessionId: null,
    requests: [],
    permissionResponses: [],
    externalUrls: [],
    planOpenRequests: [],
    workspaceFiles: getWorkspaceFilesForScenario(name),
    mcpStatus: {},
    storedState: {},
    postReadyMessages: [],
    readyStatus: { state: 'running', url: 'mock://opencode', eventStream: 'healthy' },
    nextSequence: 0,
  };

  if (name === 'restored-session') {
    const session = makeSession('session-restored', 'Restored Session', BASE_TIME - 2_000);
    const user = makeUserMessage(
      session.id,
      'message-restored-user',
      ['Review the refactor status'],
      BASE_TIME - 8_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-restored-assistant',
      user.info.id,
      'Refactor status looks good. The latest cleanup is ready for review.',
      BASE_TIME - 6_000
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 10;
    return state;
  }

  if (name === 'pending-permission') {
    const session = makeSession('session-permission', 'Permission Request', BASE_TIME - 1_000);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.pendingPermissions = [
      {
        id: 'permission-run-tests',
        permission: 'bash',
        sessionID: session.id,
        messageID: 'message-pending',
        title: 'Allow running npm test?',
        metadata: {
          command: 'npm test',
        },
        patterns: ['npm test'],
        time: { created: BASE_TIME - 500 },
      },
    ];
    state.nextSequence = 20;
    return state;
  }

  if (name === 'plan-ready') {
    const session = makeSession('session-plan-ready', 'Plan migration rollout', BASE_TIME - 1_000);
    const user = makeUserMessage(
      session.id,
      'message-plan-user',
      [
        'Use Copilot GPT-5-mini and Z.ai GLM 5.1 to draft a practical rollout plan for migrating the e2e coverage.',
      ],
      BASE_TIME - 8_000
    );
    const assistant = makePlanAssistantMessage(
      session.id,
      'message-plan-assistant',
      user.info.id,
      BASE_TIME - 5_000,
      [
        '# Migration Plan',
        '',
        '1. Audit the current Playwright harness coverage and identify missing real user journeys.',
        '2. Add a planning-mode path that ends in a durable plan artifact instead of code changes.',
        '3. Validate default-permission flows with a real bash request such as `opencode --version`.',
        '4. Exercise sticky prompt behavior with a long assistant reply and confirm the preview yields before overlap.',
      ].join('\n')
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 40;
    return state;
  }

  if (name === 'sticky-preview') {
    const session = makeSession('session-sticky-preview', 'Sticky header overlap', BASE_TIME - 500);
    const longPrompt = Array.from(
      { length: 18 },
      (_, index) => `Line ${index + 1}: keep this prompt visible while the answer scrolls.`
    ).join('\n');
    const longResponse = Array.from(
      { length: 36 },
      (_, index) =>
        `Response section ${index + 1}: verifying that the sticky preview remains readable without colliding with the next prompt.`
    ).join('\n\n');
    const followupPrompt = 'Follow-up prompt that should hide the sticky preview before any overlap occurs.';
    const user1 = makeUserMessage(session.id, 'message-sticky-user-1', [longPrompt], BASE_TIME - 20_000);
    const assistant1 = makeAssistantMessage(
      session.id,
      'message-sticky-assistant-1',
      user1.info.id,
      longResponse,
      BASE_TIME - 18_000
    );
    const user2 = makeUserMessage(
      session.id,
      'message-sticky-user-2',
      [followupPrompt],
      BASE_TIME - 2_000
    );
    const assistant2 = makeAssistantMessage(
      session.id,
      'message-sticky-assistant-2',
      user2.info.id,
      'Short final response to keep the second prompt near the viewport.',
      BASE_TIME - 1_000
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user1, assistant1, user2, assistant2];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 50;
    return state;
  }

  if (name === 'todo-queue') {
    const session = makeSessionWithPermission(
      'session-todo-queue',
      'Queued follow-up coverage',
      BASE_TIME - 500,
      DEFAULT_PERMISSION_RULES as unknown as Session['permission']
    );
    const user = makeUserMessage(
      session.id,
      'message-todo-user',
      ['Keep working through the remaining e2e tasks.'],
      BASE_TIME - 8_000
    );
    const assistant = makeCompletedAssistantMessageWithParts(
      session.id,
      'message-todo-assistant',
      user.info.id,
      BASE_TIME - 6_000,
      'Captured the next implementation steps and waiting for follow-up work.',
      [
        makeTodoToolPart(session.id, 'message-todo-assistant', 'todo-tool-1', [
          {
            id: 'todo-1',
            content: 'Add queue coverage for busy sessions',
            status: 'in_progress',
            priority: 'high',
          },
          {
            id: 'todo-2',
            content: 'Confirm todos stay visible above the composer',
            status: 'pending',
            priority: 'medium',
          },
        ]),
      ]
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'busy' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 60;
    return state;
  }

  if (name === 'status-filters') {
    const running = makeSession('session-running', 'Running lint repair', BASE_TIME - 5_000);
    const failed = makeSession('session-failed', 'Failing provider sync', BASE_TIME - 4_000);
    const attention = makeSession('session-attention', 'Waiting on permission', BASE_TIME - 3_000);
    const planReady = makeSession('session-plan-filter', 'Plan awaiting implementation', BASE_TIME - 2_000);
    const completed = makeSession('session-completed', 'Completed sticky cleanup', BASE_TIME - 1_000);
    const failedUser = makeUserMessage(
      failed.id,
      'message-failed-user',
      ['Retry the provider sync.'],
      BASE_TIME - 4_500
    );
    const failedAssistant = makeAssistantMessage(
      failed.id,
      'message-failed-assistant',
      failedUser.info.id,
      'Provider sync failed.',
      BASE_TIME - 4_000
    );
    failedAssistant.info.error = {
      name: 'ProviderError',
      data: { message: 'Provider sync failed.' },
    };
    state.sessions = [completed, planReady, attention, failed, running];
    state.sessionStatuses[running.id] = { type: 'busy' };
    state.sessionStatuses[failed.id] = { type: 'idle' };
    state.sessionStatuses[attention.id] = { type: 'idle' };
    state.sessionStatuses[planReady.id] = { type: 'idle' };
    state.sessionStatuses[completed.id] = { type: 'idle' };
    state.messagesBySessionId = {
      [running.id]: [],
      [failed.id]: [failedUser, failedAssistant],
      [attention.id]: [],
      [planReady.id]: [],
      [completed.id]: [],
    };
    state.pendingPermissions = [
      {
        id: 'permission-status-filter',
        permission: 'bash',
        type: 'bash',
        sessionID: attention.id,
        messageID: 'message-attention',
        title: 'Allow running npm run lint?',
        metadata: { command: 'npm run lint' },
        patterns: ['npm run lint'],
        time: { created: BASE_TIME - 2_500 },
      },
    ];
    state.persistedActiveSessionId = completed.id;
    state.nextSequence = 70;
    state.storedState = {
      sessionSelectedAgents: { [planReady.id]: 'plan' },
      lastSeenSessions: {
        [completed.id]: BASE_TIME - 10_000,
        [planReady.id]: BASE_TIME - 10_000,
      },
    };
    return state;
  }

  if (name === 'file-search') {
    const session = makeSessionWithPermission(
      'session-file-search',
      'Attach tmp workspace files',
      BASE_TIME - 500,
      DEFAULT_PERMISSION_RULES as unknown as Session['permission']
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 80;
    return state;
  }

  if (name === 'transport-degraded') {
    const session = makeSession('session-transport', 'Reconnecting stream', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.readyStatus = { state: 'running', url: 'mock://opencode', eventStream: 'degraded' };
    state.nextSequence = 90;
    return state;
  }

  if (name === 'usage-limit') {
    const session = makeSession('session-usage-limit', '429 retry handling', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-usage-user',
      ['Retry the OpenAI request after the provider quota resets.'],
      BASE_TIME - 6_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-usage-assistant',
      user.info.id,
      'The provider returned 429 usage limit reached. retry in 45s attempt #2',
      BASE_TIME - 5_000
    );
    assistant.info.providerID = 'openai';
    assistant.info.modelID = 'gpt-4.1';
    assistant.info.error = {
      name: 'rate_limit_exceeded',
      data: { message: '429 usage limit reached. retry in 45s attempt #2' },
    };
    state.sessions = [session];
    state.sessionStatuses[session.id] = {
      type: 'retry',
      attempt: 2,
      message: '429 usage limit reached. retry in 45s attempt #2',
      next: 45,
    };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 100;
    return state;
  }

  if (name === 'mcp-pickers') {
    const session = makeSessionWithPermission(
      'session-mcp-picker',
      'Inspect MCP integrations',
      BASE_TIME - 500,
      DEFAULT_PERMISSION_RULES as unknown as Session['permission']
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.mcpStatus = {
      chrome: { status: 'connected' },
      figma: { status: 'needs_auth', error: 'Login required' },
      playwright: { status: 'disabled' },
      github: { status: 'failed', error: 'CLI not authenticated' },
    };
    state.storedState = {
      sessionSelectedMcps: {
        [session.id]: ['chrome'],
      },
    };
    state.nextSequence = 110;
    return state;
  }

  if (name === 'slash-commands') {
    const session = makeSessionWithPermission(
      'session-slash',
      'Slash command flows',
      BASE_TIME - 500,
      DEFAULT_PERMISSION_RULES as unknown as Session['permission']
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.mcpStatus = {
      chrome: { status: 'connected' },
      playwright: { status: 'disabled' },
    };
    state.storedState = {
      sessionSelectedMcps: {
        [session.id]: ['chrome'],
      },
    };
    state.nextSequence = 120;
    return state;
  }

  if (name === 'command-events') {
    const session = makeSession('session-command-events', 'Host command events', BASE_TIME - 500);
    const secondSession = makeSession(
      'session-command-events-2',
      'Follow up attention queue',
      BASE_TIME - 700
    );
    const thirdSession = makeSession(
      'session-command-events-3',
      'Build approval required',
      BASE_TIME - 900
    );
    state.sessions = [session, secondSession, thirdSession];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.sessionStatuses[secondSession.id] = { type: 'idle' };
    state.sessionStatuses[thirdSession.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.messagesBySessionId[secondSession.id] = [];
    state.messagesBySessionId[thirdSession.id] = [];
    state.persistedActiveSessionId = session.id;
    state.postReadyMessages.push(
      { type: 'command/focus-input' },
      { type: 'command/open-attention-sessions' }
    );
    state.pendingPermissions = [
      {
        id: 'permission-command-event',
        permission: 'bash',
        type: 'bash',
        sessionID: secondSession.id,
        messageID: 'message-command-event',
        title: 'Allow running npm run build?',
        metadata: { command: 'npm run build' },
        patterns: ['npm run build'],
        time: { created: BASE_TIME - 100 },
      },
      {
        id: 'permission-command-event-2',
        permission: 'edit',
        type: 'edit',
        sessionID: thirdSession.id,
        messageID: 'message-command-event-2',
        title: 'Allow editing src/routes.ts?',
        metadata: { path: 'src/routes.ts' },
        patterns: ['src/routes.ts'],
        time: { created: BASE_TIME - 90 },
      },
    ];
    state.nextSequence = 130;
    return state;
  }

  if (name === 'no-providers') {
    state.providers = [];
    state.providerDefaults = {};
    state.nextSequence = 140;
    return state;
  }

  if (name === 'busy-stop-send') {
    const session = makeSession('session-busy-stop-send', 'Busy stop and send', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-busy-user',
      ['Continue the refactor while I prepare one more instruction.'],
      BASE_TIME - 4_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-busy-assistant',
      user.info.id,
      'Still working through the requested refactor steps.',
      BASE_TIME - 3_000
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'busy' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 150;
    return state;
  }

  if (name === 'new-session-command') {
    const session = makeSession('session-command-seed', 'Existing session', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.postReadyMessages.push({ type: 'command/new-session' });
    state.nextSequence = 160;
    return state;
  }

  if (name === 'session-search') {
    const alpha = makeSession('session-search-alpha', 'Alpha release checklist', BASE_TIME - 500);
    const beta = makeSession('session-search-beta', 'Beta rollout notes', BASE_TIME - 700);
    const gamma = makeSession('session-search-gamma', 'Gamma cleanup pass', BASE_TIME - 900);
    state.sessions = [alpha, beta, gamma];
    state.sessionStatuses[alpha.id] = { type: 'idle' };
    state.sessionStatuses[beta.id] = { type: 'idle' };
    state.sessionStatuses[gamma.id] = { type: 'idle' };
    state.messagesBySessionId[alpha.id] = [];
    state.messagesBySessionId[beta.id] = [];
    state.messagesBySessionId[gamma.id] = [];
    state.persistedActiveSessionId = alpha.id;
    state.nextSequence = 170;
    return state;
  }

  if (name === 'model-search') {
    const session = makeSession('session-model-search', 'Model picker search', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    addDenseSearchModels(state);
    state.nextSequence = 180;
    return state;
  }

  if (name === 'mcp-search') {
    const session = makeSession('session-mcp-search', 'MCP picker search', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.mcpStatus = createDenseMcpStatus();
    state.storedState = {
      sessionSelectedMcps: {
        [session.id]: ['chrome', 'linear'],
      },
    };
    state.nextSequence = 190;
    return state;
  }

  if (name === 'full-access') {
    const session = makeSessionWithPermission(
      'session-full-access',
      'Full access mode',
      BASE_TIME - 500,
      [
        { permission: 'read', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'glob', pattern: '*', action: 'allow' },
        { permission: 'grep', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'allow' },
      ] as unknown as Session['permission']
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.storedState = {
      sessionPermissionModes: {
        [session.id]: 'full',
      },
    };
    state.nextSequence = 200;
    return state;
  }

  if (name === 'abort-command') {
    const session = makeSession('session-abort-command', 'Abort command flow', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-abort-user',
      ['Continue running until the extension sends an abort command.'],
      BASE_TIME - 4_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-abort-assistant',
      user.info.id,
      'The task is still running.',
      BASE_TIME - 3_000
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'busy' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.postReadyMessages.push({ type: 'command/abort' });
    state.nextSequence = 210;
    return state;
  }

  if (name === 'server-error-missing-cli') {
    state.readyStatus = { state: 'error', message: 'OpenCode CLI not found in PATH' } as const;
    state.providers = [];
    state.providerDefaults = {};
    state.nextSequence = 220;
    return state;
  }

  if (name === 'server-error-generic') {
    state.readyStatus = { state: 'error', message: 'Failed to bind local server port' } as const;
    state.providers = [];
    state.providerDefaults = {};
    state.nextSequence = 230;
    return state;
  }

  if (name === 'question-prompt') {
    const session = makeSession('session-question-prompt', 'Question prompt flow', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.questions = [
      {
        id: 'question-prompt-1',
        sessionID: session.id,
        questions: [
          {
            question: 'Which rollout should we use?',
            header: 'Rollout choice',
            options: [
              { label: 'Canary', description: 'Ship it gradually' },
              { label: 'Big bang', description: 'Ship it everywhere at once' },
            ],
          },
        ],
      },
    ];
    state.nextSequence = 240;
    return state;
  }

  if (name === 'archive-overflow') {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession(
        `session-archive-${index + 1}`,
        `Archive candidate ${index + 1}`,
        BASE_TIME - (index + 2) * 24 * 60 * 60 * 1000
      )
    );
    state.sessions = sessions;
    for (const session of sessions) {
      state.sessionStatuses[session.id] = { type: 'idle' };
      state.messagesBySessionId[session.id] = [];
    }
    state.persistedActiveSessionId = sessions[0]?.id || null;
    state.nextSequence = 250;
    return state;
  }

  if (name === 'context-compact') {
    const session = makeSession('session-context-compact', 'Context compact flow', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-context-user',
      ['Summarize the large session before continuing.'],
      BASE_TIME - 4_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-context-assistant',
      user.info.id,
      'The session has grown large enough that compacting would help before continuing.',
      BASE_TIME - 3_000
    );
    assistant.info.tokens = {
      input: 200_000,
      output: 40_000,
      reasoning: 10_000,
      cache: { read: 0, write: 0 },
      total: 250_000,
    };
    assistant.info.providerID = 'opencode';
    assistant.info.modelID = 'go-plan';
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 260;
    return state;
  }

  if (name === 'review-slash') {
    const session = makeSession('session-review-slash', 'Review slash flow', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 270;
    return state;
  }

  if (name === 'undo-session') {
    const session = makeSession('session-undo', 'Undo session flow', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-undo-user',
      ['Generate a first draft before undoing it.'],
      BASE_TIME - 5_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-undo-assistant',
      user.info.id,
      'Here is the first draft that can be reverted.',
      BASE_TIME - 4_000
    );
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 280;
    return state;
  }

  if (name === 'linked-tool-question') {
    const session = makeSession('session-linked-question', 'Linked tool question', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-linked-question-user',
      ['Run the tool and ask which environment to use.'],
      BASE_TIME - 5_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-linked-question-assistant',
      user.info.id,
      'I need one more answer before continuing.',
      BASE_TIME - 4_000
    );
    assistant.parts = [
      {
        id: 'tool-question-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'linked-question-call-1',
        tool: 'question',
        state: {
          status: 'running',
          input: { question: 'Which environment should I target?' },
          title: 'Ask follow-up question',
          metadata: {},
          time: { start: BASE_TIME - 4_000 },
        },
      },
    ];
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.questions = [
      {
        id: 'linked-tool-question-1',
        sessionID: session.id,
        tool: { messageID: assistant.info.id, callID: 'linked-question-call-1' },
        questions: [
          {
            question: 'Which environment should I target?',
            header: 'Target environment',
            options: [
              { label: 'Staging', description: 'Use the staging environment' },
              { label: 'Production', description: 'Use the production environment' },
            ],
          },
        ],
      },
    ];
    state.nextSequence = 290;
    return state;
  }

  if (name === 'tool-cards') {
    const session = makeSession('session-tool-cards', 'Tool card rendering', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-tool-cards-user',
      ['Show read, edit, and bash tool cards.'],
      BASE_TIME - 6_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-tool-cards-assistant',
      user.info.id,
      'Here are representative tool invocations.',
      BASE_TIME - 5_000
    );
    assistant.parts = [
      {
        id: 'tool-read-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-read-call-1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { file_path: '/workspace/varro/src/index.ts', offset: 1, limit: 20 },
          output: '<type>file</type>\n<content>export const value = 1;</content>',
          title: 'Read file',
          metadata: {},
          time: { start: BASE_TIME - 5_000, end: BASE_TIME - 4_900 },
        },
      },
      {
        id: 'tool-edit-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-edit-call-1',
        tool: 'edit',
        state: {
          status: 'completed',
          input: { file_path: '/workspace/varro/src/index.ts', old_string: 'value = 1', new_string: 'value = 2' },
          output: 'Updated /workspace/varro/src/index.ts',
          title: 'Edit file',
          metadata: { additions: 1, deletions: 1 },
          time: { start: BASE_TIME - 4_800, end: BASE_TIME - 4_700 },
        },
      },
      {
        id: 'tool-bash-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-bash-call-1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'npm test', description: 'Runs the test suite' },
          output: '3 passed',
          title: 'Run command',
          metadata: {},
          time: { start: BASE_TIME - 4_600, end: BASE_TIME - 4_400 },
        },
      },
    ];
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 300;
    return state;
  }

  if (name === 'subagent-sessions') {
    const parent = makeSession('session-parent', 'Parent orchestration', BASE_TIME - 500);
    const childA = {
      ...makeSession('session-child-a', 'Inspect API routes', BASE_TIME - 400),
      parentID: parent.id,
    };
    const childB = {
      ...makeSession('session-child-b', 'Update tests', BASE_TIME - 300),
      parentID: parent.id,
    };
    state.sessions = [childB, childA, parent];
    state.sessionStatuses[parent.id] = { type: 'idle' };
    state.sessionStatuses[childA.id] = { type: 'idle' };
    state.sessionStatuses[childB.id] = { type: 'idle' };
    state.messagesBySessionId[parent.id] = [];
    state.messagesBySessionId[childA.id] = [];
    state.messagesBySessionId[childB.id] = [];
    state.persistedActiveSessionId = null;
    state.nextSequence = 310;
    return state;
  }

  if (name === 'row-archive') {
    const alpha = makeSession('session-row-archive-a', 'Archive row target', BASE_TIME - 500);
    const beta = makeSession('session-row-archive-b', 'Keep me', BASE_TIME - 700);
    state.sessions = [alpha, beta];
    state.sessionStatuses[alpha.id] = { type: 'idle' };
    state.sessionStatuses[beta.id] = { type: 'idle' };
    state.messagesBySessionId[alpha.id] = [];
    state.messagesBySessionId[beta.id] = [];
    state.persistedActiveSessionId = beta.id;
    state.nextSequence = 320;
    return state;
  }

  if (name === 'tool-card-errors') {
    const session = makeSession('session-tool-card-errors', 'Tool card errors', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-tool-errors-user',
      ['Show aborted and failed tool cards.'],
      BASE_TIME - 5_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-tool-errors-assistant',
      user.info.id,
      'Here are failing tool states.',
      BASE_TIME - 4_000
    );
    assistant.parts = [
      {
        id: 'tool-read-error-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-read-error-call-1',
        tool: 'read',
        state: {
          status: 'error',
          input: { file_path: '/workspace/varro/src/missing.ts' },
          error: 'aborted',
          metadata: {},
          time: { start: BASE_TIME - 4_000, end: BASE_TIME - 3_900 },
        },
      },
      {
        id: 'tool-bash-error-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-bash-error-call-1',
        tool: 'bash',
        state: {
          status: 'error',
          input: { command: 'npm test' },
          error: 'Command failed with exit code 1',
          metadata: {},
          time: { start: BASE_TIME - 3_800, end: BASE_TIME - 3_700 },
        },
      },
    ];
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 330;
    return state;
  }

  if (name === 'grouped-permissions') {
    const session = makeSession('session-grouped-permissions', 'Grouped permissions', BASE_TIME - 500);
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [];
    state.persistedActiveSessionId = session.id;
    state.pendingPermissions = [
      {
        id: 'permission-group-1',
        permission: 'bash',
        sessionID: session.id,
        messageID: 'message-group-1',
        callID: 'call-group-1',
        title: 'Allow running npm test?',
        metadata: { command: 'npm test' },
        patterns: ['npm test'],
        time: { created: BASE_TIME - 100 },
      },
      {
        id: 'permission-group-2',
        permission: 'bash',
        sessionID: session.id,
        messageID: 'message-group-2',
        callID: 'call-group-2',
        title: 'Allow running npm test?',
        metadata: { command: 'npm test' },
        patterns: ['npm test'],
        time: { created: BASE_TIME - 99 },
      },
    ];
    state.nextSequence = 340;
    return state;
  }

  if (name === 'tool-open-actions') {
    const session = makeSession('session-tool-open-actions', 'Tool open actions', BASE_TIME - 500);
    const user = makeUserMessage(
      session.id,
      'message-tool-open-user',
      ['Open the file and directory from tool cards.'],
      BASE_TIME - 5_000
    );
    const assistant = makeAssistantMessage(
      session.id,
      'message-tool-open-assistant',
      user.info.id,
      'Tool cards should open VS Code targets.',
      BASE_TIME - 4_000
    );
    assistant.parts = [
      {
        id: 'tool-open-read-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-open-read-call-1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { file_path: '/workspace/varro/src/components/App.tsx', offset: 1, limit: 20 },
          output: '<type>file</type>\n<content>export function App() {}</content>',
          title: 'Read file',
          metadata: {},
          time: { start: BASE_TIME - 4_000, end: BASE_TIME - 3_900 },
        },
      },
      {
        id: 'tool-open-dir-1',
        sessionID: session.id,
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-open-dir-call-1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { file_path: '/workspace/varro/src/components' },
          output: '<type>directory</type>\n<entries>App.tsx</entries>',
          title: 'Read directory',
          metadata: {},
          time: { start: BASE_TIME - 3_800, end: BASE_TIME - 3_700 },
        },
      },
    ];
    state.sessions = [session];
    state.sessionStatuses[session.id] = { type: 'idle' };
    state.messagesBySessionId[session.id] = [user, assistant];
    state.persistedActiveSessionId = session.id;
    state.nextSequence = 350;
    return state;
  }

  state.nextSequence = 30;
  return state;
}

function getScenarioName(): ScenarioName {
  const value = new URLSearchParams(window.location.search).get('scenario');
  if (
    value === 'restored-session' ||
    value === 'pending-permission' ||
    value === 'plan-ready' ||
    value === 'sticky-preview' ||
    value === 'todo-queue' ||
    value === 'status-filters' ||
    value === 'file-search' ||
    value === 'transport-degraded' ||
    value === 'usage-limit' ||
    value === 'mcp-pickers' ||
    value === 'slash-commands' ||
    value === 'command-events' ||
    value === 'no-providers' ||
    value === 'busy-stop-send' ||
    value === 'new-session-command' ||
    value === 'session-search' ||
    value === 'model-search' ||
    value === 'mcp-search' ||
    value === 'full-access' ||
    value === 'abort-command' ||
    value === 'server-error-missing-cli' ||
    value === 'server-error-generic' ||
    value === 'question-prompt' ||
    value === 'archive-overflow' ||
    value === 'context-compact' ||
    value === 'review-slash' ||
    value === 'undo-session' ||
    value === 'linked-tool-question' ||
    value === 'tool-cards' ||
    value === 'subagent-sessions' ||
    value === 'row-archive' ||
    value === 'tool-card-errors' ||
    value === 'grouped-permissions' ||
    value === 'tool-open-actions'
  ) {
    return value;
  }
  return 'blank';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getSession(state: ScenarioState, id: string) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`Unknown session: ${id}`);
  return session;
}

function buildInitialState(state: ScenarioState): InitialWebviewState {
  return {
    theme: THEME,
    serverStatus: { state: 'stopped' },
    editorContext: {
      workspacePath: state.workspacePath,
      activeFile: null,
      selection: null,
      diagnostics: [],
    },
    terminalSelection: null,
    droppedFiles: [],
    emptyStateLogoUri: '',
    showStickyUserPrompt: true,
    pendingPermissions: state.pendingPermissions,
    pendingQuestions: [],
    recycleBinEntries: state.recycleBinEntries,
  };
}

function dispatchToWebview(message: unknown) {
  window.postMessage(message, '*');
}

function dispatchPostReadyMessage(message: unknown) {
  if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    (message.type === 'command/open-attention-sessions' || message.type === 'command/abort')
  ) {
    window.setTimeout(() => dispatchToWebview(message), 150);
    return;
  }

  dispatchToWebview(message);
}

function sendApiResponse(id: number, payload: { data?: unknown; error?: string }) {
  dispatchToWebview({
    type: 'api/response',
    payload: { id, ...payload },
  });
}

async function handleApiRequest(
  state: ScenarioState,
  method: string,
  rawPath: string,
  body: unknown
) {
  const url = new URL(rawPath, 'http://varro.test');
  const path = url.pathname;

  if (method === 'GET' && path === '/global/health') {
    return { healthy: true, version: 'e2e' };
  }

  if (method === 'GET' && path === '/session') {
    return state.sessions;
  }

  if (method === 'GET' && path === '/varro/session-trash') {
    return state.recycleBinEntries;
  }

  if (method === 'GET' && path === '/session/status') {
    return state.sessionStatuses;
  }

  if (method === 'GET' && path === '/agent') {
    return state.agents;
  }

  if (method === 'GET' && path === '/config/providers') {
    return {
      providers: state.providers,
      default: state.providerDefaults,
    };
  }

  if (method === 'GET' && path === '/mcp') {
    return state.mcpStatus;
  }

  if (method === 'GET' && path === '/question') {
    return state.questions;
  }

  if (method === 'GET' && path === '/file/status') {
    return [];
  }

  if (method === 'POST' && /\/mcp\/[^/]+\/(connect|disconnect)$/.test(path)) {
    const match = path.match(/^\/mcp\/([^/]+)\/(connect|disconnect)$/);
    const name = match ? decodeURIComponent(match[1]) : null;
    const action = match?.[2];
    if (name && state.mcpStatus[name]) {
      if (action === 'connect') {
        state.mcpStatus[name] = { status: 'connected' };
      } else {
        state.mcpStatus[name] = { status: 'disabled' };
      }
    }
    dispatchToWebview({
      type: 'server/event',
      payload: { type: 'mcp.tools.changed' },
    });
    return true;
  }

  if (method === 'GET' && path === '/varro/provider-limit') {
    if (state.persistedActiveSessionId === 'session-usage-limit') {
      return {
        providerID: url.searchParams.get('providerID') || 'openai',
        modelID: url.searchParams.get('modelID') || 'gpt-4.1',
        status: 'available',
        source: 'provider',
        checkedAt: Date.now(),
        note: 'Provider usage window exhausted in mock scenario.',
        windows: [
          {
            id: 'messages',
            label: 'Messages',
            unit: 'messages',
            remaining: 0,
            limit: 40,
            resetAt: BASE_TIME + 45_000,
          },
        ],
      };
    }
    return {
      providerID: url.searchParams.get('providerID') || DEFAULT_PROVIDER_ID,
      modelID: url.searchParams.get('modelID') || DEFAULT_MODEL_ID,
      status: 'unsupported',
      source: 'opencode',
      checkedAt: Date.now(),
      note: 'Provider limits are not mocked in e2e.',
    };
  }

  if (method === 'POST' && path === '/varro/plan/open') {
    const payload = asRecord(body);
    if (typeof payload.content === 'string') {
      state.planOpenRequests.push(payload.content);
    }
    return { path: `${state.workspacePath}/PLAN.md` };
  }

  if (method === 'POST' && path === '/session') {
    const payload = asRecord(body);
    const createdAt = nextTimestamp(state);
    const sessionId = `session-${state.nextSequence}`;
    const title =
      typeof payload.title === 'string' && payload.title.trim().length > 0
        ? payload.title.trim()
        : `Mock Session ${state.sessions.length + 1}`;
    const session: Session = {
      id: sessionId,
      projectID: 'project-varro',
      directory: state.workspacePath,
      title,
      version: '1',
      time: {
        created: createdAt,
        updated: createdAt,
      },
      permission: Array.isArray(payload.permission)
        ? (payload.permission as Session['permission'])
        : undefined,
    };
    state.sessions = [session, ...state.sessions];
    state.messagesBySessionId[session.id] = [];
    state.sessionStatuses[session.id] = { type: 'idle' };
    return session;
  }

  const sessionMatch = path.match(/^\/session\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    return getSession(state, decodeURIComponent(sessionMatch[1]));
  }

  if (sessionMatch && method === 'DELETE') {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const root = state.sessions.find((item) => item.id === sessionId);
    if (!root) return true;
    const hidden = new Set<string>();
    const pending = [sessionId];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || hidden.has(current)) continue;
      hidden.add(current);
      for (const session of state.sessions) {
        if (session.parentID === current) pending.push(session.id);
      }
    }
    state.recycleBinEntries = [
      {
        rootID: sessionId,
        deletedAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        root: { ...root },
        sessions: state.sessions.filter((item) => hidden.has(item.id)).map((item) => ({ ...item })),
      },
      ...state.recycleBinEntries.filter((entry) => entry.rootID !== sessionId),
    ];
    state.sessions = state.sessions.filter((item) => !hidden.has(item.id));
    return true;
  }

  if (method === 'POST' && path.match(/^\/varro\/session-trash\/[^/]+\/restore$/)) {
    const match = path.match(/^\/varro\/session-trash\/([^/]+)\/restore$/);
    const rootID = match ? decodeURIComponent(match[1]) : null;
    const entry = rootID ? state.recycleBinEntries.find((item) => item.rootID === rootID) : null;
    if (!entry) return false;
    state.recycleBinEntries = state.recycleBinEntries.filter((item) => item.rootID !== rootID);
    state.sessions = [...entry.sessions.map((session) => ({ ...session })), ...state.sessions].toSorted(
      (left, right) => right.time.updated - left.time.updated
    );
    return true;
  }

  if (method === 'DELETE' && path.match(/^\/varro\/session-trash\/[^/]+\/delete$/)) {
    const match = path.match(/^\/varro\/session-trash\/([^/]+)\/delete$/);
    const rootID = match ? decodeURIComponent(match[1]) : null;
    const entry = rootID ? state.recycleBinEntries.find((item) => item.rootID === rootID) : null;
    if (!entry) return false;
    state.recycleBinEntries = state.recycleBinEntries.filter((item) => item.rootID !== rootID);
    for (const session of entry.sessions) {
      delete state.messagesBySessionId[session.id];
      delete state.sessionStatuses[session.id];
    }
    return true;
  }

  if (method === 'DELETE' && path === '/varro/session-trash') {
    for (const entry of state.recycleBinEntries) {
      for (const session of entry.sessions) {
        delete state.messagesBySessionId[session.id];
        delete state.sessionStatuses[session.id];
      }
    }
    state.recycleBinEntries = [];
    return true;
  }

  const messageMatch = path.match(/^\/session\/([^/]+)\/message$/);
  if (messageMatch && method === 'GET') {
    const sessionId = decodeURIComponent(messageMatch[1]);
    return state.messagesBySessionId[sessionId] || [];
  }

  const diffMatch = path.match(/^\/session\/([^/]+)\/diff$/);
  if (diffMatch && method === 'GET') {
    return [];
  }

  const promptMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (promptMatch && method === 'POST') {
    const sessionId = decodeURIComponent(promptMatch[1]);
    const payload = asRecord(body);
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    const textParts = parts
      .map((part) => asRecord(part))
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text || ''));
    const promptText =
      textParts.find((text) => !text.startsWith('[Working directory:')) || 'Untitled request';
    const model = asRecord(payload.model);
    const providerID =
      typeof model.providerID === 'string' && model.providerID ? model.providerID : DEFAULT_PROVIDER_ID;
    const modelID =
      typeof model.modelID === 'string' && model.modelID ? model.modelID : DEFAULT_MODEL_ID;
    const variant = typeof payload.variant === 'string' ? payload.variant : undefined;
    const agent = typeof payload.agent === 'string' && payload.agent ? payload.agent : 'build';
    const createdAt = nextTimestamp(state);
    const userId = `message-user-${state.nextSequence}`;
    const assistantId = `message-assistant-${state.nextSequence}`;
    const userMessage: MessageEntry = {
      info: {
        id: userId,
        sessionID: sessionId,
        role: 'user',
        time: { created: createdAt },
        agent,
        model: { providerID, modelID, ...(variant ? { variant } : {}) },
      },
      parts: textParts.map((text, index) => ({
        id: `${userId}-part-${index + 1}`,
        sessionID: sessionId,
        messageID: userId,
        type: 'text',
        text,
      })),
    };
    const assistantMessage = makeAssistantMessage(
      sessionId,
      assistantId,
      userId,
      `Mock assistant response for: ${promptText}`,
      createdAt + 1
    );
    assistantMessage.info.providerID = providerID;
    assistantMessage.info.modelID = modelID;
    assistantMessage.info.agent = agent;
    if (variant) {
      assistantMessage.info.variant = variant;
    }

    if (
      agent === 'plan' ||
      (/\b(plan|planning mode|implementation plan|rollout plan)\b/i.test(promptText) &&
        !/^Implement the plan from your last response/i.test(promptText))
    ) {
      assistantMessage.info.agent = 'plan';
      assistantMessage.info.providerID = 'z-ai';
      assistantMessage.info.modelID = 'glm-5.1';
      assistantMessage.info.variant = variant || 'balanced';
      assistantMessage.parts = [
        makeReasoningPart(
          sessionId,
          assistantId,
          `${assistantId}-reasoning-1`,
          'Evaluating the scope and sequencing the work into a concrete plan.',
          createdAt + 1,
          createdAt + 2
        ),
        makeTextPart(
          sessionId,
          assistantId,
          `${assistantId}-text-1`,
          [
            '# Plan',
            '',
            '1. Confirm the current harness and seed realistic providers and models.',
            '2. Capture the permission request path with a bash command that asks by default.',
            '3. Verify sticky prompt overlap handling with a long conversation.',
          ].join('\n')
        ),
      ];
      assistantMessage.info.tokens = {
        input: 96,
        output: 210,
        reasoning: 48,
        cache: { read: 0, write: 0 },
      };
    }

    state.messagesBySessionId[sessionId] = [
      ...(state.messagesBySessionId[sessionId] || []),
      userMessage,
      assistantMessage,
    ];

    const session = getSession(state, sessionId);
    if (
      session.permission?.some(
        (rule) => rule.permission === 'bash' && rule.pattern === '*' && rule.action === 'ask'
      ) &&
      /\b(opencode(?:\s+|.*\s)--version|get opencode version|bash)\b/i.test(promptText)
    ) {
      const permissionRequest = {
        id: `permission-bash-${state.nextSequence}`,
        permission: 'bash',
        type: 'bash',
        pattern: ['opencode --version'],
        sessionID: sessionId,
        messageID: assistantId,
        title: 'Allow running opencode --version?',
        metadata: {
          command: 'opencode --version',
          providerID,
          modelID,
        },
        patterns: ['opencode --version'],
        time: { created: createdAt + 2 },
      };
      state.pendingPermissions = [
        ...state.pendingPermissions,
        permissionRequest,
      ];
      dispatchToWebview({
        type: 'server/event',
        payload: {
          type: 'permission.asked',
          properties: permissionRequest,
        },
      });
    }

    session.time.updated = createdAt + 1;
    if (!session.title.trim()) {
      session.title = promptText.slice(0, 60);
    }
    if (state.sessionStatuses[sessionId]?.type === 'busy') {
      state.sessionStatuses[sessionId] = { type: 'busy' };
    } else {
      state.sessionStatuses[sessionId] = { type: 'idle' };
    }
    return null;
  }

  const permissionMatch = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
  if (permissionMatch && method === 'POST') {
    const sessionId = decodeURIComponent(permissionMatch[1]);
    const permissionId = decodeURIComponent(permissionMatch[2]);
    const payload = asRecord(body);
    const response = payload.response;
    if (response !== 'once' && response !== 'always' && response !== 'reject') {
      throw new Error('Invalid permission response');
    }
    state.permissionResponses.push({ sessionId, permissionId, response });
    state.pendingPermissions = state.pendingPermissions.filter((item) => item.id !== permissionId);
    return true;
  }

  const rejectQuestionMatch = path.match(/^\/question\/([^/]+)\/reject$/);
  if (rejectQuestionMatch && method === 'POST') {
    const requestId = decodeURIComponent(rejectQuestionMatch[1]);
    state.questions = state.questions.filter((item) => item.id !== requestId);
    return true;
  }

  const replyQuestionMatch = path.match(/^\/question\/([^/]+)\/reply$/);
  if (replyQuestionMatch && method === 'POST') {
    const requestId = decodeURIComponent(replyQuestionMatch[1]);
    state.questions = state.questions.filter((item) => item.id !== requestId);
    return true;
  }

  const updateSessionMatch = path.match(/^\/session\/([^/]+)$/);
  if (updateSessionMatch && method === 'PATCH') {
    const sessionId = decodeURIComponent(updateSessionMatch[1]);
    const payload = asRecord(body);
    const session = getSession(state, sessionId);
    if (typeof payload.title === 'string') {
      session.title = payload.title;
    }
    if (Array.isArray(payload.permission)) {
      session.permission = payload.permission as Session['permission'];
    }
    session.time.updated = nextTimestamp(state);
    return session;
  }

  if (/(\/abort|\/revert|\/summarize)$/.test(path) && method === 'POST') {
    return true;
  }

  throw new Error(`Unhandled mock API route: ${method} ${rawPath}`);
}

function installBridge(state: ScenarioState) {
  const harnessWindow = window as HarnessWindow;
  harnessWindow.__sendToExtension = async (message: WebviewMessage) => {
    switch (message.type) {
      case 'api/request': {
        const { id, method, path, body } = message.payload;
        state.requests.push({ method, path, body });
        try {
          const data = await handleApiRequest(state, method, path, body);
          sendApiResponse(id, { data });
        } catch (error) {
          sendApiResponse(id, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case 'ready':
        dispatchToWebview({
          type: 'server/status',
          payload: state.readyStatus || { state: 'running', url: 'mock://opencode' },
        });
        dispatchToWebview({
          type: 'theme/update',
          payload: { theme: THEME },
        });
        dispatchToWebview({
          type: 'context/update',
          payload: {
            workspacePath: state.workspacePath,
            activeFile: null,
            selection: null,
            diagnostics: [],
          },
        });
        queueMicrotask(() => {
          for (const msg of state.postReadyMessages) {
            dispatchPostReadyMessage(msg);
          }
        });
        return;
      case 'vscode/open-external':
        state.externalUrls.push(message.payload.url);
        return;
      case 'terminal/run':
        harnessWindow.__varroE2E?.terminalCommands?.push({
          command: message.payload.command,
          ...(message.payload.title ? { title: message.payload.title } : {}),
        });
        return;
      case 'vscode/open-settings':
        harnessWindow.__varroE2E?.settingsQueries?.push(message.payload.query || '');
        return;
      case 'files/pick':
        if (harnessWindow.__varroE2E) {
          harnessWindow.__varroE2E.filePickCount = (harnessWindow.__varroE2E.filePickCount || 0) + 1;
        }
        return;
      case 'files/search': {
        const query = message.payload.query.trim().toLowerCase();
        const requestId = message.payload.requestId;
        const limit = typeof message.payload.limit === 'number' ? message.payload.limit : 12;
        const files = state.workspaceFiles
          .filter((file) => {
            if (!query) return true;
            return (
              file.relativePath.toLowerCase().includes(query) ||
              file.path.toLowerCase().includes(query)
            );
          })
          .slice(0, limit)
          .map((file) => ({ ...file }));
        dispatchToWebview({
          type: 'files/search-results',
          payload: { requestId, query: message.payload.query, files },
        });
        return;
      }
      case 'terminal-selection/clear':
      case 'files/clear':
      case 'files/remove':
      case 'context/request':
      case 'webview/focus':
      case 'log':
      case 'files/drop':
      case 'files/drop-content':
      case 'file/read':
      case 'config/update':
        return;
      case 'vscode/open':
        harnessWindow.__varroE2E?.openTargets?.push({
          path: message.payload.path,
          ...(typeof message.payload.line === 'number' ? { line: message.payload.line } : {}),
          ...(typeof message.payload.kind === 'string' ? { kind: message.payload.kind } : {}),
        });
        return;
      default:
        return;
    }
  };
}

function setUpHarness() {
  const scenarioState = createScenarioState(getScenarioName());
  const harnessWindow = window as HarnessWindow;
  window.localStorage.clear();
  if (scenarioState.persistedActiveSessionId) {
    window.localStorage.setItem(
      'varro.lastActiveSessionId',
      JSON.stringify(scenarioState.persistedActiveSessionId)
    );
  }
  if (scenarioState.storedState.sessionSelectedAgents) {
    window.localStorage.setItem(
      'varro.sessionSelectedAgents',
      JSON.stringify(scenarioState.storedState.sessionSelectedAgents)
    );
  }
  if (scenarioState.storedState.sessionSelectedMcps) {
    window.localStorage.setItem(
      'varro.sessionSelectedMcps',
      JSON.stringify(scenarioState.storedState.sessionSelectedMcps)
    );
  }
  if (scenarioState.storedState.sessionPermissionModes) {
    window.localStorage.setItem(
      'varro.sessionPermissionModes',
      JSON.stringify(scenarioState.storedState.sessionPermissionModes)
    );
  }
  if (scenarioState.storedState.lastSeenSessions) {
    window.localStorage.setItem(
      'varro.lastSeenSessions',
      JSON.stringify(scenarioState.storedState.lastSeenSessions)
    );
  }
  harnessWindow.__initialTheme = THEME;
  harnessWindow.__initialWebviewState = buildInitialState(scenarioState);
  harnessWindow.__varroE2E = {
    requests: scenarioState.requests,
    permissionResponses: scenarioState.permissionResponses,
    externalUrls: scenarioState.externalUrls,
    planOpenRequests: scenarioState.planOpenRequests,
    terminalCommands: [],
    settingsQueries: [],
    filePickCount: 0,
    openTargets: [],
  };
  document.body.dataset.vscodeThemeKind = THEME;
  installBridge(scenarioState);
}

setUpHarness();

await import('../../src/webview/index');
