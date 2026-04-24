import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Part, Provider, Session } from '../types';

const clientMocks = vi.hoisted(() => ({
  health: vi.fn(),
  sessionList: vi.fn(),
  sessionCreate: vi.fn(),
  sessionDelete: vi.fn(),
  sessionGet: vi.fn(),
  sessionMessages: vi.fn(),
  sessionSendAsync: vi.fn(),
  sessionRevert: vi.fn(),
  sessionAbort: vi.fn(),
  sessionStatus: vi.fn(),
  agentList: vi.fn(),
  providerList: vi.fn(),
  providerLimit: vi.fn(),
  mcpStatus: vi.fn(),
  mcpConnect: vi.fn(),
  mcpDisconnect: vi.fn(),
  questionList: vi.fn(),
  varroOpenPlan: vi.fn(),
  serverEventsOn: vi.fn(() => () => {}),
}));

const bridgeMocks = vi.hoisted(() => ({
  onMessage: vi.fn(() => () => {}),
  postMessage: vi.fn(),
}));

vi.mock('../lib/client', () => ({
  client: {
    health: clientMocks.health,
    session: {
      list: clientMocks.sessionList,
      create: clientMocks.sessionCreate,
      delete: clientMocks.sessionDelete,
      get: clientMocks.sessionGet,
      messages: clientMocks.sessionMessages,
      sendAsync: clientMocks.sessionSendAsync,
      revert: clientMocks.sessionRevert,
      abort: clientMocks.sessionAbort,
      status: clientMocks.sessionStatus,
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
    },
    mcp: {
      status: clientMocks.mcpStatus,
      connect: clientMocks.mcpConnect,
      disconnect: clientMocks.mcpDisconnect,
    },
    question: {
      list: clientMocks.questionList,
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

function provider(id: string, models: Provider['models']): Provider {
  return {
    id,
    name: id,
    source: 'api',
    models,
  };
}

function session(id = 'session-1'): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
  };
}

function userMessage(id: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

function userMessageForSession(
  id: string,
  sessionID: string,
  model: { providerID: string; modelID: string; variant?: string }
): Message {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model,
  };
}

function assistantMessage(id: string, parentID: string): Message {
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

function todoPart(id: string, messageID: string, content: string, status = 'completed'): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'tool',
    tool: 'todowrite',
    state: {
      input: {
        todos: [{ id: `${id}-todo`, content, status, priority: 'medium' }],
      },
    },
  } as Part;
}

async function loadModules() {
  const stateModule = await import('../lib/state');
  const hookModule = await import('./useOpenCode');
  return { stateModule, hookModule };
}

beforeEach(() => {
  vi.resetModules();
  delete (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState;
  clientMocks.health.mockReset();
  clientMocks.sessionList.mockReset();
  clientMocks.sessionCreate.mockReset();
  clientMocks.sessionDelete.mockReset();
  clientMocks.sessionGet.mockReset();
  clientMocks.sessionMessages.mockReset();
  clientMocks.sessionSendAsync.mockReset();
  clientMocks.sessionRevert.mockReset();
  clientMocks.sessionAbort.mockReset();
  clientMocks.sessionStatus.mockReset();
  clientMocks.agentList.mockReset();
  clientMocks.providerList.mockReset();
  clientMocks.providerLimit.mockReset();
  clientMocks.mcpStatus.mockReset();
  clientMocks.mcpConnect.mockReset();
  clientMocks.mcpDisconnect.mockReset();
  clientMocks.questionList.mockReset();
  clientMocks.varroOpenPlan.mockReset();
  clientMocks.serverEventsOn.mockClear();
  bridgeMocks.onMessage.mockClear();
  bridgeMocks.postMessage.mockReset();
  clientMocks.mcpStatus.mockResolvedValue({});
  clientMocks.mcpConnect.mockResolvedValue(true);
  clientMocks.mcpDisconnect.mockResolvedValue(true);
  clientMocks.varroOpenPlan.mockResolvedValue({ path: '/tmp/plan.md' });
});

describe('sendMessage', () => {
  it('omits pasted images and placeholder tags for non-vision models', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openrouter', {
        'qwen3-coder-30b': {
          id: 'qwen3-coder-30b',
          name: 'Qwen3 Coder 30B',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openrouter: 'qwen3-coder-30b' });
    stateModule.setSelectedModel({ providerID: 'openrouter', modelID: 'qwen3-coder-30b' });
    stateModule.addClipboardImage({
      id: 'img-1',
      url: 'blob:1',
      mime: 'image/png',
      filename: 'img-1.png',
      size: 10,
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('See [img-1.png] later');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [{ type: 'text', text: 'See later' }],
      model: { providerID: 'openrouter', modelID: 'qwen3-coder-30b' },
    });
  });

  it('keeps pasted images for vision-capable models', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.addClipboardImage({
      id: 'img-1',
      url: 'blob:1',
      mime: 'image/png',
      filename: 'img-1.png',
      size: 10,
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('See [img-1.png] later');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'See [img-1.png] later' },
        { type: 'file', mime: 'image/png', filename: 'img-1.png', url: 'blob:1' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('preserves attachments when sending fails', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.addContextFile({ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' });
    stateModule.addClipboardImage({
      id: 'img-1',
      url: 'blob:1',
      mime: 'image/png',
      filename: 'img-1.png',
      size: 10,
    });

    clientMocks.sessionSendAsync.mockRejectedValue(new Error('network down'));

    await hookModule.sendMessage('Review this');

    expect(stateModule.state.droppedFiles).toEqual([
      { path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
    ]);
    expect(stateModule.state.clipboardImages).toEqual([
      {
        id: 'img-1',
        url: 'blob:1',
        mime: 'image/png',
        filename: 'img-1.png',
        size: 10,
      },
    ]);
    expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith({ type: 'files/clear' });
    expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('clears sent attachments while keeping current document context', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
      selection: { startLine: 4, endLine: 8 },
      diagnostics: [],
    });
    stateModule.setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });
    stateModule.addContextFile({
      path: '/repo/src/extra.ts',
      relativePath: 'src/extra.ts',
      type: 'file',
    });
    stateModule.addClipboardImage({
      id: 'img-1',
      url: 'blob:1',
      mime: 'image/png',
      filename: 'img-1.png',
      size: 10,
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review this');

    expect(stateModule.state.droppedFiles).toEqual([]);
    expect(stateModule.state.clipboardImages).toEqual([]);
    expect(stateModule.state.terminalSelection).toBeNull();
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(true);
    expect(bridgeMocks.postMessage).toHaveBeenCalledWith({ type: 'files/clear' });
    expect(bridgeMocks.postMessage).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('clears loading when the prompt is accepted but the session is already idle', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({
      session: { type: 'idle' },
      'session-1': { type: 'idle' },
    });

    await hookModule.sendMessage('Review this');

    expect(stateModule.isLoading()).toBe(false);
    expect(stateModule.loadingStartedAt()).toBeNull();
    expect(stateModule.loadingLastActivityAt()).toBeNull();
  });

  it('clears completed todos from previous turns on a new prompt', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });

    const oldTurnMessages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1', 'user-1'),
        parts: [todoPart('todo-part-1', 'assistant-1', 'Old completed task')],
      },
    ];

    stateModule.setState('messages', oldTurnMessages);
    stateModule.setState('todos', [
      { id: 'old-todo', content: 'Old completed task', status: 'completed', priority: 'medium' },
    ]);

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([
      ...oldTurnMessages,
      { info: userMessage('user-2'), parts: [] },
    ]);

    await hookModule.sendMessage('Start something new');

    expect(stateModule.state.todos).toEqual([]);
  });

  it('sends merged explicit selections as a single document attachment', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 3, endLine: 4 }],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 8, endLine: 10 }],
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review this');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'Review this' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'text', text: '[Selection from src/a.ts lines 3-4, 8-10]' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('includes only unique live-selection lines alongside explicit same-file context', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
      selection: { startLine: 20, endLine: 24 },
      diagnostics: [],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 3, endLine: 4 }],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 8, endLine: 10 }],
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review active file');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'Review active file' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'text', text: '[Selection from src/a.ts lines 20-24]' },
        { type: 'text', text: '[Selection from src/a.ts lines 3-4, 8-10]' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('subtracts overlapping explicit ranges from the live same-file selection payload', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
      selection: { startLine: 2, endLine: 12 },
      diagnostics: [],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 1, endLine: 4 }],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 8, endLine: 10 }],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
      lineRanges: [{ startLine: 12, endLine: 20 }],
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review overlap');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'Review overlap' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'text', text: '[Selection from src/a.ts lines 5-7, 11]' },
        { type: 'text', text: '[Selection from src/a.ts lines 1-4, 8-10, 12-20]' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('hides the duplicate active file payload when the file is explicitly added without a live selection', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
      selection: null,
      diagnostics: [],
    });
    stateModule.addContextFile({
      path: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      type: 'file',
    });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review active file');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'Review active file' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'text', text: 'src/a.ts' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('omits a disabled current document while keeping other context attachments', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
      selection: { startLine: 4, endLine: 8 },
      diagnostics: [],
    });
    stateModule.addClipboardImage({
      id: 'img-1',
      url: 'blob:1',
      mime: 'image/png',
      filename: 'img-1.png',
      size: 10,
    });
    stateModule.addContextFile({
      path: '/repo/src/extra.ts',
      relativePath: 'src/extra.ts',
      type: 'file',
    });
    stateModule.setCurrentDocumentEnabled(false, 'session-1');

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review this image');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'Review this image' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'text', text: 'src/extra.ts' },
        { type: 'file', mime: 'image/png', filename: 'img-1.png', url: 'blob:1' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('reuses the most recently selected model for a new session', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-5' });

    clientMocks.sessionCreate.mockResolvedValue(session('session-2'));

    await hookModule.createSession();

    expect(stateModule.state.activeSessionId).toBe('session-2');
    expect(stateModule.state.selectedModel).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(stateModule.getSelectedModelForSession('session-2')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });
  });

  it('defaults new sessions to the build agent', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('agents', [
      {
        name: 'build',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
      {
        name: 'plan',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
    ]);
    stateModule.setSelectedAgent('plan');

    clientMocks.sessionCreate.mockResolvedValue(session('session-2'));

    await hookModule.createSession();

    expect(stateModule.state.activeSessionId).toBe('session-2');
    expect(stateModule.state.selectedAgent).toBe('build');
    expect(stateModule.getSelectedAgentForSession('session-2')).toBe('build');
    expect(stateModule.getPersistedSelectedAgent()).toBe('plan');
  });

  it('restores the previously used model when switching back to an existing session', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-5' });

    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([
      {
        info: userMessageForSession('user-1', 'session-1', {
          providerID: 'openai',
          modelID: 'gpt-4o',
        }),
        parts: [],
      },
    ]);

    await hookModule.selectSession('session-1');

    expect(stateModule.state.selectedModel).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
    expect(stateModule.getPersistedSelectedModel()).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });
  });

  it('restores the previously used agent when switching back to an existing session', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('agents', [
      {
        name: 'build',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
      {
        name: 'plan',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
    ]);
    stateModule.setSelectedAgent('build');
    stateModule.setSelectedAgent('plan', { sessionId: 'session-1', persistGlobal: false });

    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([
      {
        info: userMessageForSession('user-1', 'session-1', {
          providerID: 'openai',
          modelID: 'gpt-4o',
        }),
        parts: [],
      },
    ]);

    await hookModule.selectSession('session-1');

    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBe('plan');
    expect(stateModule.getPersistedSelectedAgent()).toBe('build');
  });

  it('marks the next session seen when archive auto-selects it', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('sessions', [
      session('session-1'),
      { ...session('session-2'), time: { created: 0, updated: 2_000 } },
    ]);
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('lastSeenSessions', { 'session-2': 1_000 });

    clientMocks.sessionDelete.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue({
      ...session('session-2'),
      time: { created: 0, updated: 2_000 },
    });
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await hookModule.deleteSession('session-1');

    expect(stateModule.state.activeSessionId).toBe('session-2');
    expect(stateModule.state.lastSeenSessions['session-2']).toBeGreaterThanOrEqual(2_000);
    expect(stateModule.isSessionUnread('session-2', 2_000)).toBe(false);
  });

  it('removes subagent descendants before auto-selecting the next session', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('sessions', [
      session('session-1'),
      {
        ...session('subagent-1'),
        parentID: 'session-1',
        time: { created: 0, updated: 3_000 },
      },
      { ...session('session-2'), time: { created: 0, updated: 2_000 } },
    ]);
    stateModule.setState('activeSessionId', 'session-1');

    clientMocks.sessionDelete.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockImplementation(async (id: string) => {
      if (id === 'session-2') {
        return { ...session('session-2'), time: { created: 0, updated: 2_000 } };
      }

      throw new Error(`unexpected session lookup: ${id}`);
    });
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await hookModule.deleteSession('session-1');

    expect(clientMocks.sessionGet).toHaveBeenCalledWith('session-2');
    expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-2');
    expect(stateModule.state.sessions.map((item) => item.id)).toEqual(['session-2']);
    expect(stateModule.state.activeSessionId).toBe('session-2');
  });

  it('switches the active session to build and sends the implementation prompt', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('agents', [
      {
        name: 'build',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
      {
        name: 'plan',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
    ]);
    stateModule.setSelectedAgent('plan');
    stateModule.setSelectedAgent('plan', { sessionId: 'session-1', persistGlobal: false });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.implementPlan('Implement the approved plan.');

    expect(stateModule.state.selectedAgent).toBe('build');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBe('build');
    expect(stateModule.getPersistedSelectedAgent()).toBe('plan');
    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [{ type: 'text', text: 'Implement the approved plan.' }],
      agent: 'build',
    });
  });

  it('opens the saved plan document for the active session', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');

    await hookModule.openPlan('# Plan\n\n1. Ship it');

    expect(clientMocks.varroOpenPlan).toHaveBeenCalledWith('# Plan\n\n1. Ship it');
  });

  it('does not try to open an empty plan', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');

    await hookModule.openPlan('   ');

    expect(clientMocks.varroOpenPlan).not.toHaveBeenCalled();
    expect(stateModule.error()).toBe('Plan content is empty');
  });

  it('continues the failed assistant turn with the interruption resume prompt', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('messages', [
      {
        info: userMessage('user-1'),
        parts: [
          {
            id: 'text-1',
            sessionID: 'session-1',
            messageID: 'user-1',
            type: 'text',
            text: 'Describe what to build',
          },
          {
            id: 'file-1',
            sessionID: 'session-1',
            messageID: 'user-1',
            type: 'file',
            mime: 'image/png',
            filename: 'image.png',
            url: 'blob:1',
          },
        ],
      },
      {
        info: {
          ...assistantMessage('assistant-1', 'user-1'),
          error: { name: 'server_error', data: { message: 'Request failed' } },
        },
        parts: [],
      },
    ]);

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'busy' } });

    await hookModule.retryMessage('assistant-1');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        {
          type: 'text',
          text: 'Continue from where you were interrupted before the extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.',
        },
      ],
    });
  });
});

describe('useOpenCode initialization', () => {
  it('defaults the extension toolbar agent to build on startup', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    window.localStorage.setItem('varro.selectedAgent', JSON.stringify('plan'));

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([
      {
        name: 'build',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
      {
        name: 'plan',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
    ]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.selectedAgent).toBe('build');
      });
      expect(stateModule.getPersistedSelectedAgent()).toBe('plan');
    } finally {
      dispose();
    }
  });

  it('hydrates 429 retry status for listed sessions before they are opened', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({
      'session-1': {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached',
        next: 8,
      },
    });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      await vi.waitFor(() => {
        expect(clientMocks.sessionStatus).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(stateModule.state.sessionStatus['session-1']).toEqual({
          type: 'retry',
          attempt: 2,
          message: '429 usage limit reached',
          next: 8,
        });
        expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
          statusCode: 429,
          message: '429 usage limit reached',
          attempt: 2,
          sessionID: 'session-1',
        });
      });
      expect(clientMocks.sessionGet).not.toHaveBeenCalled();
      expect(clientMocks.sessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('retries startup after an initial connection failure', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    clientMocks.health.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      healthy: true,
      version: '1.0.0',
    });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(clientMocks.health).toHaveBeenCalledTimes(1);
      expect(stateModule.error()).toBe('Failed to connect to OpenCode server');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(clientMocks.health).toHaveBeenCalledTimes(2);
      expect(stateModule.error()).toBeNull();
    } finally {
      dispose();
    }
  });

  it('continues sessions that were interrupted by extension reload', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState = {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: '',
      interruptedSessionIds: ['session-1'],
    };

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));

    const { hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
          parts: [
            {
              type: 'text',
              text: 'Continue from where you were interrupted before the extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.',
            },
          ],
        });
      });
    } finally {
      dispose();
    }
  });

  it('syncs session-selected mcps when selecting a session', async () => {
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.mcpStatus
      .mockResolvedValueOnce({
        alpha: { status: 'connected' },
        beta: { status: 'disabled' },
      })
      .mockResolvedValueOnce({
        alpha: { status: 'disabled' },
        beta: { status: 'connected' },
      });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    stateModule.setSelectedMcpsForSession('session-1', ['beta']);

    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await hookModule.selectSession('session-1');

      expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
      expect(clientMocks.mcpConnect).toHaveBeenCalledWith('beta');
    } finally {
      dispose();
    }
  });

  it('applies session mcps immediately when toggled', async () => {
    clientMocks.mcpStatus
      .mockResolvedValueOnce({
        alpha: { status: 'connected' },
        beta: { status: 'disabled' },
      })
      .mockResolvedValueOnce({
        alpha: { status: 'disabled' },
        beta: { status: 'connected' },
      });

    const { stateModule, hookModule } = await loadModules();
    stateModule.setState('activeSessionId', 'session-1');

    await hookModule.applySessionMcps(['beta'], 'session-1');

    expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
    expect(clientMocks.mcpConnect).toHaveBeenCalledWith('beta');
    expect(stateModule.getSelectedMcpsForSession('session-1')).toEqual(['beta']);
  });

  it('applies desktop session pane side from config updates', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          showStickyUserPrompt: true,
          desktopSessionPaneSide: 'right',
        },
      });

      expect(stateModule.desktopSessionPaneSide()).toBe('right');
    } finally {
      dispose();
    }
  });

  it('restores pending permission prompts from initial webview state after reload', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState = {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: '',
      interruptedSessionIds: ['session-1'],
      pendingPermissions: [
        {
          id: 'perm-1',
          permission: 'apply_patch',
          sessionID: 'session-1',
          title: 'apply_patch',
          metadata: {},
          tool: { messageID: 'message-1', callID: 'call-1' },
          time: { created: 123 },
        },
      ],
    };

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            callID: 'call-1',
            type: 'apply_patch',
          }),
        ]);
      });
      expect(stateModule.state.pendingAttentionSessionIds).toContain('session-1');
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('restores pending permission prompts that use permissionID after reload', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState = {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: '',
      interruptedSessionIds: ['session-1'],
      pendingPermissions: [
        {
          permissionID: 'perm-2',
          permission: 'apply_patch',
          sessionID: 'session-1',
          title: 'apply_patch',
          metadata: {},
          tool: { messageID: 'message-1', callID: 'call-1' },
          time: { created: 123 },
        },
      ],
    };

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'busy' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-2',
            sessionID: 'session-1',
            messageID: 'message-1',
            callID: 'call-1',
            type: 'apply_patch',
          }),
        ]);
      });
      expect(stateModule.state.pendingAttentionSessionIds).toContain('session-1');
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('normalizes live permission events with nested tool metadata', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    const serverEventHandlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation(
      (event: string, handler: (data: unknown) => void) => {
        serverEventHandlers.set(event, handler);
        return () => {
          serverEventHandlers.delete(event);
        };
      }
    );

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(serverEventHandlers.has('permission.asked')).toBe(true);
      });

      serverEventHandlers.get('permission.asked')?.({
        properties: {
          id: 'perm-live-1',
          permission: 'apply_patch',
          sessionID: 'session-1',
          title: 'apply_patch',
          metadata: {},
          tool: { messageID: 'message-1', callID: 'call-1' },
          time: { created: 123 },
        },
      });

      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({
          id: 'perm-live-1',
          sessionID: 'session-1',
          type: 'apply_patch',
          messageID: 'message-1',
          callID: 'call-1',
        }),
      ]);
    } finally {
      dispose();
    }
  });

  it('keeps the chat connected when the event stream is degraded', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096', eventStream: 'degraded' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(stateModule.state.serverStatus).toMatchObject({
        state: 'running',
        eventStream: 'degraded',
      });
      expect(clientMocks.health).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('resyncs active session messages on idle even when messages already exist', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([
      { info: userMessage('user-1'), parts: [] },
      { info: assistantMessage('assistant-1', 'user-1'), parts: [] },
    ]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [{ info: userMessage('stale-user'), parts: [] }]);

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

      await vi.waitFor(() => {
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('session-1');
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1');
      });

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'user-1',
        'assistant-1',
      ]);
    } finally {
      dispose();
    }
  });

  it('keeps the active session marked seen when a later session update arrives', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('lastSeenSessions', { 'session-1': 1_000 });

      handlers.get('session.updated')?.({
        properties: {
          info: {
            ...session('session-1'),
            time: { created: 0, updated: 2_000 },
          },
        },
      });

      expect(stateModule.state.lastSeenSessions['session-1']).toBe(2_000);
      expect(stateModule.isSessionUnread('session-1', 2_000)).toBe(false);
    } finally {
      nowSpy.mockRestore();
      dispose();
    }
  });

  it('ignores stale session selection results after switching sessions quickly', async () => {
    const { stateModule, hookModule } = await loadModules();

    const slowSession = Promise.resolve({ ...session('session-1'), title: 'Slow session' });
    const fastSession = Promise.resolve({ ...session('session-2'), title: 'Fast session' });
    const slowMessages = Promise.resolve([{ info: userMessage('user-1'), parts: [] }]);
    const fastMessages = Promise.resolve([{ info: userMessage('user-2'), parts: [] }]);

    clientMocks.sessionGet.mockImplementation(async (id: string) =>
      id === 'session-1' ? slowSession : fastSession
    );
    clientMocks.sessionMessages.mockImplementation(async (id: string) =>
      id === 'session-1' ? slowMessages : fastMessages
    );
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await Promise.all([
      hookModule.selectSession('session-1'),
      hookModule.selectSession('session-2'),
    ]);

    expect(stateModule.state.activeSessionId).toBe('session-2');
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['user-2']);
  });

  it('ignores stale retry status updates after aborting a retrying session', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
      default: { openai: 'gpt-4o' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ]);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('sessionStatus', 'session-1', {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached',
        next: 3,
      });
      stateModule.setSessionUsageLimit('session-1', {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 3_000,
        attempt: 2,
        providerID: 'openai',
        modelID: 'gpt-4o',
      });

      await hookModule.abortSession();

      handlers.get('session.status')?.({
        properties: {
          sessionID: 'session-1',
          status: {
            type: 'retry',
            attempt: 3,
            message: '429 usage limit reached',
            next: 8,
          },
        },
      });

      expect(stateModule.state.sessionStatus['session-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        attempt: 2,
        providerID: 'openai',
        modelID: 'gpt-4o',
      });

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
      handlers.get('session.status')?.({
        properties: {
          sessionID: 'session-1',
          status: {
            type: 'retry',
            attempt: 1,
            message: '429 usage limit reached',
            next: 5,
          },
        },
      });

      expect(stateModule.state.sessionStatus['session-1']).toEqual({
        type: 'retry',
        attempt: 1,
        message: '429 usage limit reached',
        next: 5,
      });
    } finally {
      dispose();
    }
  });

  it('aborts retrying subagent sessions when stopping the parent session', async () => {
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1' },
        { ...session('child-2'), parentID: 'child-1' },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('sessionStatus', {
        'session-1': { type: 'retry', attempt: 1, message: '429 usage limit reached', next: 3 },
        'child-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 4 },
        'child-2': { type: 'busy' },
      });
      stateModule.setSessionUsageLimit('session-1', {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 3_000,
        attempt: 1,
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
      stateModule.setSessionUsageLimit('child-1', {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 4_000,
        attempt: 2,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });

      await hookModule.abortSession();

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(3);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(3, 'child-2');
      expect(stateModule.state.sessionStatus['session-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionStatus['child-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionStatus['child-2']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        attempt: 1,
        sessionID: 'session-1',
      });
      expect(stateModule.state.sessionUsageLimits['child-1']).toMatchObject({
        attempt: 2,
        sessionID: 'child-1',
      });
    } finally {
      dispose();
    }
  });

  it('marks aborted plan sessions as skipped', async () => {
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('sessions', [
        { ...session('session-1'), time: { created: 0, updated: 200 } },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('sessionSelectedAgents', { 'session-1': 'plan' });

      await hookModule.abortSession();

      expect(stateModule.state.skippedPlanSessions['session-1']).toBe(200);
    } finally {
      dispose();
    }
  });

  it('records the originating session on usage-limit notices', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
      default: { openai: 'gpt-4o' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ]);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
      stateModule.setState('activeSessionId', 'child-1');

      handlers.get('session.status')?.({
        properties: {
          sessionID: 'child-1',
          status: {
            type: 'retry',
            attempt: 2,
            message: '429 usage limit reached',
            next: 8,
          },
        },
      });

      expect(stateModule.state.sessionUsageLimits['child-1']).toMatchObject({
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
    } finally {
      dispose();
    }
  });

  it('attaches retry usage-limit notices to the selected provider', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
        provider('anthropic', {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
      default: { openai: 'gpt-4o', anthropic: 'claude' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
        provider('anthropic', {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ]);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setSelectedModel(
        { providerID: 'anthropic', modelID: 'claude' },
        { sessionId: 'session-1', persistGlobal: false }
      );

      handlers.get('session.status')?.({
        properties: {
          sessionID: 'session-1',
          status: {
            type: 'retry',
            attempt: 2,
            message: '429 usage limit reached',
            next: 8,
          },
        },
      });

      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        providerID: 'anthropic',
        modelID: 'claude',
        attempt: 2,
        statusCode: 429,
      });
    } finally {
      dispose();
    }
  });
});
