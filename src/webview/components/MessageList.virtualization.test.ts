import { describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setMessagesIncremental,
  setState,
  state,
  upsertPart,
} from '../lib/state';
import type { MessageEntry, Part } from '../types';
import type { AssistantActivityGroupInfo } from '../lib/assistant-activity';
import { MessageList, canWidthResizeOwnAnchor } from './MessageList';
import {
  getChangedInlinePreviewMessageIds,
  getAssistantFlowSpacingSize,
  getBorderedAdjacencyLayoutSignatures,
  getCompactActivityDisclosureLayoutSignatures,
  getCompactActivityLayoutSignatures,
  getInlinePreviewLayoutSignatures,
  getMessageBlockBoundaryMap,
} from './message-list/row-layout';
import { startEditingMessage } from '../lib/message-edit-state';
import {
  cacheSessionHistoryPage,
  invalidateSessionMessageWindowRequests,
  markSessionHistoryLoadFailed,
  resetSessionMessageWindowForRefetch,
  setSessionHistoryCursor,
} from '../lib/message-window';
import { client } from '../lib/client';
import {
  assistantMessage,
  filePart,
  installMessageListTestEnvironment,
  installQueuedAnimationFrameMocks,
  reasoningPart,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';
import { fixture } from '../test-fixtures';

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

describe('inline preview virtualization signatures', () => {
  const compactFileEdit: Part = {
    id: 'compact-edit',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'compact-call',
    tool: 'apply_patch',
    state: {
      status: 'completed',
      input: {},
      output: '',
      title: 'apply_patch',
      metadata: {
        files: [{ type: 'update', relativePath: 'src/app.ts', additions: 1, deletions: 1 }],
      },
      time: { start: 1, end: 2 },
    },
  };
  const previewFileEdit: Part = {
    id: 'preview-edit',
    sessionID: 'session-1',
    messageID: 'message-2',
    type: 'tool',
    callID: 'preview-call',
    tool: 'apply_patch',
    state: {
      status: 'running',
      input: { patchText: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new' },
      title: 'apply_patch',
      metadata: {},
      time: { start: 1 },
    },
  };

  it('does not create layout revisions for compact cards without preview content', () => {
    const messages = [{ info: { id: 'message-1' }, parts: [compactFileEdit] }];

    expect(getInlinePreviewLayoutSignatures(messages, false)).toEqual(new Map());
    expect(getInlinePreviewLayoutSignatures(messages, true)).toEqual(new Map());
  });

  it('invalidates only messages whose inline preview layout changes', () => {
    const messages = [{ info: { id: 'message-2' }, parts: [previewFileEdit] }];
    const previewSignatures = getInlinePreviewLayoutSignatures(messages, true);
    const messageIds = new Set(['message-1', 'message-2']);

    expect(getChangedInlinePreviewMessageIds(new Map(), previewSignatures, messageIds)).toEqual([
      'message-2',
    ]);
    expect(
      getChangedInlinePreviewMessageIds(previewSignatures, previewSignatures, messageIds)
    ).toEqual([]);
    expect(getChangedInlinePreviewMessageIds(previewSignatures, new Map(), messageIds)).toEqual([
      'message-2',
    ]);
    expect(
      getChangedInlinePreviewMessageIds(previewSignatures, new Map(), new Set(['message-1']))
    ).toEqual([]);
  });

  it('revises preview layout when a completed edit drops its active header', () => {
    const runningMessages = [{ info: { id: 'message-2' }, parts: [previewFileEdit] }];
    const completedMessages = [
      {
        info: { id: 'message-2' },
        parts: [
          {
            ...previewFileEdit,
            state: {
              status: 'completed' as const,
              input: previewFileEdit.state.input,
              output: 'Done',
              title: 'apply_patch',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ];

    expect(getInlinePreviewLayoutSignatures(completedMessages, true)).not.toEqual(
      getInlinePreviewLayoutSignatures(runningMessages, true)
    );
  });
});

describe('compact activity virtualization signatures', () => {
  const activityPart: Part = {
    id: 'read-1',
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };

  it('signatures include only assistant rows with compactable activity', () => {
    const messages = [
      { info: { id: 'user-1', role: 'user' as const }, parts: [textPart('text-1', 'Prompt')] },
      {
        info: { id: 'assistant-1', role: 'assistant' as const },
        parts: [activityPart, textPart('text-2', 'Result')],
      },
      {
        info: { id: 'assistant-2', role: 'assistant' as const },
        parts: [textPart('text-3', 'Result only')],
      },
    ];

    expect(getCompactActivityLayoutSignatures(messages)).toEqual(
      new Map([['assistant-1', 'read-1']])
    );
  });

  it('revises every participating row when the shared disclosure changes', () => {
    const group = {
      key: 'activity-turn\u0000session-1\u0000user-1',
      ownerMessageId: 'assistant-1',
      ownerPartId: 'read-1',
      parts: [activityPart],
    };
    const groups = new Map([
      ['assistant-1', [group]],
      ['assistant-2', [group]],
    ]);
    const collapsed = getCompactActivityDisclosureLayoutSignatures(groups, () => false);
    const expanded = getCompactActivityDisclosureLayoutSignatures(groups, () => true);

    expect(getChangedInlinePreviewMessageIds(collapsed, expanded, new Set(groups.keys()))).toEqual([
      'assistant-1',
      'assistant-2',
    ]);

    const movedOwner = new Map([
      [
        'assistant-2',
        [
          {
            ...group,
            ownerMessageId: 'assistant-2',
            ownerPartId: 'read-2',
          },
        ],
      ],
    ]);
    expect(
      getChangedInlinePreviewMessageIds(
        new Map([['assistant-2', collapsed.get('assistant-2')!]]),
        getCompactActivityDisclosureLayoutSignatures(movedOwner, () => false),
        new Set(['assistant-2'])
      )
    ).toEqual(['assistant-2']);
  });

  it('revises a disclosure when an edit joins without changing its owner', () => {
    const editPart: Part = {
      ...activityPart,
      id: 'edit-1',
      callID: 'call-edit-1',
      tool: 'edit',
    };
    const initialGroup = {
      key: 'activity-turn\u0000session-1\u0000user-1',
      ownerMessageId: 'assistant-1',
      ownerPartId: 'read-1',
      parts: [activityPart],
    };
    const extendedGroup = { ...initialGroup, parts: [activityPart, editPart] };
    const initial = getCompactActivityDisclosureLayoutSignatures(
      new Map([['assistant-1', [initialGroup]]]),
      () => false
    );
    const extended = getCompactActivityDisclosureLayoutSignatures(
      new Map([['assistant-1', [extendedGroup]]]),
      () => false
    );

    expect(getChangedInlinePreviewMessageIds(initial, extended, new Set(['assistant-1']))).toEqual([
      'assistant-1',
    ]);
  });

  it('revises a disclosure when activity changes transition state', () => {
    const group: AssistantActivityGroupInfo = {
      key: 'activity-turn\u0000session-1\u0000user-1',
      ownerMessageId: 'assistant-1',
      ownerPartId: activityPart.id,
      parts: [activityPart],
    };
    const groups = new Map([['assistant-1', [group]]]);
    const signature = (layoutState: string) =>
      getCompactActivityDisclosureLayoutSignatures(
        groups,
        () => false,
        () => layoutState
      ).get('assistant-1');

    expect(new Set(['active', 'retained', 'exiting', 'grouped'].map(signature))).toHaveLength(4);
  });

  it('projects bordered boundaries for collapsed and expanded cross-row activity', () => {
    const continuedPart: Part = {
      ...activityPart,
      id: 'read-2',
      messageID: 'assistant-2',
      callID: 'call-2',
    };
    const group: AssistantActivityGroupInfo = {
      key: 'activity-turn\u0000session-1\u0000user-1',
      ownerMessageId: 'assistant-1',
      ownerPartId: activityPart.id,
      parts: [activityPart, continuedPart],
    };
    const messages: MessageEntry[] = [
      { info: assistantMessage('assistant-1'), parts: [activityPart] },
      { info: assistantMessage('assistant-2'), parts: [continuedPart] },
    ];
    const groups = new Map([
      ['assistant-1', [group]],
      ['assistant-2', [group]],
    ]);
    const project = (expanded: boolean, emptyIds: ReadonlySet<string> = new Set()) =>
      getMessageBlockBoundaryMap(messages, groups, {
        expandedActivityGroup: () => expanded,
        renderEmptyMessageIds: emptyIds,
        showThinking: true,
      });

    expect(project(false, new Set(['assistant-2']))).toEqual(
      new Map([
        ['assistant-1', { startsBordered: false, endsBordered: false, signature: 'u:u:0' }],
        ['assistant-2', { startsBordered: false, endsBordered: false, signature: 'empty' }],
      ])
    );
    expect(project(true)).toEqual(
      new Map([
        ['assistant-1', { startsBordered: false, endsBordered: true, signature: 'u:b:0' }],
        ['assistant-2', { startsBordered: true, endsBordered: true, signature: 'b:b:0' }],
      ])
    );
  });
});

describe('bordered message projection', () => {
  it('distinguishes bordered cards from prose and row chrome', () => {
    const messages: MessageEntry[] = [
      { info: userMessage('user-1'), parts: [textPart('user-text', 'Prompt')] },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Prose'), toolPart('tool-1', 'assistant-1')],
      },
    ];
    const boundaries = getMessageBlockBoundaryMap(messages, new Map(), {
      expandedActivityGroup: () => false,
      renderEmptyMessageIds: new Set(),
      showThinking: true,
      modelChangeMessageIds: new Set(['user-1']),
    });

    expect(boundaries.get('user-1')).toEqual({
      startsBordered: false,
      endsBordered: true,
      signature: 'user:content:u:b',
    });
    expect(boundaries.get('assistant-1')).toEqual({
      startsBordered: false,
      endsBordered: true,
      signature: 'u:b:0',
    });
  });

  it('invalidates visual adjacency through zero-height rows', () => {
    const messages = [{ info: { id: 'a' } }, { info: { id: 'empty' } }, { info: { id: 'b' } }];
    const boundaries = new Map([
      ['a', { startsBordered: true, endsBordered: true, signature: 'b' }],
      ['empty', { startsBordered: false, endsBordered: false, signature: 'empty' }],
      ['b', { startsBordered: true, endsBordered: true, signature: 'b' }],
    ]);
    const signatures = getBorderedAdjacencyLayoutSignatures(
      messages,
      boundaries,
      new Set(['empty'])
    );

    expect(signatures.get('b')).toBe('b\u0000a\u0000tight');
    const visibleMiddle = getBorderedAdjacencyLayoutSignatures(messages, boundaries, new Set());
    expect(visibleMiddle.get('b')).toBe('b\u0000empty\u0000normal');
  });

  it('includes bordered-pair overlap in flow spacing', () => {
    const bordered = { startsBordered: true, endsBordered: true };

    expect(getAssistantFlowSpacingSize([bordered, bordered], 8)).toBe(6);
    expect(getAssistantFlowSpacingSize([bordered, bordered, bordered], 8)).toBe(12);
    expect(
      getAssistantFlowSpacingSize([bordered, bordered, bordered], 8) -
        getAssistantFlowSpacingSize([bordered, bordered], 8)
    ).toBe(6);
    expect(
      getAssistantFlowSpacingSize(
        [bordered, { startsBordered: false, endsBordered: false, permissionPrompt: true }],
        8
      )
    ).toBe(6);
  });

  it('excludes delayed activity from a visible row boundary', () => {
    const runningPart: Part = {
      ...toolPart('running-1', 'assistant-1'),
      state: {
        status: 'running',
        input: { command: 'npm test' },
        title: 'npm test',
        time: { start: 1 },
      },
    };
    const messages: MessageEntry[] = [
      {
        info: assistantMessage('assistant-1'),
        parts: [runningPart, { ...textPart('text-1', 'Visible prose'), messageID: 'assistant-1' }],
      },
    ];
    const partKey = `${runningPart.messageID}\u0000${runningPart.id}`;
    const boundary = getMessageBlockBoundaryMap(messages, new Map(), {
      delayedActivityPartKeys: new Set([partKey]),
      expandedActivityGroup: () => false,
      renderEmptyMessageIds: new Set(),
      showThinking: true,
    }).get('assistant-1');

    expect(boundary).toEqual({ startsBordered: false, endsBordered: false, signature: 'u:u:0' });
  });

  it('projects permission activity in its rendered order with its prompt', () => {
    const ownerPart = toolPart('read-1', 'assistant-1');
    const waitingPart = toolPart('bash-1', 'assistant-1');
    const group: AssistantActivityGroupInfo = {
      key: 'activity-1',
      ownerMessageId: 'assistant-1',
      ownerPartId: ownerPart.id,
      parts: [ownerPart],
    };
    const boundary = getMessageBlockBoundaryMap(
      [{ info: assistantMessage('assistant-1'), parts: [waitingPart, ownerPart] }],
      new Map([['assistant-1', [group]]]),
      {
        expandedActivityGroup: () => false,
        renderEmptyMessageIds: new Set(),
        showThinking: true,
        trailingPermissionMessageIds: new Set(['assistant-1']),
        waitingActivityPartKeys: new Set([`${waitingPart.messageID}\u0000${waitingPart.id}`]),
      }
    ).get('assistant-1');

    expect(boundary).toEqual({ startsBordered: false, endsBordered: true, signature: 'u:b:1' });
  });
});

describe('width resize ownership', () => {
  const noOwners = {
    bottomFollow: false,
    diffFocus: false,
    editing: false,
    expansion: false,
    history: false,
    stickyNavigation: false,
    structuralReconciliation: false,
  };
  const strongerOwners = [
    'bottomFollow',
    'diffFocus',
    'editing',
    'expansion',
    'history',
    'stickyNavigation',
    'structuralReconciliation',
  ] satisfies Array<keyof typeof noOwners>;

  it('yields its anchor to every stronger scroll owner', () => {
    expect(canWidthResizeOwnAnchor(noOwners)).toBe(true);
    for (const owner of strongerOwners) {
      expect(canWidthResizeOwnAnchor({ ...noOwners, [owner]: true }), owner).toBe(false);
    }
  });
});

describe('MessageList history pagination', () => {
  async function mountDeferredHistory(
    initialMessages: MessageEntry[] = [
      {
        info: userMessage('current-user'),
        parts: [textPart('current-user-text', 'Current prompt')],
      },
      {
        info: assistantMessage('current-assistant'),
        parts: [textPart('current-assistant-text', 'Current response')],
      },
    ],
    getMessageLayoutOffset: (messageId: string) => number = () => 0,
    olderPage: Awaited<ReturnType<typeof client.session.messages>> = [
      { info: userMessage('older-user'), parts: [textPart('older-user-text', 'Older prompt')] },
      {
        info: assistantMessage('older-assistant'),
        parts: [textPart('older-assistant-text', 'Older response')],
      },
    ]
  ) {
    const animationFrames = installQueuedAnimationFrameMocks();
    let releasePage: ((page: typeof olderPage) => void) | undefined;
    const pendingPage = new Promise<typeof olderPage>((resolve) => {
      releasePage = resolve;
    });
    const messagesSpy = vi.spyOn(client.session, 'messages').mockReturnValue(pendingPage);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, state.messages.length * 100);
        }
        if (this.dataset.assistantRenderKey) {
          const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
          const index = state.messages.findIndex((message) => message.info.id === messageId);
          const documentTop = index * 100 + getMessageLayoutOffset(messageId || '');
          return new DOMRect(0, documentTop + 6 - scrollTopValue, 500, 40);
        }
        if (this.dataset.msgId) {
          const index = state.messages.findIndex(
            (message) => message.info.id === this.dataset.msgId
          );
          const documentTop = index * 100 + getMessageLayoutOffset(this.dataset.msgId);
          return new DOMRect(0, documentTop - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    replaceMessages(initialMessages);
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => 1200 + Math.max(0, state.messages.length - initialMessages.length) * 100,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    return {
      animationFrames,
      list,
      getScrollTop: () => scrollTopValue,
      setScrollTop: (value: number) => {
        scrollTopValue = value;
      },
      async startLoad(top: number) {
        list!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
        scrollTopValue = top;
        list!.dispatchEvent(new Event('scroll'));
        await vi.waitFor(() => {
          expect(messagesSpy).toHaveBeenCalledWith('session-1', {
            limit: 200,
            before: 'cursor-1',
          });
        });
      },
      async resolveLoad() {
        this.releaseLoad();
        await this.waitForPrepend();
        for (let frame = 0; frame < 3; frame += 1) {
          await Promise.resolve();
          animationFrames.flush();
        }
        await Promise.resolve();
      },
      releaseLoad() {
        releasePage?.(olderPage);
      },
      async waitForPrepend() {
        await vi.waitFor(() => {
          expect(state.messages[0]?.info.id).toBe(olderPage[0]?.info.id);
        });
        await Promise.resolve();
      },
    };
  }

  it('keeps a pending history anchor after an upward wheel cannot move past the top boundary', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(0);

    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(200);
    harness.animationFrames.restore();
  });

  it('does not publish a cached history prepend inside the native scroll event', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('older-user'), parts: [textPart('older-user-text', 'Older prompt')] },
      {
        info: assistantMessage('older-assistant'),
        parts: [textPart('older-assistant-text', 'Older response')],
      },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const harness = await mountDeferredHistory(undefined, undefined, olderPage);
    cacheSessionHistoryPage('session-1', 'cursor-1', olderPage);
    harness.setScrollTop(100);
    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    harness.setScrollTop(0);
    harness.list.dispatchEvent(new Event('scroll'));

    expect(state.messages[0]?.info.id).toBe('current-user');
    await Promise.resolve();
    expect(state.messages[0]?.info.id).toBe('current-user');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(state.messages[0]?.info.id).toBe('older-user'));
    await harness.resolveLoad();
    harness.animationFrames.restore();
  });

  it('keeps the visible message fixed when a prepended activity group moves to an older owner', async () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
      function (this: HTMLElement) {
        if (!this.dataset.assistantRenderKey)
          // SAFETY: The fixture provides the unknown fields read by this statement.
          if (!this.dataset.assistantRenderKey) return fixture<DOMRectList>([]);
        // SAFETY: The fixture provides the unknown fields read by this statement.
        return fixture<DOMRectList>([this.getBoundingClientRect()]);
      }
    );
    const thought: Part = {
      id: 'current-thought',
      sessionID: 'session-1',
      messageID: 'current-assistant',
      type: 'reasoning',
      text: 'Current thought',
      time: { start: 3, end: 4 },
    };
    const command = toolPart('older-command', 'older-assistant', 'older-command-call');
    command.state = {
      status: 'completed',
      input: { command: 'npm test' },
      output: 'passed',
      title: 'npm test',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('shared-user'), parts: [textPart('shared-prompt', 'Inspect')] },
      {
        info: assistantMessage('older-assistant', { parentID: 'shared-user' }),
        parts: [command],
      },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const harness = await mountDeferredHistory(
      [
        {
          info: assistantMessage('current-assistant', { parentID: 'shared-user' }),
          parts: [thought],
        },
      ],
      undefined,
      olderPage
    );
    const currentRow = container?.querySelector<HTMLElement>('[data-msg-id="current-assistant"]');
    expect(
      container
        ?.querySelector('.assistant-activity-group')
        ?.closest('[data-msg-id]')
        ?.getAttribute('data-msg-id')
    ).toBe('current-assistant');

    await harness.startLoad(0);
    const topBefore = currentRow!.getBoundingClientRect().top;
    harness.releaseLoad();
    await harness.waitForPrepend();
    expect(currentRow!.getBoundingClientRect().top).toBe(topBefore);
    await harness.resolveLoad();

    expect(
      container
        ?.querySelector('.assistant-activity-group')
        ?.closest('[data-msg-id]')
        ?.getAttribute('data-msg-id')
    ).toBe('older-assistant');
    expect(currentRow!.getBoundingClientRect().top).toBe(topBefore);
    harness.animationFrames.restore();
  });

  it('keeps prepended rows lightweight while pinning a distant history anchor', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Shared fixtures are imported from the test-utils module.
    const buildMessages = (prefix: string) =>
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `${prefix}-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`${messageId}-text`, `\`\`\`ts\nconst value = ${index};\n\`\`\``),
              messageID: messageId,
            },
          ],
        };
      });
    const currentMessages = buildMessages('current');
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = buildMessages('older') as Awaited<ReturnType<typeof client.session.messages>>;
    let releasePage: ((page: typeof olderPage) => void) | undefined;
    vi.spyOn(client.session, 'messages').mockReturnValue(
      new Promise<typeof olderPage>((resolve) => {
        releasePage = resolve;
      })
    );
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollTopWrites = 0;
    let rowRectReads = 0;
    let hydratedRowRectReads = 0;
    let misreportVirtualPlaceholderHeight = false;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, -scrollTopValue, 500, state.messages.length * 100);
        }
        if (this.classList.contains('message-history-banner')) {
          return new DOMRect(0, 0, 500, 0);
        }
        if (this.dataset.msgId) {
          rowRectReads += 1;
          if (
            this.dataset.msgId === 'older-49' &&
            !this.classList.contains('interactive-item-virtual-placeholder')
          ) {
            hydratedRowRectReads += 1;
          }
          const index = state.messages.findIndex(
            (message) => message.info.id === this.dataset.msgId
          );
          const height =
            misreportVirtualPlaceholderHeight &&
            (this.dataset.msgId === 'older-30' || this.dataset.msgId === 'older-49') &&
            this.classList.contains('interactive-item-virtual-placeholder')
              ? 123
              : 100;
          return new DOMRect(0, index * 100 - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    replaceMessages(currentMessages);
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => state.messages.length * 100,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        scrollTopWrites += 1;
      },
    });

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    const normalOverscanRow = container?.querySelector<HTMLElement>('.interactive-item-off-core');
    expect(normalOverscanRow).toBeInstanceOf(HTMLDivElement);
    expect(normalOverscanRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(normalOverscanRow?.childElementCount).toBeGreaterThan(0);

    scrollTopValue = 20;
    scrollTopWrites = 0;
    rowRectReads = 0;
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    list.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(client.session.messages).toHaveBeenCalled());
    expect(rowRectReads).toBeLessThan(80);
    const anchor = container?.querySelector<HTMLElement>('[data-msg-id="current-0"]');
    const anchorTopBefore = anchor?.getBoundingClientRect().top;
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    let mountedRows = list.querySelectorAll('[data-msg-id]').length;
    let peakMountedRows = mountedRows;
    let sawPinnedGap = false;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Kept beside the observer it measures.
    const countRows = (node: Node) => {
      if (!(node instanceof Element)) return 0;
      return (
        (node.matches('[data-msg-id]') ? 1 : 0) + node.querySelectorAll('[data-msg-id]').length
      );
    };
    const mountObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) mountedRows -= countRows(node);
        for (const node of record.addedNodes) {
          mountedRows += countRows(node);
          peakMountedRows = Math.max(peakMountedRows, mountedRows);
          if (
            node instanceof Element &&
            (node.matches('.virtual-pinned-gap') || node.querySelector('.virtual-pinned-gap'))
          ) {
            sawPinnedGap = true;
          }
        }
      }
    });
    mountObserver.observe(list, { childList: true, subtree: true });
    misreportVirtualPlaceholderHeight = true;
    releasePage?.(olderPage);
    await vi.waitFor(() => expect(state.messages).toHaveLength(100));
    mountObserver.disconnect();
    expect(scrollTopWrites).toBeLessThan(30);
    expect(anchor?.isConnected).toBe(true);
    expect(anchor?.getBoundingClientRect().top).toBe(anchorTopBefore);

    expect(sawPinnedGap).toBe(true);
    expect(peakMountedRows).toBeLessThan(50);
    const offCoreRow = container?.querySelector<HTMLElement>('[data-msg-id="older-30"]');
    expect(offCoreRow?.classList).toContain('interactive-item-off-core');
    expect(offCoreRow?.childElementCount).toBe(0);
    const provisionalPlaceholderHeight = offCoreRow?.style.height;
    expect(provisionalPlaceholderHeight).toBe('160px');
    expect(container?.querySelector('[data-msg-id="current-0"]')?.classList).not.toContain(
      'interactive-item-off-core'
    );

    upsertPart({
      ...reasoningPart('older-30-reasoning', 'New reasoning'),
      messageID: 'older-30',
    });
    await Promise.resolve();
    await Promise.resolve();
    const forcedGapRow = container?.querySelector<HTMLElement>('[data-msg-id="older-30"]');
    expect(forcedGapRow).toBeInstanceOf(HTMLDivElement);
    expect(forcedGapRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(forcedGapRow?.childElementCount).toBeGreaterThan(0);

    const touchStart = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(touchStart, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchStart, 'isPrimary', { value: true });
    list.dispatchEvent(touchStart);
    scrollTopValue += 20;
    list.dispatchEvent(new Event('scroll'));
    for (let frame = 0; frame < 3; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    await vi.advanceTimersByTimeAsync(600);
    animationFrames.flush(performance.now());
    await Promise.resolve();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(50);

    scrollTopValue = 7_800;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush(performance.now());
    await Promise.resolve();
    const retainedRow = container?.querySelector<HTMLElement>('[data-msg-id="older-49"]');
    expect(retainedRow).toBeInstanceOf(HTMLDivElement);
    expect(retainedRow?.classList).toContain('interactive-item-virtual-placeholder');
    expect(retainedRow?.style.height).toBe(provisionalPlaceholderHeight);
    expect(retainedRow?.childElementCount).toBe(0);

    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    hydratedRowRectReads = 0;
    animationFrames.flush(performance.now());
    await Promise.resolve();
    const hydratedRow = container?.querySelector<HTMLElement>('[data-msg-id="older-49"]');
    expect(hydratedRow).toBeInstanceOf(HTMLDivElement);
    expect(hydratedRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(hydratedRow?.childElementCount).toBeGreaterThan(0);
    expect(hydratedRowRectReads).toBeGreaterThan(0);
    animationFrames.restore();
  });

  it('updates pending history ownership for inertial movement after touch release', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);

    const touchStart = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(touchStart, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchStart, 'isPrimary', { value: true });
    harness.list.dispatchEvent(touchStart);
    harness.setScrollTop(120);
    harness.list.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    harness.setScrollTop(160);
    harness.list.dispatchEvent(new Event('scroll'));
    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(360);
    harness.animationFrames.restore();
  });

  it('yields history settling to continued user movement after the prepend', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);

    harness.list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));
    harness.setScrollTop(120);
    harness.list.dispatchEvent(new Event('scroll'));
    harness.releaseLoad();
    await harness.waitForPrepend();
    expect(harness.getScrollTop()).toBe(320);

    // Native key scrolling and trackpad momentum can continue without another input event.
    harness.setScrollTop(240);
    harness.list.dispatchEvent(new Event('scroll'));
    for (let frame = 0; frame < 3; frame += 1) {
      await Promise.resolve();
      harness.animationFrames.flush();
    }

    expect(harness.getScrollTop()).toBe(240);
    harness.animationFrames.restore();
  });

  it.each([
    { name: 'ArrowUp', key: 'ArrowUp', shiftKey: false, nextTop: 0 },
    { name: 'PageUp', key: 'PageUp', shiftKey: false, nextTop: 0 },
    { name: 'Home', key: 'Home', shiftKey: false, nextTop: 0 },
    { name: 'Shift+Space', key: ' ', shiftKey: true, nextTop: 0 },
    { name: 'ArrowDown', key: 'ArrowDown', shiftKey: false, nextTop: 120 },
    { name: 'PageDown', key: 'PageDown', shiftKey: false, nextTop: 420 },
    { name: 'End', key: 'End', shiftKey: false, nextTop: 800 },
    { name: 'Space', key: ' ', shiftKey: false, nextTop: 420 },
  ])('transfers pending history ownership after $name movement', async (input) => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);
    vi.advanceTimersByTime(600);

    harness.list.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: input.key,
        shiftKey: input.shiftKey,
      })
    );
    harness.setScrollTop(input.nextTop);
    harness.list.dispatchEvent(new Event('scroll'));
    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(input.nextTop + 200);
    harness.animationFrames.restore();
  });

  it('transfers pending history ownership for an actual scroll after input is idle', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);
    vi.advanceTimersByTime(600);

    harness.setScrollTop(140);
    harness.list.dispatchEvent(new Event('scroll'));
    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(340);
    harness.animationFrames.restore();
  });

  it('transfers pending history ownership during a scrollbar pointer movement', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);
    vi.advanceTimersByTime(600);

    harness.list.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 })
    );
    harness.setScrollTop(140);
    harness.list.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(340);
    harness.animationFrames.restore();
  });

  it('transfers pending history ownership after an expansion correction', async () => {
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    class TestResizeObserver {
      readonly targets = new Set<Element>();

      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    let expansionOffset = 0;
    const harness = await mountDeferredHistory(
      [
        { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
        { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
        { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
        { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      ],
      (messageId) => (messageId === 'user-2' || messageId === 'assistant-2' ? expansionOffset : 0)
    );
    await harness.startLoad(20);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(harness.list) && observer.targets.has(track)
    );
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const expandedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const expansionControl = document.createElement('button');
    expansionControl.setAttribute('aria-expanded', 'false');
    expansionControl.getBoundingClientRect = () =>
      new DOMRect(0, 200 + expansionOffset - harness.getScrollTop(), 500, 20);
    expandedRow.append(expansionControl);
    expansionControl.click();

    expansionOffset = 100;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    harness.animationFrames.flush();
    await Promise.resolve();
    expect(harness.getScrollTop()).toBe(120);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const visibleRow = container?.querySelector('[data-msg-id="assistant-1"]') as HTMLDivElement;
    const visibleTopBefore =
      visibleRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;

    await harness.resolveLoad();

    const visibleTopAfter =
      visibleRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;
    expect(visibleTopAfter).toBe(visibleTopBefore);
    expect(harness.getScrollTop()).toBe(320);
    harness.animationFrames.restore();
  });

  it('yields expansion anchoring to direct outer wheel movement', async () => {
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    class TestResizeObserver {
      readonly targets = new Set<Element>();

      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    let expansionOffset = 0;
    const harness = await mountDeferredHistory(
      [
        { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
        { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
        { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
        { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      ],
      (messageId) => (messageId === 'user-2' || messageId === 'assistant-2' ? expansionOffset : 0)
    );
    await harness.startLoad(20);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(harness.list) && observer.targets.has(track)
    );
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const expandedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const expansionControl = document.createElement('button');
    expansionControl.setAttribute('aria-expanded', 'false');
    expansionControl.getBoundingClientRect = () =>
      new DOMRect(0, 200 + expansionOffset - harness.getScrollTop(), 500, 20);
    expandedRow.append(expansionControl);
    expansionControl.click();
    expansionOffset = 100;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    harness.animationFrames.flush();
    await Promise.resolve();
    expect(harness.getScrollTop()).toBe(120);

    expansionControl.click();
    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
    harness.setScrollTop(160);
    harness.list.dispatchEvent(new Event('scroll'));
    expansionOffset = 200;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    harness.animationFrames.flush();
    await Promise.resolve();

    expect(harness.getScrollTop()).toBe(160);
    await harness.resolveLoad();
    harness.animationFrames.restore();
  });

  it('transfers pending history anchoring to the edited row through a prepend', async () => {
    const harness = await mountDeferredHistory([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);
    await harness.startLoad(20);

    harness.setScrollTop(120);
    harness.list.dispatchEvent(new Event('scroll'));
    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    await Promise.resolve();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const editedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const editedTopBefore =
      editedRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;
    await harness.resolveLoad();

    const editedTopAfter =
      editedRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;
    expect(editedTopAfter).toBe(editedTopBefore);
    expect(harness.getScrollTop()).toBe(320);
    harness.animationFrames.restore();
  });

  it('permanently yields pending history restoration to an explicit bottom-follow request', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    harness.animationFrames.flush();
    await Promise.resolve();
    expect(harness.getScrollTop()).toBe(800);

    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(1000);
    harness.animationFrames.restore();
  });

  it('does not reuse a pending history load or anchor after switching A to B and back to A', async () => {
    const sessionOneMessages = [
      {
        info: userMessage('current-user'),
        parts: [textPart('current-user-text', 'Current prompt')],
      },
      {
        info: assistantMessage('current-assistant'),
        parts: [textPart('current-assistant-text', 'Current response')],
      },
    ];
    const harness = await mountDeferredHistory(sessionOneMessages);
    await harness.startLoad(20);

    setState('activeSessionId', 'session-2');
    replaceMessages([
      {
        info: { ...userMessage('session-2-user'), sessionID: 'session-2' },
        parts: [{ ...textPart('session-2-text', 'Session 2'), sessionID: 'session-2' }],
      },
    ]);
    await Promise.resolve();
    harness.animationFrames.flush();
    await Promise.resolve();

    setState('activeSessionId', 'session-1');
    replaceMessages(sessionOneMessages);
    await Promise.resolve();
    await Promise.resolve();
    harness.animationFrames.flush();
    await Promise.resolve();
    const staleLoadShown = container
      ?.querySelector('.message-history-banner')
      ?.classList.contains('is-loading');

    expect(harness.getScrollTop()).toBe(800);
    await harness.resolveLoad();

    expect(staleLoadShown).toBe(false);
    expect(harness.getScrollTop()).toBe(1000);
    harness.animationFrames.restore();
  });

  it('invalidates pending history state before a late response resolves after cleanup', async () => {
    const harness = await mountDeferredHistory();
    await harness.startLoad(20);

    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    await harness.resolveLoad();

    expect(harness.getScrollTop()).toBe(20);
    harness.animationFrames.restore();
  });

  it('preserves a DOM anchor when a history prepend crosses from 49 to 50 rows', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      {
        info: userMessage('older-boundary'),
        parts: [textPart('older-boundary-text', 'A taller older boundary row')],
      },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    let releasePage: ((page: typeof olderPage) => void) | undefined;
    const pendingPage = new Promise<typeof olderPage>((resolve) => {
      releasePage = resolve;
    });
    vi.spyOn(client.session, 'messages').mockReturnValue(pendingPage);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    const olderBoundaryId = olderPage[0]!.info.id;
    const olderLoaded = () => state.messages[0]?.info.id === olderBoundaryId;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, olderLoaded() ? 5200 : 4900);
        }
        if (this.dataset.msgId === 'older-boundary') {
          return new DOMRect(0, -scrollTopValue, 500, 300);
        }
        if (this.dataset.msgId?.startsWith('current-')) {
          const index = Number(this.dataset.msgId.replace('current-', ''));
          const documentTop = index * 100 + (olderLoaded() ? 300 : 0);
          return new DOMRect(0, documentTop - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-49');
    replaceMessages(
      Array.from({ length: 49 }, (_, index) => {
        const messageId = `current-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`${messageId}-text`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => (olderLoaded() ? 5400 : 4900),
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    scrollTopValue = 20;
    list.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-49',
      });
    });
    const anchorBefore = container
      ?.querySelector<HTMLElement>('[data-msg-id="current-0"]')
      ?.getBoundingClientRect().top;

    releasePage?.(olderPage);
    await vi.waitFor(() => expect(olderLoaded()).toBe(true));
    for (let frame = 0; frame < 3; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    await Promise.resolve();

    const anchorAfter = container
      ?.querySelector<HTMLElement>('[data-msg-id="current-0"]')
      ?.getBoundingClientRect().top;
    expect(anchorAfter).toBe(anchorBefore);
    expect(scrollTopValue).toBe(320);
    animationFrames.restore();
  });

  it('preserves image carousel selection through a history prepend', async () => {
    const currentMessageId = 'current-image-user';
    const current = {
      info: userMessage(currentMessageId),
      parts: [
        { ...filePart('image-1', 'Image 1'), messageID: currentMessageId },
        { ...filePart('image-2', 'Image 2'), messageID: currentMessageId },
      ],
    };
    setState('activeSessionId', 'session-1');
    setMessagesIncremental([current]);
    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const currentRow = () =>
      container?.querySelector<HTMLElement>(`[data-msg-id="${currentMessageId}"]`);
    expect(currentRow()?.textContent).toContain('1 / 2');
    currentRow()?.querySelector<HTMLButtonElement>('[aria-label="Next image"]')?.click();
    await Promise.resolve();
    expect(currentRow()?.textContent).toContain('2 / 2');

    setMessagesIncremental([
      {
        info: userMessage('older-user'),
        parts: [textPart('older-text', 'Older prompt')],
      },
      {
        info: { ...current.info },
        parts: current.parts.map((part) => ({ ...part })),
      },
    ]);
    await Promise.resolve();

    expect(currentRow()?.textContent).toContain('2 / 2');
  });

  it.each([
    { interaction: 'without later user interaction', userScrollTop: null, expectedScrollTop: 220 },
    {
      interaction: 'after the user scrolls while loading',
      userScrollTop: 120,
      expectedScrollTop: 320,
    },
  ])('anchors a history prepend $interaction', async ({ userScrollTop, expectedScrollTop }) => {
    const animationFrames = installQueuedAnimationFrameMocks();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('older-user'), parts: [textPart('older-user-text', 'Older prompt')] },
      {
        info: assistantMessage('older-assistant'),
        parts: [textPart('older-assistant-text', 'Older response')],
      },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    let releasePage: ((page: typeof olderPage) => void) | undefined;
    const pendingPage = new Promise<typeof olderPage>((resolve) => {
      releasePage = resolve;
    });
    vi.spyOn(client.session, 'messages').mockReturnValue(pendingPage);

    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, state.messages.length * 100);
        }
        if (this.dataset.msgId) {
          const index = state.messages.findIndex(
            (message) => message.info.id === this.dataset.msgId
          );
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    replaceMessages([
      {
        info: userMessage('current-user'),
        parts: [textPart('current-user-text', 'Current prompt')],
      },
      {
        info: assistantMessage('current-assistant'),
        parts: [textPart('current-assistant-text', 'Current response')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => 1200 + Math.max(0, state.messages.length - 2) * 100,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    scrollTopValue = 20;
    list.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-1',
      });
    });

    if (userScrollTop !== null) {
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
      scrollTopValue = userScrollTop;
      list.dispatchEvent(new Event('scroll'));
    }

    releasePage?.(olderPage);
    await vi.waitFor(() => {
      expect(state.messages[0]?.info.id).toBe('older-user');
    });
    animationFrames.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(scrollTopValue).toBe(expectedScrollTop);
    animationFrames.restore();
  });

  it('does not let one session pagination request lock another session', async () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keeping the page builder beside its one scenario makes pagination setup explicit.
    const pageFor = (sessionId: string, messageId: string) =>
      // SAFETY: The page contains the complete message and part fields read by pagination.
      [
        {
          info: { ...userMessage(messageId), sessionID: sessionId },
          parts: [{ ...textPart(`${messageId}-text`, 'Older prompt'), sessionID: sessionId }],
        },
      ] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseFirstPage: ((page: ReturnType<typeof pageFor>) => void) | undefined;
    const firstPage = new Promise<ReturnType<typeof pageFor>>((resolve) => {
      releaseFirstPage = resolve;
    });
    const messagesSpy = vi.spyOn(client.session, 'messages').mockImplementation((sessionId) => {
      if (sessionId === 'session-1') return firstPage;
      return Promise.resolve(pageFor('session-2', 'session-2-older'));
    });

    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    markSessionHistoryLoadFailed('session-1', true);
    replaceMessages([
      { info: userMessage('session-1-current'), parts: [textPart('session-1-text', 'Current')] },
    ]);
    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', { limit: 200, before: 'cursor-1' });
    });

    setSessionHistoryCursor('session-2', 'cursor-2');
    markSessionHistoryLoadFailed('session-2', true);
    setState('activeSessionId', 'session-2');
    replaceMessages([
      {
        info: { ...userMessage('session-2-current'), sessionID: 'session-2' },
        parts: [{ ...textPart('session-2-text', 'Current'), sessionID: 'session-2' }],
      },
    ]);
    await Promise.resolve();

    const secondRetry = container?.querySelector<HTMLButtonElement>(
      '.message-history-banner-retry'
    );
    const secondRetryEnabled = secondRetry?.disabled === false;
    secondRetry?.click();
    await vi.waitFor(() => {
      expect(messagesSpy.mock.calls.some(([sessionId]) => sessionId === 'session-2')).toBe(true);
    });
    const secondSessionRequested = messagesSpy.mock.calls.some(
      ([sessionId]) => sessionId === 'session-2'
    );

    releaseFirstPage?.(pageFor('session-1', 'session-1-older'));
    await Promise.resolve();

    expect(secondRetryEnabled).toBe(true);
    expect(secondSessionRequested).toBe(true);
  });

  it('loads truncated history from an upward wheel when the initial window cannot scroll', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('older-user'), parts: [textPart('older-text', 'Older prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValue(olderPage);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-older');
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 180 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    await Promise.resolve();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));

    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-older',
      });
    });
    expect(state.messages.map((message) => message.info.id)).toEqual([
      'older-user',
      'current-user',
    ]);
  });

  it('loads enough initial history to fill the viewport', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const firstPage = [
      { info: userMessage('older-user-1'), parts: [textPart('older-text-1', 'Older prompt 1')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    firstPage.nextCursor = 'cursor-oldest';
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const secondPage = [
      { info: userMessage('older-user-2'), parts: [textPart('older-text-2', 'Older prompt 2')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-older');
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => (state.messages.length < 3 ? 500 : 700),
    });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));

    expect(messagesSpy).toHaveBeenNthCalledWith(1, 'session-1', {
      limit: 200,
      before: 'cursor-older',
    });
    expect(messagesSpy).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-oldest',
    });
    await vi.waitFor(() => expect(list.scrollTop).toBe(200));
  });

  it('continues ordinary pagination when a page advances the cursor without adding rows', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const emptyPage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    emptyPage.nextCursor = 'cursor-next';
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('older-user'), parts: [textPart('older-text', 'Older prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce(olderPage);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-empty');
    markSessionHistoryLoadFailed('session-1', true);
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();

    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-next',
      });
    });
    expect(state.messages.map((message) => message.info.id)).toEqual([
      'older-user',
      'current-user',
    ]);
  });

  it('retries an invalidated history page while the same boundary remains current', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    stalePage.nextCursor = 'cursor-next';
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const freshPage = [
      { info: userMessage('older-user'), parts: [textPart('older-text', 'Older prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockReturnValueOnce(pendingStalePage)
      .mockResolvedValueOnce(freshPage);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    markSessionHistoryLoadFailed('session-1', true);
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));
    invalidateSessionMessageWindowRequests('session-1');
    releaseStalePage?.(stalePage);

    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));
    expect(state.messages.map((message) => message.info.id)).toEqual([
      'older-user',
      'current-user',
    ]);
  });

  it('does not retry an invalidated history page after its cursor boundary advances', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockReturnValueOnce(pendingStalePage)
      .mockResolvedValueOnce([]);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    markSessionHistoryLoadFailed('session-1', true);
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));

    invalidateSessionMessageWindowRequests('session-1');
    setSessionHistoryCursor('session-1', 'cursor-current');
    releaseStalePage?.(stalePage);
    await vi.advanceTimersByTimeAsync(0);

    expect(messagesSpy).toHaveBeenCalledTimes(1);
    expect(messagesSpy).not.toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-current',
    });
  });

  it('does not retry a stale history page against a replacement message window', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockReturnValueOnce(pendingStalePage)
      .mockResolvedValueOnce([]);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    markSessionHistoryLoadFailed('session-1', true);
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));

    resetSessionMessageWindowForRefetch('session-1');
    setSessionHistoryCursor('session-1', 'cursor-current');
    releaseStalePage?.(stalePage);
    await vi.advanceTimersByTimeAsync(0);

    expect(messagesSpy).toHaveBeenCalledTimes(1);
    expect(messagesSpy).not.toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-current',
    });
  });

  it('does not pin a stale history anchor after the same-session window resets', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    const messagesSpy = vi.spyOn(client.session, 'messages').mockReturnValue(pendingStalePage);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 6000);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 6000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 20;
    list.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-stale',
      });
    });

    resetSessionMessageWindowForRefetch('session-1');
    setSessionHistoryCursor('session-1', 'cursor-current');
    scrollTopValue = 5000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const renderedRows = [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')];
    releaseStalePage?.(stalePage);
    await vi.advanceTimersByTimeAsync(0);
    expect(renderedRows.length).toBeLessThan(40);
    expect(renderedRows[0]?.dataset.msgId).not.toBe('assistant-0');
    animationFrames.restore();
  });
});
