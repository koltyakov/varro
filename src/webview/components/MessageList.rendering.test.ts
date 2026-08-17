import { describe, expect, it, vi } from 'vitest';
import { batch } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setSessions,
  setShowInlineFileChanges,
  setShowThinkingPreference,
  setState,
  startLoading,
  stopLoading,
  upsertPart,
} from '../lib/state';
import type { MessageEntry, Part, Permission, QuestionRequest, TextPart, ToolPart } from '../types';
import type { AssistantActivityGroupInfo } from '../lib/assistant-activity';
import { MessageList, getNewlyAppendedMessageIds } from './MessageList';
import { getRenderEmptyAssistantMessageIds } from './message-list/row-layout';
import { getVisibleThreadMessages } from './message-list/thread-visibility';
import { markSessionHistoryLoadFailed, setSessionHistoryCursor } from '../lib/message-window';
import {
  assistantMessage,
  filePart,
  installMessageListTestEnvironment,
  installQueuedAnimationFrameMocks,
  reasoningPart,
  session,
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

describe('MessageList keyboard navigation', () => {
  it('makes the transcript focusable for native scrolling keys', () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Focusable transcript')] },
    ]);

    cleanup = render(() => MessageList(), container!);

    expect((container?.querySelector('.interactive-list') as HTMLElement | null)?.tabIndex).toBe(0);
  });

  it('moves the focused transcript for native page keys', () => {
    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Keyboard scrolling')] },
    ]);
    cleanup = render(() => MessageList(), container!);
    const list = container?.querySelector('.interactive-list') as HTMLDivElement;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    list.scrollTop = 200;
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'PageDown',
    });

    list.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(600);
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
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Shared fixtures are imported from the test-utils module.
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

    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Shared fixtures are imported from the test-utils module.
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
    expect(container?.querySelector('.interactive-loading-row')?.classList).toContain(
      'is-reserved'
    );

    setState('messagesLoading', false);
  });

  it('does not show Thinking while a busy session is still loading messages', async () => {
    setSessions([session('session-1', { time: { created: 1, updated: 2 } })]);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'busy' });
    setState('messagesLoading', true);
    replaceMessages([]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.chat-messages-loading')).not.toBeNull();
    const thinkingRow = container?.querySelector('.interactive-loading-row');
    expect(thinkingRow?.classList).toContain('is-reserved');
    expect(thinkingRow?.getAttribute('aria-hidden')).toBe('true');
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

  it('waits to render a linked permission until its message finishes loading', async () => {
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
    expect(container?.querySelector('.permission-prompt')).toBeNull();

    replaceMessages([
      {
        info: assistantMessage('message-1'),
        parts: [
          toolPart('tool-1'),
          {
            ...toolPart('tool-2', 'message-1', 'call-2'),
            state: {
              status: 'completed',
              input: { command: 'git status' },
              output: '',
              title: 'git status',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ]);
    await Promise.resolve();

    expect(container?.querySelector('[data-msg-id="message-1"]')).not.toBeNull();
    expect(container?.querySelector('.permission-prompt')).toBeNull();

    setState('messagesLoading', false);
    await Promise.resolve();

    const messageRow = container?.querySelector('[data-msg-id="message-1"]');
    const activitySummary = messageRow?.querySelector('.assistant-activity-summary');
    const waitingTool = messageRow
      ?.querySelector('.tool-call-wait-icon')
      ?.closest('.tool-invocation-header');
    const permissionPrompt = messageRow?.querySelector('.permission-prompt');
    expect(permissionPrompt).not.toBeNull();
    expect(activitySummary).not.toBeNull();
    expect(waitingTool).not.toBeNull();
    expect(
      (activitySummary?.compareDocumentPosition(waitingTool!) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      (activitySummary?.compareDocumentPosition(permissionPrompt!) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(messageRow?.querySelectorAll('.permission-prompt')).toHaveLength(1);
    expect(container?.querySelectorAll('.permission-prompt')).toHaveLength(1);
  });

  it('waits for restored permissions before performing the initial bottom scroll', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
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
    replaceMessages([
      {
        info: assistantMessage('message-1'),
        parts: [toolPart('tool-1')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    const list = container?.querySelector('.interactive-list') as HTMLDivElement | null;
    let scrollTopValue = 0;
    let scrollWrites = 0;
    Object.defineProperty(list!, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list!, 'scrollHeight', { configurable: true, get: () => 1200 });
    Object.defineProperty(list!, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        scrollWrites += 1;
      },
    });

    await Promise.resolve();
    animationFrames.flush();

    expect(container?.querySelector('.permission-prompt')).toBeNull();
    expect(list?.classList).toContain('is-session-hydrating');
    expect(scrollWrites).toBe(0);

    setState('messagesLoading', false);
    await Promise.resolve();
    animationFrames.flush();

    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
    expect(list?.classList).not.toContain('is-session-hydrating');
    expect(scrollTopValue).toBe(800);
    expect(scrollWrites).toBeGreaterThan(0);
    animationFrames.restore();
  });

  it('reveals a retained permission when message loading ends without content', async () => {
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

    expect(container?.querySelector('.permission-prompt')).toBeNull();

    setState('messagesLoading', false);
    await Promise.resolve();

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

  it('keeps running activity outside an expanded Explored group', async () => {
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

    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(1);
    expect(container?.querySelector('.assistant-active-activity-tray')).toBeNull();
    expect(summary?.textContent).toContain('Explored: 1 command');
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.classList).toContain(
      'interactive-item-render-empty'
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(1);
    expect(container?.querySelector('.assistant-active-activity-tray')).not.toBeNull();
    expect(
      container
        ?.querySelector('[data-activity-part-id="command-running"]')
        ?.closest('.assistant-activity-details')
    ).toBeNull();
    expect(container?.querySelector('[data-msg-id="assistant-2"]')?.classList).not.toContain(
      'interactive-item-render-empty'
    );
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
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Shared fixtures are imported from the test-utils module.
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

    setShowInlineFileChanges(false);
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(0);
    expect(
      container?.querySelectorAll('.assistant-file-edit-stack .file-change-card')
    ).toHaveLength(2);
    expect(summaries().map((summary) => summary.textContent)).toEqual([
      expect.stringContaining('Explored: 1 edit'),
      expect.stringContaining('Explored: 1 file'),
    ]);

    setShowInlineFileChanges(true);
    await Promise.resolve();

    expect(container?.querySelectorAll('.diff-view-file')).toHaveLength(2);

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
    const logo = container?.querySelector<HTMLImageElement>('.chat-empty-logo');
    expect(logo).toBeInstanceOf(HTMLImageElement);
    expect(logo?.width).toBe(256);
    expect(logo?.height).toBe(256);
    const hints = container?.querySelectorAll('.chat-empty-hint');
    expect(hints).toHaveLength(4);
    expect([...hints!].map((hint) => hint.textContent)).toEqual([
      '@ add files and agents',
      '/ run commands',
      '& link sessions',
      'ShiftEnter new line',
    ]);
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
    expect(container?.querySelectorAll('.chat-empty-hint')).toHaveLength(4);
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

  it('shows the loading row while automatic permission review is in progress', async () => {
    setSessions([session('session-1'), session('child-1', { parentID: 'session-1' })]);
    setState('activeSessionId', 'session-1');
    setState('sessionAutoPermissionCounts', 'child-1', {
      inFlight: 1,
      approved: 0,
      rejected: 0,
    });

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    const row = container?.querySelector('.interactive-loading-row');
    expect(row).toBeInstanceOf(HTMLDivElement);
    expect(row?.classList.contains('is-reserved')).toBe(false);
    expect(row?.textContent).toContain('Thinking');
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

  it('shows the worked summary when a completed response is loaded directly in a fork', async () => {
    setState('activeSessionId', 'forked-session');
    replaceMessages([
      {
        info: {
          ...userMessage('user-1'),
          sessionID: 'forked-session',
          time: { created: 1_000 },
        },
        parts: [textPart('text-user-1', 'Prompt')],
      },
      {
        info: assistantMessage('assistant-1', {
          sessionID: 'forked-session',
          time: { created: 2_000, completed: 11_000 },
          tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [textPart('text-assistant-1', 'Final response')],
      },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 ↓ 7');
    expect(container?.querySelector('.trailing-assistant-summary-row')).toBeInstanceOf(
      HTMLDivElement
    );
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

  it('keeps a rejected permission command visible and summarizes the stopped turn', async () => {
    const rejectedCommand = toolPart('tool-1', 'assistant-1');
    rejectedCommand.tool = 'bash';
    rejectedCommand.state = {
      status: 'error',
      input: { command: 'npm run release' },
      error: 'The user rejected permission to use this specific tool call.',
      time: { start: 3_000, end: 10_000 },
    };
    const interrupted = assistantMessage('assistant-1', {
      time: { created: 2_000, completed: 11_000 },
      tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    interrupted.finish = 'tool-calls';
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Publish the package')],
      },
      { info: interrupted, parts: [rejectedCommand] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary')).toBeNull();
    expect(container?.querySelector('.tool-invocation-title')?.textContent).toBe('npm run release');
    expect(container?.querySelector('.tool-invocation-error-label')?.textContent).toBe('rejected');
    expect(container?.textContent).toContain(
      'Worked for 10s - Permission rejected - Tokens ↑ 42 ↓ 7'
    );
  });

  it('shows a skipped question as a stopped turn instead of a failure', async () => {
    const skippedQuestion = toolPart('tool-1', 'assistant-1');
    skippedQuestion.tool = 'question';
    skippedQuestion.state = {
      status: 'error',
      input: { questions: [{ question: 'Which identifier should be used?' }] },
      error: 'QuestionRejectedError: The user dismissed this question',
      time: { start: 3_000, end: 10_000 },
    };
    const interrupted = assistantMessage('assistant-1', {
      time: { created: 2_000, completed: 11_000 },
      tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    interrupted.finish = 'tool-calls';
    setState('activeSessionId', 'session-1');
    replaceMessages([
      {
        info: { ...userMessage('user-1'), time: { created: 1_000 } },
        parts: [textPart('text-user-1', 'Help identify this machine')],
      },
      { info: interrupted, parts: [skippedQuestion] },
    ]);

    cleanup = render(() => MessageList(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-activity-summary')).toBeNull();
    expect(container?.querySelector('.question-summary-title')?.textContent).toBe(
      'Question skipped'
    );
    expect(container?.querySelector('.question-summary-answer')?.textContent).toBe('Skipped');
    expect(container?.querySelector('.tool-invocation-error-label')).toBeNull();
    expect(container?.textContent).toContain('Worked for 10s - Question skipped - Tokens ↑ 42 ↓ 7');
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
