import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Part, Provider, Session } from '../types';

const clientMocks = vi.hoisted(() => ({
  sessionCreate: vi.fn(),
  sessionGet: vi.fn(),
  sessionMessages: vi.fn(),
  sessionSendAsync: vi.fn(),
  serverEventsOn: vi.fn(() => () => {}),
}));

const bridgeMocks = vi.hoisted(() => ({
  onMessage: vi.fn(() => () => {}),
  postMessage: vi.fn(),
}));

vi.mock('../lib/client', () => ({
  client: {
    session: {
      create: clientMocks.sessionCreate,
      get: clientMocks.sessionGet,
      messages: clientMocks.sessionMessages,
      sendAsync: clientMocks.sessionSendAsync,
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
  clientMocks.sessionCreate.mockReset();
  clientMocks.sessionGet.mockReset();
  clientMocks.sessionMessages.mockReset();
  clientMocks.sessionSendAsync.mockReset();
  clientMocks.serverEventsOn.mockClear();
  bridgeMocks.onMessage.mockClear();
  bridgeMocks.postMessage.mockReset();
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

  it('reuses the most recently selected agent for a new session', async () => {
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
    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-2')).toBe('plan');
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
});
