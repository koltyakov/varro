/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These activation tests intentionally verify module wiring with minimal extension-host fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

type ConfigChangeEvent = { affectsConfiguration: (key: string) => boolean };
type ConfigChangeListener = (event: ConfigChangeEvent) => void;

const {
  envMock,
  executeCommandMock,
  getCommandsMock,
  getMock,
  onDidChangeConfigurationMock,
  registerWebviewViewProviderMock,
  showInformationMessageMock,
  sweepStaleInjectedConfigDirectoriesMock,
} = vi.hoisted(() => ({
  envMock: { appName: 'Visual Studio Code', uriScheme: 'vscode' },
  executeCommandMock: vi.fn(() => Promise.resolve()),
  getCommandsMock: vi.fn(() => Promise.resolve([] as string[])),
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
  showInformationMessageMock: vi.fn(() => Promise.resolve('Reload Window')),
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
      updateLaunchSettings: ReturnType<typeof vi.fn>;
    },
  },
  latestSidebarProviderInstance: {
    current: null as null | {
      dispose: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
      startProviderFileObservation: ReturnType<typeof vi.fn>;
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
  env: envMock,
  workspace: {
    getConfiguration: vi.fn(() => ({ get: getMock })),
    onDidChangeConfiguration: onDidChangeConfigurationMock,
  },
  window: {
    registerWebviewViewProvider: registerWebviewViewProviderMock,
    showInformationMessage: showInformationMessageMock,
  },
  commands: {
    executeCommand: executeCommandMock,
    getCommands: getCommandsMock,
  },
}));

vi.mock('./server', () => ({
  OpenCodeServer: class {
    updateCompactionSettings = vi.fn(() => Promise.resolve());
    updateLaunchSettings = vi.fn();
    disconnect = vi.fn(() => Promise.resolve());
    rescopeEventStream = vi.fn(() => Promise.resolve({ state: 'inactive', directory: undefined }));

    constructor(...args: unknown[]) {
      latestServerInstance.current = {
        updateCompactionSettings: this.updateCompactionSettings,
        updateLaunchSettings: this.updateLaunchSettings,
        disconnect: this.disconnect,
        rescopeEventStream: this.rescopeEventStream,
      };
      openCodeServerMock(...args);
    }
  },
}));
vi.mock('./open-code-process', async (importOriginal) => ({
  ...(await importOriginal()),
  sweepStaleInjectedConfigDirectories: sweepStaleInjectedConfigDirectoriesMock,
}));
vi.mock('./sidebar-provider', () => ({
  SidebarProvider: class {
    static viewType = 'varro.chat';
    dispose = vi.fn(() => Promise.resolve());
    post = vi.fn();
    startProviderFileObservation = vi.fn();

    constructor(...args: unknown[]) {
      latestSidebarProviderInstance.current = {
        dispose: this.dispose,
        post: this.post,
        startProviderFileObservation: this.startProviderFileObservation,
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

function readDefaultConfig(key: string, fallback?: unknown) {
  switch (key) {
    case 'server.port':
      return 4096;
    case 'server.autoStart':
      return true;
    case 'server.command':
      return '';
    case 'debug.simulateMissingCli':
    case 'debug.simulateNoProviders':
      return false;
    case 'chat.autoCompact':
      return false;
    case 'chat.autoCompactionReservedTokens':
      return 7777;
    default:
      return fallback;
  }
}

describe('extension activation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    latestContextProviderInstance.current = null;
    contextChangeCallback.current = null;
    latestServerInstance.current = null;
    latestSidebarProviderInstance.current = null;
    envMock.appName = 'Visual Studio Code';
    envMock.uriScheme = 'vscode';
    getMock.mockImplementation(readDefaultConfig);
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

  it('reapplies launch settings when configuration changes', async () => {
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    const listener = onDidChangeConfigurationMock.mock.lastCall?.[0];
    listener?.({
      affectsConfiguration: (key: string) => key === 'varro.server.command',
    });

    expect(latestServerInstance.current?.updateLaunchSettings).toHaveBeenCalledWith({
      autoStart: true,
      command: '',
    });
  });

  it('offers to reload the window when the configured server port changes', async () => {
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    const listener = onDidChangeConfigurationMock.mock.lastCall?.[0];
    listener?.({
      affectsConfiguration: (key: string) => key === 'varro.server.port',
    });
    await Promise.resolve();

    expect(showInformationMessageMock).toHaveBeenCalledWith(
      'Reload VS Code to apply the new Varro server port.',
      'Reload Window'
    );
    expect(executeCommandMock).toHaveBeenCalledWith('workbench.action.reloadWindow');
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

    expect(registerWebviewViewProviderMock).toHaveBeenCalledWith('varro.chat', expect.anything(), {
      webviewOptions: { retainContextWhenHidden: true },
    });
    expect(registerCommandsMock).toHaveBeenCalledWith(
      context as never,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(Function)
    );
    expect(registerCommandsMock.mock.calls[0]?.[1]).toMatchObject(
      latestSidebarProviderInstance.current!
    );
    expect(registerCommandsMock.mock.calls[0]?.[2]).toMatchObject(
      latestContextProviderInstance.current!
    );
    expect(registerCommandsMock.mock.calls[0]?.[3]).toMatchObject(latestServerInstance.current!);
    expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:activated', true);
    expect(
      latestSidebarProviderInstance.current?.startProviderFileObservation
    ).toHaveBeenCalledOnce();
    expect(context.subscriptions).toHaveLength(2);
  });

  it.each([
    ['Cursor', 'cursor'],
    ['Windsurf', 'windsurf'],
    ['Devin', 'devin'],
  ])('moves the chat view to the primary sidebar once in %s', async (appName, uriScheme) => {
    envMock.appName = appName;
    envMock.uriScheme = uriScheme;
    getCommandsMock.mockResolvedValueOnce(['vscode.moveViews']);
    const globalState = {
      get: vi.fn(() => false),
      update: vi.fn(() => Promise.resolve()),
    };
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(executeCommandMock).toHaveBeenCalledWith('vscode.moveViews', {
      viewIds: ['varro.chat'],
      destinationId: 'workbench.view.extension.varro-primary',
    });
    expect(globalState.update).toHaveBeenCalledWith('layout.cursorPrimarySidebar.v1', true);
    expect(registerCommandsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('skips startup migration after the marker but registers a repairing revealer', async () => {
    envMock.appName = 'Devin';
    envMock.uriScheme = 'devin';
    const globalState = {
      get: vi.fn(() => true),
      update: vi.fn(() => Promise.resolve()),
    };
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(getCommandsMock).not.toHaveBeenCalled();
    expect(executeCommandMock).not.toHaveBeenCalledWith('vscode.moveViews', expect.anything());
    expect(globalState.update).not.toHaveBeenCalled();
    expect(registerCommandsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('reapplies fork placement when revealing after a persisted migration', async () => {
    envMock.appName = 'Cursor';
    envMock.uriScheme = 'cursor';
    const globalState = {
      get: vi.fn(() => true),
      update: vi.fn(() => Promise.resolve()),
    };
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);
    const reveal = registerCommandsMock.mock.calls[0]?.[4];

    expect(reveal).toBeTypeOf('function');
    executeCommandMock.mockClear();
    await (reveal as () => Promise<void>)();

    expect(executeCommandMock).toHaveBeenCalledWith('vscode.moveViews', {
      viewIds: ['varro.chat'],
      destinationId: 'workbench.view.extension.varro-primary',
    });
  });

  it.each([
    ['Visual Studio Code', 'vscode'],
    ['VSCodium', 'vscodium'],
  ])('keeps the secondary container in %s', async (appName, uriScheme) => {
    envMock.appName = appName;
    envMock.uriScheme = uriScheme;
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(getCommandsMock).not.toHaveBeenCalled();
    expect(executeCommandMock).not.toHaveBeenCalledWith('vscode.moveViews', expect.anything());
    expect(registerCommandsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('reveals the secondary sidebar once after installation in VS Code', async () => {
    const globalState = {
      get: vi.fn(() => false),
      update: vi.fn(() => Promise.resolve()),
    };
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(executeCommandMock).toHaveBeenCalledWith('workbench.view.extension.varro');
    expect(executeCommandMock).toHaveBeenCalledWith('varro.chat.focus');
    expect(executeCommandMock.mock.calls.slice(0, 2)).toEqual([
      ['workbench.view.extension.varro'],
      ['varro.chat.focus'],
    ]);
    expect(globalState.update).toHaveBeenCalledWith('layout.initialSidebarReveal.v1', true);
  });

  it('does not reveal the sidebar again after the initial activation', async () => {
    const globalState = {
      get: vi.fn((key: string) => key === 'layout.initialSidebarReveal.v1'),
      update: vi.fn(() => Promise.resolve()),
    };
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(executeCommandMock).not.toHaveBeenCalledWith('workbench.view.extension.varro');
    expect(executeCommandMock).not.toHaveBeenCalledWith('varro.chat.focus');
    expect(globalState.update).not.toHaveBeenCalled();
  });

  it('reapplies standard-host placement on every reveal', async () => {
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    const reveal = registerCommandsMock.mock.calls[0]?.[4];

    expect(reveal).toBeTypeOf('function');
    executeCommandMock.mockClear();
    await (reveal as () => Promise<void>)();

    expect(executeCommandMock).toHaveBeenCalledWith('vscode.moveViews', {
      viewIds: ['varro.chat'],
      destinationId: 'workbench.view.extension.varro',
    });
  });

  it('resets and opens the manifest view when placement cannot be reapplied', async () => {
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    const reveal = registerCommandsMock.mock.calls[0]?.[4];
    expect(reveal).toBeTypeOf('function');
    executeCommandMock.mockClear();
    executeCommandMock
      .mockRejectedValueOnce(new Error('move command unavailable'))
      .mockResolvedValueOnce(undefined);

    await (reveal as () => Promise<void>)();

    expect(executeCommandMock.mock.calls).toEqual([
      [
        'vscode.moveViews',
        {
          viewIds: ['varro.chat'],
          destinationId: 'workbench.view.extension.varro',
        },
      ],
      ['varro.chat.resetViewLocation'],
    ]);
  });

  it.each([0, -1, 1.5, 65_536, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid configured server port %s before constructing the server',
    async (configuredPort) => {
      getMock.mockImplementation((key: string, fallback?: unknown) =>
        key === 'server.port' ? configuredPort : fallback
      );
      const { activate } = await import('./extension');

      await expect(
        activate({
          extensionUri: {},
          extension: { id: 'koltyakov.varro' },
          workspaceState: {},
          subscriptions: [],
        } as never)
      ).rejects.toThrow('varro.server.port');

      expect(openCodeServerMock).not.toHaveBeenCalled();
    }
  );

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

describe('extension manifest', () => {
  it('contributes quick actions to the Varro view title', () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.chat.openSettings',
      title: 'Varro: Open Settings',
      shortTitle: 'Settings',
      icon: '$(gear)',
    });
    expect(packageJson.contributes.submenus).toContainEqual({
      id: 'varro.viewActions',
      label: 'More Actions',
      icon: '$(more)',
    });
    expect(packageJson.contributes.menus['view/title']).toEqual([
      {
        command: 'varro.chat.openSettings',
        when: 'view == varro.chat',
        group: 'navigation@1',
      },
      {
        submenu: 'varro.viewActions',
        when: 'view == varro.chat',
        group: 'navigation@2',
      },
    ]);
    expect(packageJson.contributes.menus['varro.viewActions']).toEqual([
      { command: 'varro.about', group: '1_main@1' },
      { command: 'varro.chat.openStats', group: '1_main@2' },
      { command: 'varro.openGitHub', group: '1_main@3' },
    ]);
  });

  it('contributes commit-message generation to the command palette and Source Control', () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.generateCommitMessage',
      title: 'Varro: Generate Commit Message',
      icon: '$(wand)',
    });
    expect(packageJson.contributes.menus['scm/title']).toEqual([
      {
        command: 'varro.generateCommitMessage',
        when: 'scmProvider == git',
        group: 'navigation@99',
      },
    ]);
  });

  it('constrains the server port setting to valid TCP ports', () => {
    const properties = packageJson.contributes.configuration.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties['varro.server.port']).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 65_535,
    });
  });

  it('contributes user-scoped helper model settings', () => {
    const properties = packageJson.contributes.configuration.properties as Record<
      string,
      Record<string, unknown>
    >;

    for (const key of ['varro.commitMessage.model', 'varro.chat.autoApproveModel']) {
      expect(properties[key]).toMatchObject({
        type: 'string',
        scope: 'application',
        default: '',
        pattern: '^$|^[^/\\s]+/[^\\s]+$',
      });
    }
  });
});
