import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })) },
}));
vi.mock('./logger', () => ({ logger: mocks.logger }));

import type { MessageRouterCallbacks } from './message-router';
import { MessageRouter } from './message-router';

function createCallbacks(): MessageRouterCallbacks {
  return {
    ready: vi.fn(() => Promise.resolve()),
    setWebviewFocus: vi.fn(),
    setProviderWatchActive: vi.fn(),
    requestContext: vi.fn(),
    refreshProviders: vi.fn(),
    clearTerminalSelection: vi.fn(),
    runInTerminal: vi.fn(),
    exportSession: vi.fn(() => Promise.resolve()),
    openSettings: vi.fn(() => Promise.resolve()),
    handleDroppedPaths: vi.fn(() => Promise.resolve()),
    handleDroppedContent: vi.fn(() => Promise.resolve()),
    removeContextFile: vi.fn(),
    clearContextFiles: vi.fn(),
    notifyContextFilesChanged: vi.fn(),
    pickFiles: vi.fn(() => Promise.resolve()),
    searchFiles: vi.fn(),
    readContextFile: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
    updateConfig: vi.fn(() => Promise.resolve()),
    handleApiRequest: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
  };
}

describe('MessageRouter', () => {
  it('dispatches ready', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'ready' });
    expect(cb.ready).toHaveBeenCalledOnce();
  });

  it('dispatches webview/focus', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'webview/focus', payload: { focused: true } });
    expect(cb.setWebviewFocus).toHaveBeenCalledWith(true);
  });

  it('dispatches providers/watch', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'providers/watch', payload: { active: true } });
    expect(cb.setProviderWatchActive).toHaveBeenCalledWith(true);
  });

  it('dispatches context/request', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'context/request' });
    expect(cb.requestContext).toHaveBeenCalledOnce();
  });

  it('dispatches providers/refresh', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'providers/refresh' });
    expect(cb.refreshProviders).toHaveBeenCalledOnce();
  });

  it('dispatches terminal-selection/clear', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'terminal-selection/clear' });
    expect(cb.clearTerminalSelection).toHaveBeenCalledOnce();
  });

  it('dispatches terminal/run with title', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({
      type: 'terminal/run',
      payload: { command: 'npm test', title: 'Test' },
    });
    expect(cb.runInTerminal).toHaveBeenCalledWith('npm test', 'Test');
  });

  it('dispatches terminal/run without title', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'terminal/run', payload: { command: 'npm test' } });
    expect(cb.runInTerminal).toHaveBeenCalledWith('npm test', undefined);
  });

  it('dispatches session/export', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'session/export', payload: { sessionId: 's1' } });
    expect(cb.exportSession).toHaveBeenCalledWith('s1');
  });

  it('dispatches vscode/open-settings with query', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'vscode/open-settings', payload: { query: 'varro' } });
    expect(cb.openSettings).toHaveBeenCalledWith('varro');
  });

  it('dispatches vscode/open-settings without query', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'vscode/open-settings', payload: {} });
    expect(cb.openSettings).toHaveBeenCalledWith(undefined);
  });

  it('dispatches files/drop', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'files/drop', payload: { paths: ['/a.ts', '/b.ts'] } });
    expect(cb.handleDroppedPaths).toHaveBeenCalledWith(['/a.ts', '/b.ts']);
  });

  it('dispatches files/drop-content', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const files = [{ name: 'a.ts', content: 'hi', size: 2 }];
    await router.handleMessage({ type: 'files/drop-content', payload: { files } });
    expect(cb.handleDroppedContent).toHaveBeenCalledWith(files);
  });

  it('dispatches files/remove', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'files/remove', payload: { path: '/x.ts' } });
    expect(cb.removeContextFile).toHaveBeenCalledWith('/x.ts');
  });

  it('dispatches files/clear and notifies', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'files/clear' });
    expect(cb.clearContextFiles).toHaveBeenCalledOnce();
    expect(cb.notifyContextFilesChanged).toHaveBeenCalledOnce();
  });

  it('dispatches files/pick', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'files/pick' });
    expect(cb.pickFiles).toHaveBeenCalledOnce();
  });

  it('dispatches files/search with optional limit', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({
      type: 'files/search',
      payload: { requestId: 1, query: 'foo', limit: 5 },
    });
    expect(cb.searchFiles).toHaveBeenCalledWith(1, 'foo', 5);
  });

  it('dispatches files/search without limit', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'files/search', payload: { requestId: 2, query: 'bar' } });
    expect(cb.searchFiles).toHaveBeenCalledWith(2, 'bar', undefined);
  });

  it('dispatches file/read', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'file/read', payload: { path: '/a.ts' } });
    expect(cb.readContextFile).toHaveBeenCalledWith('/a.ts');
  });

  it('dispatches vscode/open', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const payload = { path: '/a.ts', line: 10, kind: 'file' as const };
    await router.handleMessage({ type: 'vscode/open', payload });
    expect(cb.openPath).toHaveBeenCalledWith(payload);
  });

  it('dispatches vscode/open-external', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({
      type: 'vscode/open-external',
      payload: { url: 'https://example.com' },
    });
    expect(cb.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('dispatches config/update', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const payload = {
      expandThinkingByDefault: true,
      showStickyUserPrompt: false,
      desktopSessionPaneSide: 'right' as const,
      defaultPermissionMode: 'full' as const,
    };
    await router.handleMessage({ type: 'config/update', payload });
    expect(cb.updateConfig).toHaveBeenCalledWith(payload);
  });

  it('dispatches api/request', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const payload = { id: 42, method: 'GET', path: '/sessions' };
    await router.handleMessage({ type: 'api/request', payload });
    expect(cb.handleApiRequest).toHaveBeenCalledWith(payload);
  });

  it('dispatches log', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const payload = { msg: 'hello', level: 'info' as const };
    await router.handleMessage({ type: 'log', payload });
    expect(cb.log).toHaveBeenCalledWith(payload);
  });

  it('logs error when callback throws', async () => {
    const cb = createCallbacks();
    (cb.ready as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'ready' });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('handleMessage(ready) failed: boom')
    );
  });
});
