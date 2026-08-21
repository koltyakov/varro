import { describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { replaceMessages, setSessions, setState, skipPlanSession } from '../lib/state';
import type { MessageEntry, Permission, QuestionRequest } from '../types';
import {
  MessageList,
  getActiveTurnMessageId,
  getActiveTurnNavigationMessageId,
  getPromptNumberMap,
} from './MessageList';
import {
  getStandalonePermissionPrompts,
  getStandaloneQuestionPrompts,
  reconcilePendingPermissionSequence,
} from './message-list/pending-prompts';
import { getRenderedMessages } from './message-list/thread-visibility';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  getLatestPlanImplementationMessageId,
  shouldShowPlanImplementationAction,
} from './message-list/plan-actions';
import * as toolCallMatching from '../lib/tool-call-matching';
import { calculateVirtualRange } from './message-list/virtualization';
import {
  clearSessionMessageWindowState,
  resetSessionMessageWindowForRefetch,
  setSessionHistoryPromptCursor,
  setSessionHistoryPrompts,
} from '../lib/message-window';
import { client } from '../lib/client';
import {
  assistantMessage,
  entry,
  installMessageListTestEnvironment,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

installMessageListTestEnvironment({
  getContainer: () => container,
  setContainer: (element) => {
    container = element;
  },
  getCleanup: () => cleanup,
  setCleanup: (nextCleanup) => {
    cleanup = nextCleanup;
  },
});

describe('MessageList prompt numbers', () => {
  it('numbers user prompts in transcript order', () => {
    const numbers = getPromptNumberMap([
      { info: userMessage('user-1'), parts: [] },
      { info: assistantMessage('assistant-1'), parts: [] },
      { info: userMessage('user-2'), parts: [] },
    ]);

    expect([...numbers]).toEqual([
      ['user-1', 1],
      ['user-2', 2],
    ]);
  });

  it('shows prompt counters only while Alt is held', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'First prompt')] },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text-1', 'First response')],
      },
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Second prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('.prompt-number-badge')).toBeNull();
    expect(container?.querySelectorAll('.message-sent-time')).toHaveLength(3);
    expect(
      [...(container?.querySelectorAll('.message-sent-time') ?? [])].every(
        (timestamp) => timestamp.classList.contains('is-visible')
      )
    ).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => {
      expect(
        [...(container?.querySelectorAll('.user-message-card .prompt-number-badge') ?? [])].map(
          (badge) => badge.textContent
        )
      ).toEqual(['1', '2']);
    });

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    await Promise.resolve();
    expect(container?.querySelector('.prompt-number-badge')).toBeNull();
    expect(
      [...(container?.querySelectorAll('.message-sent-time') ?? [])].every(
        (timestamp) => timestamp.classList.contains('is-visible')
      )
    ).toBe(true);
  });

  it('includes prefetched prompts outside the loaded message window', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryPrompts(
      'session-1',
      Array.from({ length: 12 }, (_, index) => ({
        info: userMessage(`user-${index + 1}`),
        parts: [textPart(`user-text-${index + 1}`, `Prompt ${index + 1}`)],
      }))
    );
    replaceMessages([
      { info: userMessage('user-13'), parts: [textPart('user-text-13', 'Prompt 13')] },
      {
        info: assistantMessage('assistant-13'),
        parts: [textPart('assistant-text-13', 'Response 13')],
      },
      { info: userMessage('user-14'), parts: [textPart('user-text-14', 'Prompt 14')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => {
      expect(
        [...(container?.querySelectorAll('.user-message-card .prompt-number-badge') ?? [])].map(
          (badge) => badge.textContent
        )
      ).toEqual(['13', '14']);
    });
  });

  it('loads every older prompt page before showing absolute counters', async () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Shared fixtures are imported from the test-utils module.
    const promptPage = (start: number, end: number, nextCursor?: string) => {
      // SAFETY: The fixture provides the complete domain shape read by this statement.
      const page = Array.from({ length: end - start + 1 }, (_, index) => {
        const promptNumber = start + index;
        return {
          info: userMessage(`user-${promptNumber}`),
          parts: [textPart(`user-text-${promptNumber}`, `Prompt ${promptNumber}`)],
        };
      }) as Awaited<ReturnType<typeof client.session.messages>>;
      page.nextCursor = nextCursor;
      return page;
    };

    setState('activeSessionId', 'session-1');
    setSessionHistoryPromptCursor('session-1', 'cursor-12');
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockResolvedValueOnce(promptPage(7, 12, 'cursor-6'))
      .mockResolvedValueOnce(promptPage(1, 6));
    replaceMessages([
      { info: userMessage('user-13'), parts: [textPart('user-text-13', 'Prompt 13')] },
      {
        info: assistantMessage('assistant-13'),
        parts: [textPart('assistant-text-13', 'Response 13')],
      },
      { info: userMessage('user-14'), parts: [textPart('user-text-14', 'Prompt 14')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    expect(container?.querySelector('.prompt-number-badge')).toBeNull();

    await vi.waitFor(() => {
      expect(
        [...(container?.querySelectorAll('.user-message-card .prompt-number-badge') ?? [])].map(
          (badge) => badge.textContent
        )
      ).toEqual(['13', '14']);
    });
    expect(messagesSpy).toHaveBeenNthCalledWith(1, 'session-1', {
      limit: 200,
      before: 'cursor-12',
    });
    expect(messagesSpy).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-6',
    });
  });

  it('keeps partial prompt numbers hidden after a failed page and retries on the next Alt hold', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryPromptCursor('session-1', 'cursor-older');
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockRejectedValueOnce(new Error('Prompt history failed'));
    replaceMessages([
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('.prompt-number-badge')).toBeNull();

    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'Older prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    messagesSpy.mockResolvedValueOnce(olderPage);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));

    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(
        [...(container?.querySelectorAll('.user-message-card .prompt-number-badge') ?? [])].map(
          (badge) => badge.textContent
        )
      ).toEqual(['2']);
    });
  });

  it('reloads absolute prompt numbers after the active session window is reset', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'Older prompt 1')] },
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Older prompt 2')] },
    ]);
    replaceMessages([
      { info: userMessage('user-3'), parts: [textPart('user-text-3', 'Current prompt')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => {
      expect(container?.querySelector('.prompt-number-badge')?.textContent).toBe('3');
    });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));

    resetSessionMessageWindowForRefetch('session-1');
    clearSessionMessageWindowState('session-1');
    setSessionHistoryPromptCursor('session-1', 'cursor-reloaded');
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const reloadedPage = [
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'Older prompt 1')] },
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Older prompt 2')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValue(reloadedPage);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    expect(container?.querySelector('.prompt-number-badge')).toBeNull();
    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-reloaded',
      });
      expect(container?.querySelector('.prompt-number-badge')?.textContent).toBe('3');
    });
  });

  it('keeps prompt numbers hidden while a reset window is awaiting its replacement fetch', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'Older prompt 1')] },
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Older prompt 2')] },
    ]);
    replaceMessages([
      { info: userMessage('user-3'), parts: [textPart('user-text-3', 'Current prompt')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => {
      expect(container?.querySelector('.prompt-number-badge')?.textContent).toBe('3');
    });

    resetSessionMessageWindowForRefetch('session-1');
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(container?.querySelector('.prompt-number-badge')).toBeNull();
  });

  it('does not wait for an obsolete prompt-number load after a window reset', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const currentPage = [
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'Older prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi.spyOn(client.session, 'messages').mockImplementation((_id, options) => {
      if (options?.before === 'cursor-stale') return pendingStalePage;
      if (options?.before === 'cursor-current') return Promise.resolve(currentPage);
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryPromptCursor('session-1', 'cursor-stale');
    replaceMessages([
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Current prompt')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
      await vi.waitFor(() => {
        expect(messagesSpy).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-stale',
        });
      });
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));

      resetSessionMessageWindowForRefetch('session-1');
      setSessionHistoryPromptCursor('session-1', 'cursor-current');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));

      await vi.waitFor(() => {
        expect(messagesSpy).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-current',
        });
      });
    } finally {
      releaseStalePage?.(stalePage);
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('hides prompt counters when the window loses focus', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'First prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => {
      expect(container?.querySelector('.prompt-number-badge')?.textContent).toBe('1');
    });

    window.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    expect(container?.querySelector('.prompt-number-badge')).toBeNull();
  });
});

describe('buildPlanImplementationPrompt', () => {
  it('uses a stable handoff prompt without copying visible plan text', () => {
    expect(
      buildPlanImplementationPrompt([
        textPart('ignored', 'draft', { ignored: true }),
        textPart('plan-1', '1. Update the API route.'),
        textPart('plan-2', '2. Add the missing UI state.'),
      ])
    ).toBe(
      'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.'
    );
  });

  it('uses the same stable handoff prompt when the plan has no visible text', () => {
    expect(
      buildPlanImplementationPrompt([textPart('synthetic', 'placeholder', { synthetic: true })])
    ).toBe(
      'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.'
    );
  });
});

describe('buildPlanDocumentContent', () => {
  it('joins non-synthetic text parts into markdown content', () => {
    expect(
      buildPlanDocumentContent([
        textPart('text-1', '# Plan'),
        textPart('text-2', '1. First'),
        textPart('text-3', 'ignore me', { synthetic: true }),
      ])
    ).toBe('# Plan\n\n1. First');
  });

  it('returns an empty string when no real text parts exist', () => {
    expect(
      buildPlanDocumentContent([textPart('synthetic', 'placeholder', { synthetic: true })])
    ).toBe('');
  });
});

describe('getActiveTurnMessageId', () => {
  const messages: MessageEntry[] = [
    { info: userMessage('user-1'), parts: [] },
    { info: assistantMessage('assistant-1'), parts: [] },
    { info: userMessage('user-2'), parts: [] },
    { info: assistantMessage('assistant-2'), parts: [] },
  ];

  it('uses the first visible user bubble instead of the previous sticky turn', () => {
    expect(getActiveTurnMessageId(messages, 2, 'user-1', 'user-1')).toBe('user-2');
  });

  it('uses the sticky turn when the first visible bubble is an assistant response', () => {
    expect(getActiveTurnMessageId(messages, 3, 'user-2', 'user-1')).toBe('user-2');
  });

  it('finds the preceding turn when no sticky preview is available', () => {
    expect(getActiveTurnMessageId(messages, 3, null, 'user-1')).toBe('user-2');
  });

  it('uses the sticky turn while visible geometry is unavailable', () => {
    expect(getActiveTurnMessageId(messages, null, 'user-2', 'user-1')).toBe('user-2');
  });
});

describe('getActiveTurnNavigationMessageId', () => {
  const turns = ['user-1', 'user-2', 'user-3', 'user-4'].map((id, index) => ({
    id,
    index: index * 2,
    text: `Prompt ${index + 1}`,
    attachmentCount: 0,
    imageCount: 0,
  }));

  it('keeps the clicked turn active while earlier turns remain visible', () => {
    expect(getActiveTurnNavigationMessageId(turns, 'user-1', 'user-3')).toBe('user-3');
    expect(getActiveTurnNavigationMessageId(turns, 'user-2', 'user-3')).toBe('user-3');
  });

  it('advances past the clicked turn while scrolling down', () => {
    expect(getActiveTurnNavigationMessageId(turns, 'user-4', 'user-3')).toBe('user-4');
  });
});

describe('getLatestPlanImplementationMessageId', () => {
  it('returns the last plan response when it is the latest message', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
      ])
    ).toBe('assistant-1');
  });

  it('returns null when a user prompt appears after the plan response', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
        entry(userMessage('user-2')),
      ])
    ).toBeNull();
  });

  it('returns null when the latest assistant response is not a plan response', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
        entry(assistantMessage('assistant-2', { agent: 'build' })),
      ])
    ).toBeNull();
  });

  it('ignores the currently selected plan agent for older non-plan responses', () => {
    setState('sessionSelectedAgents', reconcile({ 'session-1': 'plan' }));

    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1')),
      ])
    ).toBeNull();
  });
});

describe('shouldShowPlanImplementationAction', () => {
  it('hides the action for aborted plan responses', () => {
    const message = assistantMessage('assistant-1', {
      agent: 'plan',
      error: { name: 'aborted', data: { message: 'Aborted' } },
    });

    expect(
      shouldShowPlanImplementationAction({
        hasBuildAgent: true,
        info: message,
        latestPlanImplementationMessageId: 'assistant-1',
      })
    ).toBe(false);
  });

  it('hides the action after the plan session is skipped', () => {
    const message = assistantMessage('assistant-1', { agent: 'plan' });
    setState('skippedPlanSessions', reconcile({}));
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'session-1',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);
    skipPlanSession('session-1', 200);

    expect(
      shouldShowPlanImplementationAction({
        hasBuildAgent: true,
        info: message,
        latestPlanImplementationMessageId: 'assistant-1',
      })
    ).toBe(false);
  });

  it('shows the action for the latest unskipped plan response', () => {
    const message = assistantMessage('assistant-1', { agent: 'plan' });
    setState('skippedPlanSessions', reconcile({}));
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'session-1',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);

    expect(
      shouldShowPlanImplementationAction({
        hasBuildAgent: true,
        info: message,
        latestPlanImplementationMessageId: 'assistant-1',
      })
    ).toBe(true);
  });
});

describe('standalone action prompts', () => {
  it('matches every pending tool while activating only the front permission', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Allow first command',
        metadata: {},
        time: { created: 1 },
      },
      {
        id: 'perm-2',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-2',
        title: 'Allow second command',
        metadata: {},
        time: { created: 2 },
      },
    ];

    const lookup = toolCallMatching.buildPermissionRequestLookup(
      permissions,
      'session-1',
      1,
      2,
      'perm-1'
    );

    expect(lookup.get('session-1\u0000message-1\u0000call-1')).toMatchObject({
      permission: { id: 'perm-1' },
      isActive: true,
      isPrimaryOwner: true,
    });
    expect(lookup.get('session-1\u0000message-1\u0000call-2')).toMatchObject({
      permission: { id: 'perm-2' },
      isActive: false,
      isPrimaryOwner: true,
    });
  });

  it('sequences distinct permissions and skips requests resolved before their turn', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow first command',
        metadata: {},
        time: { created: 1 },
      },
      {
        id: 'perm-2',
        type: 'edit',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow edit',
        metadata: {},
        time: { created: 2 },
      },
      {
        id: 'perm-3',
        type: 'websearch',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow search',
        metadata: {},
        time: { created: 3 },
      },
    ];

    let sequence = reconcilePendingPermissionSequence(undefined, permissions, 'session-1');
    expect(sequence).toMatchObject({
      activePermission: expect.objectContaining({ id: 'perm-1' }),
      position: 1,
      total: 3,
    });

    sequence = reconcilePendingPermissionSequence(
      sequence,
      [permissions[0]!, permissions[1]!],
      'session-1'
    );
    expect(sequence).toMatchObject({
      activePermission: expect.objectContaining({ id: 'perm-1' }),
      position: 1,
      total: 2,
    });

    sequence = reconcilePendingPermissionSequence(sequence, [permissions[1]!], 'session-1');
    expect(sequence).toMatchObject({
      activePermission: expect.objectContaining({ id: 'perm-2' }),
      position: 2,
      total: 2,
    });
  });

  it('keeps unmatched permissions visible as standalone prompts', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('keeps one standalone permission prompt for duplicate requests', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'external_directory',
        sessionID: 'session-1',
        messageID: '',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 1 },
        duplicateIDs: ['perm-1', 'perm-2'],
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('does not duplicate permissions already linked to a tool call', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(
      getStandalonePermissionPrompts(
        [{ info: assistantMessage('message-1'), parts: [toolPart('tool-1')] }],
        permissions,
        'session-1'
      )
    ).toEqual([]);
  });

  it('keeps linked permissions visible when their tool row is hidden in chat', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(
      getStandalonePermissionPrompts(
        [
          {
            info: assistantMessage('message-1'),
            parts: [
              {
                id: 'tool-1',
                sessionID: 'session-1',
                messageID: 'message-1',
                type: 'tool',
                callID: 'call-1',
                tool: 'custom',
                state: {
                  status: 'running',
                  title: 'Updating plan',
                  input: {},
                  time: { start: 1 },
                },
              },
            ],
          },
        ],
        permissions,
        'session-1'
      )
    ).toEqual(permissions);
  });

  it('keeps linked permissions visible when virtualization hides their tool row', () => {
    const messages = Array.from({ length: 60 }, (_, index) => {
      const messageId = `assistant-${index}`;
      return {
        info: assistantMessage(messageId),
        parts:
          index === 0
            ? [toolPart('tool-1', messageId, 'call-1')]
            : [textPart(`text-${index}`, `Response ${index}`)],
      };
    });

    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'assistant-0',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    const visibleRange = calculateVirtualRange({
      itemIds: messages.map((message) => message.info.id),
      measuredHeights: new Map(),
      scrollTop: 7_000,
      viewportHeight: 600,
      defaultItemHeight: 120,
      overscan: 0,
    });

    expect(visibleRange.start).toBeGreaterThan(0);
    expect(
      getStandalonePermissionPrompts(
        messages.slice(visibleRange.start, visibleRange.end),
        permissions,
        'session-1'
      )
    ).toEqual(permissions);
  });

  it('keeps linked permissions visible when their tool row is inside a pinned virtual gap', () => {
    const messages = Array.from({ length: 60 }, (_, index) => {
      const messageId = `assistant-${index}`;
      return {
        info: assistantMessage(messageId),
        parts:
          index === 20
            ? [toolPart('tool-1', messageId, 'call-1')]
            : [textPart(`text-${index}`, `Response ${index}`)],
      };
    });
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'assistant-20',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];
    const renderedMessages = getRenderedMessages(
      messages,
      {
        start: 0,
        end: 50,
        pinnedGapStart: 10,
        pinnedGapEnd: 40,
      },
      true
    );

    expect(getStandalonePermissionPrompts(renderedMessages, permissions, 'session-1')).toEqual(
      permissions
    );
  });

  it('keeps unmatched questions visible as standalone prompts', () => {
    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ];

    expect(getStandaloneQuestionPrompts([], questions, 'session-1')).toEqual(questions);
  });

  it('does not duplicate questions already linked to a tool call', () => {
    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    ];

    expect(
      getStandaloneQuestionPrompts(
        [{ info: assistantMessage('message-1'), parts: [toolPart('tool-1')] }],
        questions,
        'session-1'
      )
    ).toEqual([]);
  });

  it('keeps linked questions visible when their tool row is hidden in chat', () => {
    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    ];

    expect(
      getStandaloneQuestionPrompts(
        [
          {
            info: assistantMessage('message-1'),
            parts: [
              {
                id: 'tool-1',
                sessionID: 'session-1',
                messageID: 'message-1',
                type: 'tool',
                callID: 'call-1',
                tool: 'TodoWrite',
                state: {
                  status: 'running',
                  input: {},
                  time: { start: 1 },
                },
              },
            ],
          },
        ],
        questions,
        'session-1'
      )
    ).toEqual(questions);
  });

  it('keeps child-session permissions visible for the active root session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);

    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'child-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('keeps unresolved-session permissions visible from the active session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
    ]);

    const permissions: Permission[] = [
      {
        id: 'perm-unresolved-child',
        type: 'bash',
        sessionID: 'child-unknown',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(
      reconcilePendingPermissionSequence(undefined, permissions, 'session-1').activePermission
    ).toEqual(permissions[0]);
    expect(getStandalonePermissionPrompts([], permissions, 'session-1')).toEqual(permissions);
  });

  it('keeps child-session questions visible for the active root session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);

    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'child-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ];

    expect(getStandaloneQuestionPrompts([], questions, 'session-1')).toEqual(questions);
  });

  it('keeps root-session permissions visible while viewing a child session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);

    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ];

    expect(getStandalonePermissionPrompts([], permissions, 'child-1')).toEqual(permissions);
  });

  it('keeps root-session questions visible while viewing a child session', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);

    const questions: QuestionRequest[] = [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ];

    expect(getStandaloneQuestionPrompts([], questions, 'child-1')).toEqual(questions);
  });
});
