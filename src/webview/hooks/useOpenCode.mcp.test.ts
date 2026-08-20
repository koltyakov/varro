import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage, McpStatus, ServerEventName } from '../../shared/protocol';
import type { onMessage } from '../lib/bridge';
import { getBridgeMocks, getClientMocks, loadModules, session } from './useOpenCode.test-support';

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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useOpenCode mcp flows', () => {
  it('keeps deferred MCP refreshes latest-wins across active-session changes', async () => {
    const responseA = deferred<Record<string, McpStatus>>();
    const responseB = deferred<Record<string, McpStatus>>();
    clientMocks.mcpStatus
      .mockReturnValueOnce(responseA.promise)
      .mockReturnValueOnce(responseB.promise);

    const { stateModule, hookModule } = await loadModules();
    stateModule.setState('activeSessionId', 'session-a');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();
      const handleMessage = bridgeOnMessage.mock.calls[0]?.[0];
      if (!handleMessage) throw new Error('Expected the runtime bridge listener');

      const refreshMessage: ExtensionMessage = {
        type: 'server/event',
        payload: { type: 'mcp.tools.changed', properties: {} },
      };
      handleMessage(refreshMessage);
      stateModule.setState('activeSessionId', 'session-b');
      handleMessage(refreshMessage);

      responseB.resolve({ beta: { status: 'connected' } });
      await responseB.promise;
      await Promise.resolve();
      responseA.resolve({ alpha: { status: 'connected' } });
      await responseA.promise;
      await Promise.resolve();

      expect(stateModule.state.mcpStatus).toEqual({ beta: { status: 'connected' } });
      expect(stateModule.getSelectedMcpsForSession('session-a')).toBeNull();
      expect(stateModule.getSelectedMcpsForSession('session-b')).toEqual(['beta']);
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

  it('lets an explicit selection disconnect an MCP used by a background session', async () => {
    clientMocks.mcpStatus.mockResolvedValue({
      alpha: { status: 'connected' },
      beta: { status: 'connected' },
    });

    const { stateModule, hookModule } = await loadModules();
    stateModule.setSelectedMcpsForSession('session-a', ['alpha']);
    stateModule.setSelectedMcpsForSession('session-b', ['beta']);
    stateModule.setState('activeSessionId', 'session-b');
    stateModule.setState('sessionStatus', {
      'session-a': { type: 'busy' },
      'session-b': { type: 'idle' },
    });
    stateModule.setState('mcpStatus', {
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
    });

    await hookModule.applySessionMcps(['beta'], 'session-b');

    expect(clientMocks.mcpConnect).toHaveBeenCalledWith('beta');
    expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
    expect(stateModule.getSelectedMcpsForSession('session-a')).toEqual(['alpha']);
    expect(stateModule.getSelectedMcpsForSession('session-b')).toEqual(['beta']);
  });

  it('disconnects an MCP retained only by a background session after it becomes idle', async () => {
    const handlers = new Map<string, (data: ServerEvent) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    });
    clientMocks.mcpStatus.mockResolvedValue({ alpha: { status: 'connected' } });

    const { stateModule, hookModule } = await loadModules();
    stateModule.setSelectedMcpsForSession('background', ['alpha']);
    stateModule.setDraftSelectedMcps([]);
    stateModule.setState('sessionStatus', 'background', { type: 'busy' });
    stateModule.setState('mcpStatus', { alpha: { status: 'connected' } });

    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      handlers.get('session.idle')?.({ properties: { sessionID: 'background' } });

      await vi.waitFor(() => {
        expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
      });
    } finally {
      dispose();
    }
  });
});
