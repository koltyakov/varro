import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { onMessage } from '../lib/bridge';
import {
  assistantMessage,
  getBridgeMocks,
  getClientMocks,
  loadModules,
  provider,
  session,
  todoPart,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();
type BridgeOnMessage = typeof onMessage;
const bridgeOnMessage = vi.fn<BridgeOnMessage>();
Object.assign(bridgeMocks, { onMessage: bridgeOnMessage });
const OPEN_CODE_MESSAGE_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function sessionInWorkspace(id: string) {
  return {
    ...session(id),
    directory: id === 'session-old' ? '/repo-old' : '/repo-new',
  };
}

describe('sendMessage', () => {
  it('requests scrolling to the latest message when sending', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    expect(stateModule.messageListScrollRequestKey()).toBe(0);

    await hookModule.sendMessage('Review this');

    expect(stateModule.messageListScrollRequestKey()).toBe(1);
  });

  it('uses an explicitly captured agent instead of the current selection', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('selectedAgent', 'plan');
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Implement the plan', { agent: 'build' });

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ agent: 'build' })
    );
  });

  it('does not promote temporary session routing to global defaults when sending', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: { high: {} },
        },
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: { medium: {} },
        },
      }),
    ]);
    stateModule.setSelectedModel({
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'medium',
    });
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-4o', variant: 'high' },
      { sessionId: 'session-1', persistGlobal: false }
    );
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Review this');

    expect(stateModule.getPersistedSelectedModel()).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'medium',
    });
    expect(stateModule.getStoredVariantForModel('openai', 'gpt-4o')).toBeUndefined();
  });

  it('starts title fallback as soon as OpenCode accepts the prompt', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('sessions', [{ ...session(), title: 'New Chat' }]);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionUpdate.mockResolvedValue({ ...session(), title: 'New Chat' });
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Fix the delayed session title');

    expect(clientMocks.varroSessionRenameIfUntitled).toHaveBeenCalledWith('session-1');
  });

  it('sends a valid OpenCode ID for exact optimistic reconciliation', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Use the server clock');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
      parts: [{ type: 'text', text: 'Use the server clock' }],
    });
  });

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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
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

    await hookModule.sendMessage('Review this [img-1.png]');

    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
      parts: [
        { type: 'text', text: 'Review this [img-1.png]' },
        { type: 'file', mime: 'image/png', filename: 'img-1.png', url: 'blob:1' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
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
      activeFile: { path: '/repo/src/app.ts', relativePath: 'src/app.ts', language: 'typescript' },
      selection: { startLine: 1, endLine: 2 },
      diagnostics: [],
    });
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
    stateModule.setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session());
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Send context');

    expect(stateModule.state.droppedFiles).toEqual([]);
    expect(stateModule.state.clipboardImages).toEqual([]);
    expect(stateModule.state.terminalSelection).toBeNull();
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(true);
  });

  it('keeps completed todos visible when sending a new turn', async () => {
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

    expect(stateModule.state.todos).toEqual([
      { id: 'old-todo', content: 'Old completed task', status: 'completed', priority: 'medium' },
    ]);
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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
      parts: [
        { type: 'text', text: 'Review this image' },
        { type: 'text', text: '[Working directory: /repo]' },
        { type: 'file', mime: 'image/png', filename: 'img-1.png', url: 'blob:1' },
        { type: 'text', text: 'src/extra.ts' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('uses global defaults instead of temporary session routing for a new session', async () => {
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
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-4o' },
      { sessionId: 'session-1', persistGlobal: false }
    );

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

  it('sends the first message of a new chat with the selected agent', async () => {
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
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-2'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.sendMessage('Make a plan');

    expect(stateModule.state.activeSessionId).toBe('session-2');
    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-2')).toBe('plan');
    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({ agent: 'plan' })
    );
  });

  it('keeps a newer selection while sending the captured draft to a delayed new session', async () => {
    const { stateModule, hookModule } = await loadModules();
    const created = deferred<ReturnType<typeof session>>();

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
    stateModule.setState('providers', [
      provider('openai', {
        'draft-model': {
          id: 'draft-model',
          name: 'Draft model',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
        'selected-model': {
          id: 'selected-model',
          name: 'Selected model',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ]);
    stateModule.setState('providerDefaults', { openai: 'draft-model' });
    stateModule.setSelectedAgent('plan');
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'draft-model' });
    clientMocks.sessionCreate.mockReturnValue(created.promise);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionUpdate.mockImplementation(async (id, body) => ({
      ...session(id as string),
      ...(body as object),
    }));
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    stateModule.setState('sessionMessageCounts', { 'session-created': 1 });

    const pendingSend = hookModule.sendMessage('Captured draft');
    await vi.waitFor(() => expect(clientMocks.sessionCreate).toHaveBeenCalledTimes(1));

    stateModule.setState('sessions', [session('session-selected')]);
    stateModule.setState('activeSessionId', 'session-selected');
    stateModule.setSelectedAgent('build', {
      sessionId: 'session-selected',
      persistGlobal: false,
    });
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'selected-model' },
      { sessionId: 'session-selected', persistGlobal: false }
    );
    created.resolve(session('session-created'));

    await expect(pendingSend).resolves.toBe(true);
    expect(stateModule.state.activeSessionId).toBe('session-selected');
    expect(stateModule.state.selectedAgent).toBe('build');
    expect(stateModule.state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'selected-model',
    });
    expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-created', {
      agent: 'plan',
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
      model: { providerID: 'openai', modelID: 'draft-model' },
      parts: [{ type: 'text', text: 'Captured draft' }],
    });
  });

  it('detaches pending lazy creation when the production workspace resets', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    const oldCreation = deferred<ReturnType<typeof session>>();
    const newCreation = deferred<ReturnType<typeof session>>();
    clientMocks.sessionCreate
      .mockReturnValueOnce(oldCreation.promise)
      .mockReturnValueOnce(newCreation.promise);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionUpdate.mockImplementation(async (id, body) => ({
      ...sessionInWorkspace(id as string),
      ...(body as object),
    }));
    clientMocks.sessionGet.mockImplementation(async (id) => sessionInWorkspace(id as string));
    clientMocks.sessionMessages.mockImplementation(async (id) => [
      {
        info: {
          ...userMessage(`user-${String(id)}`),
          sessionID: String(id),
        },
        parts: [],
      },
    ]);
    clientMocks.sessionStatus.mockResolvedValue({});

    const { stateModule, hookModule } = await loadModules();
    const providers = [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ];
    const applyDraftRouting = () => {
      stateModule.setState('providers', providers);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
      stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4o' });
    };
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-old',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });
      applyDraftRouting();

      const oldSend = hookModule.sendMessage('old workspace draft');
      await vi.waitFor(() => expect(clientMocks.sessionCreate).toHaveBeenCalledTimes(1));

      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-new',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });
      applyDraftRouting();
      const newSend = hookModule.sendMessage('new workspace draft');

      oldCreation.resolve(sessionInWorkspace('session-old'));
      newCreation.resolve(sessionInWorkspace('session-new'));
      const results = await Promise.all([oldSend, newSend]);

      expect(clientMocks.sessionCreate).toHaveBeenCalledTimes(2);
      expect(results).toEqual([false, true]);
      expect(stateModule.state.activeSessionId).toBe('session-new');
      expect(clientMocks.sessionSendAsync.mock.calls.map(([id]) => id)).toEqual(['session-new']);
    } finally {
      dispose();
    }
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
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 0 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4o' },
        },
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

  it('falls back to the persisted global model for blank sessions', async () => {
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
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-4o' },
      { sessionId: 'session-1', persistGlobal: false }
    );

    clientMocks.sessionGet.mockResolvedValue(session('session-2'));
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await hookModule.selectSession('session-2');

    expect(stateModule.state.selectedModel).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(stateModule.getSelectedModelForSession('session-2')).toEqual({
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
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 0 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4o' },
        },
        parts: [],
      },
    ]);

    await hookModule.selectSession('session-1');

    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBe('plan');
    expect(stateModule.getPersistedSelectedAgent()).toBe('build');
  });

  it('clears remembered tool expansion state when switching sessions', async () => {
    const expansionStateModule = await import('../lib/tool-call-expansion-state');
    const { hookModule } = await loadModules();

    const expansionKey = 'session-1\u0000message-1\u0000call-1';
    expansionStateModule.setToolCallExpanded(expansionKey, true);

    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await hookModule.selectSession('session-1');

    expect(expansionStateModule.getToolCallExpanded(expansionKey)).toBe(false);
  });

  it('restores todos from parallel tool calls when selecting a session', async () => {
    const { stateModule, hookModule } = await loadModules();

    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1', 'user-1'),
        parts: [],
      },
    ]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await hookModule.selectSession('session-1');

    expect(stateModule.state.todos).toBeDefined();
  });

  it('requests opening attention sessions when the extension sends that command', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
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

      expect(stateModule.openAttentionSessionsKey()).toBe(0);

      bridgeHandler({ type: 'command/open-attention-sessions' });

      expect(stateModule.openAttentionSessionsKey()).toBe(1);
    } finally {
      dispose();
    }
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
      messageID: expect.stringMatching(OPEN_CODE_MESSAGE_ID),
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
    const failedAssistant = assistantMessage('assistant-1', 'user-1');
    if (failedAssistant.role !== 'assistant') {
      throw new Error('Expected an assistant message fixture');
    }

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
          ...failedAssistant,
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
