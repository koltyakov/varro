import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();

describe('RestProxy workspace file picker', () => {
  it('returns the selected plan path without starting the server', async () => {
    vscodeMock.window.showOpenDialog.mockResolvedValue([
      { fsPath: '/repo/docs/RALPH.md' },
    ] as never);
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ name: 'repo' } as never);
    vscodeMock.workspace.asRelativePath.mockReturnValue('docs/RALPH.md');

    const server = createServer({
      status: { state: 'error', message: 'offline' },
      start: vi.fn(() => Promise.reject(new Error('should not start'))),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 11, method: 'GET', path: '/varro/workspace-file/pick' },
    });

    expect(server.start).not.toHaveBeenCalled();
    expect(vscodeMock.window.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        title: 'Select Ralph plan document',
      })
    );
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 11, data: 'docs/RALPH.md' },
    });
  });
});
