/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- These provider tests verify VS Code URI integration with minimal document and content-provider fixtures. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecuteCommandMock = (
  command: string,
  beforeUri: unknown,
  afterUri: unknown,
  title: string,
  options: { preview: boolean }
) => Promise<unknown>;

const vscodeMock = vi.hoisted(() => ({
  provider: undefined as { provideTextDocumentContent(uri: unknown): string } | undefined,
  workspace: {
    registerTextDocumentContentProvider: vi.fn(
      (_scheme: string, provider: { provideTextDocumentContent(uri: unknown): string }) => {
        vscodeMock.provider = provider;
        return { dispose: vi.fn() };
      }
    ),
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    executeCommand: vi.fn<ExecuteCommandMock>(() => Promise.resolve(undefined)),
  },
  Uri: {
    from: vi.fn((value: { scheme: string; path: string }) => ({
      ...value,
      toString: () => `${value.scheme}:${value.path}`,
    })),
  },
}));

vi.mock('vscode', () => vscodeMock);

import { SessionDiffDocumentProvider } from './session-diff-document-provider';

describe('SessionDiffDocumentProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.provider = undefined;
  });

  it('opens exact session snapshots in the native VS Code diff editor', async () => {
    const server = {
      getWorkspaceCwd: () => '/repo',
      request: vi.fn((_method: string, path: string) =>
        Promise.resolve(
          path === '/session/session%2F1'
            ? { id: 'session/1', directory: '/repo' }
            : [
                {
                  file: 'src/app.ts',
                  before: 'const value = 1;\n',
                  after: 'const value = 2;\n',
                  additions: 1,
                  deletions: 1,
                },
              ]
        )
      ),
    };
    const provider = new SessionDiffDocumentProvider(server as never);

    try {
      await expect(provider.open('session/1', '/repo/src/app.ts')).resolves.toBe('opened');
      expect(server.request).toHaveBeenCalledWith('GET', '/session/session%2F1', undefined, {
        directory: '/repo',
      });
      expect(server.request).toHaveBeenCalledWith('GET', '/session/session%2F1/diff');
      expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ scheme: 'varro-session-diff' }),
        expect.objectContaining({ scheme: 'varro-session-diff' }),
        'app.ts (Varro session)',
        { preview: true }
      );
      const [, beforeUri, afterUri] = vscodeMock.commands.executeCommand.mock.calls[0]!;
      expect(vscodeMock.provider?.provideTextDocumentContent(beforeUri)).toBe('const value = 1;\n');
      expect(vscodeMock.provider?.provideTextDocumentContent(afterUri)).toBe('const value = 2;\n');
    } finally {
      provider.dispose();
    }
  });

  it('falls back when OpenCode does not provide both sides', async () => {
    const provider = new SessionDiffDocumentProvider({
      getWorkspaceCwd: () => '/repo',
      request: vi.fn((_method: string, path: string) =>
        Promise.resolve(
          path === '/session/session-1'
            ? { id: 'session-1', directory: '/repo' }
            : [
                {
                  file: 'src/app.ts',
                  after: 'new',
                  additions: 1,
                  deletions: 0,
                },
              ]
        )
      ),
    } as never);

    try {
      await expect(provider.open('session-1', 'src/app.ts')).resolves.toBe('unavailable');
      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it.each([
    ['case-distinct path', '/repo/src/Foo.ts', 'src/foo.ts'],
    ['common suffix', '/repo/src/app.ts', 'archive/src/app.ts'],
    ['outside workspace', '/other/src/app.ts', 'src/app.ts'],
  ])('does not conflate a %s', async (_case, requestedPath, diffPath) => {
    const provider = new SessionDiffDocumentProvider({
      getWorkspaceCwd: () => '/repo',
      request: vi.fn((_method: string, path: string) =>
        Promise.resolve(
          path === '/session/session-1'
            ? { id: 'session-1', directory: '/repo' }
            : [{ file: diffPath, before: 'old', after: 'new', additions: 1, deletions: 1 }]
        )
      ),
    } as never);

    try {
      await expect(provider.open('session-1', requestedPath)).resolves.toBe('unavailable');
      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('matches Windows paths case-insensitively within the workspace', async () => {
    const provider = new SessionDiffDocumentProvider({
      getWorkspaceCwd: () => 'C:\\repo',
      request: vi.fn((_method: string, path: string) =>
        Promise.resolve(
          path === '/session/session-1'
            ? { id: 'session-1', directory: 'C:\\repo' }
            : [{ file: 'SRC\\App.ts', before: 'old', after: 'new', additions: 1, deletions: 1 }]
        )
      ),
    } as never);

    try {
      await expect(provider.open('session-1', 'c:\\REPO\\src\\app.ts')).resolves.toBe('opened');
    } finally {
      provider.dispose();
    }
  });

  it('refuses to open snapshots from a session in another workspace', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/session/session-foreign') {
        return { id: 'session-foreign', directory: '/other-repo' };
      }
      return [
        {
          file: 'src/app.ts',
          before: 'old',
          after: 'new',
          additions: 1,
          deletions: 1,
        },
      ];
    });
    const provider = new SessionDiffDocumentProvider({
      getWorkspaceCwd: () => '/repo',
      request,
    } as never);

    try {
      await expect(provider.open('session-foreign', 'src/app.ts')).resolves.toBe('forbidden');
      expect(request).toHaveBeenCalledWith('GET', '/session/session-foreign', undefined, {
        directory: '/repo',
      });
      expect(request).not.toHaveBeenCalledWith('GET', '/session/session-foreign/diff');
      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('refuses a snapshot when the workspace changes while the diff is loading', async () => {
    let workspacePath = '/repo';
    let resolveDiff: ((value: unknown[]) => void) | undefined;
    const diff = new Promise<unknown[]>((resolve) => {
      resolveDiff = resolve;
    });
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/session/session-1') {
        return { id: 'session-1', directory: '/repo' };
      }
      return await diff;
    });
    const provider = new SessionDiffDocumentProvider({
      getWorkspaceCwd: () => workspacePath,
      request,
    } as never);

    try {
      const opening = provider.open('session-1', 'src/app.ts');
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith('GET', '/session/session-1/diff')
      );
      workspacePath = '/other-repo';
      resolveDiff?.([
        {
          file: 'src/app.ts',
          before: 'old',
          after: 'new',
          additions: 1,
          deletions: 1,
        },
      ]);

      await expect(opening).resolves.toBe('forbidden');
      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('does not fall back after a diff request rejects during a workspace switch', async () => {
    let workspacePath = '/repo';
    let rejectDiff: ((error: Error) => void) | undefined;
    const diff = new Promise<unknown[]>((_resolve, reject) => {
      rejectDiff = reject;
    });
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/session/session-1') {
        return { id: 'session-1', directory: '/repo' };
      }
      return await diff;
    });
    const provider = new SessionDiffDocumentProvider({
      getWorkspaceCwd: () => workspacePath,
      request,
    } as never);

    try {
      const opening = provider.open('session-1', 'src/app.ts');
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith('GET', '/session/session-1/diff')
      );
      workspacePath = '/other-repo';
      rejectDiff?.(new Error('request invalidated'));

      await expect(opening).resolves.toBe('forbidden');
      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });
});
