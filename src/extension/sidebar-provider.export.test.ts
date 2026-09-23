/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- These export tests inspect controlled provider internals and deliberately verify opaque response representations. */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createServer,
  createSidebarProviderInstance,
  getSpawnMock,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();
const spawnMock = getSpawnMock();

function createExportServer() {
  return createServer({
    request: vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/session/session-1') {
        return { id: 'session-1', directory: '/repo' };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
    resolveCommand: vi.fn(() => 'opencode'),
    getWorkspaceCwd: vi.fn(() => '/repo'),
  });
}

function mockExportProcess() {
  const stdout = new PassThrough();
  const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  spawnMock.mockReturnValue({
    stdout,
    stderr: { on: vi.fn() },
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') {
        closeHandlers.push((code, signal) => {
          stdout.end();
          (handler as (code: number | null, signal: NodeJS.Signals | null) => void)(code, signal);
        });
      }
    }),
  });
  return { stdout, closeHandlers };
}

describe('SidebarProvider export flows', () => {
  it('exports a session through the OpenCode CLI and opens the result', async () => {
    const { stdout, closeHandlers } = mockExportProcess();

    const { provider } = await createSidebarProviderInstance({
      server: createExportServer(),
    });

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    stdout.write('{"id":"session-1"}');
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
    const { stdout, closeHandlers } = mockExportProcess();

    const { provider } = await createSidebarProviderInstance({
      server: createExportServer(),
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
    const content = '{"items":[{"id":1}]}';
    stdout.write(content);
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content,
    });
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows an error when export output is invalid JSON', async () => {
    const { stdout, closeHandlers } = mockExportProcess();

    const { provider } = await createSidebarProviderInstance({
      server: createExportServer(),
    });

    const exportPromise = provider.handleMessage({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(closeHandlers).toHaveLength(1);
    });
    stdout.write('{"items":[');
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export session: OpenCode export returned invalid JSON')
    );
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('exports through a temp file to avoid stdout truncation', async () => {
    const { stdout, closeHandlers } = mockExportProcess();

    const { provider } = await createSidebarProviderInstance({
      server: createExportServer(),
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
    expect(options?.stdio?.[1]).toBe('pipe');
    expect(options?.stdio?.[2]).toBe('pipe');
    const content = `{"items":[{"id":1,"text":"${'x'.repeat(70_000)}"}]}`;
    stdout.write(content);
    closeHandlers[0]?.(0, null);
    await exportPromise;

    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith({
      language: 'json',
      content,
    });
  });

  it('times out a hung export process and reports an error', async () => {
    let closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const proc = {
      stdout: new PassThrough(),
      stderr: {
        on: vi.fn(),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandler = handler as (code: number | null, signal: NodeJS.Signals | null) => void;
        }
      }),
      kill: vi.fn((signal: NodeJS.Signals) => {
        queueMicrotask(() => closeHandler?.(null, signal));
        return true;
      }),
      exitCode: null,
      signalCode: null,
    };
    spawnMock.mockReturnValue(proc);

    const { provider } = await createSidebarProviderInstance({
      server: createExportServer(),
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

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to export session: OpenCode CLI export timed out'
      );
    } finally {
      exportService.sessionExportService.exportTimeoutMs = originalTimeout;
    }
  });
});
