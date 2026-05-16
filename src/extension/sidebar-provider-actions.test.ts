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
  };
  const contextFilesState = {
    notifyContextFilesChanged: vi.fn(),
  };
  const sessionExportService = {
    exportSession: vi.fn(() => Promise.resolve()),
  };
  const restProxy = {
    handleRequest: vi.fn(() => Promise.resolve()),
  };

  const deps: SidebarProviderActionDeps = {
    contextProvider: contextProvider as unknown as SidebarProviderActionDeps['contextProvider'],
    webviewSession,
    contextFilesState:
      contextFilesState as unknown as SidebarProviderActionDeps['contextFilesState'],
    sessionExportService:
      sessionExportService as unknown as SidebarProviderActionDeps['sessionExportService'],
    restProxy: restProxy as unknown as SidebarProviderActionDeps['restProxy'],
    setProviderWatchActive: vi.fn(),
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
  };

  return {
    actions: createSidebarProviderActions(deps),
    contextFilesState,
    contextProvider,
    deps,
    restProxy,
    sessionExportService,
    webviewSession,
  };
}

describe('createSidebarProviderActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vscode.workspace.getConfiguration.mockReturnValue(mocks.config);
    mocks.vscode.Uri.parse.mockImplementation((value: string) => ({ value }));
  });

  it('forwards host-backed actions to the injected dependencies', async () => {
    const {
      actions,
      contextFilesState,
      contextProvider,
      deps,
      restProxy,
      sessionExportService,
      webviewSession,
    } = createActionFixture();

    await actions.ready();
    actions.setWebviewFocus(true);
    actions.setProviderWatchActive(true);
    actions.requestContext();
    actions.refreshProviders();
    actions.clearTerminalSelection();
    actions.runInTerminal('npm test', 'Tests');
    await actions.exportSession('session-1');
    await actions.handleDroppedPaths(['/repo/a.ts']);
    await actions.handleDroppedContent([{ name: 'a.ts', content: 'QQ==', size: 1 }]);
    actions.removeContextFile('/repo/a.ts');
    actions.clearContextFiles();
    actions.notifyContextFilesChanged();
    await actions.pickFiles();
    actions.searchFiles(7, 'src', 25);
    await actions.readContextFile('/repo/a.ts');
    await actions.openPath({ path: '/repo/a.ts', line: 12, kind: 'file' });
    await actions.handleApiRequest({ id: 4, method: 'GET', path: '/api', body: { ok: true } });

    expect(deps.handleReadyMessage).toHaveBeenCalledOnce();
    expect(webviewSession.setFocus).toHaveBeenCalledWith(true);
    expect(deps.setProviderWatchActive).toHaveBeenCalledWith(true);
    expect(deps.postContext).toHaveBeenCalledTimes(2);
    expect(deps.postConfigState).toHaveBeenCalledTimes(1);
    expect(deps.postTerminalSelection).toHaveBeenNthCalledWith(1, {
      text: 'npm test',
      terminalName: 'Terminal 1',
    });
    expect(deps.postTerminalSelection).toHaveBeenNthCalledWith(2, null);
    expect(contextProvider.clearTerminalSelection).toHaveBeenCalledOnce();
    expect(deps.runInTerminal).toHaveBeenCalledWith('npm test', 'Tests');
    expect(sessionExportService.exportSession).toHaveBeenCalledWith('session-1');
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
      expandThinkingByDefault: true,
      showStickyUserPrompt: false,
      desktopSessionPaneSide: 'right',
      defaultPermissionMode: 'full',
    });

    expect(mocks.vscode.workspace.getConfiguration).toHaveBeenCalledTimes(4);
    expect(mocks.vscode.workspace.getConfiguration).toHaveBeenNthCalledWith(1, 'varro');
    expect(mocks.config.update).toHaveBeenNthCalledWith(
      1,
      'chat.expandThinkingByDefault',
      true,
      'global'
    );
    expect(mocks.config.update).toHaveBeenNthCalledWith(
      2,
      'chat.showStickyUserPrompt',
      false,
      'global'
    );
    expect(mocks.config.update).toHaveBeenNthCalledWith(
      3,
      'chat.desktopSessionPaneSide',
      'right',
      'global'
    );
    expect(mocks.config.update).toHaveBeenNthCalledWith(
      4,
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
