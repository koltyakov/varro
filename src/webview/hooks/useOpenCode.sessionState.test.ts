import { createComputed, createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEventName } from '../../shared/protocol';
import type { onMessage } from '../lib/bridge';
import type { MessageEntry, Part } from '../types';
import {
  assistantMessage,
  getBridgeMocks,
  getClientMocks,
  loadModules,
  session,
  userMessage,
} from './useOpenCode.test-support';

interface ServerEvent {
  properties: unknown;
}

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();
type BridgeOnMessage = typeof onMessage;
type ServerEventsOn = (
  event: ServerEventName | '*',
  handler: (data: ServerEvent) => void
) => () => void;
const bridgeOnMessage = vi.fn<BridgeOnMessage>();
const serverEventsOn = vi.fn<ServerEventsOn>();
Object.assign(bridgeMocks, { onMessage: bridgeOnMessage });
Object.assign(clientMocks, { serverEventsOn });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function userEntry(id: string, sessionId = 'session-1') {
  const info = userMessage(id);
  info.sessionID = sessionId;
  return { info, parts: [] };
}

function taskAnchorEntry(
  childSessionId: string,
  ownerSessionId = 'session-1',
  messageId = 'parent-task',
  parentMessageId = 'parent-user'
): MessageEntry {
  const info = assistantMessage(messageId, parentMessageId);
  info.sessionID = ownerSessionId;
  info.time = { created: 2, completed: 3 };
  const part: Part = {
    id: `${messageId}-part`,
    sessionID: ownerSessionId,
    messageID: info.id,
    type: 'tool',
    callID: `${messageId}-call`,
    tool: 'task',
    state: {
      status: 'completed',
      input: { description: 'Inspect the repo' },
      output: 'Done',
      title: 'Inspect the repo',
      metadata: { sessionId: childSessionId },
      time: { start: 2, end: 3 },
    },
  };
  return { info, parts: [part] };
}

function installServerEventHandlers() {
  const handlers = new Map<ServerEventName | '*', (data: ServerEvent) => void>();
  serverEventsOn.mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  return handlers;
}

function mockRuntimeBootstrap() {
  clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
  clientMocks.sessionList.mockResolvedValue([]);
  clientMocks.agentList.mockResolvedValue([]);
  clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
  clientMocks.questionList.mockResolvedValue([]);
  clientMocks.sessionStatus.mockResolvedValue({});
}

describe('useOpenCode session state flows', () => {
  it('closes the session picker when the host opens a session', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    mockRuntimeBootstrap();
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      stateModule.setShowSessionPicker(true);

      bridgeHandler({
        type: 'command/open-session',
        payload: { sessionId: 'session-1' },
      });

      expect(stateModule.showSessionPicker()).toBe(false);
      expect(stateModule.state.activeSessionId).toBe('session-1');
    } finally {
      dispose();
    }
  });

  it('keeps a cross-root selection alive through its activation context update', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    mockRuntimeBootstrap();
    const siblingSession = { ...session('session-b'), directory: '/repo-b' };
    const siblingMessage = userEntry('message-b', 'session-b');
    clientMocks.sessionGet.mockResolvedValue(siblingSession);
    clientMocks.sessionMessages.mockResolvedValue([siblingMessage]);
    clientMocks.sessionActivate.mockImplementation(async () => {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-b',
          workspaceFolders: [
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/repo-b' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });
      return siblingSession;
    });
    // SAFETY: The fixture provides the initial context snapshot read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-a',
        workspaceFolders: [
          { name: 'Repo A', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      stateModule.setState('sessions', [siblingSession]);

      await hookModule.selectSession('session-b', { directory: '/repo-b' });

      expect(clientMocks.sessionActivate).toHaveBeenCalledWith(
        'session-b',
        '/repo-b',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(stateModule.state.editorContext.workspacePath).toBe('/repo-b');
      expect(stateModule.state.activeSessionId).toBe('session-b');
      expect(stateModule.state.messages).toEqual([siblingMessage]);
    } finally {
      dispose();
    }
  });

  it('does not surface a best-effort restoration activation failure', async () => {
    const siblingSession = { ...session('session-b'), directory: '/repo-b' };
    clientMocks.sessionActivate.mockRejectedValue(
      new Error('Workspace directory is not an open workspace folder')
    );
    // SAFETY: The fixture provides the initial context snapshot read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-a',
        workspaceFolders: [{ name: 'Repo A', path: '/repo-a' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const { stateModule, hookModule } = await loadModules();
    stateModule.setState('sessions', [siblingSession]);

    await hookModule.selectSession('session-b', {
      directory: '/repo-b',
      reportActivationError: false,
    });

    expect(clientMocks.sessionActivate).toHaveBeenCalledOnce();
    expect(stateModule.error()).toBeNull();
    expect(stateModule.state.activeSessionId).toBeNull();
  });

  it('does not reactivate an explicitly scoped session in the current workspace', async () => {
    const localSession = { ...session('session-a'), directory: '/repo-a' };
    clientMocks.sessionGet.mockResolvedValue(localSession);
    clientMocks.sessionMessages.mockResolvedValue([]);
    // SAFETY: The fixture provides the initial context snapshot read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-a',
        workspaceFolders: [{ name: 'Repo A', path: '/repo-a' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const { stateModule, hookModule } = await loadModules();
    stateModule.setState('sessions', [localSession]);

    await hookModule.selectSession('session-a', { directory: '/repo-a' });

    expect(clientMocks.sessionActivate).not.toHaveBeenCalled();
    expect(stateModule.state.activeSessionId).toBe('session-a');
  });

  it('preserves the active chat when only workspace folder membership changes', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    mockRuntimeBootstrap();
    const siblingSession = { ...session('session-b'), directory: '/repo-b' };
    const siblingMessage = userEntry('message-b', 'session-b');
    clientMocks.sessionGet.mockResolvedValue(siblingSession);
    clientMocks.sessionMessages.mockResolvedValue([siblingMessage]);
    clientMocks.sessionActivate.mockResolvedValue(siblingSession);
    // SAFETY: The fixture provides the initial context snapshot read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-a',
        workspaceFolders: [
          { name: 'Repo A', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      stateModule.setState('sessions', [siblingSession]);
      await hookModule.selectSession('session-b', { directory: '/repo-b' });
      clientMocks.sessionList.mockResolvedValue([siblingSession]);
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-a',
          workspaceFolders: [
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/repo-b' },
            { name: 'Repo C', path: '/repo-c' },
          ],
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });

      expect(stateModule.state.activeSessionId).toBe('session-b');
      expect(stateModule.state.messages).toEqual([siblingMessage]);
    } finally {
      dispose();
    }
  });

  it('keeps the chat connected when the event stream is degraded', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
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

  it('does not resync active session messages on idle when local messages already look settled', async () => {
    const handlers = new Map<string, (data: ServerEvent) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
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
      const settledAssistant = assistantMessage('assistant-1', 'user-1');
      if (settledAssistant.role !== 'assistant') {
        throw new Error('Expected an assistant message fixture');
      }
      settledAssistant.time.completed = 1;

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: settledAssistant,
          parts: [],
        },
      ]);

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

      await vi.waitFor(() => {
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('session-1', {
          directory: undefined,
        });
      });

      expect(clientMocks.sessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('applies a fallback title when refetching the session fails', async () => {
    const handlers = new Map<string, (data: ServerEvent) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionGet.mockRejectedValue(new Error('404 Session not found'));
    clientMocks.varroSessionRenameIfUntitled.mockResolvedValue({
      id: 'session-1',
      title: 'Test Message',
    });

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();
      stateModule.setState('sessions', [{ ...session('session-1'), title: 'New Chat' }]);

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

      await vi.waitFor(() => {
        expect(stateModule.state.sessions[0]?.title).toBe('Test Message');
      });
      expect(clientMocks.varroSessionRenameIfUntitled).toHaveBeenCalledWith('session-1', {
        directory: '/repo',
      });
    } finally {
      dispose();
    }
  });

  it('keeps the active session marked seen when a later session update arrives', async () => {
    const handlers = new Map<string, (data: ServerEvent) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
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

  it('keeps an active completion unread when session metadata updates with the list open', async () => {
    const handlers = new Map<string, (data: ServerEvent) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
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
      stateModule.setState('completedSessionResponses', { 'session-1': 1_500 });
      stateModule.setShowSessionPicker(true);

      handlers.get('session.updated')?.({
        properties: {
          info: {
            ...session('session-1'),
            time: { created: 0, updated: 2_000 },
          },
        },
      });

      expect(stateModule.state.lastSeenSessions['session-1']).toBe(1_000);
      expect(stateModule.isSessionCompletedResponseUnread('session-1')).toBe(true);
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

  it('loads older session messages through cursor pages', async () => {
    const { stateModule, hookModule } = await loadModules();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const latest = [{ info: userMessage('user-3'), parts: [] }] as Array<{
      info: ReturnType<typeof userMessage>;
      parts: [];
    }> & { nextCursor?: string };
    latest.nextCursor = 'cursor-2';
    // SAFETY: The fixture provides the typeof latest fields read by this statement.
    const older = [
      { info: userMessage('user-1'), parts: [] },
      { info: userMessage('user-2'), parts: [] },
    ] as typeof latest;

    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValueOnce(latest).mockResolvedValueOnce(older);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    await hookModule.selectSession('session-1');
    await hookModule.loadFullSessionHistory('session-1');

    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(1, 'session-1', { limit: 200 });
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-2',
    });
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
    ]);
  });

  it('stops full history loading when cursors form a multi-page cycle', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [{ info: userMessage('user-3'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-a';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const pageA = [{ info: userMessage('user-2'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    pageA.nextCursor = 'cursor-b';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const pageB = [
      { info: userMessage('user-1'), parts: [] },
      { info: userMessage('user-2'), parts: [] },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    pageB.nextCursor = 'cursor-a';
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (!options?.before) return latest;
      if (options.before === 'cursor-a') return pageA;
      if (options.before === 'cursor-b') return pageB;
      throw new Error(`Unexpected cursor ${options.before}`);
    });
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-1');
    await hookModule.loadFullSessionHistory('session-1');

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
    ]);
    expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
  });

  it('loads one older history page at a time for scroll pagination', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [{ info: userMessage('user-3'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-2';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const older = [
      { info: userMessage('user-1'), parts: [] },
      { info: userMessage('user-2'), parts: [] },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    older.nextCursor = 'cursor-1';
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValueOnce(latest).mockResolvedValueOnce(older);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-1');

    await expect(hookModule.loadOlderSessionHistoryPage('session-1')).resolves.toBe(true);
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-2',
    });
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(3, 'session-1', {
      limit: 200,
      before: 'cursor-1',
    });
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
    ]);
    expect(messageWindow.getSessionHistoryCursor('session-1')).toBe('cursor-1');
  });

  it('retains a live append that arrives while an older history page is in flight', async () => {
    const olderPage = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValueOnce([{ info: userMessage('user-3'), parts: [] }]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-1');
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
    clientMocks.sessionMessages.mockReturnValueOnce(olderPage.promise);

    const load = hookModule.loadOlderSessionHistoryPage('session-1');
    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenLastCalledWith('session-1', {
        limit: 200,
        before: 'cursor-older',
        directory: '/repo',
      });
    });
    stateModule.upsertMessage({ info: userMessage('user-4'), parts: [] });

    olderPage.resolve([
      { info: userMessage('user-1'), parts: [] },
      { info: userMessage('user-2'), parts: [] },
    ]);

    await expect(load).resolves.toBe(true);
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
      'user-4',
    ]);
  });

  it('preserves child-session messages and streaming state while loading older parent history', async () => {
    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const childInfo = assistantMessage('child-assistant', 'child-user');
    childInfo.sessionID = 'child-1';
    const childPart: Part = {
      id: 'child-text',
      sessionID: 'child-1',
      messageID: 'child-assistant',
      type: 'text',
      text: '',
    };
    clientMocks.sessionMessages.mockResolvedValue([userEntry('parent-old')]);
    stateModule.setState('sessions', [
      session('session-1'),
      { ...session('child-1'), parentID: 'session-1' },
    ]);
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('messages', [
      userEntry('parent-latest'),
      { info: childInfo, parts: [childPart] },
    ]);
    stateModule.setState('streamingPartId', childPart.id);
    stateModule.setState('streamingText', 'Child response in progress');
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');

    await hookModule.loadOlderSessionHistoryPage('session-1');

    expect({
      messageIds: stateModule.state.messages.map((entry) => entry.info.id),
      streamingPartId: stateModule.state.streamingPartId,
      streamingText: stateModule.state.streamingText,
    }).toEqual({
      messageIds: ['parent-old', 'parent-latest', 'child-assistant'],
      streamingPartId: 'child-text',
      streamingText: 'Child response in progress',
    });
  });

  it('preserves interleaved child entry identities while loading older parent history', async () => {
    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const childBefore = userEntry('child-before', 'child-1');
    const parentCurrent = userEntry('parent-current');
    const childAfter = userEntry('child-after', 'child-1');
    clientMocks.sessionMessages.mockResolvedValue([userEntry('parent-older')]);
    stateModule.setState('sessions', [
      session('session-1'),
      { ...session('child-1'), parentID: 'session-1' },
    ]);
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('messages', [childBefore, parentCurrent, childAfter]);
    const retained = new Map(
      stateModule.state.messages.map((entry) => [entry.info.id, entry] as const)
    );
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');

    await hookModule.loadOlderSessionHistoryPage('session-1');

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'child-before',
      'parent-older',
      'parent-current',
      'child-after',
    ]);
    expect(stateModule.state.messages[0]).toBe(retained.get('child-before'));
    expect(stateModule.state.messages[2]).toBe(retained.get('parent-current'));
    expect(stateModule.state.messages[3]).toBe(retained.get('child-after'));
  });

  it('preserves active-session streaming state while prepending older history', async () => {
    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const currentInfo = assistantMessage('parent-assistant', 'parent-user');
    currentInfo.time = { created: 1 };
    const currentPart: Part = {
      id: 'parent-text',
      sessionID: 'session-1',
      messageID: 'parent-assistant',
      type: 'text',
      text: '',
    };
    clientMocks.sessionMessages.mockResolvedValue([userEntry('parent-old')]);
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('messages', [{ info: currentInfo, parts: [currentPart] }]);
    stateModule.setState('streamingPartId', currentPart.id);
    stateModule.setState('streamingText', 'Parent response in progress');
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');

    const observedStreamingState: Array<[string | null, string]> = [];
    const dispose = createRoot((cleanup) => {
      createComputed(() => {
        observedStreamingState.push([
          stateModule.state.streamingPartId,
          stateModule.state.streamingText,
        ]);
      });
      return cleanup;
    });

    try {
      await hookModule.loadOlderSessionHistoryPage('session-1');
    } finally {
      dispose();
    }

    expect({
      messageIds: stateModule.state.messages.map((entry) => entry.info.id),
      streamingPartId: stateModule.state.streamingPartId,
      streamingText: stateModule.state.streamingText,
    }).toEqual({
      messageIds: ['parent-old', 'parent-assistant'],
      streamingPartId: 'parent-text',
      streamingText: 'Parent response in progress',
    });
    expect(observedStreamingState).not.toContainEqual([null, '']);
  });

  it('materializes live streaming text before a stale busy-status message sync clears it', async () => {
    mockRuntimeBootstrap();
    const info = assistantMessage('assistant-1', 'user-1');
    info.time = { created: 1 };
    const stalePart: Part = {
      id: 'text-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'text',
      text: '',
    };
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'busy' } });
    clientMocks.sessionMessages.mockResolvedValue([{ info, parts: [stalePart] }]);

    const { stateModule, hookModule } = await loadModules();
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('sessions', [session('session-1')]);
    stateModule.setState('messages', [{ info, parts: [stalePart] }]);
    stateModule.setState('streamingPartId', stalePart.id);
    stateModule.setState('streamingText', 'Partial answer from the live SSE stream');

    await hookModule.recheckSessionStatus('session-1');

    expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      text: 'Partial answer from the live SSE stream',
    });
    expect(stateModule.state.streamingPartId).toBeNull();
    expect(stateModule.state.streamingText).toBe('');
  });

  it('preserves a queued active-session delta while prepending older history', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 1),
    });

    try {
      const { stateModule, hookModule } = await loadModules();
      const messageWindow = await import('../lib/message-window');
      const currentInfo = assistantMessage('parent-assistant', 'parent-user');
      currentInfo.time = { created: 1 };
      const currentPart: Part = {
        id: 'parent-text',
        sessionID: 'session-1',
        messageID: 'parent-assistant',
        type: 'text',
        text: '',
      };
      clientMocks.sessionMessages.mockResolvedValue([userEntry('parent-old')]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [{ info: currentInfo, parts: [currentPart] }]);
      stateModule.setState('streamingPartId', currentPart.id);
      stateModule.setState('streamingText', 'Parent response');
      stateModule.applyMessagePartDelta(
        currentInfo.id,
        currentPart.id,
        ' in progress',
        'session-1'
      );
      messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');

      await hookModule.loadOlderSessionHistoryPage('session-1');

      expect({
        streamingPartId: stateModule.state.streamingPartId,
        streamingText: stateModule.state.streamingText,
      }).toEqual({
        streamingPartId: 'parent-text',
        streamingText: 'Parent response in progress',
      });
    } finally {
      if (originalRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalRequestAnimationFrame,
        });
      } else {
        // SAFETY: The fixture provides the Partial<typeof globalThis> fields read by this statement.
        delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
      }
    }
  });

  it('returns a detached older-history response after A -> B -> A reselection', async () => {
    const stalePage = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    // SAFETY: The test installs the typed mock implementation before this statement.
    const initialA = [{ info: userMessage('user-a-initial'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    initialA[0]!.info.sessionID = 'session-a';
    initialA.nextCursor = 'cursor-stale';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const reopenedA = [{ info: userMessage('user-a-current'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    reopenedA[0]!.info.sessionID = 'session-a';
    reopenedA.nextCursor = 'cursor-current';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const initialB = [{ info: userMessage('user-b'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    initialB[0]!.info.sessionID = 'session-b';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const staleOlderA = [{ info: userMessage('user-a-stale'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    staleOlderA[0]!.info.sessionID = 'session-a';
    let initialALoads = 0;

    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockImplementation(async (id, options) => {
      if (id === 'session-a' && options?.before === 'cursor-stale') {
        return stalePage.promise;
      }
      if (id === 'session-a' && options?.before === 'cursor-current') return [];
      if (id === 'session-a') {
        initialALoads += 1;
        return initialALoads === 1 ? initialA : reopenedA;
      }
      return initialB;
    });
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-a');
    const staleLoad = hookModule.loadOlderSessionHistoryPage('session-a');
    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-a', {
        limit: 200,
        before: 'cursor-stale',
      });
    });

    await hookModule.selectSession('session-b');
    await hookModule.selectSession('session-a');
    stalePage.resolve(staleOlderA);

    await expect(staleLoad).resolves.toBe(false);
    expect(stateModule.state.activeSessionId).toBe('session-a');
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['user-a-current']);
    expect(messageWindow.getSessionHistoryCursor('session-a')).toBe('cursor-current');
  });

  it('preserves exhausted older history after A -> B -> A reselection', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latestA = [
      userEntry('user-a-2', 'session-a'),
      userEntry('user-a-3', 'session-a'),
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    latestA.nextCursor = 'cursor-older';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const olderA = [userEntry('user-a-1', 'session-a')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    // SAFETY: The test installs the typed mock implementation before this statement.
    const reopenedA = [
      userEntry('user-a-2', 'session-a'),
      userEntry('user-a-3', 'session-a'),
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    // SAFETY: The test installs the typed mock implementation before this statement.
    const initialB = [userEntry('user-b', 'session-b')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    let latestALoads = 0;

    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockImplementation(async (id, options) => {
      if (id === 'session-a' && options?.before === 'cursor-older') return olderA;
      if (id === 'session-a') {
        latestALoads += 1;
        return latestALoads === 1 ? latestA : reopenedA;
      }
      return initialB;
    });
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-a');
    await expect(hookModule.loadOlderSessionHistoryPage('session-a')).resolves.toBe(true);
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-a-1',
      'user-a-2',
      'user-a-3',
    ]);
    expect(messageWindow.getSessionHistoryCursor('session-a')).toBeUndefined();

    await hookModule.selectSession('session-b');
    await hookModule.selectSession('session-a');

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-a-1',
      'user-a-2',
      'user-a-3',
    ]);
    expect(messageWindow.getSessionHistoryCursor('session-a')).toBeUndefined();
  });

  it('prefetches a user prompt behind an assistant-only history boundary', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [{ info: assistantMessage('assistant-1', 'user-1'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-1';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const boundary = [
      {
        info: userMessage('user-1'),
        parts: [
          {
            id: 'user-1-text',
            sessionID: 'session-1',
            messageID: 'user-1',
            type: 'text' as const,
            text: 'Boundary prompt',
          },
        ],
      },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    boundary.nextCursor = 'cursor-2';
    const older = [{ info: userMessage('user-0'), parts: [] }];
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(boundary)
      .mockResolvedValueOnce(older);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-1');

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
        limit: 200,
        before: 'cursor-1',
      });
      expect(
        messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
      ).toEqual(['user-1']);
    });

    await expect(hookModule.loadOlderSessionHistoryPage('session-1')).resolves.toBe(true);
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-1',
    });
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(3, 'session-1', {
      limit: 200,
      before: 'cursor-2',
      directory: '/repo',
    });
    expect(messageWindow.getSessionHistoryCursor('session-1')).toBe('cursor-2');

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(3, 'session-1', {
        limit: 200,
        before: 'cursor-2',
        directory: '/repo',
      });
      expect(
        messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
      ).toEqual(['user-0', 'user-1']);
    });
  });

  it('restarts boundary prefetch after an active message invalidates its revision', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const staleBoundary = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [{ info: assistantMessage('assistant-1', 'user-1'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-1';
    const completedAssistant = assistantMessage('assistant-2', 'user-1');
    if (completedAssistant.role !== 'assistant') {
      throw new Error('Expected an assistant message fixture');
    }
    completedAssistant.time.completed = 3;
    // SAFETY: The test installs the typed mock implementation before this statement.
    const resynced = [latest[0]!, { info: completedAssistant, parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    resynced.nextCursor = 'cursor-1';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const boundary = [
      {
        info: userMessage('user-1'),
        parts: [
          {
            id: 'user-1-text',
            sessionID: 'session-1',
            messageID: 'user-1',
            type: 'text' as const,
            text: 'Boundary prompt',
          },
        ],
      },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    let latestLoads = 0;
    let boundaryLoads = 0;
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (!options?.before) {
        latestLoads += 1;
        return latestLoads === 1 ? latest : resynced;
      }
      boundaryLoads += 1;
      return boundaryLoads === 1 ? staleBoundary.promise : boundary;
    });

    const { hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('message.updated')).toBe(true));
      await hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(boundaryLoads).toBe(1));

      handlers.get('message.updated')?.({ properties: { info: completedAssistant } });

      await vi.waitFor(() => {
        expect(latestLoads).toBeGreaterThanOrEqual(2);
        expect(boundaryLoads).toBe(2);
        expect(
          messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
        ).toEqual(['user-1']);
      });
    } finally {
      staleBoundary.resolve(boundary);
      await staleBoundary.promise;
      dispose();
    }
  });

  it('does not block scroll pagination on an in-flight prompt prefetch', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [userEntry('user-current')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-a';
    const firstPromptPage = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const laterPromptPage = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    // SAFETY: The test installs the typed mock implementation before this statement.
    const olderPage = [userEntry('user-older')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    olderPage.nextCursor = 'cursor-b';
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (!options?.before) return latest;
      if (options.before === 'cursor-a') return firstPromptPage.promise;
      if (options.before === 'cursor-b') return laterPromptPage.promise;
      throw new Error(`Unexpected cursor ${options.before}`);
    });
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    await hookModule.selectSession('session-1');
    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-a',
        directory: undefined,
      });
    });

    const pageLoad = hookModule.loadOlderSessionHistoryPage('session-1');
    try {
      firstPromptPage.resolve(olderPage);
      await vi.waitFor(() => {
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-b',
          directory: '/repo',
        });
      });
      await expect(pageLoad).resolves.toBe(true);
      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'user-older',
        'user-current',
      ]);
      expect(
        clientMocks.sessionMessages.mock.calls.filter(
          ([, options]) => options?.before === 'cursor-a'
        )
      ).toHaveLength(1);
    } finally {
      laterPromptPage.resolve([]);
      await laterPromptPage.promise;
    }
  });

  it('prefetches past an empty boundary prompt to the nearest previewable prompt', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [{ info: assistantMessage('assistant-1', 'user-valid'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-empty';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const emptyBoundary = [userEntry('user-empty')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    emptyBoundary.nextCursor = 'cursor-valid';
    const validBoundary = [
      {
        info: userMessage('user-valid'),
        parts: [
          {
            id: 'user-valid-text',
            sessionID: 'session-1',
            messageID: 'user-valid',
            type: 'text' as const,
            text: 'Previewable prompt',
          },
        ],
      },
    ];
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(emptyBoundary)
      .mockResolvedValueOnce(validBoundary);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-1');

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-valid',
      });
    });
    expect(
      messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
    ).toEqual(['user-valid', 'user-empty']);
  });

  it('prefetches past a working-directory-only boundary prompt', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [{ info: assistantMessage('assistant-1', 'user-valid'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-metadata';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const metadataBoundary = [
      {
        info: userMessage('user-metadata'),
        parts: [
          {
            id: 'user-metadata-text',
            sessionID: 'session-1',
            messageID: 'user-metadata',
            type: 'text' as const,
            text: '[Working directory: /repo]',
          },
        ],
      },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    metadataBoundary.nextCursor = 'cursor-valid';
    const validBoundary = [
      {
        info: userMessage('user-valid'),
        parts: [
          {
            id: 'user-valid-text',
            sessionID: 'session-1',
            messageID: 'user-valid',
            type: 'text' as const,
            text: 'Previewable prompt',
          },
        ],
      },
    ];
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(metadataBoundary)
      .mockResolvedValueOnce(validBoundary);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    await hookModule.selectSession('session-1');

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-valid',
      });
    });
    expect(
      messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
    ).toEqual(['user-valid', 'user-metadata']);
  });

  it('prefetches past a previewable boundary prompt already in the loaded window', async () => {
    // SAFETY: The test installs the typed mock implementation before this statement.
    const latest = [
      userEntry('user-loaded'),
      { info: assistantMessage('assistant-1', 'user-loaded'), parts: [] },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    latest.nextCursor = 'cursor-duplicate';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const duplicateBoundary = [
      {
        info: userMessage('user-loaded'),
        parts: [
          {
            id: 'user-loaded-text',
            sessionID: 'session-1',
            messageID: 'user-loaded',
            type: 'text' as const,
            text: 'Loaded prompt from the boundary page',
          },
        ],
      },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    duplicateBoundary.nextCursor = 'cursor-older';
    const olderBoundary = [
      {
        info: userMessage('user-older'),
        parts: [
          {
            id: 'user-older-text',
            sessionID: 'session-1',
            messageID: 'user-older',
            type: 'text' as const,
            text: 'Older previewable prompt',
          },
        ],
      },
    ];
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(duplicateBoundary)
      .mockResolvedValueOnce(olderBoundary);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.questionList.mockResolvedValue([]);

    const { hookModule } = await loadModules();
    await hookModule.selectSession('session-1');

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-older',
      });
    });
  });

  it('preserves append and removal events that beat a stale latest response', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const staleLatest = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const canonical = [userEntry('message-1'), userEntry('message-3')];
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages
      .mockReturnValueOnce(staleLatest.promise)
      .mockResolvedValueOnce(canonical);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      stateModule.setState('sessions', [session('session-1')]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [userEntry('message-1'), userEntry('message-2')]);

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));

      handlers.get('message.updated')?.({ properties: { info: userMessage('message-3') } });
      handlers.get('message.removed')?.({
        properties: { sessionID: 'session-1', messageID: 'message-2' },
      });
      staleLatest.resolve([userEntry('message-1'), userEntry('message-2')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'message-1',
        'message-3',
      ]);
    } finally {
      dispose();
    }
  });

  it('preserves an append without relying on a later removal invalidation', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const staleLatest = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockReturnValueOnce(staleLatest.promise);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      stateModule.setState('sessions', [session('session-1')]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [userEntry('message-1'), userEntry('message-2')]);

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      handlers.get('message.updated')?.({ properties: { info: userMessage('message-3') } });

      staleLatest.resolve([userEntry('message-1'), userEntry('message-2')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
      ]);
    } finally {
      dispose();
    }
  });

  it('preserves a same-part SSE update that beats a stale latest response', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const staleLatest = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const staleEntry = {
      ...userEntry('message-1'),
      parts: [
        {
          id: 'part-1',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'text' as const,
          text: 'old',
        },
      ],
    };
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockReturnValueOnce(staleLatest.promise);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      stateModule.setState('sessions', [session('session-1')]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [staleEntry]);

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      handlers.get('message.part.updated')?.({
        properties: {
          part: {
            ...staleEntry.parts[0],
            text: 'new',
          },
        },
      });
      staleLatest.resolve([staleEntry]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({ text: 'new' });
    } finally {
      dispose();
    }
  });

  it('hydrates a selected busy session when an unprojectable stream event races the initial snapshot', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const initialSnapshot = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const followUpSnapshot = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const canonical = [
      userEntry('user-1'),
      { info: assistantMessage('assistant-1', 'user-1'), parts: [] },
    ];
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages
      .mockReturnValueOnce(initialSnapshot.promise)
      .mockReturnValue(followUpSnapshot.promise);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.next.text.delta')).toBe(true));
      stateModule.setState('sessions', [session('session-1')]);
      const selection = hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));

      handlers.get('session.next.text.delta')?.({
        properties: {
          sessionID: 'session-1',
          assistantMessageID: 'assistant-1',
          textID: 'text-1',
          delta: 'streaming response',
        },
      });
      handlers.get('session.next.reasoning.delta')?.({
        properties: {
          sessionID: 'session-1',
          assistantMessageID: 'assistant-1',
          reasoningID: 'reasoning-1',
          delta: 'thinking',
        },
      });
      handlers.get('message.part.delta')?.({
        properties: {
          sessionID: 'session-1',
          messageID: 'assistant-1',
          partID: 'text-1',
          field: 'text',
          delta: 'streaming response',
        },
      });
      handlers.get('message.part.updated')?.({
        properties: {
          part: {
            id: 'text-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'text',
            text: 'streaming response',
          },
        },
      });
      handlers.get('message.updated')?.({
        properties: {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
          },
        },
      });
      initialSnapshot.resolve(canonical);
      await selection;

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'user-1',
        'assistant-1',
      ]);
      expect(stateModule.state.messagesLoading).toBe(false);
    } finally {
      dispose();
    }
  });

  it('preserves child-session messages during active-parent latest-message resync', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const parentMessage = userEntry('parent-message');
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockResolvedValue([parentMessage]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1' },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [parentMessage, userEntry('child-message', 'child-1')]);

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'parent-message',
        'child-message',
      ]);
    } finally {
      dispose();
    }
  });

  it('inserts a child idle sync after its parent task anchor', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const childMessage = userEntry('child-message', 'child-1');
    clientMocks.sessionGet.mockImplementation(async (id) =>
      id === 'child-1'
        ? { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } }
        : session(String(id))
    );
    clientMocks.sessionMessages.mockResolvedValue([childMessage]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      const parentAnchor = taskAnchorEntry('child-1');
      parentAnchor.parts.push({
        id: 'parent-stream',
        sessionID: 'session-1',
        messageID: 'parent-task',
        type: 'text',
        text: '',
      });
      stateModule.setState('messages', [
        userEntry('parent-before'),
        parentAnchor,
        userEntry('parent-after'),
      ]);
      stateModule.setState('streamingPartId', 'parent-stream');
      stateModule.setState('streamingText', 'Parent still streaming');

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });

      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
          'parent-before',
          'parent-task',
          'child-message',
          'parent-after',
        ]);
      });
      expect(stateModule.state.streamingPartId).toBe('parent-stream');
      expect(stateModule.state.streamingText).toBe('Parent still streaming');
    } finally {
      dispose();
    }
  });

  it('clears child streaming state when the child snapshot completes that stream', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const childInfo = assistantMessage('child-assistant', 'child-user');
    childInfo.sessionID = 'child-1';
    childInfo.time = { created: 2, completed: 4 };
    const childPart: Part = {
      id: 'child-text',
      sessionID: 'child-1',
      messageID: childInfo.id,
      type: 'text',
      text: 'Final child response',
    };
    clientMocks.sessionGet.mockImplementation(async (id) =>
      id === 'child-1'
        ? { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 4 } }
        : session(String(id))
    );
    clientMocks.sessionMessages.mockResolvedValue([{ info: childInfo, parts: [childPart] }]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 4 } },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        taskAnchorEntry('child-1'),
        {
          info: { ...childInfo, time: { created: 2 } },
          parts: [{ ...childPart, text: '' }],
        },
      ]);
      stateModule.setState('streamingPartId', childPart.id);
      stateModule.setState('streamingText', 'Stale child stream');

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });

      await vi.waitFor(() => {
        expect(stateModule.state.streamingPartId).toBeNull();
        expect(stateModule.state.streamingText).toBe('');
        const child = stateModule.state.messages.find((entry) => entry.info.id === childInfo.id);
        expect(child?.parts[0]).toMatchObject({ text: 'Final child response' });
      });
    } finally {
      dispose();
    }
  });

  it('reorders an early child recovery after its anchor when the parent snapshot arrives', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const parentSnapshot = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const childMessage = userEntry('child-message', 'child-1');
    clientMocks.sessionGet.mockImplementation(async (id) =>
      id === 'child-1'
        ? { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } }
        : session(String(id))
    );
    clientMocks.sessionMessages.mockImplementation(async (id) =>
      id === 'session-1' ? parentSnapshot.promise : [childMessage]
    );

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
      ]);
      const selection = hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(stateModule.state.activeSessionId).toBe('session-1'));

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['child-message']);
      });
      const recoveredChild = stateModule.state.messages[0];

      parentSnapshot.resolve([
        userEntry('parent-before'),
        taskAnchorEntry('child-1'),
        userEntry('parent-after'),
      ]);
      await selection;

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'parent-before',
        'parent-task',
        'child-message',
        'parent-after',
      ]);
      expect(stateModule.state.messages[2]).toBe(recoveredChild);
    } finally {
      dispose();
    }
  });

  it('orders a grandchild recovered before its child when the parent snapshot arrives', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const parentSnapshot = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const grandchildMessage = userEntry('grandchild-message', 'grandchild-1');
    const childMessages = [
      userEntry('child-before', 'child-1'),
      taskAnchorEntry('grandchild-1', 'child-1', 'child-task', 'child-before'),
      userEntry('child-after', 'child-1'),
    ];
    clientMocks.sessionGet.mockImplementation(async (id) => {
      if (id === 'child-1') {
        return { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } };
      }
      if (id === 'grandchild-1') {
        return {
          ...session('grandchild-1'),
          parentID: 'child-1',
          time: { created: 3, updated: 3 },
        };
      }
      return session(String(id));
    });
    clientMocks.sessionMessages.mockImplementation(async (id) => {
      if (id === 'session-1') return parentSnapshot.promise;
      if (id === 'grandchild-1') return [grandchildMessage];
      return childMessages;
    });

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
        {
          ...session('grandchild-1'),
          parentID: 'child-1',
          time: { created: 3, updated: 3 },
        },
      ]);
      const selection = hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(stateModule.state.activeSessionId).toBe('session-1'));

      handlers.get('session.idle')?.({ properties: { sessionID: 'grandchild-1' } });
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
          'grandchild-message',
        ]);
      });
      const recoveredGrandchild = stateModule.state.messages[0];

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
          'grandchild-message',
          'child-before',
          'child-task',
          'child-after',
        ]);
      });
      const recoveredChild = stateModule.state.messages.slice(1);

      parentSnapshot.resolve([
        userEntry('parent-before'),
        taskAnchorEntry('child-1'),
        userEntry('parent-after'),
      ]);
      await selection;

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'parent-before',
        'parent-task',
        'child-before',
        'child-task',
        'grandchild-message',
        'child-after',
        'parent-after',
      ]);
      expect(stateModule.state.messages[2]).toBe(recoveredChild[0]);
      expect(stateModule.state.messages[3]).toBe(recoveredChild[1]);
      expect(stateModule.state.messages[4]).toBe(recoveredGrandchild);
      expect(stateModule.state.messages[5]).toBe(recoveredChild[2]);
    } finally {
      dispose();
    }
  });

  it('rejects a stale child snapshot after a newer child mutation', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const childSnapshot = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    clientMocks.sessionGet.mockImplementation(async (id) =>
      id === 'child-1'
        ? { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } }
        : session(String(id))
    );
    clientMocks.sessionMessages.mockReturnValue(childSnapshot.promise);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      const childInfo = assistantMessage('child-assistant', 'child-user');
      childInfo.sessionID = 'child-1';
      const initialPart: Part = {
        id: 'child-text',
        sessionID: 'child-1',
        messageID: 'child-assistant',
        type: 'text',
        text: 'Initial',
      };
      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        taskAnchorEntry('child-1'),
        { info: childInfo, parts: [initialPart] },
      ]);
      stateModule.setState('streamingPartId', 'child-text');
      stateModule.setState('streamingText', 'Live child text');

      handlers.get('message.part.updated')?.({
        properties: {
          part: {
            id: 'missing-child-part',
            sessionID: 'child-1',
            messageID: 'missing-child-message',
            type: 'text',
            text: 'Starts child recovery',
          },
        },
      });
      await vi.waitFor(() =>
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('child-1', {
          limit: 200,
          directory: '/repo',
        })
      );
      handlers.get('message.updated')?.({
        properties: {
          info: { ...childInfo, cost: 1 },
        },
      });
      childSnapshot.resolve([
        { info: childInfo, parts: [{ ...initialPart, text: 'Stale child text' }] },
      ]);

      await vi.waitFor(() => {
        const child = stateModule.state.messages.find(
          (entry) => entry.info.id === 'child-assistant'
        );
        expect(child?.info).toMatchObject({ cost: 1 });
        expect(child?.parts[0]).toMatchObject({ text: 'Initial' });
      });
      expect(stateModule.state.streamingPartId).toBe('child-text');
      expect(stateModule.state.streamingText).toBe('Live child text');
    } finally {
      dispose();
    }
  });

  it('does not reintroduce a removed message from an in-flight older page', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const stalePage = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    let latestLoads = 0;
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (options?.before) return stalePage.promise;
      latestLoads += 1;
      return latestLoads === 1
        ? [userEntry('message-2'), userEntry('message-3')]
        : [userEntry('message-3')];
    });

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('message.removed')).toBe(true));
      await hookModule.selectSession('session-1');
      messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');

      const pageLoad = hookModule.loadOlderSessionHistoryPage('session-1');
      await vi.waitFor(() => {
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-older',
          directory: '/repo',
        });
      });
      handlers.get('message.removed')?.({
        properties: { sessionID: 'session-1', messageID: 'message-2' },
      });
      stalePage.resolve([userEntry('message-1'), userEntry('message-2')]);

      await pageLoad;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-3']);
    } finally {
      dispose();
    }
  });

  it('keeps a newer selection load when an inactive sync resolves late', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    const staleBackground = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    // SAFETY: The test installs the typed mock implementation before this statement.
    const freshSelection = [userEntry('session-b-fresh', 'session-b')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    freshSelection.nextCursor = 'cursor-fresh';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const staleMessages = [
      userEntry('session-b-stale-1', 'session-b'),
      userEntry('session-b-stale-2', 'session-b'),
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    staleMessages.nextCursor = 'cursor-stale';
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages
      .mockReturnValueOnce(staleBackground.promise)
      .mockResolvedValueOnce(freshSelection);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      stateModule.setState('sessions', [session('session-a'), session('session-b')]);
      stateModule.setState('activeSessionId', 'session-a');
      stateModule.setState('messages', [userEntry('session-a-message', 'session-a')]);

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-b', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));

      await hookModule.selectSession('session-b');
      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['session-b-fresh']);
      staleBackground.resolve(staleMessages);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['session-b-fresh']);
      expect(stateModule.state.sessionMessageCounts['session-b']).toBe(1);
      expect(messageWindow.getSessionHistoryCursor('session-b')).toBe('cursor-fresh');
    } finally {
      dispose();
    }
  });

  it('clears every old history store after empty and disjoint resyncs', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages
      .mockResolvedValueOnce([userEntry('message-old')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([userEntry('message-new')]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    const seedOldHistory = (suffix: string) => {
      messageWindow.setSessionHistoryCursor('session-1', `history-${suffix}`);
      messageWindow.setSessionHistoryPromptCursor('session-1', `prompt-${suffix}`);
      messageWindow.setSessionHistoryPrompts('session-1', [userEntry(`old-prompt-${suffix}`)]);
      messageWindow.cacheSessionHistoryPage('session-1', `page-${suffix}`, [
        userEntry(`old-page-${suffix}`),
      ]);
    };

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      await hookModule.selectSession('session-1');
      seedOldHistory('empty');

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => expect(stateModule.state.messages).toEqual([]));
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPromptCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPrompts('session-1')).toEqual([]);
      expect(messageWindow.takeCachedSessionHistoryPage('session-1', 'page-empty')).toBeUndefined();

      stateModule.setState('messages', [userEntry('message-old-again')]);
      seedOldHistory('disjoint');
      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-new']);
      });
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPromptCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPrompts('session-1')).toEqual([]);
      expect(
        messageWindow.takeCachedSessionHistoryPage('session-1', 'page-disjoint')
      ).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it('continues full-history loading through an empty continuation page', async () => {
    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    // SAFETY: The test installs the typed mock implementation before this statement.
    const emptyPage = [] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    emptyPage.nextCursor = 'cursor-b';
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (options?.before === 'cursor-a') return emptyPage;
      if (options?.before === 'cursor-b') return [userEntry('message-1')];
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('messages', [userEntry('message-3')]);
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-a');

    await hookModule.loadFullSessionHistory('session-1');

    expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-b',
    });
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'message-1',
      'message-3',
    ]);
    expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
  });

  it('terminates a cursor cycle across separate one-page history loads', async () => {
    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    // SAFETY: The test installs the typed mock implementation before this statement.
    const pageA = [userEntry('message-2')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    pageA.nextCursor = 'cursor-b';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const pageB = [
      {
        info: userMessage('message-1'),
        parts: [
          {
            id: 'message-1-text',
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'text' as const,
            text: 'Previewable history prompt',
          },
        ],
      },
    ] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    pageB.nextCursor = 'cursor-a';
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (options?.before === 'cursor-a') return pageA;
      if (options?.before === 'cursor-b') return pageB;
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('messages', [userEntry('message-3')]);
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-a');

    await hookModule.loadOlderSessionHistoryPage('session-1');
    await hookModule.loadOlderSessionHistoryPage('session-1');

    expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('terminates a prompt cursor cycle across separate history requests', async () => {
    const { hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    // SAFETY: The test installs the typed mock implementation before this statement.
    const pageA = [userEntry('prompt-a')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    pageA.nextCursor = 'cursor-b';
    // SAFETY: The test installs the typed mock implementation before this statement.
    const pageB = [userEntry('prompt-b')] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    pageB.nextCursor = 'cursor-a';
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (options?.before === 'cursor-a') return pageA;
      if (options?.before === 'cursor-b') return pageB;
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    messageWindow.setSessionHistoryPromptCursor('session-1', 'cursor-a');

    await hookModule.loadOlderSessionPrompts('session-1');
    await hookModule.loadOlderSessionPrompts('session-1');

    expect(messageWindow.getSessionHistoryPromptCursor('session-1')).toBeUndefined();
    expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('canonically resyncs and resets history after a committed revert', async () => {
    const handlers = installServerEventHandlers();
    mockRuntimeBootstrap();
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockResolvedValue([userEntry('message-kept')]);

    const { stateModule, hookModule } = await loadModules();
    const messageWindow = await import('../lib/message-window');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await vi.waitFor(() => expect(handlers.has('session.next.revert.committed')).toBe(true));
      stateModule.setState('sessions', [session('session-1')]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [userEntry('message-kept'), userEntry('message-reverted')]);
      messageWindow.setSessionHistoryCursor('session-1', 'cursor-old');
      messageWindow.setSessionHistoryPrompts('session-1', [userEntry('prompt-old')]);
      messageWindow.cacheSessionHistoryPage('session-1', 'page-old', [
        userEntry('message-reverted'),
      ]);

      handlers.get('session.next.revert.committed')?.({
        properties: { sessionID: 'session-1', messageID: 'message-reverted' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-kept']);
      });
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPrompts('session-1')).toEqual([]);
      expect(messageWindow.takeCachedSessionHistoryPage('session-1', 'page-old')).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
