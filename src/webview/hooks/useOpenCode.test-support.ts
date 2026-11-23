import { createRoot, flush as flushSolid } from 'solid-js';
import { beforeEach, vi } from 'vitest';
import type { onMessage } from '../lib/bridge';
import type { Agent, Message, Part, Provider, Session } from '../types';
import { fixture } from '../test-fixtures';

type BridgeHandler = Parameters<typeof onMessage>[0];
type ServerEventHandler = (data: { properties?: unknown }) => void;
type ServerEventsOn = (event: string, handler: ServerEventHandler) => () => void;

const mocks = vi.hoisted(() => ({
  client: {
    health: vi.fn(),
    commandList: vi.fn(),
    sessionList: vi.fn(),
    sessionActivate: vi.fn(),
    sessionCreate: vi.fn(),
    sessionDelete: vi.fn(),
    sessionGet: vi.fn(),
    sessionMessages: vi.fn(),
    sessionDeleteMessage: vi.fn(),
    sessionTodos: vi.fn(),
    sessionSendAsync: vi.fn(),
    sessionCommand: vi.fn(),
    sessionInit: vi.fn(),
    sessionRevert: vi.fn(),
    sessionUnrevert: vi.fn(),
    sessionAbort: vi.fn(),
    interruptChild: vi.fn(),
    childTaskControls: vi.fn(),
    backgroundParent: vi.fn(),
    sessionStatus: vi.fn(),
    agentList: vi.fn(),
    providerList: vi.fn(),
    providerLimit: vi.fn(),
    mcpStatus: vi.fn(),
    mcpDefaults: vi.fn(),
    mcpConnect: vi.fn(),
    mcpAuthenticate: vi.fn(),
    mcpDisconnect: vi.fn(),
    questionList: vi.fn(),
    permissionList: vi.fn(),
    varroOpenPlan: vi.fn(),
    varroJudgePermission: vi.fn(),
    varroResolveJudgeModel: vi.fn(),
    varroSessionRenameIfUntitled: vi.fn(),
    varroSessionUpdatePermissionMode: vi.fn(),
    recycleBinList: vi.fn(),
    recycleBinRestore: vi.fn(),
    recycleBinDelete: vi.fn(),
    recycleBinEmpty: vi.fn(),
    sessionUpdate: vi.fn(),
    sessionCompact: vi.fn(),
    sessionRespondPermission: vi.fn(),
    sessionPersistProjectPermissionAllow: vi.fn(),
    sessionPersistGlobalPermissionAllow: vi.fn(),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    serverEventsOn: vi.fn<ServerEventsOn>(() => () => {}),
    invalidateClientWorkspaceCaches: vi.fn(),
  },
  bridge: {
    onMessage: vi.fn<typeof onMessage>(() => () => {}),
    postMessage: vi.fn(),
  },
}));

export function getClientMocks() {
  return mocks.client;
}

export function getBridgeMocks() {
  return mocks.bridge;
}

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();

/* oxlint-disable anti-slop/no-module-mocking -- This support harness provides controlled client and bridge module integrations. */
vi.mock('../lib/client', () => ({
  invalidateClientWorkspaceCaches: clientMocks.invalidateClientWorkspaceCaches,
  client: {
    health: clientMocks.health,
    command: {
      list: clientMocks.commandList,
    },
    session: {
      list: clientMocks.sessionList,
      activate: clientMocks.sessionActivate,
      create: clientMocks.sessionCreate,
      delete: clientMocks.sessionDelete,
      get: clientMocks.sessionGet,
      messages: clientMocks.sessionMessages,
      deleteMessage: clientMocks.sessionDeleteMessage,
      todos: clientMocks.sessionTodos,
      sendAsync: clientMocks.sessionSendAsync,
      command: clientMocks.sessionCommand,
      init: clientMocks.sessionInit,
      revert: clientMocks.sessionRevert,
      unrevert: clientMocks.sessionUnrevert,
      abort: clientMocks.sessionAbort,
      interruptChild: clientMocks.interruptChild,
      childTaskControls: clientMocks.childTaskControls,
      backgroundParent: clientMocks.backgroundParent,
      status: clientMocks.sessionStatus,
      update: clientMocks.sessionUpdate,
      compact: clientMocks.sessionCompact,
      respondPermission: clientMocks.sessionRespondPermission,
      persistProjectPermissionAllow: clientMocks.sessionPersistProjectPermissionAllow,
      persistGlobalPermissionAllow: clientMocks.sessionPersistGlobalPermissionAllow,
    },
    agent: {
      list: clientMocks.agentList,
    },
    config: {
      providers: clientMocks.providerList,
      providerLimit: clientMocks.providerLimit,
    },
    varro: {
      openPlan: clientMocks.varroOpenPlan,
      judgePermission: clientMocks.varroJudgePermission,
      resolveJudgeModel: clientMocks.varroResolveJudgeModel,
      session: {
        renameIfUntitled: clientMocks.varroSessionRenameIfUntitled,
        updatePermissionMode: clientMocks.varroSessionUpdatePermissionMode,
      },
      recycleBin: {
        list: clientMocks.recycleBinList,
        restore: clientMocks.recycleBinRestore,
        delete: clientMocks.recycleBinDelete,
        empty: clientMocks.recycleBinEmpty,
      },
    },
    mcp: {
      defaults: clientMocks.mcpDefaults,
      status: clientMocks.mcpStatus,
      connect: clientMocks.mcpConnect,
      authenticate: clientMocks.mcpAuthenticate,
      disconnect: clientMocks.mcpDisconnect,
    },
    question: {
      list: clientMocks.questionList,
      reply: clientMocks.questionReply,
      reject: clientMocks.questionReject,
    },
    permission: {
      list: clientMocks.permissionList,
    },
  },
  serverEvents: {
    on: clientMocks.serverEventsOn,
  },
}));

vi.mock('../lib/bridge', () => ({
  onMessage: bridgeMocks.onMessage,
  postMessage: bridgeMocks.postMessage,
}));

export function provider(id: string, models: Provider['models']): Provider {
  return {
    id,
    name: id,
    source: 'api',
    models,
  };
}

export function session(id = 'session-1'): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
  };
}

export function userMessage(id: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

export function assistantMessage(id: string, parentID: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 0 },
    parentID,
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

export function todoPart(
  id: string,
  messageID: string,
  content: string,
  status = 'completed'
): Part {
  // SAFETY: The fixture provides the unknown fields read by this statement.
  return fixture<Part>({
    id,
    sessionID: 'session-1',
    messageID,
    type: 'tool',
    callID: `${id}-call`,
    tool: 'todowrite',
    state: {
      input: {
        todos: [{ id: `${id}-todo`, content, status, priority: 'medium' }],
      },
    },
  });
}

/** The single-model OpenAI provider most tests select. */
export function gpt4oProvider(
  capabilities: Record<string, boolean> = { toolcall: true }
): Provider {
  return provider('openai', {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', capabilities, cost: { input: 0, output: 0 } },
  });
}

export function primaryAgent(name: string): Agent {
  return {
    name,
    mode: 'primary',
    builtIn: true,
    permission: { edit: 'ask', bash: {} },
    tools: {},
  };
}

export async function loadModules() {
  const stateModule = await import('../lib/state');
  const hookModule = await import('./useOpenCode');
  return { stateModule, hookModule };
}

/** Mounts the hook in its own root and returns that root's disposer. */
export function mountUseOpenCode(hookModule: { useOpenCode: () => void }) {
  return createRoot((cleanup) => {
    hookModule.useOpenCode();
    return cleanup;
  });
}

/** Loads fresh modules and mounts the hook, flushing after each step. */
export async function loadAndMountUseOpenCode() {
  const { stateModule, hookModule } = await loadModules();
  flushSolid();
  const dispose = mountUseOpenCode(hookModule);
  flushSolid();
  return { stateModule, hookModule, dispose };
}

/** Captures the listener the runtime registers with the webview bridge. */
export function captureBridgeHandler() {
  let bridgeHandler: BridgeHandler | undefined;
  bridgeMocks.onMessage.mockImplementation((handler) => {
    bridgeHandler = handler;
    return () => {
      bridgeHandler = undefined;
    };
  });
  return {
    send(message: Parameters<BridgeHandler>[0]) {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler(message);
    },
  };
}

/** Captures the server event listeners the runtime registers, keyed by event name. */
export function captureServerEventHandlers() {
  const handlers = new Map<string, ServerEventHandler>();
  clientMocks.serverEventsOn.mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  return handlers;
}

// These mocks have never been reset between tests, so their calls and results carry over.
const UNRESET_CLIENT_MOCKS = new Set(['interruptChild', 'childTaskControls', 'backgroundParent']);

beforeEach(() => {
  vi.resetModules();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
    permissionAutomation: { owner: true, lease: 1 },
  };
  for (const [name, mock] of Object.entries(clientMocks)) {
    if (!UNRESET_CLIENT_MOCKS.has(name)) mock.mockReset();
  }
  clientMocks.serverEventsOn.mockImplementation(() => () => {});
  bridgeMocks.onMessage.mockReset();
  bridgeMocks.onMessage.mockImplementation(() => () => {});
  bridgeMocks.postMessage.mockReset();
  clientMocks.mcpStatus.mockResolvedValue({});
  clientMocks.mcpDefaults.mockResolvedValue({
    global: {},
    project: {},
    effective: {},
    editable: true,
  });
  clientMocks.commandList.mockResolvedValue([]);
  clientMocks.permissionList.mockResolvedValue([]);
  clientMocks.sessionTodos.mockRejectedValue(new Error('404 Not Found'));
  clientMocks.sessionCommand.mockResolvedValue({
    info: assistantMessage('assistant-command', 'user-1'),
    parts: [],
  });
  clientMocks.sessionInit.mockResolvedValue(true);
  clientMocks.sessionActivate.mockImplementation(async (sessionId: string) => session(sessionId));
  clientMocks.sessionUpdate.mockResolvedValue(session());
  clientMocks.sessionUnrevert.mockResolvedValue(session());
  clientMocks.mcpConnect.mockResolvedValue(true);
  clientMocks.mcpAuthenticate.mockResolvedValue(undefined);
  clientMocks.mcpDisconnect.mockResolvedValue(true);
  clientMocks.varroOpenPlan.mockResolvedValue({ path: '/tmp/plan.md' });
  clientMocks.varroJudgePermission.mockResolvedValue({ decision: 'ask', reason: 'test' });
  clientMocks.varroResolveJudgeModel.mockResolvedValue(null);
  clientMocks.varroSessionRenameIfUntitled.mockResolvedValue(null);
  clientMocks.varroSessionUpdatePermissionMode.mockImplementation(async (sessionId: string) =>
    session(sessionId)
  );
  clientMocks.recycleBinList.mockResolvedValue([]);
  clientMocks.recycleBinRestore.mockResolvedValue(true);
  clientMocks.recycleBinDelete.mockResolvedValue(true);
  clientMocks.recycleBinEmpty.mockResolvedValue(true);
});
