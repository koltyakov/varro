/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- This support module supplies extension-host import fakes and protocol-shaped fixtures shared by sidebar tests. */
import { beforeEach, vi } from 'vitest';
import type * as FsPromises from 'fs/promises';
import type { EditorContext } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  configurationValues: new Map<string, unknown>(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  spawn: vi.fn(),
  mkdtemp: vi.fn(),
  open: vi.fn(),
  providerSignatureFileSystem: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  readFile: vi.fn(),
  rm: vi.fn(),
  vscode: {
    env: { remoteName: undefined as string | undefined },
    extensions: {
      getExtension: vi.fn(() => ({ packageJSON: { version: '0.26.4' } })),
    },
    window: {
      createStatusBarItem: vi.fn((_id: string, _alignment: number, _priority: number) => ({
        name: '',
        command: '',
        text: '',
        tooltip: '',
        backgroundColor: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      })),
      createWebviewPanel: vi.fn(),
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
      activeColorTheme: { kind: 2 },
      showOpenDialog: vi.fn(() => Promise.resolve(undefined)),
      showTextDocument: vi.fn(() => Promise.resolve()),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
      createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
      onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    },
    workspace: {
      asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
      textDocuments: [] as Array<{
        isDirty: boolean;
        uri: { fsPath: string; toString(): string };
      }>,
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      onDidChangeConfiguration: vi.fn(
        (_listener?: (event: { affectsConfiguration(key: string): boolean }) => void) => ({
          dispose: vi.fn(),
        })
      ),
      registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
      onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      getWorkspaceFolder: vi.fn(() => undefined),
      getConfiguration: vi.fn(),
      fs: {
        readFile: vi.fn(),
        stat: vi.fn(),
        writeFile: vi.fn(() => Promise.resolve()),
      },
      openTextDocument: vi.fn(() => Promise.resolve({})),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    TerminalLocation: { Panel: 1, Editor: 2 },
    ThemeColor: class ThemeColor {
      constructor(public readonly value: string) {}
    },
    ThemeIcon: class ThemeIcon {
      constructor(public readonly id: string) {}
    },
    RelativePattern: class RelativePattern {
      constructor(
        public readonly base: unknown,
        public readonly pattern: string
      ) {}
    },
    ColorThemeKind: {
      Light: 1,
      Dark: 2,
      HighContrast: 3,
      HighContrastLight: 4,
    },
    FileType: {
      Unknown: 0,
      File: 1,
      Directory: 2,
      SymbolicLink: 64,
    },
    ConfigurationTarget: { Global: 1 },
    Uri: {
      joinPath: vi.fn(() => ({ toString: () => 'vscode-resource://icon.png' })),
      file: vi.fn((fsPath: string) => ({ fsPath, toString: () => fsPath })),
      from: vi.fn((value: { scheme: string; path: string }) => ({
        ...value,
        toString: () => `${value.scheme}:${value.path}`,
      })),
    },
  },
}));

export function getLoggerMock() {
  return mocks.logger;
}

export function getSpawnMock() {
  return mocks.spawn;
}

export function getProviderSignatureFileSystemMock() {
  return mocks.providerSignatureFileSystem;
}

export function getVscodeMock() {
  return mocks.vscode;
}

export function getConfigurationValue(key: string) {
  return mocks.configurationValues.get(key);
}

vi.mock('vscode', () => mocks.vscode);
vi.mock('child_process', () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }));
vi.mock('cross-spawn', () => ({ default: mocks.spawn, spawn: mocks.spawn }));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises');
  return {
    ...actual,
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readFile: mocks.readFile,
    rm: mocks.rm,
  };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises');
  return {
    ...actual,
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readFile: mocks.readFile,
    rm: mocks.rm,
  };
});
vi.mock('./logger', () => ({ logger: mocks.logger }));
vi.mock('./error-hub', () => ({
  errorHub: {
    report: vi.fn(),
    reportCliMissing: vi.fn(),
  },
}));

export function createWorkspaceState() {
  return {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
    update: vi.fn((_key: string, _value: unknown) => Promise.resolve()),
  };
}

export function createContextProvider() {
  const context: EditorContext = {
    workspacePath: '/repo',
    activeFile: null,
    selection: null,
    diagnostics: [],
  };
  const provider = {
    context,
    terminalSelection: null,
    getOpenWorkspaceRoot: vi.fn<(path: string) => string | null>((path: string) => path),
    clearTerminalSelection: vi.fn(),
    readFile: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve()),
    selectWorkspace: vi.fn(async (path: string) => {
      provider.context.workspacePath = path;
    }),
  };
  return provider;
}

export function createServer(
  overrides: Partial<{
    status: { state: string; url?: string; message?: string };
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
    readServerInfo: ReturnType<typeof vi.fn>;
    getWorkspaceCwd: ReturnType<typeof vi.fn>;
    resolveCommand: ReturnType<typeof vi.fn>;
    prepareForWindowsCliUpgrade: ReturnType<typeof vi.fn>;
    finishWindowsCliUpgrade: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    status: { state: 'running', url: 'http://127.0.0.1:4096' },
    on: vi.fn(),
    off: vi.fn(),
    start: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
    request: vi.fn(),
    restart: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
    readServerInfo: vi.fn(() => Promise.resolve({ managedProcess: true })),
    getWorkspaceCwd: vi.fn(() => '/repo'),
    resolveCommand: vi.fn(() => 'opencode'),
    prepareForWindowsCliUpgrade: vi.fn(() => Promise.resolve()),
    finishWindowsCliUpgrade: vi.fn(),
    ...overrides,
  };
}

export function attachTestView(provider: object) {
  const posted: unknown[] = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      postMessage: vi.fn((message: unknown) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      asWebviewUri: vi.fn((uri: { toString?: () => string }) => uri),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
  };

  (provider as { view?: unknown }).view = view;
  return { posted, view };
}

export async function loadSidebarProvider() {
  return import('./sidebar-provider');
}

export async function createSidebarProviderInstance(
  options: {
    extensionUri?: { fsPath: string };
    workspaceState?: ReturnType<typeof createWorkspaceState>;
    contextProvider?: ReturnType<typeof createContextProvider>;
    providerSignatureFileSystem?: typeof mocks.providerSignatureFileSystem;
    server?: ReturnType<typeof createServer>;
  } = {}
) {
  const { SidebarProvider } = await loadSidebarProvider();
  const workspaceState = options.workspaceState ?? createWorkspaceState();
  const contextProvider = options.contextProvider ?? createContextProvider();
  const server = options.server ?? createServer();
  const provider = new SidebarProvider(
    (options.extensionUri ?? { fsPath: '/extension' }) as never,
    workspaceState as never,
    contextProvider as never,
    server as never,
    'koltyakov.varro',
    false,
    options.providerSignatureFileSystem ?? mocks.providerSignatureFileSystem
  );

  return { SidebarProvider, provider, workspaceState, contextProvider, server };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.configurationValues.clear();
  mocks.vscode.workspace.getConfiguration.mockReset();
  mocks.vscode.workspace.getConfiguration.mockImplementation(() => ({
    get: vi.fn((key: string, fallback?: unknown) =>
      mocks.configurationValues.has(key) ? mocks.configurationValues.get(key) : fallback
    ),
    update: vi.fn((key: string, value: unknown) => {
      if (value === undefined) mocks.configurationValues.delete(key);
      else mocks.configurationValues.set(key, value);
      return Promise.resolve();
    }),
  }));

  mocks.spawn.mockReset();
  mocks.mkdtemp.mockReset();
  mocks.mkdtemp.mockResolvedValue('/tmp/varro-opencode-export-123');
  mocks.open.mockReset();
  mocks.open.mockResolvedValue({ fd: 17, close: vi.fn(() => Promise.resolve()) });
  mocks.readFile.mockReset();
  mocks.providerSignatureFileSystem.readFile.mockReset();
  mocks.providerSignatureFileSystem.stat.mockReset();
  mocks.providerSignatureFileSystem.stat.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' })
  );
  mocks.rm.mockReset();
  mocks.rm.mockResolvedValue(undefined);

  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();

  mocks.vscode.window.showTextDocument.mockReset();
  mocks.vscode.window.showInformationMessage.mockReset();
  mocks.vscode.window.showInformationMessage.mockResolvedValue(undefined);
  mocks.vscode.window.createWebviewPanel.mockReset();
  mocks.vscode.window.showTextDocument.mockResolvedValue(undefined);
  mocks.vscode.window.showWarningMessage.mockReset();
  mocks.vscode.window.showWarningMessage.mockResolvedValue(undefined);
  mocks.vscode.window.showErrorMessage.mockReset();
  mocks.vscode.window.showErrorMessage.mockResolvedValue(undefined);
  mocks.vscode.window.showOpenDialog.mockReset();
  mocks.vscode.window.showOpenDialog.mockResolvedValue(undefined);
  mocks.vscode.commands.executeCommand.mockReset();
  mocks.vscode.commands.executeCommand.mockResolvedValue(undefined);

  mocks.vscode.workspace.asRelativePath.mockReset();
  mocks.vscode.workspace.asRelativePath.mockImplementation((uri: { fsPath: string }) => uri.fsPath);
  mocks.vscode.workspace.textDocuments = [];
  mocks.vscode.workspace.getWorkspaceFolder.mockReset();
  mocks.vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
  mocks.vscode.workspace.fs.readFile.mockReset();
  mocks.vscode.workspace.fs.stat.mockReset();
  mocks.vscode.workspace.fs.writeFile.mockReset();
  mocks.vscode.workspace.fs.stat.mockResolvedValue({ mtime: 1, size: 1, type: 0, ctime: 0 });
  mocks.vscode.workspace.fs.writeFile.mockResolvedValue(undefined);
  mocks.vscode.workspace.openTextDocument.mockReset();
  mocks.vscode.workspace.openTextDocument.mockResolvedValue({});
});
