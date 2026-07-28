import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    executeCommand: vi.fn(() => Promise.resolve(undefined)),
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
      request: vi.fn(() =>
        Promise.resolve([
          {
            file: 'src/app.ts',
            before: 'const value = 1;\n',
            after: 'const value = 2;\n',
            additions: 1,
            deletions: 1,
          },
        ])
      ),
    };
    const provider = new SessionDiffDocumentProvider(server as never);

    try {
      await expect(provider.open('session/1', '/repo/src/app.ts')).resolves.toBe(true);
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
      request: vi.fn(() =>
        Promise.resolve([{ file: 'src/app.ts', after: 'new', additions: 1, deletions: 0 }])
      ),
    } as never);

    try {
      await expect(provider.open('session-1', 'src/app.ts')).resolves.toBe(false);
      expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });
});
