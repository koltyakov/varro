import { flush as flushSolid, createRoot } from 'solid-js';
import { storePath } from '@solidjs/signals';
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
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-a'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await Promise.resolve();
      flushSolid();
      const handleMessage = bridgeOnMessage.mock.calls[0]?.[0];
      if (!handleMessage) throw new Error('Expected the runtime bridge listener');

      const refreshMessage: ExtensionMessage = {
        type: 'server/event',
        payload: { type: 'mcp.tools.changed', properties: {} },
      };
      handleMessage(refreshMessage);
      stateModule.setState(storePath('activeSessionId', 'session-b'));
      flushSolid();
      handleMessage(refreshMessage);

      responseB.resolve({ beta: { status: 'connected' } });
      flushSolid();
      await responseB.promise;
      flushSolid();
      await Promise.resolve();
      flushSolid();
      responseA.resolve({ alpha: { status: 'connected' } });
      flushSolid();
      await responseA.promise;
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(stateModule.state.mcpStatus).toEqual({ beta: { status: 'connected' } });
      expect(stateModule.getSelectedMcpsForSession('session-a')).toEqual([]);
      expect(stateModule.getSelectedMcpsForSession('session-b')).toEqual([]);
      expect(stateModule.state.sessionSelectedMcps).toEqual({});
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    stateModule.setSelectedMcpsForSession('session-1', ['beta']);
    flushSolid();

    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      await hookModule.selectSession('session-1');
      flushSolid();

      expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
      expect(clientMocks.mcpConnect).toHaveBeenCalledWith('beta');
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();

    await hookModule.applySessionMcps(['beta'], 'session-1');
    flushSolid();

    expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
    expect(clientMocks.mcpConnect).toHaveBeenCalledWith('beta');
    expect(stateModule.getSelectedMcpsForSession('session-1')).toEqual(['beta']);
  });

  it('keeps an MCP used by a running background session after an explicit toggle', async () => {
    clientMocks.mcpStatus.mockResolvedValue({
      alpha: { status: 'connected' },
      beta: { status: 'connected' },
    });

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setSelectedMcpsForSession('session-a', ['alpha']);
    flushSolid();
    stateModule.setSelectedMcpsForSession('session-b', ['beta']);
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-b'));
    flushSolid();
    stateModule.setState(
      storePath('sessionStatus', {
        'session-a': { type: 'busy' },
        'session-b': { type: 'idle' },
      })
    );
    flushSolid();
    stateModule.setState(
      storePath('mcpStatus', {
        alpha: { status: 'connected' },
        beta: { status: 'disabled' },
      })
    );
    flushSolid();

    await hookModule.applySessionMcps(['beta'], 'session-b');
    flushSolid();

    expect(clientMocks.mcpConnect).toHaveBeenCalledWith('beta');
    expect(clientMocks.mcpDisconnect).not.toHaveBeenCalledWith('alpha');
    expect(stateModule.getSelectedMcpsForSession('session-a')).toEqual(['alpha']);
    expect(stateModule.getSelectedMcpsForSession('session-b')).toEqual(['beta']);
  });

  it('retains a root session MCP while its child is running', async () => {
    clientMocks.mcpStatus.mockResolvedValue({ rare: { status: 'connected' } });
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(
      storePath('sessions', [
        session('root'),
        { ...session('child'), parentID: 'root' },
        session('foreground'),
      ])
    );
    flushSolid();
    stateModule.setState(storePath('sessionStatus', { child: { type: 'busy' } }));
    flushSolid();
    stateModule.setSelectedMcpsForSession('root', ['rare']);
    flushSolid();
    stateModule.setState(storePath('mcpStatus', { rare: { status: 'connected' } }));
    flushSolid();
    await hookModule.applySessionMcps([], 'foreground');
    flushSolid();
    expect(clientMocks.mcpDisconnect).not.toHaveBeenCalled();
  });

  it('conservatively retains shared connections used by an unknown running view', async () => {
    clientMocks.mcpStatus.mockResolvedValue({ rare: { status: 'connected' } });
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessionStatus', { unknown: { type: 'busy' } }));
    flushSolid();
    stateModule.setState(storePath('mcpStatus', { rare: { status: 'connected' } }));
    flushSolid();
    await hookModule.applySessionMcps([], 'foreground');
    flushSolid();
    expect(clientMocks.mcpDisconnect).not.toHaveBeenCalled();
    stateModule.setState(storePath('sessionStatus', { unknown: { type: 'idle' } }));
    flushSolid();
    await hookModule.applySessionMcps([], 'foreground');
    flushSolid();
    expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('rare');
  });

  it('does not connect MCPs selected only by an idle child of a running session', async () => {
    clientMocks.mcpStatus.mockResolvedValue({ rare: { status: 'disabled' } });
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(
      storePath('sessions', [session('root'), { ...session('child'), parentID: 'root' }])
    );
    flushSolid();
    stateModule.setState(
      storePath('sessionStatus', { root: { type: 'busy' }, child: { type: 'idle' } })
    );
    flushSolid();
    stateModule.setSelectedMcpsForSession('root', []);
    flushSolid();
    stateModule.setSelectedMcpsForSession('child', ['rare']);
    flushSolid();
    stateModule.setState(storePath('mcpStatus', { rare: { status: 'disabled' } }));
    flushSolid();
    await hookModule.applySessionMcps([], 'foreground');
    flushSolid();
    expect(clientMocks.mcpConnect).not.toHaveBeenCalled();
  });

  it('does not adopt a rare shared connection when refreshing a new session', async () => {
    clientMocks.mcpStatus.mockResolvedValue({
      rare: { status: 'connected' },
      docs: { status: 'disabled' },
    });
    clientMocks.mcpDefaults.mockResolvedValue({
      global: { rare: false, docs: true },
      project: {},
      effective: { rare: false, docs: true },
      editable: true,
    });
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    await hookModule.refreshSessionMcps('new');
    flushSolid();
    expect(stateModule.getSelectedMcpsForSession('new')).toEqual(['docs']);
    expect(stateModule.state.sessionSelectedMcps.new).toBeUndefined();
    expect(clientMocks.mcpConnect).toHaveBeenCalledWith('docs');
    expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('rare');
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
    flushSolid();
    stateModule.setSelectedMcpsForSession('background', ['alpha']);
    flushSolid();
    stateModule.setDraftSelectedMcps([]);
    flushSolid();
    stateModule.setState(storePath('sessionStatus', 'background', { type: 'busy' }));
    flushSolid();
    stateModule.setState(storePath('mcpStatus', { alpha: { status: 'connected' } }));
    flushSolid();

    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      handlers.get('session.idle')?.({ properties: { sessionID: 'background' } });
      flushSolid();

      await vi.waitFor(() => {
        expect(clientMocks.mcpDisconnect).toHaveBeenCalledWith('alpha');
      });
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });
});
