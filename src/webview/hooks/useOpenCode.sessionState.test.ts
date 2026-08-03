import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEventName } from '../../shared/protocol';
import type { onMessage } from '../lib/bridge';
import {
  assistantMessage,
  getBridgeMocks,
  getClientMocks,
  loadModules,
  session,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();
type BridgeOnMessage = typeof onMessage;
type ServerEventsOn = (
  event: ServerEventName | '*',
  handler: (data: unknown) => void
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

describe('useOpenCode session state flows', () => {
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
    const handlers = new Map<string, (data: unknown) => void>();
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
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('session-1');
      });

      expect(clientMocks.sessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('applies a fallback title when refetching the session fails', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
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
      expect(clientMocks.varroSessionRenameIfUntitled).toHaveBeenCalledWith('session-1');
    } finally {
      dispose();
    }
  });

  it('keeps the active session marked seen when a later session update arrives', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
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
    const handlers = new Map<string, (data: unknown) => void>();
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
    const latest = [{ info: userMessage('user-3'), parts: [] }] as Array<{
      info: ReturnType<typeof userMessage>;
      parts: [];
    }> & { nextCursor?: string };
    latest.nextCursor = 'cursor-2';
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

    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(1, 'session-1', { limit: 50 });
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 50,
      before: 'cursor-2',
    });
    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
    ]);
  });

  it('stops full history loading when cursors form a multi-page cycle', async () => {
    const latest = [{ info: userMessage('user-3'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-a';
    const pageA = [{ info: userMessage('user-2'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    pageA.nextCursor = 'cursor-b';
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
    const latest = [{ info: userMessage('user-3'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-2';
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
      limit: 50,
      before: 'cursor-2',
    });
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(3, 'session-1', {
      limit: 50,
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
        limit: 50,
        before: 'cursor-older',
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

  it('returns a detached older-history response after A -> B -> A reselection', async () => {
    const stalePage = deferred<Awaited<ReturnType<typeof clientMocks.sessionMessages>>>();
    const initialA = [{ info: userMessage('user-a-initial'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    initialA[0]!.info.sessionID = 'session-a';
    initialA.nextCursor = 'cursor-stale';
    const reopenedA = [{ info: userMessage('user-a-current'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    reopenedA[0]!.info.sessionID = 'session-a';
    reopenedA.nextCursor = 'cursor-current';
    const initialB = [{ info: userMessage('user-b'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    initialB[0]!.info.sessionID = 'session-b';
    const staleOlderA = [{ info: userMessage('user-a-stale'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    staleOlderA[0]!.info.sessionID = 'session-a';
    let initialALoads = 0;

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
        limit: 50,
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

  it('prefetches a user prompt behind an assistant-only history boundary', async () => {
    const latest = [{ info: assistantMessage('assistant-1', 'user-1'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
    latest.nextCursor = 'cursor-1';
    const boundary = [{ info: userMessage('user-1'), parts: [] }] as Awaited<
      ReturnType<typeof clientMocks.sessionMessages>
    >;
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
        limit: 50,
        before: 'cursor-1',
      });
      expect(
        messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
      ).toEqual(['user-1']);
    });

    await expect(hookModule.loadOlderSessionHistoryPage('session-1')).resolves.toBe(true);
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 50,
      before: 'cursor-1',
    });
    expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(3, 'session-1', {
      limit: 50,
      before: 'cursor-2',
    });
    expect(messageWindow.getSessionHistoryCursor('session-1')).toBe('cursor-2');

    await vi.waitFor(() => {
      expect(clientMocks.sessionMessages).toHaveBeenNthCalledWith(3, 'session-1', {
        limit: 50,
        before: 'cursor-2',
      });
      expect(
        messageWindow.getSessionHistoryPrompts('session-1').map((entry) => entry.info.id)
      ).toEqual(['user-0', 'user-1']);
    });
  });
});
