import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batch } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setMessagesIncremental,
  state,
  setSessions,
  setShowInlineFileChanges,
  setShowModelPicker,
  setShowThinkingPreference,
  setState,
  skipPlanSession,
  startLoading,
  stopLoading,
  upsertPart,
} from '../lib/state';
import type {
  AssistantMessage,
  FilePart,
  Message,
  MessageEntry,
  Part,
  Permission,
  QuestionRequest,
  Session,
  TextPart,
  ToolPart,
  UserMessage,
} from '../types';
import type { AssistantActivityGroupInfo } from '../lib/assistant-activity';
import { MessageList, getNewlyAppendedMessageIds, getPromptNumberMap } from './MessageList';
import {
  getChangedInlinePreviewMessageIds,
  getCompactActivityDisclosureLayoutSignatures,
  getCompactActivityLayoutSignatures,
  getInlinePreviewLayoutSignatures,
  getRenderEmptyAssistantMessageIds,
} from './message-list/row-layout';
import {
  getStandalonePermissionPrompts,
  getStandaloneQuestionPrompts,
  reconcilePendingPermissionSequence,
} from './message-list/pending-prompts';
import { getVisibleThreadMessages } from './message-list/thread-visibility';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  getLatestPlanImplementationMessageId,
  shouldShowPlanImplementationAction,
} from './message-list/plan-actions';
import { getAssistantDialogSummaryMap } from './message-list/assistant-dialog';
import * as toolCallMatching from '../lib/tool-call-matching';
import {
  getNextVisibleUserMessageTopMap,
  getStickyUserMessagePreview,
  shouldShowStickyUserMessagePreview,
} from './message-list/sticky-preview';
import { calculateVirtualRange } from './message-list/virtualization';
import {
  editingMessage,
  resetMessageEditState,
  startEditingMessage,
} from '../lib/message-edit-state';
import {
  cacheSessionHistoryPage,
  clearSessionMessageWindowState,
  invalidateSessionMessageWindowRequests,
  markSessionHistoryLoadFailed,
  resetMessageWindowState,
  resetSessionMessageWindowForRefetch,
  setSessionHistoryCursor,
  setSessionHistoryPromptCursor,
  setSessionHistoryPrompts,
} from '../lib/message-window';
import { client } from '../lib/client';
import { setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
const testDiffOverlayOwner = Symbol();

function installQueuedAnimationFrameMocks() {
  const originalGlobalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalGlobalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
  const originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
  const pendingAnimationFrameCallbacks: Array<FrameRequestCallback | null> = [];
  const requestAnimationFrameMock = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
    pendingAnimationFrameCallbacks.push(cb);
    return pendingAnimationFrameCallbacks.length;
  });
  const cancelAnimationFrameMock = vi.fn().mockImplementation((id: number) => {
    if (id <= 0) return;
    pendingAnimationFrameCallbacks[id - 1] = null;
  });

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: requestAnimationFrameMock,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: cancelAnimationFrameMock,
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: requestAnimationFrameMock,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: cancelAnimationFrameMock,
  });

  return {
    flush(now = 0) {
      const callbacks = pendingAnimationFrameCallbacks.splice(0);
      for (const callback of callbacks) callback?.(now);
    },
    restore() {
      Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalGlobalRequestAnimationFrame,
      });
      Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalGlobalCancelAnimationFrame,
      });
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowCancelAnimationFrame,
      });
    },
  };
}

function installControllableIntersectionObserver() {
  let callback: IntersectionObserverCallback | undefined;
  let observer: IntersectionObserver | undefined;

  class TestIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0, 1];

    constructor(nextCallback: IntersectionObserverCallback) {
      callback = nextCallback;
      observer = this as unknown as IntersectionObserver;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver =
    TestIntersectionObserver as unknown as typeof IntersectionObserver;

  return {
    emit(
      entries: Array<Partial<IntersectionObserverEntry> & Pick<IntersectionObserverEntry, 'target'>>
    ) {
      if (!callback || !observer) throw new Error('IntersectionObserver was not created');
      callback(entries as IntersectionObserverEntry[], observer);
    },
  };
}

function textPart(
  id: string,
  text: string,
  options?: { ignored?: boolean; synthetic?: boolean }
): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
    ...options,
  };
}

function filePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url: `https://example.test/${id}.png`,
  };
}

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  };
}

function assistantMessage(
  id: string,
  options?: {
    agent?: string;
    error?: AssistantMessage['error'];
    mode?: string;
    modelID?: string;
    parentID?: string;
    providerID?: string;
    sessionID?: string;
    time?: AssistantMessage['time'];
    tokens?: AssistantMessage['tokens'];
    variant?: string;
  }
): AssistantMessage {
  return {
    id,
    sessionID: options?.sessionID ?? 'session-1',
    role: 'assistant',
    time: options?.time ?? { created: 1, completed: 2 },
    parentID: options?.parentID ?? 'parent-1',
    modelID: options?.modelID ?? 'gpt-5.4',
    providerID: options?.providerID ?? 'openai',
    mode: options?.mode ?? 'default',
    agent: options?.agent,
    error: options?.error,
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: options?.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    variant: options?.variant,
  };
}

function hasAssistantModelChangeBetween(previousId: string, currentId: string) {
  const previous = state.messages.find((message) => message.info.id === previousId);
  const current = state.messages.find((message) => message.info.id === currentId);
  return (
    previous?.info.role === 'assistant' &&
    current?.info.role === 'assistant' &&
    (previous.info.providerID !== current.info.providerID ||
      previous.info.modelID !== current.info.modelID)
  );
}

function session(id: string, options: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/workspace',
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
    ...options,
  };
}

function entry(info: Message) {
  return { info, parts: [] as Part[] };
}

function toolPart(id: string, messageID = 'message-1', callID = 'call-1'): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'tool',
    callID,
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'pwd' },
      time: { start: 1 },
    },
  };
}

function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 1 },
  };
}

describe('message entrance detection', () => {
  it('returns only messages appended at the end of the current transcript', () => {
    expect(
      getNewlyAppendedMessageIds(['message-1'], ['message-1', 'message-2', 'message-3'])
    ).toEqual(['message-2', 'message-3']);
  });

  it('does not treat prepended history or a replaced transcript as new messages', () => {
    expect(getNewlyAppendedMessageIds(['message-2'], ['message-1', 'message-2'])).toEqual([]);
    expect(getNewlyAppendedMessageIds(['message-1'], ['other-message'])).toEqual([]);
  });
});

describe('MessageList entrance animation', () => {
  it('shows a transcript instantly when it loads after switching to an existing chat', async () => {
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    replaceMessages([]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    replaceMessages([
      {
        info: assistantMessage('message-1', { time: { created: 1 } }),
        parts: [textPart('text-1', 'Loaded history')],
      },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="message-1"]')?.classList).not.toContain(
      'interactive-item-entering'
    );
    expect(container?.querySelector('.assistant-message-flow-item-streamed')).toBeNull();
  });

  it('shows existing unfinished chat content immediately and reveals only later streamed parts', async () => {
    const info = assistantMessage('message-1', { time: { created: 1 } });
    const initialPart = textPart('text-1', 'Already loaded');
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info, parts: [initialPart] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(
      container?.querySelector('[data-assistant-render-key="part:text-1"]')?.classList
    ).not.toContain('assistant-message-flow-item-streamed');

    replaceMessages([
      {
        info,
        parts: [initialPart, textPart('text-2', 'Streamed after opening')],
      },
    ]);
    await Promise.resolve();

    expect(
      container?.querySelector('[data-assistant-render-key="part:text-2"]')?.classList
    ).toContain('assistant-message-flow-item-streamed');
  });

  it('reveals the first part streamed into an assistant row that opened empty', async () => {
    const info = assistantMessage('message-1', { time: { created: 1 } });
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info, parts: [] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    replaceMessages([{ info, parts: [textPart('text-1', 'First streamed content')] }]);
    await Promise.resolve();

    expect(
      container?.querySelector('[data-assistant-render-key="part:text-1"]')?.classList
    ).toContain('assistant-message-flow-item-streamed');
  });

  it('does not collapse a newly appended user message during canonical replacement', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: userMessage('user-1'), parts: [textPart('text-1', 'First prompt')] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    startLoading(1);
    requestMessageListScrollToBottom();
    await Promise.resolve();

    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'First prompt')] },
      { info: userMessage('user-2'), parts: [textPart('text-2', 'Second prompt')] },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="user-2"]')?.classList).not.toContain(
      'interactive-item-entering'
    );

    // A canonical replacement remount must keep the sent row at its final geometry.
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'First prompt')] },
      { info: userMessage('user-2'), parts: [textPart('text-2', 'Second prompt')] },
    ]);
    await Promise.resolve();

    const appendedRow = container?.querySelector('[data-msg-id="user-2"]');
    expect(appendedRow?.classList).not.toContain('measured-entrance-active');
    expect(appendedRow?.classList).not.toContain('interactive-item-entering');
  });

  it('shows newly appended image messages immediately', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: userMessage('user-1'), parts: [textPart('text-1', 'First prompt')] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'First prompt')] },
      {
        info: userMessage('user-2'),
        parts: [textPart('text-2', 'Prompt with image'), filePart('image-1', 'Image')],
      },
    ]);
    await Promise.resolve();

    const imageRow = container?.querySelector('[data-msg-id="user-2"]');
    expect(imageRow?.querySelector('.chat-image-preview-trigger')).not.toBeNull();
    expect(imageRow?.classList).not.toContain('interactive-item-entering');
  });

  it('does not height-animate appends once row measurement is active', async () => {
    const buildMessages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        info: userMessage(`user-${index}`),
        parts: [{ ...textPart(`text-${index}`, `Prompt ${index}`), messageID: `user-${index}` }],
      }));

    setState('activeSessionId', 'session-1');
    replaceMessages(buildMessages(50));

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    replaceMessages(buildMessages(51));
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="user-50"]')?.classList).not.toContain(
      'interactive-item-entering'
    );
  });

  it('does not mark appends as entering while scrolled away from the bottom', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: userMessage('user-1'), parts: [textPart('text-1', 'First')] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 7200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

    requestMessageListScrollToBottom();
    await Promise.resolve();
    expect(list.scrollTop).toBe(6800);

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    list.scrollTop = 6400;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'First')] },
      { info: userMessage('user-2'), parts: [textPart('text-2', 'Second')] },
    ]);
    await Promise.resolve();

    const appendedRow = container?.querySelector('[data-msg-id="user-2"]');
    expect(appendedRow).not.toBeNull();
    expect(appendedRow?.classList).not.toContain('interactive-item-entering');
  });

  it('does not animate a message that was appended while scrolled up when it mounts later', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    const buildMessages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        info: userMessage(`user-${index}`),
        parts: [{ ...textPart(`text-${index}`, `Prompt ${index}`), messageID: `user-${index}` }],
      }));

    try {
      setState('activeSessionId', 'session-1');
      replaceMessages(buildMessages(60));

      cleanup = render(() => MessageList(), container!);

      const list = container?.querySelector('.interactive-list') as HTMLDivElement;
      let rowCount = 60;
      let scrollTopValue = 0;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(list, 'scrollHeight', {
        configurable: true,
        get: () => rowCount * 120,
      });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          if (this.classList.contains('interactive-item-container')) {
            return new DOMRect(0, 0, 500, 120);
          }
          return new DOMRect(0, 0, 500, 400);
        }
      );

      await Promise.resolve();
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      // Virtualization is active and pinned to the bottom.
      expect(container?.querySelector('[data-msg-id="user-0"]')).toBeNull();

      // Scroll up: new appends must not be marked as entering.
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      scrollTopValue = 0;
      list.dispatchEvent(new Event('scroll'));
      animationFrames.flush();
      await Promise.resolve();

      rowCount = 61;
      replaceMessages(buildMessages(61));
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      expect(container?.querySelector('[data-msg-id="user-60"]')).toBeNull();

      // Scroll back down: the row mounts now, without an entrance animation.
      scrollTopValue = rowCount * 120 - 400;
      list.dispatchEvent(new Event('scroll'));
      animationFrames.flush();
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      const appendedRow = container?.querySelector('[data-msg-id="user-60"]');
      expect(appendedRow).not.toBeNull();
      expect(appendedRow?.classList).not.toContain('interactive-item-entering');
    } finally {
      animationFrames.restore();
    }
  });
});

describe('MessageList loading states', () => {
  it('shows a loading indicator instead of a blank transcript while messages load', async () => {
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);
    replaceMessages([]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.chat-messages-loading')).not.toBeNull();
    expect(container?.querySelector('.chat-empty-state')).toBeNull();

    setState('messagesLoading', false);
  });

  it('waits to place a linked question until its message loads', async () => {
    const question: QuestionRequest = {
      id: 'question-1',
      sessionID: 'session-1',
      tool: { messageID: 'message-1', callID: 'call-1' },
      questions: [{ question: 'Choose one', header: 'Question', options: [] }],
    };
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    setState('questions', [question]);
    setState('messagesLoading', true);
    replaceMessages([]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.chat-messages-loading')).not.toBeNull();
    expect(container?.querySelector('.question-prompt-card')).toBeNull();

    batch(() => {
      replaceMessages([
        {
          info: assistantMessage('message-1'),
          parts: [{ ...toolPart('tool-1'), tool: 'question' }],
        },
      ]);
      setState('messagesLoading', false);
    });
    await Promise.resolve();

    const messageRow = container?.querySelector('[data-msg-id="message-1"]');
    expect(messageRow?.querySelectorAll('.question-prompt-card')).toHaveLength(1);
    expect(container?.querySelectorAll('.question-prompt-card')).toHaveLength(1);
  });

  it('keeps a linked permission actionable while its message loads', async () => {
    const permission: Permission = {
      id: 'permission-1',
      type: 'bash',
      sessionID: 'session-1',
      messageID: 'message-1',
      callID: 'call-1',
      title: 'Allow command',
      metadata: { command: 'pwd' },
      time: { created: 1 },
    };
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    setState('permissions', [permission]);
    setState('messagesLoading', true);
    replaceMessages([]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.chat-messages-loading')).not.toBeNull();
    expect(container?.querySelectorAll('.permission-prompt')).toHaveLength(1);

    batch(() => {
      replaceMessages([
        {
          info: assistantMessage('message-1'),
          parts: [toolPart('tool-1')],
        },
      ]);
      setState('messagesLoading', false);
    });
    await Promise.resolve();

    const messageRow = container?.querySelector('[data-msg-id="message-1"]');
    expect(messageRow?.querySelectorAll('.permission-prompt')).toHaveLength(1);
    expect(container?.querySelectorAll('.permission-prompt')).toHaveLength(1);
  });

  it('shows a retry action in the history banner when loading earlier messages failed', async () => {
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: assistantMessage('message-1', { time: { created: 1 } }), parts: [] }]);
    setSessionHistoryCursor('session-1', 'cursor-1');
    markSessionHistoryLoadFailed('session-1', true);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const banner = container?.querySelector('.message-history-banner.is-error');
    expect(banner?.textContent).toContain("Couldn't load earlier messages");
    expect(banner?.getAttribute('aria-hidden')).toBeNull();
    expect(banner?.querySelector('.message-history-banner-retry')).not.toBeNull();
  });

  it('keeps the decorative wave banner when earlier history loads normally', async () => {
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: assistantMessage('message-1', { time: { created: 1 } }), parts: [] }]);
    setSessionHistoryCursor('session-1', 'cursor-1');

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const banner = container?.querySelector('.message-history-banner');
    expect(banner?.classList.contains('is-error')).toBe(false);
    expect(banner?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.message-history-banner-retry')).toBeNull();
  });
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
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  globalThis.requestAnimationFrame = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  globalThis.cancelAnimationFrame = vi.fn();
  vi.useFakeTimers();
});

afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  await Promise.resolve();
  vi.useRealTimers();
  container?.remove();
  container = null;
  setState('messages', []);
  setState('sessions', []);
  setState('permissions', []);
  setState('questions', []);
  setState('activeSessionId', null);
  setState('messagesLoading', false);
  setState('providers', []);
  setState('agents', []);
  setState('allAgents', []);
  setState('queuedMessages', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
  resetMessageWindowState();
  resetToolCallExpansionState();
  setState('sessionSelectedAgents', reconcile({}));
  setState('sessionStatus', reconcile({}));
  setState('skippedPlanSessions', reconcile({}));
  setShowInlineFileChanges(false);
  setShowThinkingPreference(true);
  stopLoading();
  resetMessageEditState();
  setExpandedDiffOverlay(testDiffOverlayOwner, false);
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
    delete (globalThis as Partial<typeof globalThis>).ResizeObserver;
  }
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    delete (globalThis as Partial<typeof globalThis>).IntersectionObserver;
  }
  if (originalRequestAnimationFrame) {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  } else {
    delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
  }
  if (originalCancelAnimationFrame) {
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  } else {
    delete (globalThis as Partial<typeof globalThis>).cancelAnimationFrame;
  }
  if (originalScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
  vi.restoreAllMocks();
});

describe('MessageList compact activity', () => {
  it('classifies render-empty assistant messages as zero-height virtual rows', () => {
    const ownerPart = toolPart('command-1', 'assistant-owner', 'call-command-1');
    const followerParts = [
      toolPart('read-1', 'assistant-follower-1', 'call-read-1'),
      toolPart('command-2', 'assistant-follower-2', 'call-command-2'),
      toolPart('read-2', 'assistant-follower-3', 'call-read-2'),
    ];
    const messages: MessageEntry[] = [
      { info: assistantMessage('assistant-owner'), parts: [ownerPart] },
      ...followerParts.map((part) => ({
        info: assistantMessage(part.messageID),
        parts: [part],
      })),
      {
        info: assistantMessage('assistant-result'),
        parts: [{ ...textPart('result-1', 'Finished.'), messageID: 'assistant-result' }],
      },
    ];
    const hiddenTodo = toolPart('todo-1', 'assistant-hidden-todo', 'call-todo-1');
    hiddenTodo.tool = 'todowrite';
    messages.splice(4, 0, {
      info: assistantMessage('assistant-hidden-todo'),
      parts: [hiddenTodo],
    });
    const group: AssistantActivityGroupInfo = {
      key: 'activity-group-1',
      ownerMessageId: 'assistant-owner',
      ownerPartId: ownerPart.id,
      parts: [ownerPart, ...followerParts],
    };
    const groups = new Map(
      messages.slice(0, 4).map((message) => [message.info.id, [group]] as const)
    );

    expect([...getRenderEmptyAssistantMessageIds(messages, groups, () => false)]).toEqual([
      'assistant-follower-1',
      'assistant-follower-2',
      'assistant-follower-3',
      'assistant-hidden-todo',
    ]);
    expect([...getRenderEmptyAssistantMessageIds(messages, groups, () => true)]).toEqual([
      'assistant-hidden-todo',
    ]);
  });

  it('does not classify projected streaming text after Explored as render-empty', async () => {
    const read = toolPart('read-1', 'assistant-1', 'call-read-1');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const streamedText: TextPart = {
      id: 'text-2',
      sessionID: 'session-1',
      messageID: 'assistant-2',
      type: 'text',
      text: '',
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Inspect the code')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [read],
      },
      {
        info: assistantMessage('assistant-2', { parentID: 'user-1' }),
        parts: [streamedText],
      },
    ]);
    batch(() => {
      setState('streamingPartId', streamedText.id);
      setState('streamingText', 'I found the relevant implementation.');
    });

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file'
    );
    expect(container?.textContent).toContain('I found the relevant implementation.');
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.classList).not.toContain(
      'interactive-item-render-empty'
    );

    batch(() => {
      upsertPart({ ...streamedText, text: 'I found the relevant implementation.' });
      setState('streamingPartId', null);
      setState('streamingText', '');
    });
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.classList).not.toContain(
      'interactive-item-render-empty'
    );
  });

  it('uses one disclosure for activity across primary assistant messages', async () => {
    const command = toolPart('command-1', 'assistant-1', 'call-command-1');
    command.state = {
      status: 'completed',
      input: { command: 'npm test' },
      output: 'passed',
      title: 'npm test',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const thought: Part = {
      id: 'reasoning-1',
      sessionID: 'session-1',
      messageID: 'assistant-2',
      type: 'reasoning',
      text: 'Verifying results',
      time: { start: 3, end: 4 },
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run the checks')] },
      { info: assistantMessage('assistant-1', { parentID: 'user-1' }), parts: [command] },
      { info: assistantMessage('assistant-2', { parentID: 'user-1' }), parts: [thought] },
      {
        info: assistantMessage('assistant-3', { parentID: 'user-1' }),
        parts: [
          {
            ...textPart('result-1', 'All checks passed.'),
            messageID: 'assistant-3',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const summaries = container?.querySelectorAll<HTMLButtonElement>('.assistant-activity-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries?.[0]?.textContent).toContain('Explored: 1 thought, 1 command');
    expect(container?.querySelectorAll('.assistant-activity-details')).toHaveLength(0);
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.classList).toContain(
      'interactive-item-render-empty'
    );

    summaries?.[0]?.click();

    expect(summaries?.[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('.assistant-activity-details')).toHaveLength(2);
    expect(container?.textContent).toContain('All checks passed.');
  });

  it('shows running activity inline before moving it into Explored', async () => {
    const read = toolPart('read-1', 'assistant-1', 'call-read-1');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 0, end: 1 },
    };
    const search = toolPart('search-1', 'assistant-1', 'call-search-1');
    search.tool = 'grep';
    search.state = {
      status: 'running',
      input: { pattern: 'activity' },
      title: 'Searching',
      time: { start: 1 },
    };
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Search the code')] };
    const info = assistantMessage('assistant-1', { parentID: 'user-1' });
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, { info, parts: [read, search] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('[data-activity-part-id="search-1"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(499);
    expect(container?.querySelector('[data-activity-part-id="search-1"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file'
    );
    expect(container?.querySelector('[data-activity-part-id="search-1"]')).not.toBeNull();
    replaceMessages([
      user,
      {
        info,
        parts: [
          read,
          {
            ...search,
            state: {
              status: 'completed',
              input: { pattern: 'activity' },
              output: 'Found matches',
              title: 'Searching',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file'
    );
    expect(
      container?.querySelector('[data-activity-part-id="search-1"].is-completed')
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(
      container?.querySelector('[data-activity-part-id="search-1"].is-completed')
    ).not.toBeNull();
    expect(container?.querySelector('[data-activity-part-id="search-1"].is-exiting')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(
      container?.querySelector('[data-activity-part-id="search-1"].is-exiting')
    ).not.toBeNull();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file, 1 search'
    );

    await vi.advanceTimersByTimeAsync(420);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file, 1 search'
    );
    expect(container?.querySelector('[data-activity-part-id="search-1"]')).toBeNull();
  });

  it('adds running activity in a new message directly to expanded Explored', async () => {
    const completed = toolPart('command-completed', 'assistant-1', 'call-command-completed');
    completed.state = {
      status: 'completed',
      input: { command: 'npm run lint' },
      output: 'passed',
      title: 'npm run lint',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const running = toolPart('command-running', 'assistant-2', 'call-command-running');
    running.state = {
      status: 'running',
      input: { command: 'npm run test' },
      title: 'npm run test',
      time: { start: 3 },
    };
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run checks')] };
    const first = {
      info: assistantMessage('assistant-1', { parentID: 'user-1' }),
      parts: [completed],
    };
    const second = {
      info: assistantMessage('assistant-2', { parentID: 'user-1', time: { created: 3 } }),
      parts: [running],
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, first]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const summary = container?.querySelector<HTMLButtonElement>('.assistant-activity-summary');
    summary?.click();
    expect(summary?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(1);

    replaceMessages([user, first, second]);
    await Promise.resolve();

    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(2);
    expect(container?.querySelector('.assistant-active-activity-tray')).toBeNull();
    expect(summary?.textContent).toContain('Explored: 1 command');
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.classList).not.toContain(
      'interactive-item-render-empty'
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(2);
    expect(container?.querySelector('.assistant-active-activity-tray')).toBeNull();
  });

  it('skips the minimum visible hold when response text is already streaming', async () => {
    const search = toolPart('search-streaming', 'assistant-1', 'call-search-streaming');
    search.tool = 'grep';
    search.state = {
      status: 'running',
      input: { pattern: 'activity' },
      title: 'Searching',
      time: { start: 1 },
    };
    const completedSearch: ToolPart = {
      ...search,
      state: {
        status: 'completed',
        input: { pattern: 'activity' },
        output: 'Found matches',
        title: 'Searching',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const response = {
      ...textPart('response-streaming', 'Streaming response'),
      messageID: 'assistant-1',
    };
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Search the code')] };
    const info = assistantMessage('assistant-1', { parentID: 'user-1' });
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, { info, parts: [search] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(container?.querySelector('[data-activity-part-id="search-streaming"]')).not.toBeNull();

    batch(() => {
      replaceMessages([user, { info, parts: [completedSearch, response] }]);
      setState('streamingPartId', response.id);
      setState('streamingText', 'Streaming response');
    });
    await Promise.resolve();

    expect(
      container?.querySelector('[data-activity-part-id="search-streaming"].is-exiting')
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-activity-part-id="search-streaming"].is-completed')
    ).toBeNull();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 search'
    );
  });

  it('retains activity while it joins a group owned by an earlier message', async () => {
    const completed = toolPart('command-completed', 'assistant-1', 'call-command-completed');
    completed.state = {
      status: 'completed',
      input: { command: 'npm run lint' },
      output: 'passed',
      title: 'npm run lint',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const running = toolPart('command-running', 'assistant-2', 'call-command-running');
    running.state = {
      status: 'running',
      input: { command: 'npm run test' },
      title: 'npm run test',
      time: { start: 3 },
    };
    const completedRunning: ToolPart = {
      ...running,
      state: {
        status: 'completed',
        input: { command: 'npm run test' },
        output: 'passed',
        title: 'npm run test',
        metadata: {},
        time: { start: 3, end: 4 },
      },
    };
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run checks')] };
    const first = {
      info: assistantMessage('assistant-1', { parentID: 'user-1' }),
      parts: [completed],
    };
    const secondInfo = assistantMessage('assistant-2', {
      parentID: 'user-1',
      time: { created: 3 },
    });
    const response = {
      info: assistantMessage('assistant-3', { parentID: 'user-1' }),
      parts: [{ ...textPart('response-1', 'Checks passed.'), messageID: 'assistant-3' }],
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, first, { info: secondInfo, parts: [running] }, response]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(container?.querySelector('[data-activity-part-id="command-running"]')).not.toBeNull();

    replaceMessages([user, first, { info: secondInfo, parts: [completedRunning] }, response]);
    await Promise.resolve();

    const followerRow = container?.querySelector('[data-msg-id="assistant-2"]');
    expect(
      followerRow?.querySelector('[data-activity-part-id="command-running"].is-completed')
    ).not.toBeNull();
    expect(followerRow?.classList).not.toContain('interactive-item-render-empty');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      followerRow?.querySelector('[data-activity-part-id="command-running"].is-exiting')
    ).not.toBeNull();
    expect(followerRow?.classList).not.toContain('interactive-item-render-empty');

    await vi.advanceTimersByTimeAsync(420);
    expect(container?.querySelector('[data-activity-part-id="command-running"]')).toBeNull();
    expect(followerRow?.classList).toContain('interactive-item-render-empty');
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 2 commands'
    );
  });

  it('does not show active tools that complete inside the display debounce', async () => {
    const read = toolPart('read-1', 'assistant-1', 'call-read-1');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 0, end: 1 },
    };
    const command = toolPart('command-fast', 'assistant-1', 'call-command-fast');
    command.state = {
      status: 'running',
      input: { command: 'npm run lint' },
      title: 'npm run lint',
      time: { start: 2 },
    };
    const completedCommand: ToolPart = {
      ...command,
      state: {
        status: 'completed',
        input: { command: 'npm run lint' },
        output: 'passed',
        title: 'npm run lint',
        metadata: {},
        time: { start: 2, end: 3 },
      },
    };
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run checks')] };
    const info = assistantMessage('assistant-1', {
      parentID: 'user-1',
      time: { created: 1 },
    });
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, { info, parts: [read] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    replaceMessages([user, { info, parts: [read, command] }]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(container?.querySelector('[data-activity-part-id="command-fast"]')).toBeNull();

    replaceMessages([user, { info, parts: [read, completedCommand] }]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);

    expect(container?.querySelector('[data-activity-part-id="command-fast"]')).toBeNull();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file, 1 command'
    );
  });

  it('keeps a delayed trailing tool row collapsed below visible reasoning', async () => {
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Investigate')] };
    const thought = {
      ...reasoningPart('reasoning-1', '**Ruminating**\n\nInspecting the layout.'),
      messageID: 'assistant-1',
    };
    const running = toolPart('command-1', 'assistant-2', 'call-command-1');
    running.state = {
      status: 'running',
      input: { command: 'npm test' },
      title: 'npm test',
      time: { start: 2 },
    };
    const reasoningMessage = {
      info: assistantMessage('assistant-1', { parentID: 'user-1' }),
      parts: [thought],
    };
    const toolMessage = {
      info: assistantMessage('assistant-2', { parentID: 'user-1' }),
      parts: [running],
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, reasoningMessage]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(container?.textContent).toContain('Ruminating');

    replaceMessages([user, reasoningMessage, toolMessage]);
    await Promise.resolve();

    const toolRow = () => container?.querySelector('[data-msg-id="assistant-2"]');
    expect(toolRow()?.classList).toContain('interactive-item-render-empty');
    expect(toolRow()?.classList).not.toContain('measured-entrance-active');
    expect(container?.querySelector('[data-activity-part-id="command-1"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(499);
    expect(toolRow()?.classList).toContain('interactive-item-render-empty');

    await vi.advanceTimersByTimeAsync(1);
    expect(toolRow()?.classList).not.toContain('interactive-item-render-empty');
    expect(container?.querySelector('[data-activity-part-id="command-1"]')).not.toBeNull();
  });

  it('keeps stale running tools in completed history compact while the latest turn works', async () => {
    const staleCommand = toolPart('command-stale', 'assistant-1', 'call-command-stale');
    staleCommand.state = {
      status: 'running',
      input: { command: 'npm run old-check' },
      title: 'npm run old-check',
      time: { start: 1 },
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run the old check')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [staleCommand],
      },
      { info: userMessage('user-2'), parts: [textPart('prompt-2', 'Continue working')] },
      {
        info: assistantMessage('assistant-2', {
          parentID: 'user-2',
          time: { created: 3 },
        }),
        parts: [{ ...textPart('response-2', 'Working on it.'), messageID: 'assistant-2' }],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(container?.querySelector('[data-activity-part-id="command-stale"]')).toBeNull();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 command'
    );
    expect(container?.textContent).toContain('Working on it.');
  });

  it('renders Explored before earlier parallel activity becomes visible', async () => {
    const running = toolPart('command-running', 'assistant-1', 'call-command-running');
    running.state = {
      status: 'running',
      input: { command: 'npm run test:e2e' },
      title: 'npm run test:e2e',
      time: { start: 1 },
    };
    const completed = ['command-completed-1', 'command-completed-2'].map((id, index) => {
      const part = toolPart(id, `assistant-${index + 2}`, `call-${id}`);
      part.state = {
        status: 'completed',
        input: { command: `npm run check:${index + 1}` },
        output: 'passed',
        title: `npm run check:${index + 1}`,
        metadata: {},
        time: { start: index + 2, end: index + 3 },
      };
      return part;
    });
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run checks')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1', time: { created: 1 } }),
        parts: [running],
      },
      {
        info: assistantMessage('assistant-2', { parentID: 'user-1' }),
        parts: [completed[0]!],
      },
      {
        info: assistantMessage('assistant-3', { parentID: 'user-1' }),
        parts: [completed[1]!],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 2 commands'
    );
    await vi.advanceTimersByTimeAsync(500);

    const summary = container?.querySelector<HTMLElement>('.assistant-activity-summary');
    const activeItem = container?.querySelector<HTMLElement>(
      '[data-activity-part-id="command-running"]'
    );
    expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
    expect(summary?.textContent).toContain('Explored: 2 commands');
    expect(summary?.closest('.assistant-active-activity-tray')).toBe(
      activeItem?.closest('.assistant-active-activity-tray')
    );
    expect(summary?.compareDocumentPosition(activeItem!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps one Explored group while a command between completed tools is retained', async () => {
    const completedCommand = (id: string, command: string, start: number) => {
      const part = toolPart(id, 'assistant-1', `call-${id}`);
      part.state = {
        status: 'completed',
        input: { command },
        output: 'passed',
        title: command,
        metadata: {},
        time: { start, end: start + 1 },
      };
      return part;
    };
    const first = completedCommand('command-1', 'npm run lint', 1);
    const running = toolPart('command-2', 'assistant-1', 'call-command-2');
    running.state = {
      status: 'running',
      input: { command: 'npm run test:e2e' },
      title: 'npm run test:e2e',
      time: { start: 3 },
    };
    const last = completedCommand('command-3', 'npm run typecheck', 5);
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run checks')] };
    const info = assistantMessage('assistant-1', {
      parentID: 'user-1',
      time: { created: 1 },
    });
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, { info, parts: [first, running, last] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 2 commands'
    );

    const retained = completedCommand('command-2', 'npm run test:e2e', 3);
    replaceMessages([user, { info, parts: [first, retained, last] }]);
    await Promise.resolve();

    expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 2 commands'
    );
    expect(
      container?.querySelector('[data-activity-part-id="command-2"].is-completed')
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 3 commands'
    );
  });

  it('reserves an inert Exploring row before the first tool can be summarized', async () => {
    const command = toolPart('command-1', 'assistant-1', 'call-command-1');
    command.state = {
      status: 'running',
      input: { command: 'npm test' },
      title: 'npm test',
      time: { start: 1 },
    };
    const completedCommand: ToolPart = {
      ...command,
      state: {
        status: 'completed',
        input: { command: 'npm test' },
        output: 'passed',
        title: 'npm test',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const user = { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run tests')] };
    const info = assistantMessage('assistant-1', {
      parentID: 'user-1',
      time: { created: 1 },
    });
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([user, { info, parts: [command] }]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    const placeholder = container?.querySelector<HTMLElement>(
      '.assistant-activity-summary-placeholder'
    );
    const activeItem = container?.querySelector<HTMLElement>('[data-activity-part-id="command-1"]');
    expect(placeholder?.textContent).toBe('Exploring');
    expect(placeholder?.querySelector('.assistant-activity-chevron')).toBeNull();
    expect(placeholder?.getAttribute('aria-expanded')).toBeNull();
    expect(placeholder?.compareDocumentPosition(activeItem!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );

    replaceMessages([
      user,
      {
        info,
        parts: [completedCommand],
      },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary-placeholder')).not.toBeNull();
    expect(container?.querySelector('button.assistant-activity-summary')).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);

    const tray = container?.querySelector('.assistant-active-activity-tray');
    expect(tray?.classList).toContain('has-active-summary');
    expect(tray?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 command'
    );
    expect(tray?.querySelector('button.assistant-activity-summary')).not.toBeNull();
    expect(tray?.querySelector('[data-activity-part-id="command-1"].is-exiting')).not.toBeNull();

    replaceMessages([
      user,
      {
        info,
        parts: [
          completedCommand,
          { ...textPart('response-1', 'Tests passed.'), messageID: 'assistant-1' },
        ],
      },
    ]);
    await Promise.resolve();
    expect(
      container?.querySelector('[data-activity-part-id="command-1"].is-exiting')
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(420);

    expect(container?.querySelector('.assistant-active-activity-tray')).toBeNull();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 command'
    );
    expect(container?.textContent).toContain('Tests passed.');
  });

  it('starts a separate disclosure for activity after response text', async () => {
    const command = toolPart('command-before', 'assistant-1', 'call-command-before');
    command.state = {
      status: 'completed',
      input: { command: 'npm test' },
      output: 'passed',
      title: 'npm test',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const response = { ...textPart('response-mid', 'Initial response.'), messageID: 'assistant-1' };
    const thought: Part = {
      id: 'thought-after',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'reasoning',
      text: 'Checking after the response',
      time: { start: 3, end: 4 },
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run the checks')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [command, response, thought],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const summaries = [
      ...(container?.querySelectorAll<HTMLButtonElement>('.assistant-activity-summary') || []),
    ];
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.textContent).toContain('Explored: 1 command');
    expect(summaries[1]?.textContent).toContain('Explored: 1 thought');

    const renderKeys = [
      ...(container?.querySelectorAll<HTMLElement>('[data-assistant-render-key]') || []),
    ].map((element) => element.dataset.assistantRenderKey);
    expect(renderKeys).toEqual([
      'activity-group:command-before',
      'part:response-mid',
      'activity-group:thought-after',
    ]);
  });

  it('keeps completed diffs inline across later prompts while the chat stays open', async () => {
    const edit: ToolPart = {
      id: 'edit-inline-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'tool',
      callID: 'call-edit-inline-1',
      tool: 'edit',
      state: {
        status: 'completed',
        input: {
          filePath: 'src/app.ts',
          oldString: 'const value = 1;',
          newString: 'const value = 2;',
        },
        output: 'Done',
        title: 'Edited src/app.ts',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const secondEdit: ToolPart = {
      ...edit,
      id: 'edit-inline-2',
      messageID: 'assistant-2',
      callID: 'call-edit-inline-2',
      state: {
        status: 'completed',
        input: {
          filePath: 'src/second.ts',
          oldString: 'const second = 1;',
          newString: 'const second = 2;',
        },
        output: 'Done',
        title: 'Edited src/second.ts',
        metadata: {},
        time: { start: 3, end: 4 },
      },
    };
    const historicalEdit: ToolPart = {
      ...edit,
      id: 'edit-history',
      messageID: 'assistant-history',
      callID: 'call-edit-history',
      state: {
        ...edit.state,
        input: {
          filePath: 'src/history.ts',
          oldString: 'const historical = 1;',
          newString: 'const historical = 2;',
        },
      },
    };
    const read = toolPart('read-current', 'assistant-1', 'call-read-current');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 0, end: 1 },
    };
    setShowInlineFileChanges(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-history'), parts: [textPart('prompt-history', 'Earlier edit')] },
      {
        info: assistantMessage('assistant-history', { parentID: 'user-history' }),
        parts: [historicalEdit],
      },
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Edit the file')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [read, edit],
      },
      {
        info: assistantMessage('assistant-2', { parentID: 'user-1' }),
        parts: [secondEdit],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const summaries = () => [
      ...(container?.querySelectorAll<HTMLElement>('.assistant-activity-summary') || []),
    ];
    expect(summaries()).toHaveLength(2);
    expect(summaries().map((summary) => summary.textContent)).toEqual([
      expect.stringContaining('Explored: 1 edit'),
      expect.stringContaining('Explored: 1 file'),
    ]);
    expect(container?.querySelector('.file-change-inline-diffs-unwrapped')).not.toBeNull();
    expect(container?.querySelector('.assistant-file-edit-pager')).toBeNull();
    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(2);
    expect(
      [...(container?.querySelectorAll('.diff-view-filename') || [])].map(
        (element) => element.textContent
      )
    ).toEqual(['app.ts', 'second.ts']);

    setState('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setState('sessionStatus', reconcile({ 'session-1': { type: 'idle' } }));
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(2);

    setState('questions', []);
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(2);

    replaceMessages([
      { info: userMessage('user-history'), parts: [textPart('prompt-history', 'Earlier edit')] },
      {
        info: assistantMessage('assistant-history', { parentID: 'user-history' }),
        parts: [historicalEdit],
      },
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Edit the file')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [read, edit],
      },
      {
        info: assistantMessage('assistant-2', { parentID: 'user-1' }),
        parts: [secondEdit],
      },
      { info: userMessage('user-2'), parts: [textPart('prompt-2', 'One more change')] },
    ]);
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(2);
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]?.textContent).toContain('Explored: 1 file');
    expect(summaries()[1]?.textContent).not.toContain('edit');
  });

  it('compacts a just-completed diff when the chat is reopened', async () => {
    const edit = toolPart('edit-inline-1', 'assistant-1', 'call-edit-inline-1');
    edit.tool = 'edit';
    edit.state = {
      status: 'completed',
      input: {
        filePath: 'src/app.ts',
        oldString: 'const value = 1;',
        newString: 'const value = 2;',
      },
      output: 'Done',
      title: 'Edited src/app.ts',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const transcript: MessageEntry[] = [
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Edit the file')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [edit],
      },
    ];
    setShowInlineFileChanges(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages(transcript);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(1);

    setState('sessionStatus', reconcile({ 'session-1': { type: 'idle' } }));
    await Promise.resolve();
    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(1);

    replaceMessages([]);
    await Promise.resolve();
    replaceMessages(transcript);
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(0);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 edit'
    );

    startLoading();
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(0);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 edit'
    );
  });

  it('omits unparsed edit tools from shared activity summaries when inline previews are enabled', async () => {
    const edit = toolPart('edit-pending', 'assistant-1', 'call-edit-pending');
    edit.tool = 'apply_patch';
    const read = toolPart('read-1', 'assistant-1', 'call-read-1');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    setShowInlineFileChanges(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Inspect and edit')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [edit, read],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      '1 file'
    );
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).not.toContain(
      'edit'
    );
  });

  it('keeps pending apply_patch calls out of shared activity summaries', async () => {
    const patch = toolPart('patch-pending', 'assistant-1', 'call-patch-pending');
    patch.tool = 'apply_patch';
    patch.state = { status: 'pending', input: {}, raw: '' };
    const read = toolPart('read-1', 'assistant-1', 'call-read-1');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Inspect and edit')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [patch, read],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file'
    );
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).not.toContain(
      'edit'
    );
    expect(container?.querySelector('.tool-invocation-title')?.textContent).toBe('apply_patch');
  });

  it('removes a pending tool from Explored when it is identified as apply_patch', async () => {
    const patch = toolPart('patch-pending', 'assistant-1', 'call-patch-pending');
    patch.tool = '';
    patch.state = { status: 'pending', input: {}, raw: '' };
    const read = toolPart('read-1', 'assistant-1', 'call-read-1');
    read.tool = 'read';
    read.state = {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'source',
      title: 'src/app.ts',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Inspect and edit')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [read, patch],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await vi.advanceTimersByTimeAsync(500);
    container?.querySelector<HTMLButtonElement>('.assistant-activity-summary')?.click();

    upsertPart({ ...patch, tool: 'functions.apply_patch' });
    await Promise.resolve();

    const patchTitle = [...(container?.querySelectorAll('.tool-invocation-title') || [])].find(
      (element) => element.textContent?.endsWith('apply_patch')
    );
    expect(patchTitle).not.toBeUndefined();
    expect(patchTitle?.closest('.assistant-activity-details')).toBeNull();
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 1 file'
    );
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).not.toContain(
      'tool call'
    );
  });

  it('keeps an expanded activity group open when history extends it backward', async () => {
    const command = toolPart('command-1', 'assistant-1', 'call-command-1');
    command.state = {
      status: 'completed',
      input: { command: 'npm test' },
      output: 'passed',
      title: 'npm test',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const thought: Part = {
      id: 'reasoning-1',
      sessionID: 'session-1',
      messageID: 'assistant-2',
      type: 'reasoning',
      text: 'Verifying results',
      time: { start: 3, end: 4 },
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('assistant-2', { parentID: 'user-1' }), parts: [thought] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    container?.querySelector<HTMLButtonElement>('.assistant-activity-summary')?.click();
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(1);

    replaceMessages([
      { info: assistantMessage('assistant-1', { parentID: 'user-1' }), parts: [command] },
      { info: assistantMessage('assistant-2', { parentID: 'user-1' }), parts: [thought] },
    ]);
    await Promise.resolve();

    expect(
      container?.querySelector('.assistant-activity-summary')?.getAttribute('aria-expanded')
    ).toBe('true');
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(2);
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
        if (!this.dataset.assistantRenderKey) return [] as unknown as DOMRectList;
        return [this.getBoundingClientRect()] as unknown as DOMRectList;
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
    animationFrames.flush(performance.now());
    await Promise.resolve();
    const hydratedRow = container?.querySelector<HTMLElement>('[data-msg-id="older-49"]');
    expect(hydratedRow).toBeInstanceOf(HTMLDivElement);
    expect(hydratedRow?.classList).not.toContain('interactive-item-virtual-placeholder');
    expect(hydratedRow?.childElementCount).toBeGreaterThan(0);
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
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
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(harness.list) && observer.targets.has(track)
    );
    const expandedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const expansionControl = document.createElement('button');
    expansionControl.setAttribute('aria-expanded', 'false');
    expansionControl.getBoundingClientRect = () =>
      new DOMRect(0, 200 + expansionOffset - harness.getScrollTop(), 500, 20);
    expandedRow.append(expansionControl);
    expansionControl.click();

    expansionOffset = 100;
    layoutObserver!.callback(
      [{ target: track } as unknown as ResizeObserverEntry],
      layoutObserver as unknown as ResizeObserver
    );
    harness.animationFrames.flush();
    await Promise.resolve();
    expect(harness.getScrollTop()).toBe(120);
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
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
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(harness.list) && observer.targets.has(track)
    );
    const expandedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    const expansionControl = document.createElement('button');
    expansionControl.setAttribute('aria-expanded', 'false');
    expansionControl.getBoundingClientRect = () =>
      new DOMRect(0, 200 + expansionOffset - harness.getScrollTop(), 500, 20);
    expandedRow.append(expansionControl);
    expansionControl.click();
    expansionOffset = 100;
    layoutObserver!.callback(
      [{ target: track } as unknown as ResizeObserverEntry],
      layoutObserver as unknown as ResizeObserver
    );
    harness.animationFrames.flush();
    await Promise.resolve();
    expect(harness.getScrollTop()).toBe(120);

    expansionControl.click();
    harness.list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
    harness.setScrollTop(160);
    harness.list.dispatchEvent(new Event('scroll'));
    expansionOffset = 200;
    layoutObserver!.callback(
      [{ target: track } as unknown as ResizeObserverEntry],
      layoutObserver as unknown as ResizeObserver
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
    const pageFor = (sessionId: string, messageId: string) =>
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
    const firstPage = [
      { info: userMessage('older-user-1'), parts: [textPart('older-text-1', 'Older prompt 1')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    firstPage.nextCursor = 'cursor-oldest';
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
    const emptyPage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    emptyPage.nextCursor = 'cursor-next';
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
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    stalePage.nextCursor = 'cursor-next';
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
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
    const promptPage = (start: number, end: number, nextCursor?: string) => {
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
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
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

describe('getStickyUserMessagePreview', () => {
  it('returns the preceding user prompt for the first visible assistant message', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [textPart('text-1', 'Old prompt')] },
          { info: assistantMessage('assistant-1'), parts: [] },
          { info: userMessage('user-2'), parts: [textPart('text-2', 'Newest prompt')] },
          { info: assistantMessage('assistant-2'), parts: [] },
        ],
        3
      )
    ).toEqual({
      id: 'user-2',
      index: 2,
      text: 'Newest prompt',
      attachmentCount: 0,
      imageCount: 0,
    });
  });

  it('uses fallback preview text for attachment-only user messages', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [filePart('file-1', 'diagram.png')] },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        1
      )
    ).toEqual({
      id: 'user-1',
      index: 0,
      text: 'Attachment: diagram.png',
      attachmentCount: 0,
      imageCount: 1,
    });
  });

  it('skips empty user prompts when picking a sticky preview', () => {
    expect(
      getStickyUserMessagePreview(
        [
          {
            info: userMessage('user-1'),
            parts: [textPart('text-1', '(no content)', { ignored: true })],
          },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        1
      )
    ).toBeNull();
  });

  it('returns null when the first visible message is already a user prompt', () => {
    expect(
      getStickyUserMessagePreview(
        [{ info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt')] }],
        0
      )
    ).toBeNull();
  });

  it('returns null when the first visible index is stale for the current message array', () => {
    expect(
      getStickyUserMessagePreview(
        [
          { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt')] },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        5
      )
    ).toBeNull();
  });

  it('skips child-session user prompts that are rendered as compact handoff rows', () => {
    expect(
      getStickyUserMessagePreview(
        [
          {
            info: {
              ...userMessage('user-child-1'),
              sessionID: 'child-1',
            },
            parts: [
              {
                id: 'text-child-1',
                sessionID: 'child-1',
                messageID: 'user-child-1',
                type: 'text',
                text: 'Explore repo structure',
              },
            ],
          },
          {
            info: assistantMessage('assistant-child-1', {
              sessionID: 'child-1',
              mode: 'subagent',
            }),
            parts: [],
          },
          { info: assistantMessage('assistant-1'), parts: [] },
        ],
        2
      )
    ).toBeNull();
  });
});

describe('getNextVisibleUserMessageTopMap', () => {
  it('reuses observed user row bounds to resolve the next visible user prompt', () => {
    const messages = [
      entry(userMessage('user-1')),
      entry(assistantMessage('assistant-1')),
      entry(userMessage('user-2')),
      entry(assistantMessage('assistant-2')),
      entry(userMessage('user-3')),
      entry(assistantMessage('assistant-3')),
    ];

    const observedBounds = new Map<string, { top: number; bottom: number }>([
      ['user-2', { top: -80, bottom: -20 }],
      ['user-3', { top: 72, bottom: 124 }],
    ]);

    const nextTopByMessageId = getNextVisibleUserMessageTopMap(messages, observedBounds);
    expect(nextTopByMessageId.get('assistant-3')).toBeNull();
    expect(nextTopByMessageId.get('user-3')).toBeNull();
    expect(nextTopByMessageId.get('assistant-2')).toBe(72);
    expect(nextTopByMessageId.get('user-2')).toBe(72);
    expect(nextTopByMessageId.get('assistant-1')).toBe(72);
    expect(nextTopByMessageId.get('user-1')).toBe(72);
  });
});

describe('shouldShowStickyUserMessagePreview', () => {
  const previewFixture = {
    id: 'user-1',
    index: 2,
    text: 'Prompt',
    attachmentCount: 0,
    imageCount: 0,
  };

  it('returns false on vertically narrow screens', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        viewportHeight: 320,
      })
    ).toBe(false);
  });

  it('returns true when virtualization places the prompt above the visible range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: true,
        visibleRange: { start: 5, end: 10 },
        rowTop: null,
        rowBottom: null,
        viewportHeight: 500,
      })
    ).toBe(true);
  });

  it('returns true when the prompt row sits above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        viewportHeight: 500,
      })
    ).toBe(true);
  });

  it('returns false when the prompt row is visible', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 120,
        rowBottom: 180,
        viewportHeight: 500,
      })
    ).toBe(false);
  });

  it('trusts a mounted prompt over a stale virtual range', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: true,
        visibleRange: { start: 3, end: 8 },
        rowTop: -20,
        rowBottom: 32,
        viewportHeight: 500,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview while any part of the prompt is visible', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 12,
        rowBottom: 40,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the prompt peeks above it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -5,
        rowBottom: 40,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the prompt extends below it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 10,
        rowBottom: 61,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview once the next user message rises into it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 10,
        rowBottom: 60,
        nextUserMessageTop: 58,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('keeps the previous sticky preview only until the next user message reaches it', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        nextUserMessageTop: 62,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(true);

    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -120,
        rowBottom: -20,
        nextUserMessageTop: 59,
        viewportHeight: 500,
        previousPreviewId: 'user-1',
        stickyPreviewTop: 10,
        stickyPreviewBottom: 60,
      })
    ).toBe(false);
  });

  it('does not attach a native title tooltip to the sticky preview text', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || defaultRect;
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const stickyText = container?.querySelector(
      '.latest-user-message-sticky-text'
    ) as HTMLDivElement | null;
    expect(stickyText).toBeInstanceOf(HTMLDivElement);
    expect(stickyText?.textContent).toContain('Prompt 2');
    expect(stickyText?.getAttribute('title')).toBeNull();

    animationFrames.restore();
  });

  it('loads and scrolls to a sticky prompt behind a truncated history boundary', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    const boundaryRowDocumentTop = 500;
    const boundaryCardDocumentTop = 520;
    const scrollIntoView = vi.fn(() => {
      scrollTopValue = boundaryRowDocumentTop;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    vi.spyOn(client.session, 'messages').mockResolvedValue([
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 500);
        }
        const row = this.classList.contains('interactive-item-container')
          ? this
          : this.closest<HTMLElement>('[data-msg-id]');
        if (row?.dataset.msgId === 'boundary-user') {
          const documentTop = this.classList.contains('user-message-card')
            ? boundaryCardDocumentTop
            : boundaryRowDocumentTop;
          return new DOMRect(0, documentTop - scrollTopValue, 500, 52);
        }
        if (row?.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, 20, 500, 320);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    track.style.setProperty('--latest-user-message-sticky-gap', '13px');
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky-text')?.textContent).toContain(
      'Boundary prompt'
    );

    requestMessageListScrollToBottom();
    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(list.scrollTop).toBe(700);

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    sticky?.click();
    expect(sticky?.classList.contains('is-loading')).toBe(true);
    expect(sticky?.textContent).not.toContain('Loading…');
    expect(sticky?.querySelector('.latest-user-message-sticky-spinner')).not.toBeNull();
    await vi.waitFor(() => {
      expect(state.messages.some((message) => message.info.id === 'boundary-user')).toBe(true);
    });
    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    expect(sticky?.classList.contains('is-loading')).toBe(true);
    for (let frame = 0; frame < 5; frame += 1) {
      animationFrames.flush();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(client.session.messages).toHaveBeenCalledWith('session-1', {
      limit: 200,
      before: 'cursor-1',
    });
    const boundaryCard = container?.querySelector<HTMLElement>(
      '[data-msg-id="boundary-user"] .user-message-card'
    );
    expect(boundaryCard).toBeInstanceOf(HTMLDivElement);
    const computedStickyGap = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    expect(
      Math.abs(
        boundaryCard!.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          computedStickyGap
      )
    ).toBeLessThanOrEqual(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
    animationFrames.restore();
  });

  it('retries sticky navigation when its page is invalidated at the same cursor', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    const freshPage = [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi
      .spyOn(client.session, 'messages')
      .mockReturnValueOnce(pendingStalePage)
      .mockResolvedValueOnce(freshPage);
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    try {
      const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
      expect(sticky?.textContent).toContain('Boundary prompt');
      sticky?.click();
      await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(1));

      invalidateSessionMessageWindowRequests('session-1');
      releaseStalePage?.(stalePage);

      await vi.waitFor(() => expect(messagesSpy).toHaveBeenCalledTimes(2));
      expect(messagesSpy).toHaveBeenLastCalledWith('session-1', {
        limit: 200,
        before: 'cursor-stale',
      });
      await vi.waitFor(() => {
        expect(state.messages.some((message) => message.info.id === 'boundary-user')).toBe(true);
      });
    } finally {
      releaseStalePage?.(stalePage);
      await vi.advanceTimersByTimeAsync(0);
      animationFrames.restore();
    }
  });

  it('releases stale sticky loading when the same-session window resets', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const stalePage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    let releaseStalePage: ((page: typeof stalePage) => void) | undefined;
    const pendingStalePage = new Promise<typeof stalePage>((resolve) => {
      releaseStalePage = resolve;
    });
    const currentPage = [
      { info: userMessage('current-older'), parts: [textPart('current-text', 'Current history')] },
    ] as Awaited<ReturnType<typeof client.session.messages>>;
    const messagesSpy = vi.spyOn(client.session, 'messages').mockImplementation((_id, options) => {
      if (options?.before === 'cursor-stale') return pendingStalePage;
      if (options?.before === 'cursor-current') return Promise.resolve(currentPage);
      throw new Error(`Unexpected cursor ${options?.before}`);
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-stale');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    try {
      const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
      expect(sticky?.textContent).toContain('Boundary prompt');
      sticky?.click();
      await vi.waitFor(() => {
        expect(messagesSpy).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-stale',
        });
      });
      expect(sticky?.classList.contains('is-loading')).toBe(true);

      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
      expect(sticky?.classList.contains('is-loading')).toBe(false);
      expect(
        container?.querySelector('.message-history-banner')?.classList.contains('is-loading')
      ).toBe(false);

      sticky?.click();
      expect(sticky?.classList.contains('is-loading')).toBe(true);

      resetSessionMessageWindowForRefetch('session-1');
      setSessionHistoryCursor('session-1', 'cursor-current');
      markSessionHistoryLoadFailed('session-1', true);
      await Promise.resolve();

      expect(sticky?.classList.contains('is-loading')).toBe(false);
      const retry = container?.querySelector<HTMLButtonElement>('.message-history-banner-retry');
      expect(retry).toBeInstanceOf(HTMLButtonElement);
      expect(retry?.disabled).toBe(false);
      retry?.click();
      await vi.waitFor(() => {
        expect(messagesSpy).toHaveBeenCalledWith('session-1', {
          limit: 200,
          before: 'cursor-current',
        });
      });
    } finally {
      releaseStalePage?.(stalePage);
      await vi.advanceTimersByTimeAsync(0);
      animationFrames.restore();
    }
  });

  it('uses an older previewable boundary prompt when the newest cached prompt is empty', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-older');
    setSessionHistoryPrompts('session-1', [
      {
        info: userMessage('boundary-visible'),
        parts: [textPart('boundary-visible-text', 'Previewable boundary prompt')],
      },
      { info: userMessage('boundary-empty'), parts: [] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Previewable boundary prompt'
    );
    animationFrames.restore();
  });

  it('keeps an unloaded boundary sticky mounted while prompt history refreshes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.dataset.msgId === 'assistant-1') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 800 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Boundary prompt');

    setSessionHistoryPrompts('session-1', []);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    await Promise.resolve();

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    animationFrames.restore();
  });

  it('keeps sticky navigation pending while history anchoring owns scroll', async () => {
    // This verifies scroll-owner ordering; destination geometry is covered by the alignment cases.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    let releaseHistory: (() => void) | undefined;
    const historyPending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    markSessionHistoryLoadFailed('session-1', true);
    setSessionHistoryPrompts('session-1', [
      { info: userMessage('boundary-user'), parts: [textPart('boundary-text', 'Boundary prompt')] },
    ]);
    vi.spyOn(client.session, 'messages').mockImplementation(async () => {
      await historyPending;
      return [
        {
          info: userMessage('boundary-user'),
          parts: [textPart('boundary-text', 'Boundary prompt')],
        },
      ];
    });
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('assistant-text', 'Visible response')],
      },
    ]);
    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, 20, 500, 320);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    rectMap.set(list, new DOMRect(0, 0, 500, 500));
    const retry = container?.querySelector<HTMLButtonElement>('.message-history-banner-retry');
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry?.click();
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(client.session.messages).toHaveBeenCalledWith('session-1', {
        limit: 200,
        before: 'cursor-1',
      });
    });
    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Boundary prompt');
    sticky?.click();
    expect(sticky?.classList.contains('is-loading')).toBe(true);

    releaseHistory?.();
    await vi.waitFor(() => {
      expect(state.messages.some((message) => message.info.id === 'boundary-user')).toBe(true);
    });
    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    expect(sticky?.classList.contains('is-loading')).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();

    animationFrames.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(sticky?.isConnected).toBe(true);
    expect(sticky?.classList.contains('is-loading')).toBe(true);

    for (let frame = 0; frame < 5; frame += 1) {
      animationFrames.flush();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
    animationFrames.restore();
  });

  it('does not show a new sticky preview until the prompt is clearly above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: previewFixture,
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: -10,
        rowBottom: 8,
        viewportHeight: 500,
        previousPreviewId: 'user-2',
      })
    ).toBe(false);
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

describe('MessageList empty state', () => {
  it('shows the starter logo for a blank new chat', () => {
    setState('emptyStateLogoUri', 'https://example.test/logo.svg');
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Blank session',
        version: '1',
        time: { created: 100, updated: 100 },
      },
    ]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);

    expect(container?.querySelector('.chat-empty-state')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-empty-logo')).toBeInstanceOf(HTMLImageElement);
    const hints = container?.querySelectorAll('.chat-empty-hint');
    expect(hints?.length).toBe(3);
    expect(container?.querySelector('.chat-empty-hints')?.textContent).toContain('add files');
  });

  it('omits the logo image when no logo URI is available but keeps the hints', () => {
    setState('emptyStateLogoUri', '');
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Blank session',
        version: '1',
        time: { created: 100, updated: 100 },
      },
    ]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);

    expect(container?.querySelector('.chat-empty-state')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-empty-logo')).toBeNull();
    expect(container?.querySelectorAll('.chat-empty-hint')).toHaveLength(3);
  });

  it('does not show the starter logo while switching to an existing chat with no loaded messages yet', () => {
    setState('emptyStateLogoUri', 'https://example.test/logo.svg');
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Existing session',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => MessageList(), container!);

    expect(container?.querySelector('.chat-empty-state')).toBeNull();
    expect(container?.querySelector('.chat-empty-logo')).toBeNull();
  });

  it('shows the parent starter state when only a hidden child message is retained', () => {
    setState('emptyStateLogoUri', 'https://example.test/logo.svg');
    setSessions([
      session('session-1'),
      session('child-1', { parentID: 'session-1', time: { created: 2, updated: 3 } }),
    ]);
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('child-assistant', { sessionID: 'child-1' }),
        parts: [
          {
            ...textPart('child-text', 'Hidden child response'),
            sessionID: 'child-1',
            messageID: 'child-assistant',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);

    expect(container?.querySelector('[data-msg-id]')).toBeNull();
    expect(container?.querySelector('.chat-empty-state')).toBeInstanceOf(HTMLDivElement);
  });
});

describe('MessageList session scoping', () => {
  it('reacts synchronously when only the active session changes', async () => {
    setSessions([session('session-1'), session('session-2')]);
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: userMessage('session-1-message'),
        parts: [
          {
            ...textPart('session-1-text', 'Session one'),
            messageID: 'session-1-message',
          },
        ],
      },
      {
        info: { ...userMessage('session-2-message'), sessionID: 'session-2' },
        parts: [
          {
            ...textPart('session-2-text', 'Session two'),
            sessionID: 'session-2',
            messageID: 'session-2-message',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(
      [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')].map((row) => row.dataset.msgId)
    ).toEqual(['session-1-message']);

    setState('activeSessionId', 'session-2');

    expect(
      [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')].map((row) => row.dataset.msgId)
    ).toEqual(['session-2-message']);
  });

  it('hides child-session user prompts in the parent thread before subagent output arrives', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Research child',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ]);

    const messages: MessageEntry[] = [
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: {
          id: 'user-child-1',
          sessionID: 'child-1',
          role: 'user',
          time: { created: 3 },
          agent: 'explore',
          model: { providerID: 'openai', modelID: 'gpt-5.4' },
        },
        parts: [
          {
            id: 'text-child-1',
            sessionID: 'child-1',
            messageID: 'user-child-1',
            type: 'text',
            text: 'Research worktree internals',
          },
        ],
      },
    ];

    expect(
      getVisibleThreadMessages(messages, 'session-1').map((messageEntry) => messageEntry.info.id)
    ).toEqual(['user-root-1']);
    expect(
      getVisibleThreadMessages(messages, 'child-1').map((messageEntry) => messageEntry.info.id)
    ).toEqual(['user-child-1']);
  });

  it('hides child-session assistant output in the parent thread filter', () => {
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Research child',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ]);

    const messages: MessageEntry[] = [
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: assistantMessage('assistant-child-1', {
          sessionID: 'child-1',
          mode: 'subagent',
          parentID: 'assistant-root-1',
        }),
        parts: [
          {
            id: 'text-child-1',
            sessionID: 'child-1',
            messageID: 'assistant-child-1',
            type: 'text',
            text: 'Streaming child output',
          },
        ],
      },
    ];

    expect(
      getVisibleThreadMessages(messages, 'session-1').map((messageEntry) => messageEntry.info.id)
    ).toEqual(['user-root-1']);
    expect(
      getVisibleThreadMessages(messages, 'child-1').map((messageEntry) => messageEntry.info.id)
    ).toEqual(['assistant-child-1']);
  });

  it('hides child-session messages in the parent thread', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Explore Varro codebase structure',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ]);
    replaceMessages([
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: assistantMessage('assistant-root-1', { parentID: 'user-root-1' }),
        parts: [textPart('text-root-2', 'Root response')],
      },
      {
        info: {
          id: 'user-child-1',
          sessionID: 'child-1',
          role: 'user',
          time: { created: 3 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.4' },
        },
        parts: [
          {
            id: 'text-child-1',
            sessionID: 'child-1',
            messageID: 'user-child-1',
            type: 'text',
            text: 'Explore Varro codebase structure',
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          sessionID: 'child-1',
          mode: 'subagent',
          agent: 'explore',
          parentID: 'assistant-root-1',
          time: { created: 4, completed: 5 },
        }),
        parts: [
          {
            id: 'text-child-2',
            sessionID: 'child-1',
            messageID: 'assistant-child-1',
            type: 'text',
            text: 'Subagent result',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Root prompt');
    expect(container?.textContent).toContain('Root response');
    expect(container?.textContent).not.toContain('Explore Varro codebase structure');
    expect(container?.textContent).not.toContain('Subagent result');
  });

  it('keeps the visible parent error retryable when a hidden child assistant is newer', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([session('session-1'), session('child-1', { parentID: 'session-1' })]);
    replaceMessages([
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: assistantMessage('assistant-root-1', {
          error: { name: 'APIError', data: { message: 'Root response failed' } },
          parentID: 'user-root-1',
        }),
        parts: [],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'assistant-root-1',
          sessionID: 'child-1',
        }),
        parts: [
          {
            ...textPart('text-child-1', 'Hidden child response'),
            messageID: 'assistant-child-1',
            sessionID: 'child-1',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const retry = [...(container?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    expect(retry).toBeInstanceOf(HTMLButtonElement);
  });

  it('does not let hidden child-session models create parent-thread switch markers', async () => {
    setState('activeSessionId', 'session-1');
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.4': {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            capabilities: { reasoning: true, toolcall: true, attachment: true },
            cost: { input: 0, output: 0 },
            variants: { medium: {}, high: {} },
          },
        },
      },
    ]);
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Explore Varro codebase structure',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ]);
    replaceMessages([
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: assistantMessage('assistant-root-1', { parentID: 'user-root-1', variant: 'high' }),
        parts: [textPart('text-root-2', 'Root response')],
      },
      {
        info: assistantMessage('assistant-child-1', {
          sessionID: 'child-1',
          parentID: 'assistant-root-1',
          variant: 'medium',
        }),
        parts: [textPart('text-child-1', 'Hidden child response')],
      },
      {
        info: assistantMessage('assistant-root-2', { parentID: 'user-root-1', variant: 'high' }),
        parts: [textPart('text-root-3', 'Continuing root response')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Root response');
    expect(container?.textContent).toContain('Continuing root response');
    expect(container?.textContent).not.toContain('Hidden child response');
    expect(container?.textContent).not.toContain('Switched to High');
  });

  it('keeps child-session streaming text out of the parent thread', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Explore Varro codebase structure',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ]);
    replaceMessages([
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: assistantMessage('assistant-child-1', {
          sessionID: 'child-1',
          mode: 'subagent',
          agent: 'explore',
          parentID: 'assistant-root-1',
          time: { created: 4 },
        }),
        parts: [
          {
            id: 'text-child-1',
            sessionID: 'child-1',
            messageID: 'assistant-child-1',
            type: 'text',
            text: 'Partial subagent result',
          },
        ],
      },
    ]);
    setState('streamingPartId', 'text-child-1');
    setState('streamingText', 'Partial subagent result that should stay hidden');

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Root prompt');
    expect(container?.textContent).not.toContain('Partial subagent result');
    expect(container?.textContent).not.toContain('should stay hidden');
  });

  it('shows child-session assistant messages when the child session is active', async () => {
    setState('activeSessionId', 'child-1');
    setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Explore Varro codebase structure',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ]);
    replaceMessages([
      { info: userMessage('user-root-1'), parts: [textPart('text-root-1', 'Root prompt')] },
      {
        info: assistantMessage('assistant-child-1', {
          sessionID: 'child-1',
          mode: 'subagent',
          agent: 'explore',
          parentID: 'assistant-root-1',
          time: { created: 4, completed: 5 },
        }),
        parts: [
          {
            id: 'text-child-1',
            sessionID: 'child-1',
            messageID: 'assistant-child-1',
            type: 'text',
            text: 'Subagent result',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).not.toContain('Root prompt');
    expect(container?.textContent).toContain('Subagent result');
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

describe('MessageList sticky prompt preview', () => {
  it('builds shared tool prompt lookups once per render for tool-heavy chats', async () => {
    const questionLookupSpy = vi.spyOn(toolCallMatching, 'buildQuestionRequestLookup');
    const permissionLookupSpy = vi.spyOn(toolCallMatching, 'buildPermissionRequestLookup');

    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [
          {
            ...toolPart('tool-1', 'assistant-1', 'call-1'),
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: '',
              title: 'pwd',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
          {
            ...toolPart('tool-2', 'assistant-1', 'call-2'),
            state: {
              status: 'completed',
              input: { command: 'ls' },
              output: '',
              title: 'ls',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
          {
            ...toolPart('tool-3', 'assistant-1', 'call-3'),
            state: {
              status: 'completed',
              input: { command: 'git status' },
              output: '',
              title: 'git status',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ],
      },
    ]);
    setState('questions', [
      {
        id: 'question-1',
        sessionID: 'session-1',
        tool: { messageID: 'assistant-1', callID: 'call-1' },
        questions: [{ question: 'Proceed?', header: 'Confirm', options: [] }],
      },
    ]);
    setState('permissions', [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        callID: 'call-2',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(questionLookupSpy).toHaveBeenCalledTimes(1);
    expect(permissionLookupSpy).toHaveBeenCalledTimes(1);
  });

  it('limits assistant dialog summaries to rendered messages when virtualized', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 4_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 5_000, completed: 6_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];

    const summaries = getAssistantDialogSummaryMap(messages, new Set(['assistant-2']));

    expect(summaries.has('assistant-1')).toBe(false);
    expect(summaries.get('assistant-2')).toMatchObject({
      durationMs: 2_000,
      inputTokens: 200,
      outputTokens: 20,
      agentCount: 0,
    });
  });

  it('suppresses only the trailing assistant summary while a turn is still active', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 4_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 5_000, completed: 6_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, {
      suppressTrailingSummary: true,
    });

    expect(summaries.has('assistant-1')).toBe(true);
    expect(summaries.has('assistant-2')).toBe(false);
  });

  it('does not let a hidden child prompt split the parent worked summary', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      session('session-1'),
      session('child-1', { parentID: 'session-1', time: { created: 2_500, updated: 4_000 } }),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Review the changes')],
      },
      {
        info: assistantMessage('assistant-1', {
          parentID: 'user-1',
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'I will inspect the runtime.')],
      },
      {
        info: {
          ...userMessage('child-user-1'),
          sessionID: 'child-1',
          time: { created: 2_500 },
        },
        parts: [
          {
            ...textPart('text-child-user-1', 'Review runtime changes'),
            sessionID: 'child-1',
            messageID: 'child-user-1',
          },
        ],
      },
      {
        info: assistantMessage('child-assistant-1', {
          sessionID: 'child-1',
          mode: 'subagent',
          parentID: 'assistant-1',
          time: { created: 2_600, completed: 4_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: assistantMessage('assistant-2', {
          parentID: 'user-1',
          time: { created: 4_100, completed: 6_000 },
          tokens: { input: 300, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-2', 'The changed production path continues here.')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(
      container?.querySelector('[data-msg-id="assistant-1"] .assistant-dialog-summary')
    ).toBeNull();
    expect(container?.querySelector('.trailing-assistant-summary-row')?.textContent).toContain(
      'Worked for 5s - Tokens ↑ 600 ↓ 60 - Agents 1'
    );
  });

  it('keeps final assistant answers plain when virtualization hides the summary row', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        if (index === 58) {
          return {
            info: { ...userMessage(`user-${index}`), time: { created: index * 1000 } },
            parts: [textPart(`text-user-${index}`, `Prompt ${index}`)],
          };
        }

        if (index === 59) {
          return {
            info: assistantMessage(`assistant-${index}`, {
              time: { created: index * 1000 + 100, completed: index * 1000 + 900 },
              tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
            parts: [textPart(`text-assistant-${index}`, 'Final visible response')],
          };
        }

        return {
          info: assistantMessage(`assistant-${index}`),
          parts: [textPart(`text-${index}`, `Response ${index}`)],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 9600 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 9200 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const finalResponse = container?.querySelector(
      '[data-msg-id="assistant-59"] .chat-turn-content'
    );
    expect(finalResponse?.className).toContain('assistant-turn-content-plain');
    expect(finalResponse?.className).not.toContain('assistant-turn-content-highlighted');

    animationFrames.restore();
  });

  it('updates Worked for summaries when the virtualized range changes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 30 }, (_, index) => {
        const created = index * 10_000;
        return [
          {
            info: { ...userMessage(`user-${index}`), time: { created } },
            parts: [textPart(`text-user-${index}`, `Prompt ${index}`)],
          },
          {
            info: assistantMessage(`assistant-${index}`, {
              time: { created: created + 1_000, completed: created + 2_000 },
              tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
            parts: [textPart(`text-assistant-${index}`, `Response ${index}`)],
          },
        ];
      }).flat()
    );

    try {
      cleanup = render(() => MessageList(), container!);
      await Promise.resolve();

      const list = container?.querySelector('.interactive-list') as HTMLDivElement;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 9_600 });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 9_200,
      });
      list.dispatchEvent(new Event('scroll'));
      animationFrames.flush();
      await Promise.resolve();

      cacheSessionHistoryPage('session-1', 'bottom-range', [state.messages[0]!]);
      await Promise.resolve();
      expect(container?.querySelector('.trailing-assistant-summary-row')?.textContent).toContain(
        'Worked for 2s'
      );

      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(
        container?.querySelector('[data-msg-id="assistant-0"] .assistant-dialog-summary')
          ?.textContent
      ).toContain('Worked for 2s');

      cacheSessionHistoryPage('session-1', 'top-range', [state.messages[0]!]);
      await Promise.resolve();
      list.scrollTop = 9_200;
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(container?.querySelector('.trailing-assistant-summary-row')?.textContent).toContain(
        'Worked for 2s'
      );
    } finally {
      animationFrames.restore();
    }
  });

  it('summarizes elapsed time and tokens across nested agent children', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      session('child-1', {
        parentID: 'session-1',
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      session('child-2', {
        parentID: 'child-1',
        tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          textPart('text-2', 'Response'),
          {
            id: 'agent-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'agent',
            name: 'explore',
          },
          { ...textPart('text-3', 'Final response'), messageID: 'assistant-1' },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'assistant-1',
          sessionID: 'child-1',
          time: { created: 2_500, completed: 8_000 },
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: assistantMessage('assistant-child-2', {
          mode: 'subagent',
          parentID: 'assistant-child-1',
          sessionID: 'child-2',
          time: { created: 3_000, completed: 11_000 },
          tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 3,100 ↓ 310 - Agents 2');
  });

  it('includes nested subagent session snapshots when their messages are not loaded', async () => {
    setState('activeSessionId', 'session-1');
    setSessions([
      session('session-1'),
      session('child-1', {
        parentID: 'session-1',
        time: { created: 2_500, updated: 8_000 },
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      session('child-2', {
        parentID: 'child-1',
        time: { created: 3_000, updated: 11_000 },
        tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'agent-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'agent',
            name: 'explore',
          },
          { ...textPart('text-2', 'Final response'), messageID: 'assistant-1' },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 4s - Tokens ↑ 3,100 ↓ 310');
  });

  it('keeps subagent session tokens scoped to the turn that launched them', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'task-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'tool' as const,
            callID: 'call-1',
            tool: 'task',
            state: {
              status: 'completed' as const,
              input: {},
              output: '',
              title: 'First task',
              metadata: { sessionId: 'child-1' },
              time: { start: 2_000, end: 3_000 },
            },
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'session-1',
          sessionID: 'child-1',
          time: { created: 2_500, completed: 3_000 },
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 4_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 5_000, completed: 6_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'task-2',
            sessionID: 'session-1',
            messageID: 'assistant-2',
            type: 'tool' as const,
            callID: 'call-2',
            tool: 'task',
            state: {
              status: 'completed' as const,
              input: {},
              output: '',
              title: 'Second task',
              metadata: { sessionId: 'child-2' },
              time: { start: 5_000, end: 6_000 },
            },
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-2', {
          mode: 'subagent',
          parentID: 'session-1',
          sessionID: 'child-2',
          time: { created: 5_500, completed: 6_000 },
          tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];
    const sessions = [
      session('child-1', {
        parentID: 'session-1',
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      session('child-2', {
        parentID: 'session-1',
        tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, { sessions });

    expect(summaries.get('assistant-1')).toMatchObject({ inputTokens: 1_100, outputTokens: 110 });
    expect(summaries.get('assistant-2')).toMatchObject({ inputTokens: 2_200, outputTokens: 220 });
  });

  it('does not attach a late task session to the preceding assistant turn', () => {
    const messages = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt 1')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 1_100, completed: 1_500 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'task-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'tool' as const,
            callID: 'call-1',
            tool: 'task',
            state: {
              status: 'completed' as const,
              input: { description: 'Late task' },
              output: '',
              title: 'Late task',
              metadata: {},
              time: { start: 1_200, end: 1_400 },
            },
          },
        ],
      },
      {
        info: { ...userMessage('user-2'), time: { created: 2_000 } },
        parts: [textPart('text-2', 'Prompt 2')],
      },
      {
        info: assistantMessage('assistant-2', {
          time: { created: 2_100, completed: 2_500 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];
    const sessions = [
      session('late-child', {
        parentID: 'session-1',
        title: 'Late task',
        time: { created: 2_100, updated: 2_500 },
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, { sessions });

    expect(summaries.get('assistant-1')).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it('keeps stopped assistant turns out of final answer formatting while preserving the summary', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 11_000 },
          error: { name: 'aborted', data: { message: 'Aborted' } },
          tokens: { input: 12, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            ...textPart('text-assistant-1', 'Partial response before stop'),
            messageID: 'assistant-1',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const response = container?.querySelector('[data-msg-id="assistant-1"] .chat-turn-content');
    expect(response?.className).toContain('assistant-turn-content-plain');
    expect(response?.className).not.toContain('assistant-turn-content-highlighted');
    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 12 ↓ 4');
  });

  it('includes prefetched turn history in the Worked for summary', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-1');
    replaceMessages([
      {
        info: assistantMessage('assistant-2', {
          time: { created: 6_000, completed: 11_000 },
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-2', 'Visible response')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.textContent).toContain('Collecting stats...');
    expect(container?.textContent).not.toContain('Worked for 5s - Tokens ↑ 200 ↓ 20');

    cacheSessionHistoryPage('session-1', 'cursor-1', [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Earlier response')],
      },
    ]);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 300 ↓ 30');
    expect(container?.querySelector('[data-msg-id="assistant-1"]')).toBeNull();
  });

  it('omits the token summary when input and output tokens are zero', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 11_000 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            ...textPart('text-assistant-1', 'Received.'),
            messageID: 'assistant-1',
          },
        ],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s');
    expect(container?.textContent).not.toContain('Tokens');
  });

  it('summarizes in and out tokens for subagent sessions parented to the root session', () => {
    const messages: MessageEntry[] = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [
          {
            id: 'agent-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'agent',
            name: 'explore',
          },
        ],
      },
      {
        info: assistantMessage('assistant-child-1', {
          mode: 'subagent',
          parentID: 'session-1',
          sessionID: 'child-1',
          time: { created: 2_500, completed: 8_000 },
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];

    const summaries = getAssistantDialogSummaryMap(messages, new Set(['assistant-1']));

    expect(summaries.get('assistant-1')).toMatchObject({
      durationMs: 7_000,
      inputTokens: 1_100,
      outputTokens: 110,
      agentCount: 1,
    });
  });

  it('does not summarize a completed assistant while its latest tool is still running', () => {
    const messages: MessageEntry[] = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [toolPart('tool-1', 'assistant-1')],
      },
    ];

    expect(getAssistantDialogSummaryMap(messages).has('assistant-1')).toBe(false);

    messages[1]!.parts = [
      {
        ...toolPart('tool-1', 'assistant-1'),
        state: {
          status: 'completed',
          input: { command: 'pwd' },
          output: '/workspace',
          title: 'Run pwd',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ];

    expect(getAssistantDialogSummaryMap(messages).get('assistant-1')).toMatchObject({
      durationMs: 4_000,
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it('updates the cached assistant summary after a completed tool receives final text', async () => {
    const runningTool = toolPart('tool-1', 'assistant-1');
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [runningTool],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('.assistant-dialog-summary')).toBeNull();

    upsertPart({
      ...runningTool,
      type: 'tool',
      state: {
        status: 'completed',
        input: { command: 'pwd' },
        output: '/workspace',
        title: 'Run pwd',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    await Promise.resolve();

    expect(container?.querySelector('.assistant-dialog-summary')).toBeNull();

    upsertPart({
      ...textPart('text-final', 'Done.'),
      messageID: 'assistant-1',
    });
    await Promise.resolve();
    vi.advanceTimersByTime(700);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 4s - Tokens ↑ 100 ↓ 10');
  });

  it('renders with virtualization enabled without hitting initialization order errors', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    expect(() => {
      cleanup = render(() => MessageList(), container!);
    }).not.toThrow();

    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list')).toBeInstanceOf(HTMLDivElement);

    animationFrames.restore();
  });

  it('adds the model-picker modifier class while the model selector is open', async () => {
    setShowModelPicker(true);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list')?.className).toContain(
      'showing-model-picker'
    );
  });

  it('keeps abandoned content rendered below the message being edited', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      { info: userMessage('user-3'), parts: [textPart('text-5', 'Prompt 3')] },
      { info: assistantMessage('assistant-3'), parts: [textPart('text-6', 'Response 3')] },
    ]);
    startEditingMessage('user-2', 'session-1', 'Prompt 2');

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list')?.className).toContain('editing-message');
    expect(container?.querySelector('[data-msg-id="user-1"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-1"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="user-2"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-2"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.className).toContain(
      'interactive-item-edit-abandoned'
    );
    expect(container?.querySelector('[data-msg-id="user-3"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-3"]')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="user-3"]')?.className).toContain(
      'interactive-item-edit-abandoned'
    );
    expect(container?.querySelector('[data-msg-id="assistant-3"]')?.className).toContain(
      'interactive-item-edit-abandoned'
    );
  });

  it('prevents scrolling down past the edited message top', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);
    startEditingMessage('user-2', 'session-1', 'Prompt 2');

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, 0, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const editedRow = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(editedRow).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 500 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(editedRow!, new DOMRect(0, -120, 500, 80));

    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    expect(list!.scrollTop).toBe(372);

    list!.scrollTop = 350;
    rectMap.set(editedRow!, new DOMRect(0, 22, 500, 80));

    const wheelAllowed = list?.dispatchEvent(
      new WheelEvent('wheel', { cancelable: true, deltaY: 80 })
    );

    expect(wheelAllowed).toBe(false);
    expect(list!.scrollTop).toBe(364);
  });

  it('reveals a partially hidden message panel when editing starts', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let scrollTopValue = 500;
    let editedRowDocumentTop = 380;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.dataset.msgId === 'user-2') {
          return new DOMRect(0, editedRowDocumentTop - scrollTopValue, 500, 180);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(372);
    editedRowDocumentTop = 340;
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(332);

    animationFrames.restore();
  });

  it('suspends bottom follow on edit entry until an explicit follow request', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollHeightValue = 1200;
    let trackHeight = 1200;
    const assignedScrollTops: number[] = [];

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId === 'user-2') {
          return new DOMRect(0, 700 - scrollTopValue, 500, 80);
        }
        return new DOMRect(0, 0, 500, 100);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    startEditingMessage('user-2', 'session-1', 'Prompt 2');
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(692);

    trackHeight = 1400;
    scrollHeightValue = 1400;
    setState('streamingPartId', 'text-4');
    setState('streamingText', 'Streaming growth while editing');
    await Promise.resolve();

    expect(assignedScrollTops).not.toContain(1000);
    expect(scrollTopValue).toBe(692);

    resetMessageEditState();
    trackHeight = 1600;
    scrollHeightValue = 1600;
    setState('streamingText', 'More streaming growth after edit cancellation');
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(assignedScrollTops).not.toContain(1200);
    expect(scrollTopValue).toBe(692);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(1200);
    animationFrames.restore();
  });

  it('shows the prompt that belongs to the response currently in view', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      { info: userMessage('user-3'), parts: [textPart('text-5', 'Prompt 3')] },
      { info: assistantMessage('assistant-3'), parts: [textPart('text-6', 'Response 3')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || defaultRect;
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const user3Row = container?.querySelector('[data-msg-id="user-3"]') as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    const assistant3Row = container?.querySelector(
      '[data-msg-id="assistant-3"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user3Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant3Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));

    rectMap.set(user2Row!, new DOMRect(0, -220, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, -340, 500, 300));
    rectMap.set(user3Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(assistant3Row!, new DOMRect(0, 40, 500, 320));

    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    let sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 3');

    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));
    rectMap.set(user3Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant3Row!, new DOMRect(0, 20, 500, 320));

    list!.scrollTop = 1400;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 2');
    expect(
      container?.querySelectorAll('.interactive-list-track .latest-user-message-sticky')
    ).toHaveLength(1);
    expect(container?.querySelector('.latest-user-message-sticky [data-msg-id]')).toBeNull();

    animationFrames.restore();
  });

  it('uses mounted row geometry when virtual metrics point at a later turn', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 30 }, (_, turn) => [
        {
          info: userMessage(`user-${turn}`),
          parts: [textPart(`user-text-${turn}`, `Prompt ${turn}`)],
        },
        {
          info: assistantMessage(`assistant-${turn}`),
          parts: [textPart(`assistant-text-${turn}`, `Response ${turn}`)],
        },
      ]).flat()
    );

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-17') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-17') return new DOMRect(0, 20, 500, 160);
        if (this.dataset.msgId) return new DOMRect(0, -600, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 9_600 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 6_400 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 17');

    animationFrames.restore();
  });

  it('keeps the previous sticky prompt while the next user row is lower in the viewport', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 30 }, (_, turn) => [
        {
          info: userMessage(`user-${turn}`),
          parts: [textPart(`user-text-${turn}`, `Prompt ${turn}`)],
        },
        {
          info: assistantMessage(`assistant-${turn}`),
          parts: [textPart(`assistant-text-${turn}`, `Response ${turn}`)],
        },
      ]).flat()
    );

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-20') return new DOMRect(0, 280, 500, 52);
        if (this.dataset.msgId) return new DOMRect(0, -600, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 9_600 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 6_400 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 19');

    animationFrames.restore();
  });

  it('keeps the sticky prompt mounted while new assistant activity events arrive', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let assistantTop = 20;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 1_200);
        }
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, assistantTop, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 700 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 1');

    const activity = toolPart('search-1', 'assistant-1', 'call-search-1');
    activity.tool = 'grep';
    assistantTop = -600;
    upsertPart(activity);
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    await Promise.resolve();

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);

    // Incoming events can leave the row between painted layouts for longer than the debounce.
    // Keep the existing prompt until geometry positively says its source is visible or overlapped.
    await vi.advanceTimersByTimeAsync(100);

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);

    assistantTop = 20;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    await Promise.resolve();

    upsertPart({
      ...activity,
      state: {
        status: 'completed',
        input: { pattern: 'sticky' },
        output: 'Found matches',
        title: 'Searching',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    await Promise.resolve();

    expect(sticky?.isConnected).toBe(true);
    expect(container?.querySelector('.latest-user-message-sticky')).toBe(sticky);
    animationFrames.restore();
  });

  it('hands off to the previous sticky after the next prompt clears the overlay', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let user2Top = -62;
    let assistant1Top = -600;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky-text')) {
          return new DOMRect(0, 22, 500, 18);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -700, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, assistant1Top, 500, 90);
        if (messageId === 'user-2') return new DOMRect(0, user2Top, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, 20, 500, 320);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );
    // A projected crossing that does not move the source must restore the current sticky.
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();
    vi.advanceTimersByTime(181);
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 2'
    );
    const stickyText = container?.querySelector<HTMLElement>('.latest-user-message-sticky-text');
    expect(stickyText).toBeInstanceOf(HTMLDivElement);
    stickyText!.style.maxHeight = '72px';

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = 70;
    assistant1Top = 20;
    list.scrollTop = 1_180;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = 120;
    list.scrollTop = 1_160;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    user2Top = 150;
    list.scrollTop = 1_140;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')?.textContent).toContain(
      'Prompt 1'
    );
    animationFrames.restore();
  });

  it('synchronously hides the previous sticky before the next user row enters its painted overlay', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 10, 500, 50);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 20, 500, 280);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1_200 });

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 90;
    list!.scrollTop = 1_330;
    list?.dispatchEvent(new Event('scroll'));
    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    animationFrames.restore();
  });

  it('hides the sticky when bottom-follow moves the next user row into its overlay', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 1_700);
        }
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 20, 500, 280);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_700 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 70;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    layoutObserver!.callback(
      [{ target: track } as unknown as ResizeObserverEntry],
      layoutObserver as unknown as ResizeObserver
    );
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    animationFrames.restore();
  });

  it('keeps the previous sticky when layout growth moves the next prompt below stale observer bounds', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const intersections = installControllableIntersectionObserver();
    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 10, 500, 50);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 0, 500, 500);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const assistant1 = container?.querySelector('[data-msg-id="assistant-1"]') as HTMLDivElement;
    const user2 = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });

    const emitVisibleBounds = (observedUserTop: number) =>
      intersections.emit([
        {
          target: assistant1,
          isIntersecting: true,
          rootBounds: new DOMRect(0, 0, 500, 500),
          boundingClientRect: new DOMRect(0, 0, 500, 500),
        },
        {
          target: user2,
          isIntersecting: true,
          rootBounds: new DOMRect(0, 0, 500, 500),
          boundingClientRect: new DOMRect(0, observedUserTop, 500, 52),
        },
      ]);

    emitVisibleBounds(220);
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 70;
    emitVisibleBounds(70);
    list.scrollTop = 1_350;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    nextUserTop = 360;
    list.scrollTop = 1_210;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    animationFrames.restore();
  });

  it('hides the previous sticky when the next prompt reaches it without a new observer callback', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const intersections = installControllableIntersectionObserver();
    let nextUserTop = 220;
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list')) return new DOMRect(0, 0, 500, 500);
        if (this.classList.contains('latest-user-message-sticky-overlay')) {
          return new DOMRect(0, 10, 500, 74);
        }
        if (this.classList.contains('latest-user-message-sticky')) {
          return new DOMRect(0, 10, 500, 50);
        }

        const messageId = this.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
        if (messageId === 'user-1') return new DOMRect(0, -100, 500, 52);
        if (messageId === 'assistant-1') return new DOMRect(0, 0, 500, 500);
        if (messageId === 'user-2') return new DOMRect(0, nextUserTop, 500, 52);
        if (messageId === 'assistant-2') return new DOMRect(0, nextUserTop + 80, 500, 160);
        return new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const assistant1 = container?.querySelector('[data-msg-id="assistant-1"]') as HTMLDivElement;
    const user2 = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_200 });

    intersections.emit([
      {
        target: assistant1,
        isIntersecting: true,
        rootBounds: new DOMRect(0, 0, 500, 500),
        boundingClientRect: new DOMRect(0, 0, 500, 500),
      },
      {
        target: user2,
        isIntersecting: true,
        rootBounds: new DOMRect(0, 0, 500, 500),
        boundingClientRect: new DOMRect(0, 220, 500, 52),
      },
    ]);
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('.latest-user-message-sticky')).toBeInstanceOf(HTMLDivElement);

    nextUserTop = 70;
    list.scrollTop = 1_350;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('.latest-user-message-sticky')).toBeNull();

    animationFrames.restore();
  });

  it('updates rendered messages synchronously without waiting for the next animation frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 240 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, value: 10_000 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 0 });

    const firstRenderedMessageIdBeforeScroll =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageIdBeforeScroll).toBe('assistant-0');

    list!.scrollTop = 3_600;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    list?.dispatchEvent(new Event('scroll'));
    list!.scrollTop = 4_800;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    const firstRenderedMessageIdAfterScroll =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageIdAfterScroll).not.toBe('assistant-0');

    animationFrames.flush();
    await Promise.resolve();

    const firstRenderedMessageIdAfterFrame =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageIdAfterFrame).not.toBe('assistant-0');

    animationFrames.restore();
  });

  it('shows sticky prompts for message IDs that are not valid CSS selector values', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const unusualUserId = 'user-2"]';
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage(unusualUserId), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const unusualUserRow = [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
      (element) => element.dataset.msgId === unusualUserId
    );
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;

    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(unusualUserRow).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(unusualUserRow!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Prompt 2');

    animationFrames.restore();
  });

  it.each([
    {
      kind: 'text',
      parts: [textPart('text-3', 'Prompt 2')],
    },
    {
      kind: 'image-only',
      parts: [filePart('image-2', 'Image 2')],
    },
  ])(
    'aligns a small-transcript $kind sticky jump to the real card without scrolling its parent',
    async ({ parts }) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      let list: HTMLDivElement | null = null;
      let scrollTopValue = 1200;
      let outerScrollTop = 75;
      const rowDocumentTop = 1120;
      const cardDocumentTop = 1140;
      const stickyGap = 14;
      const scrollIntoView = vi.fn(() => {
        scrollTopValue = rowDocumentTop;
        outerScrollTop = 0;
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });

      setState('activeSessionId', 'session-1');
      replaceMessages([
        { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
        { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
        { info: userMessage('user-2'), parts },
        { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
      ]);

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          if (this === list || this.classList.contains('interactive-list')) {
            return new DOMRect(0, 100, 500, 500);
          }
          const row = this.classList.contains('interactive-item-container')
            ? this
            : this.closest<HTMLElement>('[data-msg-id]');
          if (row?.dataset.msgId === 'user-2') {
            const documentTop = this.classList.contains('user-message-card')
              ? cardDocumentTop
              : rowDocumentTop;
            return new DOMRect(0, 100 + documentTop - scrollTopValue, 500, 52);
          }
          if (row?.dataset.msgId === 'assistant-2') {
            return new DOMRect(0, 120, 500, 320);
          }
          return new DOMRect(0, -600, 500, 40);
        }
      );

      cleanup = render(() => MessageList(), container!);
      await Promise.resolve();

      list = container?.querySelector('.interactive-list') as HTMLDivElement;
      const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
      const card = container?.querySelector(
        '[data-msg-id="user-2"] .user-message-card'
      ) as HTMLDivElement;
      Object.defineProperty(container!, 'scrollTop', {
        configurable: true,
        get: () => outerScrollTop,
        set: (value: number) => {
          outerScrollTop = value;
        },
      });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
      track.style.setProperty('--latest-user-message-sticky-gap', `${stickyGap}px`);

      list.dispatchEvent(new Event('scroll'));
      animationFrames.flush();
      await Promise.resolve();

      const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
      expect(sticky).toBeInstanceOf(HTMLDivElement);
      sticky?.click();

      const computedStickyGap = Number.parseFloat(
        getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
      );
      expect(
        Math.abs(
          card.getBoundingClientRect().top - list.getBoundingClientRect().top - computedStickyGap
        )
      ).toBeLessThanOrEqual(1);
      expect(outerScrollTop).toBe(75);
      expect(scrollIntoView).not.toHaveBeenCalled();
      animationFrames.restore();
    }
  );

  it('does not enter edit mode from a sticky click while the active session is running', async () => {
    // This verifies click ownership, not destination alignment.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    startLoading(1);
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.getAttribute('title')).toBe('Click to scroll to message');

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(editingMessage()).toBeNull();

    animationFrames.restore();
  });

  it('scrolls a measured terminal-attachment prompt within the message list only', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let outerScrollTop = 60;
    let targetLayoutShift = 0;
    let jumpStarted = false;
    const targetIndex = 40;
    const targetScrollTop = targetIndex * 120;
    const stickyTopInset = 13;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list) return new DOMRect(0, 0, 500, 500);
        const row = this.classList.contains('interactive-item-container')
          ? this
          : this.closest<HTMLElement>('.interactive-item-container');
        const messageIndex = Number(row?.dataset.msgId?.replace('message-', ''));
        if (Number.isFinite(messageIndex)) {
          const layoutShift = messageIndex === targetIndex ? targetLayoutShift : 0;
          return new DOMRect(0, messageIndex * 120 - scrollTopValue + layoutShift, 500, 120);
        }
        return new DOMRect(0, 0, 500, 500);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => ({
        info:
          index === targetIndex
            ? userMessage(`message-${index}`)
            : assistantMessage(`message-${index}`),
        parts:
          index === targetIndex
            ? [
                {
                  ...textPart(`text-${index}-1`, '[Working directory: /workspace/varro]'),
                  messageID: `message-${index}`,
                },
                {
                  ...textPart(
                    `text-${index}-2`,
                    '[Selection from terminal zsh]\n```text\nnpm run test:e2e\n3 failed\n```'
                  ),
                  messageID: `message-${index}`,
                },
              ]
            : [
                {
                  ...textPart(`text-${index}`, `Response ${index}`),
                  messageID: `message-${index}`,
                },
              ],
      }))
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(container!, 'scrollTop', {
      configurable: true,
      get: () => outerScrollTop,
      set: (value: number) => {
        outerScrollTop = value;
      },
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 6000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        if (!jumpStarted && value === targetScrollTop - stickyTopInset) {
          jumpStarted = true;
          targetLayoutShift = -100;
        }
      },
    });
    track.style.setProperty('--latest-user-message-sticky-gap', `${stickyTopInset}px`);

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    scrollTopValue = 42 * 120;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Terminal: zsh (2 lines)');
    sticky?.click();

    const computedStickyGap = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    expect(scrollTopValue).toBe(targetScrollTop - stickyTopInset);
    expect(
      container
        ?.querySelector<HTMLElement>(`[data-msg-id="message-${targetIndex}"] .user-message-card`)
        ?.getBoundingClientRect().top
    ).toBe(stickyTopInset - 100);
    animationFrames.flush();
    await Promise.resolve();
    const targetCard = container?.querySelector<HTMLElement>(
      `[data-msg-id="message-${targetIndex}"] .user-message-card`
    );
    expect(targetCard).toBeInstanceOf(HTMLDivElement);
    expect(
      Math.abs(
        targetCard!.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          computedStickyGap
      )
    ).toBeLessThanOrEqual(1);
    expect(outerScrollTop).toBe(60);

    const nestedScroller = document.createElement('div');
    nestedScroller.style.overflowY = 'auto';
    Object.defineProperty(nestedScroller, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(nestedScroller, 'scrollHeight', { configurable: true, value: 300 });
    Object.defineProperty(nestedScroller, 'scrollTop', { configurable: true, value: 50 });
    targetCard!.append(nestedScroller);
    const scrollTopBeforeNestedWheel = scrollTopValue;
    targetLayoutShift -= 40;
    nestedScroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));
    animationFrames.flush();
    await Promise.resolve();
    expect(scrollTopValue).toBe(scrollTopBeforeNestedWheel);
    targetLayoutShift += 40;

    const originalCard = container?.querySelector<HTMLElement>(
      `[data-msg-id="message-${targetIndex}"] .user-message-card`
    );
    originalCard?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editingMessage()?.messageId).toBe(`message-${targetIndex}`);
    const scrollTopAfterEdit = scrollTopValue;
    targetLayoutShift -= 50;
    for (let frame = 0; frame < 3; frame += 1) {
      animationFrames.flush();
      await Promise.resolve();
    }
    expect(scrollTopValue).toBe(scrollTopAfterEdit - 50);
    expect(scrollIntoView).not.toHaveBeenCalled();
    animationFrames.restore();
  });

  it('restores image attachments when editing a message selected through its sticky preview', async () => {
    // Sticky destination geometry is covered separately; this case owns edit-state restoration.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      {
        info: userMessage('user-2'),
        parts: [
          textPart('text-3', 'Still is shown as this. Before switching to [Image 2]'),
          filePart('image-2', 'Image 2'),
        ],
      },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    user2Card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toEqual({
      messageId: 'user-2',
      sessionId: 'session-1',
      text: 'Still is shown as this. Before switching to [Image 2]',
      context: {
        files: [],
        images: [
          {
            id: 'image-2',
            url: 'https://example.test/image-2.png',
            mime: 'image/png',
            filename: 'Image 2',
            size: 0,
          },
        ],
        terminalSelection: null,
      },
    });

    animationFrames.restore();
  });

  it('edits an image-only message after selecting it through the sticky preview', async () => {
    // Sticky destination geometry is covered separately; this case owns image-only edit state.
    const animationFrames = installQueuedAnimationFrameMocks();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      {
        info: userMessage('user-2'),
        parts: [filePart('image-2', 'Image 2')],
      },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -80, 500, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 20, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    const sticky = container?.querySelector<HTMLElement>('.latest-user-message-sticky');
    expect(sticky).toBeInstanceOf(HTMLDivElement);
    expect(sticky?.textContent).toContain('Attachment: Image 2');

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    user2Card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toEqual({
      messageId: 'user-2',
      sessionId: 'session-1',
      text: '',
      context: {
        files: [],
        images: [
          {
            id: 'image-2',
            url: 'https://example.test/image-2.png',
            mime: 'image/png',
            filename: 'Image 2',
            size: 0,
          },
        ],
        terminalSelection: null,
      },
    });

    animationFrames.restore();
  });

  it('hides the sticky preview as soon as any part of the prompt is visible outside it', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Response 2')] },
    ]);

    const rectMap = new Map<Element, DOMRect>();
    const defaultRect = new DOMRect(0, -600, 500, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectMap.get(this) || defaultRect;
      }
    );

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    const user2Row = container?.querySelector('[data-msg-id="user-2"]') as HTMLDivElement | null;
    const user2Card = container?.querySelector(
      '[data-msg-id="user-2"] .user-message-card'
    ) as HTMLDivElement | null;
    const assistant2Row = container?.querySelector(
      '[data-msg-id="assistant-2"]'
    ) as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);
    expect(user2Row).toBeInstanceOf(HTMLDivElement);
    expect(user2Card).toBeInstanceOf(HTMLDivElement);
    expect(assistant2Row).toBeInstanceOf(HTMLDivElement);

    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollTop', { configurable: true, writable: true, value: 1200 });
    rectMap.set(list!, new DOMRect(0, 0, 500, 500));
    rectMap.set(user2Row!, new DOMRect(0, -90, 500, 52));
    rectMap.set(user2Card!, new DOMRect(120, -90, 320, 52));
    rectMap.set(assistant2Row!, new DOMRect(0, 40, 500, 320));

    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    let sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky?.textContent).toContain('Prompt 2');
    expect(sticky).toBeInstanceOf(HTMLDivElement);

    rectMap.set(sticky!, new DOMRect(0, 10, 500, 50));

    rectMap.set(user2Card!, new DOMRect(120, 30, 320, 40));
    list!.scrollTop = 1210;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    await Promise.resolve();

    sticky = container?.querySelector('.latest-user-message-sticky');
    expect(sticky).toBeNull();

    animationFrames.restore();
  });
});

describe('MessageList loading row', () => {
  it('shows hours and minutes without seconds for hour-long durations', async () => {
    vi.setSystemTime(69 * 60_000 + 32_000);
    setState('activeSessionId', 'session-1');
    startLoading(0);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('1h 9m');
  });

  it('replaces the reserved row with the worked summary when an existing chat loads', async () => {
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);
    replaceMessages([]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(true);

    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 11_000 },
          tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Final response')],
      },
    ]);
    setState('messagesLoading', false);
    stopLoading();
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 ↓ 7');
    expect(
      container?.querySelector('.interactive-loading-row.trailing-assistant-summary-row')
    ).toBeInstanceOf(HTMLDivElement);
  });

  it('marks the loading row as stale after prolonged inactivity', async () => {
    vi.setSystemTime(0);
    setState('activeSessionId', 'session-1');
    startLoading(0);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(container?.textContent).not.toContain('Session may be stale');

    vi.advanceTimersByTime(91_000);
    await Promise.resolve();

    expect(container?.textContent).toContain('Session may be stale');
    expect(container?.querySelector('.loading-action')).toBeInstanceOf(HTMLButtonElement);
  });

  it('shows the loading row while visible reasoning is streaming', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [reasoningPart('reason-1', 'Analyzing')] },
    ]);
    setState('streamingPartId', 'reason-1');
    setState('streamingText', 'Analyzing');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
  });

  it('shows the loading row while hidden reasoning is streaming', async () => {
    setState('activeSessionId', 'session-1');
    setShowThinkingPreference(false);
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [reasoningPart('reason-1', 'Analyzing')] },
    ]);
    setState('streamingPartId', 'reason-1');
    setState('streamingText', 'Analyzing');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
  });

  it('shows the loading row while the active session status is busy', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(false);
  });

  it('keeps the loading row while the visible assistant reply is incomplete', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: assistantMessage('message-1', { time: { created: 1 } }), parts: [] }]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    stopLoading();
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(false);
  });

  it('does not keep the loading label for older incomplete assistant replies', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('user-text-1', 'First prompt')] },
      {
        info: assistantMessage('assistant-1', { time: { created: 2 } }),
        parts: [textPart('assistant-text-1', 'Intermediate answer')],
      },
      { info: userMessage('user-2'), parts: [textPart('user-text-2', 'Follow-up prompt')] },
      {
        info: assistantMessage('assistant-2', { time: { created: 3, completed: 4 } }),
        parts: [textPart('assistant-text-2', 'Final answer')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.loading-indicator')).toBeNull();
    expect(container?.querySelector('.trailing-assistant-summary-row')).toBeInstanceOf(
      HTMLDivElement
    );
  });

  it('reserves the loading row while visible text is streaming', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [textPart('text-1', 'Drafting')] },
    ]);
    setState('streamingPartId', 'text-1');
    setState('streamingText', 'Drafting');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(true);
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('immediately hides a visible loading label when final text is committed', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: assistantMessage('message-1'), parts: [] }]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(false);

    upsertPart({ ...textPart('text-1', 'Final answer'), messageID: 'message-1' });
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(true);
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hides the loading label when final text streams after a stale running tool', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('assistant-1'), parts: [toolPart('tool-1', 'assistant-1')] },
      {
        info: assistantMessage('assistant-2'),
        parts: [textPart('text-2', 'Final answer')],
      },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    setState('streamingPartId', 'text-2');
    setState('streamingText', 'Final answer');
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(true);
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the loading row reserved after final visible text completes while loading settles', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [textPart('text-1', 'Final answer')] },
    ]);
    setState('streamingPartId', 'text-1');
    setState('streamingText', 'Final answer');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(true);

    setState('streamingPartId', null);
    setState('streamingText', '');
    await Promise.resolve();
    vi.advanceTimersByTime(180);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(true);
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the loading row for a new prompt after the previous assistant completed', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [] },
      { info: assistantMessage('message-1'), parts: [textPart('text-1', 'Final answer')] },
      { info: userMessage('user-2'), parts: [] },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(false);
  });

  it('keeps the loading row directly after the last message', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([{ info: userMessage('user-1'), parts: [textPart('user-text-1', 'Prompt')] }]);
    startLoading(1);
    requestMessageListScrollToBottom('user-1');

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const messageRow = container?.querySelector('[data-msg-id="user-1"]');
    const loadingRow = container?.querySelector('.interactive-loading-row');
    expect(loadingRow).toBeInstanceOf(HTMLDivElement);
    expect(messageRow?.nextElementSibling).toBe(loadingRow);
  });

  it('keeps stale busy status hidden after the final assistant text completed', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: assistantMessage('message-1'), parts: [textPart('text-1', 'Final answer')] },
    ]);
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(true);
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the loading row while a visible tool is still running', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('message-1'),
        parts: [textPart('text-1', 'I will update the file.'), toolPart('tool-1')],
      },
    ]);
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(false);
    expect(row?.getAttribute('aria-hidden')).toBeNull();
  });

  it('hides the loading label while an active edit tool is shown inline', async () => {
    const patch = toolPart('patch-active');
    patch.tool = 'apply_patch';
    patch.state = {
      status: 'running',
      input: {
        patchText: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch',
      },
      title: 'Apply patch',
      time: { start: 1 },
    };
    setShowInlineFileChanges(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Apply the change')] },
      {
        info: assistantMessage('message-1', {
          parentID: 'user-1',
          time: { created: 1 },
        }),
        parts: [patch],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList).toContain('is-reserved');
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the loading label visible with a namespaced running task tool card', async () => {
    const tool = toolPart('tool-active', 'assistant-1', 'call-tool-active');
    tool.tool = 'opencode.task';
    tool.state = {
      status: 'running',
      input: { command: 'npm test' },
      title: 'npm test',
      time: { start: 1 },
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run tests')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [tool],
      },
    ]);
    setState('streamingPartId', 'tool-active');

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('.interactive-loading-row')?.classList).not.toContain(
      'is-reserved'
    );

    await vi.advanceTimersByTimeAsync(500);

    expect(container?.querySelector('.tool-invocation-task')).not.toBeNull();
    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList).not.toContain('is-reserved');
    expect(row?.getAttribute('aria-hidden')).toBeNull();
  });

  it('hides the loading label once a compact active tool row is visible', async () => {
    const tool = toolPart('tool-active', 'assistant-1', 'call-tool-active');
    tool.state = {
      status: 'running',
      input: { command: 'npm test' },
      title: 'npm test',
      time: { start: 1 },
    };
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Run tests')] },
      {
        info: assistantMessage('assistant-1', { parentID: 'user-1' }),
        parts: [tool],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();
    expect(container?.querySelector('.interactive-loading-row')?.classList).not.toContain(
      'is-reserved'
    );

    await vi.advanceTimersByTimeAsync(500);

    expect(container?.querySelector('[data-activity-part-id="tool-active"]')).not.toBeNull();
    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList).toContain('is-reserved');
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('re-shows the loading row only after a sustained visible-stream gap', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('message-1'),
        parts: [textPart('text-1', '[Working directory: /workspace]')],
      },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);

    setState('streamingPartId', 'text-1');
    setState('streamingText', 'Drafting');
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(true);

    setState('streamingPartId', null);
    setState('streamingText', '');
    await Promise.resolve();
    vi.advanceTimersByTime(599);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(true);

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(false);
  });

  it('does not flash the loading row when the final event arrives during the stream grace period', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('message-1'),
        parts: [textPart('text-1', '[Working directory: /workspace]')],
      },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    setState('streamingPartId', 'text-1');
    setState('streamingText', 'Final response');
    await Promise.resolve();
    setState('streamingPartId', null);
    setState('streamingText', '');
    await Promise.resolve();

    vi.advanceTimersByTime(599);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(true);

    stopLoading();
    vi.advanceTimersByTime(1);
    await Promise.resolve();

    const settledRow = container?.querySelector('.interactive-loading-row');
    expect(settledRow == null || settledRow.classList.contains('is-reserved')).toBe(true);
  });

  it('keeps the loading row reserved across brief inactive gaps', async () => {
    setState('activeSessionId', 'session-1');
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);

    stopLoading();
    await Promise.resolve();
    vi.advanceTimersByTime(599);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(true);

    startLoading(601);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.interactive-loading-row')?.classList.contains('is-reserved')
    ).toBe(false);
  });

  it('replaces the loading row immediately when the trailing worked summary settles', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 11_000 },
          tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Interim update')],
      },
    ]);
    startLoading(11_000);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).not.toContain('Worked for');

    stopLoading();
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 ↓ 7');
    expect(container?.querySelector('.trailing-assistant-summary-row')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(
      container?.querySelector('.trailing-assistant-summary-row .loading-indicator')
    ).toBeNull();
  });

  it('keeps the worked summary visible across post-completion signals until a new prompt', async () => {
    setState('activeSessionId', 'session-1');
    const completedDialog: MessageEntry[] = [
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000, completed: 11_000 },
          tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Final response')],
      },
    ];
    replaceMessages(completedDialog);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const workedRow = container?.querySelector('.trailing-assistant-summary-row');
    expect(workedRow).toBeInstanceOf(HTMLDivElement);

    batch(() => {
      startLoading(12_000);
      setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
    });
    await Promise.resolve();
    vi.advanceTimersByTime(700);
    await Promise.resolve();

    expect(container?.querySelector('.trailing-assistant-summary-row')).toBe(workedRow);
    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 ↓ 7');
    expect(container?.querySelector('.loading-indicator')).toBeNull();

    batch(() => {
      setState('streamingPartId', 'text-assistant-1');
      setState('streamingText', 'Final response');
    });
    await Promise.resolve();

    expect(container?.querySelector('.trailing-assistant-summary-row')).toBe(workedRow);
    expect(container?.querySelector('.loading-indicator')).toBeNull();

    replaceMessages([
      completedDialog[0]!,
      {
        info: assistantMessage('assistant-1', {
          time: { created: 2_000 },
          tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Final response')],
      },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('.trailing-assistant-summary-row')).toBe(workedRow);
    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 ↓ 7');
    expect(container?.querySelector('.loading-indicator')).toBeNull();

    batch(() => {
      setState('streamingPartId', null);
      setState('streamingText', '');
      replaceMessages([
        ...completedDialog,
        {
          info: { ...userMessage('user-2'), time: { created: 13_000 } },
          parts: [textPart('text-user-2', 'Follow-up prompt')],
        },
      ]);
    });
    await Promise.resolve();

    expect(container?.querySelector('.trailing-assistant-summary-row')).toBeNull();
    expect(container?.querySelector('.loading-indicator')).toBeInstanceOf(HTMLDivElement);
  });

  it('keeps an explicitly terminal worked summary visible while stale busy state settles', async () => {
    setState('activeSessionId', 'session-1');
    const terminalAssistant = assistantMessage('assistant-1', {
      time: { created: 2_000, completed: 11_000 },
      tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    terminalAssistant.finish = 'stop';
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: terminalAssistant,
        parts: [textPart('text-assistant-1', 'Final response')],
      },
    ]);
    startLoading(1_000);
    setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 ↓ 7');
    expect(container?.querySelector('.trailing-assistant-summary-row')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(container?.querySelector('.loading-indicator')).toBeNull();
  });

  it('does not show a trailing worked summary before the final text response', async () => {
    const prompt = {
      info: { ...userMessage('user-1'), time: { created: 1_000 } },
      parts: [{ ...textPart('text-user-1', 'Prompt'), messageID: 'user-1' }],
    };
    const completedTool = toolPart('tool-1', 'assistant-1');
    completedTool.tool = 'todowrite';
    completedTool.state = {
      status: 'completed',
      input: { todos: [{ content: 'Run the checks', status: 'in_progress' }] },
      output: 'Updated todos',
      title: 'Updating todos',
      metadata: {},
      time: { start: 3_000, end: 10_000 },
    };
    const toolStep = {
      info: assistantMessage('assistant-1', {
        time: { created: 2_000, completed: 11_000 },
        tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      parts: [
        { ...textPart('text-assistant-1', 'Running the checks.'), messageID: 'assistant-1' },
        completedTool,
      ],
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([prompt, toolStep]);
    startLoading(11_000);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    stopLoading();
    await Promise.resolve();
    vi.advanceTimersByTime(700);
    await Promise.resolve();

    expect(container?.textContent).not.toContain('Worked for');

    replaceMessages([
      prompt,
      toolStep,
      {
        info: assistantMessage('assistant-2', {
          time: { created: 12_000, completed: 13_000 },
          tokens: { input: 8, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [{ ...textPart('text-assistant-2', 'All checks pass.'), messageID: 'assistant-2' }],
      },
    ]);
    setState('streamingPartId', 'text-assistant-2');
    setState('streamingText', 'All checks pass.');
    await Promise.resolve();

    vi.advanceTimersByTime(700);
    await Promise.resolve();
    expect(container?.textContent).not.toContain('Worked for');

    setState('streamingPartId', null);
    setState('streamingText', '');
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 12s - Tokens ↑ 50 ↓ 10');
  });

  it('does not render the loading row in a draft session when stale messages leak in', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: assistantMessage('message-1', { time: { created: 1 } }),
        parts: [textPart('text-1', 'Generating response')],
      },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeInstanceOf(HTMLDivElement);

    setState('activeSessionId', null);
    replaceMessages([]);
    stopLoading();
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeNull();

    replaceMessages([
      {
        info: assistantMessage('stale-1', { time: { created: 1 } }),
        parts: [textPart('stale-text-1', 'Leftover from the previous session')],
      },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('.interactive-loading-row')).toBeNull();
  });
});

describe('MessageList auto-scroll', () => {
  it('updates the virtualized range when initial bottom scroll is programmatic', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 7200 });
    Object.defineProperty(list!, 'scrollTop', {
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

    expect(scrollTopValue).toBe(6800);
    const firstRenderedMessageId =
      container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId;
    expect(firstRenderedMessageId).not.toBe('assistant-0');

    animationFrames.restore();
  });

  it('virtualizes after mount-time measurement when resize observers do not emit', async () => {
    // Principle: exact-height virtualization must still activate in test/no-layout environments.
    // If this regresses, the list falls back to rendering every row and future refactors may hide it
    // behind fake performance improvements.
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 7200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, 500, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 7200);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    expect(container?.querySelector('.virtual-spacer-top')).toBeTruthy();

    animationFrames.restore();
  });

  it.each(['insertion', 'removal'] as const)(
    'preserves a detached visible row across a structural %s during active slow scrolling',
    async (mutation) => {
      const animationFrames = installQueuedAnimationFrameMocks();
      const baseMessages = Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      });
      const heightById = new Map(
        baseMessages.map((message, index) => [message.info.id, 70 + (index % 4) * 25])
      );
      let layoutIds = baseMessages.map((message) => message.info.id);
      let list: HTMLDivElement | null = null;
      let scrollTopValue = 0;
      const rowTop = (messageId: string) => {
        const index = layoutIds.indexOf(messageId);
        return layoutIds
          .slice(0, Math.max(0, index))
          .reduce((total, id) => total + (heightById.get(id) ?? 0), 0);
      };
      const totalHeight = () =>
        layoutIds.reduce((total, id) => total + (heightById.get(id) ?? 0), 0);

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          if (this === list || this.classList.contains('interactive-list')) {
            return new DOMRect(0, 0, 500, 400);
          }
          if (this.classList.contains('interactive-list-track')) {
            return new DOMRect(0, 0, 500, totalHeight());
          }
          const messageId = this.dataset.msgId;
          if (messageId && heightById.has(messageId)) {
            return new DOMRect(
              0,
              rowTop(messageId) - scrollTopValue,
              500,
              heightById.get(messageId)
            );
          }
          return new DOMRect(0, 0, 500, 40);
        }
      );

      setState('activeSessionId', 'session-1');
      replaceMessages(baseMessages);
      cleanup = render(() => MessageList(), container!);
      list = container?.querySelector('.interactive-list') as HTMLDivElement;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(list, 'scrollHeight', {
        configurable: true,
        get: totalHeight,
      });
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
      const anchorId = 'assistant-25';
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
      scrollTopValue = rowTop(anchorId) + 20;
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      const anchorBefore = container?.querySelector(
        `[data-msg-id="${anchorId}"]`
      ) as HTMLDivElement;
      expect(anchorBefore).toBeInstanceOf(HTMLDivElement);
      const anchorTopBefore = anchorBefore.getBoundingClientRect().top;

      const nextMessages = state.messages.map((message) => ({
        info: message.info,
        parts: message.parts,
      }));
      if (mutation === 'removal') {
        nextMessages.splice(4, 1);
      } else {
        const insertedId = 'assistant-inserted';
        heightById.set(insertedId, 135);
        nextMessages.splice(4, 0, {
          info: assistantMessage(insertedId),
          parts: [
            {
              ...textPart('text-inserted', 'Inserted response'),
              messageID: insertedId,
            },
          ],
        });
      }
      replaceMessages(nextMessages);
      layoutIds = nextMessages.map((message) => message.info.id);
      await Promise.resolve();
      animationFrames.flush();
      await Promise.resolve();

      const anchorAfter = container?.querySelector(`[data-msg-id="${anchorId}"]`) as HTMLDivElement;
      expect(anchorAfter).toBeInstanceOf(HTMLDivElement);
      expect(
        Math.abs(anchorAfter.getBoundingClientRect().top - anchorTopBefore)
      ).toBeLessThanOrEqual(0.5);
      animationFrames.restore();
    }
  );

  it('preserves the visible row for one mixed resize batch above, at, and below it', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    const rowHeights = Array.from({ length: 50 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((total, height) => total + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((total, height) => total + height, 0),
    });
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
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    const changedRows = [8, 14, 20, 25].map(
      (index) => container?.querySelector(`[data-msg-id="assistant-${index}"]`) as HTMLDivElement
    );
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(changedRows.every((row) => row instanceof HTMLDivElement)).toBe(true);
    const rowObserver = observers.find((observer) => observer.targets.has(anchor));
    expect(rowObserver).toBeDefined();
    const anchorTopBefore = anchor.getBoundingClientRect().top;

    rowHeights[8] = 130;
    rowHeights[14] = 80;
    rowHeights[20] = 180;
    rowHeights[25] = 160;
    rowObserver!.callback(
      changedRows.map(
        (row, index) =>
          ({
            target: row,
            borderBoxSize: [{ blockSize: rowHeights[[8, 14, 20, 25][index]!]!, inlineSize: 500 }],
          }) as unknown as ResizeObserverEntry
      ),
      rowObserver as unknown as ResizeObserver
    );

    expect(scrollTopValue).toBe(2010);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);

    const belowRow = changedRows[3]!;
    rowHeights[25] = 200;
    rowObserver!.callback(
      [
        {
          target: belowRow,
          borderBoxSize: [{ blockSize: 200, inlineSize: 500 }],
        } as unknown as ResizeObserverEntry,
      ],
      rowObserver as unknown as ResizeObserver
    );
    expect(scrollTopValue).toBe(2010);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    animationFrames.restore();
  });

  it('ignores delayed resize entries from unmounted rows', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    const rowHeight = 100;
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 50 * rowHeight);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * rowHeight - scrollTopValue, 500, rowHeight);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 50 * rowHeight });
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
    const staleRow = container?.querySelector('[data-msg-id="assistant-49"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(staleRow));
    expect(staleRow).toBeInstanceOf(HTMLDivElement);
    expect(rowObserver).toBeDefined();

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 0;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-49"]')).toBeNull();

    const bottomSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height || '0'
      );
    const bottomPadBefore = bottomSpacer();
    document.body.append(staleRow);
    rowObserver!.callback(
      [
        {
          target: staleRow,
          borderBoxSize: [{ blockSize: 500, inlineSize: 500 }],
        } as unknown as ResizeObserverEntry,
      ],
      rowObserver as unknown as ResizeObserver
    );
    await Promise.resolve();

    expect(bottomSpacer()).toBe(bottomPadBefore);
    staleRow.remove();
    animationFrames.restore();
  });

  it('yields pending width measurement anchoring to direct user scroll input', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    const rowHeights = Array.from({ length: 50 }, () => 100);
    const rowTop = (index: number) =>
      rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((total, height) => total + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((total, height) => total + height, 0),
    });
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
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    vi.advanceTimersByTime(600);

    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(anchor));
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(rowObserver).toBeDefined();
    const publishWidthMeasurement = (height: number, inlineSize: number) => {
      rowHeights[20] = height;
      rowObserver!.callback(
        [
          {
            target: anchor,
            borderBoxSize: [{ blockSize: height, inlineSize }],
          } as unknown as ResizeObserverEntry,
        ],
        rowObserver as unknown as ResizeObserver
      );
    };

    publishWidthMeasurement(120, 420);
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    scrollTopValue += 120;
    list.dispatchEvent(new Event('scroll'));
    const wheelOwnedTop = scrollTopValue;
    await Promise.resolve();
    expect(scrollTopValue).toBe(wheelOwnedTop);

    vi.advanceTimersByTime(600);
    publishWidthMeasurement(140, 380);
    list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));
    scrollTopValue += 200;
    list.dispatchEvent(new Event('scroll'));
    const keyboardOwnedTop = scrollTopValue;
    await Promise.resolve();
    expect(scrollTopValue).toBe(keyboardOwnedTop);

    vi.advanceTimersByTime(600);
    publishWidthMeasurement(160, 340);
    list.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 495 }));
    scrollTopValue += 100;
    list.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    const pointerOwnedTop = scrollTopValue;
    await Promise.resolve();
    expect(scrollTopValue).toBe(pointerOwnedTop);
    animationFrames.restore();
  });

  it('does not treat a visible row below pre-message chrome as above the viewport', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    const chromeHeight = 48;
    const rowHeights: number[] = Array.from({ length: 50 }, (_, index) => (index === 0 ? 20 : 100));
    const rowTop = (index: number) =>
      chromeHeight + rowHeights.slice(0, index).reduce((total, height) => total + height, 0);
    const totalHeight = () =>
      chromeHeight + rowHeights.reduce((total, height) => total + height, 0);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, -scrollTopValue, 500, totalHeight());
        }
        if (this.classList.contains('message-history-banner')) {
          return new DOMRect(0, 14 - scrollTopValue, 500, 22);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, rowTop(index) - scrollTopValue, 500, rowHeights[index]);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    setSessionHistoryCursor('session-1', 'cursor-older');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const historyBanner = container?.querySelector('.message-history-banner') as HTMLDivElement;
    track.style.paddingTop = '14px';
    historyBanner.style.marginBottom = '12px';
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: totalHeight });
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
    scrollTopValue = 30;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const firstRow = container?.querySelector('[data-msg-id="assistant-0"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(firstRow));
    expect(rowObserver).toBeDefined();
    const topBefore = firstRow.getBoundingClientRect().top;
    expect(topBefore).toBe(18);

    rowHeights[0] = 40;
    rowObserver!.callback(
      [
        {
          target: firstRow,
          borderBoxSize: [{ blockSize: 40, inlineSize: 500 }],
        } as unknown as ResizeObserverEntry,
      ],
      rowObserver as unknown as ResizeObserver
    );

    expect(firstRow.getBoundingClientRect().top).toBe(topBefore);
    expect(scrollTopValue).toBe(30);
    animationFrames.restore();
  });

  it('invalidates cached heights for offscreen reasoning rows when thinking visibility changes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 5000);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index < 40
              ? [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }]
              : [
                  {
                    ...reasoningPart(`reasoning-${index}`, `Reasoning ${index}`),
                    messageID: messageId,
                  },
                ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
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
    scrollTopValue = 0;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-40"]')).toBeNull();
    const bottomSpacer = () =>
      Number.parseFloat(
        container?.querySelector<HTMLElement>('.virtual-spacer-bottom')?.style.height || '0'
      );
    const bottomPadBefore = bottomSpacer();

    setShowThinkingPreference(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-40"]')).toBeNull();
    // Compact activity already gives the follower rows zero height, so hiding thinking removes only
    // the disclosure owner's provisional height.
    expect(bottomSpacer() - bottomPadBefore).toBe(-100);
    animationFrames.restore();
  });

  it('preserves the visible row while invalidating offscreen thinking heights above it', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const rowHeights = Array.from({ length: 50 }, () => 100);
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(
            0,
            0,
            500,
            rowHeights.reduce((sum, height) => sum + height, 0)
          );
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const mountedIndexes = [
            ...(container?.querySelectorAll<HTMLElement>('[data-msg-id^="assistant-"]') || []),
          ].map((row) => Number(row.dataset.msgId!.replace('assistant-', '')));
          const firstMountedIndex = Math.min(...mountedIndexes, index);
          const topPad = Number.parseFloat(
            container?.querySelector<HTMLElement>('.virtual-spacer-top')?.style.height || '0'
          );
          const mountedHeightBefore = rowHeights
            .slice(firstMountedIndex, index)
            .reduce((sum, height) => sum + height, 0);
          return new DOMRect(
            0,
            topPad + mountedHeightBefore - scrollTopValue,
            500,
            rowHeights[index]
          );
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId, { parentID: 'user-1' }),
          parts:
            index < 5
              ? [
                  {
                    ...reasoningPart(`reasoning-${index}`, `Reasoning ${index}`),
                    messageID: messageId,
                  },
                ]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => rowHeights.reduce((sum, height) => sum + height, 0),
    });
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
    scrollTopValue = 2000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const anchor = container?.querySelector('[data-msg-id="assistant-20"]') as HTMLDivElement;
    expect(anchor).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('[data-msg-id="assistant-0"]')).toBeNull();
    const anchorTopBefore = anchor.getBoundingClientRect().top;
    rowHeights[0] = 40;
    for (let index = 1; index < 5; index += 1) rowHeights[index] = 0;

    setShowThinkingPreference(false);
    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }

    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    animationFrames.restore();
  });

  it('does not give an explicitly render-empty row a provisional virtual height', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 4900);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 0 ? 0 : 100;
          return new DOMRect(0, index * 100 - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 0
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 4900 });
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
    expect(
      container?.querySelector('.interactive-list-track')?.classList.contains('virtualized')
    ).toBe(true);

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 3000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId).toBe(
      'assistant-16'
    );
    animationFrames.restore();
  });

  it('retains the prior height when a rendered nonempty row reports a transient zero', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, 5000);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    const firstRow = container?.querySelector('[data-msg-id="assistant-0"]') as HTMLDivElement;
    const rowObserver = observers.find((observer) => observer.targets.has(firstRow));
    expect(firstRow.childElementCount).toBeGreaterThan(0);
    expect(rowObserver).toBeDefined();
    rowObserver!.callback(
      [
        {
          target: firstRow,
          borderBoxSize: [{ blockSize: 0, inlineSize: 500 }],
        } as unknown as ResizeObserverEntry,
      ],
      rowObserver as unknown as ResizeObserver
    );

    for (let frame = 0; frame < 4; frame += 1) {
      await Promise.resolve();
      animationFrames.flush();
    }
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    scrollTopValue = 3000;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector<HTMLElement>('[data-msg-id]')?.dataset.msgId).toBe(
      'assistant-15'
    );
    animationFrames.restore();
  });

  it('remounts and remeasures a cached zero-height row after it gains content', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const zeroRowHasContent =
          state.messages.find((message) => message.info.id === 'assistant-30')?.parts.length !== 0;
        const trackHeight = zeroRowHasContent ? 5000 : 4900;
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 30 && !zeroRowHasContent ? 0 : 100;
          const documentTop =
            index <= 30 ? index * 100 : index * 100 - (zeroRowHasContent ? 0 : 100);
          return new DOMRect(0, documentTop - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 30
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages.find((message) => message.info.id === 'assistant-30')?.parts.length
          ? 5000
          : 4900,
    });
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
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    scrollTopValue = 4450;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    let emptyRowRemounted = false;
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            (node.dataset.msgId === 'assistant-30' ||
              node.querySelector('[data-msg-id="assistant-30"]'))
          ) {
            emptyRowRemounted = true;
          }
        }
      }
    });
    mutationObserver.observe(track, { childList: true, subtree: true });
    upsertPart({
      ...textPart('text-0-extra', 'An unrelated message changed'),
      messageID: 'assistant-0',
    });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(emptyRowRemounted).toBe(false);

    upsertPart({
      ...textPart('text-30', 'Content appeared after the zero-height row unmounted'),
      messageID: 'assistant-30',
    });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeInstanceOf(HTMLDivElement);
    mutationObserver.disconnect();
    animationFrames.restore();
  });

  it('makes a cached zero-height row provisional when it gains model chrome', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const hasModelChange = hasAssistantModelChangeBetween('assistant-29', 'assistant-30');
        const trackHeight = hasModelChange ? 5000 : 4900;
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 30 && !hasModelChange ? 0 : 100;
          const documentTop = index <= 30 ? index * 100 : index * 100 - (hasModelChange ? 0 : 100);
          return new DOMRect(0, documentTop - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 30
              ? []
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => (hasAssistantModelChangeBetween('assistant-29', 'assistant-30') ? 5000 : 4900),
    });
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
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    scrollTopValue = 4450;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    replaceMessages(
      state.messages.map((message) =>
        message.info.id === 'assistant-29'
          ? {
              ...message,
              info: assistantMessage('assistant-29', {
                modelID: 'claude-sonnet-4',
                providerID: 'anthropic',
              }),
            }
          : message
      )
    );
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const remountedRow = container?.querySelector('[data-msg-id="assistant-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.querySelector('.model-change-indicator')).not.toBeNull();
    animationFrames.restore();
  });

  it('remounts an offscreen cached zero-height row after the same text part becomes visible', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const zeroRowHasContent = !!state.messages
          .find((message) => message.info.id === 'assistant-30')
          ?.parts.find((part) => part.id === 'text-30' && part.type === 'text' && part.text.trim());
        const trackHeight = zeroRowHasContent ? 5000 : 4900;
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 30 && !zeroRowHasContent ? 0 : 100;
          const documentTop =
            index <= 30 ? index * 100 : index * 100 - (zeroRowHasContent ? 0 : 100);
          return new DOMRect(0, documentTop - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, index === 30 ? '' : `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        state.messages
          .find((message) => message.info.id === 'assistant-30')
          ?.parts.find((part) => part.id === 'text-30' && part.type === 'text' && part.text.trim())
          ? 5000
          : 4900,
    });
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
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    scrollTopValue = 4450;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();
    expect(container?.querySelector('[data-msg-id="assistant-30"]')).toBeNull();

    upsertPart({
      ...textPart('text-30', 'The existing part is now visible'),
      messageID: 'assistant-30',
    });
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    const remountedRow = container?.querySelector('[data-msg-id="assistant-30"]');
    expect(remountedRow).toBeInstanceOf(HTMLDivElement);
    expect(remountedRow?.textContent).toContain('The existing part is now visible');
    animationFrames.restore();
  });

  it('cancels pending width work when async initial messages arrive or the list unmounts', async () => {
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    let listWidth = 500;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-item-container')) {
          return new DOMRect(0, 0, listWidth, 120);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, listWidth, 6000);
        }
        return new DOMRect(0, 0, listWidth, 500);
      }
    );

    setState('activeSessionId', 'session-1');
    cleanup = render(() => MessageList(), container!);
    const list = container!.querySelector('.interactive-list')!;
    const track = container!.querySelector('.interactive-list-track')!;
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();

    listWidth = 420;
    layoutObserver!.callback([], layoutObserver as unknown as ResizeObserver);
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();
    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(100);
    expect(container?.querySelector('.interactive-list-track.virtualized')).toBeTruthy();

    listWidth = 400;
    const timersBeforeResize = vi.getTimerCount();
    layoutObserver!.callback([], layoutObserver as unknown as ResizeObserver);
    expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeResize);
    cleanup();
    cleanup = undefined;
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResize);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeResize);
  });

  it('stays pinned to the real bottom when virtualized messages update in place', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(`text-${index}`, `Response ${index}`),
              messageID: messageId,
            },
          ],
        };
      })
    );

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    let scrollHeightValue = 7200;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
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

    expect(scrollTopValue).toBe(6800);

    scrollTopValue = 6800;
    scrollHeightValue = 7440;
    replaceMessages(
      Array.from({ length: 60 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [
            {
              ...textPart(
                `text-${index}`,
                index === 59 ? 'Updated response with more content' : `Response ${index}`
              ),
              messageID: messageId,
            },
          ],
        };
      })
    );

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(scrollTopValue).toBe(7040);
    animationFrames.restore();
  });

  it('keeps correcting initial bottom scroll when scrollHeight shifts without track growth', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    scrollHeightValue = 1700;
    trackHeight = 1200;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps bottom follow active after a downward wheel that cannot move the list', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    trackHeight = 1600;
    scrollHeightValue = 1600;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1200);
    animationFrames.restore();
  });

  it('restarts bottom follow after a downward wheel cancels its pending frame', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Response 1')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1600;
    scrollHeightValue = 1600;
    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    setState('streamingPartId', 'text-2');
    setState('streamingText', 'Streaming growth');
    await Promise.resolve();

    expect(scrollTopValue).toBe(1200);
    animationFrames.flush();
    animationFrames.restore();
  });

  it('keeps the latest message fully visible when the last response grows', async () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1700 });
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      {
        info: assistantMessage('assistant-1'),
        parts: [textPart('text-2', 'Expanded response'), textPart('text-3', 'More content')],
      },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(scrollTopValue).toBe(1300);
  });

  it('corrects bottom scroll immediately when rendered content resizes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1700;
    scrollHeightValue = 1700;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps following running tool growth when a resize notification is delayed', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Run checks')] },
      { info: assistantMessage('assistant-1'), parts: [toolPart('tool-1', 'assistant-1')] },
    ]);
    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTopValue).toBe(800);
    animationFrames.flush();

    trackHeight = 1700;
    scrollHeightValue = 1700;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps following delayed layout growth after final parts arrive in one batch', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    const userEntry = {
      info: userMessage('user-1'),
      parts: [textPart('text-1', 'Explain the result')],
    };
    setState('activeSessionId', 'session-1');
    replaceMessages([
      userEntry,
      {
        info: assistantMessage('assistant-1'),
        parts: [{ ...textPart('text-2', 'Initial response'), messageID: 'assistant-1' }],
      },
    ]);
    setState('streamingPartId', 'text-2');
    setState('streamingText', 'Initial response');
    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    setMessagesIncremental([
      userEntry,
      {
        info: assistantMessage('assistant-1'),
        parts: Array.from({ length: 20 }, (_, index) => ({
          ...textPart(`text-${index + 2}`, `Final response section ${index + 1}`),
          messageID: 'assistant-1',
        })),
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    // The first post-stream frame runs before deferred markdown and entrance layout settles.
    animationFrames.flush();
    trackHeight = 1800;
    scrollHeightValue = 1800;
    animationFrames.flush();

    expect(scrollTopValue).toBe(1400);
    animationFrames.restore();
  });

  it('synchronizes a browser bottom clamp when grouped activity shrinks during follow', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollHeightValue = 5000;
    let trackHeight = 5000;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * 100 - scrollTopValue, 500, 100);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts:
            index === 49
              ? [toolPart('tool-49', messageId)]
              : [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);

    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
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
    expect(scrollTopValue).toBe(4600);
    for (const callback of resizeCallbacks) {
      callback([{ target: list } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
    animationFrames.flush();

    trackHeight = 5500;
    scrollHeightValue = 5500;
    requestMessageListScrollToBottom();
    await Promise.resolve();
    expect(scrollTopValue).toBe(5100);

    trackHeight = 1000;
    scrollHeightValue = 1000;
    // Chrome clamps to the new bottom during layout, before it necessarily dispatches scroll.
    scrollTopValue = 600;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id]')?.getAttribute('data-msg-id')).toBe(
      'assistant-0'
    );
    animationFrames.restore();
  });

  it('does not auto-scroll again when the track bounces back to an already-followed height', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    trackHeight = 1700;
    scrollHeightValue = 1700;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    expect(scrollTopValue).toBe(1300);

    const assignmentCountAfterGrowth = assignedScrollTops.length;

    trackHeight = 1688;
    scrollHeightValue = 1688;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    expect(assignedScrollTops).toHaveLength(assignmentCountAfterGrowth);

    trackHeight = 1700;
    scrollHeightValue = 1700;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterGrowth);
    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('keeps following when non-scroll pointer input precedes a layout clamp', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    scrollHeightValue = 400;
    list?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 }));
    scrollHeightValue = 1200;
    list?.firstElementChild?.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 })
    );
    // The browser can clamp scrollTop while content briefly shrinks, then deliver the scroll
    // event only after the old bottom target has returned.
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(1000);
    animationFrames.restore();
  });

  it('ignores external PageUp but stops following after in-list PageUp movement', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    const externalButton = document.createElement('button');
    container?.appendChild(externalButton);
    externalButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTopValue = 500;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(1000);

    list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTopValue = 700;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1600;
    scrollHeightValue = 1600;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(700);
    animationFrames.restore();
  });

  it.each([
    { name: 'classic', clientWidth: 484 },
    { name: 'overlay', clientWidth: 500 },
  ])('stops following after $name scrollbar pointer-originated upward scrolling', async (args) => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'clientWidth', {
      configurable: true,
      value: args.clientWidth,
    });
    Object.defineProperty(list!, 'offsetWidth', { configurable: true, value: 500 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 495 }));
    scrollTopValue = 500;
    list?.dispatchEvent(new Event('scroll'));

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(500);
    animationFrames.restore();
  });

  it('resumes after nested diff input without outer movement but not after diff keyboard scrolling', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    const diffViewport = document.createElement('div');
    diffViewport.className = 'diff-view-lines';
    diffViewport.tabIndex = 0;
    list?.appendChild(diffViewport);
    const externalButton = document.createElement('button');
    container?.appendChild(externalButton);

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    diffViewport.focus();
    diffViewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    externalButton.focus();
    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();

    trackHeight = 1400;
    scrollHeightValue = 1400;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();
    expect(scrollTopValue).toBe(1000);

    diffViewport.focus();
    diffViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    scrollTopValue = 700;
    list?.dispatchEvent(new Event('scroll'));
    externalButton.focus();
    await Promise.resolve();
    await Promise.resolve();

    trackHeight = 1600;
    scrollHeightValue = 1600;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(scrollTopValue).toBe(700);
    animationFrames.restore();
  });

  it('does not rewrite scrollTop when resize leaves the list already at bottom', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    const assignmentCountAfterInitialScroll = assignedScrollTops.length;
    trackHeight = 1700;
    scrollHeightValue = 1700;
    scrollTopValue = 1300;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterInitialScroll);
    expect(scrollTopValue).toBe(1300);
    animationFrames.restore();
  });

  it('does not snap back to bottom after a small upward scroll near the threshold', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    const assignmentCountAfterUserScroll = assignedScrollTops.length;

    trackHeight = 1240;
    scrollHeightValue = 1240;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterUserScroll);
    expect(scrollTopValue).toBe(760);
    animationFrames.restore();
  });

  it('does not re-pin to bottom after loading settles when the user moved slightly upward', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);
    startLoading(1);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();
    const assignmentCountAfterUserScroll = assignedScrollTops.length;

    stopLoading();
    await Promise.resolve();
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterUserScroll);
    expect(scrollTopValue).toBe(760);
    animationFrames.restore();
  });

  it('keeps auto-scroll enabled when the bottom target shifts before a near-bottom scroll event', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    scrollHeightValue = 1240;
    scrollTopValue = 800;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    trackHeight = 1240;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops.at(-1)).toBe(840);
    expect(scrollTopValue).toBe(840);
    animationFrames.restore();
  });

  it('releases the send-triggered follow lock after bottom scroll stabilizes', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    let trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    scrollTopValue = 400;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    animationFrames.flush();
    animationFrames.flush();
    animationFrames.flush();

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    trackHeight = 1240;
    scrollHeightValue = 1240;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    animationFrames.flush();

    expect(assignedScrollTops.at(-1)).toBe(800);
    expect(scrollTopValue).toBe(760);
    animationFrames.restore();
  });

  it('never reverses a downward user scroll during the measured append transition', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const baseMessages = Array.from({ length: 50 }, (_, index) => {
      const messageId = `assistant-${index}`;
      return {
        info: assistantMessage(messageId),
        parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
      };
    });
    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let scrollHeightValue = 5000;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, scrollHeightValue);
        }
        if (this.dataset.msgId) {
          const index =
            this.dataset.msgId === 'assistant-appended'
              ? 50
              : Number(this.dataset.msgId.replace('assistant-', ''));
          const height = index === 50 ? 200 : 100;
          return new DOMRect(0, index * 100 - scrollTopValue, 500, height);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );
    setState('activeSessionId', 'session-1');
    replaceMessages(baseMessages);

    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
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
    expect(scrollTopValue).toBe(4600);

    scrollHeightValue = 5200;
    replaceMessages([
      ...baseMessages,
      {
        info: assistantMessage('assistant-appended'),
        parts: [
          {
            ...textPart('text-appended', 'Appended response'),
            messageID: 'assistant-appended',
          },
        ],
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush(30);

    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    scrollTopValue += 100;
    const userOwnedTop = scrollTopValue;
    list.dispatchEvent(new Event('scroll'));
    animationFrames.flush(60);

    expect(scrollTopValue).toBeGreaterThanOrEqual(userOwnedTop);
    animationFrames.restore();
  });

  it('keeps following new messages after an explicit scroll request from a recent wheel scroll', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    let scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    scrollTopValue = 400;
    list?.dispatchEvent(new Event('scroll'));

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    animationFrames.flush();
    animationFrames.flush();

    trackHeight = 1600;
    scrollHeightValue = 1600;
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
      { info: userMessage('user-2'), parts: [textPart('text-3', 'Prompt 2')] },
      { info: assistantMessage('assistant-2'), parts: [textPart('text-4', 'Follow-up response')] },
    ]);
    await Promise.resolve();
    animationFrames.flush();

    expect(assignedScrollTops.at(-1)).toBe(1200);
    expect(scrollTopValue).toBe(1200);
    animationFrames.restore();
  });

  it('re-attaches to bottom again on the next explicit scroll request', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const trackHeight = 1200;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks.length).toBeGreaterThanOrEqual(2);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollHeightValue = 1200;
    let scrollTopValue = 0;
    const assignedScrollTops: number[] = [];
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        assignedScrollTops.push(value);
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);

    animationFrames.flush();
    animationFrames.flush();
    animationFrames.flush();

    scrollTopValue = 760;
    list?.dispatchEvent(new Event('scroll'));
    animationFrames.flush();

    const assignmentCountAfterNearBottomScroll = assignedScrollTops.length;

    requestMessageListScrollToBottom();
    await Promise.resolve();
    animationFrames.flush();

    expect(assignedScrollTops).toHaveLength(assignmentCountAfterNearBottomScroll + 1);
    expect(assignedScrollTops.at(-1)).toBe(800);
    expect(scrollTopValue).toBe(800);
    animationFrames.restore();
  });

  it('reacts to trailing permission growth when jump-to-latest crosses its threshold', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    let list: HTMLDivElement | null = null;
    let scrollTopValue = 0;
    let trailingHeight = 0;
    const messageHeight = 100;
    const messageTrackHeight = 50 * messageHeight;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this === list || this.classList.contains('interactive-list')) {
          return new DOMRect(0, 0, 500, 400);
        }
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, messageTrackHeight + trailingHeight);
        }
        if (this.dataset.msgId?.startsWith('assistant-')) {
          const index = Number(this.dataset.msgId.replace('assistant-', ''));
          return new DOMRect(0, index * messageHeight - scrollTopValue, 500, messageHeight);
        }
        return new DOMRect(0, 0, 500, 40);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages(
      Array.from({ length: 50 }, (_, index) => {
        const messageId = `assistant-${index}`;
        return {
          info: assistantMessage(messageId),
          parts: [{ ...textPart(`text-${index}`, `Response ${index}`), messageID: messageId }],
        };
      })
    );
    cleanup = render(() => MessageList(), container!);
    list = container?.querySelector('.interactive-list') as HTMLDivElement;
    const track = container?.querySelector('.interactive-list-track') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => messageTrackHeight + trailingHeight,
    });
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
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    scrollTopValue = messageTrackHeight - list.clientHeight - 220;
    list.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    trailingHeight = 100;
    setState('permissions', [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: '',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ]);
    const layoutObserver = observers.find(
      (observer) => observer.targets.has(list!) && observer.targets.has(track)
    );
    expect(layoutObserver).toBeDefined();
    layoutObserver!.callback(
      [{ target: track } as unknown as ResizeObserverEntry],
      layoutObserver as unknown as ResizeObserver
    );
    await Promise.resolve();

    expect(container?.querySelector('.jump-to-latest-button')).toBeInstanceOf(HTMLButtonElement);
    animationFrames.restore();
  });

  it('shows the jump-to-latest button after scrolling away and returns to bottom on click', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('interactive-list-track')) {
          return new DOMRect(0, 0, 500, trackHeight);
        }
        return new DOMRect(0, 0, 500, 400);
      }
    );

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    expect(list).toBeInstanceOf(HTMLDivElement);

    const scrollHeightValue = 1200;
    let scrollTopValue = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await Promise.resolve();
    animationFrames.flush();
    expect(scrollTopValue).toBe(800);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    list?.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    scrollTopValue = 200;
    list?.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    const button = container?.querySelector('.jump-to-latest-button') as HTMLButtonElement | null;
    expect(button).toBeInstanceOf(HTMLButtonElement);

    setExpandedDiffOverlay(testDiffOverlayOwner, true);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();

    setExpandedDiffOverlay(testDiffOverlayOwner, false);
    const restoredButton = container?.querySelector(
      '.jump-to-latest-button'
    ) as HTMLButtonElement | null;
    expect(restoredButton).toBeInstanceOf(HTMLButtonElement);

    restoredButton?.click();
    await Promise.resolve();
    animationFrames.flush();

    expect(scrollTopValue).toBe(800);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();
    animationFrames.restore();
  });
});
