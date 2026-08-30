import { beforeEach, vi } from 'vitest';
import type { Message, Part, Provider, Session } from '../types';
import { fixture } from '../test-fixtures';

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
    sessionTodos: vi.fn(),
    sessionSendAsync: vi.fn(),
    sessionCommand: vi.fn(),
    sessionInit: vi.fn(),
    sessionRevert: vi.fn(),
    sessionUnrevert: vi.fn(),
    sessionAbort: vi.fn(),
    sessionStatus: vi.fn(),
    agentList: vi.fn(),
    providerList: vi.fn(),
    providerLimit: vi.fn(),
    mcpStatus: vi.fn(),
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
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    serverEventsOn: vi.fn(() => () => {}),
    invalidateClientWorkspaceCaches: vi.fn(),
  },
  bridge: {
    onMessage: vi.fn(() => () => {}),
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
      todos: clientMocks.sessionTodos,
      sendAsync: clientMocks.sessionSendAsync,
      command: clientMocks.sessionCommand,
      init: clientMocks.sessionInit,
      revert: clientMocks.sessionRevert,
      unrevert: clientMocks.sessionUnrevert,
      abort: clientMocks.sessionAbort,
      status: clientMocks.sessionStatus,
      update: clientMocks.sessionUpdate,
      compact: clientMocks.sessionCompact,
      respondPermission: clientMocks.sessionRespondPermission,
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

export async function loadModules() {
  const stateModule = await import('../lib/state');
  const hookModule = await import('./useOpenCode');
  return { stateModule, hookModule };
}

beforeEach(() => {
  vi.resetModules();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
    permissionAutomation: { owner: true, lease: 1 },
  };
  clientMocks.health.mockReset();
  clientMocks.commandList.mockReset();
  clientMocks.sessionList.mockReset();
  clientMocks.sessionActivate.mockReset();
  clientMocks.sessionCreate.mockReset();
  clientMocks.sessionDelete.mockReset();
  clientMocks.sessionGet.mockReset();
  clientMocks.sessionMessages.mockReset();
  clientMocks.sessionTodos.mockReset();
  clientMocks.sessionSendAsync.mockReset();
  clientMocks.sessionCommand.mockReset();
  clientMocks.sessionInit.mockReset();
  clientMocks.sessionRevert.mockReset();
  clientMocks.sessionUnrevert.mockReset();
  clientMocks.sessionAbort.mockReset();
  clientMocks.sessionStatus.mockReset();
  clientMocks.agentList.mockReset();
  clientMocks.providerList.mockReset();
  clientMocks.providerLimit.mockReset();
  clientMocks.mcpStatus.mockReset();
  clientMocks.mcpConnect.mockReset();
  clientMocks.mcpAuthenticate.mockReset();
  clientMocks.mcpDisconnect.mockReset();
  clientMocks.questionList.mockReset();
  clientMocks.permissionList.mockReset();
  clientMocks.varroOpenPlan.mockReset();
  clientMocks.varroJudgePermission.mockReset();
  clientMocks.varroResolveJudgeModel.mockReset();
  clientMocks.varroSessionRenameIfUntitled.mockReset();
  clientMocks.varroSessionUpdatePermissionMode.mockReset();
  clientMocks.recycleBinList.mockReset();
  clientMocks.recycleBinRestore.mockReset();
  clientMocks.recycleBinDelete.mockReset();
  clientMocks.recycleBinEmpty.mockReset();
  clientMocks.sessionUpdate.mockReset();
  clientMocks.sessionCompact.mockReset();
  clientMocks.sessionRespondPermission.mockReset();
  clientMocks.questionReply.mockReset();
  clientMocks.questionReject.mockReset();
  clientMocks.serverEventsOn.mockReset();
  clientMocks.serverEventsOn.mockImplementation(() => () => {});
  clientMocks.invalidateClientWorkspaceCaches.mockReset();
  bridgeMocks.onMessage.mockReset();
  bridgeMocks.onMessage.mockImplementation(() => () => {});
  bridgeMocks.postMessage.mockReset();
  clientMocks.mcpStatus.mockResolvedValue({});
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
