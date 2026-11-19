import { flush as flushSolid, createRoot } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';
import { AUTO_APPROVE_JUDGE_TIMEOUT_MS, type ServerEventName } from '../../shared/protocol';
import type { onMessage } from '../lib/bridge';
import type { Permission } from '../types';
import {
  getBridgeMocks,
  getClientMocks,
  loadModules,
  session,
  userMessage,
} from './useOpenCode.test-support';

interface ServerEvent {
  properties?: unknown;
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
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
  const handlers = new Map<string, (data: ServerEvent) => void>();
  serverEventsOn.mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
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
  it('saves reviewed global patterns before replying once and keeps grouped peers pending', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('serverStatus', { state: 'running', apiVersion: 2 }));
    flushSolid();
    stateModule.setState(storePath('sessions', [session()]));
    flushSolid();
    stateModule.addPermission(permission());
    flushSolid();
    stateModule.addPermission(permission('perm-2'));
    flushSolid();
    const persisted = deferred<void>();
    clientMocks.sessionPersistGlobalPermissionAllow.mockReturnValue(persisted.promise);
    const approval = hookModule.alwaysAllowPermissionForGlobal('session-1', 'perm-1', [
      'git diff *',
    ]);
    expect(clientMocks.sessionPersistGlobalPermissionAllow).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'perm-1',
      { directory: '/repo', patterns: ['git diff *'] }
    );
    expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
    persisted.resolve();
    flushSolid();
    await approval;
    flushSolid();
    expect(clientMocks.sessionRespondPermission).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'perm-1',
      'once'
    );
    expect(stateModule.state.permissions).toEqual([expect.objectContaining({ id: 'perm-2' })]);
  });

  it('keeps global approval pending after config or reply failures', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('serverStatus', { state: 'running', apiVersion: 2 }));
    flushSolid();
    stateModule.addPermission(permission());
    flushSolid();
    clientMocks.sessionPersistGlobalPermissionAllow.mockRejectedValueOnce(
      new Error('Write failed')
    );
    await expect(
      hookModule.alwaysAllowPermissionForGlobal('session-1', 'perm-1', ['git *'])
    ).rejects.toThrow('Write failed');
    flushSolid();
    expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
    expect(stateModule.state.permissions).toHaveLength(1);
    clientMocks.sessionRespondPermission.mockRejectedValueOnce(new Error('Reply failed'));
    await expect(
      hookModule.alwaysAllowPermissionForGlobal('session-1', 'perm-1', ['git *'])
    ).rejects.toThrow('Reply failed');
    flushSolid();
    expect(stateModule.state.permissions).toHaveLength(1);
  });

  it.each([1, 2] as const)(
    'persists project approval before replying with the V%s lifetime',
    async (apiVersion) => {
      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setState(storePath('serverStatus', { state: 'running', apiVersion }));
      flushSolid();
      stateModule.setState(storePath('sessions', [session()]));
      flushSolid();
      stateModule.addPermission(permission());
      flushSolid();
      stateModule.addPermission(permission('perm-2'));
      flushSolid();
      const persisted = deferred<void>();
      clientMocks.sessionPersistProjectPermissionAllow.mockReturnValue(persisted.promise);
      const approval = hookModule.alwaysAllowPermissionForProject('session-1', 'perm-1');

      expect(clientMocks.sessionPersistProjectPermissionAllow).toHaveBeenCalledExactlyOnceWith(
        'session-1',
        'perm-1',
        { directory: '/repo' }
      );
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(stateModule.state.permissions).toHaveLength(1);
      expect(stateModule.state.permissions[0]?.groupMembers).toHaveLength(2);
      persisted.resolve();
      flushSolid();
      await approval;
      flushSolid();

      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledExactlyOnceWith(
        'session-1',
        'perm-1',
        apiVersion === 2 ? 'once' : 'always'
      );
      expect(clientMocks.sessionUpdate).not.toHaveBeenCalled();
      expect(stateModule.state.permissions).toEqual(
        apiVersion === 2 ? [expect.objectContaining({ id: 'perm-2' })] : []
      );
    }
  );

  it('does not reply or remove the V2 prompt when project persistence fails', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('serverStatus', { state: 'running', apiVersion: 2 }));
    flushSolid();
    stateModule.addPermission(permission());
    flushSolid();
    clientMocks.sessionPersistProjectPermissionAllow.mockRejectedValue(new Error('Write failed'));

    await expect(hookModule.alwaysAllowPermissionForProject('session-1', 'perm-1')).rejects.toThrow(
      'Write failed'
    );
    flushSolid();
    expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
    expect(stateModule.state.permissions).toHaveLength(1);
  });

  it('keeps the V2 project prompt actionable when its once reply fails', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('serverStatus', { state: 'running', apiVersion: 2 }));
    flushSolid();
    stateModule.addPermission(permission());
    flushSolid();
    clientMocks.sessionRespondPermission.mockRejectedValue(new Error('Reply failed'));

    await expect(hookModule.alwaysAllowPermissionForProject('session-1', 'perm-1')).rejects.toThrow(
      'Reply failed'
    );
    flushSolid();
    expect(clientMocks.sessionRespondPermission).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'perm-1',
      'once'
    );
    expect(stateModule.state.permissions).toHaveLength(1);
  });

  it('clears restored prompts after a successful empty permission list', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.addPermission(permission('perm-stale'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() => expect(stateModule.state.permissions).toEqual([]));
      flushSolid();
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    stateModule.addPermission(permission('perm-restored'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(1));
      flushSolid();
      await vi.waitFor(() =>
        expect(bridgeMocks.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ error: error.message }),
          })
        )
      );
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-restored' }),
      ]);
      expect(stateModule.getPermissionReconciliationMetadataSize()).toEqual({
        activeReconciliations: 0,
        retainedPermissionIds: 0,
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('auto-judges listed prompts and keeps prompts that still need approval', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem()]);
    clientMocks.varroJudgePermission.mockResolvedValue({
      decision: 'ask',
      reason: 'review',
      actionSummary: 'Check installed tool versions',
    });

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-1',
            autoApproveReason: 'review',
            actionSummary: 'Check installed tool versions',
          }),
        ])
      );
      flushSolid();
      expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(1);
      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([
        expect.objectContaining({
          permissionId: 'perm-1',
          status: 'approval-required',
          detail: 'review',
        }),
      ]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('keeps prompts visible and sends no automatic work without initial ownership', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    // SAFETY: This fixture intentionally omits permissionAutomation to verify fail-closed startup.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      sessionPermissionModes: { 'session-1': 'auto' },
    };

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-unowned'),
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-unowned' }),
        ])
      );
      flushSolid();
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-unowned' },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it.each([
    ['default', 'todowrite'],
    ['default', 'question'],
    ['auto', 'todowrite'],
    ['auto', 'question'],
    ['full', 'todowrite'],
    ['full', 'question'],
  ] as const)('leaves %s-mode %s permissions to the automation owner', async (mode, type) => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    // SAFETY: The fixture provides the initial ownership state read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      permissionAutomation: { owner: false, lease: 1 },
    };
    clientMocks.sessionRespondPermission.mockRejectedValue(
      new Error('Permission automation ownership changed')
    );

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', mode);
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-direct-unowned'), permission: type },
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-direct-unowned', type }),
        ])
      );
      flushSolid();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      expect(stateModule.error()).toBeNull();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-direct-unowned' },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it.each(['bash', 'todowrite', 'question'])(
    'recovers a full-access %s reply rejected during an ownership handoff without a popup',
    async (type) => {
      let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
      bridgeOnMessage.mockImplementation((handler) => {
        bridgeHandler = handler;
        return () => {
          bridgeHandler = undefined;
        };
      });
      const serverEventHandlers = captureServerEventHandlers();
      configureReconciliationMocks();
      const pending = { ...permissionListItem('perm-handoff'), permission: type };
      const response = deferred<void>();
      clientMocks.sessionRespondPermission.mockReturnValueOnce(response.promise);
      clientMocks.permissionList.mockResolvedValue([pending]);

      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setPermissionModeForSession('session-1', 'full');
      flushSolid();
      const dispose = createRoot((cleanup) => {
        hookModule.useOpenCode();
        return cleanup;
      });
      flushSolid();

      try {
        serverEventHandlers.get('permission.asked')?.({ properties: pending });
        flushSolid();
        await vi.waitFor(() => expect(clientMocks.sessionRespondPermission).toHaveBeenCalledOnce());
        flushSolid();
        if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
        bridgeHandler({
          type: 'permission-automation/update',
          payload: { owner: false, lease: 2 },
        });
        flushSolid();
        response.reject(new Error('Permission automation ownership changed'));
        flushSolid();

        await vi.waitFor(() =>
          expect(stateModule.state.permissions).toEqual([
            expect.objectContaining({ id: 'perm-handoff' }),
          ])
        );
        flushSolid();
        expect(stateModule.error()).toBeNull();
        expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
          type: 'permission/reveal',
          payload: { permissionId: 'perm-handoff' },
        });

        clientMocks.sessionRespondPermission.mockResolvedValue(undefined);
        bridgeHandler({
          type: 'permission-automation/update',
          payload: { owner: true, lease: 3 },
        });
        flushSolid();
        await vi.waitFor(() =>
          expect(clientMocks.sessionRespondPermission).toHaveBeenCalledTimes(2)
        );
        flushSolid();
        expect(clientMocks.sessionRespondPermission).toHaveBeenLastCalledWith(
          'session-1',
          'perm-handoff',
          'once',
          { permissionAutomationLease: 3 }
        );
        await vi.waitFor(() => expect(stateModule.state.permissions).toEqual([]));
        flushSolid();
        expect(stateModule.error()).toBeNull();
      } finally {
        dispose();
        flushSolid();
      }
    }
  );

  it('reconciles visible prompts once when a non-owner acquires automation', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    const serverEventHandlers = captureServerEventHandlers();
    clientMocks.permissionList.mockResolvedValue([permissionListItem('perm-failover')]);
    clientMocks.varroJudgePermission.mockResolvedValue({
      decision: 'ask',
      reason: 'Needs confirmation.',
    });
    // SAFETY: The fixture provides the initial ownership state read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      permissionAutomation: { owner: false, lease: 1 },
    };

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-failover'),
      });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-failover' }),
        ])
      );
      flushSolid();
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'permission-automation/update',
        payload: { owner: true, lease: 2 },
      });
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-failover',
            autoApproveReason: 'Needs confirmation.',
          }),
        ])
      );
      flushSolid();

      bridgeHandler({
        type: 'permission-automation/update',
        payload: { owner: true, lease: 2 },
      });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.permissionList).toHaveBeenCalledOnce();
      expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('counts acknowledged automatic rejections', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.varroJudgePermission.mockResolvedValue({
      decision: 'reject',
      reason: 'Matches a prior rejection.',
    });
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-rejected'),
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-rejected',
          'reject',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.sessionAutoPermissionCounts).toEqual({
        'session-1': { inFlight: 0, approved: 0, rejected: 1 },
      });
      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([
        expect.objectContaining({
          permissionId: 'perm-rejected',
          status: 'auto-review-failed',
          detail: 'Matches a prior rejection.',
        }),
      ]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('shows the judge failure reason on the permission fallback', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.varroJudgePermission.mockRejectedValue(new Error('Judge model unavailable'));

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-judge-failed'),
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-judge-failed',
            autoApproveReason: 'Failed to evaluate this request: Judge model unavailable',
          }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('hides a restored permission and its attention status until the judge asks', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem('perm-restored')]);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const { deriveSessionIndicators } = await import('../components/chat/SessionListView');
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    stateModule.addPermission(permission('perm-restored'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
      expect(deriveSessionIndicators(stateModule.state.sessions).attentionIds).not.toContain(
        'session-1'
      );

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
      flushSolid();
      expect(deriveSessionIndicators(stateModule.state.sessions).attentionIds).toContain(
        'session-1'
      );
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('reveals an unknown child during ancestry loading and preserves the fallback while judging', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.permissionList.mockResolvedValue([
      { ...permissionListItem('perm-restored-child'), sessionID: 'child-1' },
    ]);
    clientMocks.sessionGet.mockResolvedValue({
      ...session('child-1'),
      parentID: 'session-1',
    });
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    stateModule.addPermission({
      ...permission('perm-restored-child'),
      sessionID: 'child-1',
    });
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      expect(stateModule.state.permissions).toEqual([]);
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-restored-child', sessionID: 'child-1' }),
      ]);

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored-child', sessionID: 'child-1' }),
        ])
      );
      flushSolid();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-restored-child' },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('ignores a late judge result after the permission is no longer pending', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([]);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-canceled'),
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();

      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.getPermissionReconciliationMetadataSize().activeReconciliations).toBe(0)
      );
      flushSolid();

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSolid();

      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('keeps judging a permission received while an empty snapshot is loading', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const pendingPermissions = deferred<ReturnType<typeof permissionListItem>[]>();
    clientMocks.permissionList.mockReturnValue(pendingPermissions.promise);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledOnce());
      flushSolid();

      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-current'),
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      pendingPermissions.resolve([]);
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.getPermissionReconciliationMetadataSize().activeReconciliations).toBe(0)
      );
      flushSolid();

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-current' }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('hides a restored auto-mode permission before the permission list resolves', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const pendingPermissions = deferred<ReturnType<typeof permissionListItem>[]>();
    clientMocks.permissionList.mockReturnValue(pendingPermissions.promise);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const { deriveSessionIndicators } = await import('../components/chat/SessionListView');
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    stateModule.addPermission(permission('perm-restored'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      expect(stateModule.state.permissions).toEqual([]);
      expect(deriveSessionIndicators(stateModule.state.sessions).attentionIds).not.toContain(
        'session-1'
      );

      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);

      pendingPermissions.resolve([permissionListItem('perm-restored')]);
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('restores a hidden auto-mode permission when permission sync fails', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockRejectedValue(new Error('Permission list failed'));

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    stateModule.addPermission(permission('perm-restored'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      expect(stateModule.state.permissions).toEqual([]);
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('restores a hidden prompt when permission sync fails during a pending full PATCH', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const modeUpdate = deferred<ReturnType<typeof session>>();
    clientMocks.varroSessionUpdatePermissionMode.mockReturnValue(modeUpdate.promise);
    clientMocks.permissionList.mockRejectedValue(new Error('Permission list failed'));

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    stateModule.addPermission(permission('perm-pending-full'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      expect(stateModule.state.permissions).toEqual([]);
      const update = hookModule.updatePermissionModeForSession('full', 'session-1');
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.varroSessionUpdatePermissionMode).toHaveBeenCalledWith(
          'session-1',
          'full',
          { directory: '/repo' }
        )
      );
      flushSolid();

      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toContainEqual(
          expect.objectContaining({ id: 'perm-pending-full' })
        )
      );
      flushSolid();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-pending-full' },
      });
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();

      modeUpdate.reject(new Error('Permission mode update failed'));
      flushSolid();
      await update;
      flushSolid();

      expect(stateModule.getPermissionModeForSession('session-1')).toBe('auto');
      expect(stateModule.state.permissions).toContainEqual(
        expect.objectContaining({ id: 'perm-pending-full' })
      );
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('restores a hidden prompt when a newer overlapping permission sync fails', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const firstList = deferred<ReturnType<typeof permissionListItem>[]>();
    const secondList = deferred<ReturnType<typeof permissionListItem>[]>();
    clientMocks.permissionList
      .mockReturnValueOnce(firstList.promise)
      .mockReturnValueOnce(secondList.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    stateModule.addPermission(permission('perm-restored'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledOnce());
      flushSolid();
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler({
        type: 'permission/actionable',
        payload: { permissionId: 'perm-restored' },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(2));
      flushSolid();

      firstList.resolve([]);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      secondList.reject(new Error('newer sync failed'));
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('does not restore a hidden permission after switching workspaces when sync fails', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockRejectedValue(new Error('Permission list failed'));
    // SAFETY: The fixture provides the initial recovery snapshot read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-a',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      sessionPermissionModes: { 'session-1': 'auto' },
      permissionAutomation: { owner: true, lease: 1 },
      pendingPermissions: [permissionListItem('perm-restored-a')],
    };

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      expect(stateModule.state.permissions).toEqual([]);
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');
      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-a',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });
      flushSolid();
      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-b',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });
      flushSolid();

      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledOnce());
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.getPermissionReconciliationMetadataSize().activeReconciliations).toBe(0)
      );
      flushSolid();

      expect(stateModule.state.permissions).toEqual([]);
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-restored-a' },
      });

      bridgeHandler({
        type: 'context/update',
        payload: {
          workspacePath: '/repo-a',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      });
      flushSolid();
      bridgeHandler({
        type: 'permission/actionable',
        payload: { permissionId: 'perm-restored-a' },
      });
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(2));
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored-a' }),
        ])
      );
      flushSolid();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-restored-a' },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('auto-approves a visible timed-out permission when the judge responds late', async () => {
    vi.useFakeTimers();
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-timeout'),
      });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce();
      expect(stateModule.state.sessionAutoPermissionCounts).toEqual({
        'session-1': { inFlight: 1, approved: 0, rejected: 0 },
      });
      expect(stateModule.state.permissions).toEqual([]);
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-timeout' },
      });

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS - 1);
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-timeout' }),
      ]);
      expect(stateModule.state.sessionAutoPermissionCounts).toEqual({
        'session-1': { inFlight: 1, approved: 0, rejected: 0 },
      });
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-timeout' },
      });

      judge.resolve({ decision: 'allow', reason: 'Late approval.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-timeout',
          'once',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.sessionAutoPermissionCounts).toEqual({
        'session-1': { inFlight: 0, approved: 1, rejected: 0 },
      });
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('keeps a visible timed-out permission through a pending permission resync', async () => {
    vi.useFakeTimers();
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem('perm-timeout-sync')]);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-timeout-sync'),
      });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS);
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({
          id: 'perm-timeout-sync',
          autoApproveReason: 'Timed out before making a decision.',
        }),
      ]);

      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.getPermissionReconciliationMetadataSize().activeReconciliations).toBe(0)
      );
      flushSolid();

      expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({
          id: 'perm-timeout-sync',
          autoApproveReason: 'Timed out before making a decision.',
        }),
      ]);

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-timeout-sync',
            autoApproveReason: 'Needs confirmation.',
          }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('keeps a visible timed-out permission until a late approval is acknowledged', async () => {
    vi.useFakeTimers();
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    const response = deferred<void>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockReturnValue(response.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-timeout-response'),
      });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS);
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-timeout-response' }),
      ]);

      judge.resolve({ decision: 'allow', reason: 'Late approval.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-timeout-response',
          'once',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-timeout-response' }),
      ]);

      response.resolve(undefined);
      flushSolid();
      await vi.waitFor(() => expect(stateModule.state.permissions).toEqual([]));
      flushSolid();
    } finally {
      dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('ignores a late judge response after the user accepts a timed-out permission', async () => {
    vi.useFakeTimers();
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    const userResponse = deferred<void>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockReturnValue(userResponse.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-user-first'),
      });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS);
      flushSolid();
      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-user-first' }),
      ]);

      const response = hookModule.respondPermission('session-1', 'perm-user-first', 'once');
      await Promise.resolve();
      flushSolid();
      expect(stateModule.state.sessionAutoPermissionCounts).toEqual({
        'session-1': { inFlight: 0, approved: 0, rejected: 0 },
      });
      judge.resolve({ decision: 'allow', reason: 'Too late.' });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledTimes(1);
      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
        'session-1',
        'perm-user-first',
        'once'
      );
      userResponse.resolve(undefined);
      flushSolid();
      await response;
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('clears reviewing activity when a reply event resolves the permission first', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-replied-first'),
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([
        expect.objectContaining({ permissionId: 'perm-replied-first', status: 'reviewing' }),
      ]);

      serverEventHandlers.get('permission.replied')?.({
        properties: { id: 'perm-replied-first' },
      });
      flushSolid();

      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([]);
      expect(stateModule.state.sessionAutoPermissionCounts['session-1']?.inFlight).toBe(0);

      judge.resolve({ decision: 'allow', reason: 'Too late.' });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('clears reviewing activity when a pending snapshot proves the permission resolved', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([]);
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-snapshot-resolved'),
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([
        expect.objectContaining({ permissionId: 'perm-snapshot-resolved', status: 'reviewing' }),
      ]);

      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([])
      );
      flushSolid();
      expect(stateModule.state.sessionAutoPermissionCounts['session-1']?.inFlight).toBe(0);

      judge.resolve({ decision: 'allow', reason: 'Too late.' });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('keeps a child-session permission hidden while resolving inherited auto mode', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const childSession = deferred<ReturnType<typeof session>>();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.sessionGet.mockReturnValue(childSession.promise);
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-child'), sessionID: 'child-1' },
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('child-1', { directory: undefined })
      );
      flushSolid();
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      expect(stateModule.state.permissions).toEqual([]);

      childSession.resolve({ ...session('child-1'), parentID: 'session-1' });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-child' },
      });

      judge.resolve({ decision: 'allow', reason: 'Safe child action.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'child-1',
          'perm-child',
          'once',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('reveals a child-session permission when ancestry resolution times out', async () => {
    vi.useFakeTimers();
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const childSession = deferred<ReturnType<typeof session>>();
    clientMocks.sessionGet.mockReturnValue(childSession.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-child-timeout'), sessionID: 'child-1' },
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('child-1', { directory: undefined })
      );
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS);
      flushSolid();

      expect(stateModule.state.permissions).toEqual([
        expect.objectContaining({ id: 'perm-child-timeout', sessionID: 'child-1' }),
      ]);
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-child-timeout' },
      });
    } finally {
      dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('shows a child-session judge fallback in the root session and accepts it', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.sessionGet.mockResolvedValue({
      ...session('child-1'),
      parentID: 'session-1',
    });
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const { getStandalonePermissionPrompts } =
      await import('../components/message-list/pending-prompts');
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-child-ask'), sessionID: 'child-1' },
      });
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-child-ask' },
      });

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-child-ask', sessionID: 'child-1' }),
        ])
      );
      flushSolid();
      expect(
        getStandalonePermissionPrompts([], stateModule.state.permissions, 'session-1')
      ).toEqual([expect.objectContaining({ id: 'perm-child-ask' })]);
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-child-ask' },
      });

      await hookModule.respondPermission('child-1', 'perm-child-ask', 'once');
      flushSolid();
      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
        'child-1',
        'perm-child-ask',
        'once'
      );
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('restores an actionable prompt when an automatic permission response fails', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.varroJudgePermission.mockResolvedValue({
      decision: 'allow',
      reason: 'Safe action.',
    });
    clientMocks.sessionRespondPermission
      .mockRejectedValueOnce(new Error('Permission backend unavailable'))
      .mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-response-failed'),
      });
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-response-failed',
            autoApproveReason:
              'Failed to apply the automatic decision: Permission backend unavailable',
          }),
        ])
      );
      flushSolid();
      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledTimes(1);
      expect(stateModule.state.sessionAutoPermissionCounts).toEqual({
        'session-1': { inFlight: 0, approved: 0, rejected: 0 },
      });
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-response-failed' },
      });

      await hookModule.respondPermission('session-1', 'perm-response-failed', 'once');
      flushSolid();
      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledTimes(2);
      expect(clientMocks.sessionRespondPermission).toHaveBeenLastCalledWith(
        'session-1',
        'perm-response-failed',
        'once'
      );
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('resolves the full session ancestry before handling an inherited auto permission', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.sessionGet.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'grandchild-1') {
        return { ...session('grandchild-1'), parentID: 'child-1' };
      }
      if (sessionId === 'child-1') {
        return { ...session('child-1'), parentID: 'session-1' };
      }
      throw new Error(`Unexpected session: ${sessionId}`);
    });
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-grandchild'), sessionID: 'grandchild-1' },
      });
      flushSolid();

      await vi.waitFor(() => {
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('grandchild-1', {
          directory: undefined,
        });
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('child-1', { directory: undefined });
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'allow', reason: 'Safe nested child action.' });
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'grandchild-1',
          'perm-grandchild',
          'once',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it.each([
    { userResponse: 'always' as const, judgeDecision: 'allow' as const, autoResponse: 'once' },
    { userResponse: 'reject' as const, judgeDecision: 'reject' as const, autoResponse: 'reject' },
  ])(
    'passes a confirmed $userResponse decision through the conversation tree and applies its $judgeDecision verdict',
    async ({ userResponse, judgeDecision, autoResponse }) => {
      const serverEventHandlers = captureServerEventHandlers();
      configureReconciliationMocks();
      clientMocks.permissionList.mockResolvedValue([]);
      clientMocks.sessionRespondPermission.mockResolvedValue(undefined);
      clientMocks.varroJudgePermission
        .mockResolvedValue({ decision: 'ask', reason: 'review' })
        .mockResolvedValueOnce({ decision: 'ask', reason: 'first call needs review' })
        .mockResolvedValueOnce({ decision: judgeDecision, reason: 'matches user decision' });

      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1' },
        ])
      );
      flushSolid();
      stateModule.setPermissionModeForSession('session-1', 'auto');
      flushSolid();
      const dispose = createRoot((cleanup) => {
        hookModule.useOpenCode();
        return cleanup;
      });
      flushSolid();

      try {
        serverEventHandlers.get('server.connected')?.({});
        flushSolid();
        await vi.waitFor(() => expect(serverEventHandlers.has('permission.asked')).toBe(true));
        flushSolid();

        serverEventHandlers.get('permission.asked')?.({
          properties: permissionListItem('perm-manual'),
        });
        flushSolid();
        await vi.waitFor(() =>
          expect(stateModule.state.permissions).toEqual([
            expect.objectContaining({ id: 'perm-manual' }),
          ])
        );
        flushSolid();

        await hookModule.respondPermission('session-1', 'perm-manual', userResponse);
        flushSolid();
        expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toEqual([
          expect.objectContaining({
            permissionId: 'perm-manual',
            status: userResponse === 'reject' ? 'manually-rejected' : 'manually-approved',
          }),
        ]);
        serverEventHandlers.get('permission.asked')?.({
          properties: { ...permissionListItem('perm-similar'), sessionID: 'child-1' },
        });
        flushSolid();

        await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(2));
        flushSolid();
        expect(clientMocks.varroJudgePermission.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({
            approvedReferences: [
              expect.objectContaining({
                type: 'bash',
                response: userResponse,
                pattern: '*',
              }),
            ],
          })
        );
        await vi.waitFor(() =>
          expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
            'child-1',
            'perm-similar',
            autoResponse,
            { permissionAutomationLease: 1 }
          )
        );
        flushSolid();
        expect(stateModule.state.permissions).not.toContainEqual(
          expect.objectContaining({ id: 'perm-similar' })
        );
        expect(stateModule.state.sessionAutoPermissionActivity['child-1']).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              permissionId: 'perm-similar',
              status: judgeDecision === 'allow' ? 'auto-approved' : 'auto-review-failed',
            }),
          ])
        );

        stateModule.setPermissionModeForSession('session-2', 'auto');
        flushSolid();
        serverEventHandlers.get('permission.asked')?.({
          properties: { ...permissionListItem('perm-other'), sessionID: 'session-2' },
        });
        flushSolid();
        await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(3));
        flushSolid();
        expect(clientMocks.varroJudgePermission.mock.calls[2]?.[0]).toEqual(
          expect.objectContaining({ approvedReferences: [] })
        );
      } finally {
        dispose();
        flushSolid();
      }
    }
  );

  it.each(['reject', 'once', 'always'] as const)(
    'scopes a confirmed %s reference correctly after a new root user message from another view',
    async (response) => {
      const serverEventHandlers = captureServerEventHandlers();
      configureReconciliationMocks();
      clientMocks.sessionRespondPermission.mockResolvedValue(undefined);
      clientMocks.varroJudgePermission.mockResolvedValue({ decision: 'ask', reason: 'review' });

      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1' },
          session('session-2'),
        ])
      );
      flushSolid();
      stateModule.setState(storePath('messages', [{ info: userMessage('user-first'), parts: [] }]));
      flushSolid();
      stateModule.setPermissionModeForSession('session-1', 'auto');
      flushSolid();
      stateModule.setPermissionModeForSession('session-2', 'auto');
      flushSolid();
      const dispose = createRoot((cleanup) => {
        hookModule.useOpenCode();
        return cleanup;
      });
      flushSolid();

      try {
        serverEventHandlers.get('permission.asked')?.({
          properties: { ...permissionListItem('perm-manual'), sessionID: 'child-1' },
        });
        flushSolid();
        await vi.waitFor(() => expect(stateModule.state.permissions).toHaveLength(1));
        flushSolid();
        await hookModule.respondPermission('child-1', 'perm-manual', response);
        flushSolid();

        // Unrelated conversations and subagent launch prompts do not start a new root turn.
        for (const sessionID of ['session-2', 'child-1']) {
          serverEventHandlers.get('message.updated')?.({
            properties: { info: { ...userMessage(`user-${sessionID}`), sessionID } },
          });
          flushSolid();
        }
        serverEventHandlers.get('permission.asked')?.({
          properties: permissionListItem('perm-same-turn'),
        });
        flushSolid();
        await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(2));
        flushSolid();
        expect(clientMocks.varroJudgePermission.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({
            approvedReferences: [expect.objectContaining({ response })],
          })
        );
        await vi.waitFor(() => expect(stateModule.state.permissions).toHaveLength(1));
        flushSolid();

        serverEventHandlers.get('message.updated')?.({
          properties: { info: userMessage('user-retry') },
        });
        flushSolid();
        serverEventHandlers.get('permission.asked')?.({
          properties: { ...permissionListItem('perm-retry'), sessionID: 'child-1' },
        });
        flushSolid();
        await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(3));
        flushSolid();
        expect(clientMocks.varroJudgePermission.mock.calls[2]?.[0]).toEqual(
          expect.objectContaining({
            approvedReferences:
              response === 'reject' ? [] : [expect.objectContaining({ response })],
          })
        );
        await vi.waitFor(() =>
          expect(stateModule.state.permissions).toContainEqual(
            expect.objectContaining({ id: 'perm-retry' })
          )
        );
        flushSolid();
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledTimes(1);
      } finally {
        dispose();
        flushSolid();
      }
    }
  );

  it.each(['manual reply', 'automatic review'] as const)(
    'does not carry a rejection into a new turn while its %s is pending',
    async (race) => {
      const serverEventHandlers = captureServerEventHandlers();
      configureReconciliationMocks();
      const reply = deferred<void>();
      const review = deferred<{ decision: 'reject'; reason: string }>();
      clientMocks.sessionRespondPermission.mockResolvedValue(undefined);
      if (race === 'manual reply') {
        clientMocks.sessionRespondPermission.mockReturnValueOnce(reply.promise);
      }
      clientMocks.varroJudgePermission.mockResolvedValue({ decision: 'ask', reason: 'review' });

      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setState(storePath('sessions', [session()]));
      flushSolid();
      stateModule.setState(storePath('messages', [{ info: userMessage('user-first'), parts: [] }]));
      flushSolid();
      stateModule.setPermissionModeForSession('session-1', 'auto');
      flushSolid();
      const dispose = createRoot((cleanup) => {
        hookModule.useOpenCode();
        return cleanup;
      });
      flushSolid();

      try {
        serverEventHandlers.get('permission.asked')?.({
          properties: permissionListItem('perm-manual'),
        });
        flushSolid();
        await vi.waitFor(() => expect(stateModule.state.permissions).toHaveLength(1));
        flushSolid();
        const rejection = hookModule.respondPermission('session-1', 'perm-manual', 'reject');
        await vi.waitFor(() => expect(clientMocks.sessionRespondPermission).toHaveBeenCalledOnce());
        flushSolid();

        if (race === 'automatic review') {
          await rejection;
          flushSolid();
          clientMocks.varroJudgePermission.mockReturnValueOnce(review.promise);
          serverEventHandlers.get('permission.asked')?.({
            properties: permissionListItem('perm-reviewing'),
          });
          flushSolid();
          await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(2));
          flushSolid();
        }
        flushSolid();

        serverEventHandlers.get('message.updated')?.({
          properties: { info: { ...userMessage('user-retry'), time: { created: 2 } } },
        });
        flushSolid();
        // A delayed update for the old prompt must not restore its rejection scope.
        serverEventHandlers.get('message.updated')?.({
          properties: { info: userMessage('user-first') },
        });
        flushSolid();
        if (race === 'manual reply') {
          reply.resolve();
          flushSolid();
          await rejection;
          flushSolid();
        } else {
          review.resolve({ decision: 'reject', reason: 'Matches the old rejection.' });
          flushSolid();
          await vi.waitFor(() =>
            expect(stateModule.state.permissions).toContainEqual(
              expect.objectContaining({
                id: 'perm-reviewing',
                autoApproveReason: expect.stringContaining('new user message'),
              })
            )
          );
          flushSolid();
          expect(stateModule.state.sessionAutoPermissionActivity['session-1']).toContainEqual(
            expect.objectContaining({ permissionId: 'perm-reviewing', status: 'approval-required' })
          );
        }
        flushSolid();

        serverEventHandlers.get('permission.asked')?.({
          properties: permissionListItem('perm-retry'),
        });
        flushSolid();
        await vi.waitFor(() =>
          expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(
            race === 'manual reply' ? 2 : 3
          )
        );
        flushSolid();
        expect(clientMocks.varroJudgePermission.mock.lastCall?.[0]).toEqual(
          expect.objectContaining({ approvedReferences: [] })
        );
        await vi.waitFor(() =>
          expect(
            stateModule.state.permissions.flatMap(
              (item) => item.groupMembers?.map((member) => member.id) ?? [item.id]
            )
          ).toContain('perm-retry')
        );
        flushSolid();
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledOnce();
        expect(stateModule.state.sessionAutoPermissionCounts['session-1']).toEqual({
          inFlight: 0,
          approved: 0,
          rejected: 0,
        });
      } finally {
        dispose();
        flushSolid();
      }
    }
  );

  it('rechecks an already-visible request after always approval records a preference', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([]);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);
    const recheck = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.varroJudgePermission
      .mockResolvedValue({ decision: 'ask', reason: 'review' })
      .mockResolvedValueOnce({ decision: 'ask', reason: 'first request needs review' })
      .mockResolvedValueOnce({ decision: 'ask', reason: 'second request needs review' })
      .mockReturnValueOnce(recheck.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(serverEventHandlers.has('permission.asked')).toBe(true));
      flushSolid();

      serverEventHandlers.get('permission.asked')?.({
        properties: {
          ...permissionListItem('perm-first'),
          permission: 'external_directory',
          patterns: '/external/path/one/*',
          title: 'external_directory /external/path/one/*',
          metadata: { filepath: '/external/path/one', parentDir: '/external/path' },
        },
      });
      flushSolid();
      serverEventHandlers.get('permission.asked')?.({
        properties: {
          ...permissionListItem('perm-second'),
          permission: 'external_directory',
          patterns: '/external/path/two/*',
          title: 'external_directory /external/path/two/*',
          metadata: { filepath: '/external/path/two', parentDir: '/external/path' },
        },
      });
      flushSolid();
      await vi.waitFor(() => {
        expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(2);
        expect(stateModule.state.permissions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'perm-first' }),
            expect.objectContaining({ id: 'perm-second' }),
          ])
        );
      });
      flushSolid();

      await hookModule.respondPermission('session-1', 'perm-first', 'always');
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(3));
      flushSolid();
      expect(stateModule.state.permissions).toContainEqual(
        expect.objectContaining({ id: 'perm-second' })
      );
      expect(clientMocks.varroJudgePermission.mock.calls[2]?.[0]).toEqual(
        expect.objectContaining({
          permission: expect.objectContaining({ id: 'perm-second' }),
          approvedReferences: [
            expect.objectContaining({
              type: 'external_directory',
              response: 'always',
              title: 'external_directory /external/path/one/*',
              metadata: { filepath: '/external/path/one', parentDir: '/external/path' },
            }),
          ],
        })
      );
      recheck.resolve({ decision: 'allow', reason: 'matches the always preference' });
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-second',
          'once',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.permissions).not.toContainEqual(
        expect.objectContaining({ id: 'perm-second' })
      );
    } finally {
      dispose();
      flushSolid();
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
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(1));
      flushSolid();

      stateModule.setPermissionModeForSession('session-1', 'default');
      flushSolid();
      resolveJudge?.({ decision: 'allow', reason: 'Allowed.' });
      flushSolid();

      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('responds to listed prompts without displaying them in full mode', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem()]);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setPermissionModeForSession('session-1', 'full');
    flushSolid();
    stateModule.addPermission(permission());
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();

      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-1',
          'once',
          { permissionAutomationLease: 1 }
        )
      );
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('keeps an optimistic full-mode request visible until the PATCH is confirmed', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const modeUpdate = deferred<ReturnType<typeof session>>();
    const reply = deferred<void>();
    clientMocks.varroSessionUpdatePermissionMode.mockReturnValue(modeUpdate.promise);
    clientMocks.sessionRespondPermission.mockReturnValue(reply.promise);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('sessions', [session('session-1')]));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      const update = hookModule.updatePermissionModeForSession('full', 'session-1');
      flushSolid();
      await vi.waitFor(() =>
        expect(clientMocks.varroSessionUpdatePermissionMode).toHaveBeenCalledWith(
          'session-1',
          'full',
          { directory: '/repo' }
        )
      );
      flushSolid();

      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-during-patch'),
      });
      flushSolid();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(stateModule.state.permissions).toContainEqual(
        expect.objectContaining({ id: 'perm-during-patch' })
      );

      modeUpdate.resolve(session('session-1'));
      await vi.waitFor(() => expect(clientMocks.sessionRespondPermission).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toContainEqual(
        expect.objectContaining({ id: 'perm-during-patch' })
      );
      reply.resolve();
      await update;
      flushSolid();
      expect(stateModule.state.permissions).toEqual([]);

      expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
        'session-1',
        'perm-during-patch',
        'once',
        { permissionAutomationLease: 1 }
      );
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('sweeps only effective-full request owners in the selected child subtree', async () => {
    configureReconciliationMocks();
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);
    clientMocks.varroSessionUpdatePermissionMode.mockResolvedValue({
      ...session('child-1'),
      parentID: 'root-1',
    });

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(
      storePath('sessions', [
        session('root-1'),
        { ...session('child-1'), parentID: 'root-1' },
        { ...session('sibling-1'), parentID: 'root-1' },
        { ...session('grandchild-1'), parentID: 'child-1' },
        { ...session('inheriting-grandchild'), parentID: 'child-1' },
      ])
    );
    flushSolid();
    stateModule.setPermissionModeForSession('root-1', 'auto');
    flushSolid();
    stateModule.setPermissionModeForSession('grandchild-1', 'default');
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      for (const [id, sessionID] of [
        ['perm-parent', 'root-1'],
        ['perm-child', 'child-1'],
        ['perm-sibling', 'sibling-1'],
        ['perm-restrictive', 'grandchild-1'],
        ['perm-inherited', 'inheriting-grandchild'],
      ] as const) {
        stateModule.addPermission({ ...permission(id), sessionID });
        flushSolid();
      }
      await hookModule.updatePermissionModeForSession('full', 'child-1');
      flushSolid();

      expect(clientMocks.sessionRespondPermission.mock.calls).toEqual([
        ['child-1', 'perm-child', 'once', { permissionAutomationLease: 1 }],
        ['inheriting-grandchild', 'perm-inherited', 'once', { permissionAutomationLease: 1 }],
      ]);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('does not re-add a permission answered while its list request is in flight', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const permissionList = deferred<ReturnType<typeof permissionListItem>[]>();
    clientMocks.permissionList.mockReturnValue(permissionList.promise);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.addPermission(permission('perm-answered'));
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      serverEventHandlers.get('server.connected')?.({});
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(1));
      flushSolid();

      await hookModule.respondPermission('session-1', 'perm-answered', 'once');
      flushSolid();
      permissionList.resolve([
        permissionListItem('perm-answered'),
        permissionListItem('perm-current'),
      ]);
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-current' }),
        ])
      );
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('applies desktop session pane side from config updates', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
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
    flushSolid();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });
    flushSolid();

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
        },
      });
      flushSolid();

      expect(stateModule.desktopSessionPaneSide()).toBe('right');
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('restores pending permission prompts from initial webview state after reload', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
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
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

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
      flushSolid();
      expect(stateModule.isSessionAwaitingInput('session-1')).toBe(true);
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('restores pending permission prompts that use permissionID after reload', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
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
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

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
      flushSolid();
      expect(stateModule.isSessionAwaitingInput('session-1')).toBe(true);
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('normalizes live permission events with nested tool metadata', async () => {
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    const serverEventHandlers = new Map<string, (data: ServerEvent) => void>();
    serverEventsOn.mockImplementation((event, handler) => {
      serverEventHandlers.set(event, handler);
      return () => {
        serverEventHandlers.delete(event);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1')]);
    clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);

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
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

      await vi.waitFor(() => {
        expect(serverEventHandlers.has('permission.asked')).toBe(true);
      });
      flushSolid();

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
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({
            id: 'perm-live-1',
            sessionID: 'session-1',
            type: 'apply_patch',
            messageID: 'message-1',
            callID: 'call-1',
          }),
        ])
      );
      flushSolid();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-live-1' },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });
});
