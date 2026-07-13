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

  it('keeps MCPs required by a running background session connected', async () => {
    const connectMcp = vi.fn(async () => {});
    const disconnectMcp = vi.fn(async () => {});

    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: (sessionId) =>
          sessionId === 'session-a' ? ['alpha'] : ['beta'],
        getRequiredMcpSessionIds: () => ['session-a', 'session-b'],
        getMcpStatus: () => ({
          alpha: { status: 'connected' },
          beta: { status: 'disabled' },
        }),
        loadMcps: vi.fn(async () => {}),
        getAvailableMcpNames: () => ['alpha', 'beta'],
        connectMcp,
        authenticateMcp: vi.fn(async () => {}),
        disconnectMcp,
        logError: vi.fn(),
      },
      'session-b'
    );

    expect(connectMcp).toHaveBeenCalledWith('beta');
    expect(disconnectMcp).not.toHaveBeenCalledWith('alpha');
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

  it('serializes rapid reconciliations so the latest selection wins', async () => {
    let resolveFirstConnect: (() => void) | undefined;
    let statuses: Record<string, { status: 'connected' | 'disabled' }> = {
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
    };
    const selections: Record<string, string[]> = {
      'session-a': ['beta'],
      'session-b': ['alpha'],
    };
    const connectMcp = vi.fn(async (name: string) => {
      if (name === 'beta') {
        await new Promise<void>((resolve) => {
          resolveFirstConnect = resolve;
        });
      }
      statuses = { ...statuses, [name]: { status: 'connected' } };
    });
    const disconnectMcp = vi.fn(async (name: string) => {
      statuses = { ...statuses, [name]: { status: 'disabled' } };
    });
    const operations = new SessionMcpOperations({
      getSelectedMcpsForSession: (sessionId) => selections[sessionId],
      getRequiredMcpSessionIds: (sessionId) => [sessionId],
      getMcpStatus: () => statuses,
      loadMcps: vi.fn(async () => {}),
      getAvailableMcpNames: () => ['alpha', 'beta'],
      connectMcp,
      authenticateMcp: vi.fn(async () => {}),
      disconnectMcp,
      logError: vi.fn(),
      setSelectedMcpsForSession: vi.fn(),
    });

    const first = operations.syncSessionMcps('session-a');
    await vi.waitFor(() => expect(connectMcp).toHaveBeenCalledWith('beta'));
    const second = operations.syncSessionMcps('session-b');

    expect(connectMcp).not.toHaveBeenCalledWith('alpha');
    resolveFirstConnect?.();
    await Promise.all([first, second]);

    expect(connectMcp.mock.calls.map(([name]) => name)).toEqual(['beta', 'alpha']);
    expect(disconnectMcp.mock.calls.map(([name]) => name)).toEqual(['alpha', 'beta']);
    expect(statuses).toEqual({
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
    });
  });
});
