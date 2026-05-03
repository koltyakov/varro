import { beforeEach, describe, expect, it, vi } from 'vitest';

type ConfigChangeEvent = { affectsConfiguration: (key: string) => boolean };
type ConfigChangeListener = (event: ConfigChangeEvent) => void;

const {
  executeCommandMock,
  getMock,
  onDidChangeConfigurationMock,
  registerWebviewViewProviderMock,
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
}));

const {
  contextProviderMock,
  latestContextProviderInstance,
  latestServerInstance,
  latestSidebarProviderInstance,
  loggerMock,
  openCodeServerMock,
  registerCommandsMock,
  sidebarProviderMock,
} = vi.hoisted(() => ({
  contextProviderMock: vi.fn(),
  latestContextProviderInstance: { current: null as null | { dispose: ReturnType<typeof vi.fn> } },
  latestServerInstance: {
    current: null as null | {
      disconnect: ReturnType<typeof vi.fn>;
      updateCompactionSettings: ReturnType<typeof vi.fn>;
    },
  },
  latestSidebarProviderInstance: {
    current: null as null | {
      dispose: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
    },
  },
  loggerMock: {
    info: vi.fn(),
    error: vi.fn(),
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

    constructor(...args: unknown[]) {
      latestServerInstance.current = {
        updateCompactionSettings: this.updateCompactionSettings,
        disconnect: this.disconnect,
      };
      openCodeServerMock(...args);
    }
  },
}));
vi.mock('./sidebar-provider', () => ({
  SidebarProvider: class {
    static viewType = 'varro.sidebar';
    dispose = vi.fn(() => Promise.resolve());
    post = vi.fn();

    constructor(...args: unknown[]) {
      latestSidebarProviderInstance.current = {
        dispose: this.dispose,
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
    latestServerInstance.current = null;
    latestSidebarProviderInstance.current = null;
  });

  it('passes compaction settings into OpenCodeServer', async () => {
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
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

  it('registers the sidebar view provider, commands, and activation context', async () => {
    const { activate } = await import('./extension');
    const context = {
      extensionUri: { path: '/extension' },
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

  it('disposes the sidebar, context provider, and server during deactivation', async () => {
    const { activate, deactivate } = await import('./extension');

    await activate({
      extensionUri: {},
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
