import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { getClientMocks, loadModules, session } from './useOpenCode.test-support';

const clientMocks = getClientMocks();

describe('useOpenCode mcp flows', () => {
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

  it('unions a background running session into global MCP reconciliation', async () => {
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
    expect(clientMocks.mcpDisconnect).not.toHaveBeenCalledWith('alpha');
    expect(stateModule.getSelectedMcpsForSession('session-a')).toEqual(['alpha']);
    expect(stateModule.getSelectedMcpsForSession('session-b')).toEqual(['beta']);
  });
});
