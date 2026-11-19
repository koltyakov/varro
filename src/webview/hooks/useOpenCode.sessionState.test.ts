import { flush as flushSolid, createEffect, createRoot } from 'solid-js';
import { storePath } from '@solidjs/signals';
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
  it('follows an active worktree chat back to the project without reopening it manually', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    mockRuntimeBootstrap();
    const moved = {
      ...session(),
      version: '2',
      directory: '/worktrees/feature',
      transfer: { originDirectory: '/repo', available: true },
    };
    const returned = { ...moved, directory: '/repo' };
    const messages = [userEntry('retained-prompt')];
    clientMocks.sessionList.mockResolvedValue([moved]);
    clientMocks.sessionActivate.mockResolvedValue(moved);
    clientMocks.sessionGet.mockResolvedValue(moved);
    clientMocks.sessionMessages.mockResolvedValue(messages);
    // SAFETY: The fixture supplies the project's context, not the worktree execution directory.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo',
        workspaceFolders: [{ name: 'Repo', path: '/repo' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();
    try {
      stateModule.setState(storePath('sessions', [moved]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', moved.id));
      flushSolid();
      stateModule.setState(storePath('messages', messages));
      flushSolid();
      expect(stateModule.state.activeSessionId).toBe(moved.id);
      expect(stateModule.state.sessions.find((entry) => entry.id === moved.id)?.directory).toBe(
        moved.directory
      );
      stateModule.setInputText('Keep this draft');
      flushSolid();
      clientMocks.sessionGet.mockClear().mockImplementation(async (_id, options) => {
        if (options?.directory !== '/repo') throw new Error('404 Session not found');
        return returned;
      });
      clientMocks.sessionMessages.mockClear().mockImplementation(async (_id, options) => {
        if (options?.directory !== '/repo') throw new Error('404 Session not found');
        return messages;
      });
      clientMocks.sessionList.mockResolvedValue([returned]);
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler({
        type: 'session/transferred',
        payload: { sessionId: moved.id, directory: '/repo', available: true },
      });
      flushSolid();
      await vi.waitFor(() => {
        flushSolid();
        expect(stateModule.state.messagesLoading).toBe(false);
        expect(clientMocks.sessionGet).toHaveBeenCalledWith(moved.id, { directory: '/repo' });
      });
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith(
        moved.id,
        expect.objectContaining({ directory: '/repo' })
      );
      expect(stateModule.error()).toBeNull();
      expect(stateModule.state.activeSessionId).toBe(moved.id);
      expect(stateModule.state.messages).toEqual(messages);
      expect(stateModule.inputText()).toBe('Keep this draft');
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('keeps an active chat moved to a closed worktree read-only', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    mockRuntimeBootstrap();
    const current = { ...session(), version: '2', directory: '/repo' };
    const moved = {
      ...current,
      directory: '/worktrees/feature',
      transfer: { originDirectory: '/repo', available: false },
    };
    const messages = [userEntry('retained-prompt')];
    clientMocks.sessionList.mockResolvedValue([current]);
    clientMocks.sessionGet.mockResolvedValue(moved);
    clientMocks.sessionMessages.mockResolvedValue(messages);
    // SAFETY: The fixture supplies the project's context; the worktree is not open in any window.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo',
        workspaceFolders: [{ name: 'Repo', path: '/repo' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();
    try {
      stateModule.setState(storePath('sessions', [current]));
      stateModule.setState(storePath('activeSessionId', current.id));
      stateModule.setState(storePath('messages', messages));
      flushSolid();
      clientMocks.sessionActivate.mockClear();
      clientMocks.sessionList.mockResolvedValue([moved]);
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler({
        type: 'session/transferred',
        payload: { sessionId: current.id, directory: '/worktrees/feature', available: false },
      });
      flushSolid();
      await vi.waitFor(() => {
        flushSolid();
        expect(stateModule.state.messagesLoading).toBe(false);
        expect(clientMocks.sessionGet).toHaveBeenCalledWith(current.id, {
          directory: '/worktrees/feature',
        });
      });
      expect(clientMocks.sessionActivate).not.toHaveBeenCalled();
      expect(stateModule.state.activeSessionId).toBe(current.id);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('reopens a persisted transferred session read-only without activating its closed folder', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const moved = {
      ...session('moved'),
      directory: '/outside',
      transfer: { originDirectory: '/repo', available: false },
    };
    stateModule.setState(storePath('sessions', [moved]));
    flushSolid();
    clientMocks.sessionGet.mockResolvedValue(moved);
    clientMocks.sessionMessages.mockResolvedValue([userEntry('old-prompt', 'moved')]);
    await hookModule.selectSession('moved', { directory: '/outside' });
    flushSolid();
    expect(clientMocks.sessionActivate).not.toHaveBeenCalled();
    expect(stateModule.state.activeSessionId).toBe('moved');
    expect(stateModule.state.messages[0]?.info.id).toBe('old-prompt');
  });
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      stateModule.setShowSessionPicker(true);
      flushSolid();

      bridgeHandler({
        type: 'command/open-session',
        payload: { sessionId: 'session-1' },
      });
      flushSolid();

      expect(stateModule.showSessionPicker()).toBe(false);
      expect(stateModule.state.activeSessionId).toBe('session-1');
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      stateModule.setState(storePath('sessions', [siblingSession]));
      flushSolid();

      await hookModule.selectSession('session-b', { directory: '/repo-b' });
      flushSolid();

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
      flushSolid();
    }
  });

  it('keeps a new-chat draft when a pending cross-root activation finishes', async () => {
    mockRuntimeBootstrap();
    const siblingSession = { ...session('session-b'), directory: '/repo-b' };
    const activation = deferred<typeof siblingSession>();
    clientMocks.sessionActivate.mockReturnValue(activation.promise);
    clientMocks.sessionGet.mockResolvedValue(siblingSession);
    clientMocks.sessionMessages.mockResolvedValue([userEntry('message-b', 'session-b')]);
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
    flushSolid();
    const { startNewChatDraft } = await import('../lib/new-chat-draft');
    flushSolid();
    stateModule.setState(storePath('sessions', [siblingSession]));
    flushSolid();

    const selection = hookModule.selectSession('session-b', { directory: '/repo-b' });
    await vi.waitFor(() => expect(clientMocks.sessionActivate).toHaveBeenCalledOnce());
    flushSolid();

    expect(stateModule.state.pendingSessionSelectionId).toBe('session-b');
    expect(stateModule.state.messagesLoading).toBe(true);

    startNewChatDraft();
    flushSolid();
    expect(stateModule.state.pendingSessionSelectionId).toBeNull();
    activation.resolve(siblingSession);
    flushSolid();
    await selection;
    flushSolid();

    expect(stateModule.state.activeSessionId).toBeNull();
    expect(stateModule.state.messages).toEqual([]);
    expect(clientMocks.sessionGet).not.toHaveBeenCalled();
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
    flushSolid();
    stateModule.setState(storePath('sessions', [siblingSession]));
    flushSolid();

    await hookModule.selectSession('session-b', {
      directory: '/repo-b',
      reportActivationError: false,
    });
    flushSolid();

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
    flushSolid();
    stateModule.setState(storePath('sessions', [localSession]));
    flushSolid();

    await hookModule.selectSession('session-a', { directory: '/repo-a' });
    flushSolid();

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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      stateModule.setState(storePath('sessions', [siblingSession]));
      flushSolid();
      await hookModule.selectSession('session-b', { directory: '/repo-b' });
      flushSolid();
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
      flushSolid();

      expect(stateModule.state.activeSessionId).toBe('session-b');
      expect(stateModule.state.messages).toEqual([siblingMessage]);
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096', eventStream: 'degraded' },
      });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(stateModule.state.serverStatus).toMatchObject({
        state: 'running',
        eventStream: 'degraded',
      });
      expect(clientMocks.health).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await Promise.resolve();
      flushSolid();
      const settledAssistant = assistantMessage('assistant-1', 'user-1');
      if (settledAssistant.role !== 'assistant') {
        throw new Error('Expected an assistant message fixture');
      }
      settledAssistant.time.completed = 1;

      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('messages', [
          { info: userMessage('user-1'), parts: [] },
          {
            info: settledAssistant,
            parts: [],
          },
        ])
      );
      flushSolid();

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
      flushSolid();

      await vi.waitFor(() => {
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('session-1', {
          directory: undefined,
        });
      });
      flushSolid();

      expect(clientMocks.sessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await Promise.resolve();
      flushSolid();
      stateModule.setState(storePath('sessions', [{ ...session('session-1'), title: 'New Chat' }]));
      flushSolid();

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
      flushSolid();

      await vi.waitFor(() => {
        expect(stateModule.state.sessions[0]?.title).toBe('Test Message');
      });
      flushSolid();
      expect(clientMocks.varroSessionRenameIfUntitled).toHaveBeenCalledWith('session-1', {
        directory: '/repo',
      });
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('lastSeenSessions', { 'session-1': 1_000 }));
      flushSolid();

      handlers.get('session.updated')?.({
        properties: {
          info: {
            ...session('session-1'),
            time: { created: 0, updated: 2_000 },
          },
        },
      });
      flushSolid();

      expect(stateModule.state.lastSeenSessions['session-1']).toBe(2_000);
      expect(stateModule.isSessionUnread('session-1', 2_000)).toBe(false);
    } finally {
      nowSpy.mockRestore();
      dispose();
      flushSolid();
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
    flushSolid();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('lastSeenSessions', { 'session-1': 1_000 }));
      flushSolid();
      stateModule.setState(storePath('completedSessionResponses', { 'session-1': 1_500 }));
      flushSolid();
      stateModule.setShowSessionPicker(true);
      flushSolid();

      handlers.get('session.updated')?.({
        properties: {
          info: {
            ...session('session-1'),
            time: { created: 0, updated: 2_000 },
          },
        },
      });
      flushSolid();

      expect(stateModule.state.lastSeenSessions['session-1']).toBe(1_000);
      expect(stateModule.isSessionCompletedResponseUnread('session-1')).toBe(true);
    } finally {
      nowSpy.mockRestore();
      dispose();
      flushSolid();
    }
  });

  it('ignores stale session selection results after switching sessions quickly', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();

    const slowSession = Promise.resolve({ ...session('session-1'), title: 'Slow session' });
    flushSolid();
    const fastSession = Promise.resolve({ ...session('session-2'), title: 'Fast session' });
    flushSolid();
    const slowMessages = Promise.resolve([userEntry('user-1', 'session-1')]);
    flushSolid();
    const fastMessages = Promise.resolve([userEntry('user-2', 'session-2')]);
    flushSolid();

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
    flushSolid();

    expect(stateModule.state.activeSessionId).toBe('session-2');
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['user-2']);
  });

  it('loads older session messages through cursor pages', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
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
    flushSolid();
    await hookModule.loadFullSessionHistory('session-1');
    flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();
    await hookModule.loadFullSessionHistory('session-1');
    flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();

    await expect(hookModule.loadOlderSessionHistoryPage('session-1')).resolves.toBe(true);
    flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();
    clientMocks.sessionMessages.mockReturnValueOnce(olderPage.promise);

    const load = hookModule.loadOlderSessionHistoryPage('session-1');
    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenLastCalledWith('session-1', {
        limit: 200,
        before: 'cursor-older',
        directory: '/repo',
      });
    });
    flushSolid();
    stateModule.upsertMessage({ info: userMessage('user-4'), parts: [] });
    flushSolid();

    olderPage.resolve([
      { info: userMessage('user-1'), parts: [] },
      { info: userMessage('user-2'), parts: [] },
    ]);
    flushSolid();

    await expect(load).resolves.toBe(true);
    flushSolid();
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
      'user-4',
    ]);
  });

  it('preserves child-session messages and streaming state while loading older parent history', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
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
    stateModule.setState(
      storePath('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1' },
      ])
    );
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(
      storePath('messages', [userEntry('parent-latest'), { info: childInfo, parts: [childPart] }])
    );
    flushSolid();
    stateModule.setState(storePath('streamingPartId', childPart.id));
    flushSolid();
    stateModule.setState(storePath('streamingText', 'Child response in progress'));
    flushSolid();
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();

    await hookModule.loadOlderSessionHistoryPage('session-1');
    flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    const childBefore = userEntry('child-before', 'child-1');
    const parentCurrent = userEntry('parent-current');
    const childAfter = userEntry('child-after', 'child-1');
    clientMocks.sessionMessages.mockResolvedValue([userEntry('parent-older')]);
    stateModule.setState(
      storePath('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1' },
      ])
    );
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('messages', [childBefore, parentCurrent, childAfter]));
    flushSolid();
    const retained = new Map(
      stateModule.state.messages.map((entry) => [entry.info.id, entry] as const)
    );
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();

    await hookModule.loadOlderSessionHistoryPage('session-1');
    flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
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
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('messages', [{ info: currentInfo, parts: [currentPart] }]));
    flushSolid();
    stateModule.setState(storePath('streamingPartId', currentPart.id));
    flushSolid();
    stateModule.setState(storePath('streamingText', 'Parent response in progress'));
    flushSolid();
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();

    const observedStreamingState: Array<[string | null, string]> = [];
    const dispose = createRoot((cleanup) => {
      createEffect(
        (): [string | null, string] => [
          stateModule.state.streamingPartId,
          stateModule.state.streamingText,
        ],
        (state) => {
          observedStreamingState.push(state);
        }
      );
      return cleanup;
    });
    flushSolid();

    try {
      await hookModule.loadOlderSessionHistoryPage('session-1');
      flushSolid();
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setState(storePath('messages', [{ info, parts: [stalePart] }]));
    flushSolid();
    stateModule.setState(storePath('streamingPartId', stalePart.id));
    flushSolid();
    stateModule.setState(storePath('streamingText', 'Partial answer from the live SSE stream'));
    flushSolid();

    await hookModule.recheckSessionStatus('session-1');
    flushSolid();

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
      flushSolid();
      const messageWindow = await import('../lib/message-window');
      flushSolid();
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
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('messages', [{ info: currentInfo, parts: [currentPart] }]));
      flushSolid();
      stateModule.setState(storePath('streamingPartId', currentPart.id));
      flushSolid();
      stateModule.setState(storePath('streamingText', 'Parent response'));
      flushSolid();
      stateModule.applyMessagePartDelta(
        currentInfo.id,
        currentPart.id,
        ' in progress',
        'session-1'
      );
      flushSolid();
      messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
      flushSolid();

      await hookModule.loadOlderSessionHistoryPage('session-1');
      flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-a');
    flushSolid();
    const staleLoad = hookModule.loadOlderSessionHistoryPage('session-a');
    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-a', {
        limit: 200,
        before: 'cursor-stale',
      });
    });
    flushSolid();

    await hookModule.selectSession('session-b');
    flushSolid();
    await hookModule.selectSession('session-a');
    flushSolid();
    stalePage.resolve(staleOlderA);
    flushSolid();

    await expect(staleLoad).resolves.toBe(false);
    flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-a');
    flushSolid();
    await expect(hookModule.loadOlderSessionHistoryPage('session-a')).resolves.toBe(true);
    flushSolid();
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-a-1',
      'user-a-2',
      'user-a-3',
    ]);
    expect(messageWindow.getSessionHistoryCursor('session-a')).toBeUndefined();

    await hookModule.selectSession('session-b');
    flushSolid();
    await hookModule.selectSession('session-a');
    flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
        limit: 200,
        before: 'cursor-1',
      });
      expect(
        messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
      ).toEqual(['user-1']);
    });
    flushSolid();

    await expect(hookModule.loadOlderSessionHistoryPage('session-1')).resolves.toBe(true);
    flushSolid();
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
    flushSolid();
  });

  it.each(['assistant', 'steer', 'inferred-steer', 'notice', 'followup'] as const)(
    'finds the original prompt beyond full %s history pages without loading transcript rows',
    async (kind) => {
      const latest: MessageEntry[] & { nextCursor?: string } = Array.from(
        { length: 200 },
        (_, index) => ({ info: assistantMessage(`latest-${index}`, 'user-root'), parts: [] })
      );
      latest.nextCursor = 'cursor-middle';
      const middle: MessageEntry[] & { nextCursor?: string } = Array.from(
        { length: 200 },
        (_, index) => ({ info: assistantMessage(`middle-${index}`, 'user-root'), parts: [] })
      );
      if (kind !== 'assistant') {
        const info = userMessage('intervening-user');
        if (info.role === 'user' && kind === 'steer') info.delivery = 'steer';
        if (info.role === 'user' && kind === 'followup') {
          info.followupTitle = 'Investigate the stall';
          info.time.created = 2;
          const previous = middle[99]!.info;
          if (previous.role === 'assistant') {
            previous.time.completed = 1;
            previous.finish = 'stop';
          }
        }
        middle[100] = {
          info,
          parts: [
            {
              id: 'intervening-text',
              sessionID: 'session-1',
              messageID: 'intervening-user',
              type: 'text',
              text:
                kind === 'notice' ? 'Background command completed' : 'An additional instruction',
              synthetic: kind === 'notice',
            },
          ],
        };
      }
      middle.nextCursor = 'cursor-root';
      const root: MessageEntry = {
        info: userMessage('user-root'),
        parts: [
          {
            id: 'root-text',
            sessionID: 'session-1',
            messageID: 'user-root',
            type: 'text',
            text: 'The original long-running request',
          },
        ],
      };
      clientMocks.sessionGet.mockResolvedValue(session('session-1'));
      clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
        if (!options?.before) return latest;
        if (options.before === 'cursor-middle') return middle;
        if (options.before === 'cursor-root') return [root];
        throw new Error(`Unexpected cursor ${options.before}`);
      });
      clientMocks.sessionStatus.mockResolvedValue({});
      clientMocks.questionList.mockResolvedValue([]);

      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      const messageWindow = await import('../lib/message-window');
      flushSolid();
      await hookModule.selectSession('session-1');
      flushSolid();

      await vi.waitFor(() => {
        expect(messageWindow.getSessionHistoryPrompts('session-1')).toContainEqual(root);
      });
      flushSolid();
      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(
        latest.map((entry) => entry.info.id)
      );
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBe('cursor-middle');
      expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(3);
    }
  );

  it('restarts boundary prefetch after an active message invalidates its revision', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('message.updated')).toBe(true));
      flushSolid();
      await hookModule.selectSession('session-1');
      flushSolid();
      await vi.waitFor(() => expect(boundaryLoads).toBe(1));
      flushSolid();

      handlers.get('message.updated')?.({ properties: { info: completedAssistant } });
      flushSolid();

      await vi.waitFor(() => {
        expect(latestLoads).toBeGreaterThanOrEqual(2);
        expect(boundaryLoads).toBe(2);
        expect(
          messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
        ).toEqual(['user-1']);
      });
      flushSolid();
    } finally {
      staleBoundary.resolve(boundary);
      flushSolid();
      await staleBoundary.promise;
      flushSolid();
      dispose();
      flushSolid();
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
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();
    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-a',
        directory: undefined,
      });
    });
    flushSolid();

    const pageLoad = hookModule.loadOlderSessionHistoryPage('session-1');
    try {
      firstPromptPage.resolve(olderPage);
      flushSolid();
      await vi.waitFor(() => {
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-b',
          directory: '/repo',
        });
      });
      flushSolid();
      await expect(pageLoad).resolves.toBe(true);
      flushSolid();
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
      flushSolid();
      await laterPromptPage.promise;
      flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-valid',
      });
    });
    flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-valid',
      });
    });
    flushSolid();
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
    flushSolid();
    await hookModule.selectSession('session-1');
    flushSolid();

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-older',
      });
    });
    flushSolid();
  });

  it('preserves append and removal events that beat a stale latest response', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    const staleLatest = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const canonical = [userEntry('message-1'), userEntry('message-3')];
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages
      .mockReturnValueOnce(staleLatest.promise)
      .mockResolvedValueOnce(canonical);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('messages', [userEntry('message-1'), userEntry('message-2')]));
      flushSolid();

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      flushSolid();

      handlers.get('message.updated')?.({ properties: { info: userMessage('message-3') } });
      flushSolid();
      handlers.get('message.removed')?.({
        properties: { sessionID: 'session-1', messageID: 'message-2' },
      });
      flushSolid();
      staleLatest.resolve([userEntry('message-1'), userEntry('message-2')]);
      flushSolid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      flushSolid();

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'message-1',
        'message-3',
      ]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('preserves an append without relying on a later removal invalidation', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    const staleLatest = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockReturnValueOnce(staleLatest.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('messages', [userEntry('message-1'), userEntry('message-2')]));
      flushSolid();

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      flushSolid();
      handlers.get('message.updated')?.({ properties: { info: userMessage('message-3') } });
      flushSolid();

      staleLatest.resolve([userEntry('message-1'), userEntry('message-2')]);
      flushSolid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      flushSolid();

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
      ]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('preserves a same-part SSE update that beats a stale latest response', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('messages', [staleEntry]));
      flushSolid();

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      flushSolid();
      handlers.get('message.part.updated')?.({
        properties: {
          part: {
            ...staleEntry.parts[0],
            text: 'new',
          },
        },
      });
      flushSolid();
      staleLatest.resolve([staleEntry]);
      flushSolid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      flushSolid();

      expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({ text: 'new' });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('hydrates a selected busy session when an unprojectable stream event races the initial snapshot', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.next.text.delta')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      const selection = hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      flushSolid();

      handlers.get('session.next.text.delta')?.({
        properties: {
          sessionID: 'session-1',
          assistantMessageID: 'assistant-1',
          textID: 'text-1',
          delta: 'streaming response',
        },
      });
      flushSolid();
      handlers.get('session.next.reasoning.delta')?.({
        properties: {
          sessionID: 'session-1',
          assistantMessageID: 'assistant-1',
          reasoningID: 'reasoning-1',
          delta: 'thinking',
        },
      });
      flushSolid();
      handlers.get('message.part.delta')?.({
        properties: {
          sessionID: 'session-1',
          messageID: 'assistant-1',
          partID: 'text-1',
          field: 'text',
          delta: 'streaming response',
        },
      });
      flushSolid();
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
      flushSolid();
      handlers.get('message.updated')?.({
        properties: {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
          },
        },
      });
      flushSolid();
      initialSnapshot.resolve(canonical);
      flushSolid();
      await selection;
      flushSolid();

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'user-1',
        'assistant-1',
      ]);
      expect(stateModule.state.messagesLoading).toBe(false);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('preserves child-session messages during active-parent latest-message resync', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    const parentMessage = userEntry('parent-message');
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockResolvedValue([parentMessage]);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1' },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('messages', [parentMessage, userEntry('child-message', 'child-1')])
      );
      flushSolid();

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      flushSolid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      flushSolid();

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'parent-message',
        'child-message',
      ]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('reconciles repeated native child result events through history without selecting the child or duplicating results', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    const parent = session('session-1');
    const child = { ...session('native-child'), parentID: parent.id };
    const result: MessageEntry = {
      info: { ...userMessage('native-result'), time: { created: 3 } },
      parts: [
        {
          id: 'native-result:content:0',
          messageID: 'native-result',
          sessionID: parent.id,
          type: 'text',
          synthetic: true,
          text: '<subagent sessionID="native-child">\nAudit complete\n</subagent>',
          subagentResult: { sessionID: child.id, state: 'completed', description: 'Audit auth' },
        },
      ],
    };
    clientMocks.sessionGet.mockImplementation(async (id) => (id === child.id ? child : parent));
    clientMocks.sessionMessages.mockResolvedValue([result]);
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();
    try {
      await vi.waitFor(() => expect(handlers.has('session.next.synthetic')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [parent]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', parent.id));
      flushSolid();
      stateModule.setState(storePath('selectedAgent', 'build'));
      flushSolid();
      stateModule.setState(
        storePath('selectedModel', { providerID: 'fixture', modelID: 'parent-model' })
      );
      flushSolid();
      handlers.get('session.created')?.({ properties: { info: child } });
      flushSolid();
      handlers.get('session.next.synthetic')?.({ properties: { sessionID: parent.id } });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['native-result'])
      );
      flushSolid();
      const retained = stateModule.state.messages[0];
      handlers.get('session.next.synthetic')?.({ properties: { sessionID: parent.id } });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(2));
      flushSolid();
      expect(stateModule.state.messages).toHaveLength(1);
      expect(stateModule.state.messages[0]).toBe(retained);
      expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({
        subagentResult: { sessionID: child.id, state: 'completed' },
      });
      expect(stateModule.state.sessions.find((entry) => entry.id === child.id)?.parentID).toBe(
        parent.id
      );
      expect(stateModule.state.activeSessionId).toBe(parent.id);
      expect(stateModule.state.selectedAgent).toBe('build');
      expect(stateModule.state.selectedModel).toEqual({
        providerID: 'fixture',
        modelID: 'parent-model',
      });
      expect(clientMocks.sessionCommand).not.toHaveBeenCalled();
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('inserts a child idle sync after its parent task anchor', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    const childMessage = userEntry('child-message', 'child-1');
    clientMocks.sessionGet.mockImplementation(async (id) =>
      id === 'child-1'
        ? { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } }
        : session(String(id))
    );
    clientMocks.sessionMessages.mockResolvedValue([childMessage]);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      const parentAnchor = taskAnchorEntry('child-1');
      parentAnchor.parts.push({
        id: 'parent-stream',
        sessionID: 'session-1',
        messageID: 'parent-task',
        type: 'text',
        text: '',
      });
      stateModule.setState(
        storePath('messages', [userEntry('parent-before'), parentAnchor, userEntry('parent-after')])
      );
      flushSolid();
      stateModule.setState(storePath('streamingPartId', 'parent-stream'));
      flushSolid();
      stateModule.setState(storePath('streamingText', 'Parent still streaming'));
      flushSolid();

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });
      flushSolid();

      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
          'parent-before',
          'parent-task',
          'child-message',
          'parent-after',
        ]);
      });
      flushSolid();
      expect(stateModule.state.streamingPartId).toBe('parent-stream');
      expect(stateModule.state.streamingText).toBe('Parent still streaming');
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('clears child streaming state when the child snapshot completes that stream', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 4 } },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('messages', [
          taskAnchorEntry('child-1'),
          {
            info: { ...childInfo, time: { created: 2 } },
            parts: [{ ...childPart, text: '' }],
          },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('streamingPartId', childPart.id));
      flushSolid();
      stateModule.setState(storePath('streamingText', 'Stale child stream'));
      flushSolid();

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });
      flushSolid();

      await vi.waitFor(() => {
        expect(stateModule.state.streamingPartId).toBeNull();
        expect(stateModule.state.streamingText).toBe('');
        const child = stateModule.state.messages.find((entry) => entry.info.id === childInfo.id);
        expect(child?.parts[0]).toMatchObject({ text: 'Final child response' });
      });
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('reorders an early child recovery after its anchor when the parent snapshot arrives', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
        ])
      );
      flushSolid();
      const selection = hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(stateModule.state.activeSessionId).toBe('session-1'));
      flushSolid();

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });
      flushSolid();
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['child-message']);
      });
      flushSolid();
      const recoveredChild = stateModule.state.messages[0];

      parentSnapshot.resolve([
        userEntry('parent-before'),
        taskAnchorEntry('child-1'),
        userEntry('parent-after'),
      ]);
      flushSolid();
      await selection;
      flushSolid();

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
        'parent-before',
        'parent-task',
        'child-message',
        'parent-after',
      ]);
      expect(stateModule.state.messages[2]).toBe(recoveredChild);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('orders a grandchild recovered before its child when the parent snapshot arrives', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
          {
            ...session('grandchild-1'),
            parentID: 'child-1',
            time: { created: 3, updated: 3 },
          },
        ])
      );
      flushSolid();
      const selection = hookModule.selectSession('session-1');
      await vi.waitFor(() => expect(stateModule.state.activeSessionId).toBe('session-1'));
      flushSolid();

      handlers.get('session.idle')?.({ properties: { sessionID: 'grandchild-1' } });
      flushSolid();
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
          'grandchild-message',
        ]);
      });
      flushSolid();
      const recoveredGrandchild = stateModule.state.messages[0];

      handlers.get('session.idle')?.({ properties: { sessionID: 'child-1' } });
      flushSolid();
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
          'grandchild-message',
          'child-before',
          'child-task',
          'child-after',
        ]);
      });
      flushSolid();
      const recoveredChild = stateModule.state.messages.slice(1);

      parentSnapshot.resolve([
        userEntry('parent-before'),
        taskAnchorEntry('child-1'),
        userEntry('parent-after'),
      ]);
      flushSolid();
      await selection;
      flushSolid();

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
      flushSolid();
    }
  });

  it('rejects a stale child snapshot after a newer child mutation', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    const childSnapshot = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    clientMocks.sessionGet.mockImplementation(async (id) =>
      id === 'child-1'
        ? { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } }
        : session(String(id))
    );
    clientMocks.sessionMessages.mockReturnValue(childSnapshot.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.idle')).toBe(true));
      flushSolid();
      const childInfo = assistantMessage('child-assistant', 'child-user');
      childInfo.sessionID = 'child-1';
      const initialPart: Part = {
        id: 'child-text',
        sessionID: 'child-1',
        messageID: 'child-assistant',
        type: 'text',
        text: 'Initial',
      };
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1', time: { created: 2, updated: 2 } },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('messages', [
          taskAnchorEntry('child-1'),
          { info: childInfo, parts: [initialPart] },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('streamingPartId', 'child-text'));
      flushSolid();
      stateModule.setState(storePath('streamingText', 'Live child text'));
      flushSolid();

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
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('child-1', {
          limit: 200,
          directory: '/repo',
        })
      );
      flushSolid();
      handlers.get('message.updated')?.({
        properties: {
          info: { ...childInfo, cost: 1 },
        },
      });
      flushSolid();
      childSnapshot.resolve([
        { info: childInfo, parts: [{ ...initialPart, text: 'Stale child text' }] },
      ]);
      flushSolid();

      await vi.waitFor(() => {
        const child = stateModule.state.messages.find(
          (entry) => entry.info.id === 'child-assistant'
        );
        expect(child?.info).toMatchObject({ cost: 1 });
        expect(child?.parts[0]).toMatchObject({ text: 'Initial' });
      });
      flushSolid();
      expect(stateModule.state.streamingPartId).toBe('child-text');
      expect(stateModule.state.streamingText).toBe('Live child text');
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('does not reintroduce a removed message from an in-flight older page', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('message.removed')).toBe(true));
      flushSolid();
      await hookModule.selectSession('session-1');
      flushSolid();
      messageWindow.setSessionHistoryCursor('session-1', 'cursor-older');
      flushSolid();

      const pageLoad = hookModule.loadOlderSessionHistoryPage('session-1');
      await vi.waitFor(() => {
        expect(clientMocks.sessionMessages).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-older',
          directory: '/repo',
        });
      });
      flushSolid();
      handlers.get('message.removed')?.({
        properties: { sessionID: 'session-1', messageID: 'message-2' },
      });
      flushSolid();
      stalePage.resolve([userEntry('message-1'), userEntry('message-2')]);
      flushSolid();

      await pageLoad;
      flushSolid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      flushSolid();
      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-3']);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('keeps a newer selection load when an inactive sync resolves late', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.error')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-a'), session('session-b')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-a'));
      flushSolid();
      stateModule.setState(storePath('messages', [userEntry('session-a-message', 'session-a')]));
      flushSolid();

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-b', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(1));
      flushSolid();

      await hookModule.selectSession('session-b');
      flushSolid();
      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['session-b-fresh']);
      staleBackground.resolve(staleMessages);
      flushSolid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      flushSolid();

      expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['session-b-fresh']);
      expect(stateModule.state.sessionMessageCounts['session-b']).toBe(1);
      expect(messageWindow.getSessionHistoryCursor('session-b')).toBe('cursor-fresh');
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('clears every old history store after empty and disjoint resyncs', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages
      .mockResolvedValueOnce([userEntry('message-old')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([userEntry('message-new')]);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();
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
      flushSolid();
      await hookModule.selectSession('session-1');
      flushSolid();
      seedOldHistory('empty');
      flushSolid();

      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => expect(stateModule.state.messages).toEqual([]));
      flushSolid();
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPromptCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPrompts('session-1')).toEqual([]);
      expect(messageWindow.takeCachedSessionHistoryPage('session-1', 'page-empty')).toBeUndefined();

      stateModule.setState(storePath('messages', [userEntry('message-old-again')]));
      flushSolid();
      seedOldHistory('disjoint');
      flushSolid();
      handlers.get('session.error')?.({
        properties: { sessionID: 'session-1', error: { name: 'UnexpectedFailure' } },
      });
      flushSolid();
      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-new']);
      });
      flushSolid();
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPromptCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPrompts('session-1')).toEqual([]);
      expect(
        messageWindow.takeCachedSessionHistoryPage('session-1', 'page-disjoint')
      ).toBeUndefined();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('continues full-history loading through an empty continuation page', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    // SAFETY: The test installs the typed mock implementation before this statement.
    const emptyPage = [] as Awaited<ReturnType<typeof clientMocks.sessionMessages>>;
    emptyPage.nextCursor = 'cursor-b';
    clientMocks.sessionMessages.mockImplementation(async (_id, options) => {
      if (options?.before === 'cursor-a') return emptyPage;
      if (options?.before === 'cursor-b') return [userEntry('message-1')];
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('messages', [userEntry('message-3')]));
    flushSolid();
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-a');
    flushSolid();

    await hookModule.loadFullSessionHistory('session-1');
    flushSolid();

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
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
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
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('messages', [userEntry('message-3')]));
    flushSolid();
    messageWindow.setSessionHistoryCursor('session-1', 'cursor-a');
    flushSolid();

    await hookModule.loadOlderSessionHistoryPage('session-1');
    flushSolid();
    await hookModule.loadOlderSessionHistoryPage('session-1');
    flushSolid();

    expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
    expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('terminates a prompt cursor cycle across separate history requests', async () => {
    const { hookModule } = await loadModules();
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
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
    flushSolid();

    await hookModule.loadOlderSessionPrompts('session-1');
    flushSolid();
    await hookModule.loadOlderSessionPrompts('session-1');
    flushSolid();

    expect(messageWindow.getSessionHistoryPromptCursor('session-1')).toBeUndefined();
    expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('canonically resyncs and resets history after a committed revert', async () => {
    const handlers = installServerEventHandlers();
    flushSolid();
    mockRuntimeBootstrap();
    // SAFETY: The fixture provides the string fields read by this statement.
    clientMocks.sessionGet.mockImplementation(async (id) => session(id as string));
    clientMocks.sessionMessages.mockResolvedValue([userEntry('message-kept')]);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const messageWindow = await import('../lib/message-window');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await vi.waitFor(() => expect(handlers.has('session.next.revert.committed')).toBe(true));
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('messages', [userEntry('message-kept'), userEntry('message-reverted')])
      );
      flushSolid();
      messageWindow.setSessionHistoryCursor('session-1', 'cursor-old');
      flushSolid();
      messageWindow.setSessionHistoryPrompts('session-1', [userEntry('prompt-old')]);
      flushSolid();
      messageWindow.cacheSessionHistoryPage('session-1', 'page-old', [
        userEntry('message-reverted'),
      ]);

      handlers.get('session.next.revert.committed')?.({
        properties: { sessionID: 'session-1', messageID: 'message-reverted' },
      });
      flushSolid();

      await vi.waitFor(() => {
        expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-kept']);
      });
      flushSolid();
      expect(messageWindow.getSessionHistoryCursor('session-1')).toBeUndefined();
      expect(messageWindow.getSessionHistoryPrompts('session-1')).toEqual([]);
      expect(messageWindow.takeCachedSessionHistoryPage('session-1', 'page-old')).toBeUndefined();
    } finally {
      dispose();
      flushSolid();
    }
  });
});
