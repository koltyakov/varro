/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These activation tests intentionally verify module wiring with minimal extension-host fixtures. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

const scratchMock = vi.hoisted(() => ({
  prepare: vi.fn(() => Promise.resolve()),
  folders: undefined as { uri: { fsPath: string } }[] | undefined,
}));
vi.mock('./varro-state-paths', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareVarroScratchDirectory: scratchMock.prepare,
}));

const { disposeProcessInspectionMock, prepareProcessInspectionMock } = vi.hoisted(() => ({
  disposeProcessInspectionMock: vi.fn(),
  prepareProcessInspectionMock: vi.fn(),
}));
vi.mock('./process-inspection', () => ({
  disposeProcessInspection: disposeProcessInspectionMock,
  prepareProcessInspection: prepareProcessInspectionMock,
}));

type ConfigChangeEvent = { affectsConfiguration: (key: string) => boolean };
type ConfigChangeListener = (event: ConfigChangeEvent) => void;

const {
  envMock,
  executeCommandMock,
  getCommandsMock,
  getMock,
  onDidChangeConfigurationMock,
  registerWebviewPanelSerializerMock,
  registerWebviewViewProviderMock,
  showInformationMessageMock,
  sweepStaleInjectedConfigDirectoriesMock,
} = vi.hoisted(() => ({
  envMock: { appName: 'Visual Studio Code', uriScheme: 'vscode' },
  executeCommandMock: vi.fn((_command: string, ..._args: unknown[]) => Promise.resolve()),
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
      default:
        return fallback;
    }
  }),
  onDidChangeConfigurationMock: vi.fn((_listener: ConfigChangeListener) => ({ dispose: vi.fn() })),
  registerWebviewPanelSerializerMock: vi.fn(() => ({ dispose: vi.fn() })),
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
          workspaceFolders?: { name: string; path: string }[];
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
      updateLaunchSettings: ReturnType<typeof vi.fn>;
    },
  },
  latestSidebarProviderInstance: {
    current: null as null | {
      dispose: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
      startProviderFileObservation: ReturnType<typeof vi.fn>;
      view: { visible: boolean };
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
  version: '1.110.0',
  env: envMock,
  workspace: {
    get workspaceFolders() {
      return scratchMock.folders;
    },
    getConfiguration: vi.fn(() => ({ get: getMock })),
    onDidChangeConfiguration: onDidChangeConfigurationMock,
  },
  window: {
    registerWebviewPanelSerializer: registerWebviewPanelSerializerMock,
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
    updateLaunchSettings = vi.fn();
    disconnect = vi.fn(() => Promise.resolve());
    rescopeEventStream = vi.fn(() => Promise.resolve({ state: 'inactive', directory: undefined }));

    constructor(...args: unknown[]) {
      latestServerInstance.current = {
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
    static editorViewType = 'varro.editor';
    dispose = vi.fn(() => Promise.resolve());
    post = vi.fn();
    startProviderFileObservation = vi.fn();
    view = { visible: true };

    constructor(...args: unknown[]) {
      latestSidebarProviderInstance.current = {
        dispose: this.dispose,
        post: this.post,
        startProviderFileObservation: this.startProviderFileObservation,
        view: this.view,
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
    default:
      return fallback;
  }
}

const primarySidebarHosts: [string, string][] = [
  ['Cursor', 'cursor'],
  ['Windsurf', 'windsurf'],
  ['Devin', 'devin'],
  ['Trae', 'trae'],
  ['Trae CN', 'trae-cn'],
  ['TraeCN', 'traecn'],
  ['Cursor Insiders', 'cursor-insiders'],
  ['Unbranded Editor', 'windsurf-next'],
];

type ViewContributions = {
  viewsContainers: Record<string, { id: string }[]>;
  views: Record<string, { id: string }[]>;
};

// Model the editor registration contract, not a successful move command: Cursor rejects
// Secondary, container registration is first-wins, and saved view moves override defaults.
// See ViewsExtensionHandler.addCustomViewContainers/addViews and
// ViewDescriptorService.regroupViews in the editor's workbench sources.
function registerChatContribution(
  contributions: ViewContributions,
  acceptsSecondary: boolean,
  savedViewContainer?: string,
  savedContainerLocations: Record<string, string> = {}
) {
  const containerLocations = new Map<string, string>([['workbench.view.explorer', 'activitybar']]);
  for (const [location, containers] of Object.entries(contributions.viewsContainers)) {
    if (location === 'secondarySidebar' && !acceptsSecondary) continue;
    for (const { id } of containers) {
      const containerId = `workbench.view.extension.${id}`;
      if (!containerLocations.has(containerId)) containerLocations.set(containerId, location);
    }
  }
  for (const [container, location] of Object.entries(savedContainerLocations)) {
    containerLocations.set(container, location);
  }
  for (const [container, views] of Object.entries(contributions.views)) {
    if (!views.some(({ id }) => id === 'varro.chat')) continue;
    const declaredContainer = `workbench.view.extension.${container}`;
    const defaultContainer = containerLocations.has(declaredContainer)
      ? declaredContainer
      : 'workbench.view.explorer';
    const currentContainer = savedViewContainer ?? defaultContainer;
    return {
      defaultContainer,
      currentContainer,
      location: containerLocations.get(currentContainer),
    };
  }
  throw new Error('The manifest does not declare varro.chat');
}

describe('view registration in restricted forks', () => {
  it('repairs a rejected-container Explorer default before activation, without migration markers', () => {
    const rejectedContributions = {
      ...packageJson.contributes,
      viewsContainers: {
        ...packageJson.contributes.viewsContainers,
        activitybar: packageJson.contributes.viewsContainers.activitybar.filter(
          ({ id }) => id !== 'varro'
        ),
      },
    };
    expect(registerChatContribution(rejectedContributions, false)).toEqual({
      defaultContainer: 'workbench.view.explorer',
      currentContainer: 'workbench.view.explorer',
      location: 'activitybar',
    });
    expect(registerChatContribution(packageJson.contributes, false)).toEqual({
      defaultContainer: 'workbench.view.extension.varro',
      currentContainer: 'workbench.view.extension.varro',
      location: 'activitybar',
    });
  });

  it('keeps native Secondary registration when the host accepts it', () => {
    expect(registerChatContribution(packageJson.contributes, true)).toEqual({
      defaultContainer: 'workbench.view.extension.varro',
      currentContainer: 'workbench.view.extension.varro',
      location: 'secondarySidebar',
    });
  });

  it.each([
    ['workbench.view.explorer', 'activitybar'],
    ['workbench.view.extension.varro-primary', 'activitybar'],
    ['workbench.views.service.panel.saved-varro', 'panel'],
    ['workbench.views.service.sidebar.saved-varro', 'activitybar'],
    ['workbench.view.extension.other-extension', 'activitybar'],
  ])('preserves an intentional saved placement in %s', (container, location) => {
    expect(
      registerChatContribution(packageJson.contributes, false, container, { [container]: location })
    ).toEqual({
      defaultContainer: 'workbench.view.extension.varro',
      currentContainer: container,
      location,
    });
  });

  it('preserves a user-relocated Varro container instead of resetting it to Primary', () => {
    expect(
      registerChatContribution(packageJson.contributes, false, undefined, {
        'workbench.view.extension.varro': 'panel',
      })
    ).toEqual({
      defaultContainer: 'workbench.view.extension.varro',
      currentContainer: 'workbench.view.extension.varro',
      location: 'panel',
    });
  });
});

describe('extension activation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    prepareProcessInspectionMock.mockReset().mockResolvedValue(undefined);
    executeCommandMock.mockImplementation(() => Promise.resolve());
    getCommandsMock.mockReset().mockResolvedValue([]);
    latestContextProviderInstance.current = null;
    contextChangeCallback.current = null;
    latestServerInstance.current = null;
    latestSidebarProviderInstance.current = null;
    envMock.appName = 'Visual Studio Code';
    envMock.uriScheme = 'vscode';
    getMock.mockImplementation(readDefaultConfig);
    sweepStaleInjectedConfigDirectoriesMock.mockResolvedValue(undefined);
    scratchMock.folders = undefined;
    scratchMock.prepare.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not wait for native helper preparation before registering the server and views', async () => {
    prepareProcessInspectionMock.mockReturnValue(new Promise<void>(() => {}));
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    expect(prepareProcessInspectionMock).toHaveBeenCalledOnce();
    expect(openCodeServerMock).toHaveBeenCalledOnce();
    expect(registerWebviewViewProviderMock).toHaveBeenCalledOnce();
    expect(prepareProcessInspectionMock.mock.invocationCallOrder[0]).toBeLessThan(
      openCodeServerMock.mock.invocationCallOrder[0]!
    );
  });

  it('logs failed helper preparation while continuing activation', async () => {
    prepareProcessInspectionMock.mockRejectedValue(new Error('Preparation timed out'));
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Could not prepare Windows process inspection: Preparation timed out'
    );
    expect(openCodeServerMock).toHaveBeenCalledOnce();
    expect(registerWebviewViewProviderMock).toHaveBeenCalledOnce();
  });

  it('passes secret storage into OpenCodeServer without reading compaction settings', async () => {
    const { activate } = await import('./extension');
    const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      secrets,
      subscriptions: [],
    } as never);

    expect(openCodeServerMock).toHaveBeenCalledWith(
      4096,
      true,
      '',
      false,
      undefined,
      secrets,
      false
    );
    expect(scratchMock.prepare).toHaveBeenCalledOnce();
    expect(getMock).not.toHaveBeenCalledWith('chat.autoCompact', expect.anything());
    expect(getMock).not.toHaveBeenCalledWith(
      'chat.autoCompactionReservedTokens',
      expect.anything()
    );
    expect(scratchMock.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      openCodeServerMock.mock.invocationCallOrder[0]!
    );
  });

  it('passes global state and notification storage to the sidebar provider', async () => {
    const { activate } = await import('./extension');
    const workspaceState = {};
    const globalState = { get: vi.fn(), update: vi.fn(() => Promise.resolve()) };
    const globalStorageUri = { fsPath: '/extension-storage' };
    const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState,
      globalState,
      globalStorageUri,
      secrets,
      subscriptions: [],
    } as never);

    expect(sidebarProviderMock).toHaveBeenCalledWith(
      {},
      workspaceState,
      globalState,
      expect.anything(),
      expect.anything(),
      'koltyakov.varro',
      false,
      undefined,
      secrets,
      globalStorageUri
    );
  });

  it('does not prepare scratch when a project is open', async () => {
    scratchMock.folders = [{ uri: { fsPath: '/repo' } }];
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    expect(scratchMock.prepare).not.toHaveBeenCalled();
  });

  it('prepares scratch before rescoping after the last folder closes', async () => {
    scratchMock.folders = [{ uri: { fsPath: '/repo' } }];
    const { activate } = await import('./extension');
    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);
    contextChangeCallback.current?.({
      workspacePath: '/varro/scratch',
      workspaceFolders: [],
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    await vi.waitFor(() =>
      expect(latestServerInstance.current?.rescopeEventStream).toHaveBeenCalledWith(
        '/varro/scratch'
      )
    );
    expect(scratchMock.prepare).toHaveBeenCalledOnce();
    expect(scratchMock.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      latestServerInstance.current!.rescopeEventStream.mock.invocationCallOrder[0]!
    );
  });

  it('fails activation rather than inheriting a cwd if scratch cannot be created', async () => {
    scratchMock.prepare.mockRejectedValueOnce(new Error('Scratch is not writable'));
    const { activate } = await import('./extension');
    await expect(
      activate({
        extensionUri: {},
        extension: { id: 'koltyakov.varro' },
        workspaceState: {},
        subscriptions: [],
      } as never)
    ).rejects.toThrow('Scratch is not writable');
    expect(openCodeServerMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'remembers whether automatic mode is migrating an existing installation: %s',
    async (existing) => {
      getMock.mockImplementation((key: string, fallback?: unknown) =>
        key === 'server.port' ? 'auto' : readDefaultConfig(key, fallback)
      );
      const values = new Map<string, unknown>();
      if (existing) values.set('layout.initialSidebarReveal.v1', true);
      const globalState = {
        get: vi.fn((key: string) => values.get(key)),
        update: vi.fn(async (key: string, value: unknown) => {
          values.set(key, value);
        }),
      };
      const { activate } = await import('./extension');
      await activate({
        extensionUri: {},
        extension: { id: 'koltyakov.varro' },
        workspaceState: {},
        globalState,
        subscriptions: [],
      } as never);
      expect(openCodeServerMock.mock.calls.at(-1)?.[0]).toBe('auto');
      expect(openCodeServerMock.mock.calls.at(-1)?.[6]).toBe(existing);
      expect(globalState.update).toHaveBeenCalledWith(
        'varro.server.legacyDefaultEndpoint',
        existing
      );
    }
  );

  it('initializes and refreshes the inline file changes toolbar context', async () => {
    let fileDiffs = true;
    getMock.mockImplementation((key: string, fallback?: unknown) =>
      key === 'chat.showFileDiffs' ? fileDiffs : fallback
    );
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:showFileDiffs', true);

    fileDiffs = false;
    const listener = onDidChangeConfigurationMock.mock.lastCall?.[0];
    listener?.({
      affectsConfiguration: (key: string) => key === 'varro.chat.showFileDiffs',
    });

    expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:showFileDiffs', false);
  });

  it('does not expose Varro compaction settings or react to legacy setting changes', async () => {
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      workspaceState: {},
      subscriptions: [],
    } as never);

    const listener = onDidChangeConfigurationMock.mock.lastCall?.[0];
    expect(listener).toBeTypeOf('function');
    getMock.mockClear();

    for (const setting of ['varro.chat.autoCompact', 'varro.chat.autoCompactionReservedTokens']) {
      expect(Object.keys(packageJson.contributes.configuration.properties)).not.toContain(setting);
      listener?.({ affectsConfiguration: (key: string) => key === setting });
    }

    expect(getMock).not.toHaveBeenCalled();
    expect(latestServerInstance.current?.updateLaunchSettings).not.toHaveBeenCalled();
    expect(showInformationMessageMock).not.toHaveBeenCalled();
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
    expect(registerWebviewPanelSerializerMock).toHaveBeenCalledWith(
      'varro.editor',
      expect.anything()
    );
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
    expect(context.subscriptions).toHaveLength(3);
  });

  it.each(primarySidebarHosts)(
    'moves a new installation to the primary sidebar in %s',
    async (appName, uriScheme) => {
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
    }
  );

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

  it('preserves a working fork placement when revealing after a persisted migration', async () => {
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

    expect(executeCommandMock.mock.calls).toEqual([['varro.chat.focus']]);
  });

  it.each(primarySidebarHosts)(
    'preserves an existing user placement in %s without requiring an old migration marker',
    async (appName, uriScheme) => {
      envMock.appName = appName;
      envMock.uriScheme = uriScheme;
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
      const reveal = registerCommandsMock.mock.calls[0]?.[4] as () => Promise<void>;

      expect(executeCommandMock.mock.calls.filter(([command]) => command !== 'setContext')).toEqual(
        []
      );
      await reveal();

      expect(executeCommandMock.mock.calls.filter(([command]) => command !== 'setContext')).toEqual(
        [['varro.chat.focus']]
      );
      expect(globalState.update).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'workbench.view.explorer', 'workbench.views.service.panel.saved-varro'])(
    'does not force an upgrade move after rejected Secondary registration with saved location %s',
    async (savedContainer) => {
      envMock.appName = 'Cursor';
      envMock.uriScheme = 'cursor';
      const registration = registerChatContribution(
        packageJson.contributes,
        false,
        savedContainer,
        {
          'workbench.views.service.panel.saved-varro': 'panel',
        }
      );
      const globalState = {
        get: vi.fn(
          (key: string) =>
            key === 'layout.initialSidebarReveal.v1' || key === 'layout.cursorPrimarySidebar.v1'
        ),
        update: vi.fn(() => Promise.resolve()),
      };
      sidebarProviderMock.mockImplementationOnce(() => {
        latestSidebarProviderInstance.current!.view.visible = false;
      });
      executeCommandMock.mockImplementation((command: string) => {
        if (command === 'varro.chat.focus') {
          latestSidebarProviderInstance.current!.view.visible = registration.location !== undefined;
        }
        return Promise.resolve();
      });
      const { activate } = await import('./extension');
      await activate({
        extensionUri: {},
        extension: { id: 'koltyakov.varro' },
        globalState,
        workspaceState: {},
        subscriptions: [],
      } as never);

      expect(executeCommandMock.mock.calls.filter(([command]) => command !== 'setContext')).toEqual(
        []
      );
      const reveal = registerCommandsMock.mock.calls[0]?.[4] as () => Promise<void>;
      await reveal();
      await reveal();

      expect(registration.currentContainer).toBe(
        savedContainer ?? 'workbench.view.extension.varro'
      );
      expect(executeCommandMock.mock.calls.filter(([command]) => command !== 'setContext')).toEqual(
        [['varro.chat.focus'], ['varro.chat.focus']]
      );
      expect(getCommandsMock).not.toHaveBeenCalled();
      expect(globalState.update).not.toHaveBeenCalled();
    }
  );

  it.each(primarySidebarHosts)(
    'recovers a hidden secondary view in %s after a persisted migration',
    async (appName, uriScheme) => {
      envMock.appName = appName;
      envMock.uriScheme = uriScheme;
      const { activate } = await import('./extension');
      await activate({
        extensionUri: {},
        extension: { id: 'koltyakov.varro' },
        globalState: { get: () => true },
        workspaceState: {},
        subscriptions: [],
      } as never);
      const reveal = registerCommandsMock.mock.calls[0]?.[4] as () => Promise<void>;
      const view = latestSidebarProviderInstance.current!.view;
      view.visible = false;
      executeCommandMock.mockClear();
      executeCommandMock.mockImplementation((command: string) => {
        if (command === 'vscode.moveViews') view.visible = true;
        return Promise.resolve();
      });

      await reveal();

      expect(executeCommandMock.mock.calls).toEqual([
        ['varro.chat.focus'],
        [
          'vscode.moveViews',
          { viewIds: ['varro.chat'], destinationId: 'workbench.view.extension.varro-primary' },
        ],
        ['varro.chat.focus'],
      ]);
      executeCommandMock.mockClear();
      await reveal();
      expect(executeCommandMock.mock.calls).toEqual([['varro.chat.focus']]);
    }
  );

  it.each(['focus rejects', 'move rejects', 'move silently does nothing'])(
    'handles fork recovery when %s without resetting to the unsupported secondary location',
    async (failure) => {
      envMock.appName = 'Cursor';
      envMock.uriScheme = 'cursor';
      const { activate } = await import('./extension');
      await activate({
        extensionUri: {},
        extension: { id: 'koltyakov.varro' },
        globalState: { get: () => true },
        workspaceState: {},
        subscriptions: [],
      } as never);
      const reveal = registerCommandsMock.mock.calls[0]?.[4] as () => Promise<void>;
      const view = latestSidebarProviderInstance.current!.view;
      view.visible = false;
      executeCommandMock.mockClear();
      executeCommandMock.mockImplementation((command: string) => {
        if (command === 'varro.chat.focus' && failure === 'focus rejects' && !view.visible) {
          return Promise.reject(new Error('secondary view unavailable'));
        }
        if (command === 'vscode.moveViews') {
          if (failure === 'move rejects') return Promise.reject(new Error('move unavailable'));
          if (failure !== 'move silently does nothing') view.visible = true;
        }
        return Promise.resolve();
      });

      if (failure === 'focus rejects') {
        await expect(reveal()).resolves.toBeUndefined();
      } else {
        await expect(reveal()).rejects.toThrow(
          failure === 'move rejects'
            ? 'move unavailable'
            : 'The host did not reveal Varro in the Primary Sidebar'
        );
      }
      expect(executeCommandMock).toHaveBeenCalledWith('vscode.moveViews', {
        viewIds: ['varro.chat'],
        destinationId: 'workbench.view.extension.varro-primary',
      });
      expect(executeCommandMock).not.toHaveBeenCalledWith('varro.chat.resetViewLocation');
    }
  );

  it('does not remember a failed first-run fork migration or reveal', async () => {
    envMock.appName = 'Cursor';
    envMock.uriScheme = 'cursor';
    getCommandsMock.mockResolvedValue(['vscode.moveViews']);
    const globalState = {
      get: vi.fn(() => false),
      update: vi.fn(() => Promise.resolve()),
    };
    executeCommandMock.mockImplementation((command: string) => {
      if (command === 'vscode.moveViews') return Promise.reject(new Error('move unavailable'));
      if (command === 'varro.chat.focus') return Promise.reject(new Error('view unavailable'));
      return Promise.resolve();
    });
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to reveal Varro after installation: move unavailable'
      );
    });
    expect(globalState.update).not.toHaveBeenCalled();
    expect(executeCommandMock).not.toHaveBeenCalledWith('varro.chat.resetViewLocation');
  });

  it.each([
    ['Visual Studio Code', 'vscode'],
    ['VSCodium', 'vscodium'],
    ['Cursorish Editor', 'vscode'],
  ])(
    'corrects legacy placement once in %s even when the old migration marker is set',
    async (appName, uriScheme) => {
      envMock.appName = appName;
      envMock.uriScheme = uriScheme;
      const globalState = {
        get: vi.fn(
          (key: string) =>
            key === 'layout.initialSidebarReveal.v1' || key === 'layout.standardSecondarySidebar.v1'
        ),
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

      await vi.waitFor(() => {
        expect(globalState.update).toHaveBeenCalledWith(
          'layout.secondarySidebarRegistration.v2',
          true
        );
      });
      expect(executeCommandMock.mock.calls.filter(([command]) => command !== 'setContext')).toEqual(
        [
          ['workbench.view.extension.varro.resetViewContainerLocation'],
          [
            'vscode.moveViews',
            { viewIds: ['varro.chat'], destinationId: 'workbench.view.extension.varro' },
          ],
          ['varro.chat.focus'],
        ]
      );
      expect(executeCommandMock).not.toHaveBeenCalledWith('workbench.action.resetViewLocations');
      expect(registerCommandsMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.any(Function)
      );
    }
  );

  it.each([
    'varro.chat.focus',
    'vscode.moveViews',
    'workbench.view.extension.varro.resetViewContainerLocation',
  ])('finishes first-run activation while %s waits for activation', async (blockedCommand) => {
    vi.useFakeTimers();
    if (blockedCommand === 'vscode.moveViews') {
      envMock.appName = 'Cursor';
      envMock.uriScheme = 'cursor';
      getCommandsMock.mockResolvedValueOnce(['vscode.moveViews']);
    }
    let releaseCommand!: () => void;
    const commandPending = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    executeCommandMock.mockImplementation((command: string) =>
      command === blockedCommand ? commandPending : Promise.resolve()
    );
    const globalState = {
      get: vi.fn(
        (key: string) =>
          blockedCommand.endsWith('.resetViewContainerLocation') &&
          key === 'layout.initialSidebarReveal.v1'
      ),
      update: vi.fn(() => Promise.resolve()),
    };
    const { activate } = await import('./extension');
    let activated = false;
    const activation = activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never).then(() => {
      activated = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    const finishedBeforeCommand = activated;
    expect(executeCommandMock.mock.calls.some(([command]) => command === blockedCommand)).toBe(
      true
    );
    expect(globalState.update).not.toHaveBeenCalledWith('layout.initialSidebarReveal.v1', true);
    releaseCommand();
    await activation;
    await vi.advanceTimersByTimeAsync(0);

    expect(finishedBeforeCommand).toBe(true);
    if (blockedCommand.endsWith('.resetViewContainerLocation')) {
      expect(globalState.update).toHaveBeenCalledWith(
        'layout.secondarySidebarRegistration.v2',
        true
      );
    } else {
      expect(globalState.update).toHaveBeenCalledWith('layout.initialSidebarReveal.v1', true);
    }
    expect(
      latestSidebarProviderInstance.current?.startProviderFileObservation
    ).toHaveBeenCalledOnce();
    executeCommandMock.mockImplementation(() => Promise.resolve());
  });

  it('reveals the declared secondary view without moving it after installation in VS Code', async () => {
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

    await vi.waitFor(() => {
      expect(globalState.update).toHaveBeenCalledWith('layout.initialSidebarReveal.v1', true);
    });
    expect(executeCommandMock).toHaveBeenCalledWith('varro.chat.focus');
    expect(executeCommandMock.mock.calls.filter(([command]) => command !== 'setContext')).toEqual([
      ['varro.chat.focus'],
    ]);
    expect(globalState.update).toHaveBeenCalledWith('layout.initialSidebarReveal.v1', true);
    expect(globalState.update).toHaveBeenCalledWith('layout.secondarySidebarRegistration.v2', true);
  });

  it.each(['varro.chat.focus'])(
    'does not remember the initial reveal when %s fails',
    async (failedCommand) => {
      executeCommandMock.mockImplementation((command: string) =>
        command === failedCommand
          ? Promise.reject(new Error('view unavailable'))
          : Promise.resolve()
      );
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

      await vi.waitFor(() => {
        expect(loggerMock.warn).toHaveBeenCalledWith(
          'Failed to reveal Varro after installation: view unavailable'
        );
      });
      expect(globalState.update).not.toHaveBeenCalledWith('layout.initialSidebarReveal.v1', true);
      expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'varro:activated', true);
    }
  );

  it('preserves saved placement and visibility after secondary migration', async () => {
    const globalState = {
      get: vi.fn(
        (key: string) =>
          key === 'layout.initialSidebarReveal.v1' ||
          key === 'layout.secondarySidebarRegistration.v2'
      ),
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
    expect(executeCommandMock).not.toHaveBeenCalledWith('workbench.view.extension.varro');
    expect(executeCommandMock).not.toHaveBeenCalledWith('workbench.view.extension.varro-primary');
    expect(executeCommandMock).not.toHaveBeenCalledWith('varro.chat.focus');
    expect(executeCommandMock).not.toHaveBeenCalledWith('vscode.moveViews', expect.anything());
    expect(globalState.update).not.toHaveBeenCalled();
  });

  it.each([
    'workbench.view.extension.varro.resetViewContainerLocation',
    'vscode.moveViews',
    'varro.chat.focus',
    'invisible view',
  ])('does not mark the legacy migration complete when %s fails', async (failure) => {
    const globalState = {
      get: vi.fn((key: string) => key === 'layout.initialSidebarReveal.v1'),
      update: vi.fn(() => Promise.resolve()),
    };
    if (failure === 'invisible view') {
      sidebarProviderMock.mockImplementationOnce(() => {
        latestSidebarProviderInstance.current!.view.visible = false;
      });
    }
    executeCommandMock.mockImplementation((command: string) =>
      command === failure ? Promise.reject(new Error('layout command failed')) : Promise.resolve()
    );
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        failure === 'invisible view'
          ? 'Failed to migrate Varro to the Secondary Sidebar: The host did not reveal Varro in the Secondary Sidebar'
          : 'Failed to migrate Varro to the Secondary Sidebar: layout command failed'
      );
    });
    expect(globalState.update).not.toHaveBeenCalledWith(
      'layout.secondarySidebarRegistration.v2',
      true
    );
  });

  it('logs a failed migration-marker write without reporting completion', async () => {
    const globalState = {
      get: vi.fn((key: string) => key === 'layout.initialSidebarReveal.v1'),
      update: vi.fn(() => Promise.reject(new Error('storage unavailable'))),
    };
    const { activate } = await import('./extension');

    await activate({
      extensionUri: {},
      extension: { id: 'koltyakov.varro' },
      globalState,
      workspaceState: {},
      subscriptions: [],
    } as never);

    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "Failed to remember Varro's Secondary Sidebar registration: storage unavailable"
      );
    });
  });

  it('reveals the saved standard-host location on every reveal without moving or resetting it', async () => {
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
    await (reveal as () => Promise<void>)();

    expect(executeCommandMock.mock.calls).toEqual([['varro.chat.focus'], ['varro.chat.focus']]);
  });

  it('does not reset a saved standard-host placement when revealing fails', async () => {
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
    executeCommandMock.mockRejectedValueOnce(new Error('view unavailable'));

    await expect((reveal as () => Promise<void>)()).rejects.toThrow('view unavailable');

    expect(executeCommandMock.mock.calls).toEqual([['varro.chat.focus']]);
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
    expect(disposeProcessInspectionMock).toHaveBeenCalledOnce();
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
  it('uses a packaged square vector icon for all editor view locations', () => {
    const icon = 'assets/workbench-icon.svg';
    for (const containers of Object.values(packageJson.contributes.viewsContainers)) {
      for (const container of containers) expect(container.icon).toBe(icon);
    }
    for (const views of Object.values(packageJson.contributes.views)) {
      for (const view of views) expect(view.icon).toBe(icon);
    }
    expect(packageJson.files).toContain(icon);
    expect(packageJson.icon).toBe('assets/icon.png');
    const svg = readFileSync(new URL('../../assets/workbench-icon.svg', import.meta.url), 'utf8');
    expect(svg).toContain('width="24" height="24" viewBox="0 0 24 24"');
    expect(svg).toContain('@media (max-width: 16px)');
    expect(svg).toContain('.regular { display: none; }');
    expect(svg).toContain('.compact { display: inline; }');
    expect(svg).toContain('class="compact" transform="scale(1.5)"');
    expect(svg).not.toMatch(/<image\b/);
    const readAttribute = (tag: string, name: string): number => {
      const value = new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1];
      expect(value).toBeDefined();
      return Number(value);
    };
    const compactStart = svg.indexOf('<g class="compact"');
    expect(compactStart).toBeGreaterThan(svg.indexOf('<g class="regular"'));
    const variants = [
      [svg.slice(0, compactStart), 0.7, 4],
      [svg.slice(compactStart), 0.49, 3.5],
    ] as const;
    for (const [variant, minimumGap, minimumConnectorLength] of variants) {
      const nodes = [...variant.matchAll(/<circle\s[^>]+\/>/g)].map(([circle]) => ({
        x: readAttribute(circle, 'cx'),
        y: readAttribute(circle, 'cy'),
        radius: readAttribute(circle, 'r'),
      }));
      const connectors = [...variant.matchAll(/<line\s[^>]+\/>/g)].map(([line]) => line);
      expect(nodes).toHaveLength(3);
      expect(connectors).toHaveLength(3);
      expect(variant).toContain('stroke-linecap="butt"');
      for (const connector of connectors) {
        expect(
          Math.hypot(
            readAttribute(connector, 'x2') - readAttribute(connector, 'x1'),
            readAttribute(connector, 'y2') - readAttribute(connector, 'y1')
          )
        ).toBeGreaterThanOrEqual(minimumConnectorLength);
        for (const endpoint of ['1', '2']) {
          const x = readAttribute(connector, `x${endpoint}`);
          const y = readAttribute(connector, `y${endpoint}`);
          for (const node of nodes) {
            expect(Math.hypot(x - node.x, y - node.y) - node.radius).toBeGreaterThanOrEqual(
              minimumGap
            );
          }
        }
      }
    }
  });

  it('contributes quick actions to the Varro view title', () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.chat.openSettings',
      title: 'Varro: Open Settings',
      shortTitle: 'Settings',
      icon: '$(gear)',
    });
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.chat.showFileDiffs',
      title: 'Varro: Show File Diffs',
      shortTitle: 'Show File Diffs',
      icon: '$(diff-single)',
    });
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.chat.hideFileDiffs',
      title: 'Varro: Hide File Diffs',
      shortTitle: 'Hide File Diffs',
      icon: '$(list-flat)',
    });
    expect(packageJson.contributes.submenus).toContainEqual({
      id: 'varro.viewActions',
      label: 'More Actions',
      icon: '$(more)',
    });
    expect(packageJson.contributes.menus['view/title']).toEqual([
      {
        command: 'varro.chat.showFileDiffs',
        when: 'view == varro.chat && !varro:showFileDiffs',
        group: 'navigation@0',
      },
      {
        command: 'varro.chat.hideFileDiffs',
        when: 'view == varro.chat && varro:showFileDiffs',
        group: 'navigation@0',
      },
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
    expect(packageJson.contributes.menus.commandPalette).toEqual(
      expect.arrayContaining([
        {
          command: 'varro.chat.showFileDiffs',
          when: '!varro:showFileDiffs',
        },
        {
          command: 'varro.chat.hideFileDiffs',
          when: 'varro:showFileDiffs',
        },
      ])
    );
  });

  it('contributes new chat and terminal actions to Varro editor tabs', () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.chat.newEditor',
      title: 'Varro: New Chat Editor',
      shortTitle: 'New Chat Editor',
      icon: '$(add)',
    });
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.chat.newTerminalEditor',
      title: 'Varro: New Terminal Editor',
      shortTitle: 'New Terminal Editor',
      icon: '$(terminal)',
    });
    expect(packageJson.contributes.menus['editor/title']).toEqual([
      {
        command: 'varro.chat.newEditor',
        when: 'activeWebviewPanelId == varro.editor',
        group: 'navigation@1',
      },
      {
        command: 'varro.chat.newTerminalEditor',
        when: 'activeWebviewPanelId == varro.editor',
        group: 'navigation@2',
      },
    ]);
  });

  it('contributes commit-message generation and repository-scoped cancellation', () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.generateCommitMessage',
      title: 'Varro: Generate Commit Message',
      icon: '$(wand)',
    });
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'varro.cancelCommitMessage',
      title: 'Varro: Cancel Commit Message Generation',
      icon: '$(debug-stop)',
      enablement: 'varro:generatingCommitMessage',
    });
    expect(packageJson.contributes.menus['scm/title']).toEqual([
      {
        command: 'varro.generateCommitMessage',
        when: 'scmProvider == git && scmProviderRootUri not in varro:commitMessageGenerationRoots',
        group: 'navigation@99',
      },
      {
        command: 'varro.cancelCommitMessage',
        when: 'scmProvider == git && scmProviderRootUri in varro:commitMessageGenerationRoots',
        group: 'navigation@99',
      },
    ]);
  });

  it('contributes repository-scoped commit-message rules', () => {
    expect(
      packageJson.contributes.configuration.properties['varro.commitMessage.rules']
    ).toMatchObject({
      type: 'string',
      scope: 'resource',
      default: '',
    });
  });

  it('constrains the server port setting to valid TCP ports', () => {
    const properties = packageJson.contributes.configuration.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties['varro.server.port']).toMatchObject({
      default: 'auto',
      oneOf: [
        { type: 'string', enum: ['auto'] },
        { type: 'integer', minimum: 1, maximum: 65_535 },
      ],
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

  it('contributes a nullable Varro chat font-size override', () => {
    const properties = packageJson.contributes.configuration.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties['varro.chat.fontSize']).toMatchObject({
      type: ['number', 'null'],
      minimum: 6,
      maximum: 100,
      default: null,
    });
  });

  it('contributes the enabled-by-default active turn timer setting', () => {
    const properties = packageJson.contributes.configuration.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties['varro.chat.showTurnTimer']).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('activates on Varro use instead of every VS Code startup', () => {
    expect(packageJson.contributes.views.varro).toContainEqual(
      expect.objectContaining({ id: 'varro.chat' })
    );
    expect(packageJson.activationEvents).not.toContain('onView:varro.chat');
    expect(packageJson.activationEvents).not.toContain('onStartupFinished');
  });

  it('declares Secondary first and the same container in Primary for hosts that reject Secondary', () => {
    expect(Object.keys(packageJson.contributes.viewsContainers)).toEqual([
      'secondarySidebar',
      'activitybar',
    ]);
    expect(packageJson.contributes.viewsContainers.secondarySidebar).toContainEqual(
      expect.objectContaining({ id: 'varro' })
    );
    expect(packageJson.contributes.viewsContainers.activitybar).toContainEqual(
      expect.objectContaining({ id: 'varro-primary' })
    );
    expect(packageJson.contributes.viewsContainers.activitybar).toContainEqual(
      expect.objectContaining({ id: 'varro' })
    );
    expect(Object.keys(packageJson.contributes.views)).toEqual(['varro']);
    expect(packageJson.contributes.commands).toContainEqual(
      expect.objectContaining({ command: 'varro.chat.focusInput' })
    );
    expect(packageJson.contributes.commands).not.toContainEqual(
      expect.objectContaining({ command: 'varro.chat.focus' })
    );
  });

  it('contributes a disabled-by-default empty-state histogram setting', () => {
    const properties = packageJson.contributes.configuration.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties['varro.chat.showEmptyStateHistogram']).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });
});
