/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- These tests verify router dispatch across its imported command handlers and inspect registered callbacks. */
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
    updateCommandState: vi.fn(),
    setWebviewFocus: vi.fn(),
    revealPermission: vi.fn(),
    migrateSessionModels: vi.fn(() => Promise.resolve()),
    setProviderWatchActive: vi.fn(),
    requestContext: vi.fn(),
    selectWorkspace: vi.fn(() => Promise.resolve()),
    refreshProviders: vi.fn(() => Promise.resolve()),
    providerReauthenticated: vi.fn(() => Promise.resolve()),
    clearTerminalSelection: vi.fn(),
    runInTerminal: vi.fn(),
    openSessionInOpenCode: vi.fn(),
    openSessionInEditor: vi.fn(),
    openNewEditor: vi.fn(),
    editorRouteChanged: vi.fn(),
    exportSession: vi.fn(() => Promise.resolve()),
    generateUsageReport: vi.fn(() => Promise.resolve()),
    reloadWebview: vi.fn(() => Promise.resolve()),
    openFolder: vi.fn(() => Promise.resolve()),
    openSettings: vi.fn(() => Promise.resolve()),
    showOutput: vi.fn(),
    setMermaidPreviewOpen: vi.fn(),
    restartServer: vi.fn(() => Promise.resolve()),
    checkServerRestart: vi.fn(() => Promise.resolve()),
    handleDroppedPaths: vi.fn(() => Promise.resolve()),
    handleDroppedContent: vi.fn(() => Promise.resolve()),
    storePdf: vi.fn(() => Promise.resolve()),
    storeImage: vi.fn(() => Promise.resolve()),
    releaseImages: vi.fn(() => Promise.resolve()),
    removeContextFile: vi.fn(),
    clearContextFiles: vi.fn(),
    notifyContextFilesChanged: vi.fn(),
    pickFiles: vi.fn(() => Promise.resolve()),
    searchFiles: vi.fn(),
    readContextFile: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve()),
    openText: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
    updateConfig: vi.fn(() => Promise.resolve()),
    handleApiRequest: vi.fn(() => Promise.resolve()),
    cancelApiRequest: vi.fn(),
    handleRalphMessage: vi.fn(),
    updateQueuedMessages: vi.fn(() => Promise.resolve()),
    updatePermissionMode: vi.fn(() => Promise.resolve()),
    updateSessionModel: vi.fn(() => Promise.resolve()),
    updateDraftImages: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
  };
}

describe('MessageRouter', () => {
  it('persists a session permission mode update', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);

    await router.handleMessage({
      type: 'permission-mode/update',
      payload: { sessionId: 'session-1', mode: 'full' },
    });

    expect(cb.updatePermissionMode).toHaveBeenCalledWith({ sessionId: 'session-1', mode: 'full' });
  });

  it('persists composer image snapshots', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const images = [
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'image.png',
        size: 1,
      },
    ];

    await router.handleMessage({ type: 'composer/images-update', payload: { images } });

    expect(cb.updateDraftImages).toHaveBeenCalledWith({ images });
  });

  it('dispatches Mermaid preview layout state', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);

    await router.handleMessage({ type: 'vscode/mermaid-preview', payload: { open: true } });

    expect(cb.setMermaidPreviewOpen).toHaveBeenCalledWith(true);
  });

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

  it('dispatches permission reveal', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({
      type: 'permission/reveal',
      payload: { permissionId: 'perm-1' },
    });
    expect(cb.revealPermission).toHaveBeenCalledWith('perm-1');
  });

  it('dispatches command state with the active chat model', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const model = { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' };

    await router.handleMessage({
      type: 'commands/state',
      payload: { canAbort: true, canSwitchSessions: false, model },
    });

    expect(cb.updateCommandState).toHaveBeenCalledWith(true, false, model);
  });

  it('dispatches providers/watch', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'providers/watch', payload: { active: true } });
    expect(cb.setProviderWatchActive).toHaveBeenCalledWith(true);
  });

  it('dispatches vscode/show-output', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'vscode/show-output' });
    expect(cb.showOutput).toHaveBeenCalledOnce();
  });

  it('dispatches regular, forced, and status-check restart messages', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);

    await router.handleMessage({ type: 'server/restart' });
    await router.handleMessage({ type: 'server/restart', payload: { force: true } });
    await router.handleMessage({ type: 'server/restart/check', payload: { checkId: 7 } });

    expect(cb.restartServer).toHaveBeenNthCalledWith(1, false);
    expect(cb.restartServer).toHaveBeenNthCalledWith(2, true);
    expect(cb.checkServerRestart).toHaveBeenCalledWith(7);
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

  it('dispatches providers/reauthenticated', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({ type: 'providers/reauthenticated' });
    expect(cb.providerReauthenticated).toHaveBeenCalledOnce();
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

  it('dispatches usage/report', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);

    await router.handleMessage({ type: 'usage/report', payload: { includeAllTime: true } });

    expect(cb.generateUsageReport).toHaveBeenCalledWith(true);
  });

  it('dispatches vscode/open-folder', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);

    await router.handleMessage({ type: 'vscode/open-folder' });

    expect(cb.openFolder).toHaveBeenCalledOnce();
  });

  it('dispatches webview/reload', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);

    await router.handleMessage({ type: 'webview/reload' });

    expect(cb.reloadWebview).toHaveBeenCalledOnce();
  });

  it('dispatches session/open-in-opencode', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    await router.handleMessage({
      type: 'session/open-in-opencode',
      payload: { sessionId: 'session-1' },
    });
    expect(cb.openSessionInOpenCode).toHaveBeenCalledWith('session-1');
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
    const payload = { path: '/a.ts', line: 10, kind: 'file' as const, view: 'diff' as const };
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

  it('dispatches api/cancel', async () => {
    const cb = createCallbacks();
    const router = new MessageRouter(cb);
    const payload = { id: 42, cancelKey: 'request-token' };
    await router.handleMessage({ type: 'api/cancel', payload });
    expect(cb.cancelApiRequest).toHaveBeenCalledWith(payload);
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
