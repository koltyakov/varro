import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
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

describe('useOpenCode session state flows', () => {
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

  it('does not resync active session messages on idle when local messages already look settled', async () => {
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
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: {
            ...assistantMessage('assistant-1', 'user-1'),
            time: { created: 0, completed: 1 },
          },
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
});
