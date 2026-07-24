import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/client', () => ({
  client: { varro: { resolveWorkspacePath: vi.fn() } },
}));

import { client } from '../../lib/client';
import {
  getPastedContextFiles,
  getPromptTextWithoutContextReferences,
  resolvePastedMentionContextFiles,
} from './pasted-context';

const resolveWorkspacePath = vi.mocked(client.varro.resolveWorkspacePath);

beforeEach(() => {
  resolveWorkspacePath.mockReset();
});

describe('getPromptTextWithoutContextReferences', () => {
  it('drops a line that is only a file mention', () => {
    expect(getPromptTextWithoutContextReferences('@src/foo.ts')).toBe('');
  });

  it('drops a mention-only line regardless of how many dots the path has', () => {
    expect(getPromptTextWithoutContextReferences('@src/a.test.ts')).toBe('');
    expect(getPromptTextWithoutContextReferences('@.github/workflows/ci.yml')).toBe('');
  });

  it('drops a line of several mentions', () => {
    expect(getPromptTextWithoutContextReferences('@src/a.ts @src/b.ts')).toBe('');
  });

  it('drops directory mentions', () => {
    expect(getPromptTextWithoutContextReferences('@src/')).toBe('');
  });

  it('keeps a line with prose around a mention, mention included', () => {
    expect(getPromptTextWithoutContextReferences('please review @src/foo.ts')).toBe(
      'please review @src/foo.ts'
    );
  });

  it('keeps lines with no mention at all', () => {
    expect(getPromptTextWithoutContextReferences('just some text')).toBe('just some text');
  });

  it('leaves email addresses alone', () => {
    expect(getPromptTextWithoutContextReferences('ping me at someone@example.com')).toBe(
      'ping me at someone@example.com'
    );
  });

  it('drops context reference lines', () => {
    expect(
      getPromptTextWithoutContextReferences(
        '[Active file: src/foo.ts]\n[Selection from src/foo.ts lines 3-5]\nreal prompt'
      )
    ).toBe('real prompt');
  });

  it('keeps mention lines mixed with prose lines', () => {
    expect(getPromptTextWithoutContextReferences('@src/foo.ts\nfix the bug')).toBe('fix the bug');
  });
});

describe('getPastedContextFiles', () => {
  it('turns a selection reference into a context file with line ranges', () => {
    const files = getPastedContextFiles('[Selection from src/foo.ts lines 3-5]', '/repo');

    expect(files).toEqual([
      {
        path: '/repo/src/foo.ts',
        relativePath: 'src/foo.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
    ]);
  });

  it('merges repeated selections of the same file', () => {
    const files = getPastedContextFiles(
      '[Selection from src/foo.ts lines 3-5]\n[Selection from src/foo.ts lines 10]',
      '/repo'
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.lineRanges).toEqual([
      { startLine: 3, endLine: 5 },
      { startLine: 10, endLine: 10 },
    ]);
  });

  it('turns an active file reference into a context file', () => {
    expect(getPastedContextFiles('[Active file: src/foo.ts]', '/repo')).toEqual([
      { path: '/repo/src/foo.ts', relativePath: 'src/foo.ts', type: 'file' },
    ]);
  });

  it('ignores plain text', () => {
    expect(getPastedContextFiles('nothing to see here', '/repo')).toEqual([]);
  });
});

describe('resolvePastedMentionContextFiles', () => {
  it('reports no mentions for plain text', async () => {
    await expect(resolvePastedMentionContextFiles('just some prose')).resolves.toEqual({
      mentionCount: 0,
      resolvedCount: 0,
      files: [],
    });
    expect(resolveWorkspacePath).not.toHaveBeenCalled();
  });

  it('resolves mentions without mutating global attachment state', async () => {
    resolveWorkspacePath.mockResolvedValue({
      path: '/repo/README.md',
      relativePath: 'README.md',
      type: 'file',
    });

    const result = await resolvePastedMentionContextFiles('@README.md');

    expect(result).toEqual({
      mentionCount: 1,
      resolvedCount: 1,
      files: [{ path: '/repo/README.md', relativePath: 'README.md', type: 'file' }],
    });
  });

  it('treats a rejected lookup as unresolved and keeps the rest of the batch', async () => {
    resolveWorkspacePath.mockImplementation(async (path: string) => {
      if (path === 'broken.ts') throw new Error('host unreachable');
      return { path: `/repo/${path}`, relativePath: path, type: 'file' as const };
    });

    const result = await resolvePastedMentionContextFiles('@broken.ts and @README.md');

    expect(result.mentionCount).toBe(2);
    expect(result.resolvedCount).toBe(1);
    expect(result.files).toEqual([
      { path: '/repo/README.md', relativePath: 'README.md', type: 'file' },
    ]);
  });

  it('does not reject when every lookup fails', async () => {
    resolveWorkspacePath.mockRejectedValue(new Error('host unreachable'));

    const result = await resolvePastedMentionContextFiles('@a.ts @b.ts');

    expect(result.mentionCount).toBe(2);
    expect(result.resolvedCount).toBe(0);
    expect(result.files).toEqual([]);
  });
});
