import { beforeEach, vi } from 'vitest';
import type * as FsPromises from 'fs/promises';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  spawn: vi.fn(),
  mkdtemp: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  vscode: {
    window: {
      createStatusBarItem: vi.fn(() => ({
        name: '',
        command: '',
        text: '',
        tooltip: '',
        backgroundColor: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      })),
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
      activeColorTheme: { kind: 2 },
      showTextDocument: vi.fn(() => Promise.resolve()),
      showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    },
    workspace: {
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, fallback?: unknown) => fallback),
        update: vi.fn(() => Promise.resolve()),
      })),
      fs: {
        readFile: vi.fn(),
        writeFile: vi.fn(() => Promise.resolve()),
      },
      openTextDocument: vi.fn(() => Promise.resolve({})),
    },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: vi.fn((value: string) => ({ value })),
    ColorThemeKind: {
      Light: 1,
      Dark: 2,
      HighContrast: 3,
      HighContrastLight: 4,
    },
    Uri: {
      joinPath: vi.fn(() => ({ toString: () => 'vscode-resource://icon.png' })),
      file: vi.fn((fsPath: string) => ({ fsPath, toString: () => fsPath })),
    },
  },
}));

export function getLoggerMock() {
  return mocks.logger;
}

export function getSpawnMock() {
  return mocks.spawn;
}

export function getMkdtempMock() {
  return mocks.mkdtemp;
}

export function getOpenMock() {
  return mocks.open;
}

export function getReadFileMock() {
  return mocks.readFile;
}

export function getRmMock() {
  return mocks.rm;
}

export function getVscodeMock() {
  return mocks.vscode;
}

vi.mock('vscode', () => mocks.vscode);
vi.mock('child_process', () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }));
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
    update: vi.fn(() => Promise.resolve()),
  };
}

export function createContextProvider() {
  return {
    context: {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    },
    terminalSelection: null,
  };
}

export function createServer(
  overrides: Partial<{
    status: { state: string; url?: string; message?: string };
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    getWorkspaceCwd: ReturnType<typeof vi.fn>;
    resolveCommand: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    status: { state: 'running', url: 'http://127.0.0.1:4096' },
    on: vi.fn(),
    off: vi.fn(),
    start: vi.fn(() => Promise.resolve('http://127.0.0.1:4096')),
    request: vi.fn(),
    getWorkspaceCwd: vi.fn(() => '/repo'),
    resolveCommand: vi.fn(() => 'opencode'),
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
    server as never
  );

  return { SidebarProvider, provider, workspaceState, contextProvider, server };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  mocks.spawn.mockReset();
  mocks.mkdtemp.mockReset();
  mocks.mkdtemp.mockResolvedValue('/tmp/varro-opencode-export-123');
  mocks.open.mockReset();
  mocks.open.mockResolvedValue({ fd: 17, close: vi.fn(() => Promise.resolve()) });
  mocks.readFile.mockReset();
  mocks.rm.mockReset();
  mocks.rm.mockResolvedValue(undefined);

  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();

  mocks.vscode.window.showTextDocument.mockReset();
  mocks.vscode.window.showTextDocument.mockResolvedValue(undefined);
  mocks.vscode.window.showErrorMessage.mockReset();
  mocks.vscode.window.showErrorMessage.mockResolvedValue(undefined);

  mocks.vscode.workspace.fs.readFile.mockReset();
  mocks.vscode.workspace.fs.writeFile.mockReset();
  mocks.vscode.workspace.fs.writeFile.mockResolvedValue(undefined);
  mocks.vscode.workspace.openTextDocument.mockReset();
  mocks.vscode.workspace.openTextDocument.mockResolvedValue({});
});
