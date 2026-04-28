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

const { contextProviderMock, openCodeServerMock, registerCommandsMock, sidebarProviderMock } =
  vi.hoisted(() => ({
    contextProviderMock: vi.fn(),
    openCodeServerMock: vi.fn(),
    registerCommandsMock: vi.fn(),
    sidebarProviderMock: vi.fn(),
  }));

let latestServerInstance: {
  updateCompactionSettings: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} | null = null;

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
      latestServerInstance = {
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
      sidebarProviderMock(...args);
    }
  },
}));
vi.mock('./context-provider', () => ({
  ContextProvider: class {
    dispose = vi.fn(() => Promise.resolve());

    constructor(...args: unknown[]) {
      contextProviderMock(...args);
    }
  },
}));
vi.mock('./commands', () => ({ registerCommands: registerCommandsMock }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), dispose: vi.fn() } }));

describe('extension activation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    latestServerInstance = null;
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

    expect(latestServerInstance).toBeTruthy();
    expect(latestServerInstance?.updateCompactionSettings).toHaveBeenCalledWith({
      auto: false,
      reserved: 7777,
    });
  });
});
