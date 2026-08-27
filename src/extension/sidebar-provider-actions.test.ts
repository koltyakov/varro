/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- These action tests verify imported VS Code commands with partial provider and private-state fixtures. */
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
    openPath: vi.fn<SidebarProviderActionDeps['contextProvider']['openPath']>(() =>
      Promise.resolve('opened')
    ),
  };
  contextProvider.clearTerminalSelection.mockImplementation(() => {
    contextProvider.terminalSelection = null;
  });

  const webviewSession = {
    updateCommandState: vi.fn(),
    reload: vi.fn(() => Promise.resolve()),
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
    cancelRequest: vi.fn(),
  };
  const sessionDiffProvider = {
    open: vi.fn<SessionDiffProvider['open']>(() => Promise.resolve('unavailable')),
  } satisfies SessionDiffProvider;
  const toolOutputProvider = {
    open: vi.fn<ToolOutputProvider['open']>(() => Promise.resolve(undefined)),
  } satisfies ToolOutputProvider;
  const server = {
    getWorkspaceCwd: vi.fn(() => '/repo'),
    request: vi.fn(async (_method: string, path: string) => ({
      id: decodeURIComponent(path.slice('/session/'.length)),
      directory: '/repo',
    })),
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
    acknowledgeSessionSeen: vi.fn(),
    revealPermission: vi.fn(),
    setMermaidPreviewOpen: vi.fn(),
    setActiveRoute: vi.fn(),
    refreshProviders: vi.fn(() => Promise.resolve()),
    providerReauthenticated: vi.fn(() => Promise.resolve()),
    postContext: vi.fn(),
    selectWorkspace: vi.fn(() => Promise.resolve()),
    postTerminalSelection: vi.fn(),
    postConfigState: vi.fn(),
    handleReadyMessage: vi.fn(() => Promise.resolve()),
    handleDroppedPaths: vi.fn(() => Promise.resolve()),
    handleDroppedContent: vi.fn(() => Promise.resolve()),
    storePdf: vi.fn(() => Promise.resolve()),
    storeImage: vi.fn(() => Promise.resolve()),
    releaseImages: vi.fn(() => Promise.resolve()),
    removeContextFile: vi.fn(),
    clearContextFiles: vi.fn(),
    pickFiles: vi.fn(() => Promise.resolve()),
    searchFiles: vi.fn(),
    runInTerminal: vi.fn(),
    openSessionInTerminal: vi.fn(),
    openSessionInEditor: vi.fn(),
    openSessionInSidebar: vi.fn(),
    openNewEditor: vi.fn(),
    editorRouteChanged: vi.fn(),
    handleRalphMessage: vi.fn<SidebarProviderActionDeps['handleRalphMessage']>(),
    updateQueuedMessages: vi.fn<SidebarProviderActionDeps['updateQueuedMessages']>(() =>
      Promise.resolve()
    ),
    claimQueuedMessage: vi.fn<SidebarProviderActionDeps['claimQueuedMessage']>(),
    releaseQueuedMessage: vi.fn<SidebarProviderActionDeps['releaseQueuedMessage']>(),
    acknowledgeInterruptedSessions: vi.fn<
      SidebarProviderActionDeps['acknowledgeInterruptedSessions']
    >(() => Promise.resolve()),
    updatePermissionMode: vi.fn<SidebarProviderActionDeps['updatePermissionMode']>(() =>
      Promise.resolve()
    ),
    migratePermissionModes: vi.fn<SidebarProviderActionDeps['migratePermissionModes']>(() =>
      Promise.resolve()
    ),
    updateSessionModel: vi.fn<SidebarProviderActionDeps['updateSessionModel']>(() =>
      Promise.resolve()
    ),
    migrateSessionModels: vi.fn<SidebarProviderActionDeps['migrateSessionModels']>(() =>
      Promise.resolve()
    ),
    updateSessionPlanState: vi.fn<SidebarProviderActionDeps['updateSessionPlanState']>(() =>
      Promise.resolve()
    ),
    updateModelPreferences: vi.fn<SidebarProviderActionDeps['updateModelPreferences']>(() =>
      Promise.resolve()
    ),
    migrateModelPreferences: vi.fn<SidebarProviderActionDeps['migrateModelPreferences']>(() =>
      Promise.resolve()
    ),
    updateDraftImages: vi.fn<SidebarProviderActionDeps['updateDraftImages']>(() =>
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

  it('routes workspace selection through the endpoint callback', async () => {
    const { actions, deps } = createActionFixture();

    await actions.selectWorkspace('/repo-b');

    expect(deps.selectWorkspace).toHaveBeenCalledWith('/repo-b');
  });

  it('opens an OpenCode session in the terminal', async () => {
    const { actions, deps } = createActionFixture();

    await actions.openSessionInOpenCode('session-1');

    expect(deps.openSessionInTerminal).toHaveBeenCalledWith('session-1');
  });

  it('refuses to open an OpenCode session from another workspace', async () => {
    const { actions, deps, server } = createActionFixture();
    Object.assign(server, {
      getWorkspaceCwd: vi.fn(() => '/repo'),
      request: vi.fn(async () => ({ id: 'session-foreign', directory: '/other-repo' })),
    });

    await expect(actions.openSessionInOpenCode('session-foreign')).rejects.toThrow(
      'Session does not belong to the current workspace'
    );

    expect(deps.openSessionInTerminal).not.toHaveBeenCalled();
  });

  it('validates a session before opening it in an editor', async () => {
    const { actions, deps, server } = createActionFixture();

    await actions.openSessionInEditor('session-1', 'Editor session');
    expect(deps.openSessionInEditor).toHaveBeenCalledWith(
      'session-1',
      'Editor session',
      undefined,
      undefined
    );

    server.request.mockResolvedValueOnce({ id: 'session-foreign', directory: '/other-repo' });
    await expect(actions.openSessionInEditor('session-foreign')).rejects.toThrow(
      'Session does not belong to the current workspace'
    );
    expect(deps.openSessionInEditor).not.toHaveBeenCalledWith('session-foreign');
  });

  it('validates a session before opening it in the sidebar', async () => {
    const { actions, deps, server } = createActionFixture();

    await actions.openSessionInSidebar('session-1');
    expect(deps.openSessionInSidebar).toHaveBeenCalledWith('session-1');

    server.request.mockResolvedValueOnce({ id: 'session-foreign', directory: '/other-repo' });
    await expect(actions.openSessionInSidebar('session-foreign')).rejects.toThrow(
      'Session does not belong to the current workspace'
    );
    expect(deps.openSessionInSidebar).not.toHaveBeenCalledWith('session-foreign');
  });

  it('does not fall back to opening a path rejected by the session diff guard', async () => {
    const { actions, contextProvider, deps } = createActionFixture();
    deps.sessionDiffProvider.open.mockResolvedValue('forbidden');

    await actions.openPath({
      path: '/other-repo/src/app.ts',
      view: 'diff',
      sessionID: 'session-foreign',
      requestId: 7,
    });

    expect(contextProvider.openPath).not.toHaveBeenCalled();
    expect(deps.post).toHaveBeenCalledWith({
      type: 'vscode/open-result',
      payload: { requestId: 7, status: 'unavailable' },
    });
  });

  it('updates command state and mirrors the active chat model', () => {
    const { actions, deps, webviewSession } = createActionFixture();
    const model = { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' };

    actions.updateCommandState(true, false, model);

    expect(webviewSession.updateCommandState).toHaveBeenCalledWith(true, false);
    expect(deps.setActiveChatModel).toHaveBeenCalledWith(model);
  });

  it('forwards session read acknowledgements', () => {
    const { actions, deps } = createActionFixture();

    actions.acknowledgeSessionSeen('session-1');

    expect(deps.acknowledgeSessionSeen).toHaveBeenCalledWith('session-1');
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
    await actions.reloadWebview();
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
    expect(webviewSession.reload).toHaveBeenCalledOnce();
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

  it('posts the correlated file-open result', async () => {
    const { actions, deps, contextProvider } = createActionFixture();
    contextProvider.openPath.mockResolvedValueOnce('unavailable');

    await actions.openPath({ path: '/repo/missing.ts', kind: 'file', requestId: 41 });

    expect(deps.post).toHaveBeenCalledWith({
      type: 'vscode/open-result',
      payload: { requestId: 41, status: 'unavailable' },
    });
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
