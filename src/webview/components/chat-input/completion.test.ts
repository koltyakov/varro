import { describe, expect, it } from 'vitest';
import {
  getActiveCompletion,
  getCompletionSelection,
  getInlineInsertionSuffix,
  getLeadingSlashCommand,
  getMentionCompletionItems,
  getMentionInsertionTrailingSpace,
  shouldPadInlineInsertion,
  shouldRequestMentionFileSearch,
} from './completion';

describe('getMentionCompletionItems', () => {
  const agents = [
    {
      name: 'helper',
      description: 'Helpful agent',
      mode: 'all',
      permission: {
        edit: 'allow',
        bash: { '*': 'allow' },
      },
    },
  ];

  const files = [
    {
      path: '/workspace/README.md',
      relativePath: 'README.md',
      type: 'file' as const,
    },
  ];

  it('shows file results for bare filename queries', () => {
    const completions = getMentionCompletionItems({
      rawQuery: 'readme',
      agents,
      files,
    });

    expect(completions.some((item) => item.type === 'file' && item.label === '@README.md')).toBe(
      true
    );
  });

  it('terminates file mentions after selection', () => {
    const completions = getMentionCompletionItems({
      rawQuery: 'readme',
      agents,
      files,
    });

    const fileItem = completions.find(
      (item): item is Extract<(typeof completions)[number], { type: 'file' }> =>
        item.type === 'file'
    );

    expect(fileItem?.value).toBe('@README.md ');
  });

  it('shows file results for empty @ queries', () => {
    const completions = getMentionCompletionItems({
      rawQuery: '',
      agents,
      files,
      meta: { showFileSearchHint: true },
    });

    expect(completions.some((item) => item.type === 'agent' && item.label === '@helper')).toBe(
      true
    );
    expect(completions.some((item) => item.type === 'file')).toBe(false);
  });

  it('suppresses suggestions for exact agent and file matches', () => {
    expect(
      getMentionCompletionItems({
        rawQuery: 'helper',
        agents,
        files,
      })
    ).toEqual([]);

    expect(
      getMentionCompletionItems({
        rawQuery: 'README.md',
        agents,
        files,
      })
    ).toEqual([]);
  });

  it('formats directory mentions with a trailing slash', () => {
    const completions = getMentionCompletionItems({
      rawQuery: 'do',
      agents,
      files: [
        {
          path: '/workspace/docs',
          relativePath: 'docs',
          type: 'directory' as const,
        },
      ],
    });

    expect(completions).toContainEqual(
      expect.objectContaining({
        type: 'file',
        label: '@docs',
        detail: 'Folder',
        value: '@docs/',
      })
    );
  });
});

describe('shouldRequestMentionFileSearch', () => {
  it('skips duplicate mention file searches when the query text is unchanged', () => {
    expect(shouldRequestMentionFileSearch('readme', 'readme')).toBe(false);
    expect(shouldRequestMentionFileSearch('readme', 'read')).toBe(true);
    expect(shouldRequestMentionFileSearch('', 'readme')).toBe(true);
  });
});

describe('getActiveCompletion', () => {
  it('detects slash commands only at the start of the input', () => {
    expect(getActiveCompletion('/rev', 4)).toEqual({
      type: 'slash',
      query: 'rev',
      start: 0,
      end: 4,
    });
    expect(getActiveCompletion('/skills ', 8)).toEqual({
      type: 'slash',
      query: 'skills ',
      start: 0,
      end: 8,
    });
    expect(getActiveCompletion('/skills browser', 15)).toEqual({
      type: 'slash',
      query: 'skills browser',
      start: 0,
      end: 15,
    });
    expect(getActiveCompletion('prefix /rev', 11)).toBeNull();
  });

  it('detects mention completions for the active token', () => {
    expect(getActiveCompletion('review @hel', 11)).toEqual({
      type: 'mention',
      query: 'hel',
      start: 7,
      end: 11,
    });
    expect(getActiveCompletion('review test', 11)).toBeNull();
  });

  it('rejects cursor positions outside the input bounds', () => {
    expect(getActiveCompletion('abc', -1)).toBeNull();
    expect(getActiveCompletion('abc', 4)).toBeNull();
  });
});

describe('getLeadingSlashCommand', () => {
  it('parses a leading slash command with optional arguments', () => {
    expect(getLeadingSlashCommand('/test')).toEqual({ name: 'test', args: '' });
    expect(getLeadingSlashCommand('/test --watch')).toEqual({ name: 'test', args: '--watch' });
    expect(getLeadingSlashCommand('  /review branch  ')).toEqual({
      name: 'review',
      args: 'branch',
    });
  });

  it('rejects slash commands that are not the whole trimmed input', () => {
    expect(getLeadingSlashCommand('prefix /test')).toBeNull();
    expect(getLeadingSlashCommand('')).toBeNull();
  });
});

describe('getCompletionSelection', () => {
  it('confirms slash selections by invoking the command path', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'in', start: 0, end: 3 },
        {
          key: 'slash:init',
          type: 'slash',
          name: 'init',
          aliases: [],
          description: 'Analyze the project and create AGENTS.md',
          action: () => {},
        },
        true
      )
    ).toEqual({ type: 'run-slash', value: '/init' });
  });

  it('keeps tab-style slash selections as composer text updates', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'in', start: 0, end: 3 },
        {
          key: 'slash:init',
          type: 'slash',
          name: 'init',
          aliases: [],
          description: 'Analyze the project and create AGENTS.md',
          action: () => {},
        }
      )
    ).toEqual({ type: 'set-slash', value: '/init' });
  });

  it('keeps selecting /skills as a composer text update', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'sk', start: 0, end: 3 },
        {
          key: 'slash:skills',
          type: 'slash',
          name: 'skills',
          aliases: [],
          description: 'Browse available skills',
          action: () => {},
        },
        true
      )
    ).toEqual({ type: 'set-slash', value: '/skills ' });
  });

  it('keeps selecting a skill entry as a composer text update', () => {
    expect(
      getCompletionSelection(
        { type: 'slash', query: 'skills bro', start: 0, end: 11 },
        {
          key: 'skill:browser-bridge',
          type: 'slash',
          name: 'browser-bridge',
          aliases: [],
          description: 'Token-efficient Chrome tab inspection',
          action: () => {},
        },
        true
      )
    ).toEqual({ type: 'set-slash', value: '/browser-bridge' });
  });

  it('returns mention selections with attached file metadata', () => {
    const file = {
      path: '/workspace/README.md',
      relativePath: 'README.md',
      type: 'file' as const,
    };

    expect(
      getCompletionSelection(
        { type: 'mention', query: 'read', start: 0, end: 5 },
        {
          key: 'file:/workspace/README.md',
          type: 'file',
          label: '@README.md',
          detail: 'File',
          value: '@README.md ',
          file,
        },
        true
      )
    ).toEqual({ type: 'apply-mention', value: '@README.md ', file });
  });
});

describe('shouldPadInlineInsertion', () => {
  it('pads only when adjacent content is non-whitespace', () => {
    expect(shouldPadInlineInsertion('a')).toBe(true);
    expect(shouldPadInlineInsertion('/')).toBe(true);
    expect(shouldPadInlineInsertion(' ')).toBe(false);
    expect(shouldPadInlineInsertion('\n')).toBe(false);
    expect(shouldPadInlineInsertion(undefined)).toBe(false);
  });

  it('treats end-of-input as requiring a trailing separator for inline insertions', () => {
    expect(getInlineInsertionSuffix('Look at this', 'Look at this'.length)).toBe(' ');
    expect(getInlineInsertionSuffix('Look at this?', 12)).toBe(' ');
    expect(getInlineInsertionSuffix('Look at this ', 'Look at this'.length)).toBe('');
  });
});

describe('getMentionInsertionTrailingSpace', () => {
  it('does not add a second trailing space when the mention value already has one', () => {
    expect(getMentionInsertionTrailingSpace('@helper ', undefined)).toBe('');
    expect(getMentionInsertionTrailingSpace('@README.md ', 'x')).toBe('');
  });

  it('adds a trailing space only when the mention is adjacent to non-whitespace', () => {
    expect(getMentionInsertionTrailingSpace('@helper', undefined)).toBe(' ');
    expect(getMentionInsertionTrailingSpace('@helper', 'x')).toBe(' ');
    expect(getMentionInsertionTrailingSpace('@helper', ' ')).toBe('');
    expect(getMentionInsertionTrailingSpace('@helper', '\n')).toBe('');
  });
});
