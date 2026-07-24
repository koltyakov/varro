import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { Permission } from '../types';
import {
  getBridgeMocks,
  getClientMocks,
  loadModules,
  session,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();

function permission(id = 'perm-1'): Permission {
  return {
    id,
    type: 'bash',
    pattern: '*',
    sessionID: 'session-1',
    messageID: `message-${id}`,
    callID: `call-${id}`,
    title: 'Run command',
    metadata: {},
    time: { created: 1 },
  };
}

function permissionListItem(id = 'perm-1') {
  return {
    id,
    permission: 'bash',
    patterns: '*',
    sessionID: 'session-1',
    title: 'Run command',
    metadata: {},
    tool: { messageID: `message-${id}`, callID: `call-${id}` },
    time: { created: 1 },
  };
}

function captureServerEventHandlers() {
  const handlers = new Map<string, (data: unknown) => void>();
  clientMocks.serverEventsOn.mockImplementation(
    (event: string, handler: (data: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }
  );
  return handlers;
}

function configureReconciliationMocks() {
  clientMocks.sessionList.mockResolvedValue([]);
  clientMocks.sessionStatus.mockResolvedValue({});
  clientMocks.agentList.mockResolvedValue([]);
  clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
  clientMocks.questionList.mockResolvedValue([]);
}

describe('useOpenCode permission and config flows', () => {
  it('clears restored prompts after a successful empty permission list', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    stateModule.addPermission(permission('perm-stale'));
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});

      await vi.waitFor(() => expect(stateModule.state.permissions).toEqual([]));
    } finally {
      dispose();
    }
  });

  it.each([
    ['failed', new Error('500 Permission list failed')],
    ['unsupported', new Error('404 Not Found')],
  ])('preserves restored prompts when the permission list is %s', async (_label, error) => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockRejectedValue(error);

    const { stateModule, hookModule } = await loadModules();
    stateModule.addPermission(permission('perm-restored'));
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});

      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(bridgeMocks.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ error: error.message }),
          })
        )
      );
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-restored' }),
      ]);
      expect(stateModule.getPermissionReconciliationMetadataSize()).toEqual({
        activeReconciliations: 0,
        retainedPermissionIds: 0,
      });
    } finally {
      dispose();
    }
  });

  it('auto-judges listed prompts and keeps prompts that still need approval', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem()]);
    clientMocks.varroJudgePermission.mockResolvedValue({ decision: 'ask', reason: 'review' });

    const { stateModule, hookModule } = await loadModules();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([expect.objectContaining({ id: 'perm-1' })])
      );
      expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('does not approve an auto-judged prompt after switching to default mode', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem()]);
    let resolveJudge: ((value: { decision: 'allow'; reason: string }) => void) | undefined;
    clientMocks.varroJudgePermission.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveJudge = resolve;
        })
    );

    const { stateModule, hookModule } = await loadModules();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(1));

      stateModule.setPermissionModeForSession('session-1', 'default');
      resolveJudge?.({ decision: 'allow', reason: 'Allowed.' });

      await Promise.resolve();
      await Promise.resolve();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('responds to listed prompts without displaying them in full mode', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem()]);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    stateModule.setPermissionModeForSession('session-1', 'full');
    stateModule.addPermission(permission());
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});

      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-1',
          'always'
        )
      );
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('does not re-add a permission answered while its list request is in flight', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    let resolvePermissionList: ((items: ReturnType<typeof permissionListItem>[]) => void) | null =
      null;
    clientMocks.permissionList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePermissionList = resolve;
        })
    );
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    stateModule.addPermission(permission('perm-answered'));
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(1));

      await hookModule.respondPermission('session-1', 'perm-answered', 'once');
      resolvePermissionList?.([
        permissionListItem('perm-answered'),
        permissionListItem('perm-current'),
      ]);

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-current' }),
        ])
      );
    } finally {
      dispose();
    }
  });

  it('applies desktop session pane side from config updates', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
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

      bridgeHandler({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          providerLimitPollIntervalSeconds: 90,
          providerLimitsDisabled: false,
          providerLimitThresholdPercent: 25,
        },
      });

      expect(stateModule.desktopSessionPaneSide()).toBe('right');
      expect(stateModule.providerLimitPollIntervalSeconds()).toBe(90);
      expect(stateModule.providerLimitThresholdPercent()).toBe(25);
    } finally {
      dispose();
    }
  });

  it('applies disabled provider-limit polling from config updates', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
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

      bridgeHandler({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          providerLimitsDisabled: true,
        },
      });

      expect(stateModule.providerLimitPollIntervalSeconds()).toBe(-1);
    } finally {
      dispose();
    }
  });

  it('still accepts legacy disabled provider-limit polling config updates', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
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

      bridgeHandler({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          providerLimitPollIntervalSeconds: -1,
        },
      });

      expect(stateModule.providerLimitPollIntervalSeconds()).toBe(-1);
    } finally {
      dispose();
    }
  });

  it('re-enables provider-limit polling from poll interval config updates', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
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

      bridgeHandler({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          providerLimitPollIntervalSeconds: -1,
        },
      });
      expect(stateModule.providerLimitPollIntervalSeconds()).toBe(-1);

      bridgeHandler({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          providerLimitPollIntervalSeconds: 120,
        },
      });

      expect(stateModule.providerLimitPollIntervalSeconds()).toBe(120);
    } finally {
      dispose();
    }
  });

  it('restores pending permission prompts from initial webview state after reload', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState = {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: '',
      interruptedSessionIds: ['session-1'],
      pendingPermissions: [
        {
          id: 'perm-1',
          permission: 'apply_patch',
          sessionID: 'session-1',
          title: 'apply_patch',
          metadata: {},
          tool: { messageID: 'message-1', callID: 'call-1' },
          time: { created: 123 },
        },
      ],
    };

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            callID: 'call-1',
            type: 'apply_patch',
          }),
        ]);
      });
      expect(stateModule.isSessionAwaitingInput('session-1')).toBe(true);
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('restores pending permission prompts that use permissionID after reload', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState = {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: '',
      interruptedSessionIds: ['session-1'],
      pendingPermissions: [
        {
          permissionID: 'perm-2',
          permission: 'apply_patch',
          sessionID: 'session-1',
          title: 'apply_patch',
          metadata: {},
          tool: { messageID: 'message-1', callID: 'call-1' },
          time: { created: 123 },
        },
      ],
    };

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'busy' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-2',
            sessionID: 'session-1',
            messageID: 'message-1',
            callID: 'call-1',
            type: 'apply_patch',
          }),
        ]);
      });
      expect(stateModule.isSessionAwaitingInput('session-1')).toBe(true);
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('normalizes live permission events with nested tool metadata', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    const serverEventHandlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation(
      (event: string, handler: (data: unknown) => void) => {
        serverEventHandlers.set(event, handler);
        return () => {
          serverEventHandlers.delete(event);
        };
      }
    );

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(serverEventHandlers.has('permission.asked')).toBe(true);
      });

      serverEventHandlers.get('permission.asked')?.({
        properties: {
          id: 'perm-live-1',
          permission: 'apply_patch',
          sessionID: 'session-1',
          title: 'apply_patch',
          metadata: {},
          tool: { messageID: 'message-1', callID: 'call-1' },
          time: { created: 123 },
        },
      });

      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({
          id: 'perm-live-1',
          sessionID: 'session-1',
          type: 'apply_patch',
          messageID: 'message-1',
          callID: 'call-1',
        }),
      ]);
    } finally {
      dispose();
    }
  });
});
