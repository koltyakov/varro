import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  window: {
    showOpenDialog: vi.fn(),
  },
  workspace: {
    fs: {
      stat: vi.fn(),
    },
    getWorkspaceFolder: vi.fn(),
  },
  FileType: {
    Directory: 2,
  },
}));

vi.mock('vscode', () => vscodeMock);

import type { DroppedFile, ExtensionMessage } from '../shared/protocol';
import { SidebarProviderContextFiles } from './sidebar-provider-context-files';

type DroppedFilesServiceLike = {
  fromContent: ReturnType<typeof vi.fn>;
  fromPaths: ReturnType<typeof vi.fn>;
  removeOwnedFile: ReturnType<typeof vi.fn>;
  removeOwnedFiles: ReturnType<typeof vi.fn>;
};

type PostDroppedFileInput = Parameters<SidebarProviderContextFiles['postDroppedFiles']>[0][number];

function createService() {
  const droppedFilesService: DroppedFilesServiceLike = {
    fromContent: vi.fn(),
    fromPaths: vi.fn(),
    removeOwnedFile: vi.fn(),
    removeOwnedFiles: vi.fn(),
  };
  const service = new SidebarProviderContextFiles(droppedFilesService as never);
  const onContextFilesChanged = vi.fn();
  const post = vi.fn<(message: ExtensionMessage) => void>();

  service.setOnContextFilesChanged(onContextFilesChanged);

  return {
    service,
    droppedFilesService,
    onContextFilesChanged,
    post,
  };
}

function asPostDroppedFilesInput(files: DroppedFile[]): PostDroppedFileInput[] {
  return files as unknown as PostDroppedFileInput[];
}

describe('SidebarProviderContextFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts dropped content returned by the dropped file service', async () => {
    const { service, droppedFilesService, onContextFilesChanged, post } = createService();
    const droppedFiles: DroppedFile[] = [
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
    ];
    droppedFilesService.fromContent.mockResolvedValue(droppedFiles);

    await service.handleDroppedContent([{ name: 'a.ts', content: 'QQ==', size: 1 }], post);

    expect(droppedFilesService.fromContent).toHaveBeenCalledWith([
      { name: 'a.ts', content: 'QQ==', size: 1 },
    ]);
    expect(post).toHaveBeenCalledWith({ type: 'files/dropped', payload: droppedFiles });
    expect(service.getContextFiles()).toEqual(droppedFiles);
    expect(onContextFilesChanged).toHaveBeenCalledOnce();
  });

  it('posts dropped paths returned by the dropped file service', async () => {
    const { service, droppedFilesService, onContextFilesChanged, post } = createService();
    const droppedFiles: DroppedFile[] = [
      { path: '/repo/dir', relativePath: 'dir', type: 'directory' },
    ];
    droppedFilesService.fromPaths.mockResolvedValue(droppedFiles);

    await service.handleDroppedPaths(['/repo/dir'], post);

    expect(droppedFilesService.fromPaths).toHaveBeenCalledWith(['/repo/dir']);
    expect(post).toHaveBeenCalledWith({ type: 'files/dropped', payload: droppedFiles });
    expect(service.getContextFiles()).toEqual(droppedFiles);
    expect(onContextFilesChanged).toHaveBeenCalledOnce();
  });

  it('merges line ranges for an existing file and posts only the merged update', () => {
    const { service, onContextFilesChanged, post } = createService();

    service.postDroppedFiles(
      asPostDroppedFilesInput([
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 1, endLine: 2 }],
        },
      ]),
      post
    );

    post.mockClear();
    onContextFilesChanged.mockClear();

    service.postDroppedFiles(
      asPostDroppedFilesInput([
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [
            { startLine: 4, endLine: 5 },
            { startLine: 2, endLine: 4 },
          ],
        },
      ]),
      post
    );

    expect(service.getContextFiles()).toEqual([
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 1, endLine: 5 }],
      },
    ]);
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: 'files/dropped',
      payload: [
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 1, endLine: 5 }],
        },
      ],
    });
    expect(onContextFilesChanged).toHaveBeenCalledOnce();
  });

  it('skips posting when an incoming file is unchanged after normalization', () => {
    const { service, onContextFilesChanged, post } = createService();

    service.postDroppedFiles(
      asPostDroppedFilesInput([
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [{ startLine: 1, endLine: 3 }],
        },
      ]),
      post
    );

    post.mockClear();
    onContextFilesChanged.mockClear();

    service.postDroppedFiles(
      asPostDroppedFilesInput([
        {
          path: '/repo/a.ts',
          relativePath: 'a.ts',
          type: 'file',
          lineRanges: [
            { startLine: 1, endLine: 2 },
            { startLine: 3, endLine: 3 },
          ],
        },
      ]),
      post
    );

    expect(post).not.toHaveBeenCalled();
    expect(onContextFilesChanged).not.toHaveBeenCalled();
    expect(service.getContextFiles()).toEqual([
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 1, endLine: 3 }],
      },
    ]);
  });

  it('removes a context file and posts the removal event', () => {
    const { service, droppedFilesService, onContextFilesChanged, post } = createService();

    service.postDroppedFiles([{ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' }], post);

    post.mockClear();
    onContextFilesChanged.mockClear();

    service.removeContextFile('/repo/a.ts', post);

    expect(service.getContextFiles()).toEqual([]);
    expect(droppedFilesService.removeOwnedFile).toHaveBeenCalledWith('/repo/a.ts');
    expect(post).toHaveBeenCalledWith({ type: 'files/removed', payload: { path: '/repo/a.ts' } });
    expect(onContextFilesChanged).toHaveBeenCalledOnce();
  });

  it('cleans up owned content files when context is cleared', () => {
    const { service, droppedFilesService, post } = createService();
    service.postDroppedFiles(
      [
        { path: '/tmp/drop-a.ts', relativePath: 'a.ts', type: 'file' },
        { path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' },
      ],
      post
    );

    service.clearContextFiles();

    expect(service.getContextFiles()).toEqual([]);
    expect(droppedFilesService.removeOwnedFiles).toHaveBeenCalledWith([
      '/tmp/drop-a.ts',
      '/repo/b.ts',
    ]);
  });
});
