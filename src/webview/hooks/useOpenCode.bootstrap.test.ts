import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  getBridgeMocks,
  getClientMocks,
  loadModules,
  provider,
  session,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();
const bridgeMocks = getBridgeMocks();

describe('useOpenCode initialization', () => {
  it('defaults the extension toolbar agent to build on startup', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    window.localStorage.setItem('varro.selectedAgent', JSON.stringify('plan'));

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.agentList.mockResolvedValue([
      {
        name: 'build',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
      {
        name: 'plan',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'ask', bash: {} },
        tools: {},
      },
    ]);
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
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });

      await vi.waitFor(() => {
        expect(stateModule.state.selectedAgent).toBe('build');
      });
      expect(stateModule.getPersistedSelectedAgent()).toBe('plan');
    } finally {
      dispose();
    }
  });

  it('hydrates 429 retry status for listed sessions before any session is opened', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

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
        expect(clientMocks.sessionStatus).toHaveBeenCalledTimes(1);
      });
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
      expect(clientMocks.sessionGet).not.toHaveBeenCalled();
      expect(clientMocks.sessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('retries startup after an initial connection failure', async () => {
    let bridgeHandler: ((message: { type: string; payload?: unknown }) => void) | undefined;
    bridgeMocks.onMessage.mockImplementation((handler) => {
      bridgeHandler = handler as typeof bridgeHandler;
      return () => {
        bridgeHandler = undefined;
      };
    });

    clientMocks.health.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      healthy: true,
      version: '1.0.0',
    });
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
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(clientMocks.health).toHaveBeenCalledTimes(1);
      expect(stateModule.error()).toBe('Failed to connect to OpenCode server: offline');

      bridgeHandler({
        type: 'server/status',
        payload: { state: 'running', url: 'http://127.0.0.1:4096' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(clientMocks.health).toHaveBeenCalledTimes(2);
      expect(stateModule.error()).toBeNull();
    } finally {
      dispose();
    }
  });

  it('continues sessions that were interrupted by extension reload', async () => {
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
        expect(clientMocks.sessionSendAsync).toHaveBeenCalledWith('session-1', {
          agent: 'build',
          parts: [
            {
              type: 'text',
              text: 'Continue from where you were interrupted before the extension reload. Review the existing conversation, do not repeat completed work, and proceed with the next unfinished step.',
            },
          ],
        });
      });
    } finally {
      dispose();
    }
  });

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
      providers: [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
      default: { openai: 'gpt-4o' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();
      stateModule.setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
      stateModule.setState('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ]);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
      stateModule.setState('providersLoaded', true);

      expect(clientMocks.providerLimit).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();

      expect(clientMocks.providerLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
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
      providers: [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
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

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();
      stateModule.setState('serverStatus', { state: 'running', url: 'http://127.0.0.1:4096' });
      stateModule.setState('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ]);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o' });
      stateModule.setState('providersLoaded', true);

      await vi.waitFor(() => {
        expect(clientMocks.providerLimit.mock.calls.length).toBeGreaterThan(0);
      });
      const callsBeforeVisibilityChange = clientMocks.providerLimit.mock.calls.length;

      stateModule.setState('providerLimits', {
        'openai:gpt-4o': {
          providerID: 'openai',
          modelID: 'gpt-4o',
          status: 'unsupported',
          source: 'provider',
          checkedAt: 1,
          note: 'Unsupported',
        },
      });

      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();

      await vi.waitFor(() => {
        expect(clientMocks.providerLimit.mock.calls.length).toBeGreaterThan(
          callsBeforeVisibilityChange
        );
      });
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });
});
