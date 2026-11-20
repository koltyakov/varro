import { flush as flushSolid, OBSERVE, untrack } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { render } from '@solidjs/web';
import {
  replaceMessages,
  removeMessage,
  requestMessageListScrollToBottom,
  setMessagesIncremental,
  setState,
  state,
  upsertMessageInfo,
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
  getErrorDetailsLayoutSignatures,
  getInlinePreviewLayoutSignatures,
  getMessageBlockBoundaryMap,
  sameMessageBlockBoundaries,
  getThinkingLayoutSignatures,
} from './message-list/row-layout';
import { startEditingMessage } from '../lib/message-edit-state';
import {
  cacheSessionHistoryPage,
  getSessionHistoryCursor,
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
  measureTranscriptRows,
  settleBottomFollow,
  reasoningPart,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';
import { fixture } from '../test-fixtures';
import { buildStopProcessPrompt } from '../lib/background-process-action';

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

  it('invalidates deferred file previews even when their bodies are unloaded', () => {
    const messages = [
      { info: { id: 'message-1' }, parts: [{ ...compactFileEdit, deferred: '/parts/edit' }] },
      {
        info: { id: 'message-3' },
        parts: [
          {
            ...compactFileEdit,
            deferred: '/parts/read',
            tool: 'read',
            state: {
              ...compactFileEdit.state,
              metadata: {},
            },
          },
        ],
      },
    ];
    const hidden = getInlinePreviewLayoutSignatures(messages, false);
    const shown = getInlinePreviewLayoutSignatures(messages, true);
    const ids = new Set(['message-1', 'message-3']);

    expect(getChangedInlinePreviewMessageIds(shown, hidden, ids)).toEqual(['message-1']);
    expect(getChangedInlinePreviewMessageIds(hidden, shown, ids)).toEqual(['message-1']);
    expect(getChangedInlinePreviewMessageIds(shown, shown, ids)).toEqual([]);
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

  it('invalidates a row when permission-linked activity enters the active tray', () => {
    const messages = [
      {
        info: { id: 'assistant-1', role: 'assistant' as const },
        parts: [activityPart],
      },
    ];

    expect(getCompactActivityLayoutSignatures(messages, () => 'permission:permission-1')).toEqual(
      new Map([['assistant-1', 'read-1:permission:permission-1']])
    );
    expect(getCompactActivityLayoutSignatures(messages, () => 'active')).toEqual(
      new Map([['assistant-1', 'read-1:active']])
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

describe('thinking virtualization signatures', () => {
  it('revises cached row geometry when thinking auto-expands', () => {
    const messages = [
      {
        info: { id: 'assistant-1', role: 'assistant' as const },
        parts: [reasoningPart('reasoning-1', 'Working')],
      },
    ];

    const collapsed = getThinkingLayoutSignatures(messages, true, new Set());
    const expanded = getThinkingLayoutSignatures(messages, true, new Set(['assistant-1']));

    expect(
      getChangedInlinePreviewMessageIds(collapsed, expanded, new Set(['assistant-1']))
    ).toEqual(['assistant-1']);
  });
});

describe('error-details virtualization signatures', () => {
  it('revises cached row geometry when error details expand', () => {
    const messages = [
      {
        info: { id: 'assistant-1', role: 'assistant' as const, error: { name: 'APIError' } },
      },
    ];

    const collapsed = getErrorDetailsLayoutSignatures(messages, new Set());
    const expanded = getErrorDetailsLayoutSignatures(messages, new Set(['assistant-1']));

    expect(
      getChangedInlinePreviewMessageIds(collapsed, expanded, new Set(['assistant-1']))
    ).toEqual(['assistant-1']);
  });
});

describe('bordered message projection', () => {
  it('keeps equivalent tail boundaries equal as prose streams but detects layout and membership changes', () => {
    const message = {
      info: assistantMessage('answer'),
      parts: [textPart('answer-text', 'Prose')],
    };
    const options = {
      expandedActivityGroup: () => false,
      renderEmptyMessageIds: new Set<string>(),
      showThinking: true,
    };
    const original = getMessageBlockBoundaryMap([message], new Map(), options);
    message.parts = [textPart('answer-text', 'Prose with more streamed text')];
    const streamed = getMessageBlockBoundaryMap([message], new Map(), options);
    expect(original.get('answer')).not.toBe(streamed.get('answer'));
    expect(sameMessageBlockBoundaries(original, streamed)).toBe(true);

    const empty = getMessageBlockBoundaryMap([message], new Map(), {
      ...options,
      renderEmptyMessageIds: new Set(['answer']),
    });
    expect(sameMessageBlockBoundaries(original, empty)).toBe(false);
    expect(sameMessageBlockBoundaries(original, new Map())).toBe(false);
    const boundary = original.get('answer')!;
    expect(sameMessageBlockBoundaries(original, new Map([['other', boundary]]))).toBe(false);
    for (const change of [
      { startsBordered: true },
      { endsBordered: true },
      { signature: 'changed' },
    ]) {
      expect(
        sameMessageBlockBoundaries(original, new Map([['answer', { ...boundary, ...change }]]))
      ).toBe(false);
    }
  });

  it('treats follow-up labels as unbordered action chrome without changing message or part identities', () => {
    const message = {
      info: { ...userMessage('followup'), followupTitle: 'Fix parser failures' },
      parts: [textPart('followup-text', 'Fix only the reported parser failures.')],
    };
    const boundaries = getMessageBlockBoundaryMap([message], new Map(), {
      expandedActivityGroup: () => false,
      renderEmptyMessageIds: new Set(),
      showThinking: true,
    });
    expect(boundaries.get('followup')).toEqual({
      startsBordered: false,
      endsBordered: false,
      signature: 'user:content:u:u',
    });
    expect(message.info.id).toBe('followup');
    expect(message.parts[0]?.id).toBe('followup-text');
    expect(message.parts[0]).toMatchObject({ text: 'Fix only the reported parser failures.' });
  });
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

  it('includes the summary margin after a bordered block in flow spacing', () => {
    const tray = { startsBordered: true, endsBordered: true };
    const summary = { startsBordered: false, endsBordered: false, startsSummary: true };

    // Removing a tray above its summary also removes the summary's 4 px margin. A collapse
    // reserve that omits it lets the browser clamp a bottom-pinned transcript backward.
    expect(getAssistantFlowSpacingSize([tray, summary], 8, 4)).toBe(12);
    expect(
      getAssistantFlowSpacingSize([tray, summary], 8, 4) -
        getAssistantFlowSpacingSize([summary], 8, 4)
    ).toBe(12);
    expect(getAssistantFlowSpacingSize([summary, tray], 8, 4)).toBe(8);
    expect(getAssistantFlowSpacingSize([tray, summary], 8)).toBe(8);
  });

  it('uses an unbordered layout boundary for compact stop-process actions', () => {
    const text = buildStopProcessPrompt({
      id: 'shell-1',
      status: 'running',
      command: 'npm test',
      cwd: '/repo',
      pid: 42,
      time: { started: 1 },
    });
    const messages: MessageEntry[] = [
      { info: userMessage('stop-1'), parts: [textPart('stop-text', text)] },
    ];
    const boundary = getMessageBlockBoundaryMap(messages, new Map(), {
      expandedActivityGroup: () => false,
      renderEmptyMessageIds: new Set(),
      showThinking: true,
    }).get('stop-1');
    expect(boundary).toEqual({
      startsBordered: false,
      endsBordered: false,
      signature: 'user:content:u:u',
    });
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

describe('removed virtual rows', () => {
  it('retains a mounted streaming entry until Solid disposes its removed row', async () => {
    const messageId = 'assistant-streaming';
    const part = { ...textPart('text-streaming', 'Initial response'), messageID: messageId };
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    replaceMessages([
      {
        info: assistantMessage(messageId, { time: { created: 1 } }),
        parts: [part],
      },
    ]);
    flushSolid();
    setState(storePath('streamingPartId', part.id));
    flushSolid();
    setState(storePath('streamingText', 'Streaming response'));
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector(`[data-msg-id="${messageId}"]`)).not.toBeNull();

    removeMessage('session-1', messageId);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.streamingPartId).toBeNull();
    expect(container?.querySelector(`[data-msg-id="${messageId}"]`)).toBeNull();
  });
});

describe('virtualized editing', () => {
  it('pins a distant edited row with full content in a bounded range', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 400);
      if (this.dataset.msgId) return new DOMRect(0, 0, 500, 100);
      return new DOMRect(0, 0, 500, 0);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => ({
        info: userMessage(`user-${index}`),
        parts: [textPart(`text-${index}`, `Prompt ${index}`)],
      }))
    );
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    expect(container?.querySelector('[data-msg-id="user-0"]')).toBeNull();

    startEditingMessage('user-0', 'session-1', 'Prompt 0');
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const editedRow = container?.querySelector<HTMLElement>('[data-msg-id="user-0"]');
    expect(editedRow).not.toBeNull();
    expect(editedRow?.classList).toContain('interactive-request-editing');
    expect(editedRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(editedRow?.querySelector('.inline-edit-composer-slot')).not.toBeNull();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);
  });

  it.each(['empty', 'rejected'] as const)(
    'releases a forced zero-height diff row when its %s request settles',
    async (outcome) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      flushSolid();
      let resolveDiff!: (value: Awaited<ReturnType<typeof client.session.diff>>) => void;
      let rejectDiff!: (reason: Error) => void;
      const pendingDiff = new Promise<Awaited<ReturnType<typeof client.session.diff>>>(
        (resolve, reject) => {
          resolveDiff = resolve;
          rejectDiff = reject;
        }
      );
      vi.spyOn(client.session, 'diff').mockReturnValue(pendingDiff);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 400);
        if (this.classList.contains('interactive-list-track')) {
          // Fake geometry reads the store like a measurement: untracked.
          const targetHasContent = untrack(() =>
            state.messages
              .find((message) => message.info.id === 'message-30')
              ?.parts.some((part) => part.type === 'text' && part.text.trim())
          );
          return new DOMRect(0, 0, 500, targetHasContent ? 6000 : 5900);
        }
        if (this.dataset.msgId) {
          // Fake geometry reads the store like a measurement: untracked.
          const targetHasContent = untrack(() =>
            state.messages
              .find((message) => message.info.id === 'message-30')
              ?.parts.some((part) => part.type === 'text' && part.text.trim())
          );
          return new DOMRect(
            0,
            0,
            500,
            this.dataset.msgId === 'message-30' && !targetHasContent ? 0 : 100
          );
        }
        return new DOMRect(0, 0, 500, 0);
      });
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      replaceMessages(
        Array.from({ length: 60 }, (_, index) => {
          const messageId = `message-${index}`;
          if (index === 30) {
            return {
              info: assistantMessage(messageId, {
                mode: 'subagent',
                time: { created: 1 },
              }),
              parts: [],
            };
          }
          return {
            info: userMessage(messageId),
            parts: [textPart(`text-${index}`, `Prompt ${index}`)],
          };
        })
      );
      flushSolid();
      cleanup = render(() => MessageList(), container!);
      flushSolid();
      const list = container!.querySelector<HTMLElement>('.interactive-list')!;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5900 });
      await measureTranscriptRows(list, animationFrames);
      flushSolid();
      // Keep the viewport at the head so editing the tail creates the pinned placeholder gap.
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      flushSolid();
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushSolid();
        animationFrames.flush();
        flushSolid();
      }

      // Measurement returns to the tail. Detach at the head so editing the last row
      // creates an inert pinned gap containing the zero-height assistant under test.
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -5900 }));
      flushSolid();
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
      await Promise.resolve();
      flushSolid();
      animationFrames.flush();
      flushSolid();
      expect(container?.querySelector('[data-msg-id="message-0"]')).not.toBeNull();
      expect(container?.querySelector('[data-msg-id="message-59"]')).toBeNull();
      expect(container?.querySelector('[data-msg-id="message-30"]')).toBeNull();
      startEditingMessage('message-59', 'session-1', 'Prompt 59');
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(container?.querySelector('[data-msg-id="message-59"]')).not.toBeNull();
      expect(container?.querySelector('.virtual-pinned-gap')).not.toBeNull();
      expect(container?.querySelector('[data-msg-id="message-30"]')).toBeNull();

      replaceMessages(
        state.messages.map((message) =>
          message.info.id === 'message-30'
            ? {
                ...message,
                info: assistantMessage('message-30', {
                  mode: 'subagent',
                  time: { created: 1, completed: 2 },
                }),
              }
            : message
        )
      );
      flushSolid();
      await Promise.resolve();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(client.session.diff).toHaveBeenCalledWith('session-1', 'message-30', {
        directory: undefined,
      });
      expect(container?.querySelector('[data-msg-id="message-30"]')).not.toBeNull();
      expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);

      if (outcome === 'empty') resolveDiff([]);
      else rejectDiff(new Error('Diff unavailable'));
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushSolid();
        animationFrames.flush();
        flushSolid();
      }

      expect(container?.querySelector('[data-msg-id="message-30"]')).toBeNull();
      expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);

      const track = container!.querySelector('.interactive-list-track')!;
      let futureContentMounted = false;
      const mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const row =
              node.dataset.msgId === 'message-30'
                ? node
                : node.querySelector('[data-msg-id="message-30"]');
            if (row?.textContent?.includes('Content appeared after the diff request settled')) {
              futureContentMounted = true;
            }
          }
        }
      });
      mutationObserver.observe(track, { childList: true, subtree: true });
      flushSolid();
      upsertPart({
        ...textPart('text-30', 'Content appeared after the diff request settled'),
        messageID: 'message-30',
      });
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushSolid();
        animationFrames.flush();
        flushSolid();
      }

      expect(container?.querySelector('[data-msg-id="message-59"]')).not.toBeNull();
      expect(futureContentMounted).toBe(true);
      expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);
      mutationObserver.disconnect();
      animationFrames.restore();
      flushSolid();
    }
  );

  it('keeps an older zero-height assistant unmounted when a newer assistant owns diff eligibility', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const pendingDiff = new Promise<Awaited<ReturnType<typeof client.session.diff>>>(() => {});
    const diffSpy = vi.spyOn(client.session, 'diff').mockReturnValue(pendingDiff);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 400);
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 5900);
      }
      if (this.dataset.msgId) {
        return new DOMRect(0, 0, 500, this.dataset.msgId === 'message-30' ? 0 : 100);
      }
      return new DOMRect(0, 0, 500, 0);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `message-${index}`;
        if (index === 30) {
          return {
            info: assistantMessage(messageId, {
              mode: 'subagent',
              time: { created: 1 },
            }),
            parts: [],
          };
        }
        if (index === 58) {
          return {
            info: assistantMessage(messageId, { time: { created: 3, completed: 4 } }),
            parts: [textPart(`text-${index}`, 'Newest response')],
          };
        }
        return {
          info: userMessage(messageId),
          parts: [textPart(`text-${index}`, `Prompt ${index}`)],
        };
      })
    );
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushSolid();
      animationFrames.flush();
      flushSolid();
    }

    expect(diffSpy).toHaveBeenCalledTimes(1);
    expect(diffSpy).toHaveBeenCalledWith('session-1', 'message-58', { directory: undefined });
    expect(container?.querySelector('[data-msg-id="message-30"]')).toBeNull();
    startEditingMessage('message-59', 'session-1', 'Prompt 59');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="message-59"]')).not.toBeNull();

    let olderAssistantMounted = false;
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (
            node.dataset.msgId === 'message-30' ||
            node.querySelector('[data-msg-id="message-30"]')
          ) {
            olderAssistantMounted = true;
          }
        }
      }
    });
    mutationObserver.observe(container!.querySelector('.interactive-list-track')!, {
      childList: true,
      subtree: true,
    });
    flushSolid();
    upsertMessageInfo(
      assistantMessage('message-30', {
        mode: 'subagent',
        time: { created: 1, completed: 2 },
      })
    );
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushSolid();
      animationFrames.flush();
      flushSolid();
    }

    expect(diffSpy).toHaveBeenCalledTimes(1);
    expect(olderAssistantMounted).toBe(false);
    expect(container?.querySelector('[data-msg-id="message-30"]')).toBeNull();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);
    mutationObserver.disconnect();
    animationFrames.restore();
    flushSolid();
  });
});

describe('retained row estimates', () => {
  it('keeps cold, reopened, appended, and explicitly reset windows bounded', async () => {
    const frames = installQueuedAnimationFrameMocks();
    flushSolid();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return new DOMRect(0, 0, 500, this.hasAttribute('data-msg-id') ? 100 : 400);
    });
    const messages = Array.from({ length: 60 }, (_, index) => {
      const id = `retained-${index}`;
      return {
        info: assistantMessage(id),
        parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: id }],
      };
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(messages);
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      flushSolid();
      frames.flush();
      flushSolid();
    }
    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    cleanup();
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);
    replaceMessages([
      ...messages,
      { info: assistantMessage('appended'), parts: [textPart('appended-text', 'New response')] },
    ]);
    flushSolid();
    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);
    cleanup();
    flushSolid();
    resetSessionMessageWindowForRefetch('session-1');
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(30);
    // Reset discards retained measurements, so the unseen prefix uses cold 160px estimates.
    const firstRow = container!.querySelector<HTMLElement>('[data-msg-id]')!;
    const firstIndex = Number(firstRow.dataset.msgId!.slice('retained-'.length));
    expect(container!.querySelector<HTMLElement>('.virtual-spacer-top')!.style.height).toBe(
      `${firstIndex * 160}px`
    );
    await Promise.resolve();
    flushSolid();
    frames.flush();
    flushSolid();
    frames.restore();
    flushSolid();
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

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === list || this.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, untrack(() => state.messages.length) * 100);
      }
      if (this.dataset.assistantRenderKey) {
        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        const index = state.messages.findIndex((message) => message.info.id === messageId);
        const documentTop = index * 100 + getMessageLayoutOffset(messageId || '');
        return new DOMRect(0, documentTop + 6 - scrollTopValue, 500, 40);
      }
      if (this.dataset.msgId) {
        const index = state.messages.findIndex((message) => message.info.id === this.dataset.msgId);
        const documentTop = index * 100 + getMessageLayoutOffset(this.dataset.msgId);
        return new DOMRect(0, documentTop - scrollTopValue, 500, 100);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    setSessionHistoryCursor('session-1', 'cursor-1');
    replaceMessages(initialMessages);
    flushSolid();
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
        flushSolid();
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
    flushSolid();
    await harness.startLoad(0);
    flushSolid();

    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    flushSolid();
    await harness.resolveLoad();
    flushSolid();

    expect(harness.getScrollTop()).toBe(200);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('bounds measurement work when history arrives after input becomes idle', async () => {
    const diagnostics = OBSERVE!.diagnostics.capture();
    onTestFinished(() => {
      diagnostics.stop();
    });
    const buildMessages = (prefix: string, messageCount: number) =>
      Array.from({ length: messageCount }, (_, index) => {
        const messageId = `${prefix}-${index}`;
        return {
          info: index % 2 === 0 ? userMessage(messageId) : assistantMessage(messageId),
          parts: [{ ...textPart(`${messageId}-text`, 'History row'), messageID: messageId }],
        };
      });
    // SAFETY: The fixture uses the complete SDK message/part shapes consumed by pagination.
    const olderPage = buildMessages('older', 200) as Awaited<
      ReturnType<typeof client.session.messages>
    >;
    const harness = await mountDeferredHistory(buildMessages('current', 200), undefined, olderPage);
    flushSolid();
    await harness.startLoad(0);
    flushSolid();
    // Slow page responses must still have one history owner, not a generic anchor per mounted row.
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    const rectSpy = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    rectSpy.mockClear();
    await harness.resolveLoad();
    flushSolid();

    expect(rectSpy.mock.calls.length).toBeLessThan(500);
    expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(80);
    expect(diagnostics.events.filter((event) => event.code === 'HUGE_FAN_IN')).toEqual([]);
    harness.animationFrames.restore();
    flushSolid();
  });

  it.each(['wheel', 'touch', 'scrollbar'] as const)(
    'bounds native scroll remount geometry with %s ownership',
    async (owner) => {
      const messages = Array.from({ length: 200 }, (_, index) => {
        const messageId = `current-${index}`;
        return {
          info: index % 2 === 0 ? userMessage(messageId) : assistantMessage(messageId),
          parts: [{ ...textPart(`${messageId}-text`, 'History row'), messageID: messageId }],
        };
      });
      let growth = 0;
      const harness = await mountDeferredHistory(messages, (messageId) => {
        const index = Number(messageId.slice('current-'.length));
        return Math.max(0, Math.min(10, index - 90)) * growth;
      });
      flushSolid();
      Object.defineProperty(harness.list, 'scrollHeight', { configurable: true, value: 20_000 });
      await measureTranscriptRows(harness.list, harness.animationFrames);
      flushSolid();
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushSolid();
        harness.animationFrames.flush();
        flushSolid();
      }
      expect(container?.querySelector('.interactive-list-track.virtualized')).not.toBeNull();
      expect(container?.querySelector('[data-msg-id="current-100"]')).toBeNull();
      if (owner !== 'wheel') {
        const pointer = new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 499,
        });
        Object.defineProperty(pointer, 'pointerType', {
          value: owner === 'touch' ? 'touch' : 'mouse',
        });
        harness.list.dispatchEvent(pointer);
        flushSolid();
      }
      flushSolid();
      harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -10_000 }));
      flushSolid();
      harness.setScrollTop(10_000);
      flushSolid();
      const rectSpy = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
      const originalRect = rectSpy.getMockImplementation()!;
      const mutations = new MutationObserver(() => {});
      mutations.observe(harness.list, { childList: true, subtree: true, attributes: true });
      flushSolid();
      const measuredRows = new Set<string>();
      let interleavedWrites = 0;
      rectSpy.mockImplementation(function (this: HTMLElement) {
        if (this.dataset.msgId && !measuredRows.has(this.dataset.msgId)) {
          const writes = mutations.takeRecords();
          if (measuredRows.size && writes.length) interleavedWrites += 1;
          measuredRows.add(this.dataset.msgId);
        }
        const rect = originalRect.call(this);
        const index = Number(this.dataset.msgId?.slice('current-'.length));
        return index >= 90 && index < 100
          ? new DOMRect(rect.x, rect.y, rect.width, rect.height + growth)
          : rect;
      });
      growth = 30;
      rectSpy.mockClear();
      harness.list.dispatchEvent(new Event('scroll'));
      flushSolid();

      expect(container?.querySelector('[data-msg-id="current-100"]')).not.toBeNull();
      expect(rectSpy.mock.calls.length).toBeLessThan(150);
      mutations.disconnect();
      // Allow anchor capture and a correction-driven range update, not a write/read per row.
      expect(interleavedWrites).toBeLessThanOrEqual(4);
      const destination = harness.getScrollTop();
      if (owner === 'scrollbar') {
        // Chromium retains the native thumb's destination. A JS prefix correction competes
        // with that destination and is reversed by the next native scrollbar reconciliation.
        expect(destination).toBe(10_000);
      } else {
        expect(destination).toBeGreaterThan(10_000);
      }
      const marker = container!.querySelector('[data-msg-id="current-100"]')!;
      const markerTop = marker.getBoundingClientRect().top;
      for (let frame = 0; frame < 4; frame += 1) {
        await Promise.resolve();
        flushSolid();
        harness.animationFrames.flush();
        flushSolid();
      }
      expect(harness.getScrollTop()).toBe(destination);
      expect(marker.isConnected).toBe(true);
      expect(marker.getBoundingClientRect().top).toBe(markerTop);
      expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
      if (owner !== 'wheel') document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      flushSolid();
      harness.animationFrames.restore();
      flushSolid();
    }
  );

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
    flushSolid();
    cacheSessionHistoryPage('session-1', 'cursor-1', olderPage);
    harness.setScrollTop(100);
    flushSolid();
    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    flushSolid();
    harness.setScrollTop(0);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();

    expect(state.messages[0]?.info.id).toBe('current-user');
    await Promise.resolve();
    flushSolid();
    expect(state.messages[0]?.info.id).toBe('current-user');
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    await vi.waitFor(() => expect(state.messages[0]?.info.id).toBe('older-user'));
    flushSolid();
    await harness.resolveLoad();
    flushSolid();
    harness.animationFrames.restore();
    flushSolid();
  });

  it('keeps the visible message fixed when a prepended activity group moves to an older owner', async () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
      this: HTMLElement
    ) {
      if (!this.dataset.assistantRenderKey)
        // SAFETY: The fixture provides the unknown fields read by this statement.
        if (!this.dataset.assistantRenderKey) return fixture<DOMRectList>([]);
      // SAFETY: The fixture provides the unknown fields read by this statement.
      return fixture<DOMRectList>([this.getBoundingClientRect()]);
    });
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
    flushSolid();
    const currentRow = container?.querySelector<HTMLElement>('[data-msg-id="current-assistant"]');
    expect(
      container
        ?.querySelector('.assistant-activity-group')
        ?.closest('[data-msg-id]')
        ?.getAttribute('data-msg-id')
    ).toBe('current-assistant');
    flushSolid();

    await harness.startLoad(0);
    flushSolid();
    const topBefore = currentRow!.getBoundingClientRect().top;
    harness.releaseLoad();
    await harness.waitForPrepend();
    flushSolid();
    expect(currentRow!.getBoundingClientRect().top).toBe(topBefore);
    await harness.resolveLoad();
    flushSolid();

    expect(
      container
        ?.querySelector('.assistant-activity-group')
        ?.closest('[data-msg-id]')
        ?.getAttribute('data-msg-id')
    ).toBe('older-assistant');
    flushSolid();
    expect(currentRow!.getBoundingClientRect().top).toBe(topBefore);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('keeps prepended rows lightweight while pinning a distant history anchor', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
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

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
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
        const index = state.messages.findIndex((message) => message.info.id === this.dataset.msgId);
        const height =
          misreportVirtualPlaceholderHeight &&
          (this.dataset.msgId === 'older-30' || this.dataset.msgId === 'older-49') &&
          this.classList.contains('interactive-item-virtual-placeholder')
            ? 123
            : 100;
        return new DOMRect(0, index * 100 - scrollTopValue, 500, height);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-1');
    flushSolid();
    replaceMessages(currentMessages);
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
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
      flushSolid();
      animationFrames.flush();
      flushSolid();
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
    flushSolid();
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await vi.waitFor(() => expect(client.session.messages).toHaveBeenCalled());
    flushSolid();
    expect(rowRectReads).toBeLessThan(80);
    const anchor = container?.querySelector<HTMLElement>('[data-msg-id="current-0"]');
    const anchorTopBefore = anchor?.getBoundingClientRect().top;
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    let mountedRows = list.querySelectorAll('[data-msg-id]').length;
    let peakMountedRows = mountedRows;
    let sawPinnedGap = false;
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
    flushSolid();
    misreportVirtualPlaceholderHeight = true;
    releasePage?.(olderPage);
    await vi.waitFor(() => expect(state.messages).toHaveLength(100));
    flushSolid();
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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const forcedGapRow = container?.querySelector<HTMLElement>('[data-msg-id="older-30"]');
    expect(forcedGapRow).toBeInstanceOf(HTMLDivElement);
    expect(forcedGapRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(forcedGapRow?.childElementCount).toBeGreaterThan(0);

    const touchStart = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(touchStart, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchStart, 'isPrimary', { value: true });
    list.dispatchEvent(touchStart);
    flushSolid();
    scrollTopValue += 20;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    for (let frame = 0; frame < 3; frame += 1) {
      await Promise.resolve();
      flushSolid();
      animationFrames.flush();
      flushSolid();
    }
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    animationFrames.flush(performance.now());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(50);

    scrollTopValue = 7_800;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    animationFrames.flush(performance.now());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const retainedRow = container?.querySelector<HTMLElement>('[data-msg-id="older-49"]');
    expect(retainedRow).toBeInstanceOf(HTMLDivElement);
    expect(retainedRow?.classList).toContain('interactive-item-virtual-placeholder');
    expect(retainedRow?.style.height).toBe(provisionalPlaceholderHeight);
    expect(retainedRow?.childElementCount).toBe(0);

    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
    hydratedRowRectReads = 0;
    animationFrames.flush(performance.now());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    // Hydration registers a mount measurement, then the list batches it before the next paint.
    await Promise.resolve();
    flushSolid();
    const hydratedRow = container?.querySelector<HTMLElement>('[data-msg-id="older-49"]');
    expect(hydratedRow).toBeInstanceOf(HTMLDivElement);
    expect(hydratedRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(hydratedRow?.childElementCount).toBeGreaterThan(0);
    expect(hydratedRowRectReads).toBeGreaterThan(0);
    animationFrames.restore();
    flushSolid();
  });

  it('updates pending history ownership for inertial movement after touch release', async () => {
    const harness = await mountDeferredHistory();
    flushSolid();
    await harness.startLoad(20);
    flushSolid();

    const touchStart = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(touchStart, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchStart, 'isPrimary', { value: true });
    harness.list.dispatchEvent(touchStart);
    flushSolid();
    harness.setScrollTop(120);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    flushSolid();

    harness.setScrollTop(160);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await harness.resolveLoad();
    flushSolid();

    expect(harness.getScrollTop()).toBe(360);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('yields history settling to continued user movement after the prepend', async () => {
    const harness = await mountDeferredHistory();
    flushSolid();
    await harness.startLoad(20);
    flushSolid();

    harness.list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));
    flushSolid();
    harness.setScrollTop(120);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    harness.releaseLoad();
    await harness.waitForPrepend();
    flushSolid();
    expect(harness.getScrollTop()).toBe(320);

    // Native key scrolling and trackpad momentum can continue without another input event.
    harness.setScrollTop(240);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    for (let frame = 0; frame < 3; frame += 1) {
      await Promise.resolve();
      flushSolid();
      harness.animationFrames.flush();
      flushSolid();
    }

    expect(harness.getScrollTop()).toBe(240);
    harness.animationFrames.restore();
    flushSolid();
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
    flushSolid();
    await harness.startLoad(20);
    flushSolid();
    vi.advanceTimersByTime(600);
    flushSolid();

    harness.list.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: input.key,
        shiftKey: input.shiftKey,
      })
    );
    flushSolid();
    harness.setScrollTop(input.nextTop);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await harness.resolveLoad();
    flushSolid();

    expect(harness.getScrollTop()).toBe(input.nextTop + 200);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('transfers pending history ownership for an actual scroll after input is idle', async () => {
    const harness = await mountDeferredHistory();
    flushSolid();
    await harness.startLoad(20);
    flushSolid();
    vi.advanceTimersByTime(600);
    flushSolid();

    harness.setScrollTop(140);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await harness.resolveLoad();
    flushSolid();

    expect(harness.getScrollTop()).toBe(340);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('transfers pending history ownership during a scrollbar pointer movement', async () => {
    const harness = await mountDeferredHistory();
    flushSolid();
    await harness.startLoad(20);
    flushSolid();
    vi.advanceTimersByTime(600);
    flushSolid();

    harness.list.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 })
    );
    flushSolid();
    harness.setScrollTop(140);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    flushSolid();
    await harness.resolveLoad();
    flushSolid();

    expect(harness.getScrollTop()).toBe(340);
    harness.animationFrames.restore();
    flushSolid();
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
    flushSolid();
    await harness.startLoad(20);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(harness.list) && observer.targets.has(track)
    );
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const expandedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const expansionControl = document.createElement('button');
    expansionControl.setAttribute('aria-expanded', 'false');
    flushSolid();
    expansionControl.getBoundingClientRect = () =>
      new DOMRect(0, 200 + expansionOffset - harness.getScrollTop(), 500, 20);
    expandedRow.append(expansionControl);
    expansionControl.click();
    flushSolid();

    expansionOffset = 100;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    harness.animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(harness.getScrollTop()).toBe(120);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const visibleRow = container?.querySelector('[data-msg-id="assistant-1"]') as HTMLDivElement;
    const visibleTopBefore =
      visibleRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;

    await harness.resolveLoad();
    flushSolid();

    const visibleTopAfter =
      visibleRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;
    expect(visibleTopAfter).toBe(visibleTopBefore);
    expect(harness.getScrollTop()).toBe(320);
    harness.animationFrames.restore();
    flushSolid();
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
    flushSolid();
    await harness.startLoad(20);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(harness.list) && observer.targets.has(track)
    );
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const expandedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const expansionControl = document.createElement('button');
    expansionControl.setAttribute('aria-expanded', 'false');
    flushSolid();
    expansionControl.getBoundingClientRect = () =>
      new DOMRect(0, 200 + expansionOffset - harness.getScrollTop(), 500, 20);
    expandedRow.append(expansionControl);
    expansionControl.click();
    flushSolid();
    expansionOffset = 100;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    harness.animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(harness.getScrollTop()).toBe(120);

    expansionControl.click();
    flushSolid();
    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
    flushSolid();
    harness.setScrollTop(160);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    expansionOffset = 200;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    layoutObserver!.callback(
      [fixture<ResizeObserverEntry>({ target: track })],
      fixture<ResizeObserver>(layoutObserver)
    );
    harness.animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(harness.getScrollTop()).toBe(160);
    await harness.resolveLoad();
    flushSolid();
    harness.animationFrames.restore();
    flushSolid();
  });

  it('transfers pending history anchoring to the edited row through a prepend', async () => {
    const harness = await mountDeferredHistory([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);
    flushSolid();
    await harness.startLoad(20);
    flushSolid();

    harness.setScrollTop(120);
    flushSolid();
    harness.list.dispatchEvent(new Event('scroll'));
    flushSolid();
    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const editedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const editedTopBefore =
      editedRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;
    await harness.resolveLoad();
    flushSolid();

    const editedTopAfter =
      editedRow.getBoundingClientRect().top - harness.list.getBoundingClientRect().top;
    expect(editedTopAfter).toBe(editedTopBefore);
    expect(harness.getScrollTop()).toBe(320);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('permanently yields pending history restoration to an explicit bottom-follow request', async () => {
    const harness = await mountDeferredHistory();
    flushSolid();
    // Finish initial positioning so the explicit return exercises detached navigation.
    settleBottomFollow(harness.animationFrames, harness.list);
    flushSolid();
    harness.animationFrames.flush();
    flushSolid();
    await harness.startLoad(20);
    flushSolid();

    requestMessageListScrollToBottom();
    await Promise.resolve();
    flushSolid();
    expect(harness.getScrollTop()).toBe(800);
    harness.animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    settleBottomFollow(harness.animationFrames, harness.list);
    flushSolid();
    expect(harness.getScrollTop()).toBe(800);

    await harness.resolveLoad();
    flushSolid();

    settleBottomFollow(harness.animationFrames, harness.list);
    flushSolid();
    expect(harness.getScrollTop()).toBe(1000);
    harness.animationFrames.restore();
    flushSolid();
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
    flushSolid();
    await harness.startLoad(20);
    flushSolid();

    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    replaceMessages([
      {
        info: { ...userMessage('session-2-user'), sessionID: 'session-2' },
        parts: [{ ...textPart('session-2-text', 'Session 2'), sessionID: 'session-2' }],
      },
    ]);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    harness.animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    replaceMessages(sessionOneMessages);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    harness.animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const staleLoadShown = container
      ?.querySelector('.message-history-banner')
      ?.classList.contains('is-loading');

    expect(harness.getScrollTop()).toBe(800);
    await harness.resolveLoad();
    flushSolid();

    expect(staleLoadShown).toBe(false);
    settleBottomFollow(harness.animationFrames, harness.list);
    flushSolid();
    expect(harness.getScrollTop()).toBe(1000);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('invalidates pending history state before a late response resolves after cleanup', async () => {
    const observers: MutationObserver[] = [];
    vi.spyOn(globalThis, 'MutationObserver').mockImplementation(function TestMutationObserver() {
      const observer = fixture<MutationObserver>({
        disconnect: vi.fn(),
        observe: vi.fn(),
        takeRecords: () => [],
      });
      observers.push(observer);
      return observer;
    });
    const harness = await mountDeferredHistory();
    flushSolid();
    await harness.startLoad(20);
    flushSolid();
    const historyObserver = observers.at(-1);

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    await Promise.resolve();
    flushSolid();

    expect(historyObserver?.disconnect).toHaveBeenCalledOnce();
    await harness.resolveLoad();
    flushSolid();

    expect(harness.getScrollTop()).toBe(20);
    harness.animationFrames.restore();
    flushSolid();
  });

  it('preserves a DOM anchor when a history prepend crosses from 49 to 50 rows', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
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

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
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
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-49');
    flushSolid();
    replaceMessages(
      Array.from({ length: 49 }, (_, index) => {
        const messageId = `current-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`${messageId}-text`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    flushSolid();
    scrollTopValue = 20;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-49',
      });
    });
    flushSolid();
    const anchorBefore = container
      ?.querySelector<HTMLElement>('[data-msg-id="current-0"]')
      ?.getBoundingClientRect().top;

    releasePage?.(olderPage);
    await vi.waitFor(() => expect(olderLoaded()).toBe(true));
    flushSolid();
    for (let frame = 0; frame < 3; frame += 1) {
      await Promise.resolve();
      flushSolid();
      animationFrames.flush();
      flushSolid();
    }
    await Promise.resolve();
    flushSolid();

    const anchorAfter = container
      ?.querySelector<HTMLElement>('[data-msg-id="current-0"]')
      ?.getBoundingClientRect().top;
    expect(anchorAfter).toBe(anchorBefore);
    expect(scrollTopValue).toBe(320);
    animationFrames.restore();
    flushSolid();
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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setMessagesIncremental([current]);
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const currentRow = () =>
      container?.querySelector<HTMLElement>(`[data-msg-id="${currentMessageId}"]`);
    const originalRow = currentRow();
    expect(currentRow()?.textContent).toContain('1 / 2');
    currentRow()?.querySelector<HTMLButtonElement>('[aria-label="Next image"]')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(currentRow()?.textContent).toContain('2 / 2');

    setMessagesIncremental([
      {
        info: userMessage('older-user'),
        parts: [textPart('older-text', 'Older prompt')],
      },
      {
        info: { ...current.info },
        parts: [
          ...current.parts.map((part) => ({ ...part })),
          { ...filePart('image-3', 'Image 3'), messageID: currentMessageId },
        ],
      },
    ]);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(currentRow()).toBe(originalRow);
    expect(currentRow()?.textContent).toContain('2 / 3');
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
    flushSolid();
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === list || this.classList.contains('interactive-list')) {
        return new DOMRect(0, 0, 500, 400);
      }
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, untrack(() => state.messages.length) * 100);
      }
      if (this.dataset.msgId) {
        const index = state.messages.findIndex((message) => message.info.id === this.dataset.msgId);
        return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
      }
      return new DOMRect(0, 0, 500, 40);
    });

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-1');
    flushSolid();
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
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    flushSolid();
    scrollTopValue = 20;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-1',
      });
    });
    flushSolid();

    if (userScrollTop !== null) {
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
      flushSolid();
      scrollTopValue = userScrollTop;
      list.dispatchEvent(new Event('scroll'));
      flushSolid();
    }
    flushSolid();

    releasePage?.(olderPage);
    await vi.waitFor(() => {
      expect(state.messages[0]?.info.id).toBe('older-user');
    });
    flushSolid();
    animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(scrollTopValue).toBe(expectedScrollTop);
    animationFrames.restore();
    flushSolid();
  });

  it('does not let one session pagination request lock another session', async () => {
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

    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-1');
    flushSolid();
    markSessionHistoryLoadFailed('session-1', true);
    flushSolid();
    replaceMessages([
      { info: userMessage('session-1-current'), parts: [textPart('session-1-text', 'Current')] },
    ]);
    flushSolid();
    cleanup = render(() => MessageList(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    flushSolid();
    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', { limit: 200, before: 'cursor-1' });
    });
    flushSolid();

    setSessionHistoryCursor('session-2', 'cursor-2');
    flushSolid();
    markSessionHistoryLoadFailed('session-2', true);
    flushSolid();
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    replaceMessages([
      {
        info: { ...userMessage('session-2-current'), sessionID: 'session-2' },
        parts: [{ ...textPart('session-2-text', 'Current'), sessionID: 'session-2' }],
      },
    ]);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const secondRetry = container?.querySelector<HTMLButtonElement>(
      '.message-history-banner-retry'
    );
    const secondRetryEnabled = secondRetry?.disabled === false;
    secondRetry?.click();
    flushSolid();
    await vi.waitFor(() => {
      expect(messagesSpy.mock.calls.some(([sessionId]) => sessionId === 'session-2')).toBe(true);
    });
    flushSolid();
    const secondSessionRequested = messagesSpy.mock.calls.some(
      ([sessionId]) => sessionId === 'session-2'
    );

    releaseFirstPage?.(pageFor('session-1', 'session-1-older'));
    await Promise.resolve();
    flushSolid();

    expect(secondRetryEnabled).toBe(true);
    expect(secondSessionRequested).toBe(true);
  });

  it('loads truncated history from an upward wheel when the initial window cannot scroll', async () => {
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const olderPage = [
      { info: userMessage('older-user'), parts: [textPart('older-text', 'Older prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValue(olderPage);
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 180 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    await Promise.resolve();
    flushSolid();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    flushSolid();

    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-older',
      });
    });
    flushSolid();
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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => (state.messages.length < 3 ? 500 : 700),
    });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));
    flushSolid();

    expect(messagesSpy).toHaveBeenNthCalledWith(1, 'session-1', {
      limit: 200,
      before: 'cursor-older',
    });
    expect(messagesSpy).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-oldest',
    });
    await vi.waitFor(() => expect(list.scrollTop).toBe(200));
    flushSolid();
  });

  it('does not treat provisional virtual overflow as a filled initial viewport', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    const currentMessages = Array.from({ length: 60 }, (_, index) => ({
      info: userMessage(`current-user-${index}`),
      parts: [textPart(`current-text-${index}`, `Current prompt ${index}`)],
    }));
    // SAFETY: The fixtures provide the complete domain shape read by this statement.
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      info: userMessage(`older-user-${index}`),
      parts: [textPart(`older-text-${index}`, `Older prompt ${index}`)],
    })) as Awaited<ReturnType<typeof client.session.messages>>;
    firstPage.nextCursor = 'cursor-oldest';
    // SAFETY: The fixtures provide the complete domain shape read by this statement.
    const secondPage = [
      { info: userMessage('oldest-user'), parts: [textPart('oldest-text', 'Oldest prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.msgId) return new DOMRect(0, 0, 500, 1);
      if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
      return new DOMRect(0, 0, 500, 60);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-older');
    flushSolid();
    replaceMessages(currentMessages);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages.length === currentMessages.length ? 60 : state.messages.length * 160,
    });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

    for (let frame = 0; frame < 120; frame += 1) {
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      animationFrames.flush(performance.now());
      flushSolid();
      if (
        messagesSpy.mock.calls.length === 2 &&
        container!.querySelectorAll('[data-msg-id]').length < 50
      )
        break;
    }
    expect(messagesSpy).toHaveBeenCalledTimes(2);

    expect(messagesSpy).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-oldest',
    });
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(50);
    animationFrames.restore();
    flushSolid();
  });

  it('stops initial fill when one hydrated page exactly fills the viewport', async () => {
    const currentMessages = Array.from({ length: 60 }, (_, index) => ({
      info: userMessage(`current-user-${index}`),
      parts: [textPart(`current-text-${index}`, `Current prompt ${index}`)],
    }));
    // SAFETY: The page fixture provides the complete domain shape consumed by history loading.
    // Its rows are exactly 500px and fit in one bounded hydration batch.
    const fillingPage = Array.from({ length: 13 }, (_, index) => ({
      info: userMessage(`filling-user-${index}`),
      parts: [textPart(`filling-text-${index}`, `Filling prompt ${index}`)],
    })) as Awaited<ReturnType<typeof client.session.messages>>;
    fillingPage.nextCursor = 'cursor-must-not-load';
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValueOnce(fillingPage);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.msgId) {
        const height = this.dataset.msgId.startsWith('filling-user-12')
          ? 20
          : this.dataset.msgId.startsWith('filling-user-')
            ? 40
            : 1;
        return new DOMRect(0, 0, 500, height);
      }
      if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
      return new DOMRect(0, 0, 500, 60);
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-filling');
    flushSolid();
    replaceMessages(currentMessages);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => (state.messages.length === currentMessages.length ? 60 : 11_360),
    });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalled());
    flushSolid();
    await vi.waitFor(() =>
      expect(
        container?.querySelector('.message-history-banner')?.classList.contains('is-loading')
      ).toBe(false)
    );
    flushSolid();

    expect(messagesSpy).toHaveBeenCalledOnce();
    expect(messagesSpy).not.toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-must-not-load',
    });
    expect(getSessionHistoryCursor('session-1')).toBe('cursor-must-not-load');
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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-empty');
    flushSolid();
    markSessionHistoryLoadFailed('session-1', true);
    flushSolid();
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    flushSolid();

    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-next',
      });
    });
    flushSolid();
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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-stale');
    flushSolid();
    markSessionHistoryLoadFailed('session-1', true);
    flushSolid();
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    flushSolid();
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));
    flushSolid();
    invalidateSessionMessageWindowRequests('session-1');
    releaseStalePage?.(stalePage);

    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));
    flushSolid();
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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-stale');
    flushSolid();
    markSessionHistoryLoadFailed('session-1', true);
    flushSolid();
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    flushSolid();
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));
    flushSolid();

    invalidateSessionMessageWindowRequests('session-1');
    setSessionHistoryCursor('session-1', 'cursor-current');
    flushSolid();
    releaseStalePage?.(stalePage);
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();

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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-stale');
    flushSolid();
    markSessionHistoryLoadFailed('session-1', true);
    flushSolid();
    replaceMessages([
      { info: userMessage('current-user'), parts: [textPart('current-text', 'Current prompt')] },
    ]);
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
    container?.querySelector<HTMLButtonElement>('.message-history-banner-retry')?.click();
    flushSolid();
    await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));
    flushSolid();

    resetSessionMessageWindowForRefetch('session-1');
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-current');
    flushSolid();
    releaseStalePage?.(stalePage);
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();

    expect(messagesSpy).toHaveBeenCalledTimes(1);
    expect(messagesSpy).not.toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-current',
    });
  });

  it('does not pin a stale history anchor after the same-session window resets', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    flushSolid();
    // SAFETY: The fixture provides the complete domain shape read by this statement.
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    const messagesSpy = vi.spyOn(client.session, 'messages').mockReturnValue(pendingStalePage);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
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
    });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-stale');
    flushSolid();
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    flushSolid();

    cleanup = render(() => MessageList(), container!);
    flushSolid();
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
      flushSolid();
      animationFrames.flush();
      flushSolid();
    }

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    flushSolid();
    scrollTopValue = 20;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await vi.waitFor(() => {
      expect(messagesSpy).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-stale',
      });
    });
    flushSolid();

    resetSessionMessageWindowForRefetch('session-1');
    flushSolid();
    setSessionHistoryCursor('session-1', 'cursor-current');
    flushSolid();
    scrollTopValue = 5000;
    list.dispatchEvent(new Event('scroll'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    animationFrames.flush();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const renderedRows = [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')];
    releaseStalePage?.(stalePage);
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    expect(renderedRows.length).toBeLessThan(40);
    expect(renderedRows[0]?.dataset.msgId).not.toBe('assistant-0');
    animationFrames.restore();
    flushSolid();
  });
});
