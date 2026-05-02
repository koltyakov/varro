import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import {
  ChatInput,
  getActiveCompletion,
  getCompletionSelection,
  getMentionCompletionItems,
  parseDroppedText,
  shouldRequestMentionFileSearch,
  shouldPadInlineInsertion,
  isToolbarControlCompacted,
  isToolbarControlHidden,
  getSlashCommands,
} from './ChatInput';
import {
  state,
  setIsLoading,
  setProviderLimitPollIntervalSeconds,
  setProviderLimitThresholdPercent,
  setState,
  setInputText,
} from '../lib/state';

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async () => {}),
}));

vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    sendMessage: sendMessageMock,
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  globalThis.ResizeObserver = originalResizeObserver;
  setInputText('');
  setIsLoading(false);
  setProviderLimitPollIntervalSeconds(120);
  setProviderLimitThresholdPercent(40);
  setState('activeSessionId', null);
  setState('messages', []);
  setState('providers', []);
  setState('providerDefaults', {});
  setState('selectedModel', null);
  setState('providerLimits', {});
  setState('clipboardImages', []);
  setState('droppedFiles', []);
  setState('terminalSelection', null);
  setState('queuedMessages', []);
  sendMessageMock.mockReset();
});

describe('ChatInput', () => {
  it('renders while loading before the current model memo is initialized', () => {
    setInputText('Ask the sub-agent');
    setIsLoading(true);

    expect(() => {
      cleanup = render(() => ChatInput(), container!);
    }).not.toThrow();
  });

  it('hides provider-limit UI when polling is disabled', () => {
    setProviderLimitPollIntervalSeconds(-1);
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'daily',
            label: 'Daily',
            unit: 'requests',
            remaining: 12,
            limit: 50,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).toBeNull();
  });

  it('hides provider-limit UI when no window crosses the threshold', () => {
    setProviderLimitThresholdPercent(40);
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 41,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'month',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).toBeNull();
  });

  it('shows provider-limit UI when any window crosses the threshold', () => {
    setProviderLimitThresholdPercent(40);
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'month',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).not.toBeNull();
  });

  it('queues busy composer attachments and clears them from the input', () => {
    setInputText('Follow up with context');
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('droppedFiles', [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }]);
    setState('clipboardImages', [
      { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
    ]);
    setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    cleanup = render(() => ChatInput(), container!);

    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[title="Add to queue (Enter)"]'
    );
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container?.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(container?.querySelector('.chat-queue-item')).not.toBeNull();
    expect(state.droppedFiles).toEqual([]);
    expect(state.clipboardImages).toEqual([]);
    expect(state.terminalSelection).toBeNull();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]).toMatchObject({
      text: 'Follow up with context',
      droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
      clipboardImages: [
        { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
  });

  it('shows an attachment badge in queued rows', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Queued follow-up',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const meta = container?.querySelector('.chat-queue-meta');
    expect(meta?.textContent).toContain('2');
    expect(container?.querySelector('.chat-queue-attachment-icon')).not.toBeNull();
  });
});

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

describe('getSlashCommands', () => {
  it('includes init for blank sessions alongside built-ins and custom commands', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: true,
      canRedo: true,
      canInit: true,
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

  it('hides init outside blank sessions', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: false,
      canRedo: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      customCommands: [],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
  });

  it('keeps reserved built-ins hidden when a custom command reuses the name', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: false,
      canRedo: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      customCommands: [
        {
          name: 'init',
          description: 'Should stay hidden',
          template: 'ignored',
        },
      ],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
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
