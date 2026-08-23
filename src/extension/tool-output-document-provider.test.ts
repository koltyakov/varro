/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These provider tests verify VS Code URI integration with partial document and event fixtures. */
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
    openTextDocument: vi.fn((uri: unknown) => Promise.resolve({ uri })),
  },
  window: {
    showTextDocument: vi.fn(() => Promise.resolve(undefined)),
  },
  languages: {
    setTextDocumentLanguage: vi.fn(() => Promise.resolve(undefined)),
  },
  Uri: {
    from: vi.fn((value: { scheme: string; path: string }) => ({
      ...value,
      toString: () => `${value.scheme}:${value.path}`,
    })),
  },
}));

vi.mock('vscode', () => vscodeMock);

import { ToolOutputDocumentProvider } from './tool-output-document-provider';

describe('ToolOutputDocumentProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.provider = undefined;
  });

  it('serves the opened text back through the virtual scheme', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await expect(
        provider.open({ content: 'line one\nline two\n', title: 'rtk git status (output)' })
      ).resolves.toEqual(expect.anything());

      const uri = vscodeMock.Uri.from.mock.results[0]?.value as { toString(): string };
      expect(vscodeMock.provider?.provideTextDocumentContent(uri)).toBe('line one\nline two\n');
      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), {
        preview: true,
      });
    } finally {
      provider.dispose();
    }
  });

  it('names the tab after the tool call so the editor label is meaningful', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await provider.open({ content: 'x', title: 'Audit data performance (prompt)' });

      // Markdown is the default: tool prompts and results are written as
      // Markdown, and a .md tab renders and highlights them correctly.
      expect(vscodeMock.Uri.from).toHaveBeenCalledWith(
        expect.objectContaining({
          scheme: 'varro-tool-output',
          path: expect.stringContaining('Audit data performance (prompt).md'),
        })
      );
      expect(vscodeMock.languages.setTextDocumentLanguage).toHaveBeenCalledWith(
        expect.anything(),
        'markdown'
      );
    } finally {
      provider.dispose();
    }
  });

  it('strips path separators from the title so they cannot split the URI path', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await provider.open({ content: 'x', title: 'read ../../etc/passwd' });

      const path = vscodeMock.Uri.from.mock.calls[0]?.[0]?.path ?? '';
      expect(path.split('/')).toHaveLength(3);
      expect(path).toContain('read .. .. etc passwd.md');
    } finally {
      provider.dispose();
    }
  });

  it('applies the language hint and extension when one is given', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await provider.open({ content: '{}', title: 'search (results)', language: 'json' });

      expect(vscodeMock.Uri.from).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining('search (results).json') })
      );
      expect(vscodeMock.languages.setTextDocumentLanguage).toHaveBeenCalledWith(
        expect.anything(),
        'json'
      );
    } finally {
      provider.dispose();
    }
  });

  it('can keep a named document out of preview mode', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await provider.open({ content: 'x', title: 'OpenCode Usage Report', preview: false });

      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), {
        preview: false,
      });
      expect(vscodeMock.Uri.from).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining('OpenCode Usage Report.md') })
      );
    } finally {
      provider.dispose();
    }
  });

  it('can register a named document without showing its source editor', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await provider.open({ content: 'x', title: 'OpenCode Usage Report', show: false });

      expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledOnce();
      expect(vscodeMock.window.showTextDocument).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it('opens markup in an XML editor tab', async () => {
    const provider = new ToolOutputDocumentProvider();

    try {
      await provider.open({ content: '<svg />', title: 'SVG user message', language: 'xml' });

      expect(vscodeMock.Uri.from).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining('SVG user message.xml') })
      );
      expect(vscodeMock.languages.setTextDocumentLanguage).toHaveBeenCalledWith(
        expect.anything(),
        'xml'
      );
      const uri = vscodeMock.Uri.from.mock.results[0]?.value as { toString(): string };
      expect(vscodeMock.provider?.provideTextDocumentContent(uri)).toBe('<svg />');
    } finally {
      provider.dispose();
    }
  });

  it('drops the buffer when opening fails so nothing leaks', async () => {
    vscodeMock.workspace.openTextDocument.mockRejectedValueOnce(new Error('nope'));
    const provider = new ToolOutputDocumentProvider();

    try {
      await expect(provider.open({ content: 'x', title: 'tool' })).resolves.toBeUndefined();

      const uri = vscodeMock.Uri.from.mock.results[0]?.value as { toString(): string };
      expect(vscodeMock.provider?.provideTextDocumentContent(uri)).toBe('');
    } finally {
      provider.dispose();
    }
  });

  it('refuses to open after disposal', async () => {
    const provider = new ToolOutputDocumentProvider();
    provider.dispose();

    await expect(provider.open({ content: 'x', title: 'tool' })).resolves.toBeUndefined();
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});
