import { describe, expect, it } from 'vitest';
import {
  getActiveCompletion,
  getMentionCompletionItems,
  parseDroppedText,
  shouldPadInlineInsertion,
  isToolbarControlCompacted,
  isToolbarControlHidden,
  getSlashCommands,
} from './ChatInput';

describe('isToolbarControlCompacted', () => {
  it('removes the stop label before compacting other toolbar controls', () => {
    expect(isToolbarControlCompacted('full', 'agent')).toBe(false);
    expect(isToolbarControlCompacted('full', 'reasoning')).toBe(false);
    expect(isToolbarControlCompacted('full', 'stop')).toBe(false);

    expect(isToolbarControlCompacted('compact-stop', 'stop')).toBe(true);
    expect(isToolbarControlCompacted('compact-stop', 'agent')).toBe(false);
    expect(isToolbarControlCompacted('compact-stop', 'reasoning')).toBe(false);

    expect(isToolbarControlCompacted('compact-agent', 'agent')).toBe(true);
    expect(isToolbarControlCompacted('compact-agent', 'reasoning')).toBe(false);
    expect(isToolbarControlCompacted('compact-agent', 'stop')).toBe(true);

    expect(isToolbarControlCompacted('compact-reasoning', 'agent')).toBe(true);
    expect(isToolbarControlCompacted('compact-reasoning', 'reasoning')).toBe(true);
    expect(isToolbarControlCompacted('compact-reasoning', 'stop')).toBe(true);

    expect(isToolbarControlCompacted('truncate-model', 'agent')).toBe(true);
    expect(isToolbarControlCompacted('truncate-model', 'reasoning')).toBe(true);
    expect(isToolbarControlCompacted('truncate-model', 'stop')).toBe(true);
  });
});

describe('isToolbarControlHidden', () => {
  it('does not hide controls during label compaction or model truncation', () => {
    expect(isToolbarControlHidden('compact-agent', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-reasoning', 'permission')).toBe(false);
    expect(isToolbarControlHidden('truncate-model', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-stop', 'permission')).toBe(false);
    expect(isToolbarControlHidden('compact-stop', 'send')).toBe(false);
  });

  it('hides controls in the requested order as the toolbar gets tighter', () => {
    expect(isToolbarControlHidden('full', 'permission')).toBe(false);

    expect(isToolbarControlHidden('hide-permission', 'permission')).toBe(true);
    expect(isToolbarControlHidden('hide-permission', 'attachments')).toBe(false);

    expect(isToolbarControlHidden('hide-attachments', 'attachments')).toBe(true);
    expect(isToolbarControlHidden('hide-attachments', 'send')).toBe(false);

    expect(isToolbarControlHidden('compact-stop', 'send')).toBe(false);
    expect(isToolbarControlHidden('compact-stop', 'stop')).toBe(false);

    expect(isToolbarControlHidden('hide-send', 'send')).toBe(true);
    expect(isToolbarControlHidden('hide-send', 'reasoning')).toBe(false);

    expect(isToolbarControlHidden('hide-reasoning', 'reasoning')).toBe(true);
    expect(isToolbarControlHidden('hide-reasoning', 'agent')).toBe(false);

    expect(isToolbarControlHidden('hide-agent', 'agent')).toBe(true);
    expect(isToolbarControlHidden('hide-agent', 'stop')).toBe(false);

    expect(isToolbarControlHidden('hide-stop', 'stop')).toBe(true);
    expect(isToolbarControlHidden('hide-stop', 'context')).toBe(false);

    expect(isToolbarControlHidden('hide-context', 'context')).toBe(true);
  });

  it('keeps the full hide set in tight mode', () => {
    expect(isToolbarControlHidden('tight', 'permission')).toBe(true);
    expect(isToolbarControlHidden('tight', 'attachments')).toBe(true);
    expect(isToolbarControlHidden('tight', 'send')).toBe(true);
    expect(isToolbarControlHidden('tight', 'reasoning')).toBe(true);
    expect(isToolbarControlHidden('tight', 'agent')).toBe(true);
    expect(isToolbarControlHidden('tight', 'stop')).toBe(true);
    expect(isToolbarControlHidden('tight', 'context')).toBe(true);
  });
});

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

describe('getActiveCompletion', () => {
  it('detects slash commands only at the start of the input', () => {
    expect(getActiveCompletion('/rev', 4)).toEqual({
      type: 'slash',
      query: 'rev',
      start: 0,
      end: 4,
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

describe('getSlashCommands', () => {
  it('includes init, export, redo, and custom commands while preserving built-ins', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: true,
      canRedo: true,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      customCommands: [
        {
          name: 'test',
          description: 'Run tests',
          template: 'Run tests',
        },
        {
          name: 'settings',
          description: 'Override built-in',
          template: 'ignored',
        },
      ],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(true);
    expect(commands.some((command) => command.name === 'export')).toBe(true);
    expect(commands.some((command) => command.name === 'redo')).toBe(true);
    expect(commands.some((command) => command.name === 'test')).toBe(true);
    expect(commands.filter((command) => command.name === 'settings')).toHaveLength(1);
  });
});

describe('parseDroppedText', () => {
  it('parses absolute, relative, and uri-list entries while dropping comments and duplicates', () => {
    expect(
      parseDroppedText(
        [
          '# comment',
          'file:///tmp/demo.ts',
          './src/app.ts',
          './src/app.ts',
          '/Users/andrew/Projects/GitHub/varro/README.md',
        ].join('\n')
      )
    ).toEqual(['/tmp/demo.ts', 'src/app.ts', '/Users/andrew/Projects/GitHub/varro/README.md']);
  });

  it('extracts paths from structured vscode drag payloads', () => {
    expect(
      parseDroppedText(
        JSON.stringify({
          resource: 'file:///tmp/from-resource.ts',
          nested: ['src/test.ts', { path: '../docs/guide.md' }],
          ignored: 'not a plain sentence with spaces',
        })
      )
    ).toEqual(['/tmp/from-resource.ts', 'src/test.ts', '../docs/guide.md']);
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
});
