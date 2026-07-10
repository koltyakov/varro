import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ConfigChangeEvent = { affectsConfiguration: (key: string) => boolean };
type ConfigChangeListener = (event: ConfigChangeEvent) => void;

const {
  executeCommandMock,
  getMock,
  onDidChangeConfigurationMock,
  registerWebviewViewProviderMock,
  sweepStaleInjectedConfigDirectoriesMock,
} = vi.hoisted(() => ({
  executeCommandMock: vi.fn(() => Promise.resolve()),
  getMock: vi.fn((key: string, fallback?: unknown) => {
    switch (key) {
      case 'server.port':
        return 4096;
      case 'server.autoStart':
        return true;
      case 'server.command':
        return '';
      case 'debug.simulateMissingCli':
        return false;
      case 'debug.simulateNoProviders':
        return false;
      case 'chat.autoCompact':
        return false;
      case 'chat.autoCompactionReservedTokens':
        return 7777;
      default:
        return fallback;
    }
  }),
  onDidChangeConfigurationMock: vi.fn((_listener: ConfigChangeListener) => ({ dispose: vi.fn() })),
  registerWebviewViewProviderMock: vi.fn(() => ({ dispose: vi.fn() })),
  sweepStaleInjectedConfigDirectoriesMock: vi.fn(() => Promise.resolve()),
}));

const {
  contextProviderMock,
  contextChangeCallback,
  latestContextProviderInstance,
  latestServerInstance,
  latestSidebarProviderInstance,
  loggerMock,
  openCodeServerMock,
  registerCommandsMock,
  sidebarProviderMock,
} = vi.hoisted(() => ({
  contextProviderMock: vi.fn(),
  contextChangeCallback: {
    current: null as
      | null
      | ((context: {
          workspacePath: string | null;
          activeFile: null;
          selection: null;
          diagnostics: never[];
        }) => void),
  },
  latestContextProviderInstance: { current: null as null | { dispose: ReturnType<typeof vi.fn> } },
  latestServerInstance: {
    current: null as null | {
      disconnect: ReturnType<typeof vi.fn>;
      rescopeEventStream: ReturnType<typeof vi.fn>;
      updateCompactionSettings: ReturnType<typeof vi.fn>;
    },
  },
  latestSidebarProviderInstance: {
    current: null as null | {
      dispose: ReturnType<typeof vi.fn>;
      initializeProviderFileSignature: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
    },
  },
  loggerMock: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    dispose: vi.fn(),
  },
  openCodeServerMock: vi.fn(),
  registerCommandsMock: vi.fn(),
  sidebarProviderMock: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: getMock })),
    onDidChangeConfiguration: onDidChangeConfigurationMock,
  },
  window: {
    registerWebviewViewProvider: registerWebviewViewProviderMock,
  },
  commands: {
    executeCommand: executeCommandMock,
  },
}));

vi.mock('./server', () => ({
  OpenCodeServer: class {
    updateCompactionSettings = vi.fn(() => Promise.resolve());
    disconnect = vi.fn(() => Promise.resolve());
    rescopeEventStream = vi.fn(() => Promise.resolve({ state: 'inactive', directory: undefined }));

    constructor(...args: unknown[]) {
      latestServerInstance.current = {
        updateCompactionSettings: this.updateCompactionSettings,
        disconnect: this.disconnect,
        rescopeEventStream: this.rescopeEventStream,
      };
      openCodeServerMock(...args);
    }
  },
}));
vi.mock('./open-code-process', () => ({
  sweepStaleInjectedConfigDirectories: sweepStaleInjectedConfigDirectoriesMock,
}));
vi.mock('./sidebar-provider', () => ({
  SidebarProvider: class {
    static viewType = 'varro.sidebar';
    dispose = vi.fn(() => Promise.resolve());
    initializeProviderFileSignature = vi.fn(() => Promise.resolve());
    post = vi.fn();

    constructor(...args: unknown[]) {
      latestSidebarProviderInstance.current = {
        dispose: this.dispose,
        initializeProviderFileSignature: this.initializeProviderFileSignature,
        post: this.post,
      };
      sidebarProviderMock(...args);
    }
  },
}));
vi.mock('./context-provider', () => ({
  ContextProvider: class {
    dispose = vi.fn(() => Promise.resolve());

    constructor(...args: unknown[]) {
      latestContextProviderInstance.current = {
        dispose: this.dispose,
      };
      contextChangeCallback.current = args[0] as typeof contextChangeCallback.current;
      contextProviderMock(...args);
    }
  },
}));
vi.mock('./commands', () => ({ registerCommands: registerCommandsMock }));
vi.mock('./logger', () => ({ logger: loggerMock }));

describe('extension activation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    latestContextProviderInstance.current = null;
    contextChangeCallback.current = null;
    latestServerInstance.current = null;
    latestSidebarProviderInstance.current = null;
    sweepStaleInjectedConfigDirectoriesMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes compaction settings into OpenCodeServer', async () => {
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(openCodeServerMock).toHaveBeenCalledWith(4096, true, '', false, {
      auto: false,
      reserved: 7777,
    });
  });

  it('reapplies compaction settings when configuration changes', async () => {
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    const listener = onDidChangeConfigurationMock.mock.lastCall?.[0];
    expect(listener).toBeTypeOf('function');

    listener?.({
      affectsConfiguration: (key: string) => key === 'varro.chat.autoCompactionReservedTokens',
    });

    expect(latestServerInstance.current).toBeTruthy();
    expect(latestServerInstance.current?.updateCompactionSettings).toHaveBeenCalledWith({
      auto: false,
      reserved: 7777,
    });
  });

  it('uses a less aggressive reserved token default', async () => {
    getMock.mockImplementation((key: string, fallback?: unknown) => {
      switch (key) {
        case 'server.port':
          return 4096;
        case 'server.autoStart':
          return true;
        case 'server.command':
          return '';
        case 'debug.simulateMissingCli':
          return false;
        case 'debug.simulateNoProviders':
          return false;
        case 'chat.autoCompact':
          return true;
        case 'chat.autoCompactionReservedTokens':
          return fallback;
        default:
          return fallback;
      }
    });

    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(openCodeServerMock).toHaveBeenCalledWith(4096, true, '', false, {
      auto: true,
      reserved: 4096,
    });
  });

  it('registers the sidebar view provider, commands, and activation context', async () => {
    const { activate } = await import('./extension');
    const context = {
      extensionUri: { path: '/extension' },
      extension: { id: 'koltyakov.varro' },
      workspaceState: { get: vi.fn(), update: vi.fn() },
      subscriptions: [] as Array<{ dispose: () => void }>,
    };

    await activate(context as never);

    expect(registerWebviewViewProviderMock).toHaveBeenCalledWith(
      'varro.sidebar',
      expect.anything(),
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    expect(registerCommandsMock).toHaveBeenCalledWith(
      context as never,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(registerCommandsMock.mock.calls[0]?.[1]).toMatchObject(
      latestSidebarProviderInstance.current!
    );
    expect(registerCommandsMock.mock.calls[0]?.[2]).toMatchObject(
      latestContextProviderInstance.current!
    );
    expect(registerCommandsMock.mock.calls[0]?.[3]).toMatchObject(latestServerInstance.current!);
    expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:activated', true);
    expect(context.subscriptions).toHaveLength(2);
  });

  it('registers the provider and commands before starting non-blocking stale cleanup', async () => {
    sweepStaleInjectedConfigDirectoriesMock.mockReturnValueOnce(new Promise(() => {}));
    const { activate } = await import('./extension');

    await expect(
      activate({
        extensionUri: {},
        extension: { id: 'koltyakov.varro' },
        workspaceState: {},
        subscriptions: [],
      } as never)
    ).resolves.toBeUndefined();

    expect(sweepStaleInjectedConfigDirectoriesMock).toHaveBeenCalledOnce();
    expect(registerWebviewViewProviderMock.mock.invocationCallOrder[0]).toBeLessThan(
      sweepStaleInjectedConfigDirectoriesMock.mock.invocationCallOrder[0] ?? 0
    );
    expect(registerCommandsMock.mock.invocationCallOrder[0]).toBeLessThan(
      sweepStaleInjectedConfigDirectoriesMock.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('logs stale cleanup failures without rejecting activation', async () => {
    sweepStaleInjectedConfigDirectoriesMock.mockRejectedValueOnce(new Error('cleanup failed'));
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    await Promise.resolve();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to clean up stale temporary config directories: cleanup failed'
    );
  });

  it('posts a changed workspace only after the event stream is rescoped', async () => {
    let finishRescope!: () => void;
    const rescope = new Promise<{ state: 'connected'; directory: string }>((resolve) => {
      finishRescope = () => resolve({ state: 'connected', directory: '/repo-b' });
    });
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    latestServerInstance.current?.rescopeEventStream.mockReturnValueOnce(rescope);
    const nextContext = {
      workspacePath: '/repo-b',
      activeFile: null,
      selection: null,
      diagnostics: [] as never[],
    };

    contextChangeCallback.current?.(nextContext);
    expect(latestServerInstance.current?.rescopeEventStream).toHaveBeenCalledWith('/repo-b');
    expect(latestSidebarProviderInstance.current?.post).not.toHaveBeenCalled();

    finishRescope();
    await rescope;
    await Promise.resolve();
    expect(latestSidebarProviderInstance.current?.post).toHaveBeenCalledWith({
      type: 'context/update',
      payload: nextContext,
    });
  });

  it('publishes a changed workspace after a degraded rescope timeout', async () => {
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    latestServerInstance.current?.rescopeEventStream.mockResolvedValueOnce({
      state: 'degraded',
      directory: '/repo-b',
    });
    const nextContext = {
      workspacePath: '/repo-b',
      activeFile: null,
      selection: null,
      diagnostics: [] as never[],
    };

    contextChangeCallback.current?.(nextContext);
    await Promise.resolve();
    await Promise.resolve();

    expect(latestSidebarProviderInstance.current?.post).toHaveBeenCalledWith({
      type: 'context/update',
      payload: nextContext,
    });
  });

  it('retries and publishes the latest context after restart cancellation', async () => {
    vi.useFakeTimers();
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    latestServerInstance.current?.rescopeEventStream
      .mockResolvedValueOnce({ state: 'cancelled', directory: '/repo-b' })
      .mockResolvedValueOnce({ state: 'inactive', directory: '/repo-b' })
      .mockResolvedValueOnce({ state: 'connected', directory: '/repo-b' });
    const nextContext = {
      workspacePath: '/repo-b',
      activeFile: null,
      selection: null,
      diagnostics: [] as never[],
    };

    contextChangeCallback.current?.(nextContext);
    await Promise.resolve();
    expect(latestSidebarProviderInstance.current?.post).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(latestServerInstance.current?.rescopeEventStream).toHaveBeenCalledTimes(3);
    expect(latestSidebarProviderInstance.current?.post).toHaveBeenCalledWith({
      type: 'context/update',
      payload: nextContext,
    });
    vi.useRealTimers();
  });

  it('publishes only C during rapid A to B to C rescoping', async () => {
    let resolveB!: (value: { state: 'superseded'; directory: string }) => void;
    const scopeB = new Promise<{ state: 'superseded'; directory: string }>((resolve) => {
      resolveB = resolve;
    });
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    latestServerInstance.current?.rescopeEventStream
      .mockReturnValueOnce(scopeB)
      .mockResolvedValueOnce({ state: 'connected', directory: '/repo-c' });
    const contextB = {
      workspacePath: '/repo-b',
      activeFile: null,
      selection: null,
      diagnostics: [] as never[],
    };
    const contextC = { ...contextB, workspacePath: '/repo-c' };

    contextChangeCallback.current?.(contextB);
    contextChangeCallback.current?.(contextC);
    await Promise.resolve();
    await Promise.resolve();
    resolveB({ state: 'superseded', directory: '/repo-b' });
    await scopeB;
    await Promise.resolve();

    expect(latestServerInstance.current?.rescopeEventStream.mock.calls).toEqual([
      ['/repo-b'],
      ['/repo-c'],
    ]);
    expect(latestSidebarProviderInstance.current?.post).toHaveBeenCalledTimes(1);
    expect(latestSidebarProviderInstance.current?.post).toHaveBeenCalledWith({
      type: 'context/update',
      payload: contextC,
    });
  });

  it('does not publish a workspace scope when event stream rescoping fails', async () => {
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    latestServerInstance.current?.rescopeEventStream.mockRejectedValueOnce(
      new Error('stream failed')
    );

    contextChangeCallback.current?.({
      workspacePath: '/repo-b',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(latestSidebarProviderInstance.current?.post).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to rescope OpenCode event stream: stream failed'
    );
  });

  it('disposes the sidebar, context provider, and server during deactivation', async () => {
    const { activate, deactivate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    await deactivate();

    expect(latestSidebarProviderInstance.current?.dispose).toHaveBeenCalledTimes(1);
    expect(latestContextProviderInstance.current?.dispose).toHaveBeenCalledTimes(1);
    expect(latestServerInstance.current?.disconnect).toHaveBeenCalledTimes(1);
    expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:activated', false);
    expect(loggerMock.dispose).toHaveBeenCalledTimes(1);
  });

  it('logs disposal errors and continues tearing down the extension', async () => {
    const { activate, deactivate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    latestSidebarProviderInstance.current?.dispose.mockRejectedValueOnce(
      new Error('sidebar failed')
    );

    await deactivate();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'Error during sidebarProvider dispose: sidebar failed'
    );
    expect(latestContextProviderInstance.current?.dispose).toHaveBeenCalledTimes(1);
    expect(latestServerInstance.current?.disconnect).toHaveBeenCalledTimes(1);
    expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:activated', false);
  });
});
