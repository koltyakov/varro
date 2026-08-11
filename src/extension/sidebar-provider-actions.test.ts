import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const config = {
    update: vi.fn(() => Promise.resolve()),
  };

  return {
    config,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
    },
    vscode: {
      commands: {
        executeCommand: vi.fn(() => Promise.resolve()),
      },
      env: {
        openExternal: vi.fn(() => Promise.resolve()),
      },
      workspace: {
        getConfiguration: vi.fn(() => config),
      },
      Uri: {
        parse: vi.fn((value: string) => ({ value })),
      },
      ConfigurationTarget: {
        Global: 'global',
      },
    },
  };
});

vi.mock('vscode', () => mocks.vscode);
vi.mock('./logger', () => ({ logger: mocks.logger }));

import type { SidebarProviderActionDeps } from './sidebar-provider-actions';
import { createSidebarProviderActions } from './sidebar-provider-actions';

type SessionDiffProvider = Pick<SidebarProviderActionDeps['sessionDiffProvider'], 'open'>;
type ToolOutputProvider = Pick<SidebarProviderActionDeps['toolOutputProvider'], 'open'>;
type SidebarProviderActionFixtureDeps = Omit<
  SidebarProviderActionDeps,
  'sessionDiffProvider' | 'toolOutputProvider'
> & {
  sessionDiffProvider: SessionDiffProvider;
  toolOutputProvider: ToolOutputProvider;
};
type CreateSidebarProviderActionsForTest = (
  deps: SidebarProviderActionFixtureDeps
) => ReturnType<typeof createSidebarProviderActions>;

const createSidebarProviderActionsForTest =
  createSidebarProviderActions as CreateSidebarProviderActionsForTest;

function createActionFixture() {
  const contextProvider = {
    terminalSelection: { text: 'npm test', terminalName: 'Terminal 1' } as {
      text: string;
      terminalName: string;
    } | null,
    clearTerminalSelection: vi.fn(),
    readFile: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve()),
  };
  contextProvider.clearTerminalSelection.mockImplementation(() => {
    contextProvider.terminalSelection = null;
  });

  const webviewSession = {
    setFocus: vi.fn(),
    updateCommandState: vi.fn(),
  };
  const contextFilesState = {
    notifyContextFilesChanged: vi.fn(),
  };
  const sessionExportService = {
    exportSession: vi.fn(() => Promise.resolve()),
  };
  const usageReportService = {
    openReport: vi.fn(() => Promise.resolve()),
  };
  const restProxy = {
    handleRequest: vi.fn(() => Promise.resolve()),
  };
  const sessionDiffProvider = {
    open: vi.fn<SessionDiffProvider['open']>(() => Promise.resolve(false)),
  } satisfies SessionDiffProvider;
  const toolOutputProvider = {
    open: vi.fn<ToolOutputProvider['open']>(() => Promise.resolve(false)),
  } satisfies ToolOutputProvider;
  const server = {
    readRestartBlockers: vi.fn(() =>
      Promise.resolve({
        totalSessionCount: 2,
        directories: [{ directory: '/repo', sessionCount: 2 }],
      })
    ),
  };

  const deps = {
    contextProvider: contextProvider as unknown as SidebarProviderActionDeps['contextProvider'],
    extensionId: 'koltyakov.varro',
    webviewSession,
    contextFilesState:
      contextFilesState as unknown as SidebarProviderActionDeps['contextFilesState'],
    sessionExportService:
      sessionExportService as unknown as SidebarProviderActionDeps['sessionExportService'],
    usageReportService:
      usageReportService as unknown as SidebarProviderActionDeps['usageReportService'],
    restProxy: restProxy as unknown as SidebarProviderActionDeps['restProxy'],
    sessionDiffProvider,
    toolOutputProvider,
    server: server as unknown as SidebarProviderActionDeps['server'],
    post: vi.fn(),
    setProviderWatchActive: vi.fn(),
    setActiveChatModel: vi.fn(),
    revealPermission: vi.fn(),
    refreshProviders: vi.fn(() => Promise.resolve()),
    postContext: vi.fn(),
    postTerminalSelection: vi.fn(),
    postConfigState: vi.fn(),
    handleReadyMessage: vi.fn(() => Promise.resolve()),
    handleDroppedPaths: vi.fn(() => Promise.resolve()),
    handleDroppedContent: vi.fn(() => Promise.resolve()),
    removeContextFile: vi.fn(),
    clearContextFiles: vi.fn(),
    pickFiles: vi.fn(() => Promise.resolve()),
    searchFiles: vi.fn(),
    runInTerminal: vi.fn(),
    handleRalphMessage: vi.fn<SidebarProviderActionDeps['handleRalphMessage']>(),
    updateQueuedMessages: vi.fn<SidebarProviderActionDeps['updateQueuedMessages']>(() =>
      Promise.resolve()
    ),
  } satisfies SidebarProviderActionFixtureDeps;

  return {
    actions: createSidebarProviderActionsForTest(deps),
    contextFilesState,
    contextProvider,
    deps,
    restProxy,
    sessionExportService,
    usageReportService,
    server,
    webviewSession,
  };
}

describe('createSidebarProviderActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vscode.workspace.getConfiguration.mockReturnValue(mocks.config);
    mocks.vscode.Uri.parse.mockImplementation((value: string) => ({ value }));
  });

  it('opens an OpenCode session in the terminal', async () => {
    const { actions, deps } = createActionFixture();

    await actions.openSessionInOpenCode('session-1');

    expect(deps.runInTerminal).toHaveBeenCalledWith(
      'opencode --session session-1',
      'OpenCode Session'
    );
  });

  it('updates command state and mirrors the active chat model', () => {
    const { actions, deps, webviewSession } = createActionFixture();
    const model = { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' };

    actions.updateCommandState(true, false, model);

    expect(webviewSession.updateCommandState).toHaveBeenCalledWith(true, false);
    expect(deps.setActiveChatModel).toHaveBeenCalledWith(model);
  });

  it('posts blocker updates while polling and restarts once the server is idle', async () => {
    const { actions, deps, server } = createActionFixture();

    await actions.checkServerRestart(4);
    expect(deps.post).toHaveBeenCalledWith({
      type: 'server/restart-blocked',
      payload: {
        totalSessionCount: 2,
        directories: [{ directory: '/repo', sessionCount: 2 }],
        checkId: 4,
      },
    });

    server.readRestartBlockers.mockResolvedValueOnce({
      totalSessionCount: 0,
      directories: [],
    });
    await actions.checkServerRestart(5);
    expect(mocks.vscode.commands.executeCommand).toHaveBeenCalledWith('varro.server.restart');
  });

  it('forwards host-backed actions to the injected dependencies', async () => {
    const {
      actions,
      contextFilesState,
      contextProvider,
      deps,
      restProxy,
      sessionExportService,
      usageReportService,
      webviewSession,
    } = createActionFixture();

    await actions.ready();
    actions.setWebviewFocus(true);
    actions.setProviderWatchActive(true);
    actions.requestContext();
    await actions.refreshProviders();
    actions.showOutput();
    actions.clearTerminalSelection();
    actions.runInTerminal('npm test', 'Tests');
    await actions.exportSession('session-1');
    await actions.generateUsageReport(false);
    await actions.handleDroppedPaths(['/repo/a.ts']);
    await actions.handleDroppedContent([{ name: 'a.ts', content: 'QQ==', size: 1 }]);
    actions.removeContextFile('/repo/a.ts');
    actions.clearContextFiles();
    actions.notifyContextFilesChanged();
    await actions.pickFiles();
    actions.searchFiles(7, 'src', 25);
    await actions.readContextFile('/repo/a.ts');
    await actions.openPath({ path: '/repo/a.ts', line: 12, kind: 'file', view: 'diff' });
    await actions.handleApiRequest({ id: 4, method: 'GET', path: '/api', body: { ok: true } });

    expect(deps.handleReadyMessage).toHaveBeenCalledOnce();
    expect(webviewSession.setFocus).toHaveBeenCalledWith(true);
    expect(deps.setProviderWatchActive).toHaveBeenCalledWith(true);
    expect(deps.postContext).toHaveBeenCalledTimes(2);
    expect(deps.refreshProviders).toHaveBeenCalledOnce();
    expect(mocks.logger.show).toHaveBeenCalledOnce();
    expect(deps.postTerminalSelection).toHaveBeenNthCalledWith(1, {
      text: 'npm test',
      terminalName: 'Terminal 1',
    });
    expect(deps.postTerminalSelection).toHaveBeenNthCalledWith(2, null);
    expect(contextProvider.clearTerminalSelection).toHaveBeenCalledOnce();
    expect(deps.runInTerminal).toHaveBeenCalledWith('npm test', 'Tests');
    expect(sessionExportService.exportSession).toHaveBeenCalledWith('session-1');
    expect(usageReportService.openReport).toHaveBeenCalledWith(false);
    expect(deps.handleDroppedPaths).toHaveBeenCalledWith(['/repo/a.ts']);
    expect(deps.handleDroppedContent).toHaveBeenCalledWith([
      { name: 'a.ts', content: 'QQ==', size: 1 },
    ]);
    expect(deps.removeContextFile).toHaveBeenCalledWith('/repo/a.ts');
    expect(deps.clearContextFiles).toHaveBeenCalledOnce();
    expect(contextFilesState.notifyContextFilesChanged).toHaveBeenCalledOnce();
    expect(deps.pickFiles).toHaveBeenCalledOnce();
    expect(deps.searchFiles).toHaveBeenCalledWith(7, 'src', 25);
    expect(contextProvider.readFile).toHaveBeenCalledWith('/repo/a.ts');
    expect(contextProvider.openPath).toHaveBeenCalledWith('/repo/a.ts', {
      line: 12,
      kind: 'file',
      view: 'diff',
    });
    expect(restProxy.handleRequest).toHaveBeenCalledWith({
      id: 4,
      method: 'GET',
      path: '/api',
      body: { ok: true },
    });
  });

  it('opens settings with explicit and default extension queries', async () => {
    const { actions } = createActionFixture();

    await actions.openSettings('@modified');
    await actions.openSettings();

    expect(mocks.vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      'workbench.action.openSettings',
      '@modified'
    );
    expect(mocks.vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      2,
      'workbench.action.openSettings',
      '@ext:koltyakov.varro'
    );
  });

  it('opens the native folder picker', async () => {
    const { actions } = createActionFixture();

    await actions.openFolder();

    expect(mocks.vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.files.openFolder'
    );
  });

  it('opens https links externally and rejects unsupported urls', async () => {
    const { actions } = createActionFixture();

    await actions.openExternal('https://example.com/docs');

    expect(mocks.vscode.Uri.parse).toHaveBeenCalledWith('https://example.com/docs');
    expect(mocks.vscode.env.openExternal).toHaveBeenCalledWith({
      value: 'https://example.com/docs',
    });

    await expect(actions.openExternal('http://example.com/docs')).rejects.toThrow(
      'Unsupported external URL'
    );
    expect(mocks.vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it('persists supported config values and posts the refreshed state', async () => {
    const { actions, deps } = createActionFixture();

    await actions.updateConfig({
      desktopSessionPaneSide: 'right',
      defaultPermissionMode: 'full',
    });

    expect(mocks.vscode.workspace.getConfiguration).toHaveBeenCalledTimes(2);
    expect(mocks.vscode.workspace.getConfiguration).toHaveBeenNthCalledWith(1, 'varro');
    expect(mocks.config.update).toHaveBeenNthCalledWith(
      1,
      'chat.desktopSessionPaneSide',
      'right',
      'global'
    );
    expect(mocks.config.update).toHaveBeenNthCalledWith(
      2,
      'chat.defaultPermissionMode',
      'full',
      'global'
    );
    expect(deps.postConfigState).toHaveBeenCalledOnce();
  });

  it('routes webview logs to the matching logger level', () => {
    const { actions } = createActionFixture();

    actions.log({ msg: 'hello' });
    actions.log({ msg: 'careful', data: 'details', level: 'warn' });
    actions.log({ msg: 'broken', data: 'request', error: 'boom', level: 'error' });

    expect(mocks.logger.info).toHaveBeenCalledWith('[webview] hello');
    expect(mocks.logger.warn).toHaveBeenCalledWith('[webview] careful details');
    expect(mocks.logger.error).toHaveBeenCalledWith('[webview] broken request boom');
  });
});
