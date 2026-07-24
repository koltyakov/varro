import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  mkdtemp: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  default: { spawn: mocks.spawn },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  default: { spawn: mocks.spawn },
}));

vi.mock('fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  open: mocks.open,
  readFile: mocks.readFile,
  rm: mocks.rm,
  default: {
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readFile: mocks.readFile,
    rm: mocks.rm,
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  open: mocks.open,
  readFile: mocks.readFile,
  rm: mocks.rm,
  default: {
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readFile: mocks.readFile,
    rm: mocks.rm,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: mocks.openTextDocument,
  },
  window: {
    showTextDocument: mocks.showTextDocument,
    showErrorMessage: mocks.showErrorMessage,
  },
}));

import { SessionExportService } from './session-export-service';

type CloseHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorHandler = (error: Error) => void;

function createServer() {
  return {
    getWorkspaceCwd: vi.fn(() => '/repo'),
    request: vi.fn(async () => [{ id: 'session-1', directory: '/repo' }]),
    resolveCommand: vi.fn(() => 'opencode'),
  };
}

function createSpawnResult() {
  const handlers: {
    close?: CloseHandler;
    error?: ErrorHandler;
    stderr?: (data: Buffer) => void;
  } = {};
  const stderrOn = vi.fn();

  const proc = {
    stderr: {
      on: stderrOn.mockImplementation((event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') {
          handlers.stderr = handler;
        }
      }),
    },
    once: vi.fn((event: string, handler: CloseHandler | ErrorHandler) => {
      if (event === 'close') {
        handlers.close = handler as CloseHandler;
      }
      if (event === 'error') {
        handlers.error = handler as ErrorHandler;
      }
    }),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  };
  mocks.spawn.mockReturnValue(proc);

  return {
    handlers: handlers as {
      close: CloseHandler;
      error: ErrorHandler;
      stderr?: (data: Buffer) => void;
    },
    proc,
  };
}

describe('SessionExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdtemp.mockResolvedValue('/tmp/varro-opencode-export-123');
    mocks.open.mockResolvedValue({ fd: 17, close: vi.fn().mockResolvedValue(undefined) });
    mocks.readFile.mockResolvedValue('{"id":"session-1"}\n');
    mocks.rm.mockResolvedValue(undefined);
    mocks.openTextDocument.mockResolvedValue({ uri: 'untitled:session-export.json' });
    mocks.showTextDocument.mockResolvedValue(undefined);
    mocks.showErrorMessage.mockResolvedValue(undefined);
  });

  it('opens valid exported JSON and removes the temp directory', async () => {
    const spawnResult = createSpawnResult();
    const server = createServer();
    const service = new SessionExportService(server, 1000);

    const exportPromise = service.exportSession('session-1');

    const tempFilePath = join('/tmp/varro-opencode-export-123', 'session-export.json');
    await vi.waitFor(() => {
      expect(mocks.open).toHaveBeenCalledWith(tempFilePath, 'w');
    });
    spawnResult.handlers.close(0, null);
    await exportPromise;

    expect(mocks.spawn).toHaveBeenCalledWith(
      'opencode',
      ['export', 'session-1'],
      expect.objectContaining({
        stdio: ['ignore', 17, 'pipe'],
        cwd: '/repo',
        windowsHide: true,
      })
    );
    expect(mocks.readFile).toHaveBeenCalledWith(tempFilePath, 'utf-8');
    expect(mocks.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content: '{"id":"session-1"}',
    });
    expect(mocks.showTextDocument).toHaveBeenCalledWith(
      { uri: 'untitled:session-export.json' },
      { preview: false }
    );
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/varro-opencode-export-123', {
      recursive: true,
      force: true,
    });
  });

  it('reports invalid JSON and still removes the temp directory', async () => {
    const spawnResult = createSpawnResult();
    const service = new SessionExportService(createServer(), 1000);
    mocks.readFile.mockResolvedValue('{"items":[');

    const exportPromise = service.exportSession('session-1');
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    spawnResult.handlers.close(0, null);

    await expect(exportPromise).rejects.toThrow('OpenCode export returned invalid JSON');
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export session: OpenCode export returned invalid JSON')
    );
    expect(mocks.openTextDocument).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/varro-opencode-export-123', {
      recursive: true,
      force: true,
    });
  });

  it('surfaces CLI stderr failures and still removes the temp directory', async () => {
    const spawnResult = createSpawnResult();
    const service = new SessionExportService(createServer(), 1000);

    const exportPromise = service.exportSession('session-1');
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    spawnResult.handlers.stderr?.(Buffer.from('permission denied\n'));
    spawnResult.handlers.close(1, null);

    await expect(exportPromise).rejects.toThrow('permission denied');
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      'Failed to export session: permission denied'
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/varro-opencode-export-123', {
      recursive: true,
      force: true,
    });
  });

  it('rejects a session from another workspace before spawning the CLI', async () => {
    const server = createServer();
    server.request.mockResolvedValue([{ id: 'session-1', directory: '/other' }]);
    const service = new SessionExportService(server, 1000);

    await expect(service.exportSession('session-1')).rejects.toThrow(
      'Session does not belong to the current workspace'
    );

    expect(server.request).toHaveBeenCalledWith('GET', '/session');
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      'Failed to export session: Session does not belong to the current workspace'
    );
  });

  it('exports without workspace isolation in a folderless window', async () => {
    const spawnResult = createSpawnResult();
    const server = {
      ...createServer(),
      getWorkspaceCwd: vi.fn(() => undefined),
    };
    const service = new SessionExportService(server, 1000);

    const exportPromise = service.exportSession('session-1');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    spawnResult.handlers.close(0, null);
    await exportPromise;

    expect(server.request).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      'opencode',
      ['export', 'session-1'],
      expect.objectContaining({ cwd: undefined })
    );
  });

  it('settles and cleans up after bounded escalation when close never arrives', async () => {
    vi.useFakeTimers();
    try {
      const spawnResult = createSpawnResult();
      const service = new SessionExportService(createServer(), 1000);
      const exportPromise = service.exportSession('session-1');
      const rejection = expect(exportPromise).rejects.toThrow('OpenCode CLI export timed out');

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.spawn).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnResult.proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mocks.rm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnResult.proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mocks.rm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(mocks.rm).toHaveBeenCalledWith('/tmp/varro-opencode-export-123', {
        recursive: true,
        force: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-terminates descendants before cleanup when the wrapper closes on timeout', async () => {
    vi.useFakeTimers();
    try {
      const spawnResult = createSpawnResult();
      const service = new SessionExportService(createServer(), 1000);
      const exportPromise = service.exportSession('session-1');
      const rejection = expect(exportPromise).rejects.toThrow('OpenCode CLI export timed out');

      await vi.advanceTimersByTimeAsync(1_000);
      spawnResult.handlers.close(null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(0);

      expect(spawnResult.proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mocks.rm).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(mocks.rm).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('signals the POSIX process group so wrapper descendants are terminated', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const spawnResult = createSpawnResult();
      Object.assign(spawnResult.proc, { pid: 4_242 });
      const service = new SessionExportService(createServer(), 1000);
      const exportPromise = service.exportSession('session-1');
      const rejection = expect(exportPromise).rejects.toThrow('OpenCode CLI export timed out');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(processKill).toHaveBeenCalledWith(-4_242, 'SIGTERM');
      expect(mocks.spawn).toHaveBeenCalledWith(
        'opencode',
        ['export', 'session-1'],
        expect.objectContaining({ detached: true })
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(processKill).toHaveBeenCalledWith(-4_242, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });
});
