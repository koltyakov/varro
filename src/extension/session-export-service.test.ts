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

  mocks.spawn.mockReturnValue({
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
  });

  return {
    handlers: handlers as {
      close: CloseHandler;
      error: ErrorHandler;
      stderr?: (data: Buffer) => void;
    },
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
});
