import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';
import {
  captureBridgeHandler,
  captureServerEventHandlers,
  getClientMocks,
  gpt4oProvider,
  loadAndMountUseOpenCode,
  loadModules,
  provider,
  session,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();

describe('useOpenCode session control flows', () => {
  it('stops a captured child without using tree abort or modifying parent and sibling status', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    const root = session('root');
    const child = { ...session('child-a'), parentID: 'root' };
    const sibling = { ...session('child-b'), parentID: 'root' };
    clientMocks.sessionStatus.mockResolvedValue({
      root: { type: 'busy' },
      'child-b': { type: 'busy' },
    });
    clientMocks.sessionGet.mockImplementation(async (id: string) =>
      [root, child, sibling].find((entry) => entry.id === id)
    );
    clientMocks.sessionMessages.mockResolvedValue([]);
    clientMocks.interruptChild.mockResolvedValue({ interrupted: true });
    clientMocks.permissionList.mockResolvedValue([]);
    clientMocks.questionList.mockResolvedValue([]);
    stateModule.setState(storePath('sessions', [root, child, sibling]));
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'root'));
    flushSolid();
    stateModule.setState(
      storePath('sessionStatus', {
        root: { type: 'busy' },
        'child-a': { type: 'busy' },
        'child-b': { type: 'busy' },
      })
    );
    flushSolid();
    await hookModule.manageChildTask('child-a', 'stop');
    flushSolid();
    expect(clientMocks.interruptChild).toHaveBeenCalledWith('child-a', child.directory);
    expect(clientMocks.sessionAbort).not.toHaveBeenCalled();
    expect(stateModule.state.sessionStatus.root).toEqual({ type: 'busy' });
    expect(stateModule.state.sessionStatus['child-b']).toEqual({ type: 'busy' });
    expect(clientMocks.permissionList).toHaveBeenCalled();
    expect(clientMocks.questionList).toHaveBeenCalled();
  });
  it('handles a rejected abort requested by the command bridge', async () => {
    const bridge = captureBridgeHandler();
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionStatus.mockResolvedValue({});
    clientMocks.sessionAbort.mockRejectedValue(new Error('abort failed'));

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();
      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      bridge.send({ type: 'command/abort' });
      flushSolid();

      await vi.waitFor(() =>
        expect(stateModule.error()).toBe('Failed to stop the run: abort failed')
      );
      flushSolid();
      expect(stateModule.state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('ignores stale retry status updates after aborting a retrying session', async () => {
    const handlers = captureServerEventHandlers();

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [gpt4oProvider({ toolcall: true, vision: true })],
      default: { openai: 'gpt-4o' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(undefined);

    const { stateModule, hookModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(
        storePath('providers', [gpt4oProvider({ toolcall: true, vision: true })])
      );
      flushSolid();
      stateModule.setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('sessionStatus', 'session-1', {
          type: 'retry',
          attempt: 2,
          message: '429 usage limit reached',
          next: 3,
        })
      );
      flushSolid();
      stateModule.setSessionUsageLimit('session-1', {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 3_000,
        attempt: 2,
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
      flushSolid();

      await hookModule.abortSession();
      flushSolid();

      handlers.get('session.status')?.({
        properties: {
          sessionID: 'session-1',
          status: {
            type: 'retry',
            attempt: 3,
            message: '429 usage limit reached',
            next: 8,
          },
        },
      });
      flushSolid();

      expect(stateModule.state.sessionStatus['session-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        attempt: 2,
        providerID: 'openai',
        modelID: 'gpt-4o',
      });

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
      flushSolid();
      handlers.get('session.status')?.({
        properties: {
          sessionID: 'session-1',
          status: {
            type: 'retry',
            attempt: 1,
            message: '429 usage limit reached',
            next: 5,
          },
        },
      });
      flushSolid();

      expect(stateModule.state.sessionStatus['session-1']).toEqual({
        type: 'retry',
        attempt: 1,
        message: '429 usage limit reached',
        next: 5,
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('aborts child sessions that appear after stop has already started', async () => {
    const handlers = captureServerEventHandlers();

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(storePath('sessions', [session('session-1')]));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();

      await hookModule.abortSession();
      flushSolid();

      handlers.get('session.created')?.({
        properties: {
          info: {
            ...session('child-1'),
            parentID: 'session-1',
          },
        },
      });
      flushSolid();

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(2);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1', {
        directory: '/repo',
      });
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1', {
        directory: '/repo',
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('aborts retrying subagent sessions when stopping the parent session', async () => {
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1' },
          { ...session('child-2'), parentID: 'child-1' },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(
        storePath('sessionStatus', {
          'session-1': { type: 'retry', attempt: 1, message: '429 usage limit reached', next: 3 },
          'child-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 4 },
          'child-2': { type: 'busy' },
        })
      );
      flushSolid();
      stateModule.setSessionUsageLimit('session-1', {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 3_000,
        attempt: 1,
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
      flushSolid();
      stateModule.setSessionUsageLimit('child-1', {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 4_000,
        attempt: 2,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
      flushSolid();

      await hookModule.abortSession();
      flushSolid();

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(3);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1', {
        directory: '/repo',
      });
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1', {
        directory: '/repo',
      });
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(3, 'child-2', {
        directory: '/repo',
      });
      expect(stateModule.state.sessionStatus['session-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionStatus['child-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionStatus['child-2']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        attempt: 1,
        sessionID: 'session-1',
      });
      expect(stateModule.state.sessionUsageLimits['child-1']).toMatchObject({
        attempt: 2,
        sessionID: 'child-1',
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('aborts the full root session tree when stopping from a subagent session', async () => {
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(
        storePath('sessions', [
          session('session-1'),
          { ...session('child-1'), parentID: 'session-1' },
          { ...session('child-2'), parentID: 'session-1' },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'child-1'));
      flushSolid();

      await hookModule.abortSession();
      flushSolid();

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(3);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1', {
        directory: '/repo',
      });
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1', {
        directory: '/repo',
      });
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(3, 'child-2', {
        directory: '/repo',
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('marks aborted plan sessions as skipped', async () => {
    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(
        storePath('sessions', [{ ...session('session-1'), time: { created: 0, updated: 200 } }])
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('sessionSelectedAgents', { 'session-1': 'plan' }));
      flushSolid();

      await hookModule.abortSession();
      flushSolid();

      expect(stateModule.state.skippedPlanSessions['session-1']).toBe(200);
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('records the originating session on usage-limit notices', async () => {
    const handlers = captureServerEventHandlers();

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
        storePath('providers', [gpt4oProvider({ toolcall: true, vision: true })])
      );
      flushSolid();
      stateModule.setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'child-1'));
      flushSolid();

      handlers.get('session.status')?.({
        properties: {
          sessionID: 'child-1',
          status: {
            type: 'retry',
            attempt: 2,
            message: '429 usage limit reached',
            next: 8,
          },
        },
      });
      flushSolid();

      expect(stateModule.state.sessionUsageLimits['child-1']).toMatchObject({
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
    } finally {
      dispose();
      flushSolid();
    }
  });

  it('attaches retry usage-limit notices to the selected provider', async () => {
    const handlers = captureServerEventHandlers();

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({
      providers: [
        gpt4oProvider({ toolcall: true, vision: true }),
        provider('anthropic', {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ],
      default: { openai: 'gpt-4o', anthropic: 'claude' },
    });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, dispose } = await loadAndMountUseOpenCode();

    try {
      await Promise.resolve();
      flushSolid();

      stateModule.setState(
        storePath('providers', [
          gpt4oProvider({ toolcall: true, vision: true }),
          provider('anthropic', {
            claude: {
              id: 'claude',
              name: 'Claude',
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
            },
          }),
        ])
      );
      flushSolid();
      stateModule.setState(
        storePath('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' })
      );
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setSelectedModel(
        { providerID: 'anthropic', modelID: 'claude' },
        { sessionId: 'session-1', persistGlobal: false }
      );
      flushSolid();

      handlers.get('session.status')?.({
        properties: {
          sessionID: 'session-1',
          status: {
            type: 'retry',
            attempt: 2,
            message: '429 usage limit reached',
            next: 8,
          },
        },
      });
      flushSolid();

      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        providerID: 'anthropic',
        modelID: 'claude',
        attempt: 2,
        statusCode: 429,
      });
    } finally {
      dispose();
      flushSolid();
    }
  });
});
