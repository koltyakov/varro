import { writeSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createServer,
  createSidebarProviderInstance,
  getSpawnMock,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();
const spawnMock = getSpawnMock();

describe('SidebarProvider export flows', () => {
  it('exports a session through the OpenCode CLI and opens the result', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
      }),
    });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        resolveCommand: vi.fn(() => 'opencode'),
        getWorkspaceCwd: vi.fn(() => '/repo'),
      }),
    });

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    const outputFd = Array.isArray(options?.stdio) ? (options.stdio[1] as number) : undefined;
    expect(typeof outputFd).toBe('number');
    writeSync(outputFd!, '{"id":"session-1"}');
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(spawnMock).toHaveBeenCalled();
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content: '{"id":"session-1"}',
    });
    expect(vscodeMock.window.showTextDocument).toHaveBeenCalled();
  });

  it('waits for close before opening a large export result', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
      }),
    });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        resolveCommand: vi.fn(() => 'opencode'),
        getWorkspaceCwd: vi.fn(() => '/repo'),
      }),
    });

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    const outputFd = Array.isArray(options?.stdio) ? (options.stdio[1] as number) : undefined;
    expect(typeof outputFd).toBe('number');
    const content = '{"items":[{"id":1}]}';
    writeSync(outputFd!, content);
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content,
    });
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows an error when export output is invalid JSON', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
      }),
    });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        resolveCommand: vi.fn(() => 'opencode'),
        getWorkspaceCwd: vi.fn(() => '/repo'),
      }),
    });

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    const outputFd = Array.isArray(options?.stdio) ? (options.stdio[1] as number) : undefined;
    expect(typeof outputFd).toBe('number');
    writeSync(outputFd!, '{"items":[');
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export session: OpenCode export returned invalid JSON')
    );
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('exports through a temp file to avoid stdout truncation', async () => {
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(
            handler as (code: number | null, signal: NodeJS.Signals | null) => void
          );
        }
      }),
    });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        resolveCommand: vi.fn(() => 'opencode'),
        getWorkspaceCwd: vi.fn(() => '/repo'),
      }),
    });

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    const options = spawnMock.mock.calls[0]?.[2] as { stdio?: unknown[] } | undefined;
    expect(Array.isArray(options?.stdio)).toBe(true);
    expect(options?.stdio?.[0]).toBe('ignore');
    expect(typeof options?.stdio?.[1]).toBe('number');
    expect(options?.stdio?.[2]).toBe('pipe');
    const outputFd = options?.stdio?.[1] as number;
    const content = `{"items":[{"id":1,"text":"${'x'.repeat(70_000)}"}]}`;
    writeSync(outputFd, content);
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content,
    });
  });

  it('times out a hung export process and reports an error', async () => {
    const kill = vi.fn();
    spawnMock.mockReturnValue({
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn(),
      kill,
      exitCode: null,
      signalCode: null,
    });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({
        resolveCommand: vi.fn(() => 'opencode'),
        getWorkspaceCwd: vi.fn(() => '/repo'),
      }),
    });

    const exportService = provider as unknown as {
      sessionExportService: { exportTimeoutMs: number };
    };
    const originalTimeout = exportService.sessionExportService.exportTimeoutMs;
    exportService.sessionExportService.exportTimeoutMs = 10;

    try {
      await provider.handleMessage({
        type: 'session/export',
        payload: { sessionId: 'session-1' },
      });

      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to export session: OpenCode CLI export timed out'
      );
    } finally {
      exportService.sessionExportService.exportTimeoutMs = originalTimeout;
    }
  });
});
