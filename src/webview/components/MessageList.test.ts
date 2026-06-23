import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import {
  replaceMessages,
  requestMessageListScrollToBottom,
  setSessions,
  setShowModelPicker,
  setShowThinkingPreference,
  setState,
  skipPlanSession,
  startLoading,
  stopLoading,
} from '../lib/state';
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  Permission,
  QuestionRequest,
  UserMessage,
} from '../types';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  getAssistantDialogSummaryMap,
  getStandalonePermissionPrompts,
  getStandaloneQuestionPrompts,
  getLatestPlanImplementationMessageId,
  getVisibleThreadMessages,
  MessageList,
  shouldShowPlanImplementationAction,
} from './MessageList';
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

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

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

function entry(info: Message) {
  return { info, parts: [] as Part[] };
}

function toolPart(id: string, messageID = 'message-1', callID = 'call-1'): Part {
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
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

afterEach(() => {
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('messages', []);
  setState('sessions', []);
  setState('permissions', []);
  setState('questions', []);
  setState('activeSessionId', null);
  setState('providers', []);
  setState('agents', []);
  setState('allAgents', []);
  setState('queuedMessages', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
  setState('sessionSelectedAgents', reconcile({}));
  setState('sessionStatus', reconcile({}));
  setState('skippedPlanSessions', reconcile({}));
  setShowThinkingPreference(true);
  stopLoading();
  resetMessageEditState();
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  if (originalScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
  vi.restoreAllMocks();
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
  it('returns false on vertically narrow screens', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
        shouldVirtualize: false,
        visibleRange: { start: 0, end: 4 },
        rowTop: 120,
        rowBottom: 180,
        viewportHeight: 500,
      })
    ).toBe(false);
  });

  it('hides the current sticky preview while any part of the prompt is visible', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || defaultRect;
    });

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

  it('does not show a new sticky preview until the prompt is clearly above the viewport', () => {
    expect(
      shouldShowStickyUserMessagePreview({
        preview: { id: 'user-1', index: 2, text: 'Prompt' },
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
});

describe('MessageList session scoping', () => {
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

    const messages = [
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

    const messages = [
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

  it('summarizes elapsed time and tokens across nested agent children', async () => {
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
        parts: [
          textPart('text-2', 'Response'),
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

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 3,100 · ↓ 310 - Agents 2');
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
    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 12 · ↓ 4');
  });

  it('summarizes in and out tokens for subagent sessions parented to the root session', () => {
    const messages = [
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
    const messages = [
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || new DOMRect(0, 0, 500, 40);
    });

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

    expect(list!.scrollTop).toBe(380);

    list!.scrollTop = 350;
    rectMap.set(editedRow!, new DOMRect(0, 30, 500, 80));

    const wheelAllowed = list?.dispatchEvent(
      new WheelEvent('wheel', { cancelable: true, deltaY: 80 })
    );

    expect(wheelAllowed).toBe(false);
    expect(list!.scrollTop).toBe(380);
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || defaultRect;
    });

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
    });

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

  it('scrolls to the sticky prompt instead of editing while the active session is running', async () => {
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
    });

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

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(editingMessage()).toBeNull();

    animationFrames.restore();
  });

  it('restores image attachments when editing from the sticky prompt preview', async () => {
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
    });

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

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

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
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });

    animationFrames.restore();
  });

  it('scrolls to and edits image-only messages from the sticky prompt preview', async () => {
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || new DOMRect(0, -600, 500, 40);
    });

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
    expect(sticky?.textContent).toContain('Attachment: Image 2');

    sticky?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

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
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return rectMap.get(this) || defaultRect;
    });

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

  it('does not keep the loading row for older incomplete assistant replies', async () => {
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

    expect(container?.querySelector('.interactive-loading-row')).toBeNull();
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

  it('does not immediately re-show the loading row during short visible-stream gaps', async () => {
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
    vi.advanceTimersByTime(179);
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

  it('waits until loading settles before showing the trailing worked summary', async () => {
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

    expect(container?.textContent).not.toContain('Worked for');

    vi.advanceTimersByTime(240);
    await Promise.resolve();

    expect(container?.textContent).toContain('Worked for 10s - Tokens ↑ 42 · ↓ 7');
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

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-item-container')) {
        return new DOMRect(0, 0, 500, 120);
      }
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, 7200);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    await Promise.resolve();
    await Promise.resolve();
    animationFrames.flush();
    await Promise.resolve();

    expect(container?.querySelectorAll('[data-msg-id]').length).toBeLessThan(40);
    expect(container?.querySelector('.virtual-spacer-top')).toBeTruthy();

    animationFrames.restore();
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

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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

  it('keeps following new messages after an explicit scroll request from a recent wheel scroll', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    let trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

    setState('activeSessionId', 'session-1');
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('text-1', 'Prompt 1')] },
      { info: assistantMessage('assistant-1'), parts: [textPart('text-2', 'Initial response')] },
    ]);

    cleanup = render(() => MessageList(), container!);
    expect(resizeCallbacks).toHaveLength(2);

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

  it('shows the jump-to-latest button after scrolling away and returns to bottom on click', async () => {
    const animationFrames = installQueuedAnimationFrameMocks();
    const trackHeight = 1200;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('interactive-list-track')) {
        return new DOMRect(0, 0, 500, trackHeight);
      }
      return new DOMRect(0, 0, 500, 400);
    });

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

    button?.click();
    await Promise.resolve();
    animationFrames.flush();

    expect(scrollTopValue).toBe(800);
    expect(container?.querySelector('.jump-to-latest-button')).toBeNull();
    animationFrames.restore();
  });
});
