import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';
import type { onMessage } from '../lib/bridge';
import {
  captureBridgeHandler,
  captureServerEventHandlers,
  getBridgeMocks,
  getClientMocks,
  gpt4oProvider,
  loadAndMountUseOpenCode,
  loadModules,
  mountUseOpenCode,
  primaryAgent,
  session,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();

function setupInterruptedRecoveryClientMocks() {
  clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
  clientMocks.sessionList.mockResolvedValue([session('session-1')]);
  clientMocks.sessionStatus.mockResolvedValue({ 'session-1': { type: 'idle' } });
  clientMocks.agentList.mockResolvedValue([]);
  clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
  clientMocks.questionList.mockResolvedValue([]);
  clientMocks.sessionMessages.mockResolvedValue([{ info: userMessage('user-1'), parts: [] }]);
  clientMocks.sessionSendAsync.mockResolvedValue(undefined);
  clientMocks.sessionGet.mockResolvedValue(session('session-1'));
}

describe('useOpenCode initialization', () => {
  async function startupFixture() {
    let handle: Parameters<typeof onMessage>[0] | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      handle = handler;
      return () => {};
    });
    const events = captureServerEventHandlers();
    setupInterruptedRecoveryClientMocks();
    clientMocks.permissionList.mockResolvedValue([]);
    const modules = await loadModules();
    const dispose = mountUseOpenCode(modules.hookModule);
    return {
      ...modules,
      dispose,
      events,
      recover: (sessionId: string) => {
        if (!handle) throw new Error('Missing bridge handler');
        handle({
          type: 'recovery/interrupted-sessions',
          payload: { claimId: 99, sessionIds: [sessionId] },
        });
      },
      start: () => {
        if (!handle) throw new Error('Missing bridge handler');
        handle({
          type: 'server/status',
          payload: { state: 'running', url: 'http://127.0.0.1:4096' },
        });
      },
    };
  }

  it('exposes restored chat without waiting for a permission judge or reply', async () => {
    const fixture = await startupFixture();
    flushSolid();
    const permission = {
      id: 'perm-startup',
      type: 'bash',
      sessionID: 'session-1',
      messageID: 'message-1',
      title: 'Run command',
      metadata: {},
      time: { created: 1 },
    };
    fixture.stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    clientMocks.permissionList.mockResolvedValue([permission]);
    let finishJudge!: (verdict: { decision: 'ask'; reason: string }) => void;
    clientMocks.varroJudgePermission.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishJudge = resolve;
        })
    );
    try {
      fixture.recover('session-1');
      fixture.start();
      flushSolid();
      await vi.waitFor(() => expect(fixture.stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce();
      expect(clientMocks.sessionRespondPermission).not.toHaveBeenCalled();
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
      finishJudge({ decision: 'ask', reason: 'Please review' });
      await vi.waitFor(() =>
        expect(fixture.stateModule.state.permissions).toContainEqual(
          expect.objectContaining({ id: permission.id })
        )
      );
      flushSolid();
    } finally {
      fixture.dispose();
      flushSolid();
    }
  });

  it('keeps unknown child ancestry visible without blocking readiness or resuming its root', async () => {
    const fixture = await startupFixture();
    flushSolid();
    fixture.stateModule.setPermissionModeForSession('session-1', 'auto');
    flushSolid();
    clientMocks.permissionList.mockResolvedValue([
      {
        id: 'perm-child',
        type: 'bash',
        sessionID: 'unknown-child',
        messageID: 'message-child',
        title: 'Run command',
        metadata: {},
        time: { created: 1 },
      },
    ]);
    let finishChild!: (value: ReturnType<typeof session>) => void;
    clientMocks.sessionGet.mockImplementation((id: string) =>
      id === 'unknown-child'
        ? new Promise((resolve) => {
            finishChild = resolve;
          })
        : Promise.resolve(session(id))
    );
    clientMocks.varroJudgePermission.mockResolvedValue({
      decision: 'ask',
      reason: 'Please review',
    });
    try {
      fixture.recover('session-1');
      fixture.start();
      flushSolid();
      await vi.waitFor(() => expect(fixture.stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      expect(fixture.stateModule.state.permissions).toContainEqual(
        expect.objectContaining({ id: 'perm-child' })
      );
      expect(clientMocks.sessionSendAsync).not.toHaveBeenCalled();
      expect(clientMocks.varroJudgePermission).not.toHaveBeenCalled();
      finishChild({ ...session('unknown-child'), parentID: 'session-1' });
      await vi.waitFor(() => expect(clientMocks.varroJudgePermission).toHaveBeenCalledOnce());
      flushSolid();
    } finally {
      fixture.dispose();
      flushSolid();
    }
  });

  it('keeps failed restored history uninitialized and retries hydration for its active ID', async () => {
    const fixture = await startupFixture();
    flushSolid();
    clientMocks.sessionMessages.mockRejectedValueOnce(new Error('503 history unavailable'));
    try {
      fixture.start();
      flushSolid();
      await vi.waitFor(() =>
        expect(fixture.stateModule.error()).toContain('Failed to restore OpenCode session:')
      );
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(false);
      expect(fixture.stateModule.state.activeSessionId).toBe('session-1');
      expect(fixture.stateModule.state.messagesLoading).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSolid();
      fixture.stateModule.errorRetry()?.();
      await vi.waitFor(() => expect(fixture.stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      expect(clientMocks.sessionMessages).toHaveBeenCalledTimes(2);
      expect(fixture.stateModule.error()).toBeNull();
    } finally {
      fixture.dispose();
      flushSolid();
    }
  });

  it('starts status loading with catalogs and reuses that snapshot for restoration', async () => {
    const fixture = await startupFixture();
    flushSolid();
    let finishCatalog!: (sessions: ReturnType<typeof session>[]) => void;
    clientMocks.sessionList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCatalog = resolve;
        })
    );
    try {
      fixture.start();
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionStatus).toHaveBeenCalledOnce());
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(false);
      finishCatalog([session('session-1')]);
      await vi.waitFor(() => expect(fixture.stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      expect(clientMocks.sessionStatus).toHaveBeenCalledOnce();
    } finally {
      fixture.dispose();
      flushSolid();
    }
  });

  it('retries failed essential data without a new server status or a restart', async () => {
    const fixture = await startupFixture();
    flushSolid();
    clientMocks.questionList.mockRejectedValueOnce(new Error('snapshot unavailable'));
    try {
      fixture.start();
      flushSolid();
      await vi.waitFor(() => expect(fixture.stateModule.error()).toContain('startup data'));
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSolid();
      const retry = fixture.stateModule.errorRetry();
      expect(retry).toBeTypeOf('function');
      retry?.();
      await vi.waitFor(() => expect(fixture.stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      expect(fixture.stateModule.error()).toBeNull();
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'server/restart' })
      );
    } finally {
      fixture.dispose();
      flushSolid();
    }
  });

  it('shows plugin activation waiting and recovers startup without restarting the server', async () => {
    const fixture = await startupFixture();
    flushSolid();
    vi.useFakeTimers();
    clientMocks.providerList
      .mockRejectedValueOnce(new Error('503 Location plugins did not finish activating'))
      .mockRejectedValueOnce(new Error('503 Location plugins did not finish activating'));
    try {
      fixture.start();
      flushSolid();
      await vi.advanceTimersByTimeAsync(0);
      flushSolid();
      expect(fixture.stateModule.startupWaitingForPlugins()).toBe(true);
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(true);
      expect(fixture.stateModule.startupWaitingForPlugins()).toBe(false);
      flushSolid();
      expect(fixture.stateModule.error()).toBeNull();
      expect(clientMocks.health).toHaveBeenCalledOnce();
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'server/restart' })
      );
    } finally {
      fixture.dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('retains expired activation errors and offers initialization retry on the healthy server', async () => {
    const fixture = await startupFixture();
    flushSolid();
    vi.useFakeTimers();
    clientMocks.providerList.mockRejectedValue(
      new Error('503 Location plugins did not finish activating')
    );
    try {
      fixture.start();
      flushSolid();
      await vi.advanceTimersByTimeAsync(60_000);
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(false);
      expect(fixture.stateModule.startupWaitingForPlugins()).toBe(false);
      flushSolid();
      expect(fixture.stateModule.error()).toBe(
        'Failed to load OpenCode startup data: Could not load routing catalogs: 503 Location plugins did not finish activating'
      );
      expect(fixture.stateModule.state.serverStatus.state).toBe('running');
      const retry = fixture.stateModule.errorRetry();
      expect(retry).toBeTypeOf('function');
      clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
      retry?.();
      await vi.advanceTimersByTimeAsync(0);
      flushSolid();
      expect(fixture.stateModule.connectionInitialized()).toBe(true);
      expect(fixture.stateModule.error()).toBeNull();
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'server/restart' })
      );
    } finally {
      fixture.dispose();
      flushSolid();
      vi.useRealTimers();
    }
  });

  it('does not supersede essential bootstrap when SSE connects while snapshots are loading', async () => {
    const fixture = await startupFixture();
    flushSolid();
    let finishCatalog!: (sessions: ReturnType<typeof session>[]) => void;
    clientMocks.sessionList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatalog = resolve;
        })
    );
    try {
      fixture.start();
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionList).toHaveBeenCalledOnce());
      flushSolid();
      fixture.events.get('server.connected')?.({});
      await Promise.resolve();
      flushSolid();
      expect(clientMocks.sessionList).toHaveBeenCalledOnce();
      expect(fixture.stateModule.connectionInitialized()).toBe(false);
      finishCatalog([session('session-1')]);
      await vi.waitFor(() => expect(fixture.stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.sessionList).toHaveBeenCalledTimes(2));
      flushSolid();
    } finally {
      fixture.dispose();
      flushSolid();
    }
  });

  it('identifies each recreated webview even when VS Code reuses its initial HTML', async () => {
    // SAFETY: VS Code reuses this host state when moving an editor to another window.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      documentId: 7,
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
    };

    for (let windowIndex = 0; windowIndex < 2; windowIndex += 1) {
      vi.resetModules();
      flushSolid();
      const { hookModule } = await loadModules();
      flushSolid();
      const dispose = mountUseOpenCode(hookModule);
      flushSolid();
      dispose();
      flushSolid();
    }

    const readyMessages = bridgeMocks.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'ready');
    expect(readyMessages).toHaveLength(2);
    for (const message of readyMessages) {
      expect(message.payload).toEqual({ documentId: 7, instanceId: expect.any(String) });
    }
    expect(readyMessages[0]?.payload?.instanceId).not.toBe(readyMessages[1]?.payload?.instanceId);
  });

  it('does not overwrite an authoritative editor queue during startup', async () => {
    // SAFETY: The fixture provides the initial host state read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      queuedMessages: [],
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
    };
    window.localStorage.setItem(
      'varro.queuedMessages',
      JSON.stringify([{ id: 'stale', sessionId: 'session-1', text: 'Stale queue' }])
    );
    flushSolid();

    const { hookModule } = await loadModules();
    flushSolid();
    const dispose = mountUseOpenCode(hookModule);
    flushSolid();

    try {
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queued-messages/update' })
      );
    } finally {
      dispose();
      flushSolid();
      window.localStorage.removeItem('varro.queuedMessages');
      flushSolid();
    }
  });

  it('sends session model migration values as structured-cloneable objects', async () => {
    // SAFETY: The fixture provides the initial host state read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      sessionModelMigrationPending: true,
      webviewContext: {
        viewId: 'sidebar',
        surface: 'sidebar',
        initialRoute: { type: 'new-session' },
      },
    };
    window.localStorage.setItem(
      'varro.sessionSelectedModels',
      JSON.stringify({
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' },
      })
    );
    flushSolid();

    const { hookModule } = await loadModules();
    flushSolid();
    const dispose = mountUseOpenCode(hookModule);
    flushSolid();

    try {
      const migration = bridgeMocks.postMessage.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === 'session-models/migrate');
      expect(migration).toEqual({
        type: 'session-models/migrate',
        payload: {
          models: {
            'session-1': { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' },
          },
        },
      });
      expect(() => structuredClone(migration)).not.toThrow();
    } finally {
      dispose();
      flushSolid();
      window.localStorage.removeItem('varro.sessionSelectedModels');
      flushSolid();
    }
  });

  it('sends legacy permission modes through the set-if-absent migration message', async () => {
    // SAFETY: The fixture provides the initial host state read by the runtime.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'sidebar',
        surface: 'sidebar',
        initialRoute: { type: 'new-session' },
      },
      sessionPermissionModes: { 'session-current': 'auto' },
    };
    window.localStorage.setItem(
      'varro.sessionPermissionModes',
      JSON.stringify({ 'session-current': 'full', 'session-legacy': 'edits' })
    );
    flushSolid();

    const { hookModule } = await loadModules();
    flushSolid();
    const dispose = mountUseOpenCode(hookModule);
    flushSolid();

    try {
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'permission-modes/migrate',
        payload: { modes: { 'session-legacy': 'default' } },
      });
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'permission-mode/update' })
      );
    } finally {
      dispose();
      flushSolid();
      window.localStorage.removeItem('varro.sessionPermissionModes');
      flushSolid();
    }
  });

  it('reconciles restored permissions during startup', async () => {
    const bridge = captureBridgeHandler();

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.permissionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.addPermission({
      id: 'perm-stale',
      type: 'bash',
      sessionID: 'session-1',
      messageID: 'message-1',
      title: 'Run command',
      metadata: {},
      time: { created: 1 },
    });
    flushSolid();
    const dispose = mountUseOpenCode(hookModule);
    flushSolid();

    try {
      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.permissionList).toHaveBeenCalledTimes(1));
      flushSolid();
      await vi.waitFor(() => expect(stateModule.state.permissions).toEqual([]));
      flushSolid();
      expect(stateModule.connectionInitialized()).toBe(true);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it.each(['ask', 'plan', 'custom'])('restores %s on startup', async (savedAgent) => {
    const bridge = captureBridgeHandler();

    window.localStorage.setItem('varro.selectedAgent', JSON.stringify(savedAgent));
    flushSolid();

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([primaryAgent('build'), primaryAgent(savedAgent)]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

      await vi.waitFor(() => expect(stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      expect(stateModule.state.selectedAgent).toBe(savedAgent);
      expect(stateModule.getPersistedSelectedAgent()).toBe(savedAgent);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('hydrates 429 retry status for listed sessions before any session is opened', async () => {
    const bridge = captureBridgeHandler();

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([session('session-1'), session('session-2')]);
    clientMocks.sessionStatus.mockResolvedValue({
      'session-1': {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached',
        next: 8,
      },
      'session-2': { type: 'idle' },
    });
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();
      await vi.waitFor(() => {
        expect(clientMocks.sessionStatus).toHaveBeenCalledTimes(1);
      });
      flushSolid();
      await vi.waitFor(() => {
        expect(stateModule.state.sessionStatus['session-1']).toEqual({
          type: 'retry',
          attempt: 2,
          message: '429 usage limit reached',
          next: 8,
        });
        expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
          statusCode: 429,
          message: '429 usage limit reached',
          attempt: 2,
          sessionID: 'session-1',
        });
      });
      flushSolid();
      expect(clientMocks.sessionGet).not.toHaveBeenCalled();
      expect(clientMocks.sessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('retries startup after an initial connection failure', async () => {
    const bridge = captureBridgeHandler();

    clientMocks.health.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      healthy: true,
      version: '1.0.0',
    });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();
      await vi.waitFor(() =>
        expect(stateModule.error()).toBe('Failed to connect to OpenCode server: offline')
      );
      flushSolid();
      // Initialization owns its final cleanup even after publishing the failure.
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSolid();
      expect(clientMocks.health).toHaveBeenCalledTimes(1);

      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();
      await vi.waitFor(() => expect(clientMocks.health).toHaveBeenCalledTimes(2));
      flushSolid();
      await vi.waitFor(() => expect(stateModule.connectionInitialized()).toBe(true));
      flushSolid();
      await vi.waitFor(() => expect(stateModule.error()).toBeNull());
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('continues sessions interrupted by a server restart or extension reload', async () => {
    const bridge = captureBridgeHandler();

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

    const { hookModule } = await loadModules();
    flushSolid();
    const dispose = mountUseOpenCode(hookModule);
    flushSolid();

    try {
      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

      await vi.waitFor(() => {
        expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith(
          'session-1',
          {
            agent: 'build',
            messageID: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
            parts: [
              {
                type: 'text',
                text: 'Continue from where you were interrupted by the server restart or extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.',
              },
            ],
          },
          { directory: '/repo', interruptedRecovery: true }
        );
      });
      flushSolid();
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('processes a recovery claim delivered before connection bootstrap before acknowledging it', async () => {
    const bridge = captureBridgeHandler();
    setupInterruptedRecoveryClientMocks();
    flushSolid();

    const { hookModule } = await loadModules();
    flushSolid();
    const dispose = mountUseOpenCode(hookModule);
    flushSolid();

    try {
      bridge.send({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 7, sessionIds: ['session-1'] },
      });
      flushSolid();
      expect(bridgeMocks.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recovery/interrupted-sessions-ack' })
      );

      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.sessionSendAsync).toHaveBeenCalledTimes(1));
      flushSolid();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions-ack',
        payload: { claimId: 7, consumedSessionIds: ['session-1'] },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('processes and acknowledges a recovery claim delivered after bootstrap', async () => {
    const bridge = captureBridgeHandler();
    setupInterruptedRecoveryClientMocks();
    flushSolid();

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      bridge.send({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      flushSolid();
      await vi.waitFor(() => expect(stateModule.connectionInitialized()).toBe(true));
      flushSolid();

      bridge.send({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 8, sessionIds: ['session-1'] },
      });
      flushSolid();

      await vi.waitFor(() => expect(clientMocks.sessionSendAsync).toHaveBeenCalledTimes(1));
      flushSolid();
      expect(bridgeMocks.postMessage).toHaveBeenCalledWith({
        type: 'recovery/interrupted-sessions-ack',
        payload: { claimId: 8, consumedSessionIds: ['session-1'] },
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it.each([
    { storedProvider: 'openai', metadataProvider: 'anthropic', polls: true },
    { storedProvider: 'anthropic', metadataProvider: 'openai', polls: false },
    { storedProvider: null, metadataProvider: 'openai', polls: true },
    { storedProvider: null, metadataProvider: null, polls: false },
  ])(
    'infers hidden background provider activity without using the composer: %j',
    async ({ storedProvider, metadataProvider, polls }) => {
      vi.useFakeTimers();
      const originalVisibility = document.visibilityState;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      clientMocks.providerLimit.mockResolvedValue(null);
      const { stateModule, dispose } = await loadAndMountUseOpenCode();
      try {
        await Promise.resolve();
        flushSolid();
        stateModule.setState(storePath('serverStatus', { state: 'running' }));
        flushSolid();
        stateModule.setState(storePath('providers', [gpt4oProvider()]));
        flushSolid();
        stateModule.setState(
          storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' })
        );
        flushSolid();
        const background = session('background');
        if (metadataProvider) background.model = { providerID: metadataProvider, id: 'old-model' };
        stateModule.setState(storePath('sessions', [background]));
        flushSolid();
        if (storedProvider) {
          stateModule.setState(
            storePath('sessionSelectedModels', 'background', {
              providerID: storedProvider,
              modelID: 'new-model',
            })
          );
          flushSolid();
        }
        flushSolid();
        stateModule.setState(storePath('sessionStatus', 'background', { type: 'busy' }));
        flushSolid();
        stateModule.setState(storePath('providersLoaded', true));
        flushSolid();
        await vi.advanceTimersByTimeAsync(20_000);
        flushSolid();
        const calls = clientMocks.providerLimit.mock.calls.length;
        expect(calls).toBe(polls ? 1 : 0);
        stateModule.setState(
          storePath('sessionStatus', 'background', {
            type: 'retry',
            attempt: 1,
            message: 'Retrying',
            next: 1000,
          })
        );
        flushSolid();
        await vi.advanceTimersByTimeAsync(10_000);
        flushSolid();
        expect(clientMocks.providerLimit).toHaveBeenCalledTimes(polls ? 2 : 0);
        if (polls) expect(clientMocks.providerLimit).toHaveBeenLastCalledWith('openai', 'gpt-4o');
      } finally {
        dispose();
        flushSolid();
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: originalVisibility,
        });
        vi.useRealTimers();
      }
    }
  );

  it('refreshes provider limits after the webview becomes visible again', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [gpt4oProvider({ toolcall: true, vision: true })],
      default: { openai: 'gpt-4o' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();
      stateModule.setState(
        storePath('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' })
      );
      flushSolid();
      stateModule.setState(
        storePath('providers', [gpt4oProvider({ toolcall: true, vision: true })])
      );
      flushSolid();
      stateModule.setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
      flushSolid();
      stateModule.setState(storePath('providersLoaded', true));
      flushSolid();

      expect(clientMocks.providerLimit).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(clientMocks.providerLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
      flushSolid();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('continues provider-limit refresh polling after an unsupported response', async () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [gpt4oProvider({ toolcall: true, vision: true })],
      default: { openai: 'gpt-4o' },
    });
    clientMocks.providerLimit.mockResolvedValue({
      providerID: 'openai',
      modelID: 'gpt-4o',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'Unsupported',
    });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();
      stateModule.setState(
        storePath('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' })
      );
      flushSolid();
      stateModule.setState(
        storePath('providers', [gpt4oProvider({ toolcall: true, vision: true })])
      );
      flushSolid();
      stateModule.setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
      flushSolid();
      stateModule.setState(storePath('providersLoaded', true));
      flushSolid();

      await vi.waitFor(() => {
        expect(clientMocks.providerLimit.mock.calls.length).toBeGreaterThan(0);
      });
      flushSolid();
      const callsBeforeVisibilityChange = clientMocks.providerLimit.mock.calls.length;

      stateModule.setState(
        storePath('providerLimits', {
          'openai:gpt-4o': {
            providerID: 'openai',
            modelID: 'gpt-4o',
            status: 'unsupported',
            source: 'provider',
            checkedAt: 1,
            note: 'Unsupported',
          },
        })
      );
      flushSolid();

      document.dispatchEvent(new Event('visibilitychange'));
      flushSolid();
      await Promise.resolve();
      flushSolid();

      await vi.waitFor(() => {
        expect(clientMocks.providerLimit.mock.calls.length).toBeGreaterThan(
          callsBeforeVisibilityChange
        );
      });
      flushSolid();
    } finally {
      dispose();
      flushSolid();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });
});
