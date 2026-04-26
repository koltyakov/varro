import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  workspace: {
    asRelativePath: vi.fn(),
    workspaceFolders: undefined as Array<{ name: string }> | undefined,
  },
}));

vi.mock('vscode', () => vscodeMock);

import {
  getRelativePath,
  normalizeRelativeWorkspacePath,
  resolveWorkspaceRelativePath,
} from './path';

describe('path helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.workspace.workspaceFolders = undefined;
    vscodeMock.workspace.asRelativePath.mockReset();
  });

  it('uses the basename when no workspace folder is available', () => {
    expect(getRelativePath({ fsPath: '/tmp/notes/todo.md' } as never, undefined)).toBe('todo.md');
  });

  it('returns the workspace root marker and prefixes multi-root paths', () => {
    const pkgA = { name: 'pkg-a' };
    const pkgB = { name: 'pkg-b' };
    vscodeMock.workspace.workspaceFolders = [pkgA, pkgB];
    vscodeMock.workspace.asRelativePath.mockReturnValueOnce('').mockReturnValueOnce('src/app.ts');

    expect(getRelativePath({ fsPath: '/repo/pkg-a' } as never, pkgA as never)).toBe('.');
    expect(getRelativePath({ fsPath: '/repo/pkg-b/src/app.ts' } as never, pkgB as never)).toBe(
      'pkg-b/src/app.ts'
    );
  });

  it('normalizes slashes, leading dot segments, and trailing separators', () => {
    expect(normalizeRelativeWorkspacePath('.\\docs\\guide///')).toBe('docs/guide');
  });

  it('resolves empty, unscoped, and scoped workspace-relative paths', () => {
    const folders = [{ name: 'alpha' }, { name: 'beta' }];

    expect(resolveWorkspaceRelativePath('./', folders as never)).toBeNull();
    expect(resolveWorkspaceRelativePath('.\\docs\\guide.md/', folders as never)).toEqual({
      workspaceFolder: undefined,
      relativePath: 'docs/guide.md',
    });
    expect(resolveWorkspaceRelativePath('beta', folders as never)).toEqual({
      workspaceFolder: folders[1],
      relativePath: '.',
    });
    expect(resolveWorkspaceRelativePath('alpha/src/index.ts', folders as never)).toEqual({
      workspaceFolder: folders[0],
      relativePath: 'src/index.ts',
    });
  });
});
