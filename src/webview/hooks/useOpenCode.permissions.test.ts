import { createRoot } from 'solid-js';
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

  it('hides a restored permission and its attention status until the judge asks', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([permissionListItem('perm-restored')]);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    const { deriveSessionIndicators } = await import('../components/chat/SessionListView');
    stateModule.setState('sessions', [session('session-1')]);
    stateModule.setPermissionModeForSession('session-1', 'auto');
    stateModule.addPermission(permission('perm-restored'));
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toEqual([]);
      expect(deriveSessionIndicators(stateModule.state.sessions).attentionIds).not.toContain(
        'session-1'
      );

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
      expect(deriveSessionIndicators(stateModule.state.sessions).attentionIds).toContain(
        'session-1'
      );
    } finally {
      dispose();
    }
  });

  it('hides a restored child permission before its inherited auto mode is known', async () => {
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
    stateModule.setState('sessions', [session('session-1')]);
    stateModule.setPermissionModeForSession('session-1', 'auto');
    stateModule.addPermission({
      ...permission('perm-restored-child'),
      sessionID: 'child-1',
    });
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      expect(stateModule.state.permissions).toEqual([]);
      serverEventHandlers.get('server.connected')?.({});

      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored-child', sessionID: 'child-1' }),
        ])
      );
    } finally {
      dispose();
    }
  });

  it('ignores a late judge result after the permission is no longer pending', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockResolvedValue([]);
    const judge = deferred<{ decision: 'ask'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);

    const { stateModule, hookModule } = await loadModules();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-canceled'),
      });
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());

      serverEventHandlers.get('server.connected')?.({});
      await vi.waitFor(() =>
        expect(stateModule.getPermissionReconciliationMetadataSize().activeReconciliations).toBe(0)
      );

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
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
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('server.connected')?.({});
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledOnce());

      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-current'),
      });
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      pendingPermissions.resolve([]);
      await vi.waitFor(() =>
        expect(stateModule.getPermissionReconciliationMetadataSize().activeReconciliations).toBe(0)
      );

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-current' }),
        ])
      );
    } finally {
      dispose();
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
    const { deriveSessionIndicators } = await import('../components/chat/SessionListView');
    stateModule.setState('sessions', [session('session-1')]);
    stateModule.setPermissionModeForSession('session-1', 'auto');
    stateModule.addPermission(permission('perm-restored'));
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      expect(stateModule.state.permissions).toEqual([]);
      expect(deriveSessionIndicators(stateModule.state.sessions).attentionIds).not.toContain(
        'session-1'
      );

      serverEventHandlers.get('server.connected')?.({});
      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toEqual([]);

      pendingPermissions.resolve([permissionListItem('perm-restored')]);
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'ask', reason: 'Needs confirmation.' });
      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
    } finally {
      dispose();
    }
  });

  it('restores a hidden auto-mode permission when permission sync fails', async () => {
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    clientMocks.permissionList.mockRejectedValue(new Error('Permission list failed'));

    const { stateModule, hookModule } = await loadModules();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    stateModule.addPermission(permission('perm-restored'));
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      expect(stateModule.state.permissions).toEqual([]);
      serverEventHandlers.get('server.connected')?.({});

      await vi.waitFor(() =>
        expect(stateModule.state.permissions).toEqual([
          expect.objectContaining({ id: 'perm-restored' }),
        ])
      );
    } finally {
      dispose();
    }
  });

  it('keeps an unanswered permission hidden until the judge allows it', async () => {
    vi.useFakeTimers();
    const serverEventHandlers = captureServerEventHandlers();
    configureReconciliationMocks();
    const judge = deferred<{ decision: 'allow'; reason: string }>();
    clientMocks.varroJudgePermission.mockReturnValue(judge.promise);
    clientMocks.sessionRespondPermission.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: permissionListItem('perm-timeout'),
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce();
      expect(stateModule.state.permissions).toEqual([]);

      await vi.advanceTimersByTimeAsync(AUTO_APPROVE_JUDGE_TIMEOUT_MS - 1);
      expect(stateModule.state.permissions).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'allow', reason: 'Late approval.' });
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'session-1',
          'perm-timeout',
          'once'
        )
      );
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
      vi.useRealTimers();
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
    stateModule.setState('sessions', [session('session-1')]);
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-child'), sessionID: 'child-1' },
      });

      await vi.waitFor(() => expect(clientMocks.sessionGet).toHaveBeenCalledWith('child-1'));
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      expect(stateModule.state.permissions).toEqual([]);

      childSession.resolve({ ...session('child-1'), parentID: 'session-1' });
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'allow', reason: 'Safe child action.' });
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'child-1',
          'perm-child',
          'once'
        )
      );
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
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
    stateModule.setState('sessions', [session('session-1')]);
    stateModule.setPermissionModeForSession('session-1', 'auto');
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      serverEventHandlers.get('permission.asked')?.({
        properties: { ...permissionListItem('perm-grandchild'), sessionID: 'grandchild-1' },
      });

      await vi.waitFor(() => {
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('grandchild-1');
        expect(clientMocks.sessionGet).toHaveBeenCalledWith('child-1');
      });
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      expect(stateModule.state.permissions).toEqual([]);

      judge.resolve({ decision: 'allow', reason: 'Safe nested child action.' });
      await vi.waitFor(() =>
        expect(clientMocks.sessionRespondPermission).toHaveBeenCalledWith(
          'grandchild-1',
          'perm-grandchild',
          'once'
        )
      );
      expect(stateModule.state.permissions).toEqual([]);
    } finally {
      dispose();
    }
  });

  it.each([
    { userResponse: 'always' as const, judgeDecision: 'allow' as const, autoResponse: 'once' },
    { userResponse: 'reject' as const, judgeDecision: 'reject' as const, autoResponse: 'reject' },
  ])(
    'passes a confirmed $userResponse decision to the judge and applies its $judgeDecision verdict',
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
      stateModule.setPermissionModeForSession('session-1', 'auto');
      const dispose = createRoot((cleanup) => {
        hookModule.useOpenCode();
        return cleanup;
      });

      try {
        serverEventHandlers.get('server.connected')?.({});
        await vi.waitFor(() => expect(serverEventHandlers.has('permission.asked')).toBe(true));

        serverEventHandlers.get('permission.asked')?.({
          properties: permissionListItem('perm-manual'),
        });
        await vi.waitFor(() =>
          expect(stateModule.state.permissions).toEqual([
            expect.objectContaining({ id: 'perm-manual' }),
          ])
        );

        await hookModule.respondPermission('session-1', 'perm-manual', userResponse);
        serverEventHandlers.get('permission.asked')?.({
          properties: permissionListItem('perm-similar'),
        });

        await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(2));
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
            'session-1',
            'perm-similar',
            autoResponse
          )
        );
        expect(stateModule.state.permissions).not.toContainEqual(
          expect.objectContaining({ id: 'perm-similar' })
        );

        stateModule.setPermissionModeForSession('session-2', 'auto');
        serverEventHandlers.get('permission.asked')?.({
          properties: { ...permissionListItem('perm-other'), sessionID: 'session-2' },
        });
        await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledTimes(3));
        expect(clientMocks.varroJudgePermission.mock.calls[2]?.[0]).toEqual(
          expect.objectContaining({ approvedReferences: [] })
        );
      } finally {
        dispose();
      }
    }
  );

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
    const permissionList = deferred<ReturnType<typeof permissionListItem>[]>();
    clientMocks.permissionList.mockReturnValue(permissionList.promise);
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
      permissionList.resolve([
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
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      if (!bridgeHandler) throw new Error('Expected webview bridge handler to be registered');

      bridgeHandler({
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: 'right',
          defaultPermissionMode: 'default',
        },
      });

      expect(stateModule.desktopSessionPaneSide()).toBe('right');
    } finally {
      dispose();
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
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
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
    let bridgeHandler: Parameters<BridgeOnMessage>[0] | undefined;
    bridgeOnMessage.mockImplementation((handler) => {
      bridgeHandler = handler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    const serverEventHandlers = new Map<string, (data: unknown) => void>();
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
    } finally {
      dispose();
    }
  });
});
