import { describe, expect, it, vi } from 'vitest';
import {
  applySessionMcpsWithDependencies,
  SessionMcpOperations,
  syncSessionMcpsWithDependencies,
} from './session/session-mcp';

describe('session MCP helpers', () => {
  it('connects and disconnects MCPs to match the session selection', async () => {
    const connectMcp = vi.fn(async () => {});
    const authenticateMcp = vi.fn(async () => {});
    const disconnectMcp = vi.fn(async () => {});
    const loadMcps = vi.fn(async () => {});

    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: () => ['beta'],
        getMcpStatus: () => ({
          alpha: { status: 'connected' },
          beta: { status: 'disabled' },
        }),
        loadMcps,
        getAvailableMcpNames: () => ['alpha', 'beta'],
        connectMcp,
        authenticateMcp,
        disconnectMcp,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(disconnectMcp).toHaveBeenCalledWith('alpha');
    expect(connectMcp).toHaveBeenCalledWith('beta');
    expect(authenticateMcp).not.toHaveBeenCalled();
    expect(loadMcps).toHaveBeenCalledTimes(1);
  });

  it('authenticates selected MCPs that require OAuth', async () => {
    const connectMcp = vi.fn(async () => {});
    const authenticateMcp = vi.fn(async () => {});

    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: () => ['oauth-server'],
        getMcpStatus: () => ({ 'oauth-server': { status: 'needs_auth' } }),
        loadMcps: vi.fn(async () => {}),
        getAvailableMcpNames: () => ['oauth-server'],
        connectMcp,
        authenticateMcp,
        disconnectMcp: vi.fn(async () => {}),
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(authenticateMcp).toHaveBeenCalledWith('oauth-server');
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('loads MCP status first when none has been hydrated yet', async () => {
    const loadMcps = vi.fn(async () => {});
    const getMcpStatus = vi
      .fn<() => Record<string, { status: 'connected' | 'disabled' }>>()
      .mockReturnValueOnce({})
      .mockReturnValueOnce({ alpha: { status: 'connected' } })
      .mockReturnValueOnce({ alpha: { status: 'connected' } });

    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: () => ['alpha'],
        getMcpStatus,
        loadMcps,
        getAvailableMcpNames: () => ['alpha'],
        connectMcp: vi.fn(async () => {}),
        authenticateMcp: vi.fn(async () => {}),
        disconnectMcp: vi.fn(async () => {}),
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(loadMcps).toHaveBeenCalledTimes(1);
  });

  it('hydrates an uninitialized session MCP selection before syncing', async () => {
    const loadMcps = vi.fn(async () => {
      selected = ['alpha'];
    });
    const connectMcp = vi.fn(async () => {});
    const disconnectMcp = vi.fn(async () => {});
    let selected: string[] | null = null;

    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: () => selected,
        getMcpStatus: () => ({ alpha: { status: 'connected' } }),
        loadMcps,
        getAvailableMcpNames: () => ['alpha'],
        connectMcp,
        authenticateMcp: vi.fn(async () => {}),
        disconnectMcp,
        logError: vi.fn(),
      },
      'session-1'
    );

    expect(loadMcps).toHaveBeenCalledTimes(1);
    expect(connectMcp).not.toHaveBeenCalled();
    expect(disconnectMcp).not.toHaveBeenCalled();
  });

  it('stores the selected MCPs before syncing them', async () => {
    const setSelectedMcpsForSession = vi.fn();
    const syncSessionMcps = vi.fn(async () => {});

    await applySessionMcpsWithDependencies(
      {
        setSelectedMcpsForSession,
        syncSessionMcps,
      },
      ['beta'],
      'session-1'
    );

    expect(setSelectedMcpsForSession).toHaveBeenCalledWith('session-1', ['beta']);
    expect(syncSessionMcps).toHaveBeenCalledWith('session-1');
  });

  it('creates bound session MCP operations from one dependency bag', async () => {
    const loadMcps = vi.fn(async () => {});
    const connectMcp = vi.fn(async () => {});
    const authenticateMcp = vi.fn(async () => {});
    const disconnectMcp = vi.fn(async () => {});
    const setSelectedMcpsForSession = vi.fn();

    const operations = new SessionMcpOperations({
      getSelectedMcpsForSession: () => ['beta'],
      getMcpStatus: () => ({
        alpha: { status: 'connected' },
        beta: { status: 'disabled' },
      }),
      loadMcps,
      getAvailableMcpNames: () => ['alpha', 'beta'],
      connectMcp,
      authenticateMcp,
      disconnectMcp,
      logError: vi.fn(),
      setSelectedMcpsForSession,
    });

    await operations.syncSessionMcps('session-1');
    await operations.applySessionMcps(['beta'], 'session-1');

    expect(disconnectMcp).toHaveBeenCalledWith('alpha');
    expect(connectMcp).toHaveBeenCalledWith('beta');
    expect(setSelectedMcpsForSession).toHaveBeenCalledWith('session-1', ['beta']);
  });
});
