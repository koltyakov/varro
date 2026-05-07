import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { getClientMocks, loadModules, provider, session } from './useOpenCode.test-support';

const clientMocks = getClientMocks();

describe('useOpenCode session control flows', () => {
  it('ignores stale retry status updates after aborting a retrying session', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
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
    clientMocks.sessionAbort.mockResolvedValue(undefined);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

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
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('sessionStatus', 'session-1', {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached',
        next: 3,
      });
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

      await hookModule.abortSession();

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

      expect(stateModule.state.sessionStatus['session-1']).toEqual({ type: 'idle' });
      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        attempt: 2,
        providerID: 'openai',
        modelID: 'gpt-4o',
      });

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
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

      expect(stateModule.state.sessionStatus['session-1']).toEqual({
        type: 'retry',
        attempt: 1,
        message: '429 usage limit reached',
        next: 5,
      });
    } finally {
      dispose();
    }
  });

  it('aborts child sessions that appear after stop has already started', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.providerLimit.mockResolvedValue(null);
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionAbort.mockResolvedValue(true);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('sessions', [session('session-1')]);
      stateModule.setState('activeSessionId', 'session-1');

      await hookModule.abortSession();

      handlers.get('session.created')?.({
        properties: {
          info: {
            ...session('child-1'),
            parentID: 'session-1',
          },
        },
      });

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(2);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1');
    } finally {
      dispose();
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

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1' },
        { ...session('child-2'), parentID: 'child-1' },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('sessionStatus', {
        'session-1': { type: 'retry', attempt: 1, message: '429 usage limit reached', next: 3 },
        'child-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 4 },
        'child-2': { type: 'busy' },
      });
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

      await hookModule.abortSession();

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(3);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(3, 'child-2');
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

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('sessions', [
        session('session-1'),
        { ...session('child-1'), parentID: 'session-1' },
        { ...session('child-2'), parentID: 'session-1' },
      ]);
      stateModule.setState('activeSessionId', 'child-1');

      await hookModule.abortSession();

      expect(clientMocks.sessionAbort).toHaveBeenCalledTimes(3);
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(1, 'session-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(2, 'child-1');
      expect(clientMocks.sessionAbort).toHaveBeenNthCalledWith(3, 'child-2');
    } finally {
      dispose();
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

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('sessions', [
        { ...session('session-1'), time: { created: 0, updated: 200 } },
      ]);
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('sessionSelectedAgents', { 'session-1': 'plan' });

      await hookModule.abortSession();

      expect(stateModule.state.skippedPlanSessions['session-1']).toBe(200);
    } finally {
      dispose();
    }
  });

  it('records the originating session on usage-limit notices', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
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
      stateModule.setState('activeSessionId', 'child-1');

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

      expect(stateModule.state.sessionUsageLimits['child-1']).toMatchObject({
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      });
    } finally {
      dispose();
    }
  });

  it('attaches retry usage-limit notices to the selected provider', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
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

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, vision: true },
            cost: { input: 0, output: 0 },
          },
        }),
        provider('anthropic', {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        }),
      ]);
      stateModule.setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setSelectedModel(
        { providerID: 'anthropic', modelID: 'claude' },
        { sessionId: 'session-1', persistGlobal: false }
      );

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

      expect(stateModule.state.sessionUsageLimits['session-1']).toMatchObject({
        providerID: 'anthropic',
        modelID: 'claude',
        attempt: 2,
        statusCode: 429,
      });
    } finally {
      dispose();
    }
  });
});
